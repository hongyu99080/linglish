/**
 * Lazy Loader Module
 *
 * Uses Intersection Observer API for efficient lazy loading of images,
 * videos, and other media content. Provides graceful fallback for
 * browsers without Intersection Observer support.
 */

(function (global) {
  'use strict';

  // Configuration
  const CONFIG = {
    rootMargin: '50px 0px',     // Start loading 50px before entering viewport
    threshold: 0.01,            // Trigger when 1% visible
    loadedClass: 'lazy-loaded',
    loadingClass: 'lazy-loading',
    errorClass: 'lazy-error',
    srcAttribute: 'data-src',
    srcsetAttribute: 'data-srcset',
    bgAttribute: 'data-bg',
  };

  // Track observed elements
  let observer = null;
  let observedElements = new Set();

  /**
   * Load an image element
   * @param {HTMLImageElement} img - Image element to load
   */
  function loadImage(img) {
    const src = img.getAttribute(CONFIG.srcAttribute);
    const srcset = img.getAttribute(CONFIG.srcsetAttribute);

    if (!src && !srcset) return;

    img.classList.add(CONFIG.loadingClass);

    // Create a new image to preload
    const tempImage = new Image();

    tempImage.onload = function () {
      if (src) {
        img.src = src;
        img.removeAttribute(CONFIG.srcAttribute);
      }
      if (srcset) {
        img.srcset = srcset;
        img.removeAttribute(CONFIG.srcsetAttribute);
      }
      img.classList.remove(CONFIG.loadingClass);
      img.classList.add(CONFIG.loadedClass);

      // Dispatch custom event for tracking
      img.dispatchEvent(new CustomEvent('lazyloaded', { bubbles: true }));
    };

    tempImage.onerror = function () {
      img.classList.remove(CONFIG.loadingClass);
      img.classList.add(CONFIG.errorClass);
      console.warn('[LazyLoader] Failed to load image:', src || srcset);
    };

    // Start loading
    tempImage.src = src || '';
    if (srcset) {
      tempImage.srcset = srcset;
    }
  }

  /**
   * Load a background image element
   * @param {HTMLElement} element - Element with data-bg attribute
   */
  function loadBackgroundImage(element) {
    const bg = element.getAttribute(CONFIG.bgAttribute);
    if (!bg) return;

    element.classList.add(CONFIG.loadingClass);

    const tempImage = new Image();

    tempImage.onload = function () {
      element.style.backgroundImage = `url('${bg}')`;
      element.removeAttribute(CONFIG.bgAttribute);
      element.classList.remove(CONFIG.loadingClass);
      element.classList.add(CONFIG.loadedClass);
      element.dispatchEvent(new CustomEvent('lazyloaded', { bubbles: true }));
    };

    tempImage.onerror = function () {
      element.classList.remove(CONFIG.loadingClass);
      element.classList.add(CONFIG.errorClass);
      console.warn('[LazyLoader] Failed to load background:', bg);
    };

    tempImage.src = bg;
  }

  /**
   * Load a video element (set poster and/or preload)
   * @param {HTMLVideoElement} video - Video element to load
   */
  function loadVideo(video) {
    const poster = video.getAttribute('data-poster');
    const src = video.getAttribute(CONFIG.srcAttribute);

    if (poster) {
      video.poster = poster;
      video.removeAttribute('data-poster');
    }

    if (src) {
      video.src = src;
      video.removeAttribute(CONFIG.srcAttribute);
      video.load();
    }

    video.classList.add(CONFIG.loadedClass);
    video.dispatchEvent(new CustomEvent('lazyloaded', { bubbles: true }));
  }

  /**
   * Load an iframe element
   * @param {HTMLIFrameElement} iframe - Iframe element to load
   */
  function loadIframe(iframe) {
    const src = iframe.getAttribute(CONFIG.srcAttribute);
    if (!src) return;

    iframe.classList.add(CONFIG.loadingClass);
    iframe.src = src;
    iframe.removeAttribute(CONFIG.srcAttribute);

    iframe.onload = function () {
      iframe.classList.remove(CONFIG.loadingClass);
      iframe.classList.add(CONFIG.loadedClass);
      iframe.dispatchEvent(new CustomEvent('lazyloaded', { bubbles: true }));
    };
  }

  /**
   * Intersection Observer callback
   * @param {IntersectionObserverEntry[]} entries - Observer entries
   */
  function onIntersection(entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;

      const element = entry.target;

      // Stop observing this element
      observer.unobserve(element);
      observedElements.delete(element);

      // Determine element type and load accordingly
      const tagName = element.tagName.toLowerCase();

      if (tagName === 'img') {
        loadImage(element);
      } else if (tagName === 'video') {
        loadVideo(element);
      } else if (tagName === 'iframe') {
        loadIframe(element);
      } else if (element.hasAttribute(CONFIG.bgAttribute)) {
        loadBackgroundImage(element);
      }
    });
  }

  /**
   * Create Intersection Observer instance
   */
  function createObserver() {
    if (observer) return;

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(onIntersection, {
        rootMargin: CONFIG.rootMargin,
        threshold: CONFIG.threshold,
      });
    }
  }

  /**
   * Observe an element for lazy loading
   * @param {HTMLElement} element - Element to observe
   */
  function observe(element) {
    if (!element || observedElements.has(element)) return;

    createObserver();

    if (observer) {
      observer.observe(element);
      observedElements.add(element);
    } else {
      // Fallback: load immediately if no IntersectionObserver
      loadElementImmediately(element);
    }
  }

  /**
   * Load element immediately (fallback for no IntersectionObserver)
   * @param {HTMLElement} element - Element to load
   */
  function loadElementImmediately(element) {
    const tagName = element.tagName.toLowerCase();

    if (tagName === 'img') {
      loadImage(element);
    } else if (tagName === 'video') {
      loadVideo(element);
    } else if (tagName === 'iframe') {
      loadIframe(element);
    } else if (element.hasAttribute(CONFIG.bgAttribute)) {
      loadBackgroundImage(element);
    }
  }

  /**
   * Initialize lazy loading for all matching elements
   * @param {string} [selector] - CSS selector for elements to lazy load
   */
  function init(selector) {
    const defaultSelector = `img[${CONFIG.srcAttribute}], video[${CONFIG.srcAttribute}], iframe[${CONFIG.srcAttribute}], [${CONFIG.bgAttribute}]`;
    const finalSelector = selector || defaultSelector;

    const elements = document.querySelectorAll(finalSelector);
    elements.forEach(observe);

    return elements.length;
  }

  /**
   * Stop observing all elements and cleanup
   */
  function destroy() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    observedElements.clear();
  }

  /**
   * Force load all observed elements immediately
   */
  function loadAll() {
    observedElements.forEach(function (element) {
      loadElementImmediately(element);
    });
    destroy();
  }

  // Public API
  const LazyLoader = {
    init: init,
    observe: observe,
    destroy: destroy,
    loadAll: loadAll,
    config: CONFIG,
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LazyLoader;
  } else {
    global.LazyLoader = LazyLoader;
  }

  // Auto-initialize on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      LazyLoader.init();
    });
  } else {
    // DOM is already ready
    LazyLoader.init();
  }

})(typeof window !== 'undefined' ? window : this);
