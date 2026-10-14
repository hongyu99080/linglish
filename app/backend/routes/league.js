/**
 * League Routes
 * 联赛相关API路由
 *
 * 端点：
 * - GET  /api/league/status           获取用户联赛状态
 * - GET  /api/league/leaderboard      获取当前段位排行榜
 * - GET  /api/league/tiers            获取所有段位信息
 * - GET  /api/league/history          获取赛季历史
 * - POST /api/league/rewards/claim    领取赛季奖励
 * - GET  /api/league/season/current   获取当前赛季信息
 * - GET  /api/league/rewards/unclaimed 获取未领取的奖励
 * - GET  /api/league/distribution     获取段位分布
 */

const leagueService = require('../services/league-service');
const cacheService = require('../services/cache');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');

function buildUserCacheKey(userId, suffix) {
  return `league:user:${userId}:${suffix}`;
}

async function invalidateLeagueCache(userId) {
  return cacheService.invalidate(`league:user:${userId}:*`);
}

/**
 * Register league routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerLeagueRoutes(pathname, req, res, url) {

  // ============================================================================
  // Season & Status
  // ============================================================================

  // GET /api/league/season/current - 获取当前赛季信息
  if (pathname === '/api/league/season/current' && req.method === 'GET') {
    try {
      await authenticate(req);

      const cacheKey = 'league:season:current';
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const season = await leagueService.getCurrentSeason();
      await cacheService.set(cacheKey, season, 60);
      return sendJson(res, 200, season);
    } catch (err) {
      console.error('Error in getCurrentSeason:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/league/status - 获取用户联赛状态
  if (pathname === '/api/league/status' && req.method === 'GET') {
    try {
      const user = await authenticate(req);

      const cacheKey = buildUserCacheKey(user.id, 'status');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const status = await leagueService.getUserLeagueStatus(user.id);
      await cacheService.set(cacheKey, status, 30);
      return sendJson(res, 200, status);
    } catch (err) {
      console.error('Error in getUserLeagueStatus:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // Tiers
  // ============================================================================

  // GET /api/league/tiers - 获取所有段位信息
  if (pathname === '/api/league/tiers' && req.method === 'GET') {
    try {
      await authenticate(req);

      const tiers = await leagueService.getAllTiers();
      return sendJson(res, 200, tiers);
    } catch (err) {
      console.error('Error in getAllTiers:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/league/distribution - 获取段位分布
  if (pathname === '/api/league/distribution' && req.method === 'GET') {
    try {
      await authenticate(req);

      const cacheKey = 'league:distribution';
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const distribution = await leagueService.getTierDistribution();
      await cacheService.set(cacheKey, distribution, 300);
      return sendJson(res, 200, distribution);
    } catch (err) {
      console.error('Error in getTierDistribution:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // Leaderboard
  // ============================================================================

  // GET /api/league/leaderboard - 获取当前段位排行榜
  if (pathname === '/api/league/leaderboard' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = parseInt(url.searchParams.get('limit')) || 50;

      const cacheKey = buildUserCacheKey(user.id, `leaderboard:${limit}`);
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const leaderboard = await leagueService.getGroupLeaderboard(user.id, limit);
      await cacheService.set(cacheKey, leaderboard, 30);
      return sendJson(res, 200, leaderboard);
    } catch (err) {
      console.error('Error in getGroupLeaderboard:', err);
      if (err.message === 'USER_NOT_IN_LEAGUE') {
        return sendError(res, 400, '请先加入联赛');
      }
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // History & Rewards
  // ============================================================================

  // GET /api/league/history - 获取赛季历史
  if (pathname === '/api/league/history' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = parseInt(url.searchParams.get('limit')) || 10;

      const history = await leagueService.getUserLeagueHistory(user.id, limit);
      return sendJson(res, 200, history);
    } catch (err) {
      console.error('Error in getUserLeagueHistory:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/league/rewards/unclaimed - 获取未领取的奖励
  if (pathname === '/api/league/rewards/unclaimed' && req.method === 'GET') {
    try {
      const user = await authenticate(req);

      const unclaimed = await leagueService.getUnclaimedRewards(user.id);
      return sendJson(res, 200, unclaimed);
    } catch (err) {
      console.error('Error in getUnclaimedRewards:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/league/rewards/claim - 领取赛季奖励
  if (pathname === '/api/league/rewards/claim' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { seasonId } = body;

      if (!seasonId) {
        return sendError(res, 400, '请指定赛季ID');
      }

      const result = await leagueService.claimSeasonRewards(user.id, seasonId);
      await invalidateLeagueCache(user.id);

      return sendJson(res, 200, result);
    } catch (err) {
      console.error('Error in claimSeasonRewards:', err);
      return sendError(res, err.status || 400, err.message);
    }
  }

  // GET /api/league/tier/:tierId/rewards - 获取段位奖励配置
  const tierRewardsMatch = pathname.match(/^\/api\/league\/tier\/(\d+)\/rewards$/);
  if (tierRewardsMatch && req.method === 'GET') {
    try {
      await authenticate(req);
      const tierId = parseInt(tierRewardsMatch[1]);

      const rewards = await leagueService.getTierRewards(tierId);
      return sendJson(res, 200, rewards);
    } catch (err) {
      console.error('Error in getTierRewards:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // XP Updates (Internal use - called from other services)
  // ============================================================================

  // POST /api/league/xp/add - 添加周XP（内部使用）
  if (pathname === '/api/league/xp/add' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { xp } = body;

      if (!xp || xp <= 0) {
        return sendError(res, 400, '请指定有效的XP值');
      }

      const result = await leagueService.addWeeklyXP(user.id, xp);
      await invalidateLeagueCache(user.id);

      return sendJson(res, 200, result);
    } catch (err) {
      console.error('Error in addWeeklyXP:', err);
      return sendError(res, err.status || 400, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerLeagueRoutes };
