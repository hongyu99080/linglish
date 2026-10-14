/**
 * VideoRecommendationClient - 调用后端推荐接口(今日推荐 / 下一个)并统一推荐埋点。
 * 所有请求失败都返回 null / [],由调用方回退到本地逻辑。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VideoRecommendationClient = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FEEDBACK_ACTIONS = ['too_hard', 'too_easy'];

  function buildHeaders(token) {
    var headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  function getVideos(options, path) {
    var fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) return Promise.resolve([]);
    var url = (options.apiBase || '') + path;
    return Promise.resolve()
      .then(function () { return fetchImpl(url, { headers: buildHeaders(options.token) }); })
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (json) {
        var videos = json && json.data && json.data.videos;
        return Array.isArray(videos) ? videos : [];
      })
      .catch(function () { return []; });
  }

  function fetchNextVideo(options) {
    var opts = options || {};
    var path = '/api/learning/next-video?after=' + encodeURIComponent(String(opts.afterId == null ? '' : opts.afterId))
      + '&limit=1';
    return getVideos(opts, path).then(function (videos) { return videos[0] || null; });
  }

  function fetchRecommendedVideos(options) {
    var opts = options || {};
    var limit = Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 4;
    return getVideos(opts, '/api/learning/recommended-videos?limit=' + limit);
  }

  function eventProps(video, slot, position) {
    return {
      slot: slot,
      video_resource_id: String(video && video.id != null ? video.id : ''),
      reason: (video && video.recommendationReason) || null,
      watched: !!(video && video.watched),
      position: Number(position) || 0,
    };
  }

  function createImpressionTracker(postEvent) {
    var seen = {};
    return {
      track: function (video, slot, position) {
        if (!video || video.id == null) return;
        var key = slot + ':' + video.id;
        if (seen[key]) return;
        seen[key] = true;
        postEvent('reco_impression', eventProps(video, slot, position));
      }
    };
  }

  function feedbackPayload(action) {
    if (FEEDBACK_ACTIONS.indexOf(action) === -1) return null;
    return { itemType: 'watch', action: action };
  }

  return {
    fetchNextVideo: fetchNextVideo,
    fetchRecommendedVideos: fetchRecommendedVideos,
    eventProps: eventProps,
    createImpressionTracker: createImpressionTracker,
    feedbackPayload: feedbackPayload,
  };
});
