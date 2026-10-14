(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameWordPool = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const NEW_WORDS_PER_LEVEL = 6;
  const REVIEW_WORDS_PER_LEVEL = 4;

  function normalizeReviewItem(item) {
    if (!item || typeof item !== 'object') return null;
    const lemma = item.lemma || item.word;
    if (typeof lemma !== 'string' || lemma.trim().length === 0) return null;
    return { ...item, lemma: lemma.trim(), state: item.state };
  }

  function buildLevelPool(options) {
    const settings = options || {};
    const newCount = Number.isFinite(Number(settings.newCount))
      ? Number(settings.newCount)
      : NEW_WORDS_PER_LEVEL;
    const reviewCount = Number.isFinite(Number(settings.reviewCount))
      ? Number(settings.reviewCount)
      : REVIEW_WORDS_PER_LEVEL;

    const relearn = Array.isArray(settings.relearnQueue) ? settings.relearnQueue : [];
    const review = Array.isArray(settings.reviewWords) ? settings.reviewWords : [];
    const fresh = Array.isArray(settings.newWords) ? settings.newWords : [];

    const seen = new Set();
    const reviewWords = [];
    for (const candidate of relearn.concat(review)) {
      if (reviewWords.length >= reviewCount) break;
      if (!candidate || seen.has(candidate.lemma)) continue;
      seen.add(candidate.lemma);
      reviewWords.push(candidate);
    }

    return { newWords: fresh.slice(0, newCount), reviewWords };
  }

  return { buildLevelPool, normalizeReviewItem, NEW_WORDS_PER_LEVEL, REVIEW_WORDS_PER_LEVEL };
});
