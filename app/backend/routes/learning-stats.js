'use strict';

/**
 * Learning Statistics Routes
 *
 * Endpoints:
 *   GET  /api/stats/overview         - Overall stats for the authenticated user
 *   GET  /api/stats/daily?days=30    - Daily breakdown for chart data
 *   GET  /api/stats/leaderboard?limit=10 - Top learners by XP this week
 *   POST /api/stats/log              - Log a learning activity
 */

const dataStore = require('../data-store');
const { sendJson, sendError } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const { parseBody } = require('../utils/parsers');
const achievements = require('../services/achievements');

const MAX_MIGRATED_XP = 20000;

// XP thresholds for level calculation (level = index + 1)
const LEVEL_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5500, 7500];

function calcLevel(totalXp) {
  let level = 1;
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalXp >= LEVEL_THRESHOLDS[i]) {
      level = i + 1;
      break;
    }
  }
  return level;
}

/**
 * Ensure a learning_streaks row exists for the user and return it.
 */
async function getOrCreateStreak(userId) {
  const existing = await dataStore.query(
    'SELECT * FROM learning_streaks WHERE user_id = $1',
    [userId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const inserted = await dataStore.query(
    `INSERT INTO learning_streaks (user_id, current_streak, longest_streak)
     VALUES ($1, 0, 0)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [userId]
  );
  return inserted.rows[0];
}

/**
 * Update the streak for a user after a learning activity today.
 * Uses current_date in DB to stay timezone-neutral.
 */
async function updateStreak(userId) {
  const streak = await getOrCreateStreak(userId);
  const today = new Date().toISOString().slice(0, 10);
  const lastActive = streak.last_active_date
    ? new Date(streak.last_active_date).toISOString().slice(0, 10)
    : null;

  if (lastActive === today) {
    // Already counted today
    return streak;
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const newStreak = lastActive === yesterday ? streak.current_streak + 1 : 1;
  const newLongest = Math.max(newStreak, streak.longest_streak);

  const updated = await dataStore.query(
    `UPDATE learning_streaks
     SET current_streak = $2, longest_streak = $3, last_active_date = $4
     WHERE user_id = $1
     RETURNING *`,
    [userId, newStreak, newLongest, today]
  );
  return updated.rows[0];
}

// ---------------------------------------------------------------------------
// GET /api/stats/overview
// ---------------------------------------------------------------------------
/**
 * 一次性迁移进来的本地 XP。只计入终身总量与等级,不进入任何时间窗口统计。
 * V30 未应用时该表不存在,与同组的 user_vocabulary 查询一样降级为 0。
 */
async function fetchMigratedXp(userId) {
  const r = await dataStore.query(
    'SELECT COALESCE(migrated_xp, 0) AS xp FROM local_xp_migrations WHERE user_id = $1',
    [userId]
  ).catch(() => ({ rows: [] }));
  return r.rows.length ? parseInt(r.rows[0].xp, 10) : 0;
}

async function handleOverview(req, res) {
  const user = await authenticate(req);

  const [streakRes, dailyRes, vocabRes, migratedXp] = await Promise.all([
    getOrCreateStreak(user.id),
    dataStore.query(
      `SELECT
         COALESCE(SUM(minutes_studied), 0)              AS total_minutes,
         COALESCE(SUM(xp_earned), 0)                    AS total_xp,
         COALESCE(SUM(words_learned), 0)                AS total_words_learned,
         COALESCE(SUM(words_reviewed), 0)               AS total_words_reviewed,
         COALESCE(SUM(articles_read), 0)                AS total_articles_read,
         COALESCE(SUM(training_sessions_completed), 0)  AS total_sessions
       FROM daily_learning_stats
       WHERE user_id = $1`,
      [user.id]
    ),
    // Also count vocab from the actual user_vocabulary table if it exists
    dataStore.query(
      `SELECT COUNT(*) AS cnt FROM user_vocabulary WHERE user_id = $1`,
      [user.id]
    ).catch(() => ({ rows: [{ cnt: 0 }] })),
    fetchMigratedXp(user.id),
  ]);

  const stats = dailyRes.rows[0];
  // 终身 XP = 已赚取 + 一次性迁移量;等级由此得出,迁移不会表现为掉级
  const totalXp = parseInt(stats.total_xp, 10) + migratedXp;
  const vocabCount = parseInt(vocabRes.rows[0].cnt, 10);

  return sendJson(res, 200, {
    streak: {
      current: streakRes.current_streak,
      longest: streakRes.longest_streak,
      last_active_date: streakRes.last_active_date,
    },
    total_minutes_studied: parseInt(stats.total_minutes, 10),
    total_xp: totalXp,
    level: calcLevel(totalXp),
    total_words_learned: parseInt(stats.total_words_learned, 10) + vocabCount,
    total_words_reviewed: parseInt(stats.total_words_reviewed, 10),
    total_articles_read: parseInt(stats.total_articles_read, 10),
    total_training_sessions: parseInt(stats.total_sessions, 10),
  });
}

// ---------------------------------------------------------------------------
// GET /api/stats/daily?days=30
// ---------------------------------------------------------------------------
async function handleDaily(req, res, url) {
  const user = await authenticate(req);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days')) || 30, 1), 365);

  const result = await dataStore.query(
    `SELECT
       date,
       minutes_studied,
       words_learned,
       words_reviewed,
       articles_read,
       training_sessions_completed,
       xp_earned
     FROM daily_learning_stats
     WHERE user_id = $1
       AND date >= CURRENT_DATE - ($2 - 1) * INTERVAL '1 day'
     ORDER BY date ASC`,
    [user.id, days]
  );

  return sendJson(res, 200, { days, data: result.rows });
}

// ---------------------------------------------------------------------------
// GET /api/stats/leaderboard?limit=10
// ---------------------------------------------------------------------------
async function handleLeaderboard(req, res, url) {
  await authenticate(req);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 10, 1), 100);

  const result = await dataStore.query(
    `SELECT
       u.id,
       u.username,
       COALESCE(SUM(dls.xp_earned), 0) AS weekly_xp
     FROM users u
     LEFT JOIN daily_learning_stats dls
       ON dls.user_id = u.id
       AND dls.date >= CURRENT_DATE - 6
     GROUP BY u.id, u.username
     ORDER BY weekly_xp DESC
     LIMIT $1`,
    [limit]
  );

  return sendJson(res, 200, {
    period: 'week',
    leaderboard: result.rows.map((row, idx) => ({
      rank: idx + 1,
      user_id: row.id,
      username: row.username || `User ${row.id}`,
      weekly_xp: parseInt(row.weekly_xp, 10),
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/stats/log
// ---------------------------------------------------------------------------
const VALID_TYPES = ['reading', 'vocabulary', 'training', 'video', 'other'];

async function handleLog(req, res) {
  const user = await authenticate(req);
  const body = await parseBody(req);

  const { type, duration_minutes, details = {} } = body;

  if (!type || !VALID_TYPES.includes(type)) {
    return sendError(res, 400, `type must be one of: ${VALID_TYPES.join(', ')}`);
  }
  const minutes = Math.max(0, parseInt(duration_minutes) || 0);

  // Map activity type to column increments
  const wordsLearned  = parseInt(details.words_learned)  || 0;
  const wordsReviewed = parseInt(details.words_reviewed) || 0;
  const articlesRead  = type === 'reading' ? 1 : 0;
  const sessions      = type === 'training' ? 1 : 0;
  // Simple XP formula: 10 per minute + 2 per word + 5 per article
  const xp = minutes * 10 + (wordsLearned + wordsReviewed) * 2 + articlesRead * 5;

  await dataStore.query(
    `INSERT INTO daily_learning_stats
       (user_id, date, minutes_studied, words_learned, words_reviewed,
        articles_read, training_sessions_completed, xp_earned)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, date) DO UPDATE SET
       minutes_studied             = daily_learning_stats.minutes_studied             + EXCLUDED.minutes_studied,
       words_learned               = daily_learning_stats.words_learned               + EXCLUDED.words_learned,
       words_reviewed              = daily_learning_stats.words_reviewed              + EXCLUDED.words_reviewed,
       articles_read               = daily_learning_stats.articles_read               + EXCLUDED.articles_read,
       training_sessions_completed = daily_learning_stats.training_sessions_completed + EXCLUDED.training_sessions_completed,
       xp_earned                   = daily_learning_stats.xp_earned                   + EXCLUDED.xp_earned`,
    [user.id, minutes, wordsLearned, wordsReviewed, articlesRead, sessions, xp]
  );

  // Update streak
  const streak = await updateStreak(user.id);

  const totalsRes = await dataStore.query(
    `SELECT COALESCE(SUM(minutes_studied),0) AS m,
            COALESCE(SUM(words_learned),0) + COALESCE(SUM(words_reviewed),0) AS w,
            COALESCE(SUM(training_sessions_completed),0) AS s
       FROM daily_learning_stats WHERE user_id = $1`,
    [user.id]
  );
  const t = totalsRes.rows[0];
  const unlocked = await achievements.checkAndUnlock(user.id, {
    totalMinutes: parseInt(t.m, 10),
    totalWords: parseInt(t.w, 10),
    totalSessions: parseInt(t.s, 10),
    streak: streak.current_streak,
  }).catch(() => []);

  return sendJson(res, 200, {
    logged: true,
    xp_earned: xp,
    current_streak: streak.current_streak,
    unlocked,
  });
}

// ---------------------------------------------------------------------------
// GET /api/stats/achievements
// ---------------------------------------------------------------------------
async function handleAchievements(req, res) {
  const user = await authenticate(req);
  const rows = await achievements.listUnlocked(user.id);
  const iconByType = Object.fromEntries(achievements.ACHIEVEMENTS.map(a => [a.type, a.icon]));
  return sendJson(res, 200, {
    unlocked: rows.map(r => ({
      type: r.achievement_type,
      name: r.achievement_name,
      description: r.achievement_description,
      rarity: r.rarity,
      xp_reward: r.xp_reward,
      unlocked_at: r.unlocked_at,
      icon: iconByType[r.achievement_type] || '🏅',
    })),
    catalog: achievements.ACHIEVEMENTS.map(({ type, name, description, icon, rarity }) =>
      ({ type, name, description, icon, rarity })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/stats/migrate-local
// ---------------------------------------------------------------------------
function sanitizeLocalXp(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_MIGRATED_XP);
}

async function handleMigrateLocal(req, res) {
  const user = await authenticate(req);
  const body = await parseBody(req);
  const xp = sanitizeLocalXp(body && body.xp);
  // 迁移量只落在 local_xp_migrations,不写进 daily_learning_stats:
  // 后者的 CURRENT_DATE 行会被"本周 XP"(daily?days=7)和排行榜(date >= CURRENT_DATE - 6)
  // 汇总,上线当天每个迁移用户都会显示两万本周 XP 并霸榜一周。
  // 终身 XP 与等级由 handleOverview 单独把这笔加回去(见 fetchMigratedXp)。
  const ins = await dataStore.query(
    `INSERT INTO local_xp_migrations (user_id, migrated_xp, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [user.id, xp, JSON.stringify((body && body.stats) || {})]
  );
  return sendJson(res, 200, {
    migrated: ins.rowCount > 0,
    xp_added: ins.rowCount > 0 ? xp : 0,
  });
}

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------
async function registerLearningStatsRoutes(pathname, req, res, url) {
  if (!pathname.startsWith('/api/stats')) return false;

  try {
    if (pathname === '/api/stats/overview' && req.method === 'GET') {
      return await handleOverview(req, res);
    }
    if (pathname === '/api/stats/daily' && req.method === 'GET') {
      return await handleDaily(req, res, url);
    }
    if (pathname === '/api/stats/leaderboard' && req.method === 'GET') {
      return await handleLeaderboard(req, res, url);
    }
    if (pathname === '/api/stats/log' && req.method === 'POST') {
      return await handleLog(req, res);
    }
    if (pathname === '/api/stats/achievements' && req.method === 'GET') {
      return await handleAchievements(req, res);
    }
    if (pathname === '/api/stats/migrate-local' && req.method === 'POST') {
      return await handleMigrateLocal(req, res);
    }
  } catch (err) {
    console.error('Learning stats error:', err);
    return sendError(res, err.message === 'UNAUTHORIZED' ? 401 : 500, err.message || 'Internal Server Error');
  }

  return false;
}

module.exports = { registerLearningStatsRoutes, sanitizeLocalXp };
