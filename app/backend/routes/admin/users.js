const dataStore = require('../../data-store');
const { parseBody } = require('../../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../../middleware/error-handler');
const { authenticate } = require('../../middleware/auth');
const { requireAiVocabToken } = require('../../middleware/ai-auth');

/**
 * Check if user is admin and throw error if not
 * @param {http.IncomingMessage} req - HTTP request object
 * @returns {Promise<Object>} Admin user object
 */
async function requireAdmin(req) {
  const u = await authenticate(req);
  if (!u?.is_admin) {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    throw err;
  }
  return u;
}

/**
 * Check if request has admin auth OR valid AI token (for MCP access)
 * @param {http.IncomingMessage} req - HTTP request object
 * @returns {Promise<Object>} Auth context
 */
async function requireAdminOrAiToken(req) {
  // Try admin auth first
  try {
    const u = await authenticate(req);
    if (u?.is_admin) {
      return { type: 'admin', user: u };
    }
  } catch (_) {
    // Admin auth failed, try AI token
  }

  // Try AI token
  try {
    const aiAuth = requireAiVocabToken(req);
    return { type: 'ai', ...aiAuth };
  } catch (_) {
    // AI token also failed
  }

  const err = new Error('UNAUTHORIZED');
  err.status = 401;
  throw err;
}

/**
 * Register and handle admin user management routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - URL object for query parameters
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerAdminUsersRoutes(pathname, req, res, url) {
  // GET /admin/users/summary (supports MCP access)
  if (pathname === '/admin/users/summary' && req.method === 'GET') {
    try {
      await requireAdminOrAiToken(req);
      const summary = await dataStore.getUserCountsSummary();
      const usage = await dataStore.getUsageSummaryAllUsers();
      const categories = await dataStore.getGlobalCategoryUsage();
      return sendJson(res, 200, { users: summary, usage, categories });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/users (supports MCP access)
  if (pathname === '/admin/users' && req.method === 'GET') {
    try {
      await requireAdminOrAiToken(req);
      const statusQ = url.searchParams.get('status') || null;
      const q = url.searchParams.get('q') || null;
      const userType = url.searchParams.get('user_type') || null;
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;
      const result = await dataStore.listUsers({ status: statusQ, query: q, user_type: userType, limit, offset });
      return sendJson(res, 200, result);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/users/:id/logins
  const loginsMatch = pathname.match(/^\/admin\/users\/(\d+)\/logins$/);
  if (loginsMatch && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const userId = Number(loginsMatch[1]);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
      const items = await dataStore.getUserLoginSessions(userId, limit);
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/users/:id/usage
  const usageMatch = pathname.match(/^\/admin\/users\/(\d+)\/usage$/);
  if (usageMatch && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const userId = Number(usageMatch[1]);
      const breakdown = await dataStore.getUsageBreakdownForUser(userId);
      const videos = await dataStore.getUserVideoUsageList(userId, { limit: 20 });
      return sendJson(res, 200, { breakdown, videos });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/users/:id/pronunciation/focus
  const focusMatch = pathname.match(/^\/admin\/users\/(\d+)\/pronunciation\/focus$/);
  if (focusMatch && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const userId = Number(focusMatch[1]);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 10;
      const items = await dataStore.listPronunciationFocus(userId, { limit });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/users/:id/pronunciation/history
  const historyMatch = pathname.match(/^\/admin\/users\/(\d+)\/pronunciation\/history$/);
  if (historyMatch && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const userId = Number(historyMatch[1]);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 20;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;
      const items = await dataStore.listPronunciationAssessments(userId, { limit, offset });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/users/:id/pronunciation/daily
  const dailyMatch = pathname.match(/^\/admin\/users\/(\d+)\/pronunciation\/daily$/);
  if (dailyMatch && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const userId = Number(dailyMatch[1]);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 14;
      const items = await dataStore.getPronunciationDailyForUser(userId, days);
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/users/:id/ban
  const banMatch = pathname.match(/^\/admin\/users\/(\d+)\/ban$/);
  if (banMatch && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const userId = Number(banMatch[1]);
      const body = await parseBody(req);
      const reason = String(body?.reason || '管理员封禁').slice(0, 200);
      await dataStore.setUserStatus(userId, 'banned');
      await dataStore.logAdminAction(admin.id, userId, 'ban_user', { reason });
      return sendJson(res, 200, { success: true });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/users/:id/unban
  const unbanMatch = pathname.match(/^\/admin\/users\/(\d+)\/unban$/);
  if (unbanMatch && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const userId = Number(unbanMatch[1]);
      await dataStore.setUserStatus(userId, 'active');
      await dataStore.logAdminAction(admin.id, userId, 'unban_user', {});
      return sendJson(res, 200, { success: true });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/users/:id/events/summary
  const eventsMatch = pathname.match(/^\/admin\/users\/(\d+)\/events\/summary$/);
  if (eventsMatch && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const userId = Number(eventsMatch[1]);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 7;
      const recent = await dataStore.listRecentEventsForUser(userId, { limit: 10 });
      const videoSecs = await dataStore.getEventSecondsTotalWindowed({ userId, name: 'video_watch', days });
      const vocabSecs = await dataStore.getEventSecondsTotalWindowed({ userId, name: 'vocab_study', days });
      return sendJson(res, 200, {
        video_watch_seconds: videoSecs,
        vocab_study_seconds: vocabSecs,
        recent
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // PATCH /admin/users/:id
  const patchMatch = pathname.match(/^\/admin\/users\/(\d+)$/);
  if (patchMatch && req.method === 'PATCH') {
    try {
      const admin = await requireAdmin(req);
      const userId = Number(patchMatch[1]);
      const body = await parseBody(req);

      // Normalize membership updates
      if (body.membership_type !== undefined) {
        const rawType = String(body.membership_type || 'free').toLowerCase();
        const typeMap = { pro: 'vip', vip: 'vip', svip: 'svip', family: 'family', free: 'free', admin: 'admin' };
        body.membership_type = typeMap[rawType] || 'free';

        // Normalize/validate expiry (optional)
        if (body.membership_expires_at) {
          const parsed = new Date(body.membership_expires_at);
          if (Number.isNaN(parsed.getTime())) {
            console.warn('[Admin Users] Invalid membership_expires_at, clearing:', body.membership_expires_at);
            body.membership_expires_at = null;
          } else {
            body.membership_expires_at = parsed.toISOString();
          }
        }

        // If setting a paid tier without an explicit expiry, default to +365 days
        if (body.membership_type !== 'free' && !body.membership_expires_at) {
          const expires = new Date();
          expires.setDate(expires.getDate() + 365);
          body.membership_expires_at = expires.toISOString();
        }

        // Clearing membership should also clear expiry
        if (body.membership_type === 'free') {
          body.membership_expires_at = null;
        }
      }

      // Handle quota update separately if present
      if (body.quota) {
        await dataStore.upsertUserQuota(userId, body.quota);
        delete body.quota;
      }

      // Update user fields
      const updatedUser = await dataStore.updateUserFields(userId, body);

      if (!updatedUser) {
        return sendError(res, 404, 'USER_NOT_FOUND');
      }

      // Log for visibility
      console.log('[Admin Users] Updated user', userId, {
        membership_type: updatedUser.membership_type,
        membership_expires_at: updatedUser.membership_expires_at,
        status: updatedUser.status,
        is_admin: updatedUser.is_admin,
      });

      // Log admin action
      const actionDetails = { changes: body };
      await dataStore.logAdminAction(admin.id, userId, 'update_user', actionDetails);

      return sendJson(res, 200, updatedUser);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // DELETE /admin/users/:id
  const deleteMatch = pathname.match(/^\/admin\/users\/(\d+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    try {
      const admin = await requireAdmin(req);
      const userId = Number(deleteMatch[1]);
      await dataStore.logAdminAction(admin.id, userId, 'delete_user', {});
      await dataStore.deleteUserById(userId);
      return sendJson(res, 200, { message: 'User deleted successfully' });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerAdminUsersRoutes };
