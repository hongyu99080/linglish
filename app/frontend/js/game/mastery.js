(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameMastery = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const MASTERY_GAME_TYPES_REQUIRED = 2;
  const CHAPTER_PASS_ACCURACY = 0.9;
  const RELEARN_WITHIN_LEVELS = 3;

  function isWordMastered(wordState) {
    if (!wordState || !Array.isArray(wordState.correctIn)) return false;
    const distinct = new Set(wordState.correctIn);
    return distinct.size >= MASTERY_GAME_TYPES_REQUIRED;
  }

  function countMastered(wordStates) {
    if (!wordStates || typeof wordStates !== 'object') return 0;
    return Object.keys(wordStates).filter((lemma) => isWordMastered(wordStates[lemma])).length;
  }

  function canPassChapter(bossAccuracy) {
    return Number(bossAccuracy) >= CHAPTER_PASS_ACCURACY;
  }

  function updateRelearnQueue(queue, result) {
    const current = Array.isArray(queue) ? queue : [];
    const without = current.filter((entry) => entry.lemma !== result.lemma);
    if (result.isCorrect) return without;
    return without.concat({
      lemma: result.lemma,
      dueLevel: Number(result.currentLevel) + 1,
    });
  }

  // 回炉词位有限(每关 4 个复习位),按 dueLevel 升序返回,
  // 保证欠得最久的词先占位,不会被后来的错词无限挤掉。
  function dueRelearnWords(queue, currentLevel) {
    const current = Array.isArray(queue) ? queue : [];
    return current
      .filter((entry) => Number(entry.dueLevel) <= Number(currentLevel))
      .slice()
      .sort((a, b) => Number(a.dueLevel) - Number(b.dueLevel))
      .map((entry) => entry.lemma);
  }

  return {
    isWordMastered,
    countMastered,
    canPassChapter,
    updateRelearnQueue,
    dueRelearnWords,
    MASTERY_GAME_TYPES_REQUIRED,
    CHAPTER_PASS_ACCURACY,
    RELEARN_WITHIN_LEVELS,
  };
});
