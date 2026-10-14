(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameQuiz = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const GAME_TYPE = 'quiz';
  const OPTION_COUNT = 4;
  const TIME_PER_QUESTION_MS = 6000;

  function shuffle(items, rng) {
    const next = items.slice();
    for (let i = next.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const swap = next[i];
      next[i] = next[j];
      next[j] = swap;
    }
    return next;
  }

  function buildQuestion(word, allWords, options) {
    const settings = options || {};
    const rng = typeof settings.rng === 'function' ? settings.rng : Math.random;
    const optionCount = Number(settings.optionCount) || OPTION_COUNT;

    const distractors = shuffle(
      allWords.filter(function (candidate) { return candidate.lemma !== word.lemma; }),
      rng
    ).slice(0, optionCount - 1).map(function (candidate) { return candidate.zh; });

    const choices = shuffle(distractors.concat(word.zh), rng);

    return {
      lemma: word.lemma,
      prompt: word.lemma,
      options: choices,
      answerIndex: choices.indexOf(word.zh),
    };
  }

  function gradeAnswer(question, chosenIndex) {
    const isCorrect = Number(chosenIndex) === question.answerIndex;
    return { isCorrect, quality: isCorrect ? 'good' : 'again' };
  }

  return { buildQuestion, gradeAnswer, GAME_TYPE, OPTION_COUNT, TIME_PER_QUESTION_MS };
});
