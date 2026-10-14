/**
 * Word Deep Analysis Route
 * GET /api/word/deep/:word
 *
 * Returns AI-generated deep analysis for a word (etymology, core image,
 * comparisons, mermaid chart, philosophy). Results are cached in DB forever.
 */

const { sendJson, sendError } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rate-limiter');
const dataStore = require('../data-store');
const AITutorService = require('../ai-services/ai-tutor-service');
const { buildQuotaPaywall, getUsageLimits } = require('../services/entitlements');

// 20 deep analysis requests per hour per IP (GPT-4o-mini still costs money)
const deepRateLimiter = createRateLimiter({
  windowMs: 3600000,
  max: 20,
  message: '深度解析每小时限 20 次，请稍后再试',
});

// Lazy singleton – instantiated once per process
let _aiTutor = null;
function getAiTutor() {
  if (!_aiTutor) _aiTutor = new AITutorService(dataStore);
  return _aiTutor;
}

async function checkDailyDeepWordLimit(user) {
  const usageLimits = getUsageLimits(user);
  const limit = usageLimits.dailyDeepWordGenerations;
  if (!Number.isFinite(limit)) {
    return { quota: null, usageLimits };
  }

  const usedToday = await dataStore.countEventsToday({ userId: user.id, name: 'word_deep_generated' });
  const quota = {
    used_today: usedToday,
    limit,
    remaining: Math.max(0, limit - usedToday),
    tier: usageLimits.tier,
  };

  if (quota.remaining <= 0) {
    const err = new Error('WORD_DEEP_DAILY_LIMIT_REACHED');
    err.status = 402;
    err.code = 'WORD_DEEP_DAILY_LIMIT_REACHED';
    err.quota = quota;
    err.entitlement = usageLimits.entitlement;
    throw err;
  }

  return { quota, usageLimits };
}

function sendQuotaError(res, err) {
  return sendJson(res, err.status || 402, {
    code: err.code || err.message,
    message: err.message,
    quota: err.quota,
    paywall: buildQuotaPaywall({
      feature: 'word_deep',
      quota: err.quota,
      entitlement: err.entitlement,
    }),
    entitlement: err.entitlement ? {
      tier: err.entitlement.tier,
      effective_tier: err.entitlement.effectiveTier,
      reason: err.entitlement.reason,
    } : null,
  });
}

async function registerWordDeepRoutes(pathname, req, res, url) {
  // GET /api/word/deep/:word
  const match = pathname.match(/^\/api\/word\/deep\/([^/]+)$/);
  if (!match || req.method !== 'GET') return false;

  // Require login – this endpoint calls AI and must not be exposed publicly
  let user;
  try {
    user = await authenticate(req);
  } catch (_) {
    return sendError(res, 401, 'Login required');
  }

  const word = decodeURIComponent(match[1] || '').trim().toLowerCase();
  if (!word || word.length > 100) {
    return sendError(res, 400, 'Invalid word');
  }

  const forceRefresh = url.searchParams.get('refresh') === '1';

  try {
    if (!forceRefresh) {
      try {
        const cached = await dataStore.query(
          'SELECT raw_json FROM word_deep_cache WHERE word = $1',
          [word],
        );
        if (cached.rows.length > 0 && cached.rows[0].raw_json) {
          return sendJson(res, 200, { success: true, word, data: cached.rows[0].raw_json, cached: true });
        }
      } catch (cacheErr) {
        console.warn('[WordDeep] Cache lookup failed before quota check:', cacheErr.message);
      }
    }

    // Rate limit and entitlement quota only apply when AI generation is needed.
    if (!deepRateLimiter(req, res)) return true;
    const { quota, usageLimits } = await checkDailyDeepWordLimit(user);
    const aiTutor = getAiTutor();
    const result = await aiTutor.generateDeepWordExplain(word, { forceRefresh });
    await dataStore.createEvent({
      user_id: user.id,
      event_time: new Date().toISOString(),
      event_name: 'word_deep_generated',
      properties: { word, force_refresh: forceRefresh, tier: usageLimits.tier },
      source: 'web',
    });
    if (quota && Number.isFinite(quota.limit)) {
      quota.used_today += 1;
      quota.remaining = Math.max(0, quota.limit - quota.used_today);
    }
    return sendJson(res, 200, { success: true, word, data: result, cached: false, quota });
  } catch (err) {
    if (err.status === 402) {
      try {
        await dataStore.createEvent({
          user_id: user.id,
          event_time: new Date().toISOString(),
          event_name: 'quota_limit_reached',
          properties: {
            feature: 'word_deep',
            code: err.code || err.message,
            word,
            tier: err.quota?.tier || null,
            effective_tier: err.entitlement?.effectiveTier || null,
            limit: err.quota?.limit ?? null,
            used_today: err.quota?.used_today ?? null,
          },
          source: 'web',
        });
      } catch (eventErr) {
        console.warn('[Quota] Failed to record word deep quota event:', eventErr?.message || eventErr);
      }
      return sendQuotaError(res, err);
    }
    console.error('[WordDeep] Error generating deep analysis for', word, err.message);
    return sendError(res, 500, err.message || 'Failed to generate deep analysis');
  }
}

module.exports = { registerWordDeepRoutes };
