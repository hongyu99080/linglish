const { pool, init } = require('../core');

async function createVoiceCheckin(userId, { text, audioPath = null, shareUrl = null, shareToken = null, durationSec }) {
  await init();
  const query = `
    INSERT INTO voice_checkins (user_id, text, audio_path, share_url, share_token, duration_sec)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `;
  const result = await pool.query(query, [
    userId,
    text || null,
    audioPath,
    shareUrl,
    shareToken,
    durationSec || null
  ]);
  return result.rows[0];
}

async function listVoiceCheckins(userId, { limit = 20, offset = 0 } = {}) {
  await init();
  const query = `
    SELECT
      vc.*,
      u.username,
      COALESCE(lc.cnt, 0)::int AS like_count,
      COALESCE(cc.cnt, 0)::int AS comment_count,
      COALESCE(rc.avg, 0)::float AS rating_avg,
      COALESCE(rc.cnt, 0)::int AS rating_count,
      ur.rating AS user_rating,
      EXISTS(
        SELECT 1 FROM voice_checkin_likes vcl
        WHERE vcl.checkin_id = vc.id AND vcl.user_id = $1
      ) AS liked
    FROM voice_checkins vc
    JOIN users u ON vc.user_id = u.id
    LEFT JOIN (
      SELECT checkin_id, COUNT(*)::int AS cnt
      FROM voice_checkin_likes
      GROUP BY checkin_id
    ) lc ON lc.checkin_id = vc.id
    LEFT JOIN (
      SELECT checkin_id, COUNT(*)::int AS cnt
      FROM voice_checkin_comments
      GROUP BY checkin_id
    ) cc ON cc.checkin_id = vc.id
    LEFT JOIN (
      SELECT checkin_id,
             AVG(rating)::float AS avg,
             COUNT(*)::int AS cnt
      FROM voice_checkin_ratings
      GROUP BY checkin_id
    ) rc ON rc.checkin_id = vc.id
    LEFT JOIN voice_checkin_ratings ur
      ON ur.checkin_id = vc.id AND ur.user_id = $1
    ORDER BY vc.created_at DESC
    LIMIT $2 OFFSET $3
  `;
  const result = await pool.query(query, [userId, limit, offset]);
  return result.rows;
}

async function getVoiceCheckinLike(userId, checkinId) {
  await init();
  const result = await pool.query(
    `SELECT id FROM voice_checkin_likes WHERE user_id = $1 AND checkin_id = $2`,
    [userId, checkinId]
  );
  return result.rows[0] || null;
}

async function addVoiceCheckinLike(userId, checkinId) {
  await init();
  await pool.query(
    `INSERT INTO voice_checkin_likes (checkin_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (checkin_id, user_id) DO NOTHING`,
    [checkinId, userId]
  );
  return true;
}

async function removeVoiceCheckinLike(userId, checkinId) {
  await init();
  await pool.query(
    `DELETE FROM voice_checkin_likes WHERE checkin_id = $1 AND user_id = $2`,
    [checkinId, userId]
  );
  return true;
}

async function countVoiceCheckinLikes(checkinId) {
  await init();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM voice_checkin_likes WHERE checkin_id = $1`,
    [checkinId]
  );
  return result.rows[0]?.cnt || 0;
}

async function addVoiceCheckinComment(userId, checkinId, content) {
  await init();
  const result = await pool.query(
    `INSERT INTO voice_checkin_comments (checkin_id, user_id, content)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [checkinId, userId, content]
  );
  return result.rows[0];
}

async function listVoiceCheckinComments(checkinId, { limit = 20 } = {}) {
  await init();
  const result = await pool.query(
    `SELECT c.*, u.username
     FROM voice_checkin_comments c
     JOIN users u ON c.user_id = u.id
     WHERE c.checkin_id = $1
     ORDER BY c.created_at DESC
     LIMIT $2`,
    [checkinId, limit]
  );
  return result.rows;
}

async function upsertVoiceCheckinRating(userId, checkinId, rating) {
  await init();
  const result = await pool.query(
    `INSERT INTO voice_checkin_ratings (checkin_id, user_id, rating, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (checkin_id, user_id)
     DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()
     RETURNING *`,
    [checkinId, userId, rating]
  );
  return result.rows[0];
}

async function getVoiceCheckinRatingSummary(checkinId) {
  await init();
  const result = await pool.query(
    `SELECT AVG(rating)::float AS avg, COUNT(*)::int AS cnt
       FROM voice_checkin_ratings
      WHERE checkin_id = $1`,
    [checkinId]
  );
  return result.rows[0] || { avg: 0, cnt: 0 };
}

async function getVoiceCheckinById(checkinId) {
  await init();
  const result = await pool.query(
    `SELECT * FROM voice_checkins WHERE id = $1`,
    [checkinId]
  );
  return result.rows[0] || null;
}

async function deleteVoiceCheckin(checkinId) {
  await init();
  // Delete related records first (likes, comments, ratings)
  await pool.query(`DELETE FROM voice_checkin_likes WHERE checkin_id = $1`, [checkinId]);
  await pool.query(`DELETE FROM voice_checkin_comments WHERE checkin_id = $1`, [checkinId]);
  await pool.query(`DELETE FROM voice_checkin_ratings WHERE checkin_id = $1`, [checkinId]);
  // Delete the checkin itself
  const result = await pool.query(
    `DELETE FROM voice_checkins WHERE id = $1 RETURNING *`,
    [checkinId]
  );
  return result.rows[0] || null;
}

async function createNativeReviewRequest(userId, { text, audioPath }) {
  await init();
  const result = await pool.query(
    `INSERT INTO native_review_requests (user_id, text, audio_path)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, text || null, audioPath]
  );
  return result.rows[0];
}

async function listNativeReviewRequests(userId, { limit = 20, offset = 0 } = {}) {
  await init();
  const result = await pool.query(
    `SELECT
        nr.*,
        u.username,
        COALESCE(cc.cnt, 0)::int AS comment_count
     FROM native_review_requests nr
     JOIN users u ON nr.user_id = u.id
     LEFT JOIN (
       SELECT request_id, COUNT(*)::int AS cnt
       FROM native_review_comments
       GROUP BY request_id
     ) cc ON cc.request_id = nr.id
     ORDER BY nr.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

async function addNativeReviewComment(reviewerId, requestId, content) {
  await init();
  const result = await pool.query(
    `INSERT INTO native_review_comments (request_id, reviewer_user_id, content)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [requestId, reviewerId, content]
  );
  return result.rows[0];
}

async function listNativeReviewComments(requestId, { limit = 20 } = {}) {
  await init();
  const result = await pool.query(
    `SELECT c.*, u.username
     FROM native_review_comments c
     LEFT JOIN users u ON c.reviewer_user_id = u.id
     WHERE c.request_id = $1
     ORDER BY c.created_at DESC
     LIMIT $2`,
    [requestId, limit]
  );
  return result.rows;
}

async function getWeeklyFocus(userId, weekStart) {
  await init();
  const result = await pool.query(
    `SELECT * FROM user_weekly_focus WHERE user_id = $1 AND week_start = $2`,
    [userId, weekStart]
  );
  return result.rows[0] || null;
}

async function saveWeeklyFocus(userId, weekStart, items) {
  await init();
  const result = await pool.query(
    `INSERT INTO user_weekly_focus (user_id, week_start, focus_items)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, week_start)
     DO UPDATE SET focus_items = EXCLUDED.focus_items
     RETURNING *`,
    [userId, weekStart, JSON.stringify(items || [])]
  );
  return result.rows[0];
}

module.exports = {
  createVoiceCheckin,
  listVoiceCheckins,
  getVoiceCheckinById,
  deleteVoiceCheckin,
  getVoiceCheckinLike,
  addVoiceCheckinLike,
  removeVoiceCheckinLike,
  countVoiceCheckinLikes,
  addVoiceCheckinComment,
  listVoiceCheckinComments,
  upsertVoiceCheckinRating,
  getVoiceCheckinRatingSummary,
  createNativeReviewRequest,
  listNativeReviewRequests,
  addNativeReviewComment,
  listNativeReviewComments,
  getWeeklyFocus,
  saveWeeklyFocus,
};
