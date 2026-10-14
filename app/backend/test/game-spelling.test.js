const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/games/spelling.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

const seeded = () => { let s = 7; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };
const tileFor = (challenge, letter) => challenge.tiles.find((t) => t.letter === letter && !challenge.filled.includes(t.id));

test('buildChallenge offers the word letters plus two distractors', () => {
  const { buildChallenge } = loadModule();
  const challenge = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  assert.equal(challenge.tiles.length, 5);
  assert.equal(challenge.lemma, 'cat');
  assert.deepEqual(challenge.filled, []);
  assert.equal(challenge.hintsUsed, 0);
});

test('buildChallenge includes every letter of the word', () => {
  const { buildChallenge } = loadModule();
  const challenge = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  const letters = challenge.tiles.map((t) => t.letter).sort().join('');
  assert.ok(letters.includes('a') && letters.includes('c') && letters.includes('t'));
});

test('placing the correct next letter is accepted', () => {
  const { buildChallenge, placeTile } = loadModule();
  const challenge = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  const result = placeTile(challenge, tileFor(challenge, 'c').id);
  assert.equal(result.accepted, true);
  assert.equal(result.challenge.filled.length, 1);
});

test('placing a wrong letter is rejected and leaves the challenge unchanged', () => {
  const { buildChallenge, placeTile } = loadModule();
  const challenge = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  const result = placeTile(challenge, tileFor(challenge, 't').id);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.challenge.filled, []);
});

test('placeTile does not mutate the challenge it is given', () => {
  const { buildChallenge, placeTile } = loadModule();
  const challenge = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  placeTile(challenge, tileFor(challenge, 'c').id);
  assert.deepEqual(challenge.filled, []);
});

test('isComplete becomes true once the whole word is spelled', () => {
  const { buildChallenge, placeTile, isComplete } = loadModule();
  let challenge = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  for (const letter of 'cat') {
    challenge = placeTile(challenge, tileFor(challenge, letter).id).challenge;
  }
  assert.equal(isComplete(challenge), true);
});

test('revealHint fills the next correct letter and counts the hint', () => {
  const { buildChallenge, revealHint } = loadModule();
  const challenge = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  const hinted = revealHint(challenge);
  assert.equal(hinted.filled.length, 1);
  assert.equal(hinted.hintsUsed, 1);
  assert.equal(challenge.hintsUsed, 0, 'must not mutate the input');
});

test('a word spelled with no hints scores in the perfect tier', () => {
  const { buildChallenge, placeTile, scoreChallenge } = loadModule();
  let challenge = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  for (const letter of 'cat') {
    challenge = placeTile(challenge, tileFor(challenge, letter).id).challenge;
  }
  const result = scoreChallenge(challenge, { timedOut: false });
  assert.equal(result.tier, 'perfect');
  assert.ok(result.score > 0);
});

test('a hinted word scores lower than a perfect one', () => {
  const { buildChallenge, placeTile, revealHint, scoreChallenge } = loadModule();
  const base = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  let perfect = base;
  for (const letter of 'cat') {
    perfect = placeTile(perfect, tileFor(perfect, letter).id).challenge;
  }
  let hinted = revealHint(base);
  for (const letter of 'at') {
    hinted = placeTile(hinted, tileFor(hinted, letter).id).challenge;
  }
  const hintedScore = scoreChallenge(hinted, { timedOut: false });
  assert.equal(hintedScore.tier, 'hinted');
  assert.ok(hintedScore.score < scoreChallenge(perfect, { timedOut: false }).score);
});

test('a timed-out challenge scores in the timeout tier', () => {
  const { buildChallenge, scoreChallenge } = loadModule();
  const challenge = buildChallenge({ lemma: 'cat', zh: '猫' }, { rng: seeded() });
  assert.equal(scoreChallenge(challenge, { timedOut: true }).tier, 'timeout');
});
