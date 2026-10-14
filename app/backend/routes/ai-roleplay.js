'use strict';

const aiConfig = require('../config/ai-config');
const { parseBody } = require('../utils/parsers');
const { sendJson, mapErrorToStatus } = require('../middleware/error-handler');

const CANONICAL_DECIMAL_ID = /^[1-9]\d*$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TRANSCRIBE_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TRANSCRIBE_AUDIO_LIMIT_BYTES = 6 * 1024 * 1024;
const DEFAULT_REVIEW_BODY_LIMIT_BYTES = 16 * 1024;

let defaultEngine = null;
let defaultTranscriber = null;
let defaultGenerator = null;
let defaultReviewItemSaver = null;

function isRoleplayPath(pathname) {
  return pathname === '/ai-roleplay' || pathname.startsWith('/ai-roleplay/');
}

function featureEnabled(config) {
  return config?.features?.aiRoleplay === true;
}

function sendDisabled(sendJsonResponse, res) {
  return sendJsonResponse(res, 404, { code: 404, message: 'Not Found' });
}

function sendCode(sendJsonResponse, res, status, code) {
  return sendJsonResponse(res, status, { code });
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function canonicalDecimalId(raw) {
  return typeof raw === 'string' && CANONICAL_DECIMAL_ID.test(raw) ? raw : null;
}

function canonicalTurnKey(raw) {
  return typeof raw === 'string' && UUID_V4.test(raw) ? raw : null;
}

function normalizeErrorCode(error) {
  return error?.code || error?.message || 'AI_ROLEPLAY_ERROR';
}

function statusForError(error) {
  const code = normalizeErrorCode(error);
  if (
    code === 'SESSION_NOT_FOUND'
    || code === 'SCENARIO_NOT_FOUND'
    || code === 'TURN_NOT_FOUND'
  ) {
    return 404;
  }
  if (
    code === 'SESSION_ID_INVALID'
    || code === 'USER_ID_INVALID'
    || code === 'TURN_KEY_INVALID'
    || code === 'TRANSCRIPT_INVALID'
    || code === 'TRANSCRIPT_TOO_LONG'
    || code === 'INVALID_AUDIO_DURATION'
    || code === 'INVALID_AUDIO_DATA'
    || code === 'EMPTY_TRANSCRIPT'
    || code === 'INVALID_JSON'
    || code === 'REVIEW_ITEMS_INVALID'
    || code === 'REVIEW_ITEM_NOT_ALLOWED'
  ) {
    return 400;
  }
  if (
    code === 'REQUEST_BODY_TOO_LARGE'
    || code === 'AUDIO_TOO_LARGE'
  ) {
    return 413;
  }
  if (code === 'TURN_IN_PROGRESS') {
    return 409;
  }
  if (code === 'SESSION_NOT_COMPLETED' || code === 'REVIEW_WINDOW_EXPIRED') {
    return 409;
  }
  if (
    code === 'DATASTORE_UNAVAILABLE'
    || code === 'TEMP_CLEANUP_FAILED'
    || code === 'AI_TURN_TIMEOUT'
    || code === 'AI_ROLEPLAY_GENERATOR_INVALID'
    || code === 'REVIEW_ITEM_SAVE_UNAVAILABLE'
    || code === 'REVIEW_ITEM_SAVE_FAILED'
  ) {
    return 503;
  }
  return error?.status || mapErrorToStatus(error, 500);
}

function publicErrorCode(error) {
  const code = normalizeErrorCode(error);
  if (
    code === 'SESSION_NOT_FOUND'
    || code === 'SCENARIO_NOT_FOUND'
    || code === 'TURN_NOT_FOUND'
    || code === 'SESSION_ID_INVALID'
    || code === 'TURN_KEY_INVALID'
    || code === 'TRANSCRIPT_INVALID'
    || code === 'TRANSCRIPT_TOO_LONG'
    || code === 'INVALID_AUDIO_DURATION'
    || code === 'INVALID_AUDIO_DATA'
    || code === 'REQUEST_BODY_TOO_LARGE'
    || code === 'AUDIO_TOO_LARGE'
    || code === 'EMPTY_TRANSCRIPT'
    || code === 'INVALID_JSON'
    || code === 'REVIEW_ITEMS_INVALID'
    || code === 'REVIEW_ITEM_NOT_ALLOWED'
    || code === 'SESSION_NOT_COMPLETED'
    || code === 'REVIEW_WINDOW_EXPIRED'
  ) {
    return code;
  }
  if (code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED') {
    return code;
  }
  if (code === 'DATASTORE_UNAVAILABLE') {
    return code;
  }
  return statusForError(error) >= 500 ? 'AI_ROLEPLAY_UNAVAILABLE' : 'AI_ROLEPLAY_ERROR';
}

function sendSafeError(sendJsonResponse, res, error) {
  const code = normalizeErrorCode(error);
  if (code === 'TURN_IN_PROGRESS') {
    return sendJsonResponse(res, 409, {
      code: 'TURN_IN_PROGRESS',
      retry_after_ms: 600,
    });
  }
  const status = statusForError(error);
  return sendJsonResponse(res, status, { code: publicErrorCode(error) });
}

function getDefaultOpenAIClient() {
  const OpenAI = require('openai');
  return new OpenAI({
    apiKey: aiConfig.openai?.apiKey,
    baseURL: aiConfig.openai?.baseURL,
  });
}

async function generateTurnWithDefaultProvider(context) {
  if (!defaultGenerator) {
    const { createAIRoleplayGenerator } = require('../services/ai-roleplay/ai-generator');
    defaultGenerator = createAIRoleplayGenerator({
      openai: getDefaultOpenAIClient(),
      model: aiConfig.openai?.models?.roleplay,
    });
  }
  return defaultGenerator.generateTurn(context);
}

function createReviewItemSaveAdapter({ dataStore } = {}) {
  if (!dataStore?.pool || typeof dataStore.pool.connect !== 'function' || typeof dataStore.init !== 'function') {
    fail('REVIEW_ITEM_SAVE_UNAVAILABLE');
  }
  return async function saveReviewItem(userId, item, context) {
    const normalizedUserId = canonicalDecimalId(String(userId));
    const sessionId = canonicalDecimalId(String(context?.session_id || ''));
    const scenarioId = typeof context?.scenario_id === 'string'
      && /^[a-z0-9-]{1,80}$/.test(context.scenario_id)
      ? context.scenario_id
      : null;
    if (!normalizedUserId || !sessionId || !scenarioId) fail('REVIEW_ITEM_SAVE_FAILED');
    await dataStore.init();
    dataStore.assertDbAvailable?.();
    const sourceContext = JSON.stringify({ scenario_id: scenarioId, session_id: sessionId });

    if (item?.kind !== 'phrase') fail('REVIEW_ITEM_SAVE_FAILED');
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    const meaningZh = typeof item.meaning_zh === 'string' ? item.meaning_zh.trim() : '';
    if (!value || value.length > 600 || meaningZh.length > 600) fail('REVIEW_ITEM_SAVE_FAILED');

    const client = await dataStore.pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const insertedPhrase = await client.query(
        `INSERT INTO vocabulary_phrases
           (user_id, phrase_text, phrase_type, source_context, notes, tags, first_seen_at, last_seen_at, exposure_count, created_at)
         VALUES ($1, $2, 'roleplay_expression', $3, NULLIF($4, ''), ARRAY[$5]::text[], NOW(), NOW(), 1, NOW())
         ON CONFLICT (user_id, phrase_text) DO NOTHING
         RETURNING id::text AS id`,
        [normalizedUserId, value, sourceContext, meaningZh, String(item.source_kind || 'roleplay')],
      );
      let phraseId = insertedPhrase?.rows?.[0]?.id;
      if (!phraseId) {
        const canonicalPhrase = await client.query(
          `SELECT id::text AS id
             FROM vocabulary_phrases
            WHERE user_id = $1 AND phrase_text = $2
            LIMIT 1`,
          [normalizedUserId, value],
        );
        phraseId = canonicalPhrase?.rows?.[0]?.id;
      }
      if (!phraseId) fail('REVIEW_ITEM_SAVE_FAILED');

      const insertedSchedule = await client.query(
        `INSERT INTO review_schedule
           (user_id, item_type, item_id, lemma, ease_factor, interval_days, repetitions,
            state, next_review_at, due_date, source_session_id, source_context, created_at, updated_at)
         VALUES ($1, 'phrase', $2, LEFT($3, 50), 2.5, 1, 0,
                 'new', NOW() + INTERVAL '1 day', (NOW() + INTERVAL '1 day')::date,
                 NULL, $4, NOW(), NOW())
         ON CONFLICT (user_id, item_type, item_id) DO NOTHING
         RETURNING id`,
        [normalizedUserId, String(phraseId), value, sourceContext],
      );
      await client.query('COMMIT');
      transactionStarted = false;
      return {
        kind: insertedSchedule?.rows?.length ? 'saved' : 'existing',
        item_id: String(phraseId),
      };
    } catch (error) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK'); } catch (_) { /* preserve original save failure */ }
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

function getDefaultReviewItemSaver(dataStore) {
  if (!defaultReviewItemSaver) {
    defaultReviewItemSaver = createReviewItemSaveAdapter({ dataStore });
  }
  return defaultReviewItemSaver;
}

function getDefaultEngine() {
  if (defaultEngine) return defaultEngine;
  const repository = require('../data-store/queries/ai-roleplay');
  const dataStore = require('../data-store');
  const { createAIRoleplayEngine } = require('../services/ai-roleplay/engine');
  defaultEngine = createAIRoleplayEngine({
    repository,
    generateTurn: generateTurnWithDefaultProvider,
    saveReviewItem: getDefaultReviewItemSaver(dataStore),
    createEvent: async ({ name, userId, properties }) => dataStore.createEvent({
      user_id: userId,
      event_time: new Date().toISOString(),
      event_name: name,
      properties,
      source: 'web',
    }),
  });
  return defaultEngine;
}

function getDefaultTranscriber() {
  if (defaultTranscriber) return defaultTranscriber;
  const { createRoleplayTranscriber } = require('../services/ai-roleplay/transcription');
  defaultTranscriber = createRoleplayTranscriber();
  return defaultTranscriber;
}

function resolveEngine(dependencies) {
  if (dependencies.engine) return dependencies.engine;
  if (typeof dependencies.createEngine === 'function') return dependencies.createEngine();
  return getDefaultEngine();
}

function resolveTranscriber(dependencies) {
  if (dependencies.transcriber) return dependencies.transcriber;
  if (typeof dependencies.createTranscriber === 'function') return dependencies.createTranscriber();
  return getDefaultTranscriber();
}

function getDefaultAuthenticate() {
  return require('../middleware/auth').authenticate;
}

function resolveAuthenticate(dependencies) {
  return dependencies.authenticate || getDefaultAuthenticate();
}

function transcribeBodyLimit(dependencies) {
  const configured = Number(dependencies.maxTranscribeBodyBytes);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_TRANSCRIBE_BODY_LIMIT_BYTES;
}

function transcribeAudioLimit(dependencies) {
  const configured = Number(dependencies.maxTranscribeAudioBytes);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_TRANSCRIBE_AUDIO_LIMIT_BYTES;
}

function reviewBodyLimit(dependencies) {
  const configured = Number(dependencies.maxReviewBodyBytes);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_REVIEW_BODY_LIMIT_BYTES;
}

function declaredContentLength(req) {
  const raw = req?.headers?.['content-length'];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function parseLimitedJsonBody(req, maxBytes) {
  const declared = declaredContentLength(req);
  if (declared !== null && declared > maxBytes) {
    fail('REQUEST_BODY_TOO_LARGE');
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      fail('REQUEST_BODY_TOO_LARGE');
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
  } catch (_) {
    fail('INVALID_JSON');
  }
}

function estimateBase64DecodedBytes(base64Payload) {
  const compact = String(base64Payload || '').replace(/\s+/g, '');
  if (!compact) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function assertAudioByteLimit(audioData, maxBytes) {
  if (typeof audioData !== 'string') return;
  const match = audioData.match(/^data:[^;]+;base64,(.+)$/);
  if (!match) return;
  if (estimateBase64DecodedBytes(match[1]) > maxBytes) {
    fail('AUDIO_TOO_LARGE');
  }
}

function sessionRoute(pathname, suffix = '') {
  const pattern = new RegExp(`^/ai-roleplay/sessions/([^/]+)${suffix}$`);
  return pathname.match(pattern);
}

async function registerAIRoleplayRoutes(pathname, req, res, url, dependencies = {}) {
  if (!isRoleplayPath(pathname)) {
    return false;
  }

  const config = dependencies.aiConfig || aiConfig;
  const sendJsonResponse = dependencies.sendJson || sendJson;
  const parseRequestBody = dependencies.parseBody || parseBody;

  if (!featureEnabled(config)) {
    sendDisabled(sendJsonResponse, res);
    return true;
  }

  try {
    if (pathname === '/ai-roleplay/scenarios' && req.method === 'GET') {
      const authenticateUser = resolveAuthenticate(dependencies);
      const user = await authenticateUser(req);
      const engine = resolveEngine(dependencies);
      const scenarios = await engine.listScenarios(String(user.id), {
        level: url.searchParams.get('level') || null,
        category: url.searchParams.get('category') || null,
        limit: url.searchParams.get('limit') || null,
      });
      sendJsonResponse(res, 200, { scenarios });
      return true;
    }

    if (pathname === '/ai-roleplay/sessions' && req.method === 'POST') {
      const authenticateUser = resolveAuthenticate(dependencies);
      const user = await authenticateUser(req);
      const body = await parseRequestBody(req);
      const engine = resolveEngine(dependencies);
      const response = await engine.startSession(String(user.id), body || {});
      sendJsonResponse(res, 201, response);
      return true;
    }

    const getSessionMatch = sessionRoute(pathname);
    if (getSessionMatch && req.method === 'GET') {
      const authenticateUser = resolveAuthenticate(dependencies);
      const user = await authenticateUser(req);
      const sessionId = canonicalDecimalId(getSessionMatch[1]);
      if (!sessionId) {
        sendCode(sendJsonResponse, res, 400, 'SESSION_ID_INVALID');
        return true;
      }
      const engine = resolveEngine(dependencies);
      const response = await engine.getSession(String(user.id), sessionId);
      sendJsonResponse(res, 200, response);
      return true;
    }

    const turnMatch = sessionRoute(pathname, '/turns');
    if (turnMatch && req.method === 'POST') {
      const authenticateUser = resolveAuthenticate(dependencies);
      const user = await authenticateUser(req);
      const sessionId = canonicalDecimalId(turnMatch[1]);
      if (!sessionId) {
        sendCode(sendJsonResponse, res, 400, 'SESSION_ID_INVALID');
        return true;
      }
      const body = await parseRequestBody(req);
      const turnKey = canonicalTurnKey(body?.turn_key || body?.turnKey);
      if (!turnKey) {
        sendCode(sendJsonResponse, res, 400, 'TURN_KEY_INVALID');
        return true;
      }
      const engine = resolveEngine(dependencies);
      const response = await engine.advanceTurn(String(user.id), sessionId, {
        ...body,
        turn_key: turnKey,
      });
      sendJsonResponse(res, 201, response);
      return true;
    }

    const completeMatch = sessionRoute(pathname, '/complete');
    if (completeMatch && req.method === 'POST') {
      const authenticateUser = resolveAuthenticate(dependencies);
      const user = await authenticateUser(req);
      const sessionId = canonicalDecimalId(completeMatch[1]);
      if (!sessionId) {
        sendCode(sendJsonResponse, res, 400, 'SESSION_ID_INVALID');
        return true;
      }
      const engine = resolveEngine(dependencies);
      const response = await engine.completeSession(String(user.id), sessionId);
      sendJsonResponse(res, 200, response);
      return true;
    }

    const reviewItemsMatch = sessionRoute(pathname, '/review-items');
    if (reviewItemsMatch && req.method === 'POST') {
      const authenticateUser = resolveAuthenticate(dependencies);
      const user = await authenticateUser(req);
      const sessionId = canonicalDecimalId(reviewItemsMatch[1]);
      if (!sessionId) {
        sendCode(sendJsonResponse, res, 400, 'SESSION_ID_INVALID');
        return true;
      }
      const body = dependencies.parseBody
        ? await parseRequestBody(req)
        : await parseLimitedJsonBody(req, reviewBodyLimit(dependencies));
      const engine = resolveEngine(dependencies);
      const response = await engine.saveReviewItems(String(user.id), sessionId, body || {});
      sendJsonResponse(res, 200, response);
      return true;
    }

    if (pathname === '/ai-roleplay/transcribe' && req.method === 'POST') {
      const authenticateUser = resolveAuthenticate(dependencies);
      await authenticateUser(req);
      const body = dependencies.parseBody
        ? await parseRequestBody(req)
        : await parseLimitedJsonBody(req, transcribeBodyLimit(dependencies));
      const audioData = body?.audio_data || body?.audioData || body?.audio;
      assertAudioByteLimit(audioData, transcribeAudioLimit(dependencies));
      const transcriber = resolveTranscriber(dependencies);
      const response = await transcriber.transcribe({
        audioData,
        durationSeconds: body?.duration_seconds ?? body?.durationSeconds,
        language: body?.language || 'en',
        duration_seconds: body?.duration_seconds ?? body?.durationSeconds,
      });
      sendJsonResponse(res, 200, response);
      return true;
    }
  } catch (error) {
    sendSafeError(sendJsonResponse, res, error);
    return true;
  }

  return false;
}

module.exports = {
  registerAIRoleplayRoutes,
  _private: {
    canonicalDecimalId,
    canonicalTurnKey,
    parseLimitedJsonBody,
    publicErrorCode,
    statusForError,
    createReviewItemSaveAdapter,
  },
};
