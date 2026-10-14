const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const smartImport = require('../services/smart-import');

const KEY_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_TWO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createLifecycleDatabase() {
  const rows = new Map();

  function clone(row) {
    return row ? { ...row } : row;
  }

  async function query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized.includes('FROM users u')) {
      return { rows: [{ user_level: 'intermediate', import_budget: 9 }] };
    }
    if (normalized.startsWith('INSERT INTO video_learning_sessions')) {
      const [sessionId, userId, videoId, userLevel, importBudget, lifecycleKey] = params;
      const key = `${userId}:${lifecycleKey}`;
      const existing = rows.get(key);
      if (existing) {
        if (normalized.includes("DO UPDATE SET status = 'abandoned'") && existing.video_id === String(videoId)
          && existing.status === 'active') {
          existing.status = 'abandoned';
        }
        return { rows: normalized.includes('DO NOTHING') ? [] : [clone(existing)], rowCount: normalized.includes('DO NOTHING') ? 0 : 1 };
      }
      const row = {
        session_id: sessionId,
        user_id: String(userId),
        video_id: String(videoId),
        lifecycle_key: lifecycleKey,
        user_level: userLevel,
        import_budget: importBudget,
        status: normalized.includes("'abandoned'") ? 'abandoned' : 'active',
      };
      rows.set(key, row);
      return { rows: [clone(row)], rowCount: 1 };
    }
    if (normalized.includes('FROM video_learning_sessions') && normalized.includes('lifecycle_key = $2')) {
      const [userId, lifecycleKey] = params;
      const row = rows.get(`${userId}:${lifecycleKey}`);
      return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`Unexpected lifecycle SQL: ${normalized}`);
  }

  return { query, rows };
}

test('SmartImport lifecycle start is idempotent per user key and keeps users scoped', async () => {
  const database = createLifecycleDatabase();
  let sequence = 0;
  const store = smartImport.createSessionLifecycleStore({
    query: database.query,
    sessionIdFactory: () => `server-session-${++sequence}`,
  });

  const first = await store.startSession('41', '8', KEY_ONE);
  const retry = await store.startSession('41', '8', KEY_ONE);
  const otherUser = await store.startSession('42', '8', KEY_ONE);

  assert.equal(first.sessionId, 'server-session-1');
  assert.equal(retry.sessionId, first.sessionId);
  assert.equal(retry.status, 'active');
  assert.equal(otherUser.sessionId, 'server-session-3');
  assert.equal(database.rows.size, 2);
});

test('SmartImport lifecycle tombstone closes pending start and does not touch a same-video successor', async () => {
  const database = createLifecycleDatabase();
  let sequence = 0;
  const store = smartImport.createSessionLifecycleStore({
    query: database.query,
    sessionIdFactory: () => `server-session-${++sequence}`,
  });

  const closed = await store.closeLifecycle('41', '8', KEY_ONE);
  const lateStart = await store.startSession('41', '8', KEY_ONE);
  const successor = await store.startSession('41', '8', KEY_TWO);
  await store.closeLifecycle('41', '8', KEY_ONE);

  assert.equal(closed.status, 'abandoned');
  assert.equal(lateStart.sessionId, closed.sessionId);
  assert.equal(lateStart.status, 'abandoned');
  assert.equal(successor.status, 'active');
  assert.equal(database.rows.get(`41:${KEY_TWO}`).status, 'active');
});

test('SmartImport legacy start generates a server lifecycle key and still creates an active session', async () => {
  const database = createLifecycleDatabase();
  const generatedKey = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const store = smartImport.createSessionLifecycleStore({
    query: database.query,
    sessionIdFactory: () => 'legacy-session',
    lifecycleKeyFactory: () => generatedKey,
  });

  const result = await store.startSession('41', '8');

  assert.equal(result.sessionId, 'legacy-session');
  assert.equal(result.lifecycleKey, generatedKey);
  assert.equal(result.status, 'active');
  await assert.rejects(
    store.startSession('41', '8', ''),
    (error) => error?.code === 'SMART_IMPORT_VALIDATION',
  );
});

test('SmartImport finisher supports legacy ownership, scopes users, and normalizes new lifecycle keys', async () => {
  const sessions = new Map([
    ['legacy-session', { session_id: 'legacy-session', user_id: '41', lifecycle_key: null, status: 'active' }],
    ['new-session', { session_id: 'new-session', user_id: '41', lifecycle_key: KEY_ONE, status: 'active' }],
  ]);
  const lookupKeys = [];
  const finisher = smartImport.createSessionFinisher({
    async getSessionForUser(userId, sessionId, lifecycleKey) {
      lookupKeys.push(lifecycleKey);
      const row = sessions.get(sessionId);
      if (!row || row.user_id !== String(userId)) return null;
      if (lifecycleKey !== null && row.lifecycle_key !== lifecycleKey) return null;
      return { ...row };
    },
    async query(sql, params) {
      if (String(sql).includes("SET status = 'finished'")) {
        const row = sessions.get(params[2]);
        if (row && row.user_id === String(params[3])) row.status = 'finished';
      }
      return { rowCount: 1, rows: [] };
    },
    async generateRecommendations() {
      return { uniqueLemmas: 0, clickedCount: 0, totalOccurrences: 0, recommendedCount: 0 };
    },
  });

  await finisher.finishSession('41', 'legacy-session', [], 0);
  await finisher.finishSession('41', 'new-session', [], 0, KEY_ONE.toUpperCase());

  assert.equal(sessions.get('legacy-session').status, 'finished');
  assert.equal(sessions.get('new-session').status, 'finished');
  assert.deepEqual(lookupKeys, [null, KEY_ONE]);
  await assert.rejects(
    finisher.finishSession('42', 'legacy-session', [], 0),
    (error) => error?.code === 'SMART_IMPORT_SESSION_NOT_FOUND',
  );
  await assert.rejects(
    finisher.finishSession('41', 'new-session', [], 0, 'not-a-uuid'),
    (error) => error?.code === 'SMART_IMPORT_VALIDATION',
  );
  await assert.rejects(
    finisher.finishSession('41', 'new-session', [], 0, ''),
    (error) => error?.code === 'SMART_IMPORT_VALIDATION',
  );
});

function loadVocabularyRouteWithFakes({ requireUser, authenticate, smartImportService }) {
  const routePath = require.resolve('../routes/vocabulary-v2');
  const realErrorHandler = require('../middleware/error-handler');
  const replacements = new Map([
    [require.resolve('../services/vocabulary-v2'), {}],
    [require.resolve('../services/smart-import'), smartImportService],
    [require.resolve('../services/auth'), { requireUser }],
    [require.resolve('../utils/parsers'), { parseBody: async (req) => req.body }],
    [require.resolve('../middleware/error-handler'), {
      ...realErrorHandler,
      sendJson(res, status, body) { res.status = status; res.body = body; return true; },
      sendError(res, status, message) { res.status = status; res.body = { message }; return true; },
    }],
    [require.resolve('../middleware/auth'), { authenticate: authenticate || (async () => ({ id: 'not-used' })) }],
  ]);
  const saved = new Map();
  for (const [modulePath, exports] of replacements) {
    saved.set(modulePath, require.cache[modulePath]);
    require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
  }
  delete require.cache[routePath];
  const loaded = require('../routes/vocabulary-v2');
  delete require.cache[routePath];
  for (const [modulePath, cached] of saved) {
    if (cached) require.cache[modulePath] = cached;
    else delete require.cache[modulePath];
  }
  return loaded;
}

test('my vocabulary route returns 401 when authentication is missing', async () => {
  const { registerVocabularyV2Routes } = loadVocabularyRouteWithFakes({
    requireUser: async () => ({ id: 'not-used' }),
    authenticate: async () => { throw new Error('UNAUTHORIZED'); },
    smartImportService: {},
  });
  const response = {};

  await registerVocabularyV2Routes(
    '/vocabulary/v2/my',
    { method: 'GET' },
    response,
    new URL('https://linglish.test/vocabulary/v2/my'),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { message: 'UNAUTHORIZED' });
});

test('my vocabulary route keeps unexpected failures at 500', async () => {
  const { registerVocabularyV2Routes } = loadVocabularyRouteWithFakes({
    requireUser: async () => ({ id: 'not-used' }),
    authenticate: async () => { throw new Error('UNEXPECTED_FAILURE'); },
    smartImportService: {},
  });
  const response = {};

  await registerVocabularyV2Routes(
    '/vocabulary/v2/my',
    { method: 'GET' },
    response,
    new URL('https://linglish.test/vocabulary/v2/my'),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { message: 'UNEXPECTED_FAILURE' });
});

test('SmartImport unload beacon authenticates and closes the exact pending lifecycle', async () => {
  const calls = [];
  const { registerVocabularyV2Routes } = loadVocabularyRouteWithFakes({
    requireUser: async (token) => ({ id: token === 'valid-token' ? '41' : null }),
    smartImportService: {
      async closeSessionLifecycle(userId, videoId, lifecycleKey) {
        calls.push({ userId, videoId, lifecycleKey });
      },
    },
  });
  const req = {
    method: 'POST',
    body: { token: 'valid-token', videoId: '8', lifecycleKey: KEY_ONE },
  };
  const res = {};

  await registerVocabularyV2Routes(
    '/vocabulary/v2/smart-import/finish-beacon',
    req,
    res,
    new URL('https://linglish.test/vocabulary/v2/smart-import/finish-beacon'),
  );

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, queued: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ userId: '41', videoId: '8', lifecycleKey: KEY_ONE }]);
});

test('SmartImport routes accept legacy start and finish payloads during rolling deployment', async () => {
  const calls = [];
  const { registerVocabularyV2Routes } = loadVocabularyRouteWithFakes({
    requireUser: async () => ({ id: '41' }),
    authenticate: async () => ({ id: '41' }),
    smartImportService: {
      async startSession(userId, videoId, lifecycleKey) {
        calls.push({ operation: 'start', userId, videoId, lifecycleKey });
        return { sessionId: 'legacy-session', lifecycleKey: KEY_ONE, status: 'active' };
      },
      async finishSession(userId, sessionId, watchedSegments, watchDurationSec, lifecycleKey) {
        calls.push({ operation: 'finish', userId, sessionId, watchedSegments, watchDurationSec, lifecycleKey });
        return { recommendedCount: 0 };
      },
    },
  });
  const startResponse = {};
  const finishResponse = {};

  await registerVocabularyV2Routes(
    '/vocabulary/v2/smart-import/start-session',
    { method: 'POST', body: { videoId: '8' } },
    startResponse,
    new URL('https://linglish.test/vocabulary/v2/smart-import/start-session'),
  );
  await registerVocabularyV2Routes(
    '/vocabulary/v2/smart-import/finish',
    { method: 'POST', body: { sessionId: 'legacy-session' } },
    finishResponse,
    new URL('https://linglish.test/vocabulary/v2/smart-import/finish'),
  );

  assert.equal(startResponse.status, 200);
  assert.equal(finishResponse.status, 200);
  assert.deepEqual(calls, [
    { operation: 'start', userId: '41', videoId: '8', lifecycleKey: undefined },
    {
      operation: 'finish', userId: '41', sessionId: 'legacy-session',
      watchedSegments: [], watchDurationSec: 0, lifecycleKey: undefined,
    },
  ]);
});

test('SmartImport finish route maps lifecycle validation and cross-user ownership failures', async () => {
  const errors = [
    Object.assign(new Error('lifecycleKey must be a UUID v4'), { code: 'SMART_IMPORT_VALIDATION' }),
    Object.assign(new Error('Session not found'), { code: 'SMART_IMPORT_SESSION_NOT_FOUND' }),
  ];
  const { registerVocabularyV2Routes } = loadVocabularyRouteWithFakes({
    requireUser: async () => ({ id: '42' }),
    authenticate: async () => ({ id: '42' }),
    smartImportService: {
      async finishSession() { throw errors.shift(); },
    },
  });
  const invalidResponse = {};
  const foreignResponse = {};

  await registerVocabularyV2Routes(
    '/vocabulary/v2/smart-import/finish',
    { method: 'POST', body: { sessionId: 'new-session', lifecycleKey: 'not-a-uuid' } },
    invalidResponse,
    new URL('https://linglish.test/vocabulary/v2/smart-import/finish'),
  );
  await registerVocabularyV2Routes(
    '/vocabulary/v2/smart-import/finish',
    { method: 'POST', body: { sessionId: 'foreign-session' } },
    foreignResponse,
    new URL('https://linglish.test/vocabulary/v2/smart-import/finish'),
  );

  assert.equal(invalidResponse.status, 400);
  assert.equal(foreignResponse.status, 404);
});

test('production SmartImport browser API sends lifecycle keys on start, finish, and abandon', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/video-reader/smart-import-api.js'), 'utf8');
  const requests = [];
  const context = {
    console: { log() {}, warn() {} },
    localStorage: { getItem: (key) => (key === 'linglish_token' ? 'auth-token' : null) },
    sessionStorage: { getItem: () => null },
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, json: async () => ({ sessionId: 'session-1', status: 'active' }) };
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'smart-import-api.js' });

  await context.window.SmartImportAPI.startSession('8', KEY_ONE);
  await context.window.SmartImportAPI.finishSession('session-1', [1, 2], 30, KEY_ONE);
  await context.window.SmartImportAPI.closeLifecycle('8', KEY_ONE);

  assert.deepEqual(requests, [
    {
      url: '/vocabulary/v2/smart-import/start-session', method: 'POST',
      body: { videoId: '8', lifecycleKey: KEY_ONE },
    },
    {
      url: '/vocabulary/v2/smart-import/finish', method: 'POST',
      body: { sessionId: 'session-1', watchedSegments: [1, 2], watchDurationSec: 30, lifecycleKey: KEY_ONE },
    },
    {
      url: '/vocabulary/v2/smart-import/abandon', method: 'POST',
      body: { videoId: '8', lifecycleKey: KEY_ONE },
    },
  ]);
});

test('mobile Today preload and executed script use the same cache version', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/mobile-today.html'), 'utf8');
  const preloadVersion = html.match(/<link[^>]+rel="preload"[^>]+href="\.\/js\/mobile-today\.js\?v=([^"&]+)"/)?.[1];
  const scriptVersion = html.match(/<script[^>]+src="\.\/js\/mobile-today\.js\?v=([^"&]+)"/)?.[1];
  assert.equal(preloadVersion, scriptVersion);
});
