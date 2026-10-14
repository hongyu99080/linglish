const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/mastery.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

test('a word answered correctly in only one game type is not mastered', () => {
  const { isWordMastered } = loadModule();
  assert.equal(isWordMastered({ correctIn: ['lianliankan'], wrongCount: 0 }), false);
});

test('a word answered correctly in two different game types is mastered', () => {
  const { isWordMastered } = loadModule();
  assert.equal(isWordMastered({ correctIn: ['lianliankan', 'spelling'], wrongCount: 1 }), true);
});

test('isWordMastered handles a missing word state', () => {
  const { isWordMastered } = loadModule();
  assert.equal(isWordMastered(undefined), false);
});

test('countMastered counts only words meeting the two-game-type rule', () => {
  const { countMastered } = loadModule();
  const states = {
    apple: { correctIn: ['quiz', 'spelling'], wrongCount: 0 },
    banana: { correctIn: ['quiz'], wrongCount: 2 },
    cat: { correctIn: ['quiz', 'lianliankan', 'spelling'], wrongCount: 0 },
  };
  assert.equal(countMastered(states), 2);
});

test('canPassChapter requires at least 90 percent boss accuracy', () => {
  const { canPassChapter } = loadModule();
  assert.equal(canPassChapter(0.9), true);
  assert.equal(canPassChapter(0.89), false);
  assert.equal(canPassChapter(1), true);
});

test('a wrong answer schedules the word to return within three levels', () => {
  const { updateRelearnQueue, RELEARN_WITHIN_LEVELS } = loadModule();
  const queue = updateRelearnQueue([], { lemma: 'apple', isCorrect: false, currentLevel: 5 });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].lemma, 'apple');
  assert.ok(queue[0].dueLevel <= 5 + RELEARN_WITHIN_LEVELS);
  assert.ok(queue[0].dueLevel > 5);
});

test('a correct answer removes the word from the relearn queue', () => {
  const { updateRelearnQueue } = loadModule();
  const withWord = updateRelearnQueue([], { lemma: 'apple', isCorrect: false, currentLevel: 1 });
  const cleared = updateRelearnQueue(withWord, { lemma: 'apple', isCorrect: true, currentLevel: 2 });
  assert.deepEqual(cleared, []);
});

test('updateRelearnQueue does not mutate the queue it is given', () => {
  const { updateRelearnQueue } = loadModule();
  const original = [];
  updateRelearnQueue(original, { lemma: 'apple', isCorrect: false, currentLevel: 1 });
  assert.equal(original.length, 0);
});

test('dueRelearnWords returns words whose due level has arrived', () => {
  const { dueRelearnWords } = loadModule();
  const queue = [
    { lemma: 'soon', dueLevel: 3 },
    { lemma: 'later', dueLevel: 9 },
  ];
  assert.deepEqual(dueRelearnWords(queue, 4), ['soon']);
});

test('dueRelearnWords returns the longest-overdue words first', () => {
  const { dueRelearnWords } = loadModule();
  const queue = [
    { lemma: 'recent', dueLevel: 7 },
    { lemma: 'stale', dueLevel: 2 },
    { lemma: 'middle', dueLevel: 4 },
  ];
  assert.deepEqual(dueRelearnWords(queue, 8), ['stale', 'middle', 'recent']);
});

test('dueRelearnWords does not mutate the queue it is given', () => {
  const { dueRelearnWords } = loadModule();
  const queue = [{ lemma: 'b', dueLevel: 5 }, { lemma: 'a', dueLevel: 1 }];
  dueRelearnWords(queue, 9);
  assert.equal(queue[0].lemma, 'b');
});
