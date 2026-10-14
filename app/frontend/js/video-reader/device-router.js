(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VideoReaderDeviceRouter = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MOBILE_UA =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Silk/i;

  function isMobileTarget({ userAgent = '', viewportWidth, mediaMatches = false } = {}) {
    const narrowViewport =
      mediaMatches === true ||
      (Number.isFinite(Number(viewportWidth)) && Number(viewportWidth) <= 768);
    return MOBILE_UA.test(String(userAgent)) || narrowViewport;
  }

  function pageName(pathname) {
    const match = String(pathname || '').match(/(?:^|\/)(video-reader(?:-desktop)?\.html)$/i);
    return match ? match[1].toLowerCase() : '';
  }

  function hasDesktopOverride(search) {
    try {
      return new URLSearchParams(String(search || '').replace(/^\?/, '')).get('desktop') === '1';
    } catch (_) {
      return /(?:^|[?&])desktop=1(?:&|$)/.test(String(search || ''));
    }
  }

  function getRedirectTarget({
    pathname = '',
    search = '',
    hash = '',
    userAgent = '',
    viewportWidth,
    mediaMatches = false
  } = {}) {
    const currentPage = pageName(pathname);
    if (!currentPage || hasDesktopOverride(search)) return null;

    const mobile = isMobileTarget({ userAgent, viewportWidth, mediaMatches });
    const suffix = `${String(search || '')}${String(hash || '')}`;

    if (currentPage === 'video-reader-desktop.html' && mobile) {
      return `./video-reader.html${suffix}`;
    }

    if (currentPage === 'video-reader.html' && !mobile) {
      return `./video-reader-desktop.html${suffix}`;
    }

    return null;
  }

  function redirectIfNeeded(windowObject) {
    try {
      if (!windowObject || !windowObject.location) return null;
      const mediaMatches =
        typeof windowObject.matchMedia === 'function'
          ? windowObject.matchMedia('(max-width: 768px)').matches
          : false;
      const target = getRedirectTarget({
        pathname: windowObject.location.pathname,
        search: windowObject.location.search,
        hash: windowObject.location.hash,
        userAgent: windowObject.navigator && windowObject.navigator.userAgent,
        viewportWidth: windowObject.innerWidth,
        mediaMatches
      });

      if (target && typeof windowObject.location.replace === 'function') {
        windowObject.location.replace(target);
      }
      return target;
    } catch (error) {
      if (windowObject && windowObject.console && typeof windowObject.console.warn === 'function') {
        windowObject.console.warn('Video reader device routing failed:', error);
      }
      return null;
    }
  }

  return {
    isMobileTarget,
    getRedirectTarget,
    redirectIfNeeded
  };
});
