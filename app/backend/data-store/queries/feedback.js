const { pool, init, dbUnavailable, assertDbAvailable } = require('../core');

async function saveFeedback(userId, { category, content, attachments = [] }) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');
  const cat = (category || 'general').toLowerCase();
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const { rows } = await pool.query(
    `INSERT INTO user_feedback (user_id, category, content, attachments) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, cat, content, JSON.stringify(safeAttachments)]
  );
  return rows[0];
}

async function listFeedbackByUser(userId, { limit = 50, offset = 0 } = {}) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');
  const { rows } = await pool.query(
    `SELECT f.*, (
        SELECT COALESCE(json_agg(r ORDER BY r.created_at ASC), '[]'::json)
        FROM user_feedback_replies r WHERE r.feedback_id = f.id
     ) AS replies
     FROM user_feedback f
     WHERE f.user_id = $1
     ORDER BY f.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

async function adminListFeedback({ status = null, limit = 100, offset = 0 } = {}) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND f.status = $${params.length}`; }
  params.push(limit); params.push(offset);
  const { rows } = await pool.query(
    `SELECT f.*, u.email, u.username,
        (SELECT COALESCE(json_agg(r ORDER BY r.created_at ASC), '[]'::json)
         FROM user_feedback_replies r WHERE r.feedback_id = f.id) AS replies
     FROM user_feedback f
     LEFT JOIN users u ON u.id = f.user_id
     ${where}
     ORDER BY f.created_at DESC
     LIMIT $${params.length-1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function addFeedbackReply(adminUserId, feedbackId, message) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');
  const role = 'admin';
  const { rows } = await pool.query(
    `INSERT INTO user_feedback_replies (feedback_id, author_user_id, role, message)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [feedbackId, adminUserId, role, message]
  );
  await pool.query(`UPDATE user_feedback SET updated_at = NOW(), status = CASE WHEN status='open' THEN 'in_progress' ELSE status END WHERE id = $1`, [feedbackId]);
  return rows[0];
}

async function updateFeedbackStatus(feedbackId, status) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');
  const { rows } = await pool.query(
    `UPDATE user_feedback SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [feedbackId, status]
  );
  return rows[0];
}

async function deleteFeedback(feedbackId) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');
  const { rows } = await pool.query(
    `DELETE FROM user_feedback WHERE id = $1 RETURNING *`,
    [feedbackId]
  );
  return rows[0];
}

module.exports = {
  saveFeedback,
  listFeedbackByUser,
  adminListFeedback,
  addFeedbackReply,
  updateFeedbackStatus,
  deleteFeedback,
};
