// app/backend/test/learning-plan-recommendation.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const dataStore = require('../data-store');
const learningPlan = require('../services/learning-plan');

const VIDEOS = [
  { id: 1, title: 'Office talk', difficulty_level: 'beginner', tags: ['职场'], tags_joined: null, practice_count: 30, view_count: 100, duration_sec: 300, uploader_id: 1 },
  { id: 2, title: 'Meeting', difficulty_level: 'beginner', tags: [], tags_joined: ['职场'], practice_count: 1, view_count: 5, duration_sec: 300, uploader_id: 1 },
  { id: 3, title: 'Travel', difficulty_level: 'beginner', tags: ['旅行'], tags_joined: null, practice_count: 10, view_count: 50, duration_sec: 300, uploader_id: 1 },
  { id: 4, title: 'Private', difficulty_level: 'beginner', tags: ['我的'], tags_joined: null, practice_count: 99, view_count: 999, duration_sec: 300, uploader_id: 42 },
];

function stubQuery({ watched = [] } = {}) {
  const original = dataStore.query;
  dataStore.query = async (sql) => {
    if (sql.includes('FROM events')) return { rows: watched.map(id => ({ video_id: String(id) })) };
    if (sql.includes('FROM video_resources vr') && sql.includes('vr.id::text = $1')) return { rows: [] };
    if (sql.includes('FROM video_resources vr')) return { rows: VIDEOS };
    return { rows: [] };
  };
  return () => { dataStore.query = original; };
}

test('getRecommendedVideos: 游客可用，不含他人私有视频，带 slot 与 watched', async () => {
  const restore = stubQuery();
  try {
    const result = await learningPlan.getRecommendedVideos(null, 5);
    assert.equal(result.userLevel, 'beginner');
    assert.ok(!result.videos.some(v => v.id === 4));
    assert.ok(result.videos.every(v => v.slot === 'today' && v.watched === false));
  } finally {
    restore();
  }
});

test('getRecommendedVideos: 已看过的排到最后，目标标签命中计入 matchedVideos', async () => {
  const restore = stubQuery({ watched: [1] });
  try {
    const result = await learningPlan.getRecommendedVideos(7, 3, {
      userLevel: { level: 'beginner', profile: { interests: ['职场沟通'] } },
    });
    assert.equal(result.videos[0].id, 2);
    assert.equal(result.videos[0].recommendationReason, '匹配你的目标「职场沟通」');
    assert.equal(result.videos.at(-1).id, 1);
    assert.equal(result.videos.at(-1).watched, true);
    assert.equal(result.personalization.matchedVideos, 1);
    assert.deepEqual(result.videos[0].tags, ['职场']);
  } finally {
    restore();
  }
});

test('getNextVideo: 推荐与当前视频同标签的下一个', async () => {
  const restore = stubQuery();
  try {
    const result = await learningPlan.getNextVideo(null, '1', 1);
    assert.equal(result.afterId, '1');
    assert.equal(result.videos.length, 1);
    assert.equal(result.videos[0].id, 2);
    assert.equal(result.videos[0].slot, 'next');
    assert.equal(result.videos[0].recommendationReason, '和你刚看的都是「职场」');
  } finally {
    restore();
  }
});

test('getNextVideo: 找不到当前视频时退回普通推荐', async () => {
  const restore = stubQuery();
  try {
    const result = await learningPlan.getNextVideo(null, '999', 1);
    assert.equal(result.afterId, '999');
    assert.equal(result.videos.length, 1);
    assert.equal(result.videos[0].slot, 'next');
  } finally {
    restore();
  }
});
