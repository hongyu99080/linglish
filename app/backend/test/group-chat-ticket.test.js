const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const vm = require('node:vm');

const ACCOUNT_SECRET = 'account-secret-0123456789abcdef0123456789abcdef';
const SCOPED_SECRET = 'scoped-secret-0123456789abcdef0123456789abcdef';

process.env.AUTH_TOKEN_SECRET = ACCOUNT_SECRET;
process.env.SCOPED_TOKEN_SECRET = SCOPED_SECRET;

const dataStore = require('../data-store');
const authService = require('../services/auth');
const { authenticate } = require('../middleware/auth');
const { registerAuthRoutes } = require('../routes/auth');
const groupChat = require('../ws/group-chat');

function scopedTokens() {
  return require('../services/scoped-browser-token');
}

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function signFixture(payload, secret = SCOPED_SECRET) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
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

function postRequest(pathname, token, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = pathname;
  req.headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function requestWithCredentials(pathname, body, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = pathname;
  req.headers = { 'content-type': 'application/json', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

const originalFindUserById = dataStore.findUserById;

test.afterEach(() => {
  dataStore.findUserById = originalFindUserById;
  process.env.SCOPED_TOKEN_SECRET = SCOPED_SECRET;
  delete process.env.WS_ALLOW_LEGACY_ACCOUNT_TOKEN;
});

test.after(async () => {
  try { await dataStore.pool.end(); } catch (_) { /* already closed */ }
});

test('group-chat tickets bind strict short-lived claims to their user and group', () => {
  const { createGroupChatTicket, verifyGroupChatTicket } = scopedTokens();
  const ticket = createGroupChatTicket({ id: 7 }, 42, { now: () => 1_000, secret: SCOPED_SECRET });
  const payload = decodePayload(ticket);

  assert.deepEqual(Object.keys(payload).sort(), [
    'aud', 'exp', 'group_id', 'iat', 'jti', 'nbf', 'purpose', 'sub', 'typ', 'ver',
  ]);
  assert.equal(payload.typ, 'scoped-browser');
  assert.equal(payload.aud, 'group-chat');
  assert.equal(payload.purpose, 'ws_ticket');
  assert.equal(payload.sub, '7');
  assert.equal(payload.group_id, 42);
  assert.equal(payload.exp - payload.iat, 60);
  assert.equal(verifyGroupChatTicket(
    ticket,
    { groupId: 42, userId: 7, now: () => 1_060, secret: SCOPED_SECRET },
  ).sub, '7');
  assert.throws(
    () => verifyGroupChatTicket(ticket, { groupId: 42, now: () => 1_061, secret: SCOPED_SECRET }),
    /TOKEN_EXPIRED/,
  );
});

test('group-chat tickets reject wrong purpose, audience, group, user, tampering, and weak secrets', () => {
  const { createGroupChatTicket, verifyGroupChatTicket } = scopedTokens();
  const base = {
    typ: 'scoped-browser',
    aud: 'group-chat',
    purpose: 'ws_ticket',
    sub: '7',
    group_id: 42,
    iat: 1_000,
    nbf: 1_000,
    exp: 1_060,
    ver: 1,
    jti: '0123456789abcdef0123456789abcdef',
  };
  const options = { groupId: 42, userId: 7, now: () => 1_010, secret: SCOPED_SECRET };
  const valid = signFixture(base);
  const tampered = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`;

  assert.throws(() => verifyGroupChatTicket(tampered, options), /INVALID_TOKEN/);
  assert.throws(() => verifyGroupChatTicket(valid, { ...options, groupId: 43 }), /INVALID_TOKEN/);
  assert.throws(() => verifyGroupChatTicket(valid, { ...options, userId: 8 }), /INVALID_TOKEN/);
  for (const payload of [
    { ...base, purpose: 'oauth_bootstrap' },
    { ...base, aud: 'oauth-session' },
    { ...base, nbf: 1_041 },
  ]) {
    assert.throws(() => verifyGroupChatTicket(signFixture(payload), options), /INVALID_TOKEN/);
  }

  const previous = process.env.SCOPED_TOKEN_SECRET;
  delete process.env.SCOPED_TOKEN_SECRET;
  try {
    assert.throws(() => createGroupChatTicket({ id: 7 }, 42), /SCOPED_TOKEN_SECRET_REQUIRED/);
    assert.throws(
      () => createGroupChatTicket({ id: 7 }, 42, { secret: 'too-short' }),
      /SCOPED_TOKEN_SECRET_INVALID/,
    );
  } finally {
    process.env.SCOPED_TOKEN_SECRET = previous;
  }
});

test('ordinary account authentication rejects a group-chat ticket even when secrets are equal', async () => {
  const { createGroupChatTicket } = scopedTokens();
  const ticket = createGroupChatTicket(
    { id: 7 },
    42,
    { now: () => Math.floor(Date.now() / 1_000), secret: ACCOUNT_SECRET },
  );
  await assert.rejects(() => authService.requireUser(ticket), /INVALID_TOKEN/);
});

test('POST /auth/ws-ticket requires an account Bearer and returns only a 60-second scoped ticket', async () => {
  dataStore.findUserById = async id => Number(id) === 7
    ? { id: 7, email: 'chat@example.test', status: 'active', password_hash: 'hidden' }
    : null;
  const accountToken = authService.createAccessTokenForUser({ id: 7, email: 'chat@example.test' });
  const res = makeResponse();

  assert.equal(await registerAuthRoutes(
    '/auth/ws-ticket',
    postRequest('/auth/ws-ticket', accountToken, { group_id: 42 }),
    res,
    new URL('http://localhost/auth/ws-ticket'),
  ), true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['expires_in', 'ticket']);
  assert.equal(res.body.expires_in, 60);
  assert.equal(decodePayload(res.body.ticket).group_id, 42);

  const scopedRes = makeResponse();
  assert.equal(await registerAuthRoutes(
    '/auth/ws-ticket',
    postRequest('/auth/ws-ticket', res.body.ticket, { group_id: 42 }),
    scopedRes,
    new URL('http://localhost/auth/ws-ticket'),
  ), true);
  assert.equal(scopedRes.statusCode, 401);
});

test('generic authentication and POST /auth/ws-ticket reject query account tokens, and ws-ticket rejects account cookies', async () => {
  dataStore.findUserById = async id => Number(id) === 7
    ? { id: 7, email: 'chat@example.test', status: 'active', password_hash: 'hidden' }
    : null;
  const accountToken = authService.createAccessTokenForUser({ id: 7, email: 'chat@example.test' });

  await assert.rejects(
    () => authenticate({
      url: `/admin/users?token=${encodeURIComponent(accountToken)}`,
      headers: {},
    }),
    /UNAUTHORIZED/,
  );

  for (const req of [
    requestWithCredentials(`/auth/ws-ticket?token=${encodeURIComponent(accountToken)}`, { group_id: 42 }),
    requestWithCredentials('/auth/ws-ticket', { group_id: 42 }, { cookie: `linglish_token=${accountToken}` }),
  ]) {
    const res = makeResponse();
    assert.equal(await registerAuthRoutes(
      '/auth/ws-ticket',
      req,
      res,
      new URL(`http://localhost${req.url}`),
    ), true);
    assert.equal(res.statusCode, 401);
  }
});

test('WebSocket ticket authorization rechecks current user and live group membership', async () => {
  const { createGroupChatTicket } = scopedTokens();
  const ticket = createGroupChatTicket({ id: 7 }, 42, { secret: SCOPED_SECRET });
  const queries = [];
  const req = {
    url: `/ws/group-chat?groupId=42&ticket=${encodeURIComponent(ticket)}`,
    headers: {},
  };
  const authorized = await groupChat.authorizeGroupChatRequest(req, {
    secret: SCOPED_SECRET,
    findUserById: async id => String(id) === '7'
      ? { id: 7, username: 'chat-user', status: 'active', password_hash: 'hidden' }
      : null,
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rows: [{ role: 'member' }] };
    },
  });

  assert.equal(authorized.user.id, 7);
  assert.equal(authorized.groupId, 42);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values, [42, 7]);
  assert.match(queries[0].sql, /status = 'active'/);

  await assert.rejects(
    () => groupChat.authorizeGroupChatRequest(req, {
      secret: SCOPED_SECRET,
      findUserById: async () => ({ id: 7, status: 'active' }),
      query: async () => ({ rows: [] }),
    }),
    /NOT_A_MEMBER/,
  );
});

test('legacy WebSocket account-token URLs work only behind WS_ALLOW_LEGACY_ACCOUNT_TOKEN', async () => {
  const accountToken = authService.createAccessTokenForUser({ id: 7, email: 'chat@example.test' });
  const req = {
    url: `/ws/group-chat?groupId=42&token=${encodeURIComponent(accountToken)}`,
    headers: {},
  };
  const options = {
    authenticateRequest: async () => ({ id: 7, username: 'legacy-user', status: 'active' }),
    query: async () => ({ rows: [{ role: 'member' }] }),
  };

  await assert.rejects(
    () => groupChat.authorizeGroupChatRequest(req, { ...options, allowLegacyAccountToken: false }),
    /UNAUTHORIZED/,
  );
  const authorized = await groupChat.authorizeGroupChatRequest(req, {
    ...options,
    allowLegacyAccountToken: true,
  });
  assert.equal(authorized.user.id, 7);
  assert.equal(authorized.groupId, 42);
});

test('group-chat disconnect uses one bounded reconnect timer, fetches a fresh ticket, and stops timers on open and unload', async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/group-detail.html'), 'utf8');
  const marker = '<script>\n    const toastEl';
  const start = html.indexOf(marker);
  const end = html.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start, 'group-detail inline application script must be present');
  const source = html.slice(start + '<script>'.length, end);

  const windowListeners = {};
  const timeouts = [];
  const intervals = [];
  const sockets = [];
  let ticketRequests = 0;
  function makeTimer(list, fn, delay) {
    const timer = { fn, delay, active: true };
    list.push(timer);
    return timer;
  }
  const element = () => ({
    addEventListener() {},
    classList: { add() {}, remove() {} },
    querySelectorAll: () => [],
    scrollIntoView() {},
    style: {},
    dataset: {},
  });
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      sockets.push(this);
    }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    emit(name, payload = {}) { if (this.listeners[name]) this.listeners[name](payload); }
    close() { this.emit('close'); }
  }
  const context = {
    URLSearchParams,
    document: {
      getElementById: () => element(),
      querySelectorAll: () => [],
    },
    location: {
      search: '?id=42',
      protocol: 'https:',
      host: 'linglish.test',
    },
    AuthManager: { getToken: () => 'account-token' },
    localStorage: { getItem: () => 'account-token' },
    fetch: async (url) => {
      assert.equal(url, '/auth/ws-ticket');
      ticketRequests += 1;
      return { ok: true, json: async () => ({ ticket: `ticket-${ticketRequests}` }) };
    },
    WebSocket: FakeWebSocket,
    setTimeout: (fn, delay) => makeTimer(timeouts, fn, delay),
    clearTimeout: timer => { if (timer) timer.active = false; },
    setInterval: (fn, delay) => makeTimer(intervals, fn, delay),
    clearInterval: timer => { if (timer) timer.active = false; },
    console: { log() {}, warn() {}, error() {} },
    navigator: {},
    FormData: class FormData {},
  };
  context.window = {
    ...context,
    location: context.location,
    addEventListener(name, handler) { windowListeners[name] = handler; },
  };
  context.globalThis = context;
  vm.runInNewContext(`${source}\n;globalThis.__chatTest = {\n  connectChatSocket,\n  stopChatConnection: typeof stopChatConnection === 'function' ? stopChatConnection : null\n};`, context, {
    filename: 'group-detail.html',
  });

  assert.equal(await context.__chatTest.connectChatSocket(), true);
  assert.equal(ticketRequests, 1);
  assert.match(sockets[0].url, /ticket=ticket-1/);
  sockets[0].emit('open');
  assert.equal(intervals.filter(timer => timer.active).length, 0);

  sockets[0].emit('close');
  sockets[0].emit('error');
  const reconnects = timeouts.filter(timer => timer.active);
  assert.equal(reconnects.length, 1, 'close/error must deduplicate reconnect work');
  assert.ok(reconnects[0].delay > 0 && reconnects[0].delay <= 30_000, 'backoff must be bounded');
  assert.equal(intervals.filter(timer => timer.active).length, 1, 'polling is a reconnect fallback');

  reconnects[0].active = false;
  await reconnects[0].fn();
  assert.equal(ticketRequests, 2, 'every reconnect obtains a new ticket');
  assert.match(sockets[1].url, /ticket=ticket-2/);
  sockets[1].emit('open');
  assert.equal(intervals.filter(timer => timer.active).length, 0, 'open stops fallback polling');
  assert.equal(timeouts.filter(timer => timer.active).length, 0, 'open stops reconnect timers');

  sockets[1].emit('close');
  assert.equal(timeouts.filter(timer => timer.active).length, 1);
  assert.equal(typeof context.__chatTest.stopChatConnection, 'function');
  windowListeners.beforeunload();
  assert.equal(intervals.filter(timer => timer.active).length, 0);
  assert.equal(timeouts.filter(timer => timer.active).length, 0);
});

test('pagehide fences an in-flight ticket request and late disconnect work', async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/group-detail.html'), 'utf8');
  const marker = '<script>\n    const toastEl';
  const start = html.indexOf(marker);
  const end = html.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start, 'group-detail inline application script must be present');
  const source = html.slice(start + '<script>'.length, end);

  const windowListeners = {};
  const timeouts = [];
  const intervals = [];
  const sockets = [];
  let resolveTicketFetch;
  function makeTimer(list, fn, delay) {
    const timer = { fn, delay, active: true };
    list.push(timer);
    return timer;
  }
  const element = () => ({
    addEventListener() {},
    classList: { add() {}, remove() {} },
    querySelectorAll: () => [],
    scrollIntoView() {},
    style: {},
    dataset: {},
  });
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      sockets.push(this);
    }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    close() { if (this.listeners.close) this.listeners.close(); }
  }
  const context = {
    URLSearchParams,
    document: {
      getElementById: () => element(),
      querySelectorAll: () => [],
    },
    location: {
      search: '?id=42',
      protocol: 'https:',
      host: 'linglish.test',
    },
    AuthManager: { getToken: () => 'account-token' },
    localStorage: { getItem: () => 'account-token' },
    fetch: url => {
      assert.equal(url, '/auth/ws-ticket');
      return new Promise(resolve => { resolveTicketFetch = resolve; });
    },
    WebSocket: FakeWebSocket,
    setTimeout: (fn, delay) => makeTimer(timeouts, fn, delay),
    clearTimeout: timer => { if (timer) timer.active = false; },
    setInterval: (fn, delay) => makeTimer(intervals, fn, delay),
    clearInterval: timer => { if (timer) timer.active = false; },
    console: { log() {}, warn() {}, error() {} },
    navigator: {},
    FormData: class FormData {},
  };
  context.window = {
    ...context,
    location: context.location,
    addEventListener(name, handler) { windowListeners[name] = handler; },
  };
  context.globalThis = context;
  vm.runInNewContext(`${source}\n;globalThis.__chatTest = {\n  connectChatSocket,\n  handleChatDisconnect,\n  scheduleChatRefresh\n};`, context, {
    filename: 'group-detail.html',
  });

  const connection = context.__chatTest.connectChatSocket();
  await Promise.resolve();
  assert.equal(typeof resolveTicketFetch, 'function', 'ticket request must be in flight');
  windowListeners.pagehide();
  resolveTicketFetch({ ok: true, json: async () => ({ ticket: 'late-ticket' }) });

  assert.equal(await connection, false, 'a stopped connection attempt must become stale');
  assert.equal(sockets.length, 0, 'a late ticket response must not create a WebSocket');
  assert.equal(intervals.filter(timer => timer.active).length, 0);
  assert.equal(timeouts.filter(timer => timer.active).length, 0);

  context.__chatTest.handleChatDisconnect(null);
  context.__chatTest.scheduleChatRefresh();
  assert.equal(intervals.filter(timer => timer.active).length, 0, 'late close/error work must not restart polling');
  assert.equal(timeouts.filter(timer => timer.active).length, 0, 'late close/error work must not reconnect');
});
