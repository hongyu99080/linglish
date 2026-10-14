const { pool, init } = require('../core');

async function createSession(payload) {
  await init();
  const {
    user_id,
    type,
    media_id = null,
    segment_id = null,
    start_at = new Date().toISOString(),
    end_at = null,
    duration_sec = null,
    output_blob = null,
  } = payload;
  const { rows } = await pool.query(
    `INSERT INTO training_sessions
     (user_id, type, media_id, segment_id, start_at, end_at, duration_sec, output_blob)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [user_id, type, media_id, segment_id, start_at, end_at, duration_sec, output_blob],
  );
  return rows[0];
}

async function updateSession(id, updates) {
  await init();
  const fields = [];
  const values = [];
  let index = 1;
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${index++}`);
    values.push(value);
  }
  if (!fields.length) {
    const session = await getSessionById(id);
    return session;
  }
  values.push(id);
  const sql = `UPDATE training_sessions SET ${fields.join(', ')}
               WHERE id = $${index} RETURNING *`;
  const { rows } = await pool.query(sql, values);
  return rows[0] || null;
}

async function getSessionById(id) {
  await init();
  const { rows } = await pool.query('SELECT * FROM training_sessions WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function listSessions({ userId, type, limit = 20 } = {}) {
  await init();
  const values = [];
  const where = [];
  let index = 1;
  if (userId != null) {
    where.push(`user_id = $${index++}`);
    values.push(userId);
  }
  if (type) {
    where.push(`type = $${index++}`);
    values.push(type);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  values.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM training_sessions
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${index}`,
    values,
  );
  return rows;
}

async function createEvent(payload) {
  await init();
  const {
    user_id = null,
    event_time = new Date().toISOString(),
    event_name,
    properties = {},
    source = 'web',
  } = payload;
  const { rows } = await pool.query(
    `INSERT INTO events (user_id, event_time, event_name, properties, source, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     RETURNING *`,
    [user_id, event_time, event_name, JSON.stringify(properties), source],
  );
  return rows[0];
}

async function listEvents({ userId, name, limit = 50 } = {}) {
  await init();
  const values = [];
  const where = [];
  let index = 1;
  if (userId != null) {
    where.push(`user_id = $${index++}`);
    values.push(userId);
  }
  if (name) {
    where.push(`event_name = $${index++}`);
    values.push(name);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  values.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM events
     ${whereSql}
     ORDER BY event_time DESC
     LIMIT $${index}`,
    values,
  );
  return rows;
}

async function countEventsToday({ userId, name }) {
  await init();
  const values = [];
  const where = [
    `event_time >= date_trunc('day', NOW())`,
    `event_time < date_trunc('day', NOW()) + INTERVAL '1 day'`,
  ];
  let index = 1;
  if (userId != null) {
    where.push(`user_id = $${index++}`);
    values.push(userId);
  }
  if (name) {
    where.push(`event_name = $${index++}`);
    values.push(name);
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM events
      WHERE ${where.join(' AND ')}`,
    values,
  );
  return rows[0]?.c || 0;
}

async function saveAiScore(payload) {
  await init();
  const {
    session_id,
    metrics,
    grade,
    cost_cents = 0,
    prosody = null,
    audio_path = null,
    reference_text = null,
    hypothesis_text = null
  } = payload;

  const { rows } = await pool.query(
    `INSERT INTO ai_scores (
      session_id, metrics, grade, cost_cents,
      prosody, audio_path, reference_text, hypothesis_text,
      created_at
    )
    VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6, $7, $8, NOW())
    RETURNING *`,
    [
      session_id,
      JSON.stringify(metrics),
      grade,
      cost_cents,
      prosody ? JSON.stringify(prosody) : null,
      audio_path,
      reference_text,
      hypothesis_text
    ],
  );
  return rows[0];
}

async function getAiScoreBySession(sessionId) {
  await init();
  const { rows } = await pool.query(
    'SELECT * FROM ai_scores WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',
    [sessionId],
  );
  return rows[0] || null;
}

async function getStatsForUser(userId) {
  await init();
  const { rows } = await pool.query(
    `SELECT type, duration_sec, output_blob
     FROM training_sessions
     WHERE user_id = $1`,
    [userId],
  );

  let effectiveMinutes = 0;
  let effectiveOutputs = 0;

  rows.forEach((session) => {
    const duration = session.duration_sec || 0;
    if (duration >= 30) {
      effectiveMinutes += duration / 60;
      if (session.type === 'shadowing' || session.type === 'roleplay') {
        effectiveOutputs += 1;
      }
    }
    if (
      (session.type === 'dictogloss' || session.type === '432') &&
      session.output_blob != null
    ) {
      effectiveOutputs += 1;
    }
  });

  return {
    total_sessions: rows.length,
    effective_minutes: Number(effectiveMinutes.toFixed(2)),
    effective_outputs: effectiveOutputs,
  };
}

module.exports = {
  createSession,
  updateSession,
  getSessionById,
  listSessions,
  createEvent,
  listEvents,
  countEventsToday,
  saveAiScore,
  getAiScoreBySession,
  getStatsForUser,
};
