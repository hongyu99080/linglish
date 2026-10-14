const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/boss.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

const chapterWords = Array.from({ length: 30 }, (_, i) => ({ lemma: 'w' + i, zh: 'z' + i }));

test('boss hp scales with the chapter word count', () => {
  const { createBossState } = loadModule();
  const state = createBossState(chapterWords, {});
  assert.equal(state.maxHp, 30);
  assert.equal(state.hp, 30);
});

test('a correct answer damages the boss', () => {
  const { createBossState, applyAnswer } = loadModule();
  const state = applyAnswer(createBossState(chapterWords, {}), { lemma: 'w0', isCorrect: true });
  assert.equal(state.hp, 29);
  assert.equal(state.shields, 3);
});

test('a wrong answer costs a shield and records the word', () => {
  const { createBossState, applyAnswer } = loadModule();
  const state = applyAnswer(createBossState(chapterWords, {}), { lemma: 'w0', isCorrect: false });
  assert.equal(state.shields, 2);
  assert.equal(state.hp, 30);
  assert.deepEqual(state.wrongLemmas, ['w0']);
});

test('applyAnswer does not mutate the previous state', () => {
  const { createBossState, applyAnswer } = loadModule();
  const before = createBossState(chapterWords, {});
  applyAnswer(before, { lemma: 'w0', isCorrect: true });
  assert.equal(before.hp, 30);
});

test('the fight is won only when boss hp reaches zero', () => {
  const { createBossState, applyAnswer, bossOutcome } = loadModule();
  let state = createBossState(chapterWords, {});
  assert.equal(bossOutcome(state).status, 'ongoing');
  for (let i = 0; i < 30; i += 1) {
    state = applyAnswer(state, { lemma: 'w' + i, isCorrect: true });
  }
  assert.equal(bossOutcome(state).status, 'won');
});

test('the fight is lost once every shield is gone', () => {
  const { createBossState, applyAnswer, bossOutcome } = loadModule();
  let state = createBossState(chapterWords, { shields: 2 });
  state = applyAnswer(state, { lemma: 'w0', isCorrect: false });
  state = applyAnswer(state, { lemma: 'w1', isCorrect: false });
  assert.equal(bossOutcome(state).status, 'lost');
});

test('bossOutcome reports accuracy over the answers given', () => {
  const { createBossState, applyAnswer, bossOutcome } = loadModule();
  let state = createBossState(chapterWords, {});
  state = applyAnswer(state, { lemma: 'w0', isCorrect: true });
  state = applyAnswer(state, { lemma: 'w1', isCorrect: true });
  state = applyAnswer(state, { lemma: 'w2', isCorrect: false });
  assert.equal(Math.round(bossOutcome(state).accuracy * 100), 67);
});

test('a retry serves the words missed last time first', () => {
  const { createBossState, applyAnswer, nextBossWords } = loadModule();
  let state = createBossState(chapterWords, {});
  state = applyAnswer(state, { lemma: 'w7', isCorrect: false });
  const served = nextBossWords(state, chapterWords, 3);
  assert.equal(served[0].lemma, 'w7');
  assert.equal(served.length, 3);
});

test('one-word rounds cover every chapter word instead of repeating the first', () => {
  const { createBossState, applyAnswer, nextBossWords } = loadModule();
  let state = createBossState(chapterWords, {});
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) {
    const round = nextBossWords(state, chapterWords, 1);
    assert.equal(round.length, 1);
    seen.add(round[0].lemma);
    state = applyAnswer(state, { lemma: round[0].lemma, isCorrect: true });
  }
  assert.equal(seen.size, 30);
});

test('a word answered correctly on retry loses its priority slot', () => {
  const { createBossState, applyAnswer, nextBossWords } = loadModule();
  let state = createBossState(chapterWords, {});
  state = applyAnswer(state, { lemma: 'w0', isCorrect: false });
  assert.equal(nextBossWords(state, chapterWords, 1)[0].lemma, 'w0');
  state = applyAnswer(state, { lemma: 'w0', isCorrect: true });
  assert.notEqual(nextBossWords(state, chapterWords, 1)[0].lemma, 'w0');
});

test('serving tops up by wrapping around when unasked words run out', () => {
  const { createBossState, applyAnswer, nextBossWords } = loadModule();
  let state = createBossState(chapterWords, {});
  for (let i = 0; i < 29; i += 1) {
    state = applyAnswer(state, { lemma: 'w' + i, isCorrect: true });
  }
  const served = nextBossWords(state, chapterWords, 3);
  assert.equal(served.length, 3);
  assert.equal(served[0].lemma, 'w29');
});
