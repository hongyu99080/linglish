// app/backend/services/plan-feedback.js
'use strict';

const { pool } = require('../data-store/core');

const VALID_ITEM_TYPES = ['watch', 'shadowing', 'review', 'overall'];
const VALID_ACTIONS = ['completed', 'skipped', 'too_hard', 'too_easy', 'boring', 'rating'];
const FEEDBACK_WINDOW_DAYS = 14;
const HARD_THRESHOLD = 2;
const BORING_THRESHOLD = 3;
const MIN_TYPE_WEIGHT = 0.5; // 降权下限:防单一反馈把类型打没

const CLIENT_ID_MAX_LEN = 64;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// 离线队列重放的幂等ID:只对非 rating 行有意义(rating 已由"每日一条"唯一索引兜底)
function normalizeClientId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > CLIENT_ID_MAX_LEN) return null;
  return CLIENT_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function validateFeedback(body) {
  if (!body || typeof body !== 'object') return null;
  const itemType = body.itemType;
  const action = body.action;
  if (!VALID_ITEM_TYPES.includes(itemType) || !VALID_ACTIONS.includes(action)) return null;
  if (action === 'rating') {
    const rating = Math.floor(Number(body.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return null;
    return { itemType, action, rating, clientId: null };
  }
  return { itemType, action, rating: null, clientId: normalizeClientId(body.clientId) };
}

function computeAdjustments(rows) {
  const count = (fn) => rows.filter(fn).length;
  const tooHard = count(r => r.action === 'too_hard');
  const tooEasy = count(r => r.action === 'too_easy');
  let difficultyShift = 0;
  if (tooHard >= HARD_THRESHOLD) difficultyShift -= 1;
  if (tooEasy >= HARD_THRESHOLD) difficultyShift += 1; // 双向都触发时抵消为 0

  const typePenalty = { watch: 1, shadowing: 1, review: 1 };
  for (const type of Object.keys(typePenalty)) {
    const negatives = count(r => r.item_type === type && (r.action === 'boring' || r.action === 'skipped'));
    if (negatives >= BORING_THRESHOLD) typePenalty[type] = MIN_TYPE_WEIGHT;
  }

  const ratings = rows.filter(r => r.action === 'rating' && r.rating != null).map(r => Number(r.rating));
  const avg = ratings.length ? ratings.reduce((s, v) => s + v, 0) / ratings.length : null;

  return {
    difficultyShift,
    typePenalty,
    wantDiversity: avg !== null && avg < 3,
    hasFeedback: rows.length > 0,
  };
}

async function saveFeedback(userId, { itemType, action, rating, clientId = null }) {
  if (action === 'rating') {
    const r = await pool.query(
      `INSERT INTO plan_feedback (user_id, item_type, action, rating)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, plan_date) WHERE action = 'rating' DO NOTHING
       RETURNING *`,
      [userId, itemType, action, rating]
    );
    if (r.rowCount === 0) {
      const err = new Error('RATING_ALREADY_SUBMITTED');
      err.statusCode = 409;
      throw err;
    }
    return r.rows[0];
  }
  // 带 clientId 时走幂等写入:离线队列重放(请求已提交但响应丢失)不会产生第二行,
  // 否则一次"太难了"会被计成两次,刚好触到 HARD_THRESHOLD 并把难度降一档 14 天
  if (clientId) {
    const r = await pool.query(
      `INSERT INTO plan_feedback (user_id, item_type, action, rating, client_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [userId, itemType, action, rating, clientId]
    );
    if (r.rowCount > 0) return r.rows[0];
    const existing = await pool.query(
      `SELECT * FROM plan_feedback WHERE user_id = $1 AND client_id = $2`,
      [userId, clientId]
    );
    return existing.rows[0] || null;
  }

  const r = await pool.query(
    `INSERT INTO plan_feedback (user_id, item_type, action, rating)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, itemType, action, rating]
  );
  return r.rows[0];
}

async function getAdjustments(userId) {
  const r = await pool.query(
    `SELECT item_type, action, rating FROM plan_feedback
      WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
    [userId, FEEDBACK_WINDOW_DAYS]
  );
  return computeAdjustments(r.rows);
}

module.exports = { validateFeedback, computeAdjustments, saveFeedback, getAdjustments };
