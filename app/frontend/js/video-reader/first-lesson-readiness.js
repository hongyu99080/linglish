(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LinglishFirstLessonReadiness = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function createFirstLessonReadiness({ focus, from, startedAt, now = Date.now }) {
    let emitted = false;

    function markReady({ videoId, segmentCount }) {
      if (emitted || focus !== 'first_lesson' || !Number.isFinite(segmentCount) || segmentCount <= 0) {
        return null;
      }

      emitted = true;
      return {
        video_resource_id: videoId,
        segment_count: segmentCount,
        ready_ms: Math.max(0, Math.round(now() - startedAt)),
      };
    }

    return { markReady };
  }

  return { createFirstLessonReadiness };
});
