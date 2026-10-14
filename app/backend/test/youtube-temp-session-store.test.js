const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/youtube-temp-session-store.js');
const NOW = Date.parse('2026-08-25T05:00:00.000Z');
const SAMPLE_SESSION = {
  youtube_video_id: 'GvbnYa4uvSQ',
  title: 'LEARN EASY English in Beijing',
  transcript: 'Welcome to Beijing.',
  segments: [{ index: 0, start: 0, end: 2.4, text: 'Welcome to Beijing.' }],
  mode: 'temporary',
};
const SECOND_SESSION = {
  ...SAMPLE_SESSION,
  youtube_video_id: 'newVideo123',
  title: 'Newest temporary import',
  transcript: 'This is the new session.',
  segments: [{ index: 0, start: 0, end: 1.8, text: 'This is the new session.' }],
};

function loadStoreModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

test('temporary YouTube sessions expose a testable browser store factory', () => {
  const api = loadStoreModule();
  assert.equal(typeof api.createTemporarySessionStore, 'function');
});

function createStorage(initial = {}, options = {}) {
  const values = new Map(Object.entries(initial));
  const calls = { get: [], set: [], remove: [] };
  return {
    calls,
    getItem(key) {
      calls.get.push(key);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      calls.set.push({ key, value: String(value) });
      if (options.setError) throw options.setError;
      values.set(key, String(value));
    },
    removeItem(key) {
      calls.remove.push(key);
      values.delete(key);
    },
  };
}

function createIndexedStore(initialValue = null, options = {}) {
  let value = initialValue;
  const calls = { get: 0, set: [], remove: 0 };
  return {
    calls,
    async get() {
      calls.get += 1;
      if (options.getError) throw options.getError;
      return value;
    },
    async set(nextValue) {
      calls.set.push(nextValue);
      if (options.setError) throw options.setError;
      value = nextValue;
    },
    async remove() {
      calls.remove += 1;
      value = null;
    },
  };
}

function createFakeIndexedDb() {
  const values = new Map();
  const objectStoreNames = new Set();

  function createRequest(transaction, operation) {
    const request = {};
    queueMicrotask(() => {
      try {
        request.result = operation();
        if (request.onsuccess) request.onsuccess();
        queueMicrotask(() => {
          if (transaction.oncomplete) transaction.oncomplete();
        });
      } catch (error) {
        request.error = error;
        transaction.error = error;
        if (request.onerror) request.onerror();
        if (transaction.onerror) transaction.onerror();
      }
    });
    return request;
  }

  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        const database = {
          objectStoreNames: {
            contains(name) { return objectStoreNames.has(name); },
          },
          createObjectStore(name) { objectStoreNames.add(name); },
          transaction(name) {
            if (!objectStoreNames.has(name)) throw new Error('object store missing');
            const transaction = {};
            transaction.objectStore = () => ({
              get(key) {
                return createRequest(transaction, () => values.get(key));
              },
              put(value, key) {
                return createRequest(transaction, () => {
                  values.set(key, value);
                  return key;
                });
              },
              delete(key) {
                return createRequest(transaction, () => values.delete(key));
              },
            });
            return transaction;
          },
          close() {},
        };
        request.result = database;
        if (!objectStoreNames.size && request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}

test('IndexedDB adapter persists, reopens, and removes a temporary-session envelope', async () => {
  const { createIndexedDbStore } = loadStoreModule();
  const indexedDB = createFakeIndexedDb();
  const envelope = {
    version: 1,
    savedAt: NOW,
    expiresAt: NOW + (24 * 60 * 60 * 1000),
    payload: SAMPLE_SESSION,
  };

  await createIndexedDbStore(indexedDB).set(envelope);
  assert.deepEqual(await createIndexedDbStore(indexedDB).get(), envelope);
  await createIndexedDbStore(indexedDB).remove();
  assert.equal(await createIndexedDbStore(indexedDB).get(), undefined);
});

test('IndexedDB adapter closes a connection that succeeds after an open-blocked rejection', async () => {
  const { createIndexedDbStore } = loadStoreModule();
  let closeCalls = 0;
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        if (request.onblocked) request.onblocked();
        queueMicrotask(() => {
          request.result = { close() { closeCalls += 1; } };
          if (request.onsuccess) request.onsuccess();
        });
      });
      return request;
    },
  };

  await assert.rejects(createIndexedDbStore(indexedDB).get(), /blocked/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
});

function makeEnvironment({ localStorage, sessionStorage } = {}) {
  const destinations = [];
  return {
    localStorage: localStorage || createStorage(),
    sessionStorage: sessionStorage || createStorage(),
    Date: { now: () => NOW },
    location: {
      assign(destination) { destinations.push(destination); },
    },
    destinations,
  };
}

test('save keeps a full temporary transcript out of quota-limited localStorage', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const localStorage = createStorage({}, {
    setError: Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }),
  });
  const sessionStorage = createStorage();
  const indexedStore = createIndexedStore();
  const store = createTemporarySessionStore(
    makeEnvironment({ localStorage, sessionStorage }),
    { indexedStore }
  );

  const result = await store.save(SAMPLE_SESSION);

  assert.deepEqual(result, { source: 'indexeddb' });
  assert.equal(indexedStore.calls.set.length, 1);
  assert.deepEqual(indexedStore.calls.set[0].payload, SAMPLE_SESSION);
  assert.equal(localStorage.calls.set.length, 0, 'large sessions must never be written to localStorage');
  assert.equal(sessionStorage.calls.set.length, 0);
});

test('save falls back to sessionStorage when IndexedDB is unavailable', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const localStorage = createStorage({}, {
    setError: Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }),
  });
  const sessionStorage = createStorage();
  const indexedStore = createIndexedStore(null, { setError: new Error('indexeddb blocked') });
  const store = createTemporarySessionStore(
    makeEnvironment({ localStorage, sessionStorage }),
    { indexedStore }
  );

  const result = await store.save(SAMPLE_SESSION);

  assert.deepEqual(result, { source: 'sessionStorage' });
  assert.equal(localStorage.calls.set.length, 0);
  const saved = JSON.parse(sessionStorage.calls.set[0].value);
  assert.deepEqual(saved.payload, SAMPLE_SESSION);
  assert.equal(saved.savedAt, NOW);
  assert.ok(saved.expiresAt > NOW);
});

test('load prefers a newer sessionStorage fallback over an older readable IndexedDB record', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const indexedStore = createIndexedStore({
    version: 1,
    savedAt: NOW - 60_000,
    expiresAt: NOW + (23 * 60 * 60 * 1000),
    payload: SAMPLE_SESSION,
  }, { setError: new Error('indexeddb update failed') });
  const environment = makeEnvironment();
  const store = createTemporarySessionStore(environment, { indexedStore });

  assert.deepEqual(await store.save(SECOND_SESSION), { source: 'sessionStorage' });

  const result = await store.load();
  assert.deepEqual(result, {
    status: 'ready',
    source: 'sessionStorage',
    session: SECOND_SESSION,
  });
});

test('save reports a storage-specific error when every safe store rejects the session', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const quotaError = Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
  const localStorage = createStorage({}, { setError: quotaError });
  const sessionStorage = createStorage({}, { setError: quotaError });
  const indexedStore = createIndexedStore(null, { setError: new Error('indexeddb blocked') });
  const store = createTemporarySessionStore(
    makeEnvironment({ localStorage, sessionStorage }),
    { indexedStore }
  );

  await assert.rejects(
    store.save(SAMPLE_SESSION),
    (error) => error && error.code === 'TEMP_SESSION_STORAGE_UNAVAILABLE'
  );
  assert.equal(localStorage.calls.set.length, 0);
});

test('load reads an unexpired IndexedDB session and clears invalid web-storage copies', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const indexedStore = createIndexedStore({
    version: 1,
    savedAt: NOW - 1000,
    expiresAt: NOW + 1000,
    payload: SAMPLE_SESSION,
  });
  const localStorage = createStorage({
    youtube_temp_session: JSON.stringify({ title: 'stale local copy' }),
  });
  const store = createTemporarySessionStore(
    makeEnvironment({ localStorage }),
    { indexedStore }
  );

  const result = await store.load();

  assert.deepEqual(result, { status: 'ready', source: 'indexeddb', session: SAMPLE_SESSION });
  assert.equal(localStorage.calls.get.length, 1);
  assert.deepEqual(localStorage.calls.remove, ['youtube_temp_session']);
});

test('load expires temporary sessions after 24 hours and removes the stale record', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const indexedStore = createIndexedStore({
    version: 1,
    savedAt: NOW - (25 * 60 * 60 * 1000),
    expiresAt: NOW - (60 * 60 * 1000),
    payload: SAMPLE_SESSION,
  });
  const store = createTemporarySessionStore(makeEnvironment(), { indexedStore });

  const result = await store.load();

  assert.deepEqual(result, { status: 'expired' });
  assert.equal(indexedStore.calls.remove, 1);
});

test('load rejects objects that do not match the minimum temporary-session schema', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const sessionStorage = createStorage({
    youtube_temp_session: JSON.stringify({ foo: 'bar' }),
  });
  const store = createTemporarySessionStore(
    makeEnvironment({ sessionStorage }),
    { indexedStore: createIndexedStore() }
  );

  assert.deepEqual(await store.load(), { status: 'invalid' });
});

test('load rejects unsupported envelopes instead of treating them as legacy sessions', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const sessionStorage = createStorage({
    youtube_temp_session: JSON.stringify({
      version: 99,
      savedAt: NOW - 1000,
      expiresAt: NOW + 1000,
      payload: SAMPLE_SESSION,
    }),
  });
  const store = createTemporarySessionStore(
    makeEnvironment({ sessionStorage }),
    { indexedStore: createIndexedStore() }
  );

  assert.deepEqual(await store.load(), { status: 'invalid' });
});

test('load migrates a legacy localStorage session without losing refresh support', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const localStorage = createStorage({
    youtube_temp_session: JSON.stringify(SAMPLE_SESSION),
  });
  const sessionStorage = createStorage();
  const indexedStore = createIndexedStore();
  const store = createTemporarySessionStore(
    makeEnvironment({ localStorage, sessionStorage }),
    { indexedStore }
  );

  const result = await store.load();

  assert.deepEqual(result, {
    status: 'ready',
    source: 'legacy-localStorage',
    session: SAMPLE_SESSION,
  });
  assert.equal(indexedStore.calls.set.length, 1, 'legacy data should be copied to IndexedDB');
  assert.deepEqual(localStorage.calls.remove, ['youtube_temp_session']);
});

test('legacy migration keeps its durable localStorage copy when only sessionStorage succeeds', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const localStorage = createStorage({
    youtube_temp_session: JSON.stringify(SAMPLE_SESSION),
  });
  const sessionStorage = createStorage();
  const indexedStore = createIndexedStore(null, { setError: new Error('indexeddb blocked') });
  const store = createTemporarySessionStore(
    makeEnvironment({ localStorage, sessionStorage }),
    { indexedStore }
  );

  assert.deepEqual(await store.load(), {
    status: 'ready',
    source: 'legacy-localStorage',
    session: SAMPLE_SESSION,
  });
  assert.equal(sessionStorage.calls.set.length, 1);
  assert.deepEqual(localStorage.calls.remove, []);
});

test('handoff navigates only after the temporary session is safely stored', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const environment = makeEnvironment();
  const indexedStore = createIndexedStore();
  const store = createTemporarySessionStore(environment, { indexedStore });

  await store.saveAndNavigate(SAMPLE_SESSION, '/youtube-reader.html');

  assert.equal(indexedStore.calls.set.length, 1);
  assert.deepEqual(environment.destinations, ['/youtube-reader.html']);
});

test('handoff keeps the user on the import page and names storage exhaustion accurately', async () => {
  const { createTemporarySessionStore } = loadStoreModule();
  const quotaError = Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
  const environment = makeEnvironment({
    localStorage: createStorage({}, { setError: quotaError }),
    sessionStorage: createStorage({}, { setError: quotaError }),
  });
  const store = createTemporarySessionStore(environment, {
    indexedStore: createIndexedStore(null, { setError: new Error('indexeddb blocked') }),
  });

  await assert.rejects(store.saveAndNavigate(SAMPLE_SESSION, '/youtube-reader.html'));

  assert.deepEqual(environment.destinations, []);
  const message = store.getSaveErrorMessage({ code: 'TEMP_SESSION_STORAGE_UNAVAILABLE' });
  assert.match(message, /浏览器存储空间/);
  assert.doesNotMatch(message, /网络错误/);
});
