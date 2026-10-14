const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');
const fsp = require('fs').promises;
const dataStore = require('../data-store');
const pronunciationService = require('../services/pronunciation');
const pronunciationProfile = require('../services/pronunciation-profile');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const { parseBase64DataUrl, getExtensionFromMime, convertAudioToWav, removeFileSafe } = require('../utils/audio');
const { buildQuotaPaywall, getUsageLimits } = require('../services/entitlements');

async function recordQuotaLimitReached(userId, feature, code, quota, entitlement) {
  try {
    await dataStore.createEvent({
      user_id: userId,
      event_time: new Date().toISOString(),
      event_name: 'quota_limit_reached',
      properties: {
        feature,
        code,
        tier: quota?.tier || null,
        effective_tier: entitlement?.effectiveTier || null,
        limit: quota?.limit ?? null,
        used_today: quota?.used_today ?? null,
      },
      source: 'web',
    });
  } catch (err) {
    console.warn('[Quota] Failed to record pronunciation quota event:', err?.message || err);
  }
}

function normalizeDurationSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0.2 || duration > 120) return null;
  return duration;
}

function buildAssessmentResponse(saved, assessed) {
  const live = assessed && typeof assessed === 'object' ? assessed : {};
  const stored = saved && typeof saved === 'object' ? saved : live;
  return {
    ...stored,
    coaching: live.coaching && typeof live.coaching === 'object' ? live.coaching : null,
    analysis_version: live.analysis_version || null,
    duration_seconds: normalizeDurationSeconds(live.duration_seconds),
    speech_rate_wpm: Number.isFinite(Number(live.speech_rate_wpm))
      ? Number(live.speech_rate_wpm)
      : null,
  };
}

function normalizeProfileLimit(value) {
  if (value === null || value === undefined || value === '') return 3;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(5, Math.max(1, Math.trunc(parsed)));
}

function normalizePositiveDecimalId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const normalized = value.replace(/^0+(?=\d)/, '');
  return normalized === '0' ? null : normalized;
}

function buildAssessmentFocusResponse(focus) {
  return {
    id: focus.id,
    video_resource_id: focus.video_resource_id,
    text: focus.text,
    next_action: focus.next_action || null,
  };
}

async function buildAssessmentApiResponse({
  store,
  userId,
  saved,
  assessed,
  quota,
  now,
  updateProfile = pronunciationProfile.updateProfileAfterAssessment,
  warn = console.warn,
}) {
  const response = {
    assessment: buildAssessmentResponse(saved, assessed),
    hypothesis: assessed?.hypothesis,
    quota,
  };
  try {
    response.skill_update = await updateProfile(store, userId, saved, assessed, now);
  } catch (_) {
    warn('[Pronunciation] Profile update failed');
  }
  return response;
}

/**
 * Register and handle pronunciation-related routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerPronunciationRoutes(pathname, req, res, url, dependencies = {}) {
  const store = dependencies.dataStore || dataStore;
  const authenticateUser = dependencies.authenticate || authenticate;
  const sendJsonResponse = dependencies.sendJson || sendJson;
  const sendErrorResponse = dependencies.sendError || sendError;
  const loadProfile = dependencies.loadProfile || pronunciationProfile.loadPronunciationProfile;

  // POST /pronunciation/assess
  if (pathname === '/pronunciation/assess' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const usageLimits = getUsageLimits(user);
      let usage = null;
      if (Number.isFinite(usageLimits.dailyPronunciationAssessments)) {
        const usedToday = await dataStore.countPronunciationAssessmentsToday(user.id);
        const remaining = Math.max(0, usageLimits.dailyPronunciationAssessments - usedToday);
        usage = {
          used_today: usedToday,
          limit: usageLimits.dailyPronunciationAssessments,
          remaining,
          tier: usageLimits.tier,
        };
        if (remaining <= 0) {
          await recordQuotaLimitReached(
            user.id,
            'pronunciation',
            'PRONUNCIATION_DAILY_LIMIT_REACHED',
            usage,
            usageLimits.entitlement,
          );
          return sendJson(res, 402, {
            code: 'PRONUNCIATION_DAILY_LIMIT_REACHED',
            message: 'PRONUNCIATION_DAILY_LIMIT_REACHED',
            quota: usage,
            paywall: buildQuotaPaywall({
              feature: 'pronunciation',
              quota: usage,
              entitlement: usageLimits.entitlement,
            }),
            entitlement: {
              tier: usageLimits.entitlement.tier,
              effective_tier: usageLimits.entitlement.effectiveTier,
              reason: usageLimits.entitlement.reason,
            },
          });
        }
      }

      const body = await parseBody(req);
      const text = (body?.text || '').trim();
      const lemma = body?.lemma || null;
      const videoId = normalizePositiveDecimalId(body?.video_id ?? body?.videoId);
      const audioData = body?.audio_data || body?.audio || null; // data URL base64
      const fastAsr = body?.fast_asr === true;
      const durationSeconds = normalizeDurationSeconds(body?.duration_seconds ?? body?.durationSeconds);
      if (!text || !audioData) {
        return sendError(res, 400, 'TEXT_AND_AUDIO_REQUIRED');
      }

      // Persist temp audio and convert to wav 16k
      const { mimeType, buffer } = parseBase64DataUrl(audioData);
      const ext = getExtensionFromMime(mimeType);
      const tmpInput = path.join(os.tmpdir(), `pron-${Date.now()}-${randomBytes(5).toString('hex')}.${ext}`);
      await fsp.writeFile(tmpInput, buffer);

      let wavPath = tmpInput;
      try {
        wavPath = await convertAudioToWav(tmpInput, 16000);
      } catch (e) {
        console.warn('convertAudioToWav failed, try raw input for ASR:', e?.message || e);
      }

      const assessed = fastAsr
        ? await pronunciationService.assessFileWithAsr(wavPath, text, {
          sampleRate: 16000,
          durationSeconds,
        })
        : await pronunciationService.assessWithAsr(
          await fsp.readFile(wavPath),
          text,
          { sampleRate: 16000, durationSeconds },
        );
      const saved = await dataStore.savePronunciationAssessment(user.id, {
        lemma,
        video_resource_id: videoId,
        text,
        audio_path: null,
        overall: assessed.overall,
        accuracy: assessed.accuracy,
        fluency: assessed.fluency,
        completeness: assessed.completeness,
        words: assessed.words,
        phonemes: assessed.phonemes,
        provider: assessed.provider,
        coaching: assessed.coaching,
        analysis_version: assessed.analysis_version,
        duration_seconds: assessed.duration_seconds,
        speech_rate_wpm: assessed.speech_rate_wpm,
      });

      // Update phoneme focus if provided
      if (Array.isArray(assessed.phonemes)) {
        for (const p of assessed.phonemes) {
          if (p && p.error) {
            await dataStore.bumpPronunciationPhoneme(user.id, p.symbol || p.phoneme || 'unknown', 1);
          }
        }
      }

      try { await removeFileSafe(tmpInput); } catch(_) {}
      try { if (wavPath !== tmpInput) await removeFileSafe(wavPath); } catch(_) {}

      if (usage) {
        usage.used_today += 1;
        usage.remaining = Math.max(0, usage.limit - usage.used_today);
      }

      return sendJson(res, 200, await buildAssessmentApiResponse({
        store: dataStore,
        userId: user.id,
        saved,
        assessed,
        quota: usage,
        updateProfile: dependencies.updateProfile || pronunciationProfile.updateProfileAfterAssessment,
        warn: dependencies.warn || console.warn,
      }));
    } catch (err) {
      // Don't pass through 401 from ASR/STT providers (OpenAI, etc.) as it confuses the frontend
      // into thinking the user's auth token expired. Map 401 from STT to 503 (service unavailable).
      let status = err.status || mapErrorToStatus(err, 400);
      if (status === 401 && err.message && !err.message.includes('UNAUTHORIZED') && !err.message.includes('TOKEN_EXPIRED')) {
        console.warn('[Pronunciation] ASR provider returned 401 (likely API key issue), mapping to 503');
        status = 503;
      }
      return sendError(res, status, err.message);
    }
  }

  // GET /pronunciation/profile
  if (pathname === '/pronunciation/profile' && req.method === 'GET') {
    try {
      const user = await authenticateUser(req);
      const limit = normalizeProfileLimit(url.searchParams.get('limit'));
      const profile = await loadProfile(store, user.id, { limit, now: dependencies.now || new Date() });
      return sendJsonResponse(res, 200, profile);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendErrorResponse(res, status, err.message);
    }
  }

  // GET /pronunciation/assessments/:id/focus
  const focusMatch = pathname.match(/^\/pronunciation\/assessments\/(\d+)\/focus$/);
  if (focusMatch && req.method === 'GET') {
    try {
      const user = await authenticateUser(req);
      const assessmentId = normalizePositiveDecimalId(focusMatch[1]);
      if (!assessmentId) return sendErrorResponse(res, 400, 'INVALID_ASSESSMENT_ID');
      const focus = await store.getPronunciationAssessmentFocus(user.id, assessmentId);
      if (!focus) return sendErrorResponse(res, 404, 'ASSESSMENT_NOT_FOUND');
      return sendJsonResponse(res, 200, buildAssessmentFocusResponse(focus));
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendErrorResponse(res, status, err.message);
    }
  }

  // GET /pronunciation/history
  if (pathname === '/pronunciation/history' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const lemma = url.searchParams.get('lemma') || null;
      const videoId = url.searchParams.get('video_id') || url.searchParams.get('videoId') || null;
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 20;
      const items = await dataStore.listPronunciationAssessments(user.id, { lemma, videoId, limit });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /pronunciation/focus
  if (pathname === '/pronunciation/focus' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 10;
      const items = await dataStore.listPronunciationFocus(user.id, { limit });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = {
  registerPronunciationRoutes,
  normalizeDurationSeconds,
  normalizeProfileLimit,
  normalizePositiveDecimalId,
  buildAssessmentResponse,
  buildAssessmentApiResponse,
  buildAssessmentFocusResponse,
};
