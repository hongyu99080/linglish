const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let MediaSession = {};
try {
  MediaSession = require('../../frontend/js/media-session');
} catch (_) {
  // RED phase: behavior assertions below fail until the shared client exists.
}

function jsonResponse(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

function successResponse(overrides = {}) {
  return jsonResponse(200, {
    expires_at: '2030-01-01T00:15:00.000Z',
    ttl_seconds: 900,
    refresh_after_seconds: 600,
    ...overrides,
  });
}

function createClient(options = {}) {
  assert.equal(typeof MediaSession.createMediaSessionClient, 'function');
  return MediaSession.createMediaSessionClient(options);
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function accountToken(subject) {
  const payload = Buffer.from(JSON.stringify({ sub: subject, exp: 4_102_444_800 })).toString('base64url');
  return `e30.${payload}.signature`;
}

function loadAuthManager({ initialToken, mediaSession }) {
  const localStorage = createStorage({
    linglish_app_version: '2024.12.16.002',
    ...(initialToken ? { authToken: initialToken, linglish_token: initialToken } : {}),
  });
  const sessionStorage = createStorage();
  const document = { cookie: '' };
  const navigator = { cookieEnabled: false };
  const window = { localStorage, sessionStorage, document, navigator, LinglishMediaSession: mediaSession };
  window.window = window;
  const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/auth-manager.js'), 'utf8');
  vm.runInNewContext(source, {
    window,
    document,
    navigator,
    localStorage,
    sessionStorage,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    console: { log() {}, info() {}, warn() {}, error() {} },
    fetch: async () => jsonResponse(200),
    Date,
    Promise,
    setTimeout,
    clearTimeout,
  });
  return { AuthManager: window.AuthManager, localStorage };
}

test('session media URLs stay clean while explicit old-node legacy URLs carry the account token', () => {
  assert.equal(typeof MediaSession.buildMediaUrl, 'function');
  assert.equal(
    MediaSession.buildMediaUrl('/videos/a.mp4', { mode: 'session', legacyToken: 'secret' }),
    '/videos/a.mp4',
  );
  assert.equal(
    MediaSession.buildMediaUrl('/videos/a.mp4', { mode: 'legacy', legacyToken: 'secret' }),
    '/videos/a.mp4?token=secret',
  );
  assert.equal(
    MediaSession.buildMediaUrl('/recordings/a.webm?download=1#clip', {
      mode: 'legacy',
      legacyToken: 'a b',
    }),
    '/recordings/a.webm?download=1&token=a%20b#clip',
  );
});

test('legacy URL construction accepts only exact same-origin protected paths', () => {
  const options = {
    mode: 'legacy',
    legacyToken: 'account-secret',
    baseUrl: 'https://app.example.test/reader.html',
  };

  assert.equal(
    MediaSession.buildMediaUrl('https://app.example.test/pdfs/a.pdf?download=1', options),
    'https://app.example.test/pdfs/a.pdf?download=1&token=account-secret',
  );
  for (const unsafe of [
    'https://www.youtube.com/watch?v=abcdefghijk',
    'https://media.example.test/videos/a.mp4',
    '//evil.example.test/recordings/a.webm',
    '/videos-archive/a.mp4',
    '/api/video-resources/1',
  ]) {
    assert.throws(
      () => MediaSession.buildMediaUrl(unsafe, options),
      err => err && err.code === 'UNSAFE_LEGACY_MEDIA_URL',
      unsafe,
    );
  }
});

test('debug payload sanitization removes media source fields and query credentials recursively', () => {
  assert.equal(typeof MediaSession.sanitizeDebugPayload, 'function');
  const sanitized = MediaSession.sanitizeDebugPayload({
    src: 'https://app.example.test/videos/a.mp4?token=account-secret',
    nested: {
      currentSrc: '/recordings/a.webm?token=account-secret',
      audioSrc: '/recordings/b.webm?token=account-secret',
      url: 'https://app.example.test/pdfs/a.pdf?token=account-secret#page=2',
    },
    message: 'failed https://app.example.test/videos/a.mp4?token=account-secret',
    ready: true,
  }, { baseUrl: 'https://app.example.test/' });
  const serialized = JSON.stringify(sanitized);

  assert.deepEqual(sanitized, {
    nested: { url: '/pdfs/a.pdf' },
    message: 'failed /videos/a.mp4',
    ready: true,
  });
  assert.doesNotMatch(serialized, /account-secret|token=|currentSrc|audioSrc|"src"/i);
});

test('concurrent bootstrap calls share one credentialed POST', async () => {
  const requests = [];
  let release;
  const fetchImpl = (url, init) => {
    requests.push({ url, init });
    return new Promise(resolve => { release = () => resolve(successResponse()); });
  };
  const client = createClient({ fetchImpl });

  const first = client.ensure({ token: 'account-a', now: () => 0 });
  const second = client.ensure({ token: 'account-a', now: () => 0 });
  assert.equal(requests.length, 1);
  release();

  assert.deepEqual(await first, await second);
  assert.equal(requests[0].url, '/auth/media-session');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'include');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer account-a');
});

test('401 and 403 bootstrap failures never select legacy account-token URLs', async () => {
  for (const status of [401, 403]) {
    const client = createClient({ fetchImpl: async () => jsonResponse(status, { message: 'denied' }) });
    await assert.rejects(
      () => client.ensure({ token: 'account-secret', now: () => 0 }),
      err => err && err.status === status && err.code === 'MEDIA_SESSION_BOOTSTRAP_FAILED',
    );
    assert.equal(client.getState().mode, null);
  }
});

test('only a 404 or 405 bootstrap response enables rolling legacy mode', async () => {
  for (const status of [404, 405]) {
    const client = createClient({ fetchImpl: async () => jsonResponse(status) });
    const state = await client.ensure({ token: 'account-secret', now: () => 10 });
    assert.equal(state.mode, 'legacy');
    assert.equal(
      client.buildMediaUrl('/videos/old.mp4', { legacyToken: 'account-secret' }),
      '/videos/old.mp4?token=account-secret',
    );
  }

  const client = createClient({ fetchImpl: async () => jsonResponse(500) });
  await assert.rejects(
    () => client.ensure({ token: 'account-secret', now: () => 10 }),
    err => err && err.status === 500,
  );
  assert.equal(client.getState().mode, null);
});

test('a live session refreshes at 600 seconds and does not reuse an expired bootstrap', async () => {
  let now = 0;
  let calls = 0;
  const client = createClient({
    fetchImpl: async () => {
      calls += 1;
      return successResponse();
    },
  });

  await client.ensure({ token: 'account-a', now: () => now });
  now = 599_999;
  await client.ensure({ token: 'account-a', now: () => now });
  assert.equal(calls, 1);
  now = 600_000;
  await client.ensure({ token: 'account-a', now: () => now });
  assert.equal(calls, 2);

  let expiryCalls = 0;
  now = 0;
  const expiryClient = createClient({
    fetchImpl: async () => {
      expiryCalls += 1;
      return successResponse({ ttl_seconds: 900, refresh_after_seconds: 1_200 });
    },
  });
  await expiryClient.ensure({ token: 'account-a', now: () => now });
  now = 899_999;
  await expiryClient.ensure({ token: 'account-a', now: () => now });
  assert.equal(expiryCalls, 1);
  now = 900_000;
  await expiryClient.ensure({ token: 'account-a', now: () => now });
  assert.equal(expiryCalls, 2);
});

test('account switching and explicit clear delete the old cookie before another bootstrap', async () => {
  const methods = [];
  const client = createClient({
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      return init.method === 'DELETE' ? jsonResponse(200, { ok: true }) : successResponse();
    },
  });

  await client.ensure({ token: 'account-a', now: () => 0 });
  await client.ensure({ token: 'account-b', now: () => 1 });
  await client.clear();
  await client.ensure({ token: 'account-b', now: () => 2 });

  assert.deepEqual(methods, ['POST', 'DELETE', 'POST', 'DELETE', 'POST']);
  assert.equal(client.getState().mode, 'session');
});

test('clear during bootstrap prevents the stale response from restoring media-session state', async () => {
  const methods = [];
  let releaseBootstrap;
  const client = createClient({
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'DELETE') return jsonResponse(200, { ok: true });
      return new Promise(resolve => {
        releaseBootstrap = () => resolve(successResponse());
      });
    },
  });

  const bootstrap = client.ensure({ token: 'account-a', now: () => 0 });
  const clearing = client.clear();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(methods, ['POST']);
  releaseBootstrap();
  await Promise.all([bootstrap, clearing]);

  assert.deepEqual(methods, ['POST', 'DELETE']);
  assert.deepEqual(client.getState(), { mode: null, refreshAt: 0, expiresAt: 0 });
});

test('clear cancels an account switch queued behind an in-flight bootstrap', async () => {
  const methods = [];
  let postCount = 0;
  let releaseBootstrap;
  const client = createClient({
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'DELETE') return jsonResponse(200, { ok: true });
      postCount += 1;
      if (postCount > 1) return successResponse();
      return new Promise(resolve => {
        releaseBootstrap = () => resolve(successResponse());
      });
    },
  });

  const first = client.ensure({ token: 'account-a', now: () => 0 });
  const queuedSwitch = client.ensure({ token: 'account-b', now: () => 1 });
  const clearing = client.clear();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(methods, ['POST']);
  releaseBootstrap();
  await Promise.all([first, queuedSwitch, clearing]);

  assert.deepEqual(methods, ['POST', 'DELETE']);
  assert.deepEqual(client.getState(), { mode: null, refreshAt: 0, expiresAt: 0 });
});

test('a replacement bootstrap cannot POST until an active clear finishes DELETE', async () => {
  const methods = [];
  let releaseFirstPost;
  const client = createClient({
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'DELETE') return jsonResponse(200, { ok: true });
      if (methods.filter(method => method === 'POST').length === 1) {
        return new Promise(resolve => { releaseFirstPost = () => resolve(successResponse()); });
      }
      return successResponse();
    },
  });

  const first = client.ensure({ token: 'account-a', now: () => 0 });
  const clearing = client.clear();
  const replacement = client.ensure({ token: 'account-b', now: () => 1 });
  await new Promise(resolve => setImmediate(resolve));
  releaseFirstPost();
  await Promise.all([first, clearing, replacement]);

  assert.deepEqual(methods, ['POST', 'DELETE', 'POST']);
  assert.equal(client.getState().mode, 'session');
});

test('AuthManager replacement waits for DELETE and the media client orders POST DELETE POST', async () => {
  const methods = [];
  let releaseDelete;
  const client = createClient({
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'DELETE') {
        return new Promise(resolve => { releaseDelete = () => resolve(jsonResponse(200, { ok: true })); });
      }
      return successResponse();
    },
  });
  const oldToken = accountToken('account-a');
  const nextToken = accountToken('account-b');
  await client.ensure({ token: oldToken, now: () => 0 });
  const { AuthManager, localStorage } = loadAuthManager({ initialToken: oldToken, mediaSession: client });

  const transition = AuthManager.setToken(nextToken, true);
  const replacement = client.ensure({ token: nextToken, now: () => 1 });
  await new Promise(resolve => setImmediate(resolve));

  try {
    assert.equal(typeof transition?.then, 'function');
    assert.notEqual(localStorage.getItem('authToken'), nextToken);
    assert.deepEqual(methods, ['POST', 'DELETE']);
  } finally {
    releaseDelete?.();
  }

  await Promise.all([transition, replacement]);
  assert.deepEqual(methods, ['POST', 'DELETE', 'POST']);
  assert.equal(localStorage.getItem('authToken'), nextToken);
});

test('rapid guarded source authorization assigns only the latest selection', async () => {
  let releaseBootstrap;
  const assigned = [];
  const element = { set src(value) { assigned.push(value); } };
  const client = createClient({
    fetchImpl: async () => new Promise(resolve => {
      releaseBootstrap = () => resolve(successResponse());
    }),
  });
  assert.equal(typeof client.authorizeElementSource, 'function');

  let generation = 0;
  const firstGeneration = ++generation;
  const first = client.authorizeElementSource(element, '/videos/old.mp4', {
    token: 'account-a',
    isCurrent: () => generation === firstGeneration,
  });
  const secondGeneration = ++generation;
  const second = client.authorizeElementSource(element, '/videos/latest.mp4', {
    token: 'account-a',
    isCurrent: () => generation === secondGeneration,
  });
  releaseBootstrap();

  assert.equal(await first, null);
  assert.equal(await second, '/videos/latest.mp4');
  assert.deepEqual(assigned, ['/videos/latest.mp4']);
});

test('cross-origin session mode assigns credentials first while legacy mode rejects the external URL', () => {
  const changes = [];
  const element = {
    set crossOrigin(value) { changes.push(`crossOrigin:${value}`); },
    set src(value) { changes.push(`src:${value}`); },
  };
  const client = createClient({ baseUrl: 'https://app.example.test/reader.html' });

  const url = client.setElementSource(element, 'https://media.example.test/videos/a.mp4', {
    mode: 'session',
    legacyToken: 'account-secret',
  });

  assert.equal(url, 'https://media.example.test/videos/a.mp4');
  assert.deepEqual(changes, [
    'crossOrigin:use-credentials',
    'src:https://media.example.test/videos/a.mp4',
  ]);

  changes.length = 0;
  assert.throws(
    () => client.setElementSource(element, 'https://media.example.test/videos/old.mp4', {
      mode: 'legacy',
      legacyToken: 'account-secret',
    }),
    err => err && err.code === 'UNSAFE_LEGACY_MEDIA_URL',
  );
  assert.deepEqual(changes, []);
});

test('visible, play, and seeking lifecycle events rotate a due media session', async () => {
  const listeners = new Map();
  const document = {
    visibilityState: 'visible',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener() {},
  };
  let now = 0;
  let calls = 0;
  const client = createClient({
    document,
    fetchImpl: async () => {
      calls += 1;
      return successResponse();
    },
  });
  client.bindLifecycle({ getToken: () => 'account-a', now: () => now });
  await client.ensure({ token: 'account-a', now: () => now });

  for (const [eventName, timestamp] of [
    ['play', 600_000],
    ['seeking', 1_200_000],
    ['visibilitychange', 1_800_000],
  ]) {
    now = timestamp;
    listeners.get(eventName)({ target: {} });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(calls, 4);

  document.visibilityState = 'hidden';
  now = 2_400_000;
  listeners.get('visibilitychange')({ target: document });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 4);
});

test('share-scoped lifecycle events with no account token make zero bootstrap calls', async () => {
  const listeners = new Map();
  const document = {
    visibilityState: 'visible',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener() {},
  };
  let calls = 0;
  const client = createClient({
    document,
    fetchImpl: async () => {
      calls += 1;
      return successResponse();
    },
  });
  client.bindLifecycle({ getToken: () => null });

  listeners.get('play')({ target: {} });
  listeners.get('seeking')({ target: {} });
  listeners.get('visibilitychange')({ target: document });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls, 0);
});
