// app/backend/test/video-recommendation.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectTags,
  isVisibleTo,
  shiftLevel,
  goalTagsFor,
  rankCandidates,
  rankNextCandidates,
} = require('../services/video-recommendation');

function video(id, extra = {}) {
  return {
    id,
    title: `Video ${id}`,
    description: '',
    difficulty_level: 'beginner',
    duration_sec: 300,
    practice_count: 0,
    view_count: 0,
    tags: [],
    tags_joined: null,
    uploader_id: 1,
    ...extra,
  };
}

test('collectTags: 合并 tags 列与 video_tags 关联并去重', () => {
  const tags = collectTags(video(1, { tags: ['生活', '职场'], tags_joined: ['职场', '演讲'] }));
  assert.deepEqual(tags.sort(), ['演讲', '生活', '职场'].sort());
});

test('collectTags: 兼容 JSON 字符串和空值', () => {
  assert.deepEqual(collectTags(video(1, { tags: '["旅行"]' })), ['旅行']);
  assert.deepEqual(collectTags(video(1, { tags: null })), []);
});

test('isVisibleTo: 「我的」标签只对上传者可见', () => {
  const mine = video(1, { tags: ['我的'], uploader_id: 7 });
  assert.equal(isVisibleTo(mine, 7), true);
  assert.equal(isVisibleTo(mine, 8), false);
  assert.equal(isVisibleTo(mine, null), false);
  assert.equal(isVisibleTo(video(2, { tags: ['生活'] }), null), true);
});

test('shiftLevel: 按反馈调一档并封顶', () => {
  assert.equal(shiftLevel('beginner', -1), 'beginner');
  assert.equal(shiftLevel('beginner', 1), 'intermediate');
  assert.equal(shiftLevel('advanced', 1), 'advanced');
  assert.equal(shiftLevel('intermediate', 0), 'intermediate');
});

test('goalTagsFor: 目标映射到已有标签', () => {
  assert.ok(goalTagsFor(['职场沟通']).includes('职场'));
  assert.ok(goalTagsFor(['日常交流']).includes('生活'));
  assert.deepEqual(goalTagsFor(['不存在的目标']), []);
});

test('rankCandidates: 已看过的排在未看过之后并标注再练一遍', () => {
  const rows = [
    video(1, { practice_count: 50, view_count: 200 }),
    video(2),
  ];
  const result = rankCandidates(rows, { level: 'beginner', watchedIds: new Set(['1']) }, 2);
  assert.deepEqual(result.map(r => r.row.id), [2, 1]);
  assert.equal(result[0].watched, false);
  assert.equal(result[1].watched, true);
  assert.equal(result[1].reason, '再练一遍');
});

test('rankCandidates: 标签精确命中目标优先于难度匹配', () => {
  const rows = [
    video(1, { difficulty_level: 'beginner', tags: ['儿童'] }),
    video(2, { difficulty_level: 'intermediate', tags: ['职场'] }),
  ];
  const result = rankCandidates(rows, { level: 'beginner', interests: ['职场沟通'] }, 2);
  assert.equal(result[0].row.id, 2);
  assert.equal(result[0].reason, '匹配你的目标「职场沟通」');
});

test('rankCandidates: 难度匹配优先于无难度视频', () => {
  const rows = [
    video(1, { difficulty_level: null }),
    video(2, { difficulty_level: 'intermediate' }),
  ];
  const result = rankCandidates(rows, { level: 'intermediate' }, 2);
  assert.equal(result[0].row.id, 2);
  assert.equal(result[0].reason, '匹配你的学习等级');
});

test('rankCandidates: 过滤他人的「我的」视频', () => {
  const rows = [video(1, { tags: ['我的'], uploader_id: 9 }), video(2)];
  const result = rankCandidates(rows, { level: 'beginner', userId: 3 }, 5);
  assert.deepEqual(result.map(r => r.row.id), [2]);
});

test('rankNextCandidates: 排除当前视频，优先共享标签', () => {
  const anchor = video(10, { tags: ['职场'], difficulty_level: 'intermediate' });
  const rows = [
    anchor,
    video(1, { tags: ['儿童'], difficulty_level: 'intermediate', practice_count: 50 }),
    video(2, { tags: ['职场'], difficulty_level: 'intermediate' }),
  ];
  const result = rankNextCandidates(rows, anchor, { level: 'beginner' }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].row.id, 2);
  assert.equal(result[0].reason, '和你刚看的都是「职场」');
});

test('rankNextCandidates: 难度跟随当前视频而非用户等级', () => {
  const anchor = video(10, { difficulty_level: 'advanced' });
  const rows = [
    anchor,
    video(1, { difficulty_level: 'beginner' }),
    video(2, { difficulty_level: 'advanced' }),
  ];
  const result = rankNextCandidates(rows, anchor, { level: 'beginner' }, 1);
  assert.equal(result[0].row.id, 2);
});

test('rankNextCandidates: 已看过的共享标签视频排在未看过之后', () => {
  const anchor = video(10, { tags: ['职场'] });
  const rows = [
    anchor,
    video(1, { tags: ['职场'] }),
    video(2, { tags: ['生活'] }),
  ];
  const result = rankNextCandidates(rows, anchor, { level: 'beginner', watchedIds: new Set(['1']) }, 2);
  assert.deepEqual(result.map(r => r.row.id), [2, 1]);
});
