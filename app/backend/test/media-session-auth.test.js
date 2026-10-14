const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const ACCOUNT_SECRET = 'account-secret-0123456789abcdef0123456789abcdef';
const MEDIA_SECRET = 'media-secret-0123456789abcdef0123456789abcdef';
const TEST_MEDIA_SECRET = 'test-media-secret-0123456789abcdef0123456789abcdef';

process.env.AUTH_TOKEN_SECRET = ACCOUNT_SECRET;
process.env.MEDIA_TOKEN_SECRET = MEDIA_SECRET;

const dataStore = require('../data-store');
const authService = require('../services/auth');
const {
  createMediaSessionToken,
  requireMediaSession,
  serializeMediaSessionCookie,
} = require('../services/media-session');
const { registerAuthRoutes } = require('../routes/auth');

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function signFixture(payload, secret = TEST_MEDIA_SECRET) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function userLookup(id) {
  return Promise.resolve(Number(id) === 7
    ? { id: 7, email: 'media@example.test', status: 'active', password_hash: 'hidden' }
    : null);
}

function makeRequest(token) {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function makeResponse() {
  return {
    statusCode: null,
    headers: {},
    headersSent: false,
    writableEnded: false,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      this.headersSent = true;
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
      this.writableEnded = true;
    },
  };
}

test.after(async () => {
  try { await dataStore.pool.end(); } catch (_) { /* already closed */ }
});

test('media credential carries only the scoped short-lived media claims', () => {
  const token = createMediaSessionToken({ id: 7 }, { now: () => 1_000, secret: TEST_MEDIA_SECRET });
  const payload = decodePayload(token);

  assert.deepEqual(Object.keys(payload).sort(), [
    'aud', 'exp', 'iat', 'jti', 'nbf', 'scope', 'sub', 'typ', 'ver',
  ]);
  assert.equal(payload.typ, 'media');
  assert.equal(payload.aud, 'linglish-media');
  assert.equal(payload.sub, 7);
  assert.equal(payload.scope, 'media:read');
  assert.equal(payload.ver, 1);
  assert.equal(payload.iat, 1_000);
  assert.equal(payload.nbf, 1_000);
  assert.equal(payload.exp, 1_900);
  assert.match(payload.jti, /^[a-f0-9]{32}$/);

  const second = decodePayload(createMediaSessionToken(
    { id: 7 },
    { now: () => 1_000, secret: TEST_MEDIA_SECRET },
  ));
  assert.notEqual(second.jti, payload.jti);
});

test('media credential verifies with a 30 second clock tolerance and resolves the account user', async () => {
  const token = createMediaSessionToken({ id: 7 }, { now: () => 1_000, secret: TEST_MEDIA_SECRET });
  const deps = { now: () => 1_930, secret: TEST_MEDIA_SECRET, findUserById: userLookup };

  assert.equal((await requireMediaSession(token, deps)).id, 7);
  await assert.rejects(
    () => requireMediaSession(token, { ...deps, now: () => 1_931 }),
    /TOKEN_EXPIRED/,
  );
});

test('media credential rejects tampering and wrong media claims', async () => {
  const base = {
    typ: 'media',
    aud: 'linglish-media',
    sub: 7,
    scope: 'media:read',
    ver: 1,
    jti: '0123456789abcdef0123456789abcdef',
    iat: 1_000,
    nbf: 1_000,
    exp: 1_900,
  };
  const deps = { now: () => 1_100, secret: TEST_MEDIA_SECRET, findUserById: userLookup };
  const valid = signFixture(base);
  const tampered = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`;

  await assert.rejects(() => requireMediaSession(tampered, deps), /INVALID_TOKEN/);
  for (const payload of [
    { ...base, aud: 'linglish-api' },
    { ...base, typ: 'access' },
    { ...base, scope: 'api:read' },
    { ...base, ver: 2 },
    { ...base, nbf: 1_131 },
  ]) {
    await assert.rejects(() => requireMediaSession(signFixture(payload), deps), /INVALID_TOKEN/);
  }
});

test('ordinary account authentication rejects a media credential even if it shares the account secret', async () => {
  const token = createMediaSessionToken(
    { id: 7 },
    { now: () => Math.floor(Date.now() / 1_000), secret: ACCOUNT_SECRET },
  );
  await assert.rejects(() => authService.requireUser(token), /INVALID_TOKEN/);
});

test('media credentials require an explicit high-entropy secret in every environment', () => {
  const previousSecret = process.env.MEDIA_TOKEN_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.MEDIA_TOKEN_SECRET;
  process.env.NODE_ENV = 'development';

  try {
    assert.throws(
      () => createMediaSessionToken({ id: 7 }, { now: () => 1_000 }),
      /MEDIA_TOKEN_SECRET_REQUIRED/,
    );
    assert.throws(
      () => createMediaSessionToken({ id: 7 }, { now: () => 1_000, secret: 'too-short' }),
      /MEDIA_TOKEN_SECRET_INVALID/,
    );
  } finally {
    process.env.MEDIA_TOKEN_SECRET = previousSecret;
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('production and local cookies use distinct names and exact security attributes', () => {
  const production = serializeMediaSessionCookie('abc.def.ghi', { production: true });
  assert.match(
    production,
    /^__Host-linglish_media=abc\.def\.ghi; Max-Age=900; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
  );
  assert.doesNotMatch(production, /Domain=/i);

  const local = serializeMediaSessionCookie('abc.def.ghi', { production: false });
  assert.match(
    local,
    /^linglish_media_dev=abc\.def\.ghi; Max-Age=900; Path=\/; HttpOnly; SameSite=Lax$/,
  );
  assert.doesNotMatch(local, /(?:^|; )Secure(?:;|$)/);
});

test('authenticated media-session routes set and clear the cookie without returning a token', async () => {
  dataStore.findUserById = userLookup;
  const accountToken = authService.createAccessTokenForUser({ id: 7, email: 'media@example.test' });
  const createRes = makeResponse();

  assert.equal(await registerAuthRoutes(
    '/auth/media-session',
    makeRequest(accountToken),
    createRes,
    new URL('http://localhost/auth/media-session'),
  ), true);
  assert.equal(createRes.statusCode, 200);
  assert.equal(createRes.body.ttl_seconds, 900);
  assert.equal(createRes.body.refresh_after_seconds, 600);
  assert.equal(typeof createRes.body.expires_at, 'string');
  assert.equal(Object.hasOwn(createRes.body, 'token'), false);
  assert.match(createRes.getHeader('set-cookie'), /^linglish_media_dev=.*; Max-Age=900; Path=\/; HttpOnly; SameSite=Lax$/);

  const clearReq = { method: 'DELETE', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const clearRes = makeResponse();
  assert.equal(await registerAuthRoutes(
    '/auth/media-session',
    clearReq,
    clearRes,
    new URL('http://localhost/auth/media-session'),
  ), true);
  assert.equal(clearRes.statusCode, 200);
  assert.deepEqual(clearRes.body, { ok: true });
  assert.equal(
    clearRes.getHeader('set-cookie'),
    'linglish_media_dev=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
  );
});

test('missing media secret returns a generic 503 for a valid account credential', async () => {
  dataStore.findUserById = userLookup;
  const accountToken = authService.createAccessTokenForUser({ id: 7, email: 'media@example.test' });
  const previousSecret = process.env.MEDIA_TOKEN_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.MEDIA_TOKEN_SECRET;
  process.env.NODE_ENV = 'development';

  try {
    const res = makeResponse();
    assert.equal(await registerAuthRoutes(
      '/auth/media-session',
      makeRequest(accountToken),
      res,
      new URL('http://localhost/auth/media-session'),
    ), true);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { code: 503, message: 'Service unavailable' });
    assert.equal(res.getHeader('set-cookie'), undefined);
    assert.doesNotMatch(JSON.stringify(res.body), /MEDIA_TOKEN_SECRET/i);
  } finally {
    process.env.MEDIA_TOKEN_SECRET = previousSecret;
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
