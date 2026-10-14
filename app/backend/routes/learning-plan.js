/**
 * Learning Plan API Routes
 *
 * Endpoints for personalized learning plans and video recommendations.
 */

const learningPlan = require('../services/learning-plan');
const planFeedback = require('../services/plan-feedback');
const cacheService = require('../services/cache');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { parseBody } = require('../utils/parsers');

function buildUserCacheKey(userId, suffix) {
  return `learning:user:${userId}:${suffix}`;
}

/**
 * Register and handle learning plan routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerLearningPlanRoutes(pathname, req, res, url) {

  // GET /api/learning/progress - 获取学习进度
  if (pathname === '/api/learning/progress' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const cacheKey = buildUserCacheKey(user.id, 'progress');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const progress = await learningPlan.getLearningProgress(user.id);
      const payload = { success: true, data: progress };
      await cacheService.set(cacheKey, payload, 60);
      return sendJson(res, 200, payload);
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/daily-plan - 获取每日学习计划
  if (pathname === '/api/learning/daily-plan' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const plan = await learningPlan.generateDailyPlan(user.id);
      return sendJson(res, 200, { success: true, data: plan });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/today-progress - 获取今日训练任务完成进度
  if (pathname === '/api/learning/today-progress' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const progress = await learningPlan.getTodayProgress(user.id);
      return sendJson(res, 200, { success: true, data: progress });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/today-streak - 获取今日训练连续天数
  if (pathname === '/api/learning/today-streak' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const streak = await learningPlan.getTodayStreak(user.id);
      return sendJson(res, 200, { success: true, data: streak });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/weekly-report - 获取最近 7 天训练报告
  if (pathname === '/api/learning/weekly-report' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const report = await learningPlan.getWeeklyReport(user.id);
      return sendJson(res, 200, { success: true, data: report });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/current-level - 获取用户当前推荐等级
  if (pathname === '/api/learning/current-level' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const levelInfo = await learningPlan.getUserCurrentLevel(user.id);
      return sendJson(res, 200, {
        success: true,
        data: {
          level: levelInfo.level,
          config: levelInfo.config,
          recommendation: levelInfo.recommendation,
          stats: levelInfo.stats
        }
      });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/words-to-learn?level=beginner&limit=20 - 获取待学习单词
  if (pathname === '/api/learning/words-to-learn' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const level = url.searchParams.get('level') || 'beginner';
      const limit = parseInt(url.searchParams.get('limit')) || 20;

      const words = await learningPlan.getWordsToLearn(user.id, level, limit);
      return sendJson(res, 200, {
        success: true,
        data: {
          level,
          levelName: learningPlan.LEVEL_CONFIG[level]?.displayName,
          count: words.length,
          words
        }
      });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/words-to-review?limit=30 - 获取待复习单词
  if (pathname === '/api/learning/words-to-review' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = parseInt(url.searchParams.get('limit')) || 30;

      const words = await learningPlan.getWordsToReview(user.id, limit);
      return sendJson(res, 200, {
        success: true,
        data: {
          count: words.length,
          words
        }
      });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/recommended-videos?limit=10 - 获取推荐视频(游客可用)
  if (pathname === '/api/learning/recommended-videos' && req.method === 'GET') {
    try {
      const user = await optionalAuth(req);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 10, 1), 30);

      const result = await learningPlan.getRecommendedVideos(user ? user.id : null, limit);
      return sendJson(res, 200, { success: true, data: result });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/next-video?after=<videoId>&limit=1 - 看完后的「下一个」(游客可用)
  if (pathname === '/api/learning/next-video' && req.method === 'GET') {
    try {
      const user = await optionalAuth(req);
      const afterId = (url.searchParams.get('after') || '').trim().slice(0, 64) || null;
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 1, 1), 5);

      const result = await learningPlan.getNextVideo(user ? user.id : null, afterId, limit);
      return sendJson(res, 200, { success: true, data: result });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/videos-by-level?level=beginner&limit=20 - 按等级获取视频
  if (pathname === '/api/learning/videos-by-level' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const level = url.searchParams.get('level') || 'beginner';
      const limit = parseInt(url.searchParams.get('limit')) || 20;

      const result = await learningPlan.getVideosByLevel(level, limit);
      return sendJson(res, 200, { success: true, data: result });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /api/learning/level-config - 获取词汇等级配置 (无需登录)
  if (pathname === '/api/learning/level-config' && req.method === 'GET') {
    try {
      return sendJson(res, 200, {
        success: true,
        data: {
          levels: Object.entries(learningPlan.LEVEL_CONFIG).map(([key, config]) => ({
            level: key,
            ...config
          }))
        }
      });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // POST /api/learning/plan-feedback - 提交计划反馈(too_hard/too_easy/boring/rating 等)
  if (pathname === '/api/learning/plan-feedback' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const feedback = planFeedback.validateFeedback(body);
      if (!feedback) return sendError(res, 400, 'INVALID_FEEDBACK');
      await planFeedback.saveFeedback(user.id, feedback);
      return sendJson(res, 200, { success: true, data: { saved: true } });
    } catch (err) {
      // saveFeedback 的当日重复评分错误带 statusCode=409;mapErrorToStatus 不识别
      // statusCode,故将其作为兜底状态传入以保住端点的 409 契约
      return sendError(res, mapErrorToStatus(err, err.statusCode || 400), err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerLearningPlanRoutes };
