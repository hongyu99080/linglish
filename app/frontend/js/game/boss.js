(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameBoss = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const DEFAULT_SHIELDS = 3;

  function createBossState(chapterWords, options) {
    const settings = options || {};
    const maxHp = chapterWords.length;
    return {
      maxHp,
      hp: maxHp,
      shields: Number.isFinite(Number(settings.shields)) ? Number(settings.shields) : DEFAULT_SHIELDS,
      asked: [],
      wrongLemmas: [],
    };
  }

  function applyAnswer(state, result) {
    const asked = state.asked.concat({ lemma: result.lemma, isCorrect: result.isCorrect });
    if (result.isCorrect) {
      // 答对的词从重问名单划掉:不清的话,count=1 时同一个错过的词会永远排在队首。
      return {
        ...state,
        hp: Math.max(0, state.hp - 1),
        asked,
        wrongLemmas: state.wrongLemmas.filter(function (lemma) { return lemma !== result.lemma; }),
      };
    }
    return {
      ...state,
      shields: Math.max(0, state.shields - 1),
      asked,
      wrongLemmas: state.wrongLemmas.includes(result.lemma)
        ? state.wrongLemmas.slice()
        : state.wrongLemmas.concat(result.lemma),
    };
  }

  function bossOutcome(state) {
    const total = state.asked.length;
    const correct = state.asked.filter(function (entry) { return entry.isCorrect; }).length;
    const accuracy = total === 0 ? 0 : correct / total;
    if (state.hp === 0) return { status: 'won', accuracy };
    if (state.shields === 0) return { status: 'lost', accuracy };
    return { status: 'ongoing', accuracy };
  }

  function nextBossWords(state, chapterWords, count) {
    const byLemma = new Map(chapterWords.map(function (word) { return [word.lemma, word]; }));
    const askedLemmas = new Set(state.asked.map(function (entry) { return entry.lemma; }));
    const served = [];
    const used = new Set();

    function serve(word) {
      if (!word || served.length >= count || used.has(word.lemma)) return;
      served.push(word);
      used.add(word.lemma);
    }

    // ① 待重问的错词优先。
    state.wrongLemmas.forEach(function (lemma) { serve(byLemma.get(lemma)); });
    // ② 然后是没问过的词——不排除 asked 的话,count=1 时每轮都发第一个词,
    //    30 刀全砍在 school 上,§5.2 的 90% 掌握门就退化成单词门。
    chapterWords.forEach(function (word) {
      if (!askedLemmas.has(word.lemma)) serve(word);
    });
    // ③ 没问过的词不够凑数时(答错不掉血,轮次可超词数):从头轮询补足,保证打得完。
    chapterWords.forEach(function (word) { serve(word); });

    return served;
  }

  return { createBossState, applyAnswer, bossOutcome, nextBossWords, DEFAULT_SHIELDS };
});
