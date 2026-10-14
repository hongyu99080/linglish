const roleplayService = require('../services/roleplay');
const cacheService = require('../services/cache');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');

function buildUserCacheKey(userId, suffix) {
  return `quests:user:${userId}:${suffix}`;
}

async function invalidateQuestCache(userId) {
  return cacheService.invalidate(`quests:user:${userId}:*`);
}

/**
 * Register and handle quest and roleplay routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @param {object} routeMatches - Pre-computed route matches
 * @param {RegExpMatchArray} routeMatches.questRouteMatch - Match for /videos/:id/quests
 * @param {RegExpMatchArray} routeMatches.questRunsRouteMatch - Match for /quests/:id/runs
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerQuestsRoutes(pathname, req, res, url, routeMatches = {}) {
  const { questRouteMatch, questRunsRouteMatch } = routeMatches;

  // GET /videos/:id/quests
  if (questRouteMatch && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const videoId = Number(questRouteMatch[1]);
      const cacheKey = buildUserCacheKey(user.id, `video:${videoId}:quests`);
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const quests = await roleplayService.listQuests(videoId);
      const payload = { items: quests };
      await cacheService.set(cacheKey, payload, 120);
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = mapErrorToStatus(err, err.status || 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /videos/:id/quests
  if (questRouteMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const videoId = Number(questRouteMatch[1]);
      const body = await parseBody(req);
      const quest = await roleplayService.createQuest(user.id, videoId, body);
      await invalidateQuestCache(user.id);
      return sendJson(res, 201, { quest });
    } catch (err) {
      const status =
        err.message === 'UNAUTHORIZED'
          ? 401
          : err.status || (err.message === 'VIDEO_NOT_FOUND' ? 404 : 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /quests/:id/runs
  if (questRunsRouteMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const questId = Number(questRunsRouteMatch[1]);
      const body = await parseBody(req);
      const result = await roleplayService.evaluateRun(user.id, questId, body);
      await invalidateQuestCache(user.id);
      return sendJson(res, 201, result);
    } catch (err) {
      const status =
        err.message === 'UNAUTHORIZED'
          ? 401
          : err.status || (err.message === 'QUEST_NOT_FOUND' ? 404 : 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /quests/:id/runs
  if (questRunsRouteMatch && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const questId = Number(questRunsRouteMatch[1]);
      const limit = url.searchParams.get('limit')
        ? Number(url.searchParams.get('limit'))
        : undefined;
      const cacheKey = buildUserCacheKey(user.id, `quest:${questId}:runs:${limit || 'all'}`);
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const runs = await roleplayService.listRuns(user.id, questId, limit);
      const payload = { items: runs };
      await cacheService.set(cacheKey, payload, 120);
      return sendJson(res, 200, payload);
    } catch (err) {
      const status =
        err.message === 'UNAUTHORIZED'
          ? 401
          : err.status || (err.message === 'QUEST_NOT_FOUND' ? 404 : 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /rewards
  if (pathname === '/rewards' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = url.searchParams.get('limit')
        ? Number(url.searchParams.get('limit'))
        : undefined;
      const cacheKey = buildUserCacheKey(user.id, `rewards:${limit || 'all'}`);
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const rewards = await roleplayService.listRewards(user.id, limit);
      const payload = { items: rewards };
      await cacheService.set(cacheKey, payload, 120);
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerQuestsRoutes };
