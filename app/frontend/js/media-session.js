(function (root, factory) {
  const api = factory(root || {});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LinglishMediaSession = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const ENDPOINT = '/auth/media-session';
  const DEFAULT_REFRESH_MS = 600_000;
  const DEFAULT_TTL_MS = 900_000;
  const PROTECTED_PATH_PREFIXES = ['/videos/', '/recordings/', '/pdfs/'];
  const DEBUG_SOURCE_KEYS = new Set(['src', 'currentsrc', 'audiosrc', 'source']);

  function createUnsafeLegacyUrlError() {
    const error = new Error('UNSAFE_LEGACY_MEDIA_URL');
    error.code = 'UNSAFE_LEGACY_MEDIA_URL';
    return error;
  }

  function getBaseUrl(options = {}) {
    return options.baseUrl
      || (root.location && root.location.href)
      || 'http://localhost/';
  }

  function assertSafeLegacyMediaUrl(value, options = {}) {
    let target;
    let current;
    try {
      current = new URL(getBaseUrl(options));
      target = new URL(value, current);
    } catch (_) {
      throw createUnsafeLegacyUrlError();
    }
    const protectedPath = PROTECTED_PATH_PREFIXES.some(prefix => (
      target.pathname.startsWith(prefix) && target.pathname.length > prefix.length
    ));
    if (
      !protectedPath
      || target.origin !== current.origin
      || target.username
      || target.password
      || !/^https?:$/.test(target.protocol)
    ) {
      throw createUnsafeLegacyUrlError();
    }
  }

  function buildMediaUrl(path, options = {}) {
    const value = String(path || '');
    if (options.mode !== 'legacy') return value;
    const token = options.legacyToken;
    if (!token || token === 'null' || token === 'undefined') return value;
    assertSafeLegacyMediaUrl(value, options);

    const hashIndex = value.indexOf('#');
    const hash = hashIndex >= 0 ? value.slice(hashIndex) : '';
    const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
    const separator = beforeHash.includes('?') ? '&' : '?';
    return `${beforeHash}${separator}token=${encodeURIComponent(token)}${hash}`;
  }

  function sanitizeDebugString(value, baseUrl) {
    return String(value).replace(/(?:https?:\/\/|\/)[^\s'"<>]+/gi, match => {
      const trailing = match.match(/[),.;:!?]+$/)?.[0] || '';
      const candidate = trailing ? match.slice(0, -trailing.length) : match;
      try {
        return `${new URL(candidate, baseUrl).pathname}${trailing}`;
      } catch (_) {
        return '[redacted-path]';
      }
    });
  }

  function sanitizeDebugPayload(payload, options = {}) {
    const baseUrl = getBaseUrl(options);
    const seen = new WeakSet();
    const sanitize = value => {
      if (typeof value === 'string') return sanitizeDebugString(value, baseUrl);
      if (value === null || value === undefined || typeof value !== 'object') return value;
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      if (Array.isArray(value)) return value.map(sanitize);
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (DEBUG_SOURCE_KEYS.has(String(key).toLowerCase())) continue;
        result[key] = sanitize(item);
      }
      return result;
    };
    return sanitize(payload);
  }

  function createBootstrapError(status) {
    const error = new Error('MEDIA_SESSION_BOOTSTRAP_FAILED');
    error.code = 'MEDIA_SESSION_BOOTSTRAP_FAILED';
    error.status = status;
    return error;
  }

  function createMediaSessionClient(options = {}) {
    const defaultFetch = options.fetchImpl
      || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    const documentRef = options.document || root.document || null;
    const baseUrl = options.baseUrl
      || (root.location && root.location.href)
      || 'http://localhost/';

    let activeToken = null;
    let mode = null;
    let refreshAt = 0;
    let expiresAt = 0;
    let pending = null;
    let pendingToken = null;
    let unbindLifecycle = null;
    let generation = 0;
    let clearing = null;

    const resetState = () => {
      activeToken = null;
      mode = null;
      refreshAt = 0;
      expiresAt = 0;
    };

    const snapshot = () => ({ mode, refreshAt, expiresAt });

    async function deleteCookie(fetchImpl) {
      if (typeof fetchImpl !== 'function') return;
      try {
        await fetchImpl(ENDPOINT, { method: 'DELETE', credentials: 'include' });
      } catch (_) {
        // Local state still clears when the old node or network cannot answer DELETE.
      }
    }

    async function clear(clearOptions = {}) {
      if (clearing) return clearing;
      const fetchImpl = clearOptions.fetchImpl || defaultFetch;
      const inFlight = pending;
      generation += 1;
      resetState();
      pending = null;
      pendingToken = null;
      const request = (async () => {
        if (inFlight) {
          try { await inFlight; } catch (_) { /* DELETE still clears a failed bootstrap cookie. */ }
        }
        await deleteCookie(fetchImpl);
        resetState();
      })();
      clearing = request;
      try {
        return await request;
      } finally {
        if (clearing === request) clearing = null;
      }
    }

    async function bootstrap(token, fetchImpl, currentTime, bootstrapGeneration) {
      if (activeToken && activeToken !== token) {
        resetState();
        await deleteCookie(fetchImpl);
        if (generation !== bootstrapGeneration) return snapshot();
      }

      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (generation !== bootstrapGeneration) return snapshot();

      if (response.status === 404 || response.status === 405) {
        activeToken = token;
        mode = 'legacy';
        refreshAt = currentTime + DEFAULT_REFRESH_MS;
        expiresAt = currentTime + DEFAULT_TTL_MS;
        return snapshot();
      }
      if (!response.ok) {
        resetState();
        throw createBootstrapError(response.status);
      }

      let body = {};
      try { body = await response.json(); } catch (_) { body = {}; }
      if (generation !== bootstrapGeneration) return snapshot();
      const refreshMs = Math.max(1, Number(body.refresh_after_seconds) || 600) * 1_000;
      const ttlMs = Math.max(1, Number(body.ttl_seconds) || 900) * 1_000;
      activeToken = token;
      mode = 'session';
      refreshAt = currentTime + refreshMs;
      expiresAt = currentTime + ttlMs;
      return snapshot();
    }

    async function ensure(ensureOptions = {}) {
      const token = ensureOptions.token;
      if (!token || token === 'null' || token === 'undefined') {
        throw createBootstrapError(401);
      }
      const fetchImpl = ensureOptions.fetchImpl || defaultFetch;
      if (typeof fetchImpl !== 'function') throw createBootstrapError(503);
      if (clearing) await clearing;
      const now = ensureOptions.now || Date.now;
      const currentTime = Number(now());
      const ensureGeneration = generation;

      if (
        activeToken === token
        && mode
        && currentTime < refreshAt
        && currentTime < expiresAt
      ) {
        return snapshot();
      }
      if (pending && pendingToken === token) return pending;
      if (pending) {
        try { await pending; } catch (_) { /* the next bootstrap decides its own result */ }
        if (generation !== ensureGeneration) return snapshot();
      }

      pendingToken = token;
      const request = bootstrap(token, fetchImpl, currentTime, ensureGeneration);
      pending = request;
      try {
        return await request;
      } finally {
        if (pending === request) {
          pending = null;
          pendingToken = null;
        }
      }
    }

    function clientBuildMediaUrl(path, buildOptions = {}) {
      return buildMediaUrl(path, {
        ...buildOptions,
        baseUrl: buildOptions.baseUrl || baseUrl,
        mode: buildOptions.mode || mode || 'session',
      });
    }

    function setElementSource(element, path, sourceOptions = {}) {
      if (!element) throw new Error('MEDIA_ELEMENT_REQUIRED');
      const selectedMode = sourceOptions.mode || mode || 'session';
      const sourceBaseUrl = sourceOptions.baseUrl || baseUrl;
      const url = buildMediaUrl(path, { ...sourceOptions, baseUrl: sourceBaseUrl, mode: selectedMode });
      try {
        const target = new URL(url, sourceBaseUrl);
        const current = new URL(sourceBaseUrl);
        if (target.origin !== current.origin) element.crossOrigin = 'use-credentials';
      } catch (_) { /* relative same-origin URL */ }
      element.src = url;
      return url;
    }

    async function authorizeElementSource(element, path, sourceOptions = {}) {
      const token = sourceOptions.token;
      const mediaState = await ensure({
        token,
        fetchImpl: sourceOptions.fetchImpl,
        now: sourceOptions.now,
      });
      if (typeof sourceOptions.isCurrent === 'function' && !sourceOptions.isCurrent()) return null;
      return setElementSource(element, path, {
        ...sourceOptions,
        mode: mediaState.mode,
        legacyToken: sourceOptions.legacyToken || token,
      });
    }

    function bindLifecycle(lifecycleOptions = {}) {
      if (!documentRef || typeof documentRef.addEventListener !== 'function') return () => {};
      if (unbindLifecycle) return unbindLifecycle;
      const getToken = lifecycleOptions.getToken || (() => activeToken);
      const rotate = () => {
        const token = getToken();
        if (!token) return;
        ensure({
          token,
          fetchImpl: lifecycleOptions.fetchImpl,
          now: lifecycleOptions.now,
        }).catch(error => {
          if (typeof lifecycleOptions.onError === 'function') lifecycleOptions.onError(error);
        });
      };
      const onVisibility = () => {
        if (documentRef.visibilityState === 'visible') rotate();
      };
      documentRef.addEventListener('visibilitychange', onVisibility);
      documentRef.addEventListener('play', rotate, true);
      documentRef.addEventListener('seeking', rotate, true);
      unbindLifecycle = () => {
        documentRef.removeEventListener('visibilitychange', onVisibility);
        documentRef.removeEventListener('play', rotate, true);
        documentRef.removeEventListener('seeking', rotate, true);
        unbindLifecycle = null;
      };
      return unbindLifecycle;
    }

    return {
      ensure,
      clear,
      getState: snapshot,
      buildMediaUrl: clientBuildMediaUrl,
      setElementSource,
      authorizeElementSource,
      bindLifecycle,
    };
  }

  const client = createMediaSessionClient();
  return {
    createMediaSessionClient,
    buildMediaUrl,
    sanitizeDebugPayload,
    ensure: client.ensure,
    clear: client.clear,
    getState: client.getState,
    setElementSource: client.setElementSource,
    authorizeElementSource: client.authorizeElementSource,
    bindLifecycle: client.bindLifecycle,
  };
});
