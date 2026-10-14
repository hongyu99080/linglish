(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishReaderLayoutState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalize(state) {
    return {
      focusMode: !!(state && state.focusMode),
      sidebarCollapsed: !!(state && state.sidebarCollapsed),
    };
  }

  function toggleVideoLibrary(state) {
    const current = normalize(state);

    // The library and focus mode are mutually exclusive. Requesting the
    // library must always make the sidebar visible, even when focus mode was
    // restored from localStorage.
    if (current.focusMode) {
      return {
        focusMode: false,
        sidebarCollapsed: false,
      };
    }

    return {
      focusMode: false,
      sidebarCollapsed: !current.sidebarCollapsed,
    };
  }

  function shouldStartFocused({ savedPreference, hasVideo, firstLesson = false }) {
    if (firstLesson) return true;
    if (savedPreference === 'true') return true;
    if (savedPreference === 'false') return false;
    return !!hasVideo;
  }

  return {
    toggleVideoLibrary,
    shouldStartFocused,
  };
});
