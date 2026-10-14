/**
 * User Retention Routes
 * 用户留存相关路由
 *
 * 包含：
 * - 学习统计
 * - 学习报告
 * - 排行榜
 * - 好友系统
 */

const learningStats = require('../services/learning-stats');
const learningReports = require('../services/learning-reports');
const leaderboard = require('../services/leaderboard');
const studyGroups = require('../services/study-groups');
const userGoals = require('../services/user-goals');
const dataStore = require('../data-store');
const cacheService = require('../services/cache');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const { broadcastGroupChat } = require('../ws/group-chat');

function buildUserCacheKey(userId, suffix) {
  return `retention:user:${userId}:${suffix}`;
}

async function invalidateRetentionCache(userId) {
  return cacheService.invalidate(`retention:user:${userId}:*`);
}

/**
 * Register retention routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerRetentionRoutes(pathname, req, res, url) {
  // ============================================================================
  // 学习统计相关
  // ============================================================================

  // POST /api/retention/activity - 记录学习活动
  if (pathname === '/api/retention/activity' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { activityType, durationMinutes, metadata } = body;

      if (!activityType) {
        return sendError(res, 400, 'Activity type is required');
      }

      const success = await learningStats.recordActivity(user.id, {
        activityType,
        durationMinutes: parseInt(durationMinutes) || 0,
        metadata: metadata || {}
      });

      if (success) {
        // 检查里程碑解锁
        const milestones = await learningStats.checkMilestones(user.id);
        await invalidateRetentionCache(user.id);
        return sendJson(res, 200, {
          recorded: true,
          milestones_unlocked: milestones
        });
      } else {
        return sendError(res, 500, 'Failed to record activity');
      }
    } catch (err) {
      console.error('Error in recordActivity:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/stats - 获取用户统计数据
  if (pathname === '/api/retention/stats' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const statType = url.searchParams.get('type') || 'daily';
      const date = url.searchParams.get('date') || null;

      const cacheKey = buildUserCacheKey(user.id, `stats:${statType}:${date || 'latest'}`);
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const stats = await learningStats.getUserStats(user.id, statType, date);
      await cacheService.set(cacheKey, stats, 60);
      return sendJson(res, 200, stats);
    } catch (err) {
      console.error('Error in getUserStats:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/skills - 获取技能进度
  if (pathname === '/api/retention/skills' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const cacheKey = buildUserCacheKey(user.id, 'skills');
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const skills = await learningStats.getSkillProgress(user.id);
      await cacheService.set(cacheKey, skills, 120);
      return sendJson(res, 200, skills);
    } catch (err) {
      console.error('Error in getSkillProgress:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/trend - 获取学习趋势
  if (pathname === '/api/retention/trend' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const days = parseInt(url.searchParams.get('days')) || 30;
      const cacheKey = buildUserCacheKey(user.id, `trend:${days}`);
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }
      const trend = await learningStats.getLearningTrend(user.id, days);
      await cacheService.set(cacheKey, trend, 120);
      return sendJson(res, 200, trend);
    } catch (err) {
      console.error('Error in getLearningTrend:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // 学习报告相关
  // ============================================================================

  // POST /api/retention/reports/weekly - 生成周报
  if (pathname === '/api/retention/reports/weekly' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const report = await learningReports.generateWeeklyReport(user.id);
      return sendJson(res, 200, report);
    } catch (err) {
      console.error('Error in generateWeeklyReport:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/reports/monthly - 生成月报
  if (pathname === '/api/retention/reports/monthly' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const report = await learningReports.generateMonthlyReport(user.id);
      return sendJson(res, 200, report);
    } catch (err) {
      console.error('Error in generateMonthlyReport:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/reports - 获取用户报告列表
  if (pathname === '/api/retention/reports' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const reportType = url.searchParams.get('type') || null;
      const limit = parseInt(url.searchParams.get('limit')) || 10;

      const reports = await learningReports.getUserReports(user.id, reportType, limit);
      return sendJson(res, 200, reports);
    } catch (err) {
      console.error('Error in getUserReports:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/reports/:id - 获取报告详情
  const reportDetailMatch = pathname.match(/^\/api\/retention\/reports\/(\d+)$/);
  if (reportDetailMatch && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const reportId = reportDetailMatch[1];

      const query = `
        SELECT * FROM learning_reports
        WHERE id = $1 AND user_id = $2
      `;
      const result = await dataStore.query(query, [reportId, user.id]);

      if (result.rows.length === 0) {
        return sendError(res, 404, 'Report not found');
      }

      // 标记为已查看
      await learningReports.markReportViewed(reportId, user.id);

      const report = result.rows[0];
      return sendJson(res, 200, {
        ...report,
        summary: JSON.parse(report.summary),
        achievements: JSON.parse(report.achievements),
        progress: JSON.parse(report.progress),
        recommendations: JSON.parse(report.recommendations)
      });
    } catch (err) {
      console.error('Error in getReportDetail:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/radar - 获取能力雷达图数据
  if (pathname === '/api/retention/radar' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const radarData = await learningReports.getSkillRadarData(user.id);
      return sendJson(res, 200, radarData);
    } catch (err) {
      console.error('Error in getSkillRadar:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // 排行榜相关
  // ============================================================================

  // GET /api/retention/leaderboard/:name/rank - 获取用户排名
  const userRankMatch = pathname.match(/^\/api\/retention\/leaderboard\/([^\/]+)\/rank$/);
  if (userRankMatch && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const leaderboardName = userRankMatch[1];
      const rank = await leaderboard.getUserRank(user.id, leaderboardName);

      if (!rank) {
        return sendError(res, 404, 'User not found in leaderboard');
      }

      return sendJson(res, 200, rank);
    } catch (err) {
      console.error('Error in getUserLeaderboardRank:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/leaderboard/:name/context - 获取用户周围的排名
  const contextMatch = pathname.match(/^\/api\/retention\/leaderboard\/([^\/]+)\/context$/);
  if (contextMatch && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const leaderboardName = contextMatch[1];
      const contextSize = parseInt(url.searchParams.get('size')) || 3;

      const context = await leaderboard.getLeaderboardContext(leaderboardName, user.id, contextSize);
      return sendJson(res, 200, context);
    } catch (err) {
      console.error('Error in getLeaderboardContext:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // Weekly Focus / Milestones
  // ============================================================================

  // GET /api/retention/weekly-focus - 获取本周重点
  if (pathname === '/api/retention/weekly-focus' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const now = new Date();
      const day = now.getDay() || 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() - (day - 1));
      monday.setHours(0, 0, 0, 0);
      const weekStart = monday.toISOString().slice(0, 10);

      const cached = await dataStore.getWeeklyFocus(user.id, weekStart);
      if (cached) {
        return sendJson(res, 200, { week_start: weekStart, items: cached.focus_items || [] });
      }

      const focusItems = await dataStore.listPronunciationFocus(user.id, { limit: 5 });
      const items = (focusItems || []).map(item => ({
        phoneme: item.phoneme,
        issue_count: item.issue_count,
        last_seen_at: item.last_seen_at
      }));

      const payload = items.length ? items : [
        { phoneme: 'θ', issue_count: 0, last_seen_at: null },
        { phoneme: 'ð', issue_count: 0, last_seen_at: null },
        { phoneme: 'r', issue_count: 0, last_seen_at: null }
      ];

      await dataStore.saveWeeklyFocus(user.id, weekStart, payload);
      return sendJson(res, 200, { week_start: weekStart, items: payload });
    } catch (err) {
      console.error('Error in getWeeklyFocus:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/milestones/user - 获取用户里程碑
  if (pathname === '/api/retention/milestones/user' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = parseInt(url.searchParams.get('limit')) || 20;
      const result = await dataStore.query(
        `SELECT * FROM user_milestones WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [user.id, limit]
      );
      return sendJson(res, 200, result.rows || []);
    } catch (err) {
      console.error('Error in getUserMilestones:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/milestones/:id/celebrate - 标记里程碑已庆祝
  const celebrateMatch = pathname.match(/^\/api\/retention\/milestones\/(\d+)\/celebrate$/);
  if (celebrateMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const milestoneId = Number(celebrateMatch[1]);
      await dataStore.query(
        `UPDATE user_milestones SET celebrated = TRUE WHERE id = $1 AND user_id = $2`,
        [milestoneId, user.id]
      );
      return sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('Error in celebrateMilestone:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/leaderboard/:name - 获取排行榜
  const leaderboardMatch = pathname.match(/^\/api\/retention\/leaderboard\/([^\/]+)$/);
  if (leaderboardMatch && req.method === 'GET') {
    try {
      const leaderboardName = leaderboardMatch[1];
      const limit = parseInt(url.searchParams.get('limit')) || 50;

      const rankings = await leaderboard.getLeaderboard(leaderboardName, limit);
      return sendJson(res, 200, rankings);
    } catch (err) {
      console.error('Error in getLeaderboard:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/leaderboard/friends - 获取好友排行榜
  if (pathname === '/api/retention/leaderboard/friends' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const metric = url.searchParams.get('metric') || 'total_xp';
      const limit = parseInt(url.searchParams.get('limit')) || 20;

      const rankings = await leaderboard.getFriendsLeaderboard(user.id, metric, limit);
      return sendJson(res, 200, rankings);
    } catch (err) {
      console.error('Error in getFriendsLeaderboard:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/rankings/me - 获取用户所有排名
  if (pathname === '/api/retention/rankings/me' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const rankings = await leaderboard.getUserAllRankings(user.id);
      return sendJson(res, 200, rankings);
    } catch (err) {
      console.error('Error in getUserAllRankings:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // 个人目标系统
  // ============================================================================

  // GET /api/retention/goals/presets - 获取预设目标模板
  if (pathname === '/api/retention/goals/presets' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const timeRange = url.searchParams.get('timeRange') || null;
      const goalType = url.searchParams.get('goalType') || null;

      const presets = await userGoals.getPresetsWithStatus(user.id, {
        timeRange,
        goalType
      });
      return sendJson(res, 200, presets);
    } catch (err) {
      console.error('Error in getGoalPresets:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/goals/stats - 获取目标完成统计
  if (pathname === '/api/retention/goals/stats' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const stats = await userGoals.getCompletionStats(user.id);
      return sendJson(res, 200, stats);
    } catch (err) {
      console.error('Error in getGoalStats:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/goals - 获取用户目标列表
  if (pathname === '/api/retention/goals' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const status = url.searchParams.get('status') || 'active';
      const limit = parseInt(url.searchParams.get('limit')) || 10;

      const goals = await userGoals.getUserGoalsWithProgress(user.id, {
        status,
        limit
      });
      return sendJson(res, 200, goals);
    } catch (err) {
      console.error('Error in getUserGoals:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/goals - 创建新目标
  if (pathname === '/api/retention/goals' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { presetKey, goalType, targetValue, timeRange, rewardXp, rewardCoins, rewardBadge } = body;

      let goal;

      if (presetKey) {
        // 从预设创建
        goal = await userGoals.createGoalFromPreset(user.id, presetKey);
      } else {
        // 自定义目标
        if (!goalType || !targetValue || !timeRange) {
          return sendError(res, 400, 'Goal type, target value, and time range are required');
        }
        goal = await userGoals.createCustomGoal(user.id, {
          goalType,
          targetValue: parseFloat(targetValue),
          timeRange,
          rewardXp: parseInt(rewardXp) || 0,
          rewardCoins: parseInt(rewardCoins) || 0,
          rewardBadge: rewardBadge || null
        });
      }

      return sendJson(res, 201, goal);
    } catch (err) {
      console.error('Error in createGoal:', err);
      if (err.message === 'PRESET_NOT_FOUND') {
        return sendError(res, 404, 'Goal preset not found');
      }
      if (err.message === 'INVALID_GOAL_TYPE') {
        return sendError(res, 400, 'Invalid goal type');
      }
      if (err.message === 'INVALID_TIME_RANGE') {
        return sendError(res, 400, 'Invalid time range');
      }
      if (err.message === 'INVALID_TARGET_VALUE') {
        return sendError(res, 400, 'Invalid target value');
      }
      return sendError(res, err.status || 500, err.message);
    }
  }

  // DELETE /api/retention/goals/:id - 取消目标
  const cancelGoalMatch = pathname.match(/^\/api\/retention\/goals\/(\d+)$/);
  if (cancelGoalMatch && req.method === 'DELETE') {
    try {
      const user = await authenticate(req);
      const goalId = parseInt(cancelGoalMatch[1]);

      const success = await userGoals.cancelGoal(goalId, user.id);

      if (!success) {
        return sendError(res, 404, 'Goal not found or already completed');
      }

      return sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('Error in cancelGoal:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/goals/check - 检查并更新目标进度
  if (pathname === '/api/retention/goals/check' && req.method === 'POST') {
    try {
      const user = await authenticate(req);

      const completedGoals = await userGoals.updateAndCheckGoals(user.id);

      return sendJson(res, 200, {
        completed_count: completedGoals.length,
        completed_goals: completedGoals
      });
    } catch (err) {
      console.error('Error in checkGoals:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // 好友系统
  // ============================================================================

  // POST /api/retention/friends/request - 发送好友请求
  if (pathname === '/api/retention/friends/request' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { friendId, friendUsername } = body;

      let targetUserId = friendId;

      // 如果提供的是用户名，查找用户ID
      if (!targetUserId && friendUsername) {
        const userQuery = `SELECT id FROM users WHERE username = $1`;
        const userResult = await dataStore.query(userQuery, [friendUsername]);
        if (userResult.rows.length === 0) {
          return sendError(res, 404, 'User not found');
        }
        targetUserId = userResult.rows[0].id;
      }

      if (!targetUserId) {
        return sendError(res, 400, 'Friend ID or username required');
      }

      if (targetUserId === user.id) {
        return sendError(res, 400, 'Cannot add yourself as friend');
      }

      // 检查是否已经是好友
      const checkQuery = `
        SELECT * FROM user_friendships
        WHERE (user_id = $1 AND friend_id = $2)
           OR (user_id = $2 AND friend_id = $1)
      `;
      const existing = await dataStore.query(checkQuery, [user.id, targetUserId]);

      if (existing.rows.length > 0) {
        return sendError(res, 400, 'Friendship already exists');
      }

      // 创建好友请求
      const insertQuery = `
        INSERT INTO user_friendships (user_id, friend_id, status)
        VALUES ($1, $2, 'pending')
        RETURNING *
      `;
      const result = await dataStore.query(insertQuery, [user.id, targetUserId]);

      return sendJson(res, 200, result.rows[0]);
    } catch (err) {
      console.error('Error in sendFriendRequest:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // PUT /api/retention/friends/:friendshipId/accept - 接受好友请求
  const acceptFriendMatch = pathname.match(/^\/api\/retention\/friends\/(\d+)\/accept$/);
  if (acceptFriendMatch && req.method === 'PUT') {
    try {
      const user = await authenticate(req);
      const friendshipId = acceptFriendMatch[1];

      const updateQuery = `
        UPDATE user_friendships
        SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND friend_id = $2 AND status = 'pending'
        RETURNING *
      `;
      const result = await dataStore.query(updateQuery, [friendshipId, user.id]);

      if (result.rows.length === 0) {
        return sendError(res, 404, 'Friend request not found');
      }

      return sendJson(res, 200, result.rows[0]);
    } catch (err) {
      console.error('Error in acceptFriendRequest:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/friends - 获取好友列表
  if (pathname === '/api/retention/friends' && req.method === 'GET') {
    try {
      const user = await authenticate(req);

      const query = `
        SELECT
          uf.id AS friendship_id,
          u.id AS user_id,
          u.username,
          u.level,
          uf.status,
          uf.accepted_at,
          uf.last_interaction_at
        FROM user_friendships uf
        JOIN users u ON (
          CASE
            WHEN uf.user_id = $1 THEN uf.friend_id = u.id
            WHEN uf.friend_id = $1 THEN uf.user_id = u.id
          END
        )
        WHERE (uf.user_id = $1 OR uf.friend_id = $1)
          AND uf.status = 'accepted'
        ORDER BY uf.accepted_at DESC
      `;
      const result = await dataStore.query(query, [user.id]);

      return sendJson(res, 200, result.rows);
    } catch (err) {
      console.error('Error in getFriends:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // 学习小组系统
  // ============================================================================

  // POST /api/retention/groups/weekly-challenge - 快速创建5人小组周目标
  if (pathname === '/api/retention/groups/weekly-challenge' && req.method === 'POST') {
    try {
      if (dataStore.isDatabaseAvailable && !dataStore.isDatabaseAvailable()) {
        return sendError(res, 503, '服务暂不可用，请稍后再试');
      }
      const user = await authenticate(req);
      const body = await parseBody(req);
      const name = body?.name || '5人组队挑战';
      const description = body?.description || '本周一起完成学习目标';
      const targetValue = Number(body?.target_value || body?.targetValue || 300);
      const challengeType = body?.challenge_type || 'study_minutes';
      if (!Number.isFinite(targetValue) || targetValue < 60 || targetValue > 600) {
        return sendError(res, 400, '目标分钟数需在 60-600 之间');
      }
      const startDate = body?.start_date || new Date().toISOString().slice(0, 10);
      const endDate = body?.end_date || new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const group = await studyGroups.createGroup(user.id, {
        name,
        description,
        groupType: 'public',
        maxMembers: 5,
        learningGoal: body?.learning_goal || '完成本周目标',
        targetLanguage: body?.target_language || 'en',
        difficultyLevel: body?.difficulty_level || null
      });

      const challenge = await studyGroups.createChallenge(group.id, user.id, {
        title: body?.challenge_title || '本周目标挑战',
        description: body?.challenge_description || '一起完成本周学习目标',
        challengeType,
        targetValue,
        startDate,
        endDate
      });

      return sendJson(res, 201, { group, challenge });
    } catch (err) {
      console.error('Error in createWeeklyChallengeGroup:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/groups - 创建学习小组
  if (pathname === '/api/retention/groups' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);

      const group = await studyGroups.createGroup(user.id, body);
      return sendJson(res, 201, group);
    } catch (err) {
      console.error('Error in createGroup:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/groups - 获取学习小组列表
  if (pathname === '/api/retention/groups' && req.method === 'GET') {
    try {
      const groupType = url.searchParams.get('type');
      const difficultyLevel = url.searchParams.get('level');
      const limit = parseInt(url.searchParams.get('limit')) || 20;
      const offset = parseInt(url.searchParams.get('offset')) || 0;

      const groups = await studyGroups.getGroups({
        groupType,
        difficultyLevel,
        limit,
        offset
      });
      return sendJson(res, 200, groups);
    } catch (err) {
      console.error('Error in getGroups:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/groups/my - 获取我的小组列表
  if (pathname === '/api/retention/groups/my' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const groups = await studyGroups.getUserGroups(user.id);
      return sendJson(res, 200, groups);
    } catch (err) {
      console.error('Error in getUserGroups:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/groups/:id - 获取小组详情
  const groupDetailMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)$/);
  if (groupDetailMatch && req.method === 'GET') {
    try {
      const groupId = groupDetailMatch[1];
      let userId = null;
      try {
        const user = await authenticate(req);
        userId = user.id;
      } catch (e) {
        // 允许未登录用户查看公开小组
      }

      const group = await studyGroups.getGroupDetail(groupId, userId);
      return sendJson(res, 200, group);
    } catch (err) {
      console.error('Error in getGroupDetail:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/groups/:id/join - 加入小组
  const joinGroupMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)\/join$/);
  if (joinGroupMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const groupId = joinGroupMatch[1];

      const member = await studyGroups.joinGroup(groupId, user.id);
      return sendJson(res, 200, member);
    } catch (err) {
      console.error('Error in joinGroup:', err);
      return sendError(res, err.status || 400, err.message);
    }
  }

  // POST /api/retention/groups/:id/leave - 离开小组
  const leaveGroupMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)\/leave$/);
  if (leaveGroupMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const groupId = leaveGroupMatch[1];

      await studyGroups.leaveGroup(groupId, user.id);
      return sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('Error in leaveGroup:', err);
      return sendError(res, err.status || 400, err.message);
    }
  }

  // GET /api/retention/groups/:id/leaderboard - 获取小组排行榜
  const groupLeaderboardMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)\/leaderboard$/);
  if (groupLeaderboardMatch && req.method === 'GET') {
    try {
      const groupId = groupLeaderboardMatch[1];
      const metric = url.searchParams.get('metric') || 'contribution_xp';

      const rankings = await studyGroups.getGroupLeaderboard(groupId, metric);
      return sendJson(res, 200, rankings);
    } catch (err) {
      console.error('Error in getGroupLeaderboard:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/groups/:id/challenges - 创建小组挑战
  const createChallengeMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)\/challenges$/);
  if (createChallengeMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const groupId = createChallengeMatch[1];
      const body = await parseBody(req);

      const challenge = await studyGroups.createChallenge(groupId, user.id, body);
      return sendJson(res, 201, challenge);
    } catch (err) {
      console.error('Error in createChallenge:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/groups/:id/challenges - 获取小组挑战列表
  if (createChallengeMatch && req.method === 'GET') {
    try {
      const groupId = createChallengeMatch[1];
      const challenges = await studyGroups.getGroupChallenges(groupId);
      return sendJson(res, 200, challenges);
    } catch (err) {
      console.error('Error in getGroupChallenges:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/challenges/:id/join - 参加挑战
  const joinChallengeMatch = pathname.match(/^\/api\/retention\/challenges\/(\d+)\/join$/);
  if (joinChallengeMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const challengeId = joinChallengeMatch[1];

      const participant = await studyGroups.joinChallenge(challengeId, user.id);
      return sendJson(res, 200, participant);
    } catch (err) {
      console.error('Error in joinChallenge:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // GET /api/retention/groups/:id/activities - 获取小组动态
  const groupActivitiesMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)\/activities$/);
  if (groupActivitiesMatch && req.method === 'GET') {
    try {
      const groupId = groupActivitiesMatch[1];
      const limit = parseInt(url.searchParams.get('limit')) || 20;
      const activityType = url.searchParams.get('type') || null;

      const activities = await studyGroups.getGroupActivities(groupId, limit, activityType);
      return sendJson(res, 200, activities);
    } catch (err) {
      console.error('Error in getGroupActivities:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/groups/:id/chat - 发送小组聊天消息
  const groupChatMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)\/chat$/);
  if (groupChatMatch && req.method === 'POST') {
    try {
      console.log('[GroupChat] POST /chat', { path: pathname });
      const user = await authenticate(req);
      const groupId = Number(groupChatMatch[1]);
      const body = await parseBody(req);
      const content = String(body?.content || '').trim();
      const rawAttachments = Array.isArray(body?.attachments) ? body.attachments : [];
      const attachments = rawAttachments
        .filter(att => att && typeof att.url === 'string' && typeof att.kind === 'string')
        .map(att => ({ url: att.url, kind: att.kind }))
        .filter(att => att.kind === 'image' || att.kind === 'audio')
        .slice(0, 6);

      if (!content && attachments.length === 0) {
        return sendError(res, 400, '内容不能为空');
      }
      if (content.length > 500) {
        return sendError(res, 400, '内容过长，请控制在 500 字以内');
      }
      const muteCheck = await dataStore.query(
        `SELECT muted_until FROM group_member_mutes
         WHERE group_id = $1 AND user_id = $2 AND muted_until > NOW()
         LIMIT 1`,
        [groupId, user.id]
      );
      if (muteCheck.rows.length > 0) {
        return sendError(res, 403, '你已被禁言，暂时无法发言');
      }
      const membership = await dataStore.query(
        `SELECT role FROM study_group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
        [groupId, user.id]
      );
      if (membership.rows.length === 0) {
        return sendError(res, 403, '加入小组后才能发言');
      }

      const mentions = content.match(/@([a-zA-Z0-9_\u4e00-\u9fa5]+)/g) || [];
      const activity = await studyGroups.postActivity(groupId, user.id, 'chat', content, {
        attachments,
        mentions: Array.from(new Set(mentions.map(m => m.slice(1))))
      });
      console.log('[GroupChat] Message stored', {
        groupId,
        userId: user.id,
        activityId: activity?.id,
        contentLength: content.length,
        attachmentCount: attachments.length
      });
      broadcastGroupChat(groupId, {
        id: activity.id,
        group_id: groupId,
        user_id: user.id,
        username: user.username || '成员',
        content,
        created_at: activity.created_at,
        activity_data: activity.activity_data
      });
      return sendJson(res, 201, activity);
    } catch (err) {
      console.error('Error in postGroupChat:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/groups/:id/mute - 禁言成员
  const groupMuteMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)\/mute$/);
  if (groupMuteMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const groupId = Number(groupMuteMatch[1]);
      const body = await parseBody(req);
      const targetUserId = Number(body?.user_id);
      const hours = Number(body?.hours || 24);
      const reason = String(body?.reason || '违反群规').slice(0, 200);
      if (!Number.isFinite(targetUserId)) {
        return sendError(res, 400, '缺少用户ID');
      }
      if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
        return sendError(res, 400, '禁言时长需在 1-720 小时之间');
      }
      if (!user?.is_admin) {
        const modCheck = await dataStore.query(
          `SELECT role FROM study_group_members
           WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
          [groupId, user.id]
        );
        const role = modCheck.rows[0]?.role;
        if (!role || (role !== 'owner' && role !== 'admin')) {
          return sendError(res, 403, '无权限禁言');
        }
      }
      const mutedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
      await dataStore.query(
        `INSERT INTO group_member_mutes (group_id, user_id, muted_until, reason, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (group_id, user_id)
         DO UPDATE SET muted_until = EXCLUDED.muted_until, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, updated_at = NOW()`,
        [groupId, targetUserId, mutedUntil, reason, user.id]
      );
      if (user?.is_admin && typeof dataStore.logAdminAction === 'function') {
        await dataStore.logAdminAction(user.id, targetUserId, 'group_mute', { groupId, hours, reason });
      }
      return sendJson(res, 200, { success: true, muted_until: mutedUntil });
    } catch (err) {
      console.error('Error in muteGroupMember:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/groups/:id/unmute - 解除禁言
  const groupUnmuteMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)\/unmute$/);
  if (groupUnmuteMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const groupId = Number(groupUnmuteMatch[1]);
      const body = await parseBody(req);
      const targetUserId = Number(body?.user_id);
      if (!Number.isFinite(targetUserId)) {
        return sendError(res, 400, '缺少用户ID');
      }
      if (!user?.is_admin) {
        const modCheck = await dataStore.query(
          `SELECT role FROM study_group_members
           WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
          [groupId, user.id]
        );
        const role = modCheck.rows[0]?.role;
        if (!role || (role !== 'owner' && role !== 'admin')) {
          return sendError(res, 403, '无权限解除禁言');
        }
      }
      await dataStore.query(
        `DELETE FROM group_member_mutes WHERE group_id = $1 AND user_id = $2`,
        [groupId, targetUserId]
      );
      if (user?.is_admin && typeof dataStore.logAdminAction === 'function') {
        await dataStore.logAdminAction(user.id, targetUserId, 'group_unmute', { groupId });
      }
      return sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('Error in unmuteGroupMember:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // POST /api/retention/groups/:id/chat-upload - 上传聊天附件
  const groupChatUploadMatch = pathname.match(/^\/api\/retention\/groups\/(\d+)\/chat-upload$/);
  if (groupChatUploadMatch && req.method === 'POST') {
    try {
      console.log('[GroupChat] POST /chat-upload', { path: pathname, query: url.searchParams.toString() });
      const user = await authenticate(req);
      const groupId = Number(groupChatUploadMatch[1]);
      const uploadKind = url.searchParams.get('kind') || 'image';
      const autoSend = url.searchParams.get('auto_send') === '1';
      const membership = await dataStore.query(
        `SELECT role FROM study_group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
        [groupId, user.id]
      );
      if (membership.rows.length === 0) {
        return sendError(res, 403, '加入小组后才能上传');
      }
      if (autoSend) {
        const muteCheck = await dataStore.query(
          `SELECT muted_until FROM group_member_mutes
           WHERE group_id = $1 AND user_id = $2 AND muted_until > NOW()
           LIMIT 1`,
          [groupId, user.id]
        );
        if (muteCheck.rows.length > 0) {
          return sendError(res, 403, '你已被禁言，暂时无法发言');
        }
      }

      const { handleFileUpload } = require('../upload-handler');
      const maxTotalBytes = uploadKind === 'audio' ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
      const { files } = await handleFileUpload(req, { maxTotalBytes });
      const file = files?.file;
      if (!file) {
        console.warn('[GroupChat] Upload missing file', { groupId, userId: user.id, uploadKind });
        return sendError(res, 400, '请选择文件');
      }
      const mime = String(file.mimetype || '');
      if (uploadKind === 'image' && !mime.startsWith('image/')) {
        return sendError(res, 400, '仅支持图片上传');
      }
      if (uploadKind === 'audio' && !mime.startsWith('audio/')) {
        return sendError(res, 400, '仅支持音频上传');
      }

      const fs = require('fs/promises');
      const path = require('path');
      const chatDir = path.join(__dirname, '../uploads/chat');
      await fs.mkdir(chatDir, { recursive: true });
      const sourcePath = file.filepath || file.path;
      if (!sourcePath) {
        return sendError(res, 400, '文件上传失败');
      }
      const targetName = `${Date.now()}-${path.basename(sourcePath)}`;
      const targetPath = path.join(chatDir, targetName);
      await fs.rename(sourcePath, targetPath);
      const urlPath = `/chat-uploads/${targetName}`;
      if (autoSend) {
        const activity = await studyGroups.postActivity(groupId, user.id, 'chat', '', {
          attachments: [{ url: urlPath, kind: uploadKind }]
        });
        console.log('[GroupChat] Upload stored + auto-send', {
          groupId,
          userId: user.id,
          activityId: activity?.id,
          urlPath,
          uploadKind
        });
        broadcastGroupChat(groupId, {
          id: activity.id,
          group_id: groupId,
          user_id: user.id,
          username: user.username || '成员',
          content: '',
          created_at: activity.created_at,
          activity_data: activity.activity_data
        });
        return sendJson(res, 200, { url: urlPath, kind: uploadKind, mime, activity });
      }
      return sendJson(res, 200, { url: urlPath, kind: uploadKind, mime });
    } catch (err) {
      console.error('Error in chat upload:', err);
      return sendError(res, err.status || 500, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerRetentionRoutes };
