(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishFirstLessonFocus = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function readContext(search) {
    try {
      const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
      return {
        enabled: params.get('focus') === 'first_lesson',
        from: params.get('from') || null,
      };
    } catch (_) {
      return { enabled: false, from: null };
    }
  }

  function applyDocumentState(documentObject, search) {
    const context = readContext(search);
    const root = documentObject && documentObject.documentElement;
    if (!root || !root.dataset) return false;
    if (context.enabled) root.dataset.learningFocus = 'first-lesson';
    else delete root.dataset.learningFocus;
    return context.enabled;
  }

  function exitDocumentState(documentObject) {
    const root = documentObject && documentObject.documentElement;
    if (root && root.dataset) delete root.dataset.learningFocus;
  }

  function createSession(options) {
    const config = options || {};
    const context = readContext(config.search);
    let active = context.enabled;
    const teardowns = new Set();

    function addTeardown(teardown) {
      if (typeof teardown !== 'function') return function () { };
      teardowns.add(teardown);
      return function removeTeardown() { teardowns.delete(teardown); };
    }

    function replaceFocusUrl() {
      if (!config.history || typeof config.history.replaceState !== 'function') return;
      const params = new URLSearchParams(String(config.search || '').replace(/^\?/, ''));
      params.delete('focus');
      const query = params.toString();
      const pathname = config.pathname || (config.location && config.location.pathname) || '';
      const hash = config.hash || (config.location && config.location.hash) || '';
      const nextUrl = `${pathname}${query ? `?${query}` : ''}${hash}`;
      config.history.replaceState(config.history.state || null, '', nextUrl);
    }

    function deactivate(reason) {
      if (!active) return false;
      for (const teardown of Array.from(teardowns)) {
        try { teardown(reason || 'exit'); } catch (_) { }
      }
      active = false;
      try { if (typeof config.onClear === 'function') config.onClear(reason || 'exit'); } catch (_) { }
      replaceFocusUrl();
      exitDocumentState(config.document);
      return true;
    }

    return {
      from: context.from,
      isActive() { return active; },
      addTeardown,
      deactivate,
    };
  }

  function createLifecycleTracker(options) {
    const config = options || {};
    const context = readContext(config.search);
    const emit = typeof config.emit === 'function' ? config.emit : function () { };
    const sent = new Set();
    const isActive = typeof config.isActive === 'function'
      ? config.isActive
      : function () { return context.enabled; };

    function once(eventName, properties) {
      if (!isActive() || sent.has(eventName)) return false;
      sent.add(eventName);
      emit(eventName, Object.assign({ from: context.from }, properties || {}));
      return true;
    }

    function practice(snapshot) {
      const state = snapshot || {};
      const properties = {
        video_resource_id: state.videoId == null ? null : String(state.videoId),
        practiced: Number(state.practicedCount || 0),
        total: Number(state.total || 0),
        percentage: Number(state.percentage || 0),
        complete: Boolean(state.complete),
      };
      if (properties.practiced <= 0) return false;
      const first = once('first_lesson_sentence_completed', properties);
      if (properties.complete) once('first_lesson_completed', properties);
      return first;
    }

    return {
      get enabled() { return isActive(); },
      ready(properties) { return once('first_lesson_ready', properties); },
      playback(properties) { return once('first_lesson_playback_started', properties); },
      practice,
      feedback(properties) { return once('first_lesson_ai_feedback_seen', properties); },
    };
  }

  return { readContext, applyDocumentState, exitDocumentState, createSession, createLifecycleTracker };
});
