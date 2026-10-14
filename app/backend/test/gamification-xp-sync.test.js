const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const gamificationPath = path.resolve(__dirname, '../../frontend/gamification.js');

function makeLocalStorage(seed = {}) {
  const store = { ...seed };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

const LOCAL_STATE = {
  xp: 5000, level: 9, xpToNextLevel: 500, totalXpEarned: 5000,
  coins: 0, totalCoinsEarned: 0,
  currentStreak: 3, longestStreak: 7, lastActiveDate: null, streakFreezeUsed: false,
  dailyGoal: { target: 20, completed: 0, date: '2026-07-31' },
  stats: { videosWatched: 0, videoMinutes: 0, practicesSessions: 0, wordsLearned: 0, sentencesRecorded: 0, perfectScores: 0, daysActive: 1 },
  achievements: {},
  vocabulary: { new: 0, learning: 0, known: 0, total: 0 },
  lastUpdate: '2026-07-31T00:00:00.000Z',
};

// 构造一个已登录、有本地进度、尚未迁移的系统实例;fetchImpl 决定服务端行为
async function bootstrap(fetchImpl) {
  const calls = [];
  const localStorage = makeLocalStorage({
    linglish_token: 'test-token',
    linglish_gamification: JSON.stringify(LOCAL_STATE),
  });
  const prev = { localStorage: global.localStorage, fetch: global.fetch };
  global.localStorage = localStorage;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return fetchImpl(url, options);
  };
  try {
    delete require.cache[require.resolve(gamificationPath)];
    const GamificationSystem = require(gamificationPath);
    const sys = new GamificationSystem();
    // 让构造函数内触发的异步链跑完
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return { sys, calls, localStorage };
  } finally {
    global.localStorage = prev.localStorage;
    global.fetch = prev.fetch;
  }
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

const SERVER_OVERVIEW = {
  total_xp: 0, level: 1, streak: { current: 0, longest: 0 }, total_words_learned: 0,
};

test('C-1: 迁移失败时不得同步服务端,本地 XP/等级保持不变', async () => {
  const { sys, calls } = await bootstrap(async (url) => {
    if (url.includes('/api/stats/migrate-local')) return { ok: false, status: 500, json: async () => ({}) };
    return okJson(SERVER_OVERVIEW);
  });

  assert.equal(sys.data.xp, 5000, '迁移失败不得改写本地 XP');
  assert.equal(sys.data.totalXpEarned, 5000, '重试来源必须保留,否则下次只能迁移 0');
  assert.equal(sys.data.level, 9, '迁移失败不得表现为掉级');
  assert.notEqual(sys.data.serverMigrated, true, '失败不得标记为已迁移');
  assert.equal(
    calls.some((c) => c.url.includes('/api/stats/overview')), false,
    '迁移失败后不得调用 overview 覆盖本地数据'
  );
});

test('C-1: 迁移成功后正常同步服务端', async () => {
  const { sys, calls } = await bootstrap(async (url) => {
    if (url.includes('/api/stats/migrate-local')) return okJson({ migrated: true });
    return okJson({ ...SERVER_OVERVIEW, total_xp: 5000, level: 9 });
  });

  assert.equal(sys.data.serverMigrated, true);
  assert.equal(calls.some((c) => c.url.includes('/api/stats/overview')), true);
  assert.equal(sys.data.xp, 5000);
  assert.equal(sys.data.level, 9);
});

test('C-1: 已迁移过的用户直接同步,不重复迁移', async () => {
  const localStorage = makeLocalStorage({
    linglish_token: 'test-token',
    linglish_gamification: JSON.stringify({ ...LOCAL_STATE, serverMigrated: true }),
  });
  const calls = [];
  const prev = { localStorage: global.localStorage, fetch: global.fetch };
  global.localStorage = localStorage;
  global.fetch = async (url) => {
    calls.push(url);
    return okJson({ ...SERVER_OVERVIEW, total_xp: 5000, level: 9 });
  };
  try {
    delete require.cache[require.resolve(gamificationPath)];
    const GamificationSystem = require(gamificationPath);
    const sys = new GamificationSystem();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.some((u) => u.includes('/api/stats/migrate-local')), false);
    assert.equal(calls.some((u) => u.includes('/api/stats/overview')), true);
    assert.equal(sys.data.xp, 5000);
  } finally {
    global.localStorage = prev.localStorage;
    global.fetch = prev.fetch;
  }
});

test('I-2: quick-win 与每日宝箱的 XP 会上报服务端', async () => {
  const prev = { localStorage: global.localStorage, fetch: global.fetch };
  global.localStorage = makeLocalStorage({
    linglish_token: 'test-token',
    linglish_gamification: JSON.stringify({ ...LOCAL_STATE, serverMigrated: true }),
  });
  const logged = [];
  global.fetch = async () => okJson(SERVER_OVERVIEW);
  try {
    delete require.cache[require.resolve(gamificationPath)];
    const GamificationSystem = require(gamificationPath);
    const sys = new GamificationSystem();
    sys.apiFetch = async (p, options) => {
      logged.push({ path: p, body: JSON.parse(options.body || '{}') });
      return {};
    };
    sys.syncFromServer = async () => {};
    sys.showNotification = () => {};

    sys.reportActivity('quick_win_completed', { correct: 6, total: 8 });
    sys.reportActivity('daily_chest_claimed');
    await new Promise((r) => setImmediate(r));

    assert.equal(logged.length, 2, '两条路径都必须打到 /api/stats/log');
    assert.ok(logged.every((l) => l.path === '/api/stats/log'));
    assert.equal(logged[0].body.type, 'vocabulary');
    assert.equal(logged[0].body.details.words_reviewed, 6);
    assert.equal(logged[1].body.type, 'other');
    assert.ok(logged[1].body.duration_minutes > 0, '宝箱必须产生非零 XP');
  } finally {
    global.localStorage = prev.localStorage;
    global.fetch = prev.fetch;
  }
});

test('I-2: 每日宝箱页面调用 recordActivity 上报', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/mobile-treasure.js'), 'utf8'
  );
  assert.match(src, /recordActivity\('daily_chest_claimed'\)/);
});

test('I-2: 未登录时上报静默跳过,不抛错', async () => {
  const prev = { localStorage: global.localStorage, fetch: global.fetch };
  global.localStorage = makeLocalStorage({ linglish_gamification: JSON.stringify(LOCAL_STATE) });
  global.fetch = async () => { throw new Error('should not be called'); };
  try {
    delete require.cache[require.resolve(gamificationPath)];
    const GamificationSystem = require(gamificationPath);
    const sys = new GamificationSystem();
    assert.doesNotThrow(() => sys.reportActivity('daily_chest_claimed'));
    assert.doesNotThrow(() => sys.reportActivity('quick_win_completed', { correct: 1 }));
  } finally {
    global.localStorage = prev.localStorage;
    global.fetch = prev.fetch;
  }
});

// C-1 回归:reportActivity 的 .then(syncFromServer) 曾绕过 initServerSync 的迁移闸门。
// 迁移失败但 /api/stats/log 成功时(V30 未上线的真实场景),同步会把本地 XP 抹成服务端值。
test('C-1 回归: 迁移未完成时任何来源的同步都不得覆盖本地 XP', async () => {
  const prev = { localStorage: global.localStorage, fetch: global.fetch };
  global.localStorage = makeLocalStorage({
    linglish_token: 'test-token',
    linglish_gamification: JSON.stringify(LOCAL_STATE), // serverMigrated 未置位
  });
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    // migrate-local 失败(表还没建),但 log 与 overview 正常:V30 上线前的真实组合
    if (String(url).includes('/api/stats/migrate-local')) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (String(url).includes('/api/stats/overview')) {
      return okJson({ ...SERVER_OVERVIEW, total_xp: 20, level: 1 });
    }
    return okJson({});
  };
  try {
    delete require.cache[require.resolve(gamificationPath)];
    const GamificationSystem = require(gamificationPath);
    const sys = new GamificationSystem();
    sys.showNotification = () => {};
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));

    sys.reportActivity('daily_chest_claimed');
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));

    assert.equal(calls.some((u) => u.includes('/api/stats/overview')), false,
      '迁移未完成时不得拉取 overview');
    assert.equal(sys.data.xp, 5000, '本地 XP 必须原样保留');
    assert.equal(sys.data.level, 9, '等级不得回退');
    assert.equal(sys.data.totalXpEarned, 5000, '重试源必须仍然可用');
  } finally {
    global.localStorage = prev.localStorage;
    global.fetch = prev.fetch;
  }
});
