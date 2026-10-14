// app/backend/test/video-recommendation-client.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

let Client = {};
try {
  Client = require('../../frontend/js/video-recommendation-client');
} catch (_) {
  // RED 阶段：模块尚未实现
}

function fakeFetch(payload, { ok = true } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok, json: async () => payload };
  };
  return { impl, calls };
}

test('fetchNextVideo: 请求 next-video 接口并返回第一个视频', async () => {
  const { impl, calls } = fakeFetch({ success: true, data: { videos: [{ id: 9, title: 'Next' }] } });
  const video = await Client.fetchNextVideo({ apiBase: '/api-base', afterId: '12', token: 'tok', fetchImpl: impl });
  assert.equal(video.id, 9);
  assert.equal(calls[0].url, '/api-base/api/learning/next-video?after=12&limit=1');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
});

test('fetchNextVideo: 游客不带 Authorization', async () => {
  const { impl, calls } = fakeFetch({ success: true, data: { videos: [{ id: 1 }] } });
  await Client.fetchNextVideo({ apiBase: '', afterId: 3, token: null, fetchImpl: impl });
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('fetchNextVideo: 失败或无结果时返回 null', async () => {
  const empty = fakeFetch({ success: true, data: { videos: [] } });
  assert.equal(await Client.fetchNextVideo({ afterId: 1, fetchImpl: empty.impl }), null);
  const bad = fakeFetch({}, { ok: false });
  assert.equal(await Client.fetchNextVideo({ afterId: 1, fetchImpl: bad.impl }), null);
  const thrown = async () => { throw new Error('offline'); };
  assert.equal(await Client.fetchNextVideo({ afterId: 1, fetchImpl: thrown }), null);
});

test('fetchRecommendedVideos: 返回视频列表', async () => {
  const { impl, calls } = fakeFetch({ success: true, data: { videos: [{ id: 1 }, { id: 2 }] } });
  const videos = await Client.fetchRecommendedVideos({ apiBase: '', limit: 2, fetchImpl: impl });
  assert.deepEqual(videos.map(v => v.id), [1, 2]);
  assert.equal(calls[0].url, '/api/learning/recommended-videos?limit=2');
});

test('eventProps: 统一推荐埋点字段', () => {
  const props = Client.eventProps({ id: 5, recommendationReason: '再练一遍', watched: true }, 'today', 2);
  assert.deepEqual(props, {
    slot: 'today',
    video_resource_id: '5',
    reason: '再练一遍',
    watched: true,
    position: 2,
  });
});

test('createImpressionTracker: 同一页面同一 slot+视频只上报一次', () => {
  const sent = [];
  const tracker = Client.createImpressionTracker((name, props) => sent.push({ name, props }));
  tracker.track({ id: 1 }, 'next', 0);
  tracker.track({ id: 1 }, 'next', 0);
  tracker.track({ id: 1 }, 'today', 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].name, 'reco_impression');
});

test('feedbackPayload: 只接受太难/太简单', () => {
  assert.deepEqual(Client.feedbackPayload('too_hard'), { itemType: 'watch', action: 'too_hard' });
  assert.deepEqual(Client.feedbackPayload('too_easy'), { itemType: 'watch', action: 'too_easy' });
  assert.equal(Client.feedbackPayload('boring'), null);
});
