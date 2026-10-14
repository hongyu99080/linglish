const { pool, init, dbUnavailable, assertDbAvailable } = require('../core');
const { ensureRoleNames } = require('../utils/helpers');

async function createVideoSceneQuest(payload) {
  await init();
  if (dbUnavailable()) {
    throw new Error('DATASTORE_UNAVAILABLE');
  }
  const {
    video_resource_id,
    title,
    description = null,
    character_name,
    start_sec,
    end_sec,
    script_lines = [],
    difficulty = 'normal',
    created_by = null,
  } = payload;

  const { rows } = await pool.query(
    `INSERT INTO video_scene_quests
       (video_resource_id, title, description, character_name, start_sec, end_sec, script_lines, difficulty, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     RETURNING *`,
    [
      video_resource_id,
      title,
      description,
      character_name,
      start_sec,
      end_sec,
      JSON.stringify(script_lines),
      difficulty,
      created_by,
    ],
  );

  return rows[0];
}

async function listVideoSceneQuestsByVideoId(videoResourceId) {
  await init();
  const { rows } = await pool.query(
    `SELECT *
       FROM video_scene_quests
      WHERE video_resource_id = $1
      ORDER BY start_sec ASC`,
    [videoResourceId],
  );
  return rows;
}

async function getVideoSceneQuestById(id) {
  await init();
  const { rows } = await pool.query(
    'SELECT * FROM video_scene_quests WHERE id = $1 LIMIT 1',
    [id],
  );
  return rows[0] || null;
}

async function getPracticeRecording(videoResourceId, userId, speaker, segmentIndex) {
  await init();
  const { rows } = await pool.query(
    `SELECT *
       FROM video_practice_recordings
      WHERE video_resource_id = $1
        AND user_id = $2
        AND speaker = $3
        AND segment_index = $4
      LIMIT 1`,
    [videoResourceId, userId, speaker, segmentIndex],
  );
  return rows[0] || null;
}

async function upsertPracticeRecording({
  videoResourceId,
  userId,
  speaker,
  segmentIndex,
  audioPath,
  durationSec = null,
}) {
  await init();
  const { rows } = await pool.query(
    `INSERT INTO video_practice_recordings
       (video_resource_id, user_id, speaker, segment_index, audio_path, duration_sec, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (video_resource_id, user_id, speaker, segment_index)
     DO UPDATE SET
       audio_path = EXCLUDED.audio_path,
       duration_sec = EXCLUDED.duration_sec,
       updated_at = NOW()
     RETURNING *`,
    [videoResourceId, userId, speaker, segmentIndex, audioPath, durationSec],
  );
  return rows[0] || null;
}

async function listPracticeRecordingsForUser(videoResourceId, userId, speaker = null) {
  await init();
  const values = [videoResourceId, userId];
  let sql = `
    SELECT *
      FROM video_practice_recordings
     WHERE video_resource_id = $1
       AND user_id = $2
  `;
  if (speaker) {
    values.push(speaker);
    sql += ` AND speaker = $${values.length}`;
  }
  sql += ' ORDER BY segment_index ASC';
  const { rows } = await pool.query(sql, values);
  return rows;
}

async function getPracticeRoleHistoryForUser(videoResourceId, userId) {
  await init();
  const { rows } = await pool.query(
    `SELECT speaker,
            COUNT(*)::int AS count,
            MAX(updated_at) AS last_at
       FROM video_practice_recordings
      WHERE video_resource_id = $1
        AND user_id = $2
      GROUP BY speaker
      ORDER BY last_at DESC`,
    [videoResourceId, userId],
  );
  return rows || [];
}

async function createUserReward({
  user_id,
  quest_id = null,
  reward_type,
  amount,
  metadata = {},
}) {
  await init();
  const { rows } = await pool.query(
    `INSERT INTO user_rewards (user_id, quest_id, reward_type, amount, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [user_id, quest_id, reward_type, amount, JSON.stringify(metadata)],
  );
  return rows[0];
}

async function listRewardsForUser(userId, limit = 50) {
  await init();
  const { rows } = await pool.query(
    `SELECT *
       FROM user_rewards
      WHERE user_id = $1
      ORDER BY earned_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

async function getBestRoleplayRun(userId, questId) {
  await init();
  const { rows } = await pool.query(
    `SELECT *
       FROM roleplay_runs
      WHERE user_id = $1 AND quest_id = $2
      ORDER BY score DESC, recorded_at DESC
      LIMIT 1`,
    [userId, questId],
  );
  return rows[0] || null;
}

async function listRoleplayRuns({ userId = null, questId, limit = 20 }) {
  await init();
  const conditions = ['quest_id = $1'];
  const values = [questId];
  let idx = 2;
  if (userId != null) {
    conditions.push(`user_id = $${idx}`);
    values.push(userId);
    idx += 1;
  }
  values.push(limit);

  const { rows } = await pool.query(
    `SELECT *
       FROM roleplay_runs
      WHERE ${conditions.join(' AND ')}
      ORDER BY recorded_at DESC
      LIMIT $${idx}`,
    values,
  );
  return rows;
}

async function createRoleplayRun({
  quest_id,
  session_id = null,
  user_id,
  transcript = null,
  metrics = {},
  score,
  grade,
  reward_id = null,
}) {
  await init();
  const { rows: attemptRows } = await pool.query(
    `SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt
       FROM roleplay_runs
      WHERE quest_id = $1 AND user_id = $2`,
    [quest_id, user_id],
  );
  const nextAttempt = Number(attemptRows[0]?.last_attempt || 0) + 1;

  const { rows } = await pool.query(
    `INSERT INTO roleplay_runs
       (quest_id, session_id, user_id, attempt_number, transcript, metrics, score, grade, reward_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING *`,
    [
      quest_id,
      session_id,
      user_id,
      nextAttempt,
      transcript,
      JSON.stringify(metrics),
      score,
      grade,
      reward_id,
    ],
  );
  return rows[0];
}

async function getVideoRoleProfileExact(videoResourceId, userId = null) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `SELECT * FROM video_role_profiles WHERE video_resource_id = $1 AND ${userId == null ? 'user_id IS NULL' : 'user_id = $2'} LIMIT 1`,
    userId == null ? [videoResourceId] : [videoResourceId, userId]
  );
  return rows[0] || null;
}

async function getVideoRoleProfileEffective(videoResourceId, userId) {
  await init();
  if (dbUnavailable()) return null;
  // Prefer user-specific
  const userRow = await getVideoRoleProfileExact(videoResourceId, userId);
  if (userRow) return userRow;
  // Fallback to global
  const globalRow = await getVideoRoleProfileExact(videoResourceId, null);
  return globalRow || null;
}

async function upsertVideoRoleProfile({
  video_resource_id,
  user_id = null,
  scope = 'user',
  role_count,
  role_rotation = 0,
  role_names = [],
  overrides = null,
  infer_mode = 'content_aware',
  max_consecutive = null,
}) {
  await init();
  if (dbUnavailable()) throw new Error('DATASTORE_UNAVAILABLE');

  const k = Math.min(Math.max(Number(role_count) || 2, 2), 5);
  const rotation = Number.isFinite(Number(role_rotation)) ? Number(role_rotation) : 0;
  const names = ensureRoleNames(k, role_names);

  const effectiveUserId = scope === 'global' ? null : user_id;

  const { rows } = await pool.query(
    `INSERT INTO video_role_profiles (
        video_resource_id, user_id, scope, role_count, role_rotation, role_names, overrides, infer_mode, max_consecutive
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
     ON CONFLICT (video_resource_id, user_id)
     DO UPDATE SET
       scope = EXCLUDED.scope,
       role_count = EXCLUDED.role_count,
       role_rotation = EXCLUDED.role_rotation,
       role_names = EXCLUDED.role_names,
       overrides = EXCLUDED.overrides,
       infer_mode = EXCLUDED.infer_mode,
       max_consecutive = EXCLUDED.max_consecutive,
       updated_at = NOW()
     RETURNING *`,
    [
      video_resource_id,
      effectiveUserId,
      scope === 'global' ? 'global' : 'user',
      k,
      rotation,
      JSON.stringify(names),
      overrides ? JSON.stringify(overrides) : null,
      infer_mode || 'content_aware',
      max_consecutive == null ? null : Number(max_consecutive),
    ]
  );
  return rows[0] || null;
}

module.exports = {
  createVideoSceneQuest,
  listVideoSceneQuestsByVideoId,
  getVideoSceneQuestById,
  getPracticeRecording,
  upsertPracticeRecording,
  listPracticeRecordingsForUser,
  getPracticeRoleHistoryForUser,
  createUserReward,
  listRewardsForUser,
  getBestRoleplayRun,
  listRoleplayRuns,
  createRoleplayRun,
  getVideoRoleProfileExact,
  getVideoRoleProfileEffective,
  upsertVideoRoleProfile,
};
