const test = require('node:test');
const assert = require('node:assert/strict');

const {
  saveVideoMetadata,
  normalizeMetadataUpdates,
} = require('../../frontend/js/video-reader/video-metadata-editor');

test('blank difficulty and collection are persisted as null so existing values can be cleared', () => {
  assert.deepEqual(
    normalizeMetadataUpdates({ difficulty: '', collectionName: '   ' }),
    { difficulty_level: null, collection_name: null },
  );
});

test('metadata save checks tag response before patching video fields', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/tags')) {
      return { ok: false, status: 500 };
    }
    throw new Error('PATCH must not run after tag failure');
  };

  await assert.rejects(
    saveVideoMetadata({
      fetchImpl,
      apiBase: '',
      headers: { Authorization: 'Bearer token' },
      videoId: 12,
      globalTagIds: [1],
      personalTagIds: [],
      difficulty: 'beginner',
      collectionName: 'BBC',
    }),
    /标签保存失败/,
  );
  assert.equal(calls.length, 1);
});

test('metadata save persists tags, difficulty and collection and returns updated video', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({
      url,
      method: options.method,
      body: JSON.parse(options.body),
    });
    if (url.endsWith('/tags')) {
      return { ok: true, status: 200 };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        video: {
          id: 12,
          difficulty_level: 'advanced',
          collection_name: 'BBC 六分钟',
        },
      }),
    };
  };

  const result = await saveVideoMetadata({
    fetchImpl,
    apiBase: '',
    headers: { Authorization: 'Bearer token' },
    videoId: 12,
    globalTagIds: [1, 5],
    personalTagIds: ['u:8'],
    difficulty: 'advanced',
    collectionName: ' BBC 六分钟 ',
  });

  assert.deepEqual(calls, [
    {
      url: '/videos/12/tags',
      method: 'POST',
      body: {
        global_tag_ids: [1, 5],
        user_tag_ids: ['u:8'],
      },
    },
    {
      url: '/video-resources/12',
      method: 'PATCH',
      body: {
        difficulty_level: 'advanced',
        collection_name: 'BBC 六分钟',
      },
    },
  ]);
  assert.deepEqual(result.video, {
    id: 12,
    difficulty_level: 'advanced',
    collection_name: 'BBC 六分钟',
  });
});

