const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/progress-store.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

function createStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

test('load returns default progress when storage is empty', () => {
  const { createProgressStore, DEFAULT_PROGRESS } = loadModule();
  const store = createProgressStore(createStorage());
  const progress = store.load();
  assert.equal(progress.version, 1);
  assert.equal(progress.currentChapter, 1);
  assert.equal(progress.currentLevel, 1);
  assert.deepEqual(progress.unlockedParts, []);
  assert.notEqual(progress, DEFAULT_PROGRESS, 'must return a copy, not the shared default');
});

test('save then load round-trips progress', () => {
  const { createProgressStore } = loadModule();
  const storage = createStorage();
  const store = createProgressStore(storage);
  const next = { ...store.load(), currentLevel: 3, unlockedParts: ['head'] };
  assert.equal(store.save(next), true);
  const loaded = store.load();
  assert.equal(loaded.currentLevel, 3);
  assert.deepEqual(loaded.unlockedParts, ['head']);
});

test('save preserves the relearn queue across a reload', () => {
  const { createProgressStore } = loadModule();
  const storage = createStorage();
  const store = createProgressStore(storage);
  const queue = [{ lemma: 'apple', dueLevel: 4 }];
  store.save({ ...store.load(), relearnQueue: queue });
  assert.deepEqual(store.load().relearnQueue, queue);
});

test('load defaults the relearn queue to an empty array', () => {
  const { createProgressStore } = loadModule();
  const store = createProgressStore(createStorage());
  assert.deepEqual(store.load().relearnQueue, []);
});

test('load discards corrupt json and returns defaults', () => {
  const { createProgressStore } = loadModule();
  const store = createProgressStore(createStorage({ linglish_game_progress: '{not json' }));
  assert.equal(store.load().currentLevel, 1);
});

test('load discards records from an unknown schema version', () => {
  const { createProgressStore } = loadModule();
  const stored = JSON.stringify({ version: 99, currentLevel: 42 });
  const store = createProgressStore(createStorage({ linglish_game_progress: stored }));
  assert.equal(store.load().currentLevel, 1);
});

test('save returns false when storage throws', () => {
  const { createProgressStore } = loadModule();
  const store = createProgressStore({
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceeded'); },
    removeItem: () => {},
  });
  assert.equal(store.save(store.load()), false);
});

test('recordWordResult tracks which game types answered a word correctly', () => {
  const { createProgressStore } = loadModule();
  const store = createProgressStore(createStorage());
  const p0 = store.load();
  const p1 = store.recordWordResult(p0, 'apple', 'lianliankan', true);
  const p2 = store.recordWordResult(p1, 'apple', 'spelling', true);
  assert.deepEqual(p2.wordStates.apple.correctIn, ['lianliankan', 'spelling']);
  assert.equal(p0.wordStates.apple, undefined, 'must not mutate the input progress');
});

test('recordWordResult counts wrong answers without adding a correct game type', () => {
  const { createProgressStore } = loadModule();
  const store = createProgressStore(createStorage());
  const p1 = store.recordWordResult(store.load(), 'apple', 'quiz', false);
  assert.deepEqual(p1.wordStates.apple.correctIn, []);
  assert.equal(p1.wordStates.apple.wrongCount, 1);
});
