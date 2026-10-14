const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../../frontend');
const storeScriptPath = path.join(frontend, 'js/youtube-temp-session-store.js');
const importHtmlPath = path.join(frontend, 'youtube-import.html');
const readerHtmlPath = path.join(frontend, 'youtube-reader.html');

function createStorage(initial = {}, options = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (options.setError) throw options.setError;
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
  };
}

function createElement(initial = {}) {
  const listeners = new Map();
  const classes = new Set();
  return Object.assign({
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    style: {},
    dataset: {},
    listeners,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(name, handler) { listeners.set(name, handler); },
    querySelectorAll() { return []; },
    appendChild() {},
    focus() {},
    scrollIntoView() {},
  }, initial);
}

function extractInlineScript(html, marker) {
  const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g));
  const match = scripts.find((entry) => entry[1].includes(marker));
  assert.ok(match, `inline script containing ${marker} must exist`);
  return match[1];
}

function loadStoreScriptWhenDeclared(html, context) {
  const declared = /<script\s+src=["']\/js\/youtube-temp-session-store\.js["']><\/script>/.test(html);
  if (!declared) return;
  const source = fs.readFileSync(storeScriptPath, 'utf8');
  vm.runInContext(source, context, { filename: storeScriptPath });
}

function createDocument(elements, options = {}) {
  return {
    body: createElement(),
    getElementById(id) {
      if (Object.prototype.hasOwnProperty.call(elements, id)) return elements[id];
      const element = createElement();
      elements[id] = element;
      return element;
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement() { return createElement(); },
    addEventListener: options.addEventListener || (() => {}),
  };
}

test('temporary import survives a full localStorage and navigates with the successful session', async () => {
  const html = fs.readFileSync(importHtmlPath, 'utf8');
  const quotaError = Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
  const elements = {
    youtubeForm: createElement(),
    youtubeUrl: createElement({ value: 'https://www.youtube.com/watch?v=GvbnYa4uvSQ' }),
    language: createElement({ value: 'en' }),
    submitBtn: createElement(),
    loading: createElement(),
    error: createElement(),
    success: createElement(),
    videoPreview: createElement(),
    previewTitle: createElement(),
    previewInfo: createElement(),
    'tag-options': null,
    'save-options': null,
    'difficulty-level': null,
    'collection-name': null,
  };
  const destinations = [];
  const session = {
    youtube_video_id: 'GvbnYa4uvSQ',
    title: 'LEARN EASY English in Beijing',
    transcript: 'Welcome to Beijing.',
    segments: [{ index: 0, start: 0, end: 2.4, text: 'Welcome to Beijing.' }],
    mode: 'temporary',
  };
  const localStorage = createStorage({ linglish_token: 'token' }, { setError: quotaError });
  const sessionStorage = createStorage();
  const window = {
    localStorage,
    sessionStorage,
    location: {
      href: 'https://www.example.com/youtube-import.html',
      assign(destination) { destinations.push(destination); },
    },
    ImportResult: { parseImportResult: () => ({ videoId: null, message: '' }) },
  };
  const context = vm.createContext({
    window,
    self: window,
    document: createDocument(elements),
    localStorage,
    sessionStorage,
    fetch: async () => ({
      status: 200,
      text: async () => JSON.stringify({ success: true, session }),
    }),
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URL,
    Date,
    Error,
    JSON,
    Set,
  });
  window.window = window;
  window.document = context.document;
  window.Date = Date;

  loadStoreScriptWhenDeclared(html, context);
  vm.runInContext(extractInlineScript(html, "const form = document.getElementById('youtubeForm')"), context, {
    filename: importHtmlPath,
  });

  const submit = elements.youtubeForm.listeners.get('submit');
  assert.equal(typeof submit, 'function');
  await submit({ preventDefault() {} });

  assert.deepEqual(destinations, ['/youtube-reader.html']);
  assert.equal(elements.error.textContent, '');
});

test('temporary reader distinguishes an expired stored session from missing data', async () => {
  const html = fs.readFileSync(readerHtmlPath, 'utf8');
  const now = Date.now();
  const expiredEnvelope = JSON.stringify({
    version: 1,
    savedAt: now - (26 * 60 * 60 * 1000),
    expiresAt: now - (2 * 60 * 60 * 1000),
    payload: {
      youtube_video_id: 'expired1234',
      title: 'Expired session',
      transcript: 'expired',
      segments: [],
      mode: 'temporary',
    },
  });
  const elements = {};
  const alerts = [];
  const loadHandlers = [];
  const localStorage = createStorage();
  const sessionStorage = createStorage({ youtube_temp_session: expiredEnvelope });
  const window = {
    localStorage,
    sessionStorage,
    location: { href: 'https://www.example.com/youtube-reader.html' },
    addEventListener(name, handler) {
      if (name === 'load') loadHandlers.push(handler);
    },
  };
  const document = createDocument(elements);
  const context = vm.createContext({
    window,
    self: window,
    document,
    localStorage,
    sessionStorage,
    alert(message) { alerts.push(message); },
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => ({ ok: true, json: async () => ({ items: [] }) }),
    setTimeout,
    clearTimeout,
    URL,
    Date,
    Error,
    JSON,
    Set,
    Map,
  });
  window.window = window;
  window.document = document;
  window.Date = Date;

  loadStoreScriptWhenDeclared(html, context);
  vm.runInContext(extractInlineScript(html, 'let player;'), context, { filename: readerHtmlPath });

  assert.equal(loadHandlers.length, 1);
  await loadHandlers[0]();

  assert.deepEqual(alerts, ['临时视频数据已过期，请返回重新导入']);
  assert.equal(window.location.href, '/youtube-import.html');
});
