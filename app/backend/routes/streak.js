/**
 * Streak Routes
 * 连胜相关API路由
 *
 * 端点：
 * - GET  /api/streak/status          获取连胜状态
 * - GET  /api/streak/freezes         获取冻结卡配置
 * - POST /api/streak/freeze/purchase 购买冻结卡
 * - POST /api/streak/freeze/use      使用冻结卡
 * - GET  /api/streak/freezes/history 获取冻结使用历史
 * - GET  /api/streak/milestones      获取里程碑列表
 * - GET  /api/streak/milestones/user 获取用户已达成里程碑
 * - POST /api/streak/milestone/:id/claim     领取里程碑奖励
 * - POST /api/streak/milestone/:id/celebrate 标记里程碑已庆祝
 * - GET  /api/streak/notifications   获取待处理通知
 * - POST /api/streak/notification/:id/open   标记通知已打开
 */

const streakService = require('../services/streak-service');
const cacheService = require('../services/cache');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');

function buildUserCacheKey(userId, suffix) {
  return `streak:user:${userId}:${suffix}`;
}

async function invalidateStreakCache(userId) {
  return cacheService.invalidate(`streak:user:${userId}:*`);
}

/**
 * Register streak routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerStreakRoutes(pathname, req, res, url) {

  // ============================================================================
  // Streak Status
  // ============================================================================

  // GET /api/streak/status - 获取连胜状态
  if (pathname === '/api/streak/status' && req.method === 'GET') {
    try {
      const user = await authenticate(req);

      const cacheKey = buildUserCacheKey(user.id, 'status');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const status = await streakService.getStreakStatus(user.id);
      await cacheService.set(cacheKey, status, 30); // Cache for 30 seconds
      return sendJson(res, 200, status);
    } catch (err) {
      console.error('Error in getStreakStatus:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // Freeze Cards
  // ============================================================================

  // GET /api/streak/freezes - 获取所有冻结卡配置
  if (pathname === '/api/streak/freezes' && req.method === 'GET') {
    try {
      await authenticate(req);

      const cacheKey = 'streak:freezes:config';
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const configs = await streakService.getFreezeConfigs();
      await cacheService.set(cacheKey, configs, 3600); // Cache for 1 hour
      return sendJson(res, 200, configs);
    } catch (err) {
      console.error('Error in getFreezeConfigs:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/streak/freeze/purchase - 购买冻结卡
  if (pathname === '/api/streak/freeze/purchase' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { freezeType } = body;

      if (!freezeType) {
        return sendError(res, 400, '请指定冻结卡类型');
      }

      const result = await streakService.purchaseFreeze(user.id, freezeType);
      await invalidateStreakCache(user.id);

      return sendJson(res, 200, result);
    } catch (err) {
      console.error('Error in purchaseFreeze:', err);
      return sendError(res, err.status || 400, err.message);
    }
  }

  // POST /api/streak/freeze/use - 使用冻结卡
  if (pathname === '/api/streak/freeze/use' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { freezeType = 'daily', protectedDate } = body;

      const result = await streakService.useFreeze(user.id, freezeType, protectedDate);
      await invalidateStreakCache(user.id);

      if (!result.success) {
        return sendError(res, 400, result.message || result.error);
      }

      return sendJson(res, 200, result);
    } catch (err) {
      console.error('Error in useFreeze:', err);
      return sendError(res, err.status || 400, err.message);
    }
  }

  // GET /api/streak/freezes/history - 获取冻结使用历史
  if (pathname === '/api/streak/freezes/history' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = parseInt(url.searchParams.get('limit')) || 20;

      const history = await streakService.getFreezeHistory(user.id, limit);
      return sendJson(res, 200, history);
    } catch (err) {
      console.error('Error in getFreezeHistory:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // Milestones
  // ============================================================================

  // GET /api/streak/milestones - 获取所有里程碑
  if (pathname === '/api/streak/milestones' && req.method === 'GET') {
    try {
      await authenticate(req);

      const cacheKey = 'streak:milestones:all';
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const milestones = await streakService.getAllMilestones();
      await cacheService.set(cacheKey, milestones, 3600); // Cache for 1 hour
      return sendJson(res, 200, milestones);
    } catch (err) {
      console.error('Error in getAllMilestones:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/streak/milestones/user - 获取用户已达成里程碑
  if (pathname === '/api/streak/milestones/user' && req.method === 'GET') {
    try {
      const user = await authenticate(req);

      const cacheKey = buildUserCacheKey(user.id, 'milestones');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const milestones = await streakService.getUserMilestones(user.id);
      await cacheService.set(cacheKey, milestones, 60);
      return sendJson(res, 200, milestones);
    } catch (err) {
      console.error('Error in getUserMilestones:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/streak/milestones/check - 检查新达成的里程碑
  if (pathname === '/api/streak/milestones/check' && req.method === 'GET') {
    try {
      const user = await authenticate(req);

      const newMilestones = await streakService.checkNewMilestones(user.id);
      await invalidateStreakCache(user.id);

      return sendJson(res, 200, {
        newMilestones: newMilestones,
        count: newMilestones.length
      });
    } catch (err) {
      console.error('Error in checkNewMilestones:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/streak/milestone/:id/claim - 领取里程碑奖励
  const claimMilestoneMatch = pathname.match(/^\/api\/streak\/milestone\/(\d+)\/claim$/);
  if (claimMilestoneMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const milestoneId = parseInt(claimMilestoneMatch[1]);

      const result = await streakService.claimMilestoneReward(user.id, milestoneId);
      await invalidateStreakCache(user.id);

      return sendJson(res, 200, result);
    } catch (err) {
      console.error('Error in claimMilestoneReward:', err);
      return sendError(res, err.status || 400, err.message);
    }
  }

  // POST /api/streak/milestone/:id/celebrate - 标记里程碑已庆祝
  const celebrateMilestoneMatch = pathname.match(/^\/api\/streak\/milestone\/(\d+)\/celebrate$/);
  if (celebrateMilestoneMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const milestoneId = parseInt(celebrateMilestoneMatch[1]);

      const success = await streakService.markMilestoneCelebrated(user.id, milestoneId);
      await invalidateStreakCache(user.id);

      return sendJson(res, 200, { success });
    } catch (err) {
      console.error('Error in markMilestoneCelebrated:', err);
      return sendError(res, err.status || 400, err.message);
    }
  }

  // ============================================================================
  // Notifications
  // ============================================================================

  // GET /api/streak/notifications - 获取待处理通知
  if (pathname === '/api/streak/notifications' && req.method === 'GET') {
    try {
      const user = await authenticate(req);

      const notifications = await streakService.getPendingNotifications(user.id);
      return sendJson(res, 200, notifications);
    } catch (err) {
      console.error('Error in getPendingNotifications:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/streak/notification/:id/open - 标记通知已打开
  const openNotificationMatch = pathname.match(/^\/api\/streak\/notification\/(\d+)\/open$/);
  if (openNotificationMatch && req.method === 'POST') {
    try {
      await authenticate(req);
      const notificationId = parseInt(openNotificationMatch[1]);

      const success = await streakService.markNotificationOpened(notificationId);
      return sendJson(res, 200, { success });
    } catch (err) {
      console.error('Error in markNotificationOpened:', err);
      return sendError(res, err.status || 400, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerStreakRoutes };
