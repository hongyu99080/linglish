const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/word-pool.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

const word = (lemma) => ({ lemma, zh: lemma + '-zh' });

test('normalizeReviewItem accepts the lemma field', () => {
  const { normalizeReviewItem } = loadModule();
  assert.deepEqual(normalizeReviewItem({ lemma: 'apple', state: 'learning' }), { lemma: 'apple', state: 'learning' });
});

test('normalizeReviewItem falls back to the word field from the legacy engine', () => {
  const { normalizeReviewItem } = loadModule();
  assert.equal(normalizeReviewItem({ word: 'banana' }).lemma, 'banana');
});

test('normalizeReviewItem returns null for an item with neither field', () => {
  const { normalizeReviewItem } = loadModule();
  assert.equal(normalizeReviewItem({ id: 3 }), null);
});

test('buildLevelPool takes the configured number of new words', () => {
  const { buildLevelPool } = loadModule();
  const pool = buildLevelPool({
    newWords: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(word),
    reviewWords: [],
    relearnQueue: [],
    newCount: 6,
    reviewCount: 4,
  });
  assert.equal(pool.newWords.length, 6);
  assert.deepEqual(pool.newWords.map((w) => w.lemma), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('buildLevelPool puts relearn words ahead of ordinary review words', () => {
  const { buildLevelPool } = loadModule();
  const pool = buildLevelPool({
    newWords: [],
    reviewWords: [word('old1'), word('old2'), word('old3'), word('old4')],
    relearnQueue: [word('wrong1'), word('wrong2')],
    newCount: 6,
    reviewCount: 4,
  });
  assert.deepEqual(pool.reviewWords.map((w) => w.lemma), ['wrong1', 'wrong2', 'old1', 'old2']);
});

test('buildLevelPool never repeats a word between the relearn queue and review words', () => {
  const { buildLevelPool } = loadModule();
  const pool = buildLevelPool({
    newWords: [],
    reviewWords: [word('dup'), word('other')],
    relearnQueue: [word('dup')],
    newCount: 6,
    reviewCount: 4,
  });
  assert.deepEqual(pool.reviewWords.map((w) => w.lemma), ['dup', 'other']);
});

test('buildLevelPool returns fewer review words rather than padding when supply runs out', () => {
  const { buildLevelPool } = loadModule();
  const pool = buildLevelPool({
    newWords: [],
    reviewWords: [word('only')],
    relearnQueue: [],
    newCount: 6,
    reviewCount: 4,
  });
  assert.equal(pool.reviewWords.length, 1);
});

test('buildLevelPool does not mutate its input arrays', () => {
  const { buildLevelPool } = loadModule();
  const reviewWords = [word('a'), word('b')];
  buildLevelPool({ newWords: [], reviewWords, relearnQueue: [], newCount: 6, reviewCount: 4 });
  assert.equal(reviewWords.length, 2);
});
