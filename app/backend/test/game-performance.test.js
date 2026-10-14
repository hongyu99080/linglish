const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const vm = require('node:vm');

const cacheHeadersMiddleware = require('../middleware/cache-headers');
const { registerStaticRoutes, serveStatic } = require('../routes/static');

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.headers = new Map();
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  removeHeader(name) { this.headers.delete(name.toLowerCase()); }

  writeHead(status, headers) {
    this.statusCode = status;
    Object.entries(headers || {}).forEach(([name, value]) => this.setHeader(name, value));
    return this;
  }

  body() { return Buffer.concat(this.chunks).toString('utf8'); }
}

async function serveFrontend(relativePath, requestUrl, method = 'GET') {
  const response = new CaptureResponse();
  const request = { method, url: requestUrl, headers: {} };
  cacheHeadersMiddleware(request, response, () => {});
  const url = new URL(requestUrl, 'http://127.0.0.1');
  const served = await registerStaticRoutes(url.pathname, request, response, url);
  assert.equal(served, true);
  return response;
}

function cssBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected CSS block ${marker}`);
  const openBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated CSS block ${marker}`);
}

async function bootGameApp(options = {}) {
  const appPath = path.resolve(__dirname, '../../frontend/js/game/game-app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  const rendered = [];
  const tracked = [];

  function node(tag, className, label) {
    return {
      tag,
      className: className || '',
      textContent: label || '',
      children: [],
      dataset: {},
      disabled: false,
      appendChild(child) { this.children.push(child); },
    };
  }

  function button(className, label, onClick) {
    return {
      ...node('button', className, label),
      onClick,
      click() { if (!this.disabled) return onClick(); },
    };
  }

  const progress = {
    currentChapter: 1,
    currentLevel: 1,
    stars: {},
    unlockedParts: [],
    ...(options.progress || {}),
  };
  const session = {
    chapter: 1,
    level: 1,
    isBoss: false,
    newWords: [],
    reviewWords: [],
  };
  const api = {
    flushRetryQueue: async () => 0,
    track(eventName, properties) {
      tracked.push({ eventName, properties });
      return Promise.resolve(true);
    },
  };
  const startCalls = [];
  const engine = {
    startLevel: async (requestedProgress) => {
      startCalls.push(requestedProgress);
      return session;
    },
    recordResult: async (current) => current,
    finishLevel: async () => ({
      progress: { ...progress, currentLevel: 2 },
      stars: 3,
      accuracy: 1,
      unlockedPart: null,
      bossStatus: null,
      characterComplete: false,
      statsResult: null,
    }),
    bossQuestionWords: () => [],
  };

  const window = {
    AuthManager: { getToken: () => 'header.payload.signature' },
    Audio: function Audio() { this.play = () => Promise.resolve(); },
    GameApiClient: { createApiClient: () => api },
    GameLevelEngine: {
      BOSS_LEVEL: 6,
      BOSS_STAR_GATE: 8,
      chapterStars: options.chapterStars || (() => 0),
      createLevelEngine: () => engine,
    },
    GameProgressStore: {
      createProgressStore: () => ({ load: () => progress }),
    },
    GameViews: {
      h: node,
      button,
      show: (_container, nodes) => { rendered.push(nodes); },
      renderLearn: async () => {},
      renderLianliankan: async () => {},
      renderSpelling: async () => {},
      renderQuiz: async () => {},
      renderBoss: async () => {},
      ...(options.views || {}),
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ chapters: [{ chapter: 1, words: [] }] }),
    }),
    localStorage: {},
    location: { replace() {} },
    matchMedia: () => ({ matches: false }),
  };

  vm.runInNewContext(source, {
    window,
    document: { getElementById: () => ({}) },
    fetch: window.fetch,
  });
  await new Promise((resolve) => setImmediate(resolve));

  return { rendered, tracked, startCalls };
}

test('versioned game assets are immutable at the real static route boundary', async () => {
  const assets = [
    ['js/game/game-app.js', '/js/game/game-app.js?v=performance-test'],
    ['js/game/word-packs/pack-max.json', '/js/game/word-packs/pack-max.json?v=performance-test'],
    ['styles/mobile/pages/game.css', '/styles/mobile/pages/game.css?v=performance-test'],
  ];

  for (const [relativePath, requestUrl] of assets) {
    const response = await serveFrontend(relativePath, requestUrl, 'HEAD');
    assert.equal(response.statusCode, 200, requestUrl);
    assert.equal(
      response.getHeader('cache-control'),
      'public, max-age=31536000, immutable',
      requestUrl,
    );
    assert.equal(response.getHeader('pragma'), undefined, requestUrl);
  }
});

test('game shell asks the browser to preload the word pack', async () => {
  const response = await serveFrontend('game.html', '/game.html');

  assert.match(
    response.body(),
    /<link\s+rel="preload"\s+href="\/js\/game\/word-packs\/pack-max\.json\?v=7"\s+as="fetch"\s+crossorigin="anonymous">/,
  );
});

test('game shell invalidates the immutable pre-tracking API client cache', async () => {
  const response = await serveFrontend('game.html', '/game.html');

  assert.match(response.body(), /<script src="\/js\/game\/api-client\.js\?v=3"><\/script>/);
  assert.doesNotMatch(response.body(), /<script src="\/js\/game\/api-client\.js\?v=2"><\/script>/);
});

test('game shell publishes interaction fixes under fresh immutable cache keys', async () => {
  const response = await serveFrontend('game.html', '/game.html');

  assert.match(response.body(), /href="\/styles\/mobile\/pages\/game\.css\?v=10"/);
  assert.match(response.body(), /src="\/js\/game\/games\/quiz\.js\?v=2"/);
  assert.match(response.body(), /src="\/js\/game\/game-app\.js\?v=8"/);
});

test('current level and quiz hover effects keep button geometry stable', () => {
  const cssPath = path.resolve(__dirname, '../../frontend/styles/mobile/pages/game.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  assert.doesNotMatch(cssBlock(css, '@keyframes game-breathe'), /\btransform\s*:/);
  assert.doesNotMatch(cssBlock(css, '.game-btn--option:hover'), /\btransform\s*:/);
});

test('explicit private cache policy wins over versioned asset inference', async () => {
  const response = new CaptureResponse();
  const filePath = path.resolve(__dirname, '../../frontend/js/game/word-packs/pack-max.json');
  const request = {
    method: 'HEAD',
    url: '/private/pack-max.json?v=performance-test',
    headers: {},
  };

  await serveStatic(response, filePath, request, { cacheControl: 'private, no-store' });

  assert.equal(response.getHeader('cache-control'), 'private, no-store');
});

test('game map renders without waiting for retry queue flush', async () => {
  const appPath = path.resolve(__dirname, '../../frontend/js/game/game-app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  let rendered = false;
  let flushStarted = false;

  function node() {
    return { appendChild() {}, dataset: {}, disabled: false };
  }

  const window = {
    AuthManager: { getToken: () => 'header.payload.signature' },
    Audio: function Audio() { this.play = () => Promise.resolve(); },
    GameApiClient: {
      createApiClient: () => ({
        flushRetryQueue: () => {
          flushStarted = true;
          return new Promise(() => {});
        },
      }),
    },
    GameLevelEngine: {
      BOSS_LEVEL: 1,
      BOSS_STAR_GATE: 0,
      chapterStars: () => 0,
      createLevelEngine: () => ({}),
    },
    GameProgressStore: {
      createProgressStore: () => ({
        load: () => ({ currentChapter: 1, currentLevel: 1, stars: {}, unlockedParts: [] }),
      }),
    },
    GameViews: {
      h: node,
      button: node,
      show: () => { rendered = true; },
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ chapters: [{ chapter: 1 }] }),
    }),
    localStorage: {},
    location: { replace() {} },
    matchMedia: () => ({ matches: false }),
  };

  vm.runInNewContext(source, {
    window,
    document: { getElementById: () => ({}) },
    fetch: window.fetch,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(flushStarted, true);
  assert.equal(rendered, true, 'the map must not be blocked by background retries');
});

test('game map exposes a stable continue button for the current level', async () => {
  const { rendered } = await bootGameApp();
  const map = rendered[0] || [];
  const continueButton = map.find((item) => item.className.includes('game-map-continue'));

  assert.ok(continueButton, 'expected a dedicated continue button above the level path');
  assert.equal(continueButton.textContent, '继续第 1 关');
});

test('continue button cannot bypass the boss star gate', async () => {
  const { rendered, startCalls } = await bootGameApp({
    progress: { currentLevel: 6 },
    chapterStars: () => 7,
  });
  const map = rendered[0] || [];
  const continueButton = map.find((item) => item.className.includes('game-map-continue'));

  assert.ok(continueButton);
  assert.equal(continueButton.textContent, '还差 1 星解锁 BOSS');
  assert.equal(continueButton.disabled, true);
  continueButton.click();
  assert.equal(startCalls.length, 0);
});

test('continue button opens the boss once the star gate is met', async () => {
  const { rendered, startCalls } = await bootGameApp({
    progress: { currentLevel: 6 },
    chapterStars: () => 8,
  });
  const map = rendered[0] || [];
  const continueButton = map.find((item) => item.className.includes('game-map-continue'));

  assert.equal(continueButton.textContent, '挑战 BOSS');
  assert.equal(continueButton.disabled, false);
  continueButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].currentLevel, 6);
});

test('finishing each regular level phase records where players progressed', async () => {
  let finishLearn;
  const learnFinished = new Promise((resolve) => { finishLearn = resolve; });
  const { rendered, tracked } = await bootGameApp({
    views: { renderLearn: () => learnFinished },
  });
  const map = rendered[0] || [];
  const currentLevel = map.find((item) => item.className === 'game-node' && item.dataset.current === 'true');

  assert.ok(currentLevel, 'expected the current level node');
  currentLevel.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    tracked.filter((event) => event.eventName === 'game_phase_complete'),
    [],
    'a phase must not be tracked until its view resolves',
  );

  finishLearn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    tracked
      .filter((event) => event.eventName === 'game_phase_complete')
      .map((event) => event.properties.phase),
    ['learn', 'matching', 'quiz'],
  );
});
