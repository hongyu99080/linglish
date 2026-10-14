/**
 * TodayRecommendationSession - 控制“今日推荐视频”在当前页面会话中的展示生命周期。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TodayRecommendationSession = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create() {
    var dismissed = false;

    return {
      dismiss: function () {
        dismissed = true;
      },
      shouldShow: function (candidate) {
        return !dismissed && !!candidate;
      },
      start: function (candidate, actions) {
        if (!candidate) return false;

        dismissed = true;
        var api = actions || {};
        if (api.card) {
          api.card.hidden = true;
          if (api.card.style) api.card.style.display = 'none';
        }
        if (typeof api.selectVideo === 'function') {
          api.selectVideo(candidate);
        }
        return true;
      }
    };
  }

  return {
    create: create
  };
});
