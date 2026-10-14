const { pool, init, dbUnavailable } = require('../core');
const { getIPLocation, getIPLocationsBatch } = require('../../utils/ip-location');

function normalizeAnalyticsDays(days, fallback = 7, max = 365) {
  const parsed = Number(days);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function analyticsDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function shiftAnalyticsDateKey(dateKey, offsetDays) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function percent(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  return Math.round((n / d) * 1000) / 10;
}

function parseEstimatedCostCents(name, fallback = 0) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed);
}

function analyticsSubjectKeySql(alias = '', visitorLinkAlias = '') {
  const prefix = alias ? `${alias}.` : '';
  const linkedVisitor = visitorLinkAlias ? `, 'v:' || ${visitorLinkAlias}.visitor_id` : '';
  return `COALESCE('v:' || NULLIF(${prefix}properties->>'visitor_id', '')${linkedVisitor}, 'u:' || ${prefix}user_id::text, 'e:' || ${prefix}id::text)`;
}

function guestVisitorLinksSql() {
  return `guest_visitor_links AS (
    SELECT DISTINCT ON (user_id)
      user_id,
      NULLIF(properties->>'visitor_id', '') AS visitor_id
    FROM events
    WHERE event_name = 'guest_login'
      AND user_id IS NOT NULL
      AND NULLIF(properties->>'visitor_id', '') IS NOT NULL
    ORDER BY user_id, event_time DESC, id DESC
  )`;
}

async function getUsageSummaryAllUsers() {
  await init();
  if (dbUnavailable()) return { by_type: {}, total_seconds: 0 };
  const { rows } = await pool.query(
    `SELECT type, COALESCE(SUM(duration_sec),0)::int AS seconds
       FROM training_sessions
      WHERE duration_sec IS NOT NULL
      GROUP BY type`
  );
  const by_type = {};
  let total = 0;
  for (const r of rows) { by_type[r.type] = r.seconds; total += r.seconds; }
  return { by_type, total_seconds: total };
}

async function getUsageSummaryForUser(userId) {
  await init();
  if (dbUnavailable()) return { by_type: {}, total_seconds: 0 };
  const { rows } = await pool.query(
    `SELECT type, COALESCE(SUM(duration_sec),0)::int AS seconds
       FROM training_sessions
      WHERE user_id = $1 AND duration_sec IS NOT NULL
      GROUP BY type`,
    [userId]
  );
  const by_type = {};
  let total = 0;
  for (const r of rows) { by_type[r.type] = r.seconds; total += r.seconds; }
  return { by_type, total_seconds: total };
}

// Category usage helpers using events table for flexible tracking
async function getEventSecondsTotal({ userId = null, name }) {
  await init();
  if (dbUnavailable()) return 0;
  const where = ['event_name = $1'];
  const values = [name];
  let idx = 2;
  if (userId != null) { where.push(`user_id = $${idx++}`); values.push(userId); }
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM((properties->>'seconds')::numeric),0)::int AS seconds
       FROM events
      WHERE ${where.join(' AND ')}`,
    values
  );
  return (rows[0] && rows[0].seconds) || 0;
}

// Windowed version for diagnostics (e.g., last N days)
async function getEventSecondsTotalWindowed({ userId = null, name, days = 7 }) {
  await init();
  if (dbUnavailable()) return 0;
  const where = ['event_name = $1', `event_time >= NOW() - INTERVAL '${Number(days)||7} days'`];
  const values = [name];
  let idx = 2;
  if (userId != null) { where.push(`user_id = $${idx++}`); values.push(userId); }
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM((properties->>'seconds')::numeric),0)::int AS seconds
       FROM events
      WHERE ${where.join(' AND ')}`,
    values
  );
  return (rows[0] && rows[0].seconds) || 0;
}

async function listRecentEventsForUser(userId, { limit = 20 } = {}) {
  await init();
  if (dbUnavailable()) return [];
  const { rows } = await pool.query(
    `SELECT id, event_time, event_name, properties, source
       FROM events
      WHERE user_id = $1
      ORDER BY event_time DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getUsageBreakdownForUser(userId) {
  await init();
  if (dbUnavailable()) return { video_watch_seconds: 0, vocab_study_seconds: 0, practice_seconds: 0 };
  const practiceQ = pool.query(
    `SELECT COALESCE(SUM(duration_sec),0)::int AS seconds
       FROM training_sessions
      WHERE user_id = $1 AND duration_sec IS NOT NULL`,
    [userId]
  );
  const videoQ = getEventSecondsTotal({ userId, name: 'video_watch' });
  const vocabQ = getEventSecondsTotal({ userId, name: 'vocab_study' });
  const [practice, video, vocab] = await Promise.all([practiceQ, videoQ, vocabQ]);
  return {
    video_watch_seconds: video,
    vocab_study_seconds: vocab,
    practice_seconds: (practice.rows?.[0]?.seconds) || 0,
  };
}

async function getGlobalCategoryUsage() {
  await init();
  if (dbUnavailable()) return { video_watch_seconds: 0, vocab_study_seconds: 0, practice_seconds: 0 };
  const practiceQ = pool.query(
    `SELECT COALESCE(SUM(duration_sec),0)::int AS seconds FROM training_sessions WHERE duration_sec IS NOT NULL`
  );
  const videoQ = getEventSecondsTotal({ name: 'video_watch' });
  const vocabQ = getEventSecondsTotal({ name: 'vocab_study' });
  const [practice, video, vocab] = await Promise.all([practiceQ, videoQ, vocabQ]);
  return {
    video_watch_seconds: (video || 0),
    vocab_study_seconds: (vocab || 0),
    practice_seconds: (practice.rows?.[0]?.seconds) || 0,
  };
}

async function getVideoUsageTop({ limit = 20 } = {}) {
  await init();
  if (dbUnavailable()) return [];
  const { rows } = await pool.query(
    `SELECT (properties->>'video_resource_id')::int AS video_resource_id,
            COALESCE(SUM((properties->>'seconds')::numeric),0)::int AS seconds,
            COUNT(DISTINCT user_id)::int AS users
       FROM events
      WHERE event_name = 'video_watch' AND (properties ? 'video_resource_id')
      GROUP BY (properties->>'video_resource_id')
      ORDER BY seconds DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getVideoUsageById(videoResourceId) {
  await init();
  if (dbUnavailable()) return [];
  const { rows } = await pool.query(
    `SELECT user_id,
            COALESCE(SUM((properties->>'seconds')::numeric),0)::int AS seconds
       FROM events
      WHERE event_name = 'video_watch' AND (properties->>'video_resource_id')::int = $1
      GROUP BY user_id
      ORDER BY seconds DESC`,
    [videoResourceId]
  );
  return rows;
}

async function getUserVideoUsageList(userId, { limit = 20 } = {}) {
  await init();
  if (dbUnavailable()) return [];
  const { rows } = await pool.query(
    `SELECT (properties->>'video_resource_id')::int AS video_resource_id,
            COALESCE(SUM((properties->>'seconds')::numeric),0)::int AS seconds
       FROM events
      WHERE event_name = 'video_watch' AND user_id = $1
      GROUP BY (properties->>'video_resource_id')
      ORDER BY seconds DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// 获取页面访问统计
async function getPageVisits({ limit = 100, offset = 0, eventName = null, userType = null } = {}) {
  await init();
  if (dbUnavailable()) return { items: [], total: 0 };

  const where = [];
  const values = [];
  let idx = 1;

  if (eventName) {
    where.push(`event_name = $${idx++}`);
    values.push(eventName);
  } else {
    where.push(`event_name IN ('page_visit', 'guest_visit')`);
  }

  // Filter by user type:
  // - registered: events tied to a non-guest user record
  // - guest: anonymous events (no user_id) OR events tied to a guest user record
  // Note: guest_visit rows typically have user_id = NULL, so filtering on u.email alone would drop them.
  if (userType === 'registered') {
    where.push(`(e.user_id IS NOT NULL AND u.email IS NOT NULL AND u.email NOT LIKE 'guest_%@temp.linglish.local')`);
  } else if (userType === 'guest') {
    where.push(`(e.user_id IS NULL OR (u.email IS NOT NULL AND u.email LIKE 'guest_%@temp.linglish.local'))`);
  }

  // Get total count
  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM events e
    LEFT JOIN users u ON e.user_id = u.id
    WHERE ${where.join(' AND ')}
  `;
  const countResult = await pool.query(countQuery, values);
  const total = countResult.rows[0]?.total || 0;

  // Get paginated results
  values.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT e.id, e.user_id, e.event_time, e.event_name, e.properties, e.source,
            u.email, u.username,
            CASE
              WHEN e.user_id IS NULL THEN 'guest'
              WHEN u.email LIKE 'guest_%@temp.linglish.local' THEN 'guest'
              ELSE 'registered'
            END AS user_type
       FROM events e
       LEFT JOIN users u ON e.user_id = u.id
      WHERE ${where.join(' AND ')}
      ORDER BY e.event_time DESC
      LIMIT $${idx++} OFFSET $${idx++}`,
    values
  );

  // Extract unique IPs from all rows to avoid redundant queries
  const uniqueIps = [...new Set(rows.map(row => {
    let props = row.properties;
    if (typeof props === 'string') {
      try {
        props = JSON.parse(props);
      } catch (e) {
        props = {};
      }
    }
    return (props && props.ip) || null;
  }).filter(Boolean))];

  // Batch query IP locations with rate limiting to avoid API throttling
  const ipLocationMap = uniqueIps.length > 0
    ? await getIPLocationsBatch(uniqueIps)
    : new Map();

  // Map IP locations back to rows
  const itemsWithLocation = rows.map(row => {
    let props = row.properties;
    if (typeof props === 'string') {
      try {
        props = JSON.parse(props);
      } catch (e) {
        props = {};
      }
    }

    const ip = (props && props.ip) || null;
    const ipLocation = ip ? (ipLocationMap.get(ip) || '未知') : '-';

    return {
      ...row,
      ip_location: ipLocation
    };
  });

  return { items: itemsWithLocation, total };
}

// 统计访问次数
async function getVisitStats({ days = 30 } = {}) {
  await init();
  if (dbUnavailable()) return { total: 0, guests: 0, users: 0, unique_ips: 0 };

  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(CASE WHEN event_name = 'guest_visit' OR event_name = 'guest_login' THEN 1 END)::int AS guests,
       COUNT(CASE WHEN event_name = 'page_visit' THEN 1 END)::int AS users,
       COUNT(DISTINCT properties->>'ip')::int AS unique_ips
     FROM events
     WHERE event_name IN ('page_visit', 'guest_visit', 'guest_login')
       AND event_time >= NOW() - INTERVAL '${Number(days)||30} days'`
  );

  return rows[0] || { total: 0, guests: 0, users: 0, unique_ips: 0 };
}

// 按日期统计访问量
async function getVisitsByDate({ days = 30 } = {}) {
  await init();
  if (dbUnavailable()) return [];

  const { rows } = await pool.query(
    `SELECT
       DATE(event_time) AS date,
       COUNT(*)::int AS total,
       COUNT(CASE WHEN event_name IN ('guest_visit', 'guest_login') THEN 1 END)::int AS guests,
       COUNT(CASE WHEN event_name = 'page_visit' THEN 1 END)::int AS users,
       COUNT(DISTINCT properties->>'ip')::int AS unique_ips
     FROM events
     WHERE event_name IN ('page_visit', 'guest_visit', 'guest_login')
       AND event_time >= NOW() - INTERVAL '${Number(days)||30} days'
     GROUP BY DATE(event_time)
     ORDER BY date DESC`
  );

  return rows;
}

// 按IP删除访问记录
async function deleteVisitsByIP(ip) {
  await init();
  if (dbUnavailable()) return { deleted: 0 };

  const { rowCount } = await pool.query(
    `DELETE FROM events
     WHERE event_name IN ('page_visit', 'guest_visit', 'guest_login')
       AND properties->>'ip' = $1`,
    [ip]
  );

  return { deleted: rowCount || 0 };
}

// 批量删除访问记录
async function deleteVisitsByIds(ids) {
  await init();
  if (dbUnavailable()) return { deleted: 0 };

  if (!Array.isArray(ids) || ids.length === 0) {
    return { deleted: 0 };
  }

  const { rowCount } = await pool.query(
    `DELETE FROM events
     WHERE id = ANY($1::int[])
       AND event_name IN ('page_visit', 'guest_visit', 'guest_login')`,
    [ids]
  );

  return { deleted: rowCount || 0 };
}

// 获取视频观看统计(包含视频标题)
async function getVideoViewsWithDetails({ limit = 10 } = {}) {
  await init();
  if (dbUnavailable()) return [];

  const { rows } = await pool.query(
    `SELECT
       v.id,
       v.title,
       v.category,
       COALESCE(SUM((e.properties->>'seconds')::numeric), 0)::int AS total_watch_seconds,
       COUNT(DISTINCT e.user_id)::int AS unique_viewers,
       COUNT(e.id)::int AS total_views
     FROM video_resources v
     LEFT JOIN events e ON e.event_name = 'video_watch'
       AND (e.properties->>'video_resource_id')::int = v.id
     GROUP BY v.id, v.title, v.category
     ORDER BY total_watch_seconds DESC
     LIMIT $1`,
    [limit]
  );

  return rows;
}

// 获取活跃用户统计(基于登录和训练)
async function getTopActiveUsers({ limit = 10, days = 30 } = {}) {
  await init();
  if (dbUnavailable()) return [];

  const { rows } = await pool.query(
    `SELECT
       u.id,
       u.username,
       u.email,
       u.membership_type,
       (u.membership_type IS NOT NULL AND u.membership_type != 'free') AS is_premium,
       u.last_login_at,
       COALESCE(SUM(ts.duration_sec), 0)::int AS total_practice_seconds,
       COUNT(DISTINCT DATE(ts.created_at))::int AS practice_days,
       COUNT(ts.id)::int AS total_sessions,
       (
         SELECT COUNT(DISTINCT DATE(ls.login_at))::int
         FROM user_login_sessions ls
         WHERE ls.user_id = u.id
           AND ls.login_at >= NOW() - INTERVAL '${Number(days)||30} days'
       ) AS login_days,
       GREATEST(
         COUNT(DISTINCT DATE(ts.created_at)),
         (
           SELECT COUNT(DISTINCT DATE(ls.login_at))
           FROM user_login_sessions ls
           WHERE ls.user_id = u.id
             AND ls.login_at >= NOW() - INTERVAL '${Number(days)||30} days'
         )
       )::int AS active_days
     FROM users u
     LEFT JOIN training_sessions ts ON ts.user_id = u.id
       AND ts.created_at >= NOW() - INTERVAL '${Number(days)||30} days'
     WHERE u.email NOT LIKE 'guest_%@temp.linglish.local'
     GROUP BY u.id, u.username, u.email, u.membership_type, u.last_login_at
     HAVING (
       SELECT COUNT(DISTINCT DATE(ls.login_at))
       FROM user_login_sessions ls
       WHERE ls.user_id = u.id
         AND ls.login_at >= NOW() - INTERVAL '${Number(days)||30} days'
     ) > 0
     ORDER BY active_days DESC, total_practice_seconds DESC, u.last_login_at DESC
     LIMIT $1`,
    [limit]
  );

  return rows;
}

// 获取用户增长趋势数据
async function getUserGrowthTrend({ days = 30 } = {}) {
  await init();
  if (dbUnavailable()) return [];

  const { rows } = await pool.query(
    `WITH date_series AS (
       SELECT generate_series(
         (NOW() - INTERVAL '${Number(days)||30} days')::date,
         NOW()::date,
         '1 day'::interval
       )::date AS date
     )
     SELECT
       ds.date,
       COUNT(u.id)::int AS new_users,
       COUNT(CASE WHEN u.membership_type IS NOT NULL AND u.membership_type != 'free' THEN 1 END)::int AS new_premium_users
     FROM date_series ds
     LEFT JOIN users u ON DATE(u.created_at) = ds.date
       AND u.email NOT LIKE 'guest_%@temp.linglish.local'
     GROUP BY ds.date
     ORDER BY ds.date ASC`
  );

  return rows;
}

// 获取用户类型分布统计
async function getUserTypeDistribution() {
  await init();
  if (dbUnavailable()) return { premium: 0, normal: 0, guests: 0 };

  const { rows } = await pool.query(
    `SELECT
       COUNT(CASE WHEN membership_type IS NOT NULL AND membership_type != 'free' THEN 1 END)::int AS premium,
       COUNT(CASE WHEN (membership_type IS NULL OR membership_type = 'free') AND email NOT LIKE 'guest_%@temp.linglish.local' THEN 1 END)::int AS normal,
       COUNT(CASE WHEN email LIKE 'guest_%@temp.linglish.local' THEN 1 END)::int AS guests
     FROM users`
  );

  return rows[0] || { premium: 0, normal: 0, guests: 0 };
}

// 获取反馈状态分布统计
async function getFeedbackStatusDistribution() {
  await init();
  if (dbUnavailable()) return [];

  try {
    const { rows } = await pool.query(
      `SELECT
         status,
         COUNT(*)::int AS count
       FROM user_feedback
       GROUP BY status
       ORDER BY count DESC`
    );

    return rows;
  } catch (error) {
    console.error('Error fetching feedback distribution:', error);
    return [];
  }
}

// CTA click heatmap (grouped by element name)
async function getClickHeatmap({ days = 30, limit = 12, page = null } = {}) {
  await init();
  if (dbUnavailable()) return [];

  const where = [`e.event_name = 'click'`, `e.event_time >= NOW() - INTERVAL '${Number(days) || 30} days'`];
  const values = [];
  let idx = 1;

  if (page) {
    where.push(`(e.properties->>'page') = $${idx++}`);
    values.push(page);
  }

  values.push(limit);

  const { rows } = await pool.query(
    `SELECT
       COALESCE(e.properties->>'name', 'unknown') AS name,
       COALESCE(e.properties->>'label', '') AS label,
       COUNT(*)::int AS clicks,
       COUNT(DISTINCT e.user_id)::int AS users,
       COUNT(CASE WHEN e.user_id IS NULL OR u.email LIKE 'guest_%@temp.linglish.local' THEN 1 END)::int AS guest_clicks
     FROM events e
     LEFT JOIN users u ON e.user_id = u.id
     WHERE ${where.join(' AND ')}
     GROUP BY name, label
     ORDER BY clicks DESC
     LIMIT $${idx++}`,
    values
  );

  return rows;
}

// Funnel metrics (guest -> register -> login)
async function getGuestFunnelStats({ days = 30 } = {}) {
  await init();
  if (dbUnavailable()) return [];

  const { rows } = await pool.query(
    `SELECT
       e.event_name,
       COUNT(*)::int AS events,
       COUNT(DISTINCT e.user_id)::int AS users
     FROM events e
     WHERE e.event_name IN ('guest_login_success', 'register_success', 'login_success')
       AND e.event_time >= NOW() - INTERVAL '${Number(days) || 30} days'
     GROUP BY e.event_name
     ORDER BY events DESC`
  );

  return rows;
}

function buildFunnelSteps(stepRows) {
  const start = Number(stepRows[0]?.users) || 0;
  let previous = start;

  return stepRows.map((step, index) => {
    const events = Number(step.events) || 0;
    const users = Number(step.users) || 0;
    const rateFromStart = start > 0 ? Math.round((users / start) * 1000) / 10 : 0;
    const rateFromPrevious = index === 0
      ? 100
      : (previous > 0 ? Math.round((users / previous) * 1000) / 10 : 0);
    previous = users;
    return {
      ...step,
      events,
      users,
      rate_from_start: rateFromStart,
      rate_from_previous: rateFromPrevious,
    };
  });
}

// First-day activation cohort (registered user -> first training loop within 24h)
async function getFirstDayActivationStats({ days = 30 } = {}) {
  await init();
  const normalizedDays = normalizeAnalyticsDays(days, 30, 365);

  const emptySteps = buildFunnelSteps([
    { key: 'registered', label: '新注册用户', events: 0, users: 0 },
    { key: 'email_verified', label: '首日验证邮箱', events: 0, users: 0 },
    { key: 'today_entered', label: '首日进入 Today', events: 0, users: 0 },
    { key: 'first_action', label: '首日点击训练动作', events: 0, users: 0 },
    { key: 'training_started', label: '首日产生训练', events: 0, users: 0 },
    { key: 'practice_completed', label: '首日完成跟读', events: 0, users: 0 },
    { key: 'upgrade_intent', label: '首日升级意向', events: 0, users: 0 },
  ]);

  if (dbUnavailable()) {
    return {
      days: normalizedDays,
      summary: {
        registered_users: 0,
        email_verified_users: 0,
        today_entered_users: 0,
        first_action_users: 0,
        training_started_users: 0,
        practice_completed_users: 0,
        upgrade_intent_users: 0,
        email_verification_rate: 0,
        today_entry_rate: 0,
        first_action_rate: 0,
        training_start_rate: 0,
        practice_completion_rate: 0,
        upgrade_intent_rate: 0,
      },
      steps: emptySteps,
      daily: [],
      segments: [],
    };
  }

  const { rows } = await pool.query(
    `WITH cohort AS (
       SELECT
         id,
         DATE(created_at)::text AS cohort_date,
         created_at,
         COALESCE(NULLIF(level, ''), 'unknown') AS level
       FROM users
       WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
         AND email NOT LIKE 'guest_%@temp.linglish.local'
     ),
     flags AS (
       SELECT
         c.id AS user_id,
         BOOL_OR(e.event_name = 'email_verified') AS email_verified_first_day,
         BOOL_OR(e.event_name IN ('today_workspace_view', 'mobile_today_workspace_view')) AS today_entered,
         BOOL_OR(
           e.event_name IN ('mobile_today_mode_switch', 'today_first_lesson_start', 'practice_first_lesson_start', 'practice_first_lesson_complete')
           OR (
             e.event_name = 'click'
             AND e.properties->>'page' = 'today'
             AND e.properties->>'name' IN (
               'primary_action', 'practice_action', 'recommended_video',
               'guest_video_action', 'guest_shadowing_action', 'guest_vocab_action',
               'plan_watch', 'plan_shadowing', 'plan_review',
               'fallback_video_action', 'fallback_shadowing_action', 'fallback_vocab_action',
               'vocab_action', 'view_all_videos', 'review_next_action', 'weekly_review_action'
             )
           )
         ) AS first_action,
         BOOL_OR(
           e.event_name IN ('practice_first_lesson_start', 'practice_first_lesson_complete', 'today_practice_completed', 'vocab_study')
           OR e.event_name = 'video_watch'
         ) AS training_started,
         BOOL_OR(e.event_name IN ('practice_first_lesson_complete', 'today_practice_completed')) AS practice_completed,
         BOOL_OR(
           e.event_name IN ('pricing_upgrade_click', 'pricing_checkout_started', 'mobile_today_upgrade_click')
           OR (
             e.event_name = 'click'
             AND e.properties->>'page' = 'today'
             AND e.properties->>'name' IN (
               'upgrade_pricing', 'nav_pricing', 'membership_center',
               'review_pricing', 'review_upgrade_action'
             )
           )
         ) AS upgrade_intent
       FROM cohort c
       LEFT JOIN events e
         ON e.user_id = c.id
        AND e.event_time >= c.created_at
        AND e.event_time < c.created_at + INTERVAL '1 day'
       GROUP BY c.id
     )
     SELECT
       c.id AS user_id,
       c.cohort_date,
       c.level,
       COALESCE(f.email_verified_first_day, FALSE) AS email_verified_first_day,
       COALESCE(f.today_entered, FALSE) AS today_entered,
       COALESCE(f.first_action, FALSE) AS first_action,
       COALESCE(f.training_started, FALSE) AS training_started,
       COALESCE(f.practice_completed, FALSE) AS practice_completed,
       COALESCE(f.upgrade_intent, FALSE) AS upgrade_intent
     FROM cohort c
     LEFT JOIN flags f ON f.user_id = c.id
     ORDER BY c.cohort_date ASC, c.id ASC`,
    [normalizedDays],
  );

  const summary = {
    registered_users: rows.length,
    email_verified_users: rows.filter(row => row.email_verified_first_day).length,
    today_entered_users: rows.filter(row => row.today_entered).length,
    first_action_users: rows.filter(row => row.first_action).length,
    training_started_users: rows.filter(row => row.training_started).length,
    practice_completed_users: rows.filter(row => row.practice_completed).length,
    upgrade_intent_users: rows.filter(row => row.upgrade_intent).length,
  };
  summary.email_verification_rate = percent(summary.email_verified_users, summary.registered_users);
  summary.today_entry_rate = percent(summary.today_entered_users, summary.registered_users);
  summary.first_action_rate = percent(summary.first_action_users, summary.registered_users);
  summary.training_start_rate = percent(summary.training_started_users, summary.registered_users);
  summary.practice_completion_rate = percent(summary.practice_completed_users, summary.registered_users);
  summary.upgrade_intent_rate = percent(summary.upgrade_intent_users, summary.registered_users);

  const steps = buildFunnelSteps([
    { key: 'registered', label: '新注册用户', events: summary.registered_users, users: summary.registered_users },
    { key: 'email_verified', label: '首日验证邮箱', events: summary.email_verified_users, users: summary.email_verified_users },
    { key: 'today_entered', label: '首日进入 Today', events: summary.today_entered_users, users: summary.today_entered_users },
    { key: 'first_action', label: '首日点击训练动作', events: summary.first_action_users, users: summary.first_action_users },
    { key: 'training_started', label: '首日产生训练', events: summary.training_started_users, users: summary.training_started_users },
    { key: 'practice_completed', label: '首日完成跟读', events: summary.practice_completed_users, users: summary.practice_completed_users },
    { key: 'upgrade_intent', label: '首日升级意向', events: summary.upgrade_intent_users, users: summary.upgrade_intent_users },
  ]);

  const dailyMap = new Map();
  for (let i = normalizedDays - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - i);
    dailyMap.set(date.toISOString().slice(0, 10), {
      date: date.toISOString().slice(0, 10),
      registered_users: 0,
      email_verified_users: 0,
      today_entered_users: 0,
      first_action_users: 0,
      training_started_users: 0,
      practice_completed_users: 0,
      upgrade_intent_users: 0,
    });
  }

  const segmentMap = new Map();
  rows.forEach((row) => {
    const date = analyticsDateKey(row.cohort_date);
    if (dailyMap.has(date)) {
      const daily = dailyMap.get(date);
      daily.registered_users += 1;
      if (row.email_verified_first_day) daily.email_verified_users += 1;
      if (row.today_entered) daily.today_entered_users += 1;
      if (row.first_action) daily.first_action_users += 1;
      if (row.training_started) daily.training_started_users += 1;
      if (row.practice_completed) daily.practice_completed_users += 1;
      if (row.upgrade_intent) daily.upgrade_intent_users += 1;
    }

    const level = row.level || 'unknown';
    const segment = segmentMap.get(level) || {
      level,
      registered_users: 0,
      today_entered_users: 0,
      training_started_users: 0,
      practice_completed_users: 0,
    };
    segment.registered_users += 1;
    if (row.today_entered) segment.today_entered_users += 1;
    if (row.training_started) segment.training_started_users += 1;
    if (row.practice_completed) segment.practice_completed_users += 1;
    segmentMap.set(level, segment);
  });

  const daily = Array.from(dailyMap.values()).map((row) => ({
    ...row,
    today_entry_rate: percent(row.today_entered_users, row.registered_users),
    training_start_rate: percent(row.training_started_users, row.registered_users),
    practice_completion_rate: percent(row.practice_completed_users, row.registered_users),
  }));

  const segments = Array.from(segmentMap.values())
    .map((item) => ({
      ...item,
      today_entry_rate: percent(item.today_entered_users, item.registered_users),
      training_start_rate: percent(item.training_started_users, item.registered_users),
      practice_completion_rate: percent(item.practice_completed_users, item.registered_users),
    }))
    .sort((a, b) => b.registered_users - a.registered_users);

  return {
    days: normalizedDays,
    summary,
    steps,
    daily,
    segments,
  };
}

// Today workspace activation funnel
async function getTodayActivationFunnel({ days = 30 } = {}) {
  await init();
  const normalizedDays = normalizeAnalyticsDays(days, 30, 365);

  const emptySteps = buildFunnelSteps([
    { key: 'workspace_view', label: '进入今日工作台', events: 0, users: 0 },
    { key: 'plan_loaded', label: '计划加载成功', events: 0, users: 0 },
    { key: 'next_action_click', label: '点击下一步', events: 0, users: 0 },
    { key: 'workspace_ready', label: '首课工作区就绪', events: 0, users: 0 },
    { key: 'video_watch', label: '产生视频观看', events: 0, users: 0 },
    { key: 'practice_completed', label: '完成跟读练习', events: 0, users: 0 },
    { key: 'next_session_commitment', label: '承诺下次训练', events: 0, users: 0 },
    { key: 'upgrade_click', label: '点击会员/升级', events: 0, users: 0 },
  ]);

  if (dbUnavailable()) {
    return {
      days: normalizedDays,
      steps: emptySteps,
      daily: [],
      actions: [],
    };
  }

  const [stepsResult, dailyResult, actionsResult] = await Promise.all([
    pool.query(
      `WITH ${guestVisitorLinksSql()},
       windowed AS (
         SELECT e.id, e.event_name, e.user_id, e.properties, e.event_time,
                ${analyticsSubjectKeySql('e', 'guest_link')} AS subject_key
         FROM events e
         LEFT JOIN guest_visitor_links guest_link ON guest_link.user_id = e.user_id
         WHERE e.event_time >= NOW() - ($1::int * INTERVAL '1 day')
       ),
       step_defs AS (
         SELECT * FROM (VALUES
           ('workspace_view', '进入今日工作台', 1),
           ('plan_loaded', '计划加载成功', 2),
           ('next_action_click', '点击下一步', 3),
           ('workspace_ready', '首课工作区就绪', 4),
           ('video_watch', '产生视频观看', 5),
           ('practice_completed', '完成跟读练习', 6),
           ('next_session_commitment', '承诺下次训练', 7),
           ('upgrade_click', '点击会员/升级', 8)
         ) AS s(key, label, sort_order)
       ),
       step_events AS (
         SELECT 'workspace_view' AS key, subject_key
         FROM windowed
         WHERE event_name = 'today_workspace_view'
         UNION ALL
         SELECT 'plan_loaded' AS key, subject_key
         FROM windowed
         WHERE event_name = 'today_plan_loaded'
           AND COALESCE(properties->>'status', '') <> 'fallback_error'
         UNION ALL
         SELECT 'next_action_click' AS key, subject_key
         FROM windowed
         WHERE event_name IN ('today_first_lesson_start', 'practice_first_lesson_start')
            OR (
              event_name = 'click'
              AND properties->>'page' = 'today'
              AND properties->>'name' IN (
                'primary_action', 'practice_action', 'recommended_video',
                'guest_video_action', 'guest_shadowing_action', 'guest_vocab_action',
                'plan_watch', 'plan_shadowing', 'plan_review',
                'fallback_video_action', 'fallback_shadowing_action', 'fallback_vocab_action',
                'vocab_action', 'view_all_videos'
              )
            )
         UNION ALL
         SELECT 'workspace_ready' AS key, subject_key
         FROM windowed
         WHERE event_name = 'today_first_lesson_workspace_ready'
         UNION ALL
         SELECT 'video_watch' AS key, subject_key
         FROM windowed
         WHERE event_name = 'video_watch'
           AND properties->>'from' IN ('today', 'today_first_lesson')
         UNION ALL
         SELECT 'practice_completed' AS key, subject_key
         FROM windowed
         WHERE event_name IN ('practice_first_lesson_complete', 'today_practice_completed')
           AND COALESCE(properties->>'from', 'today') IN ('today', 'today_first_lesson')
         UNION ALL
         SELECT 'next_session_commitment' AS key, subject_key
         FROM windowed
         WHERE event_name = 'today_next_session_committed'
         UNION ALL
         SELECT 'upgrade_click' AS key, subject_key
         FROM windowed
         WHERE event_name = 'click'
           AND properties->>'page' = 'today'
           AND properties->>'name' IN ('upgrade_pricing', 'nav_pricing', 'membership_center')
       )
       SELECT
         sd.key,
         sd.label,
         COUNT(se.key)::int AS events,
         COUNT(DISTINCT se.subject_key)::int AS users
       FROM step_defs sd
       LEFT JOIN step_events se ON se.key = sd.key
       GROUP BY sd.key, sd.label, sd.sort_order
       ORDER BY sd.sort_order`,
      [normalizedDays],
    ),
    pool.query(
      `WITH ${guestVisitorLinksSql()},
       days AS (
         SELECT generate_series(
           (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::date,
           CURRENT_DATE,
           '1 day'::interval
         )::date AS date
       ),
       windowed AS (
         SELECT e.id, e.event_name, e.user_id, e.properties, e.event_time,
                ${analyticsSubjectKeySql('e', 'guest_link')} AS subject_key
         FROM events e
         LEFT JOIN guest_visitor_links guest_link ON guest_link.user_id = e.user_id
         WHERE e.event_time >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
       ),
       daily AS (
         SELECT
           DATE(event_time) AS date,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'today_workspace_view')::int AS workspace_view_users,
           COUNT(*) FILTER (WHERE event_name = 'today_workspace_view')::int AS workspace_view_events,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'today_plan_loaded' AND COALESCE(properties->>'status', '') <> 'fallback_error')::int AS plan_loaded_users,
           COUNT(*) FILTER (WHERE event_name = 'today_plan_loaded' AND COALESCE(properties->>'status', '') <> 'fallback_error')::int AS plan_loaded_events,
           COUNT(DISTINCT subject_key) FILTER (
             WHERE event_name = 'today_first_lesson_start'
                OR (
                  event_name = 'click'
                  AND properties->>'page' = 'today'
                  AND properties->>'name' IN (
                    'primary_action', 'practice_action', 'recommended_video',
                    'guest_video_action', 'guest_shadowing_action', 'guest_vocab_action',
                    'plan_watch', 'plan_shadowing', 'plan_review',
                    'fallback_video_action', 'fallback_shadowing_action', 'fallback_vocab_action',
                    'vocab_action', 'view_all_videos'
                  )
                )
           )::int AS next_action_click_users,
           COUNT(*) FILTER (
             WHERE event_name = 'today_first_lesson_start'
                OR (
                  event_name = 'click'
                  AND properties->>'page' = 'today'
                  AND properties->>'name' IN (
                    'primary_action', 'practice_action', 'recommended_video',
                    'guest_video_action', 'guest_shadowing_action', 'guest_vocab_action',
                    'plan_watch', 'plan_shadowing', 'plan_review',
                    'fallback_video_action', 'fallback_shadowing_action', 'fallback_vocab_action',
                    'vocab_action', 'view_all_videos'
                  )
                )
           )::int AS next_action_click_events,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'today_first_lesson_workspace_ready')::int AS workspace_ready_users,
           COUNT(*) FILTER (WHERE event_name = 'today_first_lesson_workspace_ready')::int AS workspace_ready_events,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'video_watch' AND properties->>'from' IN ('today', 'today_first_lesson'))::int AS video_watch_users,
           COUNT(*) FILTER (WHERE event_name = 'video_watch' AND properties->>'from' IN ('today', 'today_first_lesson'))::int AS video_watch_events,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name IN ('practice_first_lesson_complete', 'today_practice_completed') AND COALESCE(properties->>'from', 'today') IN ('today', 'today_first_lesson'))::int AS practice_completed_users,
           COUNT(*) FILTER (WHERE event_name IN ('practice_first_lesson_complete', 'today_practice_completed') AND COALESCE(properties->>'from', 'today') IN ('today', 'today_first_lesson'))::int AS practice_completed_events,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'today_next_session_committed')::int AS next_session_commitment_users,
           COUNT(*) FILTER (WHERE event_name = 'today_next_session_committed')::int AS next_session_commitment_events,
           COUNT(DISTINCT subject_key) FILTER (
             WHERE event_name = 'click'
               AND properties->>'page' = 'today'
               AND properties->>'name' IN ('upgrade_pricing', 'nav_pricing', 'membership_center')
           )::int AS upgrade_click_users,
           COUNT(*) FILTER (
             WHERE event_name = 'click'
               AND properties->>'page' = 'today'
               AND properties->>'name' IN ('upgrade_pricing', 'nav_pricing', 'membership_center')
           )::int AS upgrade_click_events
         FROM windowed
         GROUP BY DATE(event_time)
       )
       SELECT
         d.date,
         COALESCE(daily.workspace_view_users, 0)::int AS workspace_view_users,
         COALESCE(daily.workspace_view_events, 0)::int AS workspace_view_events,
         COALESCE(daily.plan_loaded_users, 0)::int AS plan_loaded_users,
         COALESCE(daily.plan_loaded_events, 0)::int AS plan_loaded_events,
         COALESCE(daily.next_action_click_users, 0)::int AS next_action_click_users,
         COALESCE(daily.next_action_click_events, 0)::int AS next_action_click_events,
         COALESCE(daily.workspace_ready_users, 0)::int AS workspace_ready_users,
         COALESCE(daily.workspace_ready_events, 0)::int AS workspace_ready_events,
         COALESCE(daily.video_watch_users, 0)::int AS video_watch_users,
         COALESCE(daily.video_watch_events, 0)::int AS video_watch_events,
         COALESCE(daily.practice_completed_users, 0)::int AS practice_completed_users,
         COALESCE(daily.practice_completed_events, 0)::int AS practice_completed_events,
         COALESCE(daily.next_session_commitment_users, 0)::int AS next_session_commitment_users,
         COALESCE(daily.next_session_commitment_events, 0)::int AS next_session_commitment_events,
         COALESCE(daily.upgrade_click_users, 0)::int AS upgrade_click_users,
         COALESCE(daily.upgrade_click_events, 0)::int AS upgrade_click_events
       FROM days d
       LEFT JOIN daily ON daily.date = d.date
       ORDER BY d.date ASC`,
      [normalizedDays],
    ),
    pool.query(
      `WITH ${guestVisitorLinksSql()},
       windowed AS (
         SELECT e.id, e.properties,
                ${analyticsSubjectKeySql('e', 'guest_link')} AS subject_key
         FROM events e
         LEFT JOIN guest_visitor_links guest_link ON guest_link.user_id = e.user_id
       WHERE event_name = 'click'
         AND properties->>'page' = 'today'
         AND event_time >= NOW() - ($1::int * INTERVAL '1 day')
       )
       SELECT
         COALESCE(properties->>'name', 'unknown') AS name,
         COALESCE(properties->>'section', '') AS section,
         COUNT(*)::int AS clicks,
         COUNT(DISTINCT subject_key)::int AS users
       FROM windowed
       GROUP BY name, section
       ORDER BY clicks DESC
       LIMIT 12`,
      [normalizedDays],
    ),
  ]);

  return {
    days: normalizedDays,
    steps: buildFunnelSteps(stepsResult.rows),
    daily: dailyResult.rows,
    actions: actionsResult.rows,
  };
}

// Onboarding first-run funnel (anonymous or logged-in visitor -> personalized Today)
async function getOnboardingFunnelStats({ days = 30 } = {}) {
  await init();
  const normalizedDays = normalizeAnalyticsDays(days, 30, 365);

  const emptySteps = buildFunnelSteps([
    { key: 'started', label: '开始测评', events: 0, users: 0 },
    { key: 'level_done', label: '完成水平题', events: 0, users: 0 },
    { key: 'goal_done', label: '选择学习目标', events: 0, users: 0 },
    { key: 'time_done', label: '选择每日时长', events: 0, users: 0 },
    { key: 'completed', label: '生成今日训练', events: 0, users: 0 },
    { key: 'today_entered', label: '进入 Today', events: 0, users: 0 },
    { key: 'profile_synced', label: '登录后画像生效', events: 0, users: 0 },
  ]);

  if (dbUnavailable()) {
    return {
      days: normalizedDays,
      steps: emptySteps,
      daily: [],
      segments: [],
      auth_sources: [],
    };
  }

  const onboardingEvents = [
    'onboarding_started',
    'onboarding_step_completed',
    'onboarding_completed',
    'onboarding_skipped',
    'today_workspace_view',
    'onboarding_profile_synced',
  ];

  const [stepsResult, dailyResult, segmentsResult, authSourceResult] = await Promise.all([
    pool.query(
      `WITH windowed AS (
         SELECT
           id,
           event_name,
           user_id,
           properties,
           COALESCE(
             'u:' || user_id::text,
             'v:' || NULLIF(properties->>'visitor_id', ''),
             'e:' || id::text
           ) AS subject_key
         FROM events
         WHERE event_time >= NOW() - ($1::int * INTERVAL '1 day')
           AND event_name = ANY($2::text[])
       ),
       step_defs AS (
         SELECT * FROM (VALUES
           ('started', '开始测评', 1),
           ('level_done', '完成水平题', 2),
           ('goal_done', '选择学习目标', 3),
           ('time_done', '选择每日时长', 4),
           ('completed', '生成今日训练', 5),
           ('today_entered', '进入 Today', 6),
           ('profile_synced', '登录后画像生效', 7)
         ) AS s(key, label, sort_order)
       ),
       step_events AS (
         SELECT 'started' AS key, user_id, subject_key
         FROM windowed
         WHERE event_name = 'onboarding_started'
         UNION ALL
         SELECT 'level_done' AS key, user_id, subject_key
         FROM windowed
         WHERE event_name = 'onboarding_step_completed'
           AND COALESCE(properties->>'completed_step', '') = '0'
         UNION ALL
         SELECT 'goal_done' AS key, user_id, subject_key
         FROM windowed
         WHERE event_name = 'onboarding_step_completed'
           AND COALESCE(properties->>'completed_step', '') = '1'
         UNION ALL
         SELECT 'time_done' AS key, user_id, subject_key
         FROM windowed
         WHERE event_name = 'onboarding_step_completed'
           AND COALESCE(properties->>'completed_step', '') = '2'
         UNION ALL
         SELECT 'completed' AS key, user_id, subject_key
         FROM windowed
         WHERE event_name = 'onboarding_completed'
         UNION ALL
         SELECT 'today_entered' AS key, user_id, subject_key
         FROM windowed
         WHERE event_name = 'today_workspace_view'
           AND COALESCE(properties->>'url', '') LIKE '%from=onboarding%'
         UNION ALL
         SELECT 'profile_synced' AS key, user_id, subject_key
         FROM windowed
         WHERE event_name = 'onboarding_profile_synced'
       )
       SELECT
         sd.key,
         sd.label,
         COUNT(se.key)::int AS events,
         COUNT(DISTINCT se.subject_key)::int AS users,
         COUNT(DISTINCT se.user_id)::int AS registered_users
       FROM step_defs sd
       LEFT JOIN step_events se ON se.key = sd.key
       GROUP BY sd.key, sd.label, sd.sort_order
       ORDER BY sd.sort_order`,
      [normalizedDays, onboardingEvents],
    ),
    pool.query(
      `WITH days AS (
         SELECT generate_series(
           (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::date,
           CURRENT_DATE,
           '1 day'::interval
         )::date AS date
       ),
       daily AS (
         SELECT
           DATE(event_time) AS date,
           COUNT(*) FILTER (WHERE event_name = 'onboarding_started')::int AS started,
           COUNT(*) FILTER (
             WHERE event_name = 'onboarding_step_completed'
               AND COALESCE(properties->>'completed_step', '') = '0'
           )::int AS level_done,
           COUNT(*) FILTER (
             WHERE event_name = 'onboarding_step_completed'
               AND COALESCE(properties->>'completed_step', '') = '1'
           )::int AS goal_done,
           COUNT(*) FILTER (
             WHERE event_name = 'onboarding_step_completed'
               AND COALESCE(properties->>'completed_step', '') = '2'
           )::int AS time_done,
           COUNT(*) FILTER (WHERE event_name = 'onboarding_completed')::int AS completed,
           COUNT(*) FILTER (
             WHERE event_name = 'today_workspace_view'
               AND COALESCE(properties->>'url', '') LIKE '%from=onboarding%'
           )::int AS today_entered,
           COUNT(*) FILTER (WHERE event_name = 'onboarding_profile_synced')::int AS profile_synced
         FROM events
         WHERE event_time >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
           AND event_name = ANY($2::text[])
         GROUP BY DATE(event_time)
       )
       SELECT
         days.date::text AS date,
         COALESCE(daily.started, 0)::int AS started,
         COALESCE(daily.level_done, 0)::int AS level_done,
         COALESCE(daily.goal_done, 0)::int AS goal_done,
         COALESCE(daily.time_done, 0)::int AS time_done,
         COALESCE(daily.completed, 0)::int AS completed,
         COALESCE(daily.today_entered, 0)::int AS today_entered,
         COALESCE(daily.profile_synced, 0)::int AS profile_synced
       FROM days
       LEFT JOIN daily ON daily.date = days.date
       ORDER BY days.date ASC`,
      [normalizedDays, onboardingEvents],
    ),
    pool.query(
      `SELECT
         COALESCE(NULLIF(properties->>'goal', ''), '未选择') AS goal,
         COALESCE(NULLIF(properties->>'level', ''), 'unknown') AS level,
         COALESCE(NULLIF(properties->>'auth_state', ''), 'unknown') AS auth_state,
         COUNT(*)::int AS completions,
         COUNT(DISTINCT COALESCE('u:' || user_id::text, 'v:' || NULLIF(properties->>'visitor_id', ''), 'e:' || id::text))::int AS users
       FROM events
       WHERE event_name = 'onboarding_completed'
         AND event_time >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY goal, level, auth_state
       ORDER BY completions DESC, users DESC
       LIMIT 12`,
      [normalizedDays],
    ),
    pool.query(
      `WITH auth_events AS (
         SELECT
           id,
           user_id,
           event_name,
           properties,
           COALESCE(NULLIF(properties->>'auth_source', ''), 'unknown') AS source,
           NULLIF(properties->>'visitor_id', '') AS visitor_id
         FROM events
         WHERE event_name IN ('register_success', 'login_success', 'guest_login_success')
           AND event_time >= NOW() - ($1::int * INTERVAL '1 day')
           AND (
             COALESCE(properties->>'auth_source', '') IN (
               'save_plan',
               'save_plan_login',
               'guest_auth_cta',
               'today_guest',
               'topbar_login',
               'login_cta'
             )
             OR COALESCE(properties->>'auth_next', '') LIKE '%from=save_plan%'
             OR COALESCE(properties->>'auth_next', '') LIKE '%from=guest_auth_cta%'
           )
       ),
       onboarding_completed AS (
         SELECT DISTINCT NULLIF(properties->>'visitor_id', '') AS visitor_id
         FROM events
         WHERE event_name = 'onboarding_completed'
           AND event_time >= NOW() - ($1::int * INTERVAL '1 day')
           AND NULLIF(properties->>'visitor_id', '') IS NOT NULL
       )
       SELECT
         ae.source,
         ae.event_name,
         COUNT(*)::int AS events,
         COUNT(DISTINCT COALESCE(
           'u:' || ae.user_id::text,
           'v:' || ae.visitor_id,
           'e:' || ae.id::text
         ))::int AS users,
         (COUNT(DISTINCT ae.visitor_id) FILTER (WHERE oc.visitor_id IS NOT NULL))::int AS linked_onboarding_users
       FROM auth_events ae
       LEFT JOIN onboarding_completed oc ON oc.visitor_id = ae.visitor_id
       GROUP BY ae.source, ae.event_name
       ORDER BY events DESC, users DESC
       LIMIT 12`,
      [normalizedDays],
    ),
  ]);

  return {
    days: normalizedDays,
    steps: buildFunnelSteps(stepsResult.rows),
    daily: dailyResult.rows,
    segments: segmentsResult.rows,
    auth_sources: authSourceResult.rows,
  };
}

// Pricing checkout funnel (pricing page -> checkout -> paid return)
async function getPricingFunnelStats({ days = 30 } = {}) {
  await init();
  const normalizedDays = normalizeAnalyticsDays(days, 30, 365);

  const emptySteps = buildFunnelSteps([
    { key: 'page_view', label: '访问定价页', events: 0, users: 0 },
    { key: 'upgrade_click', label: '点击升级', events: 0, users: 0 },
    { key: 'checkout_started', label: '开始 checkout', events: 0, users: 0 },
    { key: 'checkout_redirect', label: '跳转支付页', events: 0, users: 0 },
    { key: 'success_view', label: '支付成功回访', events: 0, users: 0 },
    { key: 'entitlement_active', label: '权益确认生效', events: 0, users: 0 },
  ]);

  const emptyOutcomes = [
    { key: 'auth_required', label: '未登录拦截', events: 0, users: 0, rate_from_start: 0 },
    { key: 'cancelled_view', label: '取消回访', events: 0, users: 0, rate_from_start: 0 },
    { key: 'checkout_error', label: 'checkout 错误', events: 0, users: 0, rate_from_start: 0 },
    { key: 'entitlement_pending', label: '权益同步中', events: 0, users: 0, rate_from_start: 0 },
    { key: 'entitlement_error', label: '权益确认异常', events: 0, users: 0, rate_from_start: 0 },
  ];

  if (dbUnavailable()) {
    return {
      days: normalizedDays,
      steps: emptySteps,
      outcomes: emptyOutcomes,
      daily: [],
      sources: [],
    };
  }

  const pricingEvents = [
    'pricing_page_view',
    'pricing_billing_toggle',
    'pricing_upgrade_click',
    'pricing_auth_required',
    'pricing_checkout_started',
    'pricing_checkout_error',
    'pricing_checkout_redirect',
    'pricing_success_view',
    'pricing_cancelled_view',
    'pricing_subscription_status_active',
    'pricing_subscription_status_pending',
    'pricing_subscription_status_error',
  ];

  const [stepsResult, outcomesResult, dailyResult, sourcesResult] = await Promise.all([
    pool.query(
      `WITH windowed AS (
         SELECT
           id,
           event_name,
           user_id,
           NULLIF(properties->>'visitor_id', '') AS visitor_id,
           COALESCE(
             'u:' || user_id::text,
             'v:' || NULLIF(properties->>'visitor_id', ''),
             'e:' || id::text
           ) AS subject_key
         FROM events
         WHERE event_time >= NOW() - ($1::int * INTERVAL '1 day')
           AND event_name = ANY($2::text[])
       ),
       step_defs AS (
         SELECT * FROM (VALUES
           ('page_view', '访问定价页', 1),
           ('upgrade_click', '点击升级', 2),
           ('checkout_started', '开始 checkout', 3),
           ('checkout_redirect', '跳转支付页', 4),
           ('success_view', '支付成功回访', 5),
           ('entitlement_active', '权益确认生效', 6)
         ) AS s(key, label, sort_order)
       ),
       step_events AS (
         SELECT
           CASE event_name
             WHEN 'pricing_page_view' THEN 'page_view'
             WHEN 'pricing_upgrade_click' THEN 'upgrade_click'
             WHEN 'pricing_checkout_started' THEN 'checkout_started'
             WHEN 'pricing_checkout_redirect' THEN 'checkout_redirect'
             WHEN 'pricing_success_view' THEN 'success_view'
             WHEN 'pricing_subscription_status_active' THEN 'entitlement_active'
             ELSE NULL
           END AS key,
           user_id,
           visitor_id,
           subject_key
         FROM windowed
       )
       SELECT
         sd.key,
         sd.label,
         COUNT(se.key)::int AS events,
         COUNT(DISTINCT se.subject_key)::int AS users,
         COUNT(DISTINCT se.user_id)::int AS registered_users,
         COUNT(DISTINCT se.visitor_id)::int AS visitors
       FROM step_defs sd
       LEFT JOIN step_events se ON se.key = sd.key
       GROUP BY sd.key, sd.label, sd.sort_order
       ORDER BY sd.sort_order`,
      [normalizedDays, pricingEvents],
    ),
    pool.query(
      `WITH windowed AS (
         SELECT
           id,
           event_name,
           user_id,
           NULLIF(properties->>'visitor_id', '') AS visitor_id,
           COALESCE(
             'u:' || user_id::text,
             'v:' || NULLIF(properties->>'visitor_id', ''),
             'e:' || id::text
           ) AS subject_key
         FROM events
         WHERE event_time >= NOW() - ($1::int * INTERVAL '1 day')
           AND event_name = ANY($2::text[])
       ),
       outcome_defs AS (
         SELECT * FROM (VALUES
           ('auth_required', '未登录拦截', 1),
           ('cancelled_view', '取消回访', 2),
           ('checkout_error', 'checkout 错误', 3),
           ('entitlement_pending', '权益同步中', 4),
           ('entitlement_error', '权益确认异常', 5)
         ) AS s(key, label, sort_order)
       ),
       outcome_events AS (
         SELECT
           CASE event_name
             WHEN 'pricing_auth_required' THEN 'auth_required'
             WHEN 'pricing_cancelled_view' THEN 'cancelled_view'
             WHEN 'pricing_checkout_error' THEN 'checkout_error'
             WHEN 'pricing_subscription_status_pending' THEN 'entitlement_pending'
             WHEN 'pricing_subscription_status_error' THEN 'entitlement_error'
             ELSE NULL
           END AS key,
           user_id,
           visitor_id,
           subject_key
         FROM windowed
       )
       SELECT
         od.key,
         od.label,
         COUNT(oe.key)::int AS events,
         COUNT(DISTINCT oe.subject_key)::int AS users,
         COUNT(DISTINCT oe.user_id)::int AS registered_users,
         COUNT(DISTINCT oe.visitor_id)::int AS visitors
       FROM outcome_defs od
       LEFT JOIN outcome_events oe ON oe.key = od.key
       GROUP BY od.key, od.label, od.sort_order
       ORDER BY od.sort_order`,
      [normalizedDays, pricingEvents],
    ),
    pool.query(
      `WITH days AS (
         SELECT generate_series(
           (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::date,
           CURRENT_DATE,
           '1 day'::interval
         )::date AS date
       ),
       daily AS (
         WITH event_subjects AS (
           SELECT
             event_time,
             event_name,
             COALESCE(
               'u:' || user_id::text,
               'v:' || NULLIF(properties->>'visitor_id', ''),
               'e:' || id::text
             ) AS subject_key
           FROM events
           WHERE event_time >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
             AND event_name = ANY($2::text[])
         )
         SELECT
           DATE(event_time) AS date,
           COUNT(*) FILTER (WHERE event_name = 'pricing_page_view')::int AS page_views,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_page_view')::int AS page_view_users,
           COUNT(*) FILTER (WHERE event_name = 'pricing_upgrade_click')::int AS upgrade_clicks,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_upgrade_click')::int AS upgrade_users,
           COUNT(*) FILTER (WHERE event_name = 'pricing_auth_required')::int AS auth_required,
           COUNT(*) FILTER (WHERE event_name = 'pricing_checkout_started')::int AS checkout_started,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_checkout_started')::int AS checkout_users,
           COUNT(*) FILTER (WHERE event_name = 'pricing_checkout_redirect')::int AS checkout_redirects,
           COUNT(*) FILTER (WHERE event_name = 'pricing_success_view')::int AS success_views,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_success_view')::int AS success_users,
           COUNT(*) FILTER (WHERE event_name = 'pricing_cancelled_view')::int AS cancelled_views,
           COUNT(*) FILTER (WHERE event_name = 'pricing_checkout_error')::int AS checkout_errors,
           COUNT(*) FILTER (WHERE event_name = 'pricing_subscription_status_active')::int AS entitlement_active,
           COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_subscription_status_active')::int AS entitlement_active_users,
           COUNT(*) FILTER (WHERE event_name = 'pricing_subscription_status_pending')::int AS entitlement_pending,
           COUNT(*) FILTER (WHERE event_name = 'pricing_subscription_status_error')::int AS entitlement_errors
         FROM event_subjects
         GROUP BY DATE(event_time)
       )
       SELECT
         d.date::text AS date,
         COALESCE(daily.page_views, 0)::int AS page_views,
         COALESCE(daily.page_view_users, 0)::int AS page_view_users,
         COALESCE(daily.upgrade_clicks, 0)::int AS upgrade_clicks,
         COALESCE(daily.upgrade_users, 0)::int AS upgrade_users,
         COALESCE(daily.auth_required, 0)::int AS auth_required,
         COALESCE(daily.checkout_started, 0)::int AS checkout_started,
         COALESCE(daily.checkout_users, 0)::int AS checkout_users,
         COALESCE(daily.checkout_redirects, 0)::int AS checkout_redirects,
         COALESCE(daily.success_views, 0)::int AS success_views,
         COALESCE(daily.success_users, 0)::int AS success_users,
         COALESCE(daily.cancelled_views, 0)::int AS cancelled_views,
         COALESCE(daily.checkout_errors, 0)::int AS checkout_errors,
         COALESCE(daily.entitlement_active, 0)::int AS entitlement_active,
         COALESCE(daily.entitlement_active_users, 0)::int AS entitlement_active_users,
         COALESCE(daily.entitlement_pending, 0)::int AS entitlement_pending,
         COALESCE(daily.entitlement_errors, 0)::int AS entitlement_errors
       FROM days d
       LEFT JOIN daily ON daily.date = d.date
       ORDER BY d.date ASC`,
      [normalizedDays, pricingEvents],
    ),
    pool.query(
       `WITH source_events AS (
         SELECT
           id,
           event_name,
           user_id,
           COALESCE(NULLIF(properties->>'source', ''), 'direct') AS pricing_source,
           COALESCE(NULLIF(properties->>'intent', ''), '-') AS pricing_intent,
           COALESCE(
             'u:' || user_id::text,
             'v:' || NULLIF(properties->>'visitor_id', ''),
             'e:' || id::text
           ) AS subject_key
         FROM events
         WHERE event_time >= NOW() - ($1::int * INTERVAL '1 day')
           AND event_name = ANY($2::text[])
       )
       SELECT
         pricing_source AS source,
         pricing_intent AS intent,
         COUNT(*) FILTER (WHERE event_name = 'pricing_page_view')::int AS page_views,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_page_view')::int AS page_view_users,
         COUNT(*) FILTER (WHERE event_name = 'pricing_upgrade_click')::int AS upgrade_clicks,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_upgrade_click')::int AS upgrade_users,
         COUNT(*) FILTER (WHERE event_name = 'pricing_checkout_started')::int AS checkout_started,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_checkout_started')::int AS checkout_users,
         COUNT(*) FILTER (WHERE event_name = 'pricing_checkout_redirect')::int AS checkout_redirects,
         COUNT(*) FILTER (WHERE event_name = 'pricing_success_view')::int AS success_views,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_success_view')::int AS success_users,
         COUNT(*) FILTER (WHERE event_name = 'pricing_cancelled_view')::int AS cancelled_views,
         COUNT(*) FILTER (WHERE event_name = 'pricing_checkout_error')::int AS checkout_errors,
         COUNT(*) FILTER (WHERE event_name = 'pricing_subscription_status_active')::int AS entitlement_active,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'pricing_subscription_status_active')::int AS entitlement_active_users,
         COUNT(*) FILTER (WHERE event_name = 'pricing_subscription_status_pending')::int AS entitlement_pending,
         COUNT(*) FILTER (WHERE event_name = 'pricing_subscription_status_error')::int AS entitlement_errors
       FROM source_events
       GROUP BY pricing_source, pricing_intent
       ORDER BY page_views DESC, upgrade_clicks DESC, checkout_started DESC
       LIMIT 12`,
      [normalizedDays, pricingEvents],
    ),
  ]);

  const steps = buildFunnelSteps(stepsResult.rows).map((row) => ({
    ...row,
    registered_users: Number(row.registered_users) || 0,
    visitors: Number(row.visitors) || 0,
  }));
  const pageViews = steps.find(step => step.key === 'page_view')?.events || 0;
  const pageViewUsers = steps.find(step => step.key === 'page_view')?.users || 0;
  const outcomes = outcomesResult.rows.map((row) => ({
    ...row,
    events: Number(row.events) || 0,
    users: Number(row.users) || 0,
    registered_users: Number(row.registered_users) || 0,
    visitors: Number(row.visitors) || 0,
    rate_from_start: percent(row.events, pageViews),
    user_rate_from_start: percent(row.users, pageViewUsers),
  }));

  const sources = sourcesResult.rows.map((row) => ({
    ...row,
    page_views: Number(row.page_views) || 0,
    page_view_users: Number(row.page_view_users) || 0,
    upgrade_clicks: Number(row.upgrade_clicks) || 0,
    upgrade_users: Number(row.upgrade_users) || 0,
    checkout_started: Number(row.checkout_started) || 0,
    checkout_users: Number(row.checkout_users) || 0,
    checkout_redirects: Number(row.checkout_redirects) || 0,
    success_views: Number(row.success_views) || 0,
    success_users: Number(row.success_users) || 0,
    cancelled_views: Number(row.cancelled_views) || 0,
    checkout_errors: Number(row.checkout_errors) || 0,
    entitlement_active: Number(row.entitlement_active) || 0,
    entitlement_active_users: Number(row.entitlement_active_users) || 0,
    entitlement_pending: Number(row.entitlement_pending) || 0,
    entitlement_errors: Number(row.entitlement_errors) || 0,
    upgrade_rate: percent(row.upgrade_clicks, row.page_views),
    checkout_rate: percent(row.checkout_started, row.upgrade_clicks),
    success_rate: percent(row.success_views, row.checkout_started),
    user_upgrade_rate: percent(row.upgrade_users, row.page_view_users),
    user_checkout_rate: percent(row.checkout_users, row.upgrade_users),
    user_success_rate: percent(row.success_users, row.checkout_users),
    entitlement_active_rate: percent(row.entitlement_active, row.success_views),
    user_entitlement_active_rate: percent(row.entitlement_active_users, row.success_users),
  }));

  return {
    days: normalizedDays,
    steps,
    outcomes,
    daily: dailyResult.rows,
    sources,
  };
}

// Today workspace retention and streak health
async function getTodayRetentionSummary({ days = 30 } = {}) {
  await init();
  const normalizedDays = normalizeAnalyticsDays(days, 30, 180);
  const empty = {
    days: normalizedDays,
    summary: {
      training_users: 0,
      active_user_days: 0,
      returning_users: 0,
      returning_rate: 0,
      d1_base_user_days: 0,
      d1_retained_user_days: 0,
      d1_retention_rate: 0,
      full_loop_users: 0,
      full_loop_rate: 0,
      current_streak_users: 0,
      avg_current_streak: 0,
      longest_current_streak: 0,
    },
    daily: [],
    streaks: [],
  };

  if (dbUnavailable()) return empty;

  const [dailyResult, userDayResult] = await Promise.all([
    pool.query(
      `WITH days AS (
         SELECT generate_series(
           (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::date,
           CURRENT_DATE,
           '1 day'::interval
         )::date AS date
       ),
       today_user_days AS (
         SELECT
           user_id,
           event_time::date AS date,
           COALESCE(SUM(
             CASE
               WHEN event_name = 'video_watch'
                 AND properties->>'from' IN ('today', 'today_first_lesson')
                 AND COALESCE(properties->>'seconds', '') ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN (properties->>'seconds')::numeric
               ELSE 0
             END
           ), 0)::int AS video_seconds,
           COALESCE(SUM(
             CASE
               WHEN event_name = 'vocab_study'
                 AND properties->>'from' IN ('today', 'today_first_lesson')
                 AND COALESCE(properties->>'seconds', '') ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN (properties->>'seconds')::numeric
               ELSE 0
             END
           ), 0)::int AS vocab_seconds,
           COUNT(*) FILTER (
             WHERE event_name IN ('practice_first_lesson_complete', 'today_practice_completed')
               AND COALESCE(properties->>'from', 'today') IN ('today', 'today_first_lesson')
           )::int AS practice_sessions
         FROM events
         WHERE user_id IS NOT NULL
           AND event_time >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
           AND event_time < CURRENT_DATE + INTERVAL '1 day'
          AND event_name IN ('video_watch', 'vocab_study', 'practice_first_lesson_complete', 'today_practice_completed')
         GROUP BY user_id, event_time::date
         HAVING
           COALESCE(SUM(
             CASE
               WHEN event_name = 'video_watch'
                 AND properties->>'from' IN ('today', 'today_first_lesson')
                 AND COALESCE(properties->>'seconds', '') ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN (properties->>'seconds')::numeric
               ELSE 0
             END
           ), 0) > 0
           OR COALESCE(SUM(
             CASE
               WHEN event_name = 'vocab_study'
                 AND properties->>'from' IN ('today', 'today_first_lesson')
                 AND COALESCE(properties->>'seconds', '') ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN (properties->>'seconds')::numeric
               ELSE 0
             END
           ), 0) > 0
           OR COUNT(*) FILTER (
             WHERE event_name IN ('practice_first_lesson_complete', 'today_practice_completed')
               AND COALESCE(properties->>'from', 'today') IN ('today', 'today_first_lesson')
           ) > 0
       )
       SELECT
         d.date::text AS date,
         COUNT(tud.user_id)::int AS active_users,
         COUNT(*) FILTER (WHERE tud.video_seconds >= 60)::int AS video_users,
         COUNT(*) FILTER (WHERE tud.practice_sessions > 0)::int AS practice_users,
         COUNT(*) FILTER (WHERE tud.vocab_seconds >= 30)::int AS review_users,
         COUNT(*) FILTER (
           WHERE tud.video_seconds >= 60
             AND tud.practice_sessions > 0
             AND tud.vocab_seconds >= 30
         )::int AS full_loop_users,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1
             FROM today_user_days next_day
             WHERE next_day.user_id = tud.user_id
               AND next_day.date = tud.date + 1
           )
         )::int AS retained_next_day_users
       FROM days d
       LEFT JOIN today_user_days tud ON tud.date = d.date
       GROUP BY d.date
       ORDER BY d.date ASC`,
      [normalizedDays],
    ),
    pool.query(
      `WITH today_user_days AS (
         SELECT
           user_id,
           event_time::date AS date,
           COALESCE(SUM(
             CASE
               WHEN event_name = 'video_watch'
                 AND properties->>'from' IN ('today', 'today_first_lesson')
                 AND COALESCE(properties->>'seconds', '') ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN (properties->>'seconds')::numeric
               ELSE 0
             END
           ), 0)::int AS video_seconds,
           COALESCE(SUM(
             CASE
               WHEN event_name = 'vocab_study'
                 AND properties->>'from' IN ('today', 'today_first_lesson')
                 AND COALESCE(properties->>'seconds', '') ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN (properties->>'seconds')::numeric
               ELSE 0
             END
           ), 0)::int AS vocab_seconds,
           COUNT(*) FILTER (
             WHERE event_name IN ('practice_first_lesson_complete', 'today_practice_completed')
               AND COALESCE(properties->>'from', 'today') IN ('today', 'today_first_lesson')
           )::int AS practice_sessions
         FROM events
         WHERE user_id IS NOT NULL
           AND event_time >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
           AND event_time < CURRENT_DATE + INTERVAL '1 day'
          AND event_name IN ('video_watch', 'vocab_study', 'practice_first_lesson_complete', 'today_practice_completed')
         GROUP BY user_id, event_time::date
       )
       SELECT
         user_id,
         date::text AS date,
         video_seconds,
         vocab_seconds,
         practice_sessions,
         (video_seconds >= 60 AND practice_sessions > 0 AND vocab_seconds >= 30) AS full_loop
       FROM today_user_days
       WHERE video_seconds > 0 OR vocab_seconds > 0 OR practice_sessions > 0
       ORDER BY user_id ASC, date ASC`,
      [normalizedDays],
    ),
  ]);

  const daily = dailyResult.rows.map((row) => ({
    date: analyticsDateKey(row.date),
    active_users: Number(row.active_users) || 0,
    video_users: Number(row.video_users) || 0,
    practice_users: Number(row.practice_users) || 0,
    review_users: Number(row.review_users) || 0,
    full_loop_users: Number(row.full_loop_users) || 0,
    retained_next_day_users: Number(row.retained_next_day_users) || 0,
  }));

  const userRows = userDayResult.rows.map((row) => ({
    userId: String(row.user_id),
    date: analyticsDateKey(row.date),
    fullLoop: !!row.full_loop,
  })).filter(row => row.date);
  const datesByUser = new Map();
  const fullLoopUsers = new Set();
  userRows.forEach((row) => {
    if (!datesByUser.has(row.userId)) datesByUser.set(row.userId, new Set());
    datesByUser.get(row.userId).add(row.date);
    if (row.fullLoop) fullLoopUsers.add(row.userId);
  });

  const endDate = daily[daily.length - 1]?.date || analyticsDateKey(new Date());
  const today = endDate;
  const yesterday = shiftAnalyticsDateKey(today, -1);
  const streaks = [];
  datesByUser.forEach((dateSet, userId) => {
    const anchor = dateSet.has(today) ? today : yesterday;
    let currentStreak = 0;
    let cursor = anchor;
    while (dateSet.has(cursor)) {
      currentStreak += 1;
      cursor = shiftAnalyticsDateKey(cursor, -1);
    }
    if (currentStreak > 0) {
      streaks.push({ user_id: userId, current_streak: currentStreak });
    }
  });

  const trainingUsers = datesByUser.size;
  const activeUserDays = userRows.length;
  const returningUsers = Array.from(datesByUser.values()).filter(dateSet => dateSet.size >= 2).length;
  const d1BaseUserDays = daily.slice(0, -1).reduce((sum, day) => sum + day.active_users, 0);
  const d1RetainedUserDays = daily.slice(0, -1).reduce((sum, day) => sum + day.retained_next_day_users, 0);
  const currentStreakUsers = streaks.filter(item => item.current_streak >= 2).length;
  const totalCurrentStreak = streaks.reduce((sum, item) => sum + item.current_streak, 0);
  const longestCurrentStreak = streaks.reduce((max, item) => Math.max(max, item.current_streak), 0);

  return {
    days: normalizedDays,
    summary: {
      training_users: trainingUsers,
      active_user_days: activeUserDays,
      returning_users: returningUsers,
      returning_rate: percent(returningUsers, trainingUsers),
      d1_base_user_days: d1BaseUserDays,
      d1_retained_user_days: d1RetainedUserDays,
      d1_retention_rate: percent(d1RetainedUserDays, d1BaseUserDays),
      full_loop_users: fullLoopUsers.size,
      full_loop_rate: percent(fullLoopUsers.size, trainingUsers),
      current_streak_users: currentStreakUsers,
      avg_current_streak: streaks.length ? Math.round((totalCurrentStreak / streaks.length) * 10) / 10 : 0,
      longest_current_streak: longestCurrentStreak,
    },
    daily,
    streaks: streaks.sort((a, b) => b.current_streak - a.current_streak).slice(0, 20),
  };
}

// Learning report sharing and reactivation growth funnel
async function getLearningReportGrowthStats({ days = 30 } = {}) {
  await init();
  const normalizedDays = normalizeAnalyticsDays(days, 30, 180);
  const emptySteps = buildFunnelSteps([
    { key: 'report_view', label: '查看周报', events: 0, users: 0 },
    { key: 'share_action', label: '分享/复制', events: 0, users: 0 },
    { key: 'next_commitment', label: '设置下次训练', events: 0, users: 0 },
    { key: 'pricing_click', label: '点击会员方案', events: 0, users: 0 },
    { key: 'today_click', label: '回到训练', events: 0, users: 0 },
  ]);

  if (dbUnavailable()) {
    return {
      days: normalizedDays,
      steps: emptySteps,
      daily: [],
      actions: [],
    };
  }

  const reportEvents = [
    'learning_report_view',
    'learning_report_shared',
    'learning_report_share_summary_copied',
    'learning_report_invite_link_copied',
    'learning_report_commitment_saved',
    'learning_report_calendar_downloaded',
  ];

  const [stepsResult, dailyResult, actionsResult] = await Promise.all([
    pool.query(
      `WITH windowed AS (
         SELECT
           id,
           user_id,
           event_name,
           properties,
           event_time,
           COALESCE(
             'u:' || user_id::text,
             'v:' || NULLIF(properties->>'visitor_id', ''),
             'e:' || id::text
           ) AS subject_key
         FROM events
         WHERE event_time >= NOW() - ($1::int * INTERVAL '1 day')
           AND (
             event_name = ANY($2::text[])
             OR (event_name = 'click' AND properties->>'page' = 'learning-reports')
           )
       ),
       step_defs AS (
         SELECT * FROM (VALUES
           ('report_view', '查看周报', 1),
           ('share_action', '分享/复制', 2),
           ('next_commitment', '设置下次训练', 3),
           ('pricing_click', '点击会员方案', 4),
           ('today_click', '回到训练', 5)
         ) AS s(key, label, sort_order)
       ),
       step_events AS (
         SELECT 'report_view' AS key, subject_key
         FROM windowed
         WHERE event_name = 'learning_report_view'
         UNION ALL
         SELECT 'share_action' AS key, subject_key
         FROM windowed
         WHERE event_name IN (
           'learning_report_shared',
           'learning_report_share_summary_copied',
           'learning_report_invite_link_copied'
         )
         UNION ALL
         SELECT 'next_commitment' AS key, subject_key
         FROM windowed
         WHERE event_name IN ('learning_report_commitment_saved', 'learning_report_calendar_downloaded')
         UNION ALL
         SELECT 'pricing_click' AS key, subject_key
         FROM windowed
         WHERE event_name = 'click'
           AND properties->>'name' IN ('report_upgrade_pricing', 'share_pricing_link', 'nav_pricing')
         UNION ALL
         SELECT 'today_click' AS key, subject_key
         FROM windowed
         WHERE event_name = 'click'
           AND properties->>'name' IN ('primary_today', 'commitment_start_now', 'practice_from_report', 'review_words', 'back_today')
       )
       SELECT
         sd.key,
         sd.label,
         COUNT(se.key)::int AS events,
         COUNT(DISTINCT se.subject_key)::int AS users
       FROM step_defs sd
       LEFT JOIN step_events se ON se.key = sd.key
       GROUP BY sd.key, sd.label, sd.sort_order
       ORDER BY sd.sort_order`,
      [normalizedDays, reportEvents],
    ),
    pool.query(
      `WITH days AS (
         SELECT generate_series(
           (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::date,
           CURRENT_DATE,
           '1 day'::interval
         )::date AS date
       ),
       daily AS (
         SELECT
           DATE(event_time) AS date,
           COUNT(*) FILTER (WHERE event_name = 'learning_report_view')::int AS report_views,
           COUNT(*) FILTER (
             WHERE event_name IN (
               'learning_report_shared',
               'learning_report_share_summary_copied',
               'learning_report_invite_link_copied'
             )
           )::int AS share_actions,
           COUNT(*) FILTER (
             WHERE event_name IN ('learning_report_commitment_saved', 'learning_report_calendar_downloaded')
           )::int AS next_commitments,
           COUNT(*) FILTER (
             WHERE event_name = 'click'
               AND properties->>'page' = 'learning-reports'
               AND properties->>'name' IN ('report_upgrade_pricing', 'share_pricing_link', 'nav_pricing')
           )::int AS pricing_clicks,
           COUNT(*) FILTER (
             WHERE event_name = 'click'
               AND properties->>'page' = 'learning-reports'
               AND properties->>'name' IN ('primary_today', 'commitment_start_now', 'practice_from_report', 'review_words', 'back_today')
           )::int AS today_clicks
         FROM events
         WHERE event_time >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
           AND (
             event_name = ANY($2::text[])
             OR (event_name = 'click' AND properties->>'page' = 'learning-reports')
           )
         GROUP BY DATE(event_time)
       )
       SELECT
         days.date::text AS date,
         COALESCE(daily.report_views, 0)::int AS report_views,
         COALESCE(daily.share_actions, 0)::int AS share_actions,
         COALESCE(daily.next_commitments, 0)::int AS next_commitments,
         COALESCE(daily.pricing_clicks, 0)::int AS pricing_clicks,
         COALESCE(daily.today_clicks, 0)::int AS today_clicks
       FROM days
       LEFT JOIN daily ON daily.date = days.date
       ORDER BY days.date ASC`,
      [normalizedDays, reportEvents],
    ),
    pool.query(
      `SELECT
         CASE
           WHEN event_name = 'click' THEN COALESCE(NULLIF(properties->>'name', ''), 'click')
           ELSE event_name
         END AS action,
         COALESCE(NULLIF(properties->>'share_channel', ''), NULLIF(properties->>'href', ''), '-') AS detail,
         COUNT(*)::int AS events,
         COUNT(DISTINCT COALESCE('u:' || user_id::text, 'v:' || NULLIF(properties->>'visitor_id', ''), 'e:' || id::text))::int AS users
       FROM events
       WHERE event_time >= NOW() - ($1::int * INTERVAL '1 day')
         AND (
           event_name = ANY($2::text[])
           OR (event_name = 'click' AND properties->>'page' = 'learning-reports')
         )
       GROUP BY action, detail
       ORDER BY events DESC, users DESC
       LIMIT 12`,
      [normalizedDays, reportEvents],
    ),
  ]);

  return {
    days: normalizedDays,
    steps: buildFunnelSteps(stepsResult.rows),
    daily: dailyResult.rows,
    actions: actionsResult.rows,
  };
}

// A/B test exposure summary
async function getABTestSummary({ days = 30, testKey } = {}) {
  await init();
  if (dbUnavailable()) return [];
  if (!testKey) return [];

  const { rows } = await pool.query(
    `SELECT
       COALESCE(e.properties->>'variant', 'unknown') AS variant,
       COUNT(*)::int AS exposures,
       COUNT(DISTINCT e.user_id)::int AS users
     FROM events e
     WHERE e.event_name = 'ab_exposure'
       AND e.properties->>'test' = $1
       AND e.event_time >= NOW() - INTERVAL '${Number(days) || 30} days'
     GROUP BY variant
     ORDER BY variant ASC`,
    [testKey]
  );

  return rows;
}

async function getAiUsageSummary({ days = 7, topLimit = 10 } = {}) {
  await init();

  const normalizedDays = normalizeAnalyticsDays(days, 7, 365);
  const normalizedTopLimit = Math.min(Math.max(Number(topLimit) || 10, 1), 50);
  const deepWordEstimateCents = parseEstimatedCostCents('AI_DEEP_WORD_ESTIMATED_COST_CENTS', 0);
  const pronunciationEstimateCents = parseEstimatedCostCents('AI_PRONUNCIATION_ESTIMATED_COST_CENTS', 0);

  const emptyUsage = {
    ai_score_requests: 0,
    ai_score_done_events: 0,
    ai_score_rows: 0,
    word_deep_generations: 0,
    pronunciation_assessments: 0,
    quota_limit_reached: 0,
    active_ai_users: 0,
  };

  if (dbUnavailable()) {
    return {
      days: normalizedDays,
      usage: { ...emptyUsage, total_ai_calls: 0 },
      today: { ...emptyUsage, total_ai_calls: 0 },
      costs: {
        ai_score_cost_cents: 0,
        deep_word_estimated_cost_cents: 0,
        pronunciation_estimated_cost_cents: 0,
        estimated_total_cost_cents: 0,
        unpriced_calls: 0,
      },
      assumptions: {
        deep_word_estimated_cost_cents: deepWordEstimateCents,
        pronunciation_estimated_cost_cents: pronunciationEstimateCents,
      },
      daily: [],
      top_users: [],
      quota_breakdown: [],
    };
  }

  const [summaryResult, dailyResult, topUsersResult, quotaBreakdownResult] = await Promise.all([
    pool.query(
      `WITH event_counts AS (
         SELECT
           COUNT(*) FILTER (WHERE event_name = 'ai_score_requested')::int AS ai_score_requests,
           COUNT(*) FILTER (WHERE event_name = 'ai_score_done')::int AS ai_score_done_events,
           COUNT(*) FILTER (WHERE event_name = 'word_deep_generated')::int AS word_deep_generations,
           COUNT(*) FILTER (WHERE event_name = 'quota_limit_reached')::int AS quota_limit_reached
         FROM events
         WHERE event_name IN ('ai_score_requested', 'ai_score_done', 'word_deep_generated', 'quota_limit_reached')
           AND event_time >= NOW() - ($1::int * INTERVAL '1 day')
       ),
       today_event_counts AS (
         SELECT
           COUNT(*) FILTER (WHERE event_name = 'ai_score_requested')::int AS ai_score_requests,
           COUNT(*) FILTER (WHERE event_name = 'ai_score_done')::int AS ai_score_done_events,
           COUNT(*) FILTER (WHERE event_name = 'word_deep_generated')::int AS word_deep_generations,
           COUNT(*) FILTER (WHERE event_name = 'quota_limit_reached')::int AS quota_limit_reached
         FROM events
         WHERE event_name IN ('ai_score_requested', 'ai_score_done', 'word_deep_generated', 'quota_limit_reached')
           AND event_time >= date_trunc('day', NOW())
       ),
       score_costs AS (
         SELECT
           COUNT(*)::int AS ai_score_rows,
           COALESCE(SUM(cost_cents), 0)::int AS ai_score_cost_cents
         FROM ai_scores
         WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       ),
       today_score_costs AS (
         SELECT
           COUNT(*)::int AS ai_score_rows,
           COALESCE(SUM(cost_cents), 0)::int AS ai_score_cost_cents
         FROM ai_scores
         WHERE created_at >= date_trunc('day', NOW())
       ),
       pronunciation_counts AS (
         SELECT
           COUNT(*)::int AS pronunciation_assessments
         FROM user_pronunciation_assessments
         WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       ),
       today_pronunciation_counts AS (
         SELECT
           COUNT(*)::int AS pronunciation_assessments
         FROM user_pronunciation_assessments
         WHERE created_at >= date_trunc('day', NOW())
       ),
       active_user_counts AS (
         SELECT COUNT(DISTINCT user_id)::int AS active_ai_users
         FROM (
           SELECT user_id
           FROM events
           WHERE event_name IN ('ai_score_requested', 'ai_score_done', 'word_deep_generated', 'quota_limit_reached')
             AND event_time >= NOW() - ($1::int * INTERVAL '1 day')
             AND user_id IS NOT NULL
           UNION ALL
           SELECT user_id
           FROM user_pronunciation_assessments
           WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
             AND user_id IS NOT NULL
         ) ai_users
       ),
       today_active_user_counts AS (
         SELECT COUNT(DISTINCT user_id)::int AS active_ai_users
         FROM (
           SELECT user_id
           FROM events
           WHERE event_name IN ('ai_score_requested', 'ai_score_done', 'word_deep_generated', 'quota_limit_reached')
             AND event_time >= date_trunc('day', NOW())
             AND user_id IS NOT NULL
           UNION ALL
           SELECT user_id
           FROM user_pronunciation_assessments
           WHERE created_at >= date_trunc('day', NOW())
             AND user_id IS NOT NULL
         ) ai_users
       )
       SELECT
         ec.ai_score_requests,
         ec.ai_score_done_events,
         ec.word_deep_generations,
         ec.quota_limit_reached,
         sc.ai_score_rows,
         sc.ai_score_cost_cents,
         pc.pronunciation_assessments,
         auc.active_ai_users,
         tec.ai_score_requests AS today_ai_score_requests,
         tec.ai_score_done_events AS today_ai_score_done_events,
         tec.word_deep_generations AS today_word_deep_generations,
         tec.quota_limit_reached AS today_quota_limit_reached,
         tsc.ai_score_rows AS today_ai_score_rows,
         tsc.ai_score_cost_cents AS today_ai_score_cost_cents,
         tpc.pronunciation_assessments AS today_pronunciation_assessments,
         tauc.active_ai_users AS today_active_ai_users
       FROM event_counts ec
       CROSS JOIN score_costs sc
       CROSS JOIN pronunciation_counts pc
       CROSS JOIN today_event_counts tec
       CROSS JOIN today_score_costs tsc
       CROSS JOIN today_pronunciation_counts tpc
       CROSS JOIN active_user_counts auc
       CROSS JOIN today_active_user_counts tauc`,
      [normalizedDays],
    ),
    pool.query(
      `WITH days AS (
         SELECT generate_series(
           (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::date,
           CURRENT_DATE,
           '1 day'::interval
         )::date AS date
       ),
       event_daily AS (
         SELECT
           DATE(event_time) AS date,
           COUNT(*) FILTER (WHERE event_name = 'ai_score_requested')::int AS ai_score_requests,
           COUNT(*) FILTER (WHERE event_name = 'ai_score_done')::int AS ai_score_done_events,
           COUNT(*) FILTER (WHERE event_name = 'word_deep_generated')::int AS word_deep_generations,
           COUNT(*) FILTER (WHERE event_name = 'quota_limit_reached')::int AS quota_limit_reached
         FROM events
         WHERE event_name IN ('ai_score_requested', 'ai_score_done', 'word_deep_generated', 'quota_limit_reached')
           AND event_time >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
         GROUP BY DATE(event_time)
       ),
       score_daily AS (
         SELECT
           DATE(created_at) AS date,
           COUNT(*)::int AS ai_score_rows,
           COALESCE(SUM(cost_cents), 0)::int AS ai_score_cost_cents
         FROM ai_scores
         WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
         GROUP BY DATE(created_at)
       ),
       pronunciation_daily AS (
         SELECT
           DATE(created_at) AS date,
           COUNT(*)::int AS pronunciation_assessments
         FROM user_pronunciation_assessments
         WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
         GROUP BY DATE(created_at)
       )
       SELECT
         d.date,
         COALESCE(ed.ai_score_requests, 0)::int AS ai_score_requests,
         COALESCE(ed.ai_score_done_events, 0)::int AS ai_score_done_events,
         COALESCE(sd.ai_score_rows, 0)::int AS ai_score_rows,
         COALESCE(ed.word_deep_generations, 0)::int AS word_deep_generations,
         COALESCE(ed.quota_limit_reached, 0)::int AS quota_limit_reached,
         COALESCE(pd.pronunciation_assessments, 0)::int AS pronunciation_assessments,
         COALESCE(sd.ai_score_cost_cents, 0)::int AS ai_score_cost_cents
       FROM days d
       LEFT JOIN event_daily ed ON ed.date = d.date
       LEFT JOIN score_daily sd ON sd.date = d.date
       LEFT JOIN pronunciation_daily pd ON pd.date = d.date
       ORDER BY d.date ASC`,
      [normalizedDays],
    ),
    pool.query(
      `WITH ai_events AS (
         SELECT
           user_id,
           COUNT(*) FILTER (WHERE event_name = 'ai_score_requested')::int AS ai_score_requests,
           COUNT(*) FILTER (WHERE event_name = 'ai_score_done')::int AS ai_score_done_events,
           COUNT(*) FILTER (WHERE event_name = 'word_deep_generated')::int AS word_deep_generations,
           COUNT(*) FILTER (WHERE event_name = 'quota_limit_reached')::int AS quota_limit_reached
         FROM events
         WHERE event_name IN ('ai_score_requested', 'ai_score_done', 'word_deep_generated', 'quota_limit_reached')
           AND event_time >= NOW() - ($1::int * INTERVAL '1 day')
           AND user_id IS NOT NULL
         GROUP BY user_id
       ),
       pronunciation_events AS (
         SELECT
           user_id,
           COUNT(*)::int AS pronunciation_assessments
         FROM user_pronunciation_assessments
         WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
           AND user_id IS NOT NULL
         GROUP BY user_id
       ),
       combined AS (
         SELECT
           COALESCE(a.user_id, p.user_id) AS user_id,
           COALESCE(a.ai_score_requests, 0)::int AS ai_score_requests,
           COALESCE(a.ai_score_done_events, 0)::int AS ai_score_done_events,
           COALESCE(a.word_deep_generations, 0)::int AS word_deep_generations,
           COALESCE(a.quota_limit_reached, 0)::int AS quota_limit_reached,
           COALESCE(p.pronunciation_assessments, 0)::int AS pronunciation_assessments
         FROM ai_events a
         FULL OUTER JOIN pronunciation_events p ON p.user_id = a.user_id
       )
       SELECT
         c.user_id,
         u.username,
         u.email,
         u.membership_type,
         c.ai_score_requests,
         c.ai_score_done_events,
         c.word_deep_generations,
         c.quota_limit_reached,
         c.pronunciation_assessments,
         (c.ai_score_requests + c.word_deep_generations + c.pronunciation_assessments)::int AS total_ai_calls
       FROM combined c
       LEFT JOIN users u ON u.id = c.user_id
       ORDER BY total_ai_calls DESC, c.ai_score_done_events DESC
       LIMIT $2`,
      [normalizedDays, normalizedTopLimit],
    ),
    pool.query(
      `SELECT
         COALESCE(NULLIF(properties->>'feature', ''), 'unknown') AS feature,
         COUNT(*)::int AS events,
         COUNT(DISTINCT user_id)::int AS users,
         COUNT(*) FILTER (WHERE event_time >= date_trunc('day', NOW()))::int AS today_events
       FROM events
       WHERE event_name = 'quota_limit_reached'
         AND event_time >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY COALESCE(NULLIF(properties->>'feature', ''), 'unknown')
       ORDER BY events DESC, feature ASC
       LIMIT 8`,
      [normalizedDays],
    ),
  ]);

  const row = summaryResult.rows[0] || {};
  const usage = {
    ai_score_requests: row.ai_score_requests || 0,
    ai_score_done_events: row.ai_score_done_events || 0,
    ai_score_rows: row.ai_score_rows || 0,
    word_deep_generations: row.word_deep_generations || 0,
    pronunciation_assessments: row.pronunciation_assessments || 0,
    quota_limit_reached: row.quota_limit_reached || 0,
    active_ai_users: row.active_ai_users || 0,
  };
  usage.total_ai_calls = usage.ai_score_requests + usage.word_deep_generations + usage.pronunciation_assessments;

  const today = {
    ai_score_requests: row.today_ai_score_requests || 0,
    ai_score_done_events: row.today_ai_score_done_events || 0,
    ai_score_rows: row.today_ai_score_rows || 0,
    word_deep_generations: row.today_word_deep_generations || 0,
    pronunciation_assessments: row.today_pronunciation_assessments || 0,
    quota_limit_reached: row.today_quota_limit_reached || 0,
    active_ai_users: row.today_active_ai_users || 0,
  };
  today.total_ai_calls = today.ai_score_requests + today.word_deep_generations + today.pronunciation_assessments;

  const costs = {
    ai_score_cost_cents: row.ai_score_cost_cents || 0,
    deep_word_estimated_cost_cents: usage.word_deep_generations * deepWordEstimateCents,
    pronunciation_estimated_cost_cents: usage.pronunciation_assessments * pronunciationEstimateCents,
    unpriced_calls: (deepWordEstimateCents > 0 ? 0 : usage.word_deep_generations)
      + (pronunciationEstimateCents > 0 ? 0 : usage.pronunciation_assessments),
  };
  costs.estimated_total_cost_cents = costs.ai_score_cost_cents
    + costs.deep_word_estimated_cost_cents
    + costs.pronunciation_estimated_cost_cents;

  const daily = dailyResult.rows.map((item) => {
    const wordDeepGenerations = item.word_deep_generations || 0;
    const pronunciationAssessments = item.pronunciation_assessments || 0;
    const aiScoreCostCents = item.ai_score_cost_cents || 0;
    return {
      ...item,
      total_ai_calls: (item.ai_score_requests || 0) + wordDeepGenerations + pronunciationAssessments,
      deep_word_estimated_cost_cents: wordDeepGenerations * deepWordEstimateCents,
      pronunciation_estimated_cost_cents: pronunciationAssessments * pronunciationEstimateCents,
      estimated_total_cost_cents: aiScoreCostCents
        + (wordDeepGenerations * deepWordEstimateCents)
        + (pronunciationAssessments * pronunciationEstimateCents),
    };
  });

  return {
    days: normalizedDays,
    usage,
    today,
    costs,
    assumptions: {
      deep_word_estimated_cost_cents: deepWordEstimateCents,
      pronunciation_estimated_cost_cents: pronunciationEstimateCents,
    },
    daily,
    top_users: topUsersResult.rows,
    quota_breakdown: quotaBreakdownResult.rows.map((item) => ({
      feature: item.feature || 'unknown',
      events: item.events || 0,
      users: item.users || 0,
      today_events: item.today_events || 0,
    })),
  };
}

// 游戏漏斗:game_view → level_start → level_complete → boss → 通章,
// 另带 learn/matching/spelling/quiz/boss 关内阶段完成情况。
// 事件由 game-app.js 经 POST /events 上报;subject_key 与其他漏斗一致
//(登录用户按 user_id,游客经 guest_visitor_links 归并)。
async function getGameFunnelStats({ days = 30 } = {}) {
  await init();
  const normalizedDays = normalizeAnalyticsDays(days, 30, 365);

  const emptySteps = buildFunnelSteps([
    { key: 'game_view', label: '打开游戏', events: 0, users: 0 },
    { key: 'level_start', label: '开始关卡', events: 0, users: 0 },
    { key: 'level_complete', label: '完成关卡', events: 0, users: 0 },
    { key: 'boss_start', label: '挑战 BOSS', events: 0, users: 0 },
    { key: 'chapter_pass', label: '通关章节', events: 0, users: 0 },
  ]);
  const emptyPhases = [
    { key: 'learn', label: '完成学词', events: 0, users: 0, rate_from_level_start: 0 },
    { key: 'matching', label: '完成连连看', events: 0, users: 0, rate_from_level_start: 0 },
    { key: 'spelling', label: '完成拼写', events: 0, users: 0, rate_from_level_start: 0 },
    { key: 'quiz', label: '完成速答', events: 0, users: 0, rate_from_level_start: 0 },
    { key: 'boss', label: '完成 BOSS', events: 0, users: 0, rate_from_level_start: 0 },
  ];

  if (dbUnavailable()) {
    return { days: normalizedDays, steps: emptySteps, phases: emptyPhases, daily: [], chapters: [] };
  }

  const [stepsResult, dailyResult, chaptersResult] = await Promise.all([
    pool.query(
      `WITH ${guestVisitorLinksSql()},
       windowed AS (
         SELECT e.id, e.event_name, e.properties,
                ${analyticsSubjectKeySql('e', 'guest_link')} AS subject_key
         FROM events e
         LEFT JOIN guest_visitor_links guest_link ON guest_link.user_id = e.user_id
         WHERE e.event_time >= NOW() - ($1::int * INTERVAL '1 day')
           AND e.event_name IN ('game_view', 'game_level_start', 'game_phase_complete', 'game_level_complete', 'game_chapter_pass')
       )
       SELECT
         COUNT(*) FILTER (WHERE event_name = 'game_view')::int AS view_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_view')::int AS view_users,
         COUNT(*) FILTER (WHERE event_name = 'game_level_start')::int AS start_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_level_start')::int AS start_users,
         COUNT(*) FILTER (WHERE event_name = 'game_level_complete')::int AS complete_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_level_complete')::int AS complete_users,
         COUNT(*) FILTER (WHERE event_name = 'game_level_start' AND (properties->>'is_boss') = 'true')::int AS boss_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_level_start' AND (properties->>'is_boss') = 'true')::int AS boss_users,
         COUNT(*) FILTER (WHERE event_name = 'game_chapter_pass')::int AS pass_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_chapter_pass')::int AS pass_users,
         COUNT(*) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'learn')::int AS learn_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'learn')::int AS learn_users,
         COUNT(*) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'matching')::int AS matching_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'matching')::int AS matching_users,
         COUNT(*) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'spelling')::int AS spelling_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'spelling')::int AS spelling_users,
         COUNT(*) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'quiz')::int AS quiz_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'quiz')::int AS quiz_users,
         COUNT(*) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'boss')::int AS boss_phase_events,
         COUNT(DISTINCT subject_key) FILTER (WHERE event_name = 'game_phase_complete' AND (properties->>'phase') = 'boss')::int AS boss_phase_users
       FROM windowed`,
      [normalizedDays]
    ),
    pool.query(
      `WITH ${guestVisitorLinksSql()}
       SELECT DATE(e.event_time) AS date,
              COUNT(DISTINCT ${analyticsSubjectKeySql('e', 'guest_link')})
                FILTER (WHERE e.event_name = 'game_view')::int AS players,
              COUNT(*) FILTER (WHERE e.event_name = 'game_level_complete')::int AS levels_completed
       FROM events e
       LEFT JOIN guest_visitor_links guest_link ON guest_link.user_id = e.user_id
       WHERE e.event_time >= NOW() - ($1::int * INTERVAL '1 day')
         AND e.event_name IN ('game_view', 'game_level_complete')
       GROUP BY DATE(e.event_time)
       ORDER BY date ASC`,
      [normalizedDays]
    ),
    pool.query(
      `WITH ${guestVisitorLinksSql()}
       SELECT (e.properties->>'chapter')::int AS chapter,
              COUNT(*) FILTER (WHERE e.event_name = 'game_level_complete')::int AS levels_completed,
              COUNT(DISTINCT ${analyticsSubjectKeySql('e', 'guest_link')})
                FILTER (WHERE e.event_name = 'game_level_complete')::int AS players,
              ROUND(AVG((e.properties->>'accuracy')::numeric)
                FILTER (WHERE e.event_name = 'game_level_complete'))::int AS avg_accuracy,
              COUNT(*) FILTER (WHERE e.event_name = 'game_chapter_pass')::int AS passes
       FROM events e
       LEFT JOIN guest_visitor_links guest_link ON guest_link.user_id = e.user_id
       WHERE e.event_time >= NOW() - ($1::int * INTERVAL '1 day')
         AND e.event_name IN ('game_level_complete', 'game_chapter_pass')
         AND (e.properties->>'chapter') ~ '^[0-9]+$'
       GROUP BY (e.properties->>'chapter')::int
       ORDER BY chapter ASC`,
      [normalizedDays]
    ),
  ]);

  const row = stepsResult.rows[0] || {};
  const steps = buildFunnelSteps([
    { key: 'game_view', label: '打开游戏', events: row.view_events, users: row.view_users },
    { key: 'level_start', label: '开始关卡', events: row.start_events, users: row.start_users },
    { key: 'level_complete', label: '完成关卡', events: row.complete_events, users: row.complete_users },
    { key: 'boss_start', label: '挑战 BOSS', events: row.boss_events, users: row.boss_users },
    { key: 'chapter_pass', label: '通关章节', events: row.pass_events, users: row.pass_users },
  ]);
  const levelStartUsers = Number(row.start_users) || 0;
  const phases = [
    { key: 'learn', label: '完成学词', events: row.learn_events, users: row.learn_users },
    { key: 'matching', label: '完成连连看', events: row.matching_events, users: row.matching_users },
    { key: 'spelling', label: '完成拼写', events: row.spelling_events, users: row.spelling_users },
    { key: 'quiz', label: '完成速答', events: row.quiz_events, users: row.quiz_users },
    { key: 'boss', label: '完成 BOSS', events: row.boss_phase_events, users: row.boss_phase_users },
  ].map((phase) => ({
    ...phase,
    events: Number(phase.events) || 0,
    users: Number(phase.users) || 0,
    rate_from_level_start: percent(phase.users, levelStartUsers),
  }));

  return {
    days: normalizedDays,
    steps,
    phases,
    daily: dailyResult.rows.map((r) => ({
      date: analyticsDateKey(r.date),
      players: Number(r.players) || 0,
      levels_completed: Number(r.levels_completed) || 0,
    })),
    chapters: chaptersResult.rows.map((r) => ({
      chapter: Number(r.chapter) || 0,
      levels_completed: Number(r.levels_completed) || 0,
      players: Number(r.players) || 0,
      avg_accuracy: r.avg_accuracy === null ? null : Number(r.avg_accuracy),
      passes: Number(r.passes) || 0,
    })),
  };
}

module.exports = {
  getUsageSummaryAllUsers,
  getUsageSummaryForUser,
  getEventSecondsTotal,
  getEventSecondsTotalWindowed,
  listRecentEventsForUser,
  getUsageBreakdownForUser,
  getGlobalCategoryUsage,
  getVideoUsageTop,
  getVideoUsageById,
  getUserVideoUsageList,
  getPageVisits,
  getVisitStats,
  getVisitsByDate,
  deleteVisitsByIP,
  deleteVisitsByIds,
  getVideoViewsWithDetails,
  getTopActiveUsers,
  getUserGrowthTrend,
  getUserTypeDistribution,
  getFeedbackStatusDistribution,
  getClickHeatmap,
  getGuestFunnelStats,
  getFirstDayActivationStats,
  getOnboardingFunnelStats,
  getTodayActivationFunnel,
  getGameFunnelStats,
  analyticsSubjectKeySql,
  guestVisitorLinksSql,
  getPricingFunnelStats,
  getTodayRetentionSummary,
  getLearningReportGrowthStats,
  getABTestSummary,
  getAiUsageSummary,
};
