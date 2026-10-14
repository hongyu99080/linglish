const { pool, init } = require('../core');

async function createPracticeRecordingShare({
  token,
  userId,
  videoResourceId,
  speaker,
  expiresAt = null,
}) {
  await init();
  const { rows } = await pool.query(
    `INSERT INTO practice_recording_shares
       (token, user_id, video_resource_id, speaker, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [token, userId, videoResourceId, speaker, expiresAt],
  );
  return rows[0] || null;
}

async function getPracticeRecordingShareByToken(token) {
  await init();
  const { rows } = await pool.query(
    `SELECT *
       FROM practice_recording_shares
      WHERE token = $1
      LIMIT 1`,
    [token],
  );
  return rows[0] || null;
}

async function touchPracticeRecordingShare(token) {
  await init();
  await pool.query(
    `UPDATE practice_recording_shares
        SET last_accessed_at = NOW()
      WHERE token = $1`,
    [token],
  );
}

module.exports = {
  createPracticeRecordingShare,
  getPracticeRecordingShareByToken,
  touchPracticeRecordingShare,
};
