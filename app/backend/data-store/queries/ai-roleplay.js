'use strict';

const { pool, init, dbUnavailable } = require('../core');

const defaultDependencies = {
  pool,
  init,
  dbUnavailable,
  now: () => new Date(),
  pendingTurnStaleAfterMs: 30_000,
};

const CEFR_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1']);
const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function canonicalDecimalId(value, code = 'INVALID_ID') {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  fail(code);
}

function canonicalUuidV4(value) {
  if (typeof value === 'string' && CANONICAL_UUID_V4.test(value)) {
    return value;
  }
  fail('TURN_KEY_INVALID');
}

function normalizeLimit(limit, fallback = 20, max = 50) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

function normalizeCefrLevel(level) {
  const normalized = typeof level === 'string' ? level.trim().toUpperCase() : '';
  return CEFR_LEVELS.has(normalized) ? normalized : null;
}

function normalizeScenario(row) {
  if (!row) return null;
  return {
    ...row,
    turn_limit: Number(row.turn_limit),
    sort_order: Number(row.sort_order),
  };
}

function normalizeSession(row) {
  if (!row) return null;
  return {
    ...row,
    id: String(row.id),
    user_id: String(row.user_id),
    turn_count: Number(row.turn_count),
    turn_limit: Number(row.turn_limit),
  };
}

function normalizeTurn(row) {
  if (!row) return null;
  return {
    ...row,
    id: String(row.id),
    session_id: String(row.session_id),
    turn_index: Number(row.turn_index),
    turn_result: normalizeTurnResult(row),
    latency_ms: row.latency_ms == null ? null : Number(row.latency_ms),
  };
}

function normalizeTurnResult(row) {
  if (row?.turn_result && typeof row.turn_result === 'object' && !Array.isArray(row.turn_result)) {
    return row.turn_result;
  }
  if (!row || row.status !== 'completed' || !row.assistant_text || !row.assistant_translation_zh || !row.evaluation) {
    return null;
  }
  return {
    version: 1,
    assistant: {
      text: row.assistant_text,
      translation_zh: row.assistant_translation_zh,
      tone: 'supportive',
    },
    evaluation: row.evaluation,
    controls: {
      should_end: false,
      needs_clarification: false,
      difficulty_adjustment: 'same',
    },
  };
}

function normalizeBoundedSummary(raw) {
  const value = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return value && value.length <= 1000 ? value : '发音评估已保存。';
}

function jsonValue(value, fallback = null) {
  return value == null ? fallback : value;
}

function isStale(row, staleAfterMs, now) {
  const staleMs = Number(staleAfterMs);
  if (!Number.isFinite(staleMs) || staleMs < 0) return false;
  const updatedAt = Date.parse(row.updated_at);
  if (!Number.isFinite(updatedAt)) return false;
  return now.getTime() - updatedAt >= staleMs;
}

async function withTransaction(deps, work) {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function createAIRoleplayRepositoryWithDeps(dependencies = defaultDependencies) {
  const deps = {
    ...defaultDependencies,
    ...dependencies,
  };

  async function ensureReady() {
    await deps.init();
    if (deps.dbUnavailable()) fail('DATASTORE_UNAVAILABLE');
  }

  async function listAIRoleplayScenarios({ level = null, category = null, limit = 20 } = {}) {
    await ensureReady();
    const values = [];
    const where = ['is_active = TRUE'];
    if (category) {
      values.push(category);
      where.push(`category = $${values.length}`);
    }
    const normalizedLevel = normalizeCefrLevel(level);
    if (normalizedLevel) {
      values.push(normalizedLevel);
      where.push(`cefr_min <= $${values.length} AND cefr_max >= $${values.length}`);
    }
    values.push(normalizeLimit(limit, 20, 50));
    const { rows } = await deps.pool.query(
      `SELECT id, title_zh, title_en, category, cefr_min, cefr_max,
              learner_role, assistant_role, opening_line, opening_translation_zh,
              goals, target_phrases, fallback_turns, turn_limit, is_active,
              sort_order, created_at, updated_at
         FROM ai_roleplay_scenarios
        WHERE ${where.join(' AND ')}
        ORDER BY sort_order ASC, id ASC
        LIMIT $${values.length}`,
      values,
    );
    return rows.map(normalizeScenario);
  }

  async function getAIRoleplayScenario(id) {
    await ensureReady();
    const { rows } = await deps.pool.query(
      `SELECT id, title_zh, title_en, category, cefr_min, cefr_max,
              learner_role, assistant_role, opening_line, opening_translation_zh,
              goals, target_phrases, fallback_turns, turn_limit, is_active,
              sort_order, created_at, updated_at
         FROM ai_roleplay_scenarios
        WHERE id = $1
        LIMIT 1`,
      [id],
    );
    return normalizeScenario(rows[0] || null);
  }

  async function createAIRoleplaySession({
    userId,
    scenarioId,
    cefrLevel,
    turnLimit,
    source = 'catalog',
    expiresAt = null,
  }) {
    await ensureReady();
    const normalizedUserId = canonicalDecimalId(userId, 'USER_ID_INVALID');
    const normalizedLevel = normalizeCefrLevel(cefrLevel) || 'A1';
    const normalizedTurnLimit = normalizeLimit(turnLimit, 4, 8);
    const { rows } = await deps.pool.query(
      `INSERT INTO ai_roleplay_sessions
         (user_id, scenario_id, cefr_level, turn_limit, source, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [normalizedUserId, scenarioId, normalizedLevel, normalizedTurnLimit, source, expiresAt],
    );
    return normalizeSession(rows[0]);
  }

  async function getAIRoleplaySessionForUser(sessionId, userId, options = {}) {
    await ensureReady();
    const normalizedSessionId = canonicalDecimalId(sessionId, 'SESSION_ID_INVALID');
    const normalizedUserId = canonicalDecimalId(userId, 'USER_ID_INVALID');
    const { rows } = await deps.pool.query(
      `SELECT *
         FROM ai_roleplay_sessions
        WHERE id = $1
          AND user_id = $2
        LIMIT 1`,
      [normalizedSessionId, normalizedUserId],
    );
    const session = normalizeSession(rows[0] || null);
    if (!session || !options.includeTurns) return session;
    return {
      ...session,
      turns: await listAIRoleplayTurnsForUser(normalizedSessionId, normalizedUserId, options.turnLimit),
    };
  }

  async function listAIRoleplayTurnsForUser(sessionId, userId, limit = 20) {
    await ensureReady();
    const normalizedSessionId = canonicalDecimalId(sessionId, 'SESSION_ID_INVALID');
    const normalizedUserId = canonicalDecimalId(userId, 'USER_ID_INVALID');
    const normalizedLimit = normalizeLimit(limit, 20, 50);
    const { rows } = await deps.pool.query(
      `SELECT t.*
         FROM ai_roleplay_turns t
         JOIN ai_roleplay_sessions s ON s.id = t.session_id
        WHERE t.session_id = $1
          AND s.user_id = $2
        ORDER BY t.turn_index ASC
        LIMIT $3`,
      [normalizedSessionId, normalizedUserId, normalizedLimit],
    );
    return rows.map(normalizeTurn);
  }

  async function claimAIRoleplayTurn({
    sessionId,
    userId,
    turnKey,
    transcript,
    pronunciationSummary = null,
  }) {
    await ensureReady();
    const normalizedSessionId = canonicalDecimalId(sessionId, 'SESSION_ID_INVALID');
    const normalizedUserId = canonicalDecimalId(userId, 'USER_ID_INVALID');
    const normalizedTurnKey = canonicalUuidV4(turnKey);
    return withTransaction(deps, async (client) => {
      const { rows: sessionRows } = await client.query(
        `SELECT *
           FROM ai_roleplay_sessions
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE`,
        [normalizedSessionId, normalizedUserId],
      );
      const session = normalizeSession(sessionRows[0] || null);
      if (!session) fail('SESSION_NOT_FOUND');

      const { rows: existingRows } = await client.query(
        `SELECT *
           FROM ai_roleplay_turns
          WHERE session_id = $1
            AND turn_key = $2
          LIMIT 1`,
        [normalizedSessionId, normalizedTurnKey],
      );
      const existing = normalizeTurn(existingRows[0] || null);
      if (existing) {
        if (existing.status === 'completed') {
          return { kind: 'completed', session, turn: existing };
        }
        const stale = isStale(existing, deps.pendingTurnStaleAfterMs, deps.now());
        if (!stale) {
          return { kind: 'pending', session, turn: existing };
        }
        const { rows: refreshedRows } = await client.query(
          `UPDATE ai_roleplay_turns
              SET updated_at = NOW()
            WHERE session_id = $1
              AND turn_key = $2
              AND status = 'pending'
            RETURNING *`,
          [normalizedSessionId, normalizedTurnKey],
        );
        return { kind: 'claimed', session, turn: normalizeTurn(refreshedRows[0] || existing) };
      }

      if (session.status !== 'active') fail('SESSION_NOT_ACTIVE');
      if (session.turn_count >= session.turn_limit) fail('TURN_LIMIT_REACHED');

      const { rows: pendingRows } = await client.query(
        `SELECT *
           FROM ai_roleplay_turns
          WHERE session_id = $1
            AND status = 'pending'
          ORDER BY turn_index ASC
          LIMIT 1`,
        [normalizedSessionId],
      );
      if (pendingRows[0]) {
        return { kind: 'pending', session, turn: normalizeTurn(pendingRows[0]) };
      }

      const nextTurnIndex = session.turn_count + 1;
      const { rows: insertedRows } = await client.query(
        `INSERT INTO ai_roleplay_turns
           (session_id, turn_key, turn_index, learner_text, pronunciation_summary)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING *`,
        [
          normalizedSessionId,
          normalizedTurnKey,
          nextTurnIndex,
          transcript,
          jsonValue(pronunciationSummary),
        ],
      );
      return { kind: 'claimed', session, turn: normalizeTurn(insertedRows[0]) };
    });
  }

  async function finalizeAIRoleplayTurn({
    sessionId,
    userId,
    turnKey,
    result,
    missionProgress,
    modelUsed,
    latencyMs,
  }) {
    await ensureReady();
    const normalizedSessionId = canonicalDecimalId(sessionId, 'SESSION_ID_INVALID');
    const normalizedUserId = canonicalDecimalId(userId, 'USER_ID_INVALID');
    const normalizedTurnKey = canonicalUuidV4(turnKey);
    return withTransaction(deps, async (client) => {
      const { rows: sessionRows } = await client.query(
        `SELECT *
           FROM ai_roleplay_sessions
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE`,
        [normalizedSessionId, normalizedUserId],
      );
      const session = normalizeSession(sessionRows[0] || null);
      if (!session) fail('SESSION_NOT_FOUND');

      const { rows: existingRows } = await client.query(
        `SELECT *
           FROM ai_roleplay_turns
          WHERE session_id = $1
            AND turn_key = $2
          LIMIT 1`,
        [normalizedSessionId, normalizedTurnKey],
      );
      const existing = normalizeTurn(existingRows[0] || null);
      if (!existing) fail('TURN_NOT_FOUND');
      if (existing.status === 'completed') {
        return { session, turn: existing };
      }
      if (session.status !== 'active') {
        fail('SESSION_NOT_ACTIVE');
      }
      if (existing.status !== 'pending') {
        fail('TURN_NOT_PENDING');
      }

      const { rows: finalizedRows } = await client.query(
        `UPDATE ai_roleplay_turns
            SET status = 'completed',
                assistant_text = $1::jsonb #>> '{assistant,text}',
                assistant_translation_zh = $1::jsonb #>> '{assistant,translation_zh}',
                evaluation = $1::jsonb -> 'evaluation',
                turn_result = $1::jsonb,
                response_mode = CASE WHEN $3 = 'fallback' THEN 'fallback' ELSE 'ai' END,
                latency_ms = $4,
                updated_at = NOW()
          WHERE session_id = $5
            AND turn_key = $6
            AND status = 'pending'
          RETURNING *`,
        [
          result,
          jsonValue(missionProgress, {}),
          modelUsed,
          latencyMs,
          normalizedSessionId,
          normalizedTurnKey,
        ],
      );
      const finalizedTurn = normalizeTurn(finalizedRows[0] || null);
      if (!finalizedTurn) {
        fail('TURN_NOT_PENDING');
      }
      const { rows: updatedSessionRows } = await client.query(
        `UPDATE ai_roleplay_sessions
            SET turn_count = turn_count + 1,
                mission_progress = $1::jsonb,
                model_used = $2,
                updated_at = NOW()
          WHERE id = $3
            AND user_id = $4
          RETURNING *`,
        [jsonValue(missionProgress, {}), modelUsed, normalizedSessionId, normalizedUserId],
      );
      return { session: normalizeSession(updatedSessionRows[0] || session), turn: finalizedTurn };
    });
  }

  async function completeAIRoleplaySession({ sessionId, userId, reviewSummary }) {
    await ensureReady();
    const normalizedSessionId = canonicalDecimalId(sessionId, 'SESSION_ID_INVALID');
    const normalizedUserId = canonicalDecimalId(userId, 'USER_ID_INVALID');
    return withTransaction(deps, async (client) => {
      const { rows: sessionRows } = await client.query(
        `SELECT *
           FROM ai_roleplay_sessions
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE`,
        [normalizedSessionId, normalizedUserId],
      );
      const session = normalizeSession(sessionRows[0] || null);
      if (!session) fail('SESSION_NOT_FOUND');
      if (session.status === 'completed') return session;
      const { rows: pendingRows } = await client.query(
        `SELECT *
           FROM ai_roleplay_turns
          WHERE session_id = $1
            AND status = 'pending'
          ORDER BY turn_index ASC
          LIMIT 1`,
        [normalizedSessionId],
      );
      if (pendingRows[0]) fail('TURN_IN_PROGRESS');
      const { rows } = await client.query(
        `UPDATE ai_roleplay_sessions
            SET status = 'completed',
                review_summary = $1::jsonb,
                completed_at = NOW(),
                updated_at = NOW()
          WHERE id = $2
            AND user_id = $3
          RETURNING *`,
        [jsonValue(reviewSummary, {}), normalizedSessionId, normalizedUserId],
      );
      return normalizeSession(rows[0]);
    });
  }

  async function getAIRoleplayPronunciationSummaryForUser(assessmentId, userId) {
    await ensureReady();
    const normalizedAssessmentId = canonicalDecimalId(assessmentId, 'ASSESSMENT_ID_INVALID');
    const normalizedUserId = canonicalDecimalId(userId, 'USER_ID_INVALID');
    const { rows } = await deps.pool.query(
      `SELECT id, user_id, overall, accuracy, fluency, completeness, coaching
         FROM user_pronunciation_assessments
        WHERE id = $1
          AND user_id = $2
        LIMIT 1`,
      [normalizedAssessmentId, normalizedUserId],
    );
    const row = rows[0];
    if (!row) return null;
    const coaching = row.coaching && typeof row.coaching === 'object' && !Array.isArray(row.coaching)
      ? row.coaching
      : {};
    const overall = Number(row.overall);
    const fallback = Number.isFinite(overall) ? `发音评分 ${Math.round(overall)}。` : '发音评估已保存。';
    return {
      trusted: true,
      owned_by_user: true,
      credible: true,
      assessment_id: String(row.id),
      summary: normalizeBoundedSummary(coaching.summary_zh || coaching.summary || fallback),
    };
  }

  return {
    listAIRoleplayScenarios,
    getAIRoleplayScenario,
    createAIRoleplaySession,
    getAIRoleplaySessionForUser,
    listAIRoleplayTurnsForUser,
    claimAIRoleplayTurn,
    finalizeAIRoleplayTurn,
    completeAIRoleplaySession,
    getAIRoleplayPronunciationSummaryForUser,
  };
}

module.exports = {
  createAIRoleplayRepositoryWithDeps,
  ...createAIRoleplayRepositoryWithDeps(defaultDependencies),
};
