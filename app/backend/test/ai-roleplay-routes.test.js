'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { Readable } = require('node:stream');

function makeReq(method, body = {}) {
  return {
    method,
    headers: { host: 'test.local' },
    body,
  };
}

function makeStreamReq(method, chunks, headers = {}) {
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = { host: 'test.local', ...headers };
  return req;
}

function makeRes() {
  return {
    headers: {},
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers = {}) {
      this.status = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(payload = '') {
      this.payload = payload;
      this.body = payload ? JSON.parse(payload) : null;
      this.writableEnded = true;
    },
  };
}

function makeUrl(pathname) {
  return new URL(pathname, 'http://test.local');
}

function makeJsonDeps(overrides = {}) {
  const calls = [];
  const deps = {
    aiConfig: { features: { aiRoleplay: true } },
    authenticate: async () => {
      calls.push('auth');
      return { id: '42' };
    },
    parseBody: async (req) => req.body,
    sendJson: (res, status, body) => {
      res.status = status;
      res.body = body;
      res.headersSent = true;
      calls.push(`send:${status}`);
      return true;
    },
    sendError: (res, status, message) => {
      res.status = status;
      res.body = { code: status, message };
      res.headersSent = true;
      calls.push(`error:${status}`);
      return true;
    },
    engine: {
      listScenarios: async (userId, filters) => {
        calls.push(`engine:list:${userId}:${filters.level || ''}:${filters.category || ''}`);
        return [{ id: 'coffee-shop', title_en: 'Coffee shop' }];
      },
      startSession: async (userId, input) => {
        calls.push(`engine:start:${userId}:${input.scenario_id}`);
        return { session: { id: '9001', user_id: String(userId) } };
      },
      getSession: async (userId, sessionId) => {
        calls.push(`engine:get:${userId}:${sessionId}:${typeof sessionId}`);
        return { session: { id: sessionId, user_id: String(userId), turns: [] } };
      },
      advanceTurn: async (userId, sessionId, input) => {
        calls.push(`engine:turn:${userId}:${sessionId}:${typeof sessionId}:${input.turn_key}`);
        return {
          session: { id: sessionId, user_id: String(userId), status: 'active' },
          turn: { id: '12', session_id: sessionId, learner_text: input.transcript },
        };
      },
      completeSession: async (userId, sessionId) => {
        calls.push(`engine:complete:${userId}:${sessionId}:${typeof sessionId}`);
        return { id: sessionId, user_id: String(userId), status: 'completed' };
      },
    },
    transcriber: {
      transcribe: async (input) => {
        calls.push(`transcribe:${input.duration_seconds}`);
        return { transcript: 'I would like coffee.', duration_seconds: 1.2, provider: 'fake' };
      },
    },
  };
  return { deps: { ...deps, ...overrides }, calls };
}

async function callRoute(pathWithQuery, method, body, deps) {
  const { registerAIRoleplayRoutes } = require('../routes/ai-roleplay');
  const url = makeUrl(pathWithQuery);
  const res = makeRes();
  const handled = await registerAIRoleplayRoutes(url.pathname, makeReq(method, body), res, url, deps);
  return { handled, res };
}

test('GET /ai-roleplay/scenarios authenticates before listing scenarios and returns 200', async () => {
  const { deps, calls } = makeJsonDeps();

  const { handled, res } = await callRoute('/ai-roleplay/scenarios?level=A2&category=travel', 'GET', {}, deps);

  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { scenarios: [{ id: 'coffee-shop', title_en: 'Coffee shop' }] });
  assert.deepEqual(calls.slice(0, 2), ['auth', 'engine:list:42:A2:travel']);
});

test('POST /ai-roleplay/sessions authenticates before starting a session and returns 201', async () => {
  const { deps, calls } = makeJsonDeps();

  const { res } = await callRoute('/ai-roleplay/sessions', 'POST', { scenario_id: 'coffee-shop' }, deps);

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { session: { id: '9001', user_id: '42' } });
  assert.deepEqual(calls.slice(0, 2), ['auth', 'engine:start:42:coffee-shop']);
});

test('GET /ai-roleplay/sessions/:id keeps canonical decimal route IDs as strings', async () => {
  const { deps, calls } = makeJsonDeps();

  const { res } = await callRoute('/ai-roleplay/sessions/9001', 'GET', {}, deps);

  assert.equal(res.status, 200);
  assert.equal(res.body.session.id, '9001');
  assert.deepEqual(calls.slice(0, 2), ['auth', 'engine:get:42:9001:string']);
});

test('GET /ai-roleplay/sessions/:id maps another user session to 404', async () => {
  const notFound = new Error('SESSION_NOT_FOUND');
  notFound.code = 'SESSION_NOT_FOUND';
  const { deps } = makeJsonDeps({
    engine: {
      getSession: async () => {
        throw notFound;
      },
    },
  });

  const { res } = await callRoute('/ai-roleplay/sessions/9001', 'GET', {}, deps);

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { code: 'SESSION_NOT_FOUND' });
});

test('POST /ai-roleplay/sessions/:id/turns returns 201 and never coerces decimal IDs', async () => {
  const { deps, calls } = makeJsonDeps();

  const { res } = await callRoute('/ai-roleplay/sessions/9001/turns', 'POST', {
    turn_key: '123e4567-e89b-42d3-a456-426614174000',
    transcript: 'I would like coffee.',
  }, deps);

  assert.equal(res.status, 201);
  assert.equal(res.body.session.id, '9001');
  assert.deepEqual(calls.slice(0, 2), [
    'auth',
    'engine:turn:42:9001:string:123e4567-e89b-42d3-a456-426614174000',
  ]);
});

test('POST /ai-roleplay/sessions/:id/turns maps TURN_IN_PROGRESS to retry payload', async () => {
  const inProgress = new Error('TURN_IN_PROGRESS');
  inProgress.code = 'TURN_IN_PROGRESS';
  inProgress.status = 409;
  const { deps } = makeJsonDeps({
    engine: {
      advanceTurn: async () => {
        throw inProgress;
      },
    },
  });

  const { res } = await callRoute('/ai-roleplay/sessions/9001/turns', 'POST', {
    turn_key: '123e4567-e89b-42d3-a456-426614174000',
    transcript: 'secret learner transcript',
  }, deps);

  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { code: 'TURN_IN_PROGRESS', retry_after_ms: 600 });
  assert.equal(JSON.stringify(res.body).includes('secret learner transcript'), false);
});

test('POST /ai-roleplay/sessions/:id/turns rejects malformed UUID with 400 before engine work', async () => {
  const { deps, calls } = makeJsonDeps();

  const { res } = await callRoute('/ai-roleplay/sessions/9001/turns', 'POST', {
    turn_key: 'not-a-uuid',
    transcript: 'I would like coffee.',
  }, deps);

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { code: 'TURN_KEY_INVALID' });
  assert.deepEqual(calls.slice(0, 1), ['auth']);
  assert.equal(calls.some((call) => call.startsWith('engine:turn')), false);
});

test('POST /ai-roleplay/sessions/:id/complete authenticates before completing and returns 200', async () => {
  const { deps, calls } = makeJsonDeps();

  const { res } = await callRoute('/ai-roleplay/sessions/9001/complete', 'POST', {}, deps);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'completed');
  assert.deepEqual(calls.slice(0, 2), ['auth', 'engine:complete:42:9001:string']);
});

test('POST /ai-roleplay/transcribe authenticates before transcribing and returns 200', async () => {
  const { deps, calls } = makeJsonDeps();

  const { res } = await callRoute('/ai-roleplay/transcribe', 'POST', {
    audio_data: 'data:audio/webm;base64,AAAA',
    duration_seconds: 1.2,
  }, deps);

  assert.equal(res.status, 200);
  assert.equal(res.body.transcript, 'I would like coffee.');
  assert.deepEqual(calls.slice(0, 2), ['auth', 'transcribe:1.2']);
});

test('disabled roleplay feature returns generic 404 without auth, engine, or provider details', async () => {
  const { deps, calls } = makeJsonDeps({
    aiConfig: { features: { aiRoleplay: false }, openai: { baseURL: 'https://provider.example' } },
  });

  const { res } = await callRoute('/ai-roleplay/scenarios', 'GET', {}, deps);

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { code: 404, message: 'Not Found' });
  assert.equal(calls.some((call) => call === 'auth' || call.startsWith('engine:') || call.startsWith('transcribe:')), false);
  assert.equal(JSON.stringify(res.body).includes('provider'), false);
  assert.equal(JSON.stringify(res.body).includes('openai'), false);
});

test('disabled roleplay feature short-circuits without loading default authentication graph', async () => {
  const { registerAIRoleplayRoutes } = require('../routes/ai-roleplay');
  const originalLoad = Module._load;
  Module._load = function loadWithoutAuth(request, parent, isMain) {
    if (request === '../middleware/auth') {
      throw new Error('AUTH_GRAPH_SHOULD_NOT_LOAD');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const res = makeRes();
    const handled = await registerAIRoleplayRoutes(
      '/ai-roleplay/scenarios',
      makeReq('GET'),
      res,
      makeUrl('/ai-roleplay/scenarios'),
      { aiConfig: { features: { aiRoleplay: false } } },
    );

    assert.equal(handled, true);
    assert.deepEqual(res.body, { code: 404, message: 'Not Found' });
  } finally {
    Module._load = originalLoad;
  }
});

test('route errors are sanitized and omit stack, provider body, prompt, and transcript', async () => {
  const providerError = new Error('provider failed for transcript: secret learner transcript');
  providerError.code = 'UPSTREAM_PROVIDER_ERROR';
  providerError.status = 503;
  providerError.stack = 'STACK with prompt and provider body';
  providerError.body = { prompt: 'system prompt', transcript: 'secret learner transcript' };
  const { deps } = makeJsonDeps({
    engine: {
      advanceTurn: async () => {
        throw providerError;
      },
    },
  });

  const { res } = await callRoute('/ai-roleplay/sessions/9001/turns', 'POST', {
    turn_key: '123e4567-e89b-42d3-a456-426614174000',
    transcript: 'secret learner transcript',
  }, deps);

  const serialized = JSON.stringify(res.body);
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { code: 'AI_ROLEPLAY_UNAVAILABLE' });
  assert.equal(serialized.includes('secret learner transcript'), false);
  assert.equal(serialized.includes('prompt'), false);
  assert.equal(serialized.includes('provider'), false);
  assert.equal(serialized.includes('STACK'), false);
});

test('unmatched /ai-roleplay route returns false so the server can 404 it', async () => {
  const { deps } = makeJsonDeps();

  const { handled } = await callRoute('/ai-roleplay/unknown', 'GET', {}, deps);

  assert.equal(handled, false);
});

async function callTranscribeWithStream(chunks, deps = {}, headers = {}) {
  const { registerAIRoleplayRoutes } = require('../routes/ai-roleplay');
  const res = makeRes();
  const handled = await registerAIRoleplayRoutes(
    '/ai-roleplay/transcribe',
    makeStreamReq('POST', chunks, headers),
    res,
    makeUrl('/ai-roleplay/transcribe'),
    {
      aiConfig: { features: { aiRoleplay: true } },
      authenticate: async () => ({ id: '42' }),
      transcriber: {
        transcribe: async () => {
          throw new Error('TRANSCRIBER_SHOULD_NOT_RUN');
        },
      },
      ...deps,
    },
  );
  return { handled, res };
}

test('POST /ai-roleplay/transcribe rejects declared oversized JSON before reading audio content', async () => {
  const { res } = await callTranscribeWithStream(
    ['{"audio_data":"secret-audio-content","duration_seconds":1}'],
    { maxTranscribeBodyBytes: 16, maxTranscribeAudioBytes: 16 },
    { 'content-length': '17' },
  );

  const serialized = JSON.stringify(res.body);
  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { code: 'REQUEST_BODY_TOO_LARGE' });
  assert.equal(serialized.includes('secret-audio-content'), false);
  assert.equal(serialized.includes('/tmp'), false);
});

test('POST /ai-roleplay/transcribe rejects chunked oversized JSON while streaming', async () => {
  const { res } = await callTranscribeWithStream(
    ['{"audio_data":"', 'secret-audio-content', '","duration_seconds":1}'],
    { maxTranscribeBodyBytes: 20, maxTranscribeAudioBytes: 16 },
  );

  const serialized = JSON.stringify(res.body);
  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { code: 'REQUEST_BODY_TOO_LARGE' });
  assert.equal(serialized.includes('secret-audio-content'), false);
  assert.equal(serialized.includes('/tmp'), false);
});

test('POST /ai-roleplay/transcribe rejects decoded audio beyond the byte cap before ASR work', async () => {
  const body = JSON.stringify({
    audio_data: `data:audio/webm;base64,${Buffer.from('oversized-audio').toString('base64')}`,
    duration_seconds: 1,
  });

  const { res } = await callTranscribeWithStream(
    [body],
    { maxTranscribeBodyBytes: 1024, maxTranscribeAudioBytes: 4 },
  );

  const serialized = JSON.stringify(res.body);
  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { code: 'AUDIO_TOO_LARGE' });
  assert.equal(serialized.includes('oversized-audio'), false);
  assert.equal(serialized.includes('/tmp'), false);
});

function loadServerWithFakes({ roleplayHandles = true } = {}) {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const source = fs.readFileSync(serverPath, 'utf8');
  const routeOrder = [];
  const limiterCalls = [];
  const makeRoute = (name, handles = false) => async () => {
    routeOrder.push(name);
    return handles;
  };
  const moduleObject = { exports: {} };
  const sandbox = {
    module: moduleObject,
    exports: moduleObject.exports,
    __dirname: path.dirname(serverPath),
    process: {
      env: { PORT: '0', ENABLE_HTTPS: 'false' },
      nextTick: process.nextTick,
    },
    Buffer,
    URL,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    require(request) {
      if (request === 'dotenv') return { config() {} };
      if (request === './node18-polyfill') return {};
      if (request === 'http') return { createServer: () => ({ listen(_port, cb) { cb?.(); }, timeout: 0 }) };
      if (request === 'https') return { createServer: () => ({ listen(_port, cb) { cb?.(); }, timeout: 0 }) };
      if (request === 'fs') return { readFileSync: () => '' };
      if (request === 'fs/promises') return { mkdir: async () => {} };
      if (request === 'fluent-ffmpeg') return Object.assign(() => {}, { setFfmpegPath() {}, setFfprobePath() {} });
      if (request === '@ffmpeg-installer/ffmpeg') return { path: '/fake/ffmpeg' };
      if (request === '@ffprobe-installer/ffprobe') return { path: '/fake/ffprobe' };
      if (request === './data-store') return { init: async () => {} };
      if (request === './config/ai-config') return { features: {} };
      if (request === './ws/group-chat') return { setupGroupChatWebSocket() {} };
      if (request === './utils/cors') return { getCorsHeaders: () => ({}) };
      if (request === './middleware/compression') return (_req, _res, next) => next?.();
      if (request === './middleware/cache-headers') return (_req, _res, next) => next?.();
      if (request === './middleware/rate-limiter') {
        return {
          createRateLimiter: () => () => true,
          presets: {
            api: () => { limiterCalls.push('api'); return true; },
            auth: () => { limiterCalls.push('auth'); return true; },
            upload: () => { limiterCalls.push('upload'); return true; },
            expensive: () => { limiterCalls.push('expensive'); return true; },
          },
        };
      }
      if (request === './middleware/ai-auth') {
        return { shouldBypassExpensiveRateLimit: () => false };
      }
      if (request === './routes/ai-roleplay') {
        return { registerAIRoleplayRoutes: makeRoute('ai-roleplay', roleplayHandles) };
      }
      if (request === './routes/static') return { registerStaticRoutes: makeRoute('static', false) };
      if (request.startsWith('./routes/')) {
        const exportName = request.includes('/admin/')
          ? request.split('/').pop()
          : request.split('/').pop();
        const handler = makeRoute(exportName, false);
        return new Proxy({}, {
          get(_target, prop) {
            if (prop === 'handleFixDefinitions') return async () => {};
            return handler;
          },
        });
      }
      if (request.startsWith('./services/') || request.startsWith('./cron/') || request === './upload-handler') {
        return new Proxy({}, { get: () => () => {} });
      }
      return require(request);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: serverPath });
  return { exports: moduleObject.exports, routeOrder, limiterCalls };
}

test('server applies the expensive-operation limiter to /ai-roleplay routes', async () => {
  const { exports: serverExports, limiterCalls } = loadServerWithFakes();
  assert.equal(typeof serverExports.handleRequest, 'function');
  const res = makeRes();
  const req = makeReq('GET');
  req.url = '/ai-roleplay/scenarios';

  await serverExports.handleRequest(req, res);

  assert.deepEqual(limiterCalls, ['expensive']);
});

test('server registers ai-roleplay routes before static routes', async () => {
  const { exports: serverExports, routeOrder } = loadServerWithFakes({ roleplayHandles: true });
  const res = makeRes();
  const req = makeReq('GET');
  req.url = '/ai-roleplay/scenarios';

  await serverExports.handleRequest(req, res);

  assert.equal(routeOrder.includes('ai-roleplay'), true);
  assert.equal(routeOrder.includes('static'), false);
});
