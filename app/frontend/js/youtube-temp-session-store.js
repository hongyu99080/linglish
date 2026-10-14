(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YouTubeTempSessionStore = api.createTemporarySessionStore(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const SESSION_KEY = 'youtube_temp_session';
  const DATABASE_NAME = 'linglish-temporary-sessions';
  const OBJECT_STORE_NAME = 'youtube-sessions';
  const RECORD_KEY = 'current';
  const RECORD_VERSION = 1;
  const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  function createStorageError(causes) {
    const error = new Error('Unable to save this temporary video in browser storage');
    error.code = 'TEMP_SESSION_STORAGE_UNAVAILABLE';
    error.causes = causes;
    return error;
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isSession(value) {
    return isObject(value)
      && typeof value.youtube_video_id === 'string'
      && value.youtube_video_id.trim().length > 0
      && typeof value.title === 'string'
      && typeof value.transcript === 'string'
      && Array.isArray(value.segments);
  }

  function hasEnvelopeFields(value) {
    if (!isObject(value)) return false;
    return ['version', 'savedAt', 'expiresAt', 'payload']
      .some(function (key) { return Object.prototype.hasOwnProperty.call(value, key); });
  }

  function isEnvelope(value) {
    const savedAt = Number(value && value.savedAt);
    const expiresAt = Number(value && value.expiresAt);
    return isObject(value)
      && value.version === RECORD_VERSION
      && Number.isFinite(savedAt)
      && Number.isFinite(expiresAt)
      && savedAt >= 0
      && expiresAt > savedAt
      && isSession(value.payload);
  }

  function parseStoredValue(raw) {
    if (!raw || raw === 'undefined' || raw === 'null') return { status: 'missing' };
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (isEnvelope(value)) return { status: 'envelope', value };
      if (hasEnvelopeFields(value)) return { status: 'invalid' };
      if (isSession(value)) return { status: 'legacy', value };
      return { status: 'invalid' };
    } catch (_) {
      return { status: 'invalid' };
    }
  }

  function openDatabase(indexedDB) {
    return new Promise(function (resolve, reject) {
      let request;
      let settled = false;
      const finishError = function (error) {
        if (settled) return;
        settled = true;
        reject(error);
      };
      try {
        request = indexedDB.open(DATABASE_NAME, 1);
      } catch (error) {
        finishError(error);
        return;
      }
      request.onupgradeneeded = function () {
        const database = request.result;
        if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
          database.createObjectStore(OBJECT_STORE_NAME);
        }
      };
      request.onsuccess = function () {
        if (settled) {
          try { request.result.close(); } catch (_) {}
          return;
        }
        settled = true;
        resolve(request.result);
      };
      request.onerror = function () { finishError(request.error || new Error('IndexedDB open failed')); };
      request.onblocked = function () { finishError(new Error('IndexedDB open blocked')); };
    });
  }

  function createIndexedDbStore(indexedDB) {
    if (!indexedDB || typeof indexedDB.open !== 'function') return null;

    async function run(mode, operation) {
      const database = await openDatabase(indexedDB);
      return new Promise(function (resolve, reject) {
        let request;
        let result;
        let settled = false;
        const finishError = function (error) {
          if (settled) return;
          settled = true;
          try { database.close(); } catch (_) {}
          reject(error || new Error('IndexedDB transaction failed'));
        };
        try {
          const transaction = database.transaction(OBJECT_STORE_NAME, mode);
          request = operation(transaction.objectStore(OBJECT_STORE_NAME));
          request.onsuccess = function () { result = request.result; };
          request.onerror = function () { finishError(request.error); };
          transaction.oncomplete = function () {
            if (settled) return;
            settled = true;
            try { database.close(); } catch (_) {}
            resolve(result);
          };
          transaction.onerror = function () { finishError(transaction.error); };
          transaction.onabort = function () { finishError(transaction.error); };
        } catch (error) {
          finishError(error);
        }
      });
    }

    return {
      get: function () {
        return run('readonly', function (store) { return store.get(RECORD_KEY); });
      },
      set: function (value) {
        return run('readwrite', function (store) { return store.put(value, RECORD_KEY); });
      },
      remove: function () {
        return run('readwrite', function (store) { return store.delete(RECORD_KEY); });
      },
    };
  }

  function createTemporarySessionStore(environment, options) {
    if (!environment) throw new Error('WINDOW_ENVIRONMENT_REQUIRED');
    const settings = options || {};
    const ttlMs = Number.isFinite(Number(settings.ttlMs))
      ? Math.max(1, Number(settings.ttlMs))
      : DEFAULT_TTL_MS;
    const indexedStore = Object.prototype.hasOwnProperty.call(settings, 'indexedStore')
      ? settings.indexedStore
      : createIndexedDbStore(environment.indexedDB);

    function now() {
      const DateObject = environment.Date || Date;
      return typeof DateObject.now === 'function' ? DateObject.now() : Date.now();
    }

    function createEnvelope(session) {
      if (!isSession(session)) {
        const error = new Error('Temporary video session is invalid');
        error.code = 'TEMP_SESSION_INVALID';
        throw error;
      }
      const savedAt = now();
      return {
        version: RECORD_VERSION,
        savedAt,
        expiresAt: savedAt + ttlMs,
        payload: session,
      };
    }

    async function save(session) {
      const envelope = createEnvelope(session);
      const causes = [];
      if (indexedStore && typeof indexedStore.set === 'function') {
        try {
          await indexedStore.set(envelope);
          return { source: 'indexeddb' };
        } catch (error) {
          causes.push(error);
        }
      }
      try {
        if (!environment.sessionStorage) throw new Error('sessionStorage unavailable');
        environment.sessionStorage.setItem(SESSION_KEY, JSON.stringify(envelope));
        return { source: 'sessionStorage' };
      } catch (error) {
        causes.push(error);
      }
      throw createStorageError(causes);
    }

    async function removeIndexedRecord() {
      if (!indexedStore || typeof indexedStore.remove !== 'function') return;
      try { await indexedStore.remove(); } catch (_) {}
    }

    function removeStorageRecord(storage) {
      try { if (storage) storage.removeItem(SESSION_KEY); } catch (_) {}
    }

    async function load() {
      let sawExpired = false;
      let sawInvalid = false;
      let sawEnvelope = false;
      const candidates = [];

      async function inspect(source, raw, remove, priority) {
        const parsed = parseStoredValue(raw);
        if (parsed.status === 'missing') return;
        if (parsed.status === 'invalid') {
          sawInvalid = true;
          await remove();
          return;
        }
        if (parsed.status === 'legacy') {
          candidates.push({
            source,
            session: parsed.value,
            savedAt: -1,
            legacy: true,
            priority,
            remove,
          });
          return;
        }

        sawEnvelope = true;
        if (Number(parsed.value.expiresAt) <= now()) {
          sawExpired = true;
          await remove();
          return;
        }
        candidates.push({
          source,
          session: parsed.value.payload,
          savedAt: Number(parsed.value.savedAt),
          legacy: false,
          priority,
          remove,
        });
      }

      if (indexedStore && typeof indexedStore.get === 'function') {
        try {
          const indexedRaw = await indexedStore.get();
          await inspect('indexeddb', indexedRaw, removeIndexedRecord, 3);
        } catch (_) {
          // A blocked or unavailable IndexedDB must not prevent storage fallbacks.
        }
      }

      let sessionRaw = null;
      try { sessionRaw = environment.sessionStorage && environment.sessionStorage.getItem(SESSION_KEY); } catch (_) {}
      await inspect(
        'sessionStorage',
        sessionRaw,
        async function () { removeStorageRecord(environment.sessionStorage); },
        2
      );

      let legacyRaw = null;
      try { legacyRaw = environment.localStorage && environment.localStorage.getItem(SESSION_KEY); } catch (_) {}
      await inspect(
        'legacy-localStorage',
        legacyRaw,
        async function () { removeStorageRecord(environment.localStorage); },
        1
      );

      const eligibleCandidates = sawEnvelope
        ? candidates.filter(function (candidate) { return !candidate.legacy; })
        : candidates;
      eligibleCandidates.sort(function (left, right) {
        return (right.savedAt - left.savedAt) || (right.priority - left.priority);
      });
      const selected = eligibleCandidates[0];

      if (selected) {
        for (const candidate of candidates) {
          if (candidate === selected || candidate.legacy) continue;
          await candidate.remove();
        }

        if (selected.legacy) {
          let migrationResult = null;
          try {
            migrationResult = await save(selected.session);
          } catch (_) {
            // Keep the legacy record when migration cannot be persisted elsewhere.
          }
          if (migrationResult && migrationResult.source === 'indexeddb') {
            await selected.remove();
          }
        } else if (selected.source === 'indexeddb') {
          for (const candidate of candidates) {
            if (candidate.legacy) await candidate.remove();
          }
        }

        return { status: 'ready', source: selected.source, session: selected.session };
      }

      if (sawEnvelope) {
        for (const candidate of candidates) {
          if (candidate.legacy) await candidate.remove();
        }
      }

      if (sawInvalid) return { status: 'invalid' };
      if (sawExpired) return { status: 'expired' };
      return { status: 'missing' };
    }

    async function saveAndNavigate(session, destination) {
      const result = await save(session);
      if (!environment.location) return result;
      if (typeof environment.location.assign === 'function') {
        environment.location.assign(destination);
      } else {
        environment.location.href = destination;
      }
      return result;
    }

    function getSaveErrorMessage(error) {
      if (error && error.code === 'TEMP_SESSION_STORAGE_UNAVAILABLE') {
        return '浏览器存储空间不足，无法打开临时视频。请清理本站缓存，或切换“下载保存”模式。';
      }
      if (error && error.code === 'TEMP_SESSION_INVALID') {
        return '视频数据格式异常，请更换视频后重试。';
      }
      return '无法保存临时视频数据，请重试。';
    }

    return { save, load, saveAndNavigate, getSaveErrorMessage };
  }

  return {
    createTemporarySessionStore,
    createIndexedDbStore,
  };
});
