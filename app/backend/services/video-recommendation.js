/**
 * Video Recommendation Service
 *
 * 推荐排序:排除已看过、按目标标签匹配兴趣、按反馈调整难度,
 * 以及看完一个视频后的「下一个」推荐。
 */

'use strict';

const dataStore = require('../data-store');

const LEVEL_ORDER = ['beginner', 'intermediate', 'advanced'];
const WATCHED_THRESHOLD_SEC = 60;
const SHORT_VIDEO_SEC = 900;
const CANDIDATE_POOL_LIMIT = 200;
const PRIVATE_TAG = '我的';

// 入门目标 → 现有视频标签
const GOAL_TAGS = {
  '面试准备': ['职场', '演讲', '播客访谈'],
  '出国留学': ['课程', '校园', '演讲'],
  '职场沟通': ['职场', '播客访谈', '演讲'],
  '日常交流': ['生活', '旅行', '购物', '情感', '影视'],
  '考试提升': ['课程', '词汇', '演讲'],
};

const SCORE = {
  goalTag: 50,
  levelMatch: 40,
  levelUnknown: 18,
  levelOther: 8,
  sharedTag: 45,
  sharedTagExtra: 5,
  shortVideo: 8,
  practiceWeight: 0.6,
  practiceCap: 50,
  viewWeight: 0.08,
  viewCap: 200,
};

function toInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function parseTagList(tags) {
  if (Array.isArray(tags)) return tags.map(String).map(t => t.trim()).filter(Boolean);
  if (!tags || typeof tags !== 'string') return [];
  try {
    const parsed = JSON.parse(tags);
    if (Array.isArray(parsed)) return parseTagList(parsed);
  } catch (_) { /* 非 JSON,按逗号分隔 */ }
  return tags.replace(/^\{|\}$/g, '').split(',').map(t => t.replace(/"/g, '').trim()).filter(Boolean);
}

function collectTags(row) {
  return Array.from(new Set([...parseTagList(row.tags), ...parseTagList(row.tags_joined)]));
}

function isVisibleTo(row, userId) {
  if (!collectTags(row).includes(PRIVATE_TAG)) return true;
  return userId != null && String(row.uploader_id) === String(userId);
}

function normalizeLevel(value) {
  const raw = String(value || '').trim().toLowerCase();
  return LEVEL_ORDER.includes(raw) ? raw : null;
}

function shiftLevel(level, shift) {
  const idx = LEVEL_ORDER.indexOf(normalizeLevel(level) || 'beginner');
  const next = Math.min(LEVEL_ORDER.length - 1, Math.max(0, idx + (toInt(shift) || 0)));
  return LEVEL_ORDER[next];
}

function goalTagsFor(interests = []) {
  const tags = new Set();
  for (const goal of interests) {
    for (const tag of GOAL_TAGS[String(goal || '').trim()] || []) tags.add(tag);
  }
  return Array.from(tags);
}

function levelScore(row, level) {
  const difficulty = normalizeLevel(row.difficulty_level);
  if (!difficulty) return SCORE.levelUnknown;
  return difficulty === level ? SCORE.levelMatch : SCORE.levelOther;
}

function popularityScore(row) {
  const duration = toInt(row.duration_sec);
  return Math.min(toInt(row.practice_count), SCORE.practiceCap) * SCORE.practiceWeight
    + Math.min(toInt(row.view_count), SCORE.viewCap) * SCORE.viewWeight
    + (duration > 0 && duration <= SHORT_VIDEO_SEC ? SCORE.shortVideo : 0);
}

// 未看过的永远排在看过的前面;看过的只做补位
function sortScored(scored) {
  return scored.sort((a, b) => {
    if (a.watched !== b.watched) return a.watched ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return toInt(b.row.practice_count) - toInt(a.row.practice_count);
  });
}

function rankCandidates(rows, context, limit) {
  const { level = 'beginner', interests = [], watchedIds = new Set(), userId = null } = context;
  const goalTags = goalTagsFor(interests);

  const scored = rows.filter(row => isVisibleTo(row, userId)).map((row) => {
    const tags = collectTags(row);
    const goalHit = goalTags.some(tag => tags.includes(tag));
    const watched = watchedIds.has(String(row.id));
    let reason = '适合今天先完成一轮训练';
    if (watched) reason = '再练一遍';
    else if (goalHit && interests.length) reason = `匹配你的目标「${interests[0]}」`;
    else if (normalizeLevel(row.difficulty_level) === level) reason = '匹配你的学习等级';
    else if (toInt(row.practice_count) > 0) reason = '已有学习者完成过跟读';

    return {
      row,
      watched,
      reason,
      score: (goalHit ? SCORE.goalTag : 0) + levelScore(row, level) + popularityScore(row),
    };
  });

  return sortScored(scored).slice(0, limit);
}

function rankNextCandidates(rows, anchor, context, limit) {
  const { watchedIds = new Set(), userId = null } = context;
  const anchorTags = collectTags(anchor).filter(tag => tag !== PRIVATE_TAG);
  const level = normalizeLevel(anchor.difficulty_level) || context.level || 'beginner';

  const scored = rows
    .filter(row => String(row.id) !== String(anchor.id) && isVisibleTo(row, userId))
    .map((row) => {
      const shared = collectTags(row).filter(tag => anchorTags.includes(tag));
      const watched = watchedIds.has(String(row.id));
      let reason = '接着练下一个';
      if (watched) reason = '再练一遍';
      else if (shared.length) reason = `和你刚看的都是「${shared[0]}」`;
      else if (normalizeLevel(row.difficulty_level) === level) reason = '难度和刚才一样';

      const sharedScore = shared.length
        ? SCORE.sharedTag + (Math.min(shared.length, 4) - 1) * SCORE.sharedTagExtra
        : 0;
      return {
        row,
        watched,
        reason,
        score: sharedScore + levelScore(row, level) + popularityScore(row),
      };
    });

  return sortScored(scored).slice(0, limit);
}

async function loadCandidates(userId) {
  const result = await dataStore.query(`
    SELECT
      vr.id, vr.title, vr.description, vr.thumbnail_path, vr.duration_sec,
      vr.difficulty_level, vr.word_count, vr.unique_word_count,
      vr.view_count, vr.practice_count, vr.category, vr.tags, vr.uploader_id,
      (
        SELECT jsonb_agg(t.name)
        FROM video_tags vt
        JOIN tags t ON t.id = vt.tag_id
        WHERE vt.video_id = vr.id
      ) AS tags_joined
    FROM video_resources vr
    WHERE vr.status = 'ready'
      AND (vr.is_public = true OR vr.uploader_id = $1)
    ORDER BY vr.practice_count DESC NULLS LAST, vr.view_count DESC NULLS LAST, vr.created_at DESC
    LIMIT $2
  `, [userId, CANDIDATE_POOL_LIMIT]);
  return result.rows;
}

async function loadWatchedIds(userId) {
  if (!userId) return new Set();
  try {
    const result = await dataStore.query(`
      SELECT properties->>'video_resource_id' AS video_id
      FROM events
      WHERE user_id = $1
        AND event_name = 'video_watch'
        AND properties ? 'video_resource_id'
      GROUP BY properties->>'video_resource_id'
      HAVING SUM(COALESCE((properties->>'seconds')::numeric, 0)) >= $2
    `, [userId, WATCHED_THRESHOLD_SEC]);
    return new Set(result.rows.map(row => String(row.video_id)));
  } catch (err) {
    console.warn('[VideoRecommendation] watched lookup failed, skipping filter:', err.message);
    return new Set();
  }
}

module.exports = {
  GOAL_TAGS,
  WATCHED_THRESHOLD_SEC,
  collectTags,
  isVisibleTo,
  shiftLevel,
  goalTagsFor,
  rankCandidates,
  rankNextCandidates,
  loadCandidates,
  loadWatchedIds,
};
