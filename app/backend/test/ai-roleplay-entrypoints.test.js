'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const entrypoints = require(path.join(frontend, 'js/ai-roleplay-entrypoints.js'));
const arenaHtml = fs.readFileSync(path.join(frontend, 'mobile-arena.html'), 'utf8');
const todayHtml = fs.readFileSync(path.join(frontend, 'today.html'), 'utf8');
const mobileTodayHtml = fs.readFileSync(path.join(frontend, 'mobile-today.html'), 'utf8');
const mobileTodayJs = fs.readFileSync(path.join(frontend, 'js/mobile-today.js'), 'utf8');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.href = '';
    this._textContent = '';
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || '').join('');
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this._textContent = '';
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  click() {
    (this.listeners.click || []).forEach((listener) => listener({ currentTarget: this }));
  }

  find(tagName) {
    const expected = String(tagName).toUpperCase();
    if (this.tagName === expected) return this;
    for (const child of this.children) {
      const found = child.find?.(expected);
      if (found) return found;
    }
    return null;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createDocumentFragment() {
    return new FakeElement('#fragment');
  }
}

function storage(values = {}) {
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
  };
}

function scenario(overrides = {}) {
  return {
    id: 'coffee-order-a1',
    title_zh: '咖啡店点单',
    learner_role: '顾客',
    assistant_role: '店员',
    cefr_min: 'A1',
    cefr_max: 'A2',
    goals: [{ id: 'order', label_zh: '完成点单' }],
    ...overrides,
  };
}

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (payload instanceof Error) throw payload;
      return payload;
    },
  };
}

test('canonical guest detection accepts the real guest JWT storage shape', () => {
  const authManager = {
    getToken: () => 'eyJhbGciOiJIUzI1NiJ9.guest.signature',
    isGuest: true,
  };
  assert.equal(entrypoints.detectGuest({
    authManager,
    localStorage: storage({ is_guest: 'true', linglish_token: authManager.getToken() }),
    sessionStorage: storage(),
  }), true);

  assert.equal(entrypoints.detectGuest({
    authManager: { isGuest: false },
    guestCheck: { isGuest: () => true },
    localStorage: storage({ is_guest: 'true' }),
    sessionStorage: storage({ isGuest: 'true' }),
  }), false, 'canonical authManager.isGuest result must win when available');
});

test('definition-only catalog shows neutral authenticated history instead of inferred zero', () => {
  const item = scenario({
    recent_result: { status: 'completed', completed_goal_count: 1 },
    recent_session: { status: 'active' },
  });
  assert.equal(entrypoints.scenarioHistoryLabel(item, { isGuest: false }), '开始后将在这里显示');
  assert.equal(entrypoints.catalogHistoryLabel([item], { isGuest: false }), '完成记录暂不可用');
});

test('only verified user-scoped completed and active history is displayed', () => {
  const completed = scenario({
    user_history: { verified: true, scope: 'user', status: 'completed', completed_goal_count: 1 },
  });
  const active = scenario({
    id: 'job-interview-b1',
    user_history: { verified: true, scope: 'user', status: 'active' },
  });
  assert.equal(entrypoints.scenarioHistoryLabel(completed, { isGuest: false }), '上次完成 1/1 个目标');
  assert.equal(entrypoints.scenarioHistoryLabel(active, { isGuest: false }), '有一轮未完成的练习');
  assert.equal(entrypoints.catalogHistoryLabel([completed, active], { isGuest: false }), '已完成 1 个场景');
});

test('guest catalog truthfully invites registration to retain history', () => {
  const item = scenario();
  assert.equal(entrypoints.scenarioHistoryLabel(item, { isGuest: true }), '登录或注册后可保留完成记录');
  assert.equal(entrypoints.catalogHistoryLabel([item], { isGuest: true }), '登录后可保留完成记录');
});

test('catalog controller distinguishes disabled, empty, expired auth, server, network and malformed states', async () => {
  const cases = [
    { name: 'disabled', run: () => response(404, {}), kind: 'disabled' },
    { name: 'empty', run: () => response(200, { scenarios: [] }), kind: 'empty' },
    { name: 'expired 401', run: () => response(401, {}), kind: 'auth_expired', clears: 1 },
    { name: 'expired 403', run: () => response(403, {}), kind: 'auth_expired', clears: 1 },
    { name: 'server', run: () => response(503, {}), kind: 'transient_error' },
    { name: 'network', run: () => Promise.reject(new Error('offline')), kind: 'network_error' },
    { name: 'malformed shape', run: () => response(200, { scenarios: 'not-an-array' }), kind: 'malformed' },
    { name: 'malformed JSON', run: () => response(200, new SyntaxError('bad json')), kind: 'malformed' },
  ];

  for (const item of cases) {
    let clearCount = 0;
    const controller = entrypoints.createCatalogController({
      request: item.run,
      getToken: () => 'valid-jwt',
      isGuest: () => false,
      clearAuth: () => { clearCount += 1; },
    });
    const state = await controller.load();
    assert.equal(state.kind, item.kind, item.name);
    assert.equal(clearCount, item.clears || 0, `${item.name} clear count`);
  }
});

test('catalog controller renders registered and guest JWT catalogs without duplicate requests', async () => {
  let requestCount = 0;
  let resolveRequest;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const controller = entrypoints.createCatalogController({
    request: async () => {
      requestCount += 1;
      return pending;
    },
    getToken: () => 'eyJhbGciOiJIUzI1NiJ9.guest.signature',
    isGuest: () => true,
  });

  const first = controller.load();
  const repeated = controller.load();
  const retryWhilePending = controller.retry();
  assert.equal(requestCount, 1);
  resolveRequest(response(200, { scenarios: [scenario()] }));
  const states = await Promise.all([first, repeated, retryWhilePending]);
  assert.ok(states.every((state) => state.kind === 'ready'));
  assert.ok(states.every((state) => state.isGuest === true));
});

test('retry performs one new request after a transient failure', async () => {
  let requestCount = 0;
  const controller = entrypoints.createCatalogController({
    request: async () => {
      requestCount += 1;
      return requestCount === 1
        ? response(500, {})
        : response(200, { scenarios: [scenario()] });
    },
    getToken: () => 'valid-jwt',
    isGuest: () => false,
  });
  assert.equal((await controller.load()).kind, 'transient_error');
  const retried = await Promise.all([controller.retry(), controller.retry()]);
  assert.equal(requestCount, 2);
  assert.ok(retried.every((state) => state.kind === 'ready'));
});

test('renderer keeps malicious server text inert and emits bounded encoded URLs', () => {
  const document = new FakeDocument();
  const listElement = new FakeElement('div');
  const statusElement = new FakeElement('p');
  const malicious = '<img src=x onerror="globalThis.pwned=true">';
  entrypoints.renderCatalogState({
    document,
    listElement,
    statusElement,
    theme: '旅行 & 咖啡',
    state: { kind: 'ready', isGuest: false, scenarios: [scenario({ title_zh: malicious })] },
  });

  const card = listElement.find('a');
  assert.ok(card);
  assert.match(card.textContent, /<img src=x onerror=/);
  assert.equal(listElement.find('img'), null, 'server text must not create an element');
  assert.equal(
    card.href,
    './ai-roleplay.html?scenario=coffee-order-a1&from=mobile_arena&theme=%E6%97%85%E8%A1%8C+%26+%E5%92%96%E5%95%A1',
  );
  assert.equal(statusElement.textContent, '完成记录暂不可用');

  assert.equal(entrypoints.buildRoleplayHref({ scenarioId: '../admin', source: 'mobile_arena' }), '');
  assert.equal(entrypoints.buildRoleplayHref({
    scenarioId: 'a'.repeat(81),
    source: 'mobile_arena',
  }), '');
  assert.equal(entrypoints.buildRoleplayHref({ scenarioId: 'coffee-order-a1', source: 'bad source' }), '');
});

test('roleplay URLs accept validated Chinese and English theme text', () => {
  assert.equal(
    entrypoints.buildRoleplayHref({
      scenarioId: 'coffee-order-a1',
      source: 'mobile_arena',
      theme: '职场英语_进阶-2',
    }),
    './ai-roleplay.html?scenario=coffee-order-a1&from=mobile_arena&theme=%E8%81%8C%E5%9C%BA%E8%8B%B1%E8%AF%AD_%E8%BF%9B%E9%98%B6-2',
  );
  assert.equal(
    entrypoints.buildRoleplayHref({
      scenarioId: 'coffee-order-a1',
      source: 'mobile_arena',
      theme: 'Travel & Workplace_English-2',
    }),
    './ai-roleplay.html?scenario=coffee-order-a1&from=mobile_arena&theme=Travel+%26+Workplace_English-2',
  );
});

test('roleplay URLs omit HTML, path, URL, quote, attribute and control syntax from themes', () => {
  const baseHref = './ai-roleplay.html?scenario=coffee-order-a1&from=mobile_arena';
  const rejectedThemes = [
    '<script>alert(1)</script>',
    '../admin',
    '..\\admin',
    'https://evil.example/path',
    'data:text/html,alert(1)',
    '"travel"',
    "'travel'",
    'theme=travel',
    'onclick=alert(1)',
    'travel\nwork',
    'travel\u0000work',
    'a'.repeat(49),
  ];

  rejectedThemes.forEach((theme) => {
    assert.equal(
      entrypoints.buildRoleplayHref({
        scenarioId: 'coffee-order-a1',
        source: 'mobile_arena',
        theme,
      }),
      baseHref,
      theme,
    );
  });
});

test('state renderer replaces content and does not duplicate retry listeners', () => {
  const document = new FakeDocument();
  const listElement = new FakeElement('div');
  const statusElement = new FakeElement('p');
  let retries = 0;
  const render = () => entrypoints.renderCatalogState({
    document,
    listElement,
    statusElement,
    state: { kind: 'network_error', isGuest: false },
    onRetry: () => { retries += 1; },
  });
  render();
  render();
  assert.equal(listElement.children.length, 1);
  const button = listElement.find('button');
  assert.ok(button);
  assert.equal(button.listeners.click.length, 1);
  button.click();
  assert.equal(retries, 1);
});

test('state renderer gives disabled, empty, auth and transient failures distinct actions', () => {
  const expected = [
    ['disabled', '功能暂未开放', null],
    ['empty', '暂无可用场景', null],
    ['auth_required', '登录后查看', 'a'],
    ['auth_expired', '登录已过期', 'a'],
    ['transient_error', '服务暂不可用', 'button'],
    ['network_error', '网络连接失败', 'button'],
    ['malformed', '数据读取失败', 'button'],
  ];

  expected.forEach(([kind, status, actionTag]) => {
    const document = new FakeDocument();
    const listElement = new FakeElement('div');
    const statusElement = new FakeElement('p');
    entrypoints.renderCatalogState({
      document,
      listElement,
      statusElement,
      state: { kind, isGuest: false },
      onRetry: () => {},
    });
    assert.equal(statusElement.textContent, status, kind);
    if (actionTag) assert.ok(listElement.find(actionTag), `${kind} action`);
    else {
      assert.equal(listElement.find('a'), null, `${kind} login action`);
      assert.equal(listElement.find('button'), null, `${kind} retry action`);
    }
  });
});

test('mobile Today coach links directly to the bounded AI scenario route', () => {
  const staticLink = mobileTodayHtml.match(/id="coach-roleplay-link"[^>]*href="([^"]+)"/);
  assert.ok(staticLink);
  assert.match(staticLink[1], /^\.\/ai-roleplay\.html\?scenario=/);
  assert.doesNotMatch(staticLink[1], /mobile-arena\.html/);
  assert.match(mobileTodayJs, /\.\/ai-roleplay\.html/);
  assert.match(mobileTodayJs, /URLSearchParams/);
});

test('mobile arena keeps AI before legacy video roleplay and loads the behavioral module', () => {
  const scenarioIndex = arenaHtml.indexOf('id="ai-scenario-list"');
  const legacyIndex = arenaHtml.indexOf('id="legacy-video-roleplay"');
  const moduleIndex = arenaHtml.indexOf('./js/ai-roleplay-entrypoints.js');
  const controllerIndex = arenaHtml.indexOf('createCatalogController');
  assert.ok(scenarioIndex >= 0 && legacyIndex >= 0 && scenarioIndex < legacyIndex);
  assert.ok(moduleIndex >= 0 && moduleIndex < controllerIndex);
  assert.match(arenaHtml, /\/ai-roleplay\/scenarios/);
  assert.doesNotMatch(arenaHtml, /guest-token/);
  assert.doesNotMatch(arenaHtml, />\s*1\/2\s*已完成\s*</);
  assert.doesNotMatch(arenaHtml, /challenge-progress-fill"\s+style="width:\s*50%/);
  assert.doesNotMatch(arenaHtml, />\s*\+50\s*金币\s*</);
});

test('legacy video roleplay routes remain unchanged', () => {
  assert.match(arenaHtml, /practice-session\.html\?videoId=\$\{encodeURIComponent\(String\(videoId\)\)\}&mode=arena/);
  assert.match(arenaHtml, /practice-session\.html\?mode=arena/);
});
