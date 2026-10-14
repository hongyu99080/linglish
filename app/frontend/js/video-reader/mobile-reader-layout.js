(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MobileReaderLayout = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function shouldStartSidebarHidden(viewportWidth) {
    return Number(viewportWidth) <= 768;
  }

  function closedSidebarState() {
    return {
      hidden: true,
      expanded: false,
      label: '打开视频库',
      text: '☰ 视频库'
    };
  }

  function nextSidebarState(currentlyHidden) {
    if (currentlyHidden) {
      return {
        hidden: false,
        expanded: true,
        label: '关闭视频库',
        text: '✕ 关闭'
      };
    }
    return closedSidebarState();
  }

  function usesFocusedTranscriptSizing(bodyClassName) {
    return String(bodyClassName || '')
      .split(/\s+/)
      .includes('video-reader-mobile-focus');
  }

  return {
    shouldStartSidebarHidden,
    nextSidebarState,
    closedSidebarState,
    usesFocusedTranscriptSizing
  };
});
