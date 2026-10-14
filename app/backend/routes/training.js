const trainingService = require('../services/training');
const dataStore = require('../data-store');
const cacheService = require('../services/cache');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');

function normalizeVisitorId(value) {
  if (typeof value !== 'string') return null;
  const visitorId = value.trim();
  return /^llv_[a-zA-Z0-9_-]{12,64}$/.test(visitorId) ? visitorId : null;
}

function buildUserCacheKey(userId, suffix) {
  return `training:user:${userId}:${suffix}`;
}

async function invalidateTrainingCache(userId) {
  return cacheService.invalidate(`training:user:${userId}:*`);
}

/**
 * Register and handle training-related routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerTrainingRoutes(pathname, req, res, url) {
  // POST /training/sessions
  if (pathname === '/training/sessions' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const session = await trainingService.startSession(user.id, body);
      await invalidateTrainingCache(user.id);
      return sendJson(res, 201, session);
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        return sendError(res, 401, err.message);
      }
      return sendError(res, 400, err.message);
    }
  }

  // GET /training/sessions
  if (pathname === '/training/sessions' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const type = url.searchParams.get('type');
      const limit = url.searchParams.get('limit')
        ? Number(url.searchParams.get('limit'))
        : undefined;
      const sessions = await trainingService.listSessions(user.id, {
        type,
        limit,
      });
      return sendJson(res, 200, { items: sessions });
    } catch (err) {
      return sendError(res, 401, err.message);
    }
  }

  // PATCH /training/sessions/:id
  if (pathname.startsWith('/training/sessions/') && req.method === 'PATCH') {
    try {
      const user = await authenticate(req);
      const id = Number(pathname.split('/').pop());
      const body = await parseBody(req);
      const session = await trainingService.stopSession(user.id, id, body);
      await invalidateTrainingCache(user.id);
      return sendJson(res, 200, session);
    } catch (err) {
      if (err.message === 'SESSION_NOT_FOUND') {
        return sendError(res, 404, err.message);
      }
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /training/stats
  if (pathname === '/training/stats' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const cacheKey = buildUserCacheKey(user.id, 'stats');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const stats = await trainingService.getStats(user.id);
      await cacheService.set(cacheKey, stats, 60);
      return sendJson(res, 200, stats);
    } catch (err) {
      return sendError(res, 401, err.message);
    }
  }

  // GET /events
  if (pathname === '/events' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = url.searchParams.get('limit')
        ? Number(url.searchParams.get('limit'))
        : 50;
      const name = url.searchParams.get('name') || null;
      const events = await dataStore.listEvents({ userId: user.id, name, limit });
      return sendJson(res, 200, { items: events });
    } catch (err) {
      const status = mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // POST /events
  if (pathname === '/events' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);

      // Extract client IP from request
      const forwarded = req.headers['x-forwarded-for'];
      const clientIp = Array.isArray(forwarded)
        ? forwarded[0]
        : (forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown');
      const visitorId = normalizeVisitorId(body.visitor_id || body.properties?.visitor_id);

      // Merge IP address into properties
      const properties = {
        ...body.properties,
        ip: clientIp,
        user_agent: req.headers['user-agent'] || null
      };
      if (visitorId) properties.visitor_id = visitorId;
      else delete properties.visitor_id;

      const event = await trainingService.recordEvent(user.id, body.event_name, properties);
      await invalidateTrainingCache(user.id);
      return sendJson(res, 201, event);
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerTrainingRoutes };
