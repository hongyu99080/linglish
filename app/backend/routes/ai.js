const aiService = require('../services/ai');
const reviewScheduler = require('../services/review-scheduler');
const spacedRepetition = require('../services/spaced-repetition');
const cacheService = require('../services/cache');
const dataStore = require('../data-store');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const { buildQuotaPaywall, getUsageLimits } = require('../services/entitlements');

function buildUserCacheKey(userId, suffix) {
  return `review:user:${userId}:${suffix}`;
}

async function invalidateReviewCache(userId) {
  return cacheService.invalidate(`review:user:${userId}:*`);
}

async function checkDailyLimit(user, eventName, limit, code) {
  if (!Number.isFinite(limit)) {
    return null;
  }

  const usedToday = await dataStore.countEventsToday({ userId: user.id, name: eventName });
  const remaining = Math.max(0, limit - usedToday);
  const usageLimits = getUsageLimits(user);
  const quota = {
    used_today: usedToday,
    limit,
    remaining,
    tier: usageLimits.tier,
  };

  if (remaining <= 0) {
    const err = new Error(code);
    err.status = 402;
    err.code = code;
    err.quota = quota;
    err.entitlement = usageLimits.entitlement;
    err.user_id = user.id;
    throw err;
  }

  return quota;
}

function sendQuotaError(res, err) {
  return sendJson(res, err.status || 402, {
    code: err.code || err.message,
    message: err.message,
    quota: err.quota,
    paywall: buildQuotaPaywall({
      feature: 'ai_score',
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

/**
 * Register and handle AI and review planning routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerAiRoutes(pathname, req, res, url) {
  // POST /ai/score
  if (pathname === '/ai/score' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const usageLimits = getUsageLimits(user);
      const quota = await checkDailyLimit(
        user,
        'ai_score_requested',
        usageLimits.dailyAiScores,
        'AI_SCORE_DAILY_LIMIT_REACHED',
      );
      const body = await parseBody(req);
      const sessionId = Number(body.session_id);
      await aiService.triggerScore(user.id, sessionId);
      await dataStore.createEvent({
        user_id: user.id,
        event_time: new Date().toISOString(),
        event_name: 'ai_score_requested',
        properties: { session_id: sessionId, tier: usageLimits.tier },
        source: 'web',
      });
      if (quota && Number.isFinite(quota.limit)) {
        quota.used_today += 1;
        quota.remaining = Math.max(0, quota.limit - quota.used_today);
      }
      return sendJson(res, 202, { status: 'queued', quota });
    } catch (err) {
      if (err.message === 'SESSION_NOT_FOUND') {
        return sendError(res, 404, err.message);
      }
      if (err.status === 402) {
        try {
          await dataStore.createEvent({
            user_id: err.user_id || null,
            event_time: new Date().toISOString(),
            event_name: 'quota_limit_reached',
            properties: {
              feature: 'ai_score',
              code: err.code || err.message,
              tier: err.quota?.tier || null,
              effective_tier: err.entitlement?.effectiveTier || null,
              limit: err.quota?.limit ?? null,
              used_today: err.quota?.used_today ?? null,
            },
            source: 'web',
          });
        } catch (eventErr) {
          console.warn('[Quota] Failed to record AI score quota event:', eventErr?.message || eventErr);
        }
        return sendQuotaError(res, err);
      }
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /ai/score/:id
  if (pathname.startsWith('/ai/score/') && req.method === 'GET') {
    try {
      await authenticate(req);
      const sessionId = Number(pathname.split('/').pop());
      const score = await aiService.getScore(sessionId);
      return sendJson(res, 200, score);
    } catch (err) {
      if (err.message === 'SCORE_NOT_FOUND') {
        return sendError(res, 404, err.message);
      }
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /review/daily-plan
  if (pathname === '/review/daily-plan' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const cacheKey = buildUserCacheKey(user.id, 'daily-plan');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const plan = await reviewScheduler.getDailyPlan(user.id);
      await cacheService.set(cacheKey, plan, 60);
      return sendJson(res, 200, plan);
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /review/dashboard
  if (pathname === '/review/dashboard' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const cacheKey = buildUserCacheKey(user.id, 'dashboard');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const dashboard = await reviewScheduler.getReviewDashboard(user.id);
      await cacheService.set(cacheKey, dashboard, 60);
      return sendJson(res, 200, dashboard);
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /review/due-items
  if (pathname === '/review/due-items' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = parseInt(url.searchParams.get('limit')) || 20;
      const includeNew = url.searchParams.get('includeNew') !== 'false';
      const includeReview = url.searchParams.get('includeReview') !== 'false';
      const includeRelearn = url.searchParams.get('includeRelearn') !== 'false';

      const cacheKey = buildUserCacheKey(
        user.id,
        `due-items:${limit}:${includeNew ? '1' : '0'}:${includeReview ? '1' : '0'}:${includeRelearn ? '1' : '0'}`,
      );
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const items = await spacedRepetition.getDueItems(user.id, {
        limit,
        includeNew,
        includeReview,
        includeRelearn
      });
      const payload = { items };
      await cacheService.set(cacheKey, payload, 60);
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /review/record
  if (pathname === '/review/record' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);

      if (!body.schedule_id || !body.rating) {
        return sendError(res, 400, 'schedule_id and rating are required');
      }

      const result = await spacedRepetition.recordReview(
        user.id,
        Number(body.schedule_id),
        Number(body.rating),
        {
          timeTakenMs: body.time_taken_ms,
          pronunciationScore: body.pronunciation_score,
          fluencyScore: body.fluency_score,
          accuracyScore: body.accuracy_score
        }
      );

      // Mark item as completed in daily plan
      await reviewScheduler.markItemCompleted(user.id, Number(body.schedule_id));

      await invalidateReviewCache(user.id);
      return sendJson(res, 200, result);
    } catch (err) {
      if (err.message === 'SCHEDULE_NOT_FOUND') {
        return sendError(res, 404, err.message);
      }
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /review/stats
  if (pathname === '/review/stats' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const cacheKey = buildUserCacheKey(user.id, 'stats');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const stats = await spacedRepetition.getReviewStats(user.id);
      await cacheService.set(cacheKey, stats, 60);
      return sendJson(res, 200, stats);
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /review/add-vocabulary
  if (pathname === '/review/add-vocabulary' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);

      if (!body.session_id || !Array.isArray(body.vocabulary)) {
        return sendError(res, 400, 'session_id and vocabulary array are required');
      }

      const scheduleItems = await reviewScheduler.addVocabularyFromSession(
        user.id,
        Number(body.session_id),
        body.vocabulary
      );

      await invalidateReviewCache(user.id);
      return sendJson(res, 201, { items: scheduleItems });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerAiRoutes };
