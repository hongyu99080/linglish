const { pool, init, dbUnavailable } = require('../core');

const defaultDependencies = { pool, init, dbUnavailable };
const PRONUNCIATION_SKILL_COLUMNS = `skill_type, target_key, display_target, evidence_level, attempt_count,
       issue_count, success_count, success_streak, ema_score, confidence, status, next_review_at,
       last_assessment_id, video_resource_id, sample_text, last_issue_at, last_success_at, created_at, updated_at`;

async function savePronunciationAssessmentWithDeps(dependencies, userId, payload) {
  const deps = dependencies || defaultDependencies;
  await deps.init();
  if (deps.dbUnavailable()) return null;
  const {
    lemma = null,
    video_resource_id = null,
    text,
    audio_path = null,
    overall = null,
    accuracy = null,
    fluency = null,
    completeness = null,
    words = null,
    phonemes = null,
    provider = 'local',
    coaching = null,
    analysis_version = null,
    duration_seconds = null,
    speech_rate_wpm = null,
  } = payload;
  const { rows } = await deps.pool.query(
    `INSERT INTO user_pronunciation_assessments
       (user_id, video_resource_id, lemma, text, audio_path, overall, accuracy, fluency, completeness, words, phonemes, provider,
        coaching, analysis_version, duration_seconds, speech_rate_wpm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,$14,$15,$16)
     RETURNING *`,
    [
      userId,
      video_resource_id,
      lemma,
      text,
      audio_path,
      overall,
      accuracy,
      fluency,
      completeness,
      words ? JSON.stringify(words) : null,
      phonemes ? JSON.stringify(phonemes) : null,
      provider,
      coaching ? JSON.stringify(coaching) : null,
      analysis_version,
      Number.isFinite(Number(duration_seconds)) ? Number(duration_seconds) : null,
      Number.isFinite(Number(speech_rate_wpm)) ? Number(speech_rate_wpm) : null,
    ]
  );
  return rows[0] || null;
}

async function savePronunciationAssessment(userId, payload) {
  return savePronunciationAssessmentWithDeps(defaultDependencies, userId, payload);
}

function normalizedSkillLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

async function listPronunciationSkillsWithDeps(dependencies, userId, { limit = 20, includeStable = false } = {}) {
  const deps = dependencies || defaultDependencies;
  await deps.init();
  if (deps.dbUnavailable()) return [];
  const values = [userId];
  const where = ['user_id = $1'];
  if (!includeStable) where.push("status <> 'stable'");
  values.push(normalizedSkillLimit(limit));
  const { rows } = await deps.pool.query(
    `SELECT ${PRONUNCIATION_SKILL_COLUMNS}
       FROM user_pronunciation_skills
      WHERE ${where.join(' AND ')}
      ORDER BY next_review_at ASC NULLS LAST,
               updated_at DESC
      LIMIT $2`,
    values,
  );
  return rows;
}

async function listPronunciationSkills(userId, options) {
  return listPronunciationSkillsWithDeps(defaultDependencies, userId, options);
}

async function upsertPronunciationSkillOn(queryable, userId, state) {
  const {
    skill_type,
    target_key,
    display_target,
    evidence_level,
    attempt_count,
    issue_count,
    success_count,
    success_streak,
    ema_score,
    confidence,
    status,
    next_review_at,
    last_assessment_id,
    video_resource_id,
    sample_text,
    last_issue_at,
    last_success_at,
    created_at,
    updated_at,
  } = state;
  const { rows } = await queryable.query(
    `INSERT INTO user_pronunciation_skills
       (user_id, skill_type, target_key, display_target, evidence_level, attempt_count, issue_count,
        success_count, success_streak, ema_score, confidence, status, next_review_at, last_assessment_id,
        video_resource_id, sample_text, last_issue_at, last_success_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (user_id, skill_type, target_key)
     DO UPDATE SET display_target = EXCLUDED.display_target,
                   evidence_level = EXCLUDED.evidence_level,
                   attempt_count = EXCLUDED.attempt_count,
                   issue_count = EXCLUDED.issue_count,
                   success_count = EXCLUDED.success_count,
                   success_streak = EXCLUDED.success_streak,
                   ema_score = EXCLUDED.ema_score,
                   confidence = EXCLUDED.confidence,
                   status = EXCLUDED.status,
                   next_review_at = EXCLUDED.next_review_at,
                   last_assessment_id = EXCLUDED.last_assessment_id,
                   video_resource_id = EXCLUDED.video_resource_id,
                   sample_text = EXCLUDED.sample_text,
                   last_issue_at = EXCLUDED.last_issue_at,
                   last_success_at = EXCLUDED.last_success_at,
                   updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      userId, skill_type, target_key, display_target, evidence_level, attempt_count, issue_count,
      success_count, success_streak, ema_score, confidence, status, next_review_at, last_assessment_id,
      video_resource_id, sample_text, last_issue_at, last_success_at, created_at, updated_at,
    ],
  );
  return rows[0] || null;
}

async function upsertPronunciationSkillWithDeps(dependencies, userId, state) {
  const deps = dependencies || defaultDependencies;
  await deps.init();
  if (deps.dbUnavailable()) return null;
  return upsertPronunciationSkillOn(deps.pool, userId, state);
}

async function upsertPronunciationSkill(userId, state) {
  return upsertPronunciationSkillWithDeps(defaultDependencies, userId, state);
}

async function withPronunciationSkillTransactionWithDeps(dependencies, userId, work) {
  const deps = dependencies || defaultDependencies;
  await deps.init();
  if (deps.dbUnavailable()) return null;
  if (typeof work !== 'function') throw new TypeError('transaction work must be a function');
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const transaction = {
      async listPronunciationSkillsForUpdate() {
        const { rows } = await client.query(
          `SELECT ${PRONUNCIATION_SKILL_COLUMNS}
             FROM user_pronunciation_skills
            WHERE user_id = $1
            ORDER BY next_review_at ASC NULLS LAST, updated_at DESC
            FOR UPDATE`,
          [userId],
        );
        return rows;
      },
      upsertPronunciationSkill(innerUserId, state) {
        return upsertPronunciationSkillOn(client, innerUserId, state);
      },
    };
    const result = await work(transaction);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    throw error;
  } finally {
    client.release();
  }
}

async function withPronunciationSkillTransaction(userId, work) {
  return withPronunciationSkillTransactionWithDeps(defaultDependencies, userId, work);
}

async function getPronunciationAssessmentFocusWithDeps(dependencies, userId, assessmentId) {
  const deps = dependencies || defaultDependencies;
  await deps.init();
  if (deps.dbUnavailable()) return null;
  const { rows } = await deps.pool.query(
    `SELECT id, video_resource_id, text, coaching -> 'next_action' AS next_action
       FROM user_pronunciation_assessments
      WHERE user_id = $1 AND id = $2`,
    [userId, assessmentId],
  );
  return rows[0] || null;
}

async function getPronunciationAssessmentFocus(userId, assessmentId) {
  return getPronunciationAssessmentFocusWithDeps(defaultDependencies, userId, assessmentId);
}

async function bumpPronunciationPhoneme(userId, phoneme, inc = 1) {
  await init();
  if (dbUnavailable()) return null;
  const { rows } = await pool.query(
    `INSERT INTO user_pronunciation_focus (user_id, phoneme, issue_count, last_seen_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (user_id, phoneme)
     DO UPDATE SET issue_count = user_pronunciation_focus.issue_count + EXCLUDED.issue_count,
                   last_seen_at = NOW()
     RETURNING *`,
    [userId, phoneme, inc]
  );
  return rows[0] || null;
}

async function listPronunciationAssessments(userId, { lemma = null, videoId = null, limit = 20, offset = 0 } = {}) {
  await init();
  if (dbUnavailable()) return [];
  const where = ['user_id = $1'];
  const values = [userId];
  let i = 2;
  if (lemma) { where.push(`lemma = $${i++}`); values.push(lemma); }
  if (videoId) { where.push(`video_resource_id = $${i++}`); values.push(videoId); }
  values.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM user_pronunciation_assessments
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${i} OFFSET $${i + 1}`,
    values
  );
  return rows;
}

async function listPronunciationFocus(userId, { limit = 10 } = {}) {
  await init();
  if (dbUnavailable()) return [];
  const { rows } = await pool.query(
    `SELECT phoneme, issue_count, last_seen_at
       FROM user_pronunciation_focus
      WHERE user_id = $1
      ORDER BY issue_count DESC, last_seen_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function countPronunciationAssessments(userId, { lemma = null } = {}) {
  await init();
  if (dbUnavailable()) return 0;
  const where = ['user_id = $1'];
  const values = [userId];
  let i = 2;
  if (lemma) { where.push(`lemma = $${i++}`); values.push(lemma); }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM user_pronunciation_assessments WHERE ${where.join(' AND ')}`,
    values
  );
  return rows[0]?.c || 0;
}

async function countPronunciationAssessmentsToday(userId) {
  await init();
  if (dbUnavailable()) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM user_pronunciation_assessments
      WHERE user_id = $1
        AND created_at >= date_trunc('day', NOW())
        AND created_at < date_trunc('day', NOW()) + INTERVAL '1 day'`,
    [userId],
  );
  return rows[0]?.c || 0;
}

async function getPronunciationSummaryAll() {
  await init();
  if (dbUnavailable()) return { avg_overall: 0, count: 0 };
  const { rows } = await pool.query(
    `SELECT COALESCE(AVG(overall),0)::int AS avg_overall,
            COUNT(*)::int AS count
       FROM user_pronunciation_assessments`
  );
  return rows[0] || { avg_overall: 0, count: 0 };
}

async function getTopPhonemesAll(limit = 10) {
  await init();
  if (dbUnavailable()) return [];
  const { rows } = await pool.query(
    `SELECT phoneme, SUM(issue_count)::int AS issues
       FROM user_pronunciation_focus
      GROUP BY phoneme
      ORDER BY issues DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getPronunciationDailyAverages(days = 14) {
  await init();
  if (dbUnavailable()) return [];
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COALESCE(AVG(overall),0)::int AS avg_overall,
            COUNT(*)::int AS count
       FROM user_pronunciation_assessments
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 1`,
    [String(days)]
  );
  return rows;
}

async function getPronunciationDailyForUser(userId, days = 14) {
  await init();
  if (dbUnavailable()) return [];
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COALESCE(AVG(overall),0)::int AS avg_overall,
            COUNT(*)::int AS count
       FROM user_pronunciation_assessments
      WHERE user_id = $1
        AND created_at >= NOW() - ($2 || ' days')::interval
      GROUP BY 1
      ORDER BY 1`,
    [userId, String(days)]
  );
  return rows;
}

module.exports = {
  savePronunciationAssessment,
  savePronunciationAssessmentWithDeps,
  listPronunciationSkills,
  listPronunciationSkillsWithDeps,
  upsertPronunciationSkill,
  upsertPronunciationSkillWithDeps,
  withPronunciationSkillTransaction,
  withPronunciationSkillTransactionWithDeps,
  getPronunciationAssessmentFocus,
  getPronunciationAssessmentFocusWithDeps,
  bumpPronunciationPhoneme,
  listPronunciationAssessments,
  listPronunciationFocus,
  countPronunciationAssessments,
  countPronunciationAssessmentsToday,
  getPronunciationSummaryAll,
  getTopPhonemesAll,
  getPronunciationDailyAverages,
  getPronunciationDailyForUser,
};
