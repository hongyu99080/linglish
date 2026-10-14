const test = require('node:test');
const assert = require('node:assert/strict');

const LibraryFilter = require('../../frontend/js/video-reader/library-filter');

const videos = [
  { id: 1, title: 'Business Meeting Basics', uploader_id: 10, difficulty_level: 'beginner' },
  { id: 2, title: 'Daily Chat', uploader_id: 20, difficulty_level: 'Intermediate ' }, // 存量非标准值
  { id: 3, title: 'Interview Prep', uploader_id: 10, difficulty_level: 'advanced' },
  { id: 4, title: 'Untagged Clip', uploader_id: 30, difficulty_level: null },
];

const tagMap = { 1: [101, '102'], 2: ['102'], 3: [103] }; // 4 无标签
const tagNames = { 101: '商务', 102: '日常', 103: '面试' };
const progressMap = { 1: 0, 2: 45, 3: 95, 4: 0 };

const ctx = {
  currentUserId: 10,
  getVideoTags: (id) => tagMap[id] || [],
  getTagName: (tagId) => tagNames[String(tagId)] || tagNames[tagId],
  getProgressPercent: (id) => progressMap[id] || 0,
  resolveSceneTagIds: (scene) => (scene === 'interview' ? [103] : []),
  sceneKeywords: { work: ['business', 'meeting'], interview: ['interview'] },
};

test('empty state returns all videos', () => {
  const result = LibraryFilter.filterVideos(videos, {}, ctx);
  assert.equal(result.length, 4);
  assert.equal(LibraryFilter.hasActiveFilters({}), false);
});

test('difficulty filter normalizes legacy values (case/whitespace)', () => {
  const result = LibraryFilter.filterVideos(videos, { difficulty: 'intermediate' }, ctx);
  assert.deepEqual(result.map(v => v.id), [2]);
});

test('tag filter compares as strings regardless of stored type', () => {
  // 数字状态值 vs 字符串存储
  assert.deepEqual(
    LibraryFilter.filterVideos(videos, { tagId: 102 }, ctx).map(v => v.id),
    [1, 2]
  );
  // 字符串状态值 vs 数字存储
  assert.deepEqual(
    LibraryFilter.filterVideos(videos, { tagId: '101' }, ctx).map(v => v.id),
    [1]
  );
});

test('_untagged matches only videos without tags', () => {
  const result = LibraryFilter.filterVideos(videos, { tagId: '_untagged' }, ctx);
  assert.deepEqual(result.map(v => v.id), [4]);
});

test('scope=mine keeps only current user uploads', () => {
  const result = LibraryFilter.filterVideos(videos, { scope: 'mine' }, ctx);
  assert.deepEqual(result.map(v => v.id), [1, 3]);
  assert.equal(LibraryFilter.hasActiveFilters({ scope: 'mine' }), true);
});

test('scope=mine with string/number user id mismatch still matches', () => {
  const result = LibraryFilter.filterVideos(videos, { scope: 'mine' }, { ...ctx, currentUserId: '10' });
  assert.deepEqual(result.map(v => v.id), [1, 3]);
});

test('scope=mine without logged-in user matches nothing', () => {
  const result = LibraryFilter.filterVideos(videos, { scope: 'mine' }, { ...ctx, currentUserId: null });
  assert.equal(result.length, 0);
});

test('status buckets use 0 / (0,90) / >=90 thresholds', () => {
  assert.deepEqual(LibraryFilter.filterVideos(videos, { status: 'unseen' }, ctx).map(v => v.id), [1, 4]);
  assert.deepEqual(LibraryFilter.filterVideos(videos, { status: 'in-progress' }, ctx).map(v => v.id), [2]);
  assert.deepEqual(LibraryFilter.filterVideos(videos, { status: 'complete' }, ctx).map(v => v.id), [3]);
});

test('scene matches by tag id first, keyword fallback second', () => {
  // interview: 标签 103 命中视频 3
  assert.deepEqual(LibraryFilter.filterVideos(videos, { scene: 'interview' }, ctx).map(v => v.id), [3]);
  // work: 无场景标签，关键词回退命中标题
  assert.deepEqual(LibraryFilter.filterVideos(videos, { scene: 'work' }, ctx).map(v => v.id), [1]);
});

test('query matches title and tag names, case-insensitive', () => {
  assert.deepEqual(LibraryFilter.filterVideos(videos, { query: 'DAILY' }, ctx).map(v => v.id), [2]);
  // 标签名匹配：'商务' -> 视频 1
  assert.deepEqual(LibraryFilter.filterVideos(videos, { query: '商务' }, ctx).map(v => v.id), [1]);
});

test('combined AND filters narrow correctly', () => {
  const result = LibraryFilter.filterVideos(
    videos,
    { scope: 'mine', difficulty: 'advanced', scene: 'interview', status: 'complete', tagId: '103' },
    ctx
  );
  assert.deepEqual(result.map(v => v.id), [3]);
  // 任一条件不满足则为空
  const none = LibraryFilter.filterVideos(
    videos,
    { scope: 'mine', difficulty: 'beginner', tagId: '103' },
    ctx
  );
  assert.equal(none.length, 0);
});

test('createState sanitizes invalid difficulty and scope', () => {
  const s = LibraryFilter.createState({ difficulty: 'expert', scope: 'weird', tagId: 5 });
  assert.equal(s.difficulty, '');
  assert.equal(s.scope, 'all');
  assert.equal(s.tagId, '5');
});
