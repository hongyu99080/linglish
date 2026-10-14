'use strict';

const { pool } = require('../data-store/core');
const { calculateNextReview, getNextReviewDate } = require('./spaced-repetition');

// 必须与 spaced-repetition.js 的 RATING 常量对齐:
// {AGAIN:1, HARD:2, GOOD:3, EASY:4, PERFECT:5}。错位一档会让"太难了"落进 GOOD 分支、
// 反而拉长间隔,并使 HARD 的减半分支永远不可达。
const QUALITY_TO_RATING = { again: 1, hard: 2, good: 3, easy: 4 };
const OUTCOME_TO_QUALITY = {
  fail: 'again', pass: 'good', success: 'good',
  mastered: 'easy', master: 'easy', easy: 'easy',
};
// 用户显式声明"完全掌握"的 outcome(区别于四档按钮直接发的 quality:'easy'):
// 显式意图优先于算法阈值,与 legacy applyReviewOutcome 的行为一致
const EXPLICIT_MASTERY_OUTCOMES = ['mastered', 'master'];
const STATE_TO_STATUS = {
  new: 'learning', learning: 'learning', relearning: 'learning',
  reviewing: 'reviewing', mastered: 'mastered',
};

function isExplicitMastery({ outcome } = {}) {
  return EXPLICIT_MASTERY_OUTCOMES.includes(outcome);
}

function resolveQuality({ quality, outcome } = {}) {
  if (quality && QUALITY_TO_RATING[quality]) return quality;
  if (outcome && OUTCOME_TO_QUALITY[outcome]) return OUTCOME_TO_QUALITY[outcome];
  return null;
}

async function reviewByLemma(userId, { lemma, quality, explicitMastery = false }) {
  const rating = QUALITY_TO_RATING[quality];
  if (!rating) {
    const err = new Error('INVALID_QUALITY');
    err.statusCode = 400;
    throw err;
  }
  const normalizedLemma = (lemma || '').trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const uvRes = await client.query(
      `SELECT id, word, status FROM user_vocabulary
        WHERE user_id = $1 AND LOWER(word) = $2 FOR UPDATE`,
      [userId, normalizedLemma]
    );
    if (uvRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const uv = uvRes.rows[0];

    // 找或建调度行(review_schedule 有 UNIQUE(user_id, item_type, item_id))
    let sched = (await client.query(
      `SELECT * FROM review_schedule
        WHERE user_id = $1 AND item_type = 'vocabulary' AND item_id = $2 FOR UPDATE`,
      [userId, uv.id]
    )).rows[0];
    if (!sched) {
      sched = (await client.query(
        `INSERT INTO review_schedule
           (user_id, item_type, item_id, lemma, ease_factor, interval_days, repetitions, state)
         VALUES ($1, 'vocabulary', $2, $3, 2.5, 1, 0, 'new')
         ON CONFLICT (user_id, item_type, item_id) DO UPDATE SET lemma = EXCLUDED.lemma
         RETURNING *`,
        [userId, uv.id, normalizedLemma]
      )).rows[0];
    }

    const next = calculateNextReview(
      parseFloat(sched.interval_days) || 1,
      parseFloat(sched.ease_factor) || 2.5,
      parseInt(sched.repetitions, 10) || 0,
      rating
    );
    // 显式"完全掌握"直接置为 mastered:间隔/EF/重复次数仍由 SM-2 计算,
    // 只覆盖 state(SM-2 的掌握阈值需 interval>180 且 reps>=8,新词永远达不到)
    const nextState = explicitMastery ? 'mastered' : next.state;
    const nextReviewAt = getNextReviewDate(next.interval);
    const isCorrect = rating >= 3;
    const isLapse = rating <= 2 && sched.state !== 'new';

    const schedule = (await client.query(
      `UPDATE review_schedule SET
         ease_factor = $3, interval_days = $4, repetitions = $5, state = $6,
         last_review_at = NOW(), next_review_at = $7, due_date = ($8::timestamp)::date,
         total_reviews = total_reviews + 1,
         correct_reviews = correct_reviews + $9,
         lapses = lapses + $10,
         updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [sched.id, userId, next.easeFactor, next.interval, next.repetitions, nextState,
       nextReviewAt, nextReviewAt, isCorrect ? 1 : 0, isLapse ? 1 : 0]
    )).rows[0];

    await client.query(
      `INSERT INTO review_history
         (schedule_id, user_id, review_time, rating,
          ease_factor_before, ease_factor_after,
          interval_days_before, interval_days_after, next_review_at)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8)`,
      [sched.id, userId, rating, sched.ease_factor, next.easeFactor,
       sched.interval_days, next.interval, nextReviewAt]
    );

    // 投影回 user_vocabulary(展示层;ease DECIMAL(3,2) 上限 9.99)
    const item = (await client.query(
      `UPDATE user_vocabulary SET
         status = $3, ease_factor = $4, interval_days = $5,
         next_review_at = $6, last_reviewed_at = NOW(),
         review_count = review_count + 1,
         correct_count = correct_count + $7,
         wrong_count = wrong_count + $8
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [uv.id, userId, STATE_TO_STATUS[nextState] || 'learning',
       Math.min(9.99, next.easeFactor), Math.round(next.interval), nextReviewAt,
       isCorrect ? 1 : 0, isCorrect ? 0 : 1]
    )).rows[0];

    await client.query('COMMIT');
    return { item, schedule };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getDueQueue(userId, limit = 10) {
  const due = await pool.query(
    `SELECT uv.word AS lemma, uv.status AS state, uv.review_count AS exposures,
            rs.ease_factor, rs.interval_days, rs.next_review_at,
            w.definitions, w.phonetic
       FROM review_schedule rs
       JOIN user_vocabulary uv ON uv.id = rs.item_id AND uv.user_id = rs.user_id
       LEFT JOIN words w ON w.id = uv.word_id
      WHERE rs.user_id = $1 AND rs.item_type = 'vocabulary'
        AND rs.state != 'mastered'
        AND (rs.next_review_at IS NULL OR rs.next_review_at <= NOW())
      ORDER BY CASE rs.state
                 WHEN 'relearning' THEN 0 WHEN 'learning' THEN 1
                 WHEN 'reviewing' THEN 2 ELSE 3 END,
               rs.next_review_at ASC NULLS FIRST
      LIMIT $2`,
    [userId, limit]
  );
  if (due.rows.length >= limit) return due.rows;

  // 新词补位:已收藏但尚未进入调度的词
  const fill = await pool.query(
    `SELECT uv.word AS lemma, uv.status AS state, uv.review_count AS exposures,
            uv.ease_factor, uv.interval_days, uv.next_review_at,
            w.definitions, w.phonetic
       FROM user_vocabulary uv
       LEFT JOIN words w ON w.id = uv.word_id
      WHERE uv.user_id = $1 AND uv.status <> 'mastered'
        AND NOT EXISTS (
          SELECT 1 FROM review_schedule rs
           WHERE rs.user_id = uv.user_id
             AND rs.item_type = 'vocabulary' AND rs.item_id = uv.id)
      ORDER BY uv.first_seen_at DESC
      LIMIT $2`,
    [userId, limit - due.rows.length]
  );
  return [...due.rows, ...fill.rows];
}

async function getDueCount(userId) {
  const r = await pool.query(
    `SELECT COUNT(*) AS c
       FROM review_schedule
      WHERE user_id = $1 AND item_type = 'vocabulary'
        AND state != 'mastered'
        AND (next_review_at IS NULL OR next_review_at <= NOW())`,
    [userId]
  );
  return parseInt(r.rows[0].c, 10);
}

module.exports = {
  QUALITY_TO_RATING, OUTCOME_TO_QUALITY, STATE_TO_STATUS, EXPLICIT_MASTERY_OUTCOMES,
  resolveQuality, isExplicitMastery, reviewByLemma, getDueQueue, getDueCount,
};
