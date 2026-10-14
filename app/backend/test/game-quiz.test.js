const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/games/quiz.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

const seeded = () => { let s = 11; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };
const pool = ['cat', 'dog', 'bird', 'fish', 'cow'].map((l) => ({ lemma: l, zh: l + '-中' }));

test('buildQuestion offers four options', () => {
  const { buildQuestion } = loadModule();
  const question = buildQuestion(pool[0], pool, { rng: seeded() });
  assert.equal(question.options.length, 4);
});

test('the correct translation is among the options at answerIndex', () => {
  const { buildQuestion } = loadModule();
  const question = buildQuestion(pool[0], pool, { rng: seeded() });
  assert.equal(question.options[question.answerIndex], 'cat-中');
});

test('buildQuestion never repeats an option', () => {
  const { buildQuestion } = loadModule();
  const question = buildQuestion(pool[0], pool, { rng: seeded() });
  assert.equal(new Set(question.options).size, 4);
});

test('buildQuestion prompts with the english word', () => {
  const { buildQuestion } = loadModule();
  assert.equal(buildQuestion(pool[0], pool, { rng: seeded() }).prompt, 'cat');
});

test('grading the right option yields quality good', () => {
  const { buildQuestion, gradeAnswer } = loadModule();
  const question = buildQuestion(pool[0], pool, { rng: seeded() });
  const result = gradeAnswer(question, question.answerIndex);
  assert.equal(result.isCorrect, true);
  assert.equal(result.quality, 'good');
});

test('grading a wrong option yields quality again', () => {
  const { buildQuestion, gradeAnswer } = loadModule();
  const question = buildQuestion(pool[0], pool, { rng: seeded() });
  const wrong = (question.answerIndex + 1) % question.options.length;
  const result = gradeAnswer(question, wrong);
  assert.equal(result.isCorrect, false);
  assert.equal(result.quality, 'again');
});

test('a timeout (no option chosen) grades as again', () => {
  const { buildQuestion, gradeAnswer } = loadModule();
  const question = buildQuestion(pool[0], pool, { rng: seeded() });
  assert.equal(gradeAnswer(question, -1).quality, 'again');
});

test('learners get at least six seconds to answer each quiz question', () => {
  const { TIME_PER_QUESTION_MS } = loadModule();
  assert.ok(
    TIME_PER_QUESTION_MS >= 6000,
    `expected at least 6000ms, received ${TIME_PER_QUESTION_MS}ms`,
  );
});
