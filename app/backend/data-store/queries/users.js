const { pool, init, dbUnavailable } = require('../core');
const { getIPLocation, getIPLocationsBatch } = require('../../utils/ip-location');

function normalizeUserLevel(raw, allowNull = false) {
  // Allow null for two-step registration (user selects level later on welcome page)
  if (raw === null || raw === undefined) {
    return allowNull ? null : 'beginner';
  }
  const v = String(raw).trim().toLowerCase();
  if (!v) return allowNull ? null : 'beginner';
  if (v === 'beginner' || v === 'intermediate' || v === 'advanced') return v;
  if (v === 'easy' || v === 'a1' || v === 'a2') return 'beginner';
  if (v === 'medium' || v === 'b1' || v === 'b2') return 'intermediate';
  if (v === 'hard' || v === 'c1' || v === 'c2') return 'advanced';
  // Legacy default from older schemas used CEFR-ish strings (e.g. "B1")
  if (v.startsWith('a')) return 'beginner';
  if (v.startsWith('b')) return 'intermediate';
  if (v.startsWith('c')) return 'advanced';
  return allowNull ? null : 'beginner';
}

async function ensureUserProfile(userId, level) {
  await init();
  if (dbUnavailable() || !userId) return;
  try {
    await pool.query(
      `INSERT INTO user_profiles (user_id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  } catch (_) { }

  // Try to sync current_vocabulary_level if the column exists (V16+)
  try {
    await pool.query(
      `UPDATE user_profiles
          SET current_vocabulary_level = $1,
              vocabulary_level_updated_at = NOW(),
              updated_at = NOW()
        WHERE user_id = $2`,
      [normalizeUserLevel(level), userId],
    );
  } catch (_) { }
}

async function createUser(payload) {
  await init();
  const { email, username, password_hash, phone = null, level = null } = payload;
  // Allow null level for two-step registration
  const normalizedLevel = normalizeUserLevel(level, level === null);
  const { rows } = await pool.query(
    `INSERT INTO users (email, username, password_hash, phone, level, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
     RETURNING *`,
    [email, username, password_hash, phone, normalizedLevel],
  );
  const user = rows[0];
  try { await ensureUserProfile(user?.id, normalizedLevel); } catch (_) { }
  return user;
}

async function upsertUser(user) {
  await init();
  const normalizedLevel = normalizeUserLevel(user.level || 'beginner');
  const { rows } = await pool.query(
    `INSERT INTO users (email, username, password_hash, level, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'active'), NOW(), NOW())
     ON CONFLICT (email) DO UPDATE
       SET username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           level = EXCLUDED.level,
           status = EXCLUDED.status,
           updated_at = NOW()
     RETURNING *`,
    [
      user.email,
      user.username,
      user.password_hash,
      normalizedLevel,
      user.status || 'active',
    ],
  );
  const updated = rows[0];
  try { await ensureUserProfile(updated?.id, normalizedLevel); } catch (_) { }
  return updated;
}

async function findUserByEmail(email) {
  await init();
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
  return rows[0] || null;
}

async function findUserByPhone(phone) {
  await init();
  const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1 LIMIT 1', [phone]);
  return rows[0] || null;
}

async function findUserById(id) {
  await init();
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function recordLoginSession(userId, loginIp = null, userAgent = null) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `INSERT INTO user_login_sessions (user_id, login_ip, user_agent)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, loginIp, userAgent]
  );
  await pool.query(
    `UPDATE users SET last_login_at = NOW(), last_login_ip = $2, updated_at = NOW() WHERE id = $1`,
    [userId, loginIp]
  );
  return rows[0] || null;
}

async function recordLogoutSession(userId) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `UPDATE user_login_sessions
        SET logout_at = NOW()
      WHERE id = (
        SELECT id FROM user_login_sessions
         WHERE user_id = $1 AND logout_at IS NULL
         ORDER BY login_at DESC
         LIMIT 1
      )
      RETURNING *`,
    [userId]
  );
  return rows[0] || null;
}

async function getUserCountsSummary() {
  await init();
  if (dbUnavailable()) {
    return { total: 0, new_today: 0, new_7d: 0, new_30d: 0, active_7d: 0, banned: 0 };
  }
  const totalQ = pool.query(`SELECT COUNT(*)::int AS c FROM users`);
  const newTodayQ = pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE created_at >= NOW() - INTERVAL '1 day'`);
  const new7dQ = pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE created_at >= NOW() - INTERVAL '7 days'`);
  const new30dQ = pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE created_at >= NOW() - INTERVAL '30 days'`);
  const active7dQ = pool.query(`
    SELECT COUNT(DISTINCT user_id)::int AS c
      FROM user_login_sessions
     WHERE login_at >= NOW() - INTERVAL '7 days'
  `);
  const bannedQ = pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE status = 'banned'`);
  const [total, today, w7, m30, active7d, banned] = await Promise.all([totalQ, newTodayQ, new7dQ, new30dQ, active7dQ, bannedQ]);
  return {
    total: total.rows[0].c,
    new_today: today.rows[0].c,
    new_7d: w7.rows[0].c,
    new_30d: m30.rows[0].c,
    active_7d: active7d.rows[0].c,
    banned: banned.rows[0].c,
  };
}

async function listUsers({ status = null, limit = 50, offset = 0, query = null, user_type = null } = {}) {
  await init();
  if (dbUnavailable()) return { items: [], total: 0 };
  const where = [];
  const values = [];
  let i = 1;
  if (status) { where.push(`u.status = $${i++}`); values.push(status); }
  if (query) { where.push(`(u.email ILIKE $${i} OR u.username ILIKE $${i})`); values.push(`%${query}%`); i += 1; }

  // Filter by user type (registered vs guest)
  if (user_type === 'guest') {
    where.push(`u.email LIKE 'guest_%@temp.linglish.local'`);
  } else if (user_type === 'registered') {
    where.push(`u.email NOT LIKE 'guest_%@temp.linglish.local'`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Get total count
  const countQuery = `SELECT COUNT(*)::int AS c FROM users u ${whereSql}`;
  const countValues = values.slice(0, i - 1);
  const countResult = await pool.query(countQuery, countValues);
  const total = countResult.rows[0].c;

  // Get paginated results
  values.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT u.*,
            q.video_upload_limit,
            q.video_upload_used,
            q.resets_at,
            CASE
              WHEN u.is_admin IS TRUE THEN TRUE
              WHEN u.membership_type IS NULL OR u.membership_type = 'free' THEN FALSE
              WHEN COALESCE(u.subscription_status, 'none') IN ('expired', 'paused', 'unpaid') THEN FALSE
              WHEN COALESCE(u.subscription_status, 'none') IN ('active', 'on_trial', 'trialing')
                THEN COALESCE(u.membership_expires_at, u.subscription_end_date) IS NULL
                  OR COALESCE(u.membership_expires_at, u.subscription_end_date) > NOW()
              WHEN COALESCE(u.subscription_status, 'none') IN ('cancelled', 'canceled', 'cancel_at_period_end', 'past_due')
                THEN COALESCE(u.subscription_end_date, u.membership_expires_at) > NOW()
              ELSE COALESCE(u.membership_expires_at, u.subscription_end_date) IS NULL
                OR COALESCE(u.membership_expires_at, u.subscription_end_date) > NOW()
            END AS is_premium
       FROM users u
       LEFT JOIN user_quotas q ON q.user_id = u.id
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
    values
  );

  // Extract unique IPs from all users to avoid redundant queries
  const uniqueIps = [...new Set(rows.map(user => user.last_login_ip).filter(Boolean))];

  // Batch query IP locations with rate limiting to avoid API throttling
  const ipLocationMap = uniqueIps.length > 0
    ? await getIPLocationsBatch(uniqueIps)
    : new Map();

  // Map IP locations back to users
  const items = rows.map(user => {
    const ipLocation = user.last_login_ip
      ? (ipLocationMap.get(user.last_login_ip) || '未知')
      : '-';

    return {
      ...user,
      ip_location: ipLocation
    };
  });

  return { items, total };
}

async function updateUserFields(userId, fields = {}) {
  await init();
  if (dbUnavailable()) return null;
  const allowed = new Set(['membership_type', 'membership_expires_at', 'level', 'status', 'is_admin', 'email_verified']);
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = $${idx++}`);
    values.push(v);
  }
  if (sets.length === 0) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [userId]);
    return rows[0] || null;
  }
  sets.push('updated_at = NOW()');
  values.push(userId);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function updateUserPasswordHash(userId, passwordHash) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `UPDATE users
        SET password_hash = $1,
            updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [passwordHash, userId],
  );
  return rows[0] || null;
}

async function createPasswordResetToken({ userId, tokenHash, expiresAt, requesterIp = null, userAgent = null }) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `INSERT INTO password_resets (
       user_id, token_hash, expires_at, requester_ip, user_agent, created_at
     )
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING *`,
    [userId, tokenHash, expiresAt, requesterIp, userAgent],
  );
  return rows[0] || null;
}

async function findPasswordResetByTokenHash(tokenHash) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `SELECT *
       FROM password_resets
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [tokenHash],
  );
  return rows[0] || null;
}

async function markPasswordResetUsed(resetId) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `UPDATE password_resets
        SET used_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [resetId],
  );
  return rows[0] || null;
}

async function invalidateUserPasswordResets(userId, exceptResetId = null) {
  await init();
  if (dbUnavailable()) return 0;
  const values = [userId];
  let exceptSql = '';
  if (exceptResetId != null) {
    values.push(exceptResetId);
    exceptSql = 'AND id <> $2';
  }
  const { rowCount } = await pool.query(
    `UPDATE password_resets
        SET used_at = COALESCE(used_at, NOW())
      WHERE user_id = $1
        AND used_at IS NULL
        ${exceptSql}`,
    values,
  );
  return rowCount;
}

async function storeEmailVerificationToken(userId, tokenHash, expiresAt) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `UPDATE users
        SET email_verification_token = $2,
            email_verification_sent_at = NOW(),
            email_verification_expires_at = $3,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [userId, tokenHash, expiresAt],
  );
  return rows[0] || null;
}

async function findUserByEmailVerificationToken(tokenHash) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `SELECT *
       FROM users
      WHERE email_verification_token = $1
        AND email_verified IS NOT TRUE
        AND email_verification_expires_at > NOW()
      LIMIT 1`,
    [tokenHash],
  );
  return rows[0] || null;
}

async function markUserEmailVerified(userId) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `UPDATE users
        SET email_verified = TRUE,
            email_verification_token = NULL,
            email_verification_sent_at = NULL,
            email_verification_expires_at = NULL,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [userId],
  );
  return rows[0] || null;
}

async function setUserStatus(userId, status) {
  return updateUserFields(userId, { status });
}

async function deleteUserById(userId) {
  await init();
  if (dbUnavailable()) return false;
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  return rowCount > 0;
}

async function upsertUserQuota(userId, { video_upload_limit = null, video_upload_used = null, resets_at = null } = {}) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `INSERT INTO user_quotas (user_id, video_upload_limit, video_upload_used, resets_at)
     VALUES ($1, COALESCE($2, 3), COALESCE($3, 0), $4)
     ON CONFLICT (user_id)
     DO UPDATE SET
       video_upload_limit = COALESCE(EXCLUDED.video_upload_limit, user_quotas.video_upload_limit),
       video_upload_used = COALESCE(EXCLUDED.video_upload_used, user_quotas.video_upload_used),
       resets_at = COALESCE(EXCLUDED.resets_at, user_quotas.resets_at)
     RETURNING *`,
    [userId, video_upload_limit, video_upload_used, resets_at]
  );
  return rows[0] || null;
}

async function getUserLoginSessions(userId, limit = 50) {
  await init();
  if (dbUnavailable()) return [];
  const { rows } = await pool.query(
    `SELECT * FROM user_login_sessions WHERE user_id = $1 ORDER BY login_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function logAdminAction(adminUserId, targetUserId, action, details = {}) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `INSERT INTO user_admin_actions (admin_user_id, target_user_id, action, details)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [adminUserId, targetUserId, action, JSON.stringify(details)]
  );
  return rows[0] || null;
}

async function getUserActiveDates(userId, days = 365) {
  await init();
  if (dbUnavailable()) return [];

  const { rows } = await pool.query(
    `SELECT DISTINCT date
     FROM (
       SELECT DATE(login_at) as date FROM user_login_sessions 
       WHERE user_id = $1 AND login_at >= NOW() - ($2 || ' days')::interval
       UNION
       SELECT DATE(created_at) as date FROM training_sessions 
       WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
       UNION
       SELECT DATE(event_time) as date FROM events
       WHERE user_id = $1 AND event_time >= NOW() - ($2 || ' days')::interval
     ) dates
     ORDER BY date DESC`,
    [userId, days]
  );

  return rows.map(r => r.date); // Returns array of Date objects or strings depending on driver
}

module.exports = {
  createUser,
  upsertUser,
  findUserByEmail,
  findUserByPhone,
  findUserById,
  recordLoginSession,
  recordLogoutSession,
  getUserCountsSummary,
  listUsers,
  updateUserFields,
  setUserStatus,
  deleteUserById,
  upsertUserQuota,
  getUserLoginSessions,
  logAdminAction,
  getUserActiveDates,
  updateUserPasswordHash,
  createPasswordResetToken,
  findPasswordResetByTokenHash,
  markPasswordResetUsed,
  invalidateUserPasswordResets,
  storeEmailVerificationToken,
  findUserByEmailVerificationToken,
  markUserEmailVerified,
};
