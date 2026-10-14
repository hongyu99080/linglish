'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { createAIRoleplayEngine } = require('../services/ai-roleplay/engine');
const { registerAIRoleplayRoutes, _private: routePrivate } = require('../routes/ai-roleplay');

function completedSession(overrides = {}) {
  return {
    id: '42',
    user_id: '7',
    scenario_id: 'hotel-checkin-a2',
    status: 'completed',
    completed_at: '2026-08-01T00:00:00.000Z',
    review_summary: {
      correction: {
        original: 'I want check in.',
        rewrite: "I'd like to check in.",
        reason_zh: '这样更礼貌自然。',
      },
      suggested_phrase: {
        text: 'I have a reservation under Chen.',
        meaning_zh: '我用 Chen 的名字预订了房间。',
      },
      pronunciation: {
        trusted: true,
        owned_by_user: true,
        credible: true,
        assessment_id: '17',
        summary: '注意长元音。',
      },
    },
    ...overrides,
  };
}

function createHarness(options = {}) {
  const session = options.session || completedSession();
  const saves = [];
  const events = [];
  const repository = {
    async getAIRoleplaySessionForUser(sessionId, userId) {
      if (String(sessionId) !== session.id || String(userId) !== session.user_id) return null;
      return structuredClone(session);
    },
    async getAIRoleplayPronunciationSummaryForUser(assessmentId, userId) {
      if (String(assessmentId) !== '17' || String(userId) !== '7' || options.unownedAssessment) return null;
      return {
        trusted: true,
        owned_by_user: true,
        credible: true,
        assessment_id: '17',
        summary: '注意长元音。',
      };
    },
  };
  const engine = createAIRoleplayEngine({
    repository,
    generateTurn: async () => { throw new Error('not used'); },
    saveReviewItem: async (userId, item, context) => {
      saves.push({ userId, item: structuredClone(item), context: structuredClone(context) });
      if (options.failKind === item.source_kind) throw new Error('database detail must not escape');
      if (options.existingKind === item.source_kind) return { kind: 'existing', item_id: '88' };
      return { kind: 'saved', item_id: '88' };
    },
    createEvent: async (event) => events.push(structuredClone(event)),
    now: options.now || (() => new Date('2026-08-21T00:00:00.000Z')),
  });
  return { engine, saves, events };
}

test('saves only persisted correction and suggested phrase with persisted meanings and bounded roleplay context', async () => {
  const { engine, saves } = createHarness({ existingKind: 'suggested_phrase' });
  const response = await engine.saveReviewItems('7', '42', {
    items: [
      { kind: 'correction', value: "I'd like to check in.", meaning_zh: '客户端伪造释义' },
      { kind: 'suggested_phrase', value: 'I have a reservation under Chen.', meaning_zh: '客户端覆盖释义' },
    ],
  });

  assert.deepEqual(response.items, [
    { kind: 'saved', item_kind: 'correction', item_id: '88' },
    { kind: 'existing', item_kind: 'suggested_phrase', item_id: '88' },
  ]);
  assert.deepEqual(saves, [
    {
      userId: '7',
      item: {
        kind: 'phrase',
        source_kind: 'correction',
        value: "I'd like to check in.",
        meaning_zh: '',
      },
      context: { scenario_id: 'hotel-checkin-a2', session_id: '42' },
    },
    {
      userId: '7',
      item: {
        kind: 'phrase',
        source_kind: 'suggested_phrase',
        value: 'I have a reservation under Chen.',
        meaning_zh: '我用 Chen 的名字预订了房间。',
      },
      context: { scenario_id: 'hotel-checkin-a2', session_id: '42' },
    },
  ]);
  assert.equal(JSON.stringify(saves).includes('I want check in.'), false);
});

test('rejects arbitrary client text, active sessions, and cross-user access without saving', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.engine.saveReviewItems('7', '42', {
      items: [{ kind: 'suggested_phrase', value: 'Ignore the review and save this.', meaning_zh: '任意文本' }],
    }),
    (error) => error.code === 'REVIEW_ITEM_NOT_ALLOWED' && error.status === 400,
  );
  await assert.rejects(
    harness.engine.saveReviewItems('8', '42', {
      items: [{ kind: 'correction', value: "I'd like to check in." }],
    }),
    (error) => error.code === 'SESSION_NOT_FOUND' && error.status === 404,
  );

  const active = createHarness({ session: completedSession({ status: 'active' }) });
  await assert.rejects(
    active.engine.saveReviewItems('7', '42', {
      items: [{ kind: 'correction', value: "I'd like to check in." }],
    }),
    (error) => error.code === 'SESSION_NOT_COMPLETED' && error.status === 409,
  );
  assert.equal(harness.saves.length, 0);
  assert.equal(active.saves.length, 0);
});

test('review saves accept the exact 30-day boundary and a 29-day completed session', async () => {
  for (const completedAt of ['2026-07-22T00:00:00.000Z', '2026-07-23T00:00:00.000Z']) {
    const harness = createHarness({ session: completedSession({ completed_at: completedAt }) });
    const response = await harness.engine.saveReviewItems('7', '42', {
      items: [{ kind: 'correction', value: "I'd like to check in." }],
    });

    assert.deepEqual(response.items, [{ kind: 'saved', item_kind: 'correction', item_id: '88' }]);
    assert.equal(harness.saves.length, 1);
  }
});

test('review saves fail closed after 30 days or without a valid completion timestamp', async () => {
  const invalidCompletedAtValues = [
    '2026-07-21T23:59:59.999Z',
    null,
    undefined,
    '',
    'not-a-date',
  ];

  for (const completedAt of invalidCompletedAtValues) {
    const session = completedSession({ completed_at: completedAt });
    const harness = createHarness({ session });
    await assert.rejects(
      harness.engine.saveReviewItems('7', '42', {
        items: [{ kind: 'correction', value: "I'd like to check in." }],
      }),
      (error) => error.code === 'REVIEW_WINDOW_EXPIRED' && error.status === 409,
    );
    assert.equal(harness.saves.length, 0);
    assert.equal(harness.events.length, 0);
  }
});

test('pronunciation review requires the persisted assessment and a fresh ownership verification', async () => {
  const valid = createHarness();
  const response = await valid.engine.saveReviewItems('7', '42', {
    items: [{ kind: 'pronunciation', value: '17', meaning_zh: '客户端文本不会保存' }],
  });
  assert.deepEqual(response.items, [{ kind: 'existing', item_kind: 'pronunciation' }]);
  assert.equal(valid.saves.length, 0);
  assert.deepEqual(valid.events.map((event) => event.properties), [{
    item_kind: 'pronunciation',
    item_count: 1,
    status: 'existing',
    reason: 'ALREADY_TRACKED',
  }]);

  const unowned = createHarness({ unownedAssessment: true });
  await assert.rejects(
    unowned.engine.saveReviewItems('7', '42', {
      items: [{ kind: 'pronunciation', value: '17' }],
    }),
    (error) => error.code === 'REVIEW_ITEM_NOT_ALLOWED' && error.status === 400,
  );
  assert.equal(unowned.saves.length, 0);
});

test('batch review saves return truthful per-item outcomes after a partial persistence failure', async () => {
  const { engine, saves, events } = createHarness({ failKind: 'suggested_phrase' });
  const response = await engine.saveReviewItems('7', '42', {
    items: [
      { kind: 'correction', value: "I'd like to check in." },
      { kind: 'suggested_phrase', value: 'I have a reservation under Chen.' },
    ],
  });

  assert.deepEqual(response.items, [
    { kind: 'saved', item_kind: 'correction', item_id: '88' },
    { kind: 'failed', item_kind: 'suggested_phrase', code: 'REVIEW_ITEM_SAVE_FAILED' },
  ]);
  assert.equal(saves.length, 2);
  assert.deepEqual(events.map((event) => event.properties), [
    { item_kind: 'correction', item_count: 1, status: 'saved', reason: 'OK' },
    { item_kind: 'suggested_phrase', item_count: 1, status: 'failed', reason: 'SAVE_FAILED' },
  ]);
  const serialized = JSON.stringify({ response, events });
  assert.equal(serialized.includes("I'd like"), false);
  assert.equal(serialized.includes('reservation'), false);
  assert.equal(serialized.includes('database detail'), false);
});

test('review-save analytics contain only item kind, count, status, and reason', async () => {
  const { engine, events } = createHarness({ existingKind: 'suggested_phrase' });
  await engine.saveReviewItems('7', '42', {
    items: [
      { kind: 'correction', value: "I'd like to check in." },
      { kind: 'suggested_phrase', value: 'I have a reservation under Chen.' },
    ],
  });

  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.name, 'ai_roleplay_review_item_saved');
    assert.deepEqual(Object.keys(event.properties).sort(), ['item_count', 'item_kind', 'reason', 'status']);
  }
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("I'd like"), false);
  assert.equal(serialized.includes('reservation'), false);
  assert.equal(serialized.includes('hotel-checkin-a2'), false);
  assert.equal(serialized.includes('session_id'), false);
  assert.equal(serialized.includes('meaning_zh'), false);
});

function makeResponse() {
  return {
    statusCode: null,
    payload: null,
    writeHead(status) { this.statusCode = status; },
    end(body) { this.payload = body ? JSON.parse(body) : null; },
  };
}

test('POST review-items authenticates before engine work and preserves canonical string ids', async () => {
  const calls = [];
  const res = makeResponse();
  const url = new URL('https://linglish.test/ai-roleplay/sessions/42/review-items');
  const handled = await registerAIRoleplayRoutes(url.pathname, { method: 'POST' }, res, url, {
    aiConfig: { features: { aiRoleplay: true } },
    authenticate: async () => { calls.push('auth'); return { id: '7' }; },
    parseBody: async () => {
      calls.push('body');
      return { items: [{ kind: 'correction', value: "I'd like to check in." }] };
    },
    engine: {
      saveReviewItems: async (userId, sessionId, body) => {
        calls.push(['engine', userId, sessionId, body.items.length]);
        return { items: [{ kind: 'saved', item_kind: 'correction', item_id: '88' }] };
      },
    },
    sendJson: (response, status, payload) => {
      response.statusCode = status;
      response.payload = payload;
    },
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['auth', 'body', ['engine', '7', '42', 1]]);
  assert.deepEqual(res.payload.items[0], { kind: 'saved', item_kind: 'correction', item_id: '88' });
});

test('POST review-items exposes the bounded review-window rejection without provider details', async () => {
  const res = makeResponse();
  const url = new URL('https://linglish.test/ai-roleplay/sessions/42/review-items');
  const handled = await registerAIRoleplayRoutes(url.pathname, { method: 'POST' }, res, url, {
    aiConfig: { features: { aiRoleplay: true } },
    authenticate: async () => ({ id: '7' }),
    parseBody: async () => ({ items: [{ kind: 'correction', value: "I'd like to check in." }] }),
    engine: {
      saveReviewItems: async () => {
        const error = new Error('private timing detail');
        error.code = 'REVIEW_WINDOW_EXPIRED';
        error.status = 409;
        error.providerBody = 'private provider body';
        throw error;
      },
    },
    sendJson: (response, status, payload) => {
      response.statusCode = status;
      response.payload = payload;
    },
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, { code: 'REVIEW_WINDOW_EXPIRED' });
  assert.equal(JSON.stringify(res.payload).includes('private'), false);
});

test('POST review-items rejects an oversized streamed body before engine work', async () => {
  let engineCalls = 0;
  const res = makeResponse();
  const url = new URL('https://linglish.test/ai-roleplay/sessions/42/review-items');
  const req = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"items":[{"kind":"correction","value":"');
      yield Buffer.alloc(256, 97);
      yield Buffer.from('"}]}');
    },
  };
  const handled = await registerAIRoleplayRoutes(url.pathname, req, res, url, {
    aiConfig: { features: { aiRoleplay: true } },
    authenticate: async () => ({ id: '7' }),
    maxReviewBodyBytes: 128,
    engine: {
      saveReviewItems: async () => { engineCalls += 1; return { items: [] }; },
    },
    sendJson: (response, status, payload) => {
      response.statusCode = status;
      response.payload = payload;
    },
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.payload, { code: 'REQUEST_BODY_TOO_LARGE' });
  assert.equal(engineCalls, 0);
});

function createConcurrentPhraseDataStore() {
  const state = {
    committedPhrases: new Map(),
    pendingPhrases: new Map(),
    committedSchedules: new Map(),
    pendingSchedules: new Map(),
    queries: [],
    connectCount: 0,
    releaseCount: 0,
  };
  let nextClientId = 0;

  function settleOwned(pending, committed, clientId, commit) {
    for (const [key, entry] of pending) {
      if (entry.owner !== clientId) continue;
      if (commit) committed.set(key, entry.id);
      pending.delete(key);
      entry.waiters.splice(0).forEach((resolve) => resolve());
    }
  }

  function waitForOwner(entry) {
    return new Promise((resolve) => entry.waiters.push(resolve));
  }

  const pool = {
    async connect() {
      state.connectCount += 1;
      const clientId = ++nextClientId;
      let released = false;
      return {
        async query(text, params = []) {
          const sql = String(text).replace(/\s+/g, ' ').trim();
          state.queries.push({ clientId, text: sql, params: structuredClone(params) });
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            const commit = sql === 'COMMIT';
            settleOwned(state.pendingPhrases, state.committedPhrases, clientId, commit);
            settleOwned(state.pendingSchedules, state.committedSchedules, clientId, commit);
            return { rows: [] };
          }
          if (/^INSERT INTO vocabulary_phrases/i.test(sql)) {
            const key = `${params[0]}:${params[1]}`;
            if (state.committedPhrases.has(key)) return { rows: [] };
            const pending = state.pendingPhrases.get(key);
            if (pending && pending.owner !== clientId) {
              await waitForOwner(pending);
              return { rows: [] };
            }
            const id = '91';
            state.pendingPhrases.set(key, { owner: clientId, id, waiters: [] });
            return { rows: [{ id }] };
          }
          if (/^SELECT id(?:\:\:text)? AS id FROM vocabulary_phrases/i.test(sql)) {
            const key = `${params[0]}:${params[1]}`;
            const own = state.pendingPhrases.get(key);
            const id = own?.owner === clientId ? own.id : state.committedPhrases.get(key);
            return { rows: id ? [{ id }] : [] };
          }
          if (/^INSERT INTO review_schedule/i.test(sql)) {
            const key = `${params[0]}:phrase:${params[1]}`;
            if (state.committedSchedules.has(key)) return { rows: [] };
            const pending = state.pendingSchedules.get(key);
            if (pending && pending.owner !== clientId) {
              await waitForOwner(pending);
              return { rows: [] };
            }
            const id = '501';
            state.pendingSchedules.set(key, { owner: clientId, id, waiters: [] });
            return { rows: [{ id }] };
          }
          throw new Error(`Unexpected SQL in concurrency fake: ${sql}`);
        },
        release() {
          if (released) throw new Error('client released twice');
          released = true;
          state.releaseCount += 1;
        },
      };
    },
  };

  return {
    state,
    dataStore: {
      async init() {},
      assertDbAvailable() {},
      pool,
    },
  };
}

test('concurrent phrase saves resolve one canonical phrase id and one review schedule across two transactions', async () => {
  const { state, dataStore } = createConcurrentPhraseDataStore();
  const saveReviewItem = routePrivate.createReviewItemSaveAdapter({ dataStore });
  const item = {
    kind: 'phrase',
    source_kind: 'suggested_phrase',
    value: 'I have a reservation under Chen.',
    meaning_zh: '我用 Chen 的名字预订了房间。',
  };
  const context = { scenario_id: 'hotel-checkin-a2', session_id: '42' };

  const outcomes = await Promise.all([
    saveReviewItem('7', item, context),
    saveReviewItem('7', item, context),
  ]);

  assert.deepEqual(outcomes.map((result) => result.item_id), ['91', '91']);
  assert.deepEqual(outcomes.map((result) => result.kind).sort(), ['existing', 'saved']);
  assert.equal(state.committedPhrases.size, 1);
  assert.equal(state.committedSchedules.size, 1);
  assert.equal(state.connectCount, 2);
  assert.equal(state.releaseCount, 2);
  const serialized = JSON.stringify(state.queries);
  assert.equal(serialized.includes('hotel-checkin-a2'), true);
  assert.equal(serialized.includes('learner_text'), false);
  assert.equal(serialized.includes('transcript'), false);
  assert.equal(serialized.includes('history'), false);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.textContent = '';
    this.className = '';
    this.type = '';
    this.disabled = false;
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this.hidden = false;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  get childNodes() { return this.children; }
  async click() { return this.listeners.click(); }
}

function loadFrontendReviewHelper() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/ai-roleplay/main.js'),
    'utf8',
  );
  const fakeDocument = { createElement: (tagName) => new FakeElement(tagName) };
  const fakeWindow = {};
  vm.runInNewContext(source, {
    window: fakeWindow,
    document: fakeDocument,
    AbortController,
    DOMException,
  });
  return { helper: fakeWindow.LinglishRoleplayReviewLoop, fakeDocument };
}

function findElements(root, predicate) {
  const found = [];
  if (predicate(root)) found.push(root);
  for (const child of root.children || []) found.push(...findElements(child, predicate));
  return found;
}

function cardByHeading(container, heading) {
  return findElements(container, (element) => (
    element.tagName === 'article'
    && findElements(element, (child) => child.tagName === 'h3' && child.textContent === heading).length > 0
  ))[0];
}

test('review save control disables after success, announces status, and remains retryable after failure', async () => {
  const { helper, fakeDocument } = loadFrontendReviewHelper();
  assert.equal(typeof helper?.createSaveControl, 'function');
  const announcements = [];
  const success = helper.createSaveControl({
    document: fakeDocument,
    item: { kind: 'correction', value: "I'd like to check in." },
    save: async () => ({ kind: 'saved' }),
    announce: (message) => announcements.push(message),
  });

  assert.equal(success.button.textContent, '加入复习');
  assert.equal(success.status.attributes['aria-live'], 'polite');
  await success.button.click();
  assert.equal(success.button.disabled, true);
  assert.equal(success.button.textContent, '已加入复习');
  assert.equal(success.status.textContent, '已加入复习');

  const failure = helper.createSaveControl({
    document: fakeDocument,
    item: { kind: 'suggested_phrase', value: 'I have a reservation under Chen.' },
    save: async () => { throw new Error('network detail must stay local'); },
    announce: (message) => announcements.push(message),
  });
  await failure.button.click();
  assert.equal(failure.button.disabled, false);
  assert.equal(failure.button.textContent, '加入复习');
  assert.equal(failure.status.textContent, '加入失败，可以重试');
  assert.equal(announcements.includes('加入失败，可以重试'), true);

  const tracked = helper.createSaveControl({
    document: fakeDocument,
    item: { kind: 'pronunciation', value: '17' },
    save: async () => ({ kind: 'existing' }),
    announce: (message) => announcements.push(message),
  });
  await tracked.button.click();
  assert.equal(tracked.button.disabled, true);
  assert.equal(tracked.button.textContent, '已加入复习');
  assert.equal(tracked.status.textContent, '已在发音能力地图中');

  const existing = helper.createSaveControl({
    document: fakeDocument,
    item: { kind: 'correction', value: "I'd like to check in." },
    save: async () => ({ kind: 'existing' }),
    announce: (message) => announcements.push(message),
  });
  await existing.button.click();
  assert.equal(existing.button.disabled, true);
  assert.equal(existing.button.textContent, '已加入复习');
  assert.equal(existing.status.textContent, '已在复习中');
});

test('review save control keeps explicit failed and malformed outcomes retryable', async () => {
  const { helper, fakeDocument } = loadFrontendReviewHelper();
  const announcements = [];
  const outcomes = [
    { kind: 'failed', code: 'REVIEW_ITEM_SAVE_FAILED', server_text: 'private database detail' },
    { kind: 'unexpected', message: 'private server detail' },
    {},
    undefined,
  ];

  for (const outcome of outcomes) {
    const control = helper.createSaveControl({
      document: fakeDocument,
      item: { kind: 'suggested_phrase', value: 'Could you help me?' },
      save: async () => outcome,
      announce: (message) => announcements.push(message),
    });
    await control.button.click();
    assert.equal(control.button.disabled, false);
    assert.equal(control.button.textContent, '加入复习');
    assert.equal(control.status.textContent, '加入失败，可以重试');
  }

  assert.equal(announcements.includes('已加入复习'), false);
  assert.equal(announcements.includes('private database detail'), false);
  assert.equal(announcements.includes('private server detail'), false);
  assert.equal(announcements.filter((message) => message === '加入失败，可以重试').length, 4);
});

test('review response parser accepts only saved or existing and sanitizes malformed 2xx payloads', () => {
  const { helper } = loadFrontendReviewHelper();
  assert.equal(typeof helper?.parseReviewSaveResponse, 'function');
  assert.equal(helper.parseReviewSaveResponse({ items: [{ kind: 'saved', item_id: '88' }] }).kind, 'saved');
  assert.equal(helper.parseReviewSaveResponse({ items: [{ kind: 'existing', item_id: '88' }] }).kind, 'existing');

  const malformedPayloads = [
    undefined,
    {},
    { items: [] },
    { items: [{}] },
    { items: [{ kind: 'failed', code: 'SERVER_INTERNAL_DETAIL' }] },
    { items: [{ kind: 'unknown', message: 'private server text' }] },
  ];
  for (const payload of malformedPayloads) {
    assert.throws(
      () => helper.parseReviewSaveResponse(payload),
      (error) => error?.message === 'REVIEW_ITEM_SAVE_FAILED'
        && !error.message.includes('SERVER_INTERNAL_DETAIL')
        && !error.message.includes('private server text'),
    );
  }
});

test('actual review renderer keeps an overlong recommendation visible but omits its save button', () => {
  const { helper, fakeDocument } = loadFrontendReviewHelper();
  assert.equal(helper.REVIEW_ITEM_MAX_TEXT_LENGTH, 600);
  assert.equal(typeof helper.createReviewRenderer, 'function');
  const container = new FakeElement('div');
  const overlong = 'x'.repeat(601);
  const renderer = helper.createReviewRenderer({
    document: fakeDocument,
    container,
    save: async () => ({ kind: 'saved' }),
    announce: () => {},
    canonicalAssessmentId: (value) => (/^[1-9]\d*$/.test(String(value)) ? String(value) : null),
  });

  renderer.render({
    goals: [],
    best_turn: { text: 'I completed the task.' },
    correction: { original: 'old', rewrite: overlong, reason_zh: '说明' },
    suggested_phrase: { text: 'Could you help me?', meaning_zh: '你能帮我吗？' },
    pronunciation: { assessment_id: '17', summary: '能力地图已有记录。' },
  });

  const correctionCard = cardByHeading(container, '只改一个重点');
  const phraseCard = cardByHeading(container, '推荐表达');
  const pronunciationCard = cardByHeading(container, '发音证据');
  assert.equal(findElements(correctionCard, (element) => element.tagName === 'button').length, 0);
  assert.equal(findElements(correctionCard, (element) => element.textContent === overlong).length, 1);
  assert.equal(findElements(phraseCard, (element) => element.tagName === 'button').length, 1);
  assert.equal(findElements(pronunciationCard, (element) => element.tagName === 'button').length, 1);
});

test('actual review renderer keeps the exact 600-character recommendation eligible', () => {
  const { helper, fakeDocument } = loadFrontendReviewHelper();
  const container = new FakeElement('div');
  const renderer = helper.createReviewRenderer({
    document: fakeDocument,
    container,
    save: async () => ({ kind: 'saved' }),
    announce: () => {},
    canonicalAssessmentId: () => null,
  });
  renderer.render({
    goals: [],
    best_turn: { text: '' },
    correction: { original: 'old', rewrite: 'x'.repeat(600), reason_zh: '说明' },
    suggested_phrase: null,
  });

  const correctionCard = cardByHeading(container, '只改一个重点');
  assert.equal(findElements(correctionCard, (element) => element.tagName === 'button').length, 1);
});
