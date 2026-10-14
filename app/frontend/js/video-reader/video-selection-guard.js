(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LinglishVideoSelectionGuard = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function createVideoSelectionGuard() {
    let generation = 0;
    let currentVideoId = null;

    function begin(videoId) {
      generation += 1;
      currentVideoId = videoId == null ? null : String(videoId);
      return Object.freeze({ generation, videoId: currentVideoId });
    }

    function isCurrent(token, expectedVideoId) {
      if (!token || token.generation !== generation || token.videoId !== currentVideoId) return false;
      if (expectedVideoId == null) return true;
      return String(expectedVideoId) === currentVideoId;
    }

    function invalidate() {
      generation += 1;
      currentVideoId = null;
    }

    return { begin, isCurrent, invalidate };
  }

  function createVideoSelectionLifecycle(options = {}) {
    const guard = createVideoSelectionGuard();
    const releasePrevious = () => {
      if (typeof options.cancelPendingLocalSeek === 'function') options.cancelPendingLocalSeek();
      if (typeof options.unloadLocal === 'function') options.unloadLocal();
      if (typeof options.destroyYouTube === 'function') options.destroyYouTube();
      if (typeof options.clearTranscript === 'function') options.clearTranscript();
    };

    return {
      begin(videoId) {
        releasePrevious();
        return guard.begin(videoId);
      },
      isCurrent: guard.isCurrent,
      invalidate() {
        guard.invalidate();
        releasePrevious();
      },
    };
  }

  return { createVideoSelectionGuard, createVideoSelectionLifecycle };
});
