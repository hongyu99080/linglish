(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameSpelling = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const GAME_TYPE = 'spelling';
  const DISTRACTOR_COUNT = 2;
  const HINT_DELAY_MS = 10000;
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
  const SCORE_PERFECT = 100;
  const SCORE_HINT_PENALTY = 30;
  const SCORE_TIMEOUT = 10;

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

  function buildChallenge(word, options) {
    const settings = options || {};
    const rng = typeof settings.rng === 'function' ? settings.rng : Math.random;
    const distractorCount = Number.isFinite(Number(settings.distractorCount))
      ? Number(settings.distractorCount)
      : DISTRACTOR_COUNT;

    const lemma = String(word.lemma).toLowerCase();
    const letters = lemma.split('');
    for (let i = 0; i < distractorCount; i += 1) {
      letters.push(ALPHABET[Math.floor(rng() * ALPHABET.length)]);
    }

    const tiles = shuffle(letters, rng).map(function (letter, index) {
      return { id: 'tile-' + index, letter };
    });

    return { lemma, zh: word.zh, tiles, filled: [], hintsUsed: 0 };
  }

  function nextLetter(challenge) {
    return challenge.lemma[challenge.filled.length];
  }

  function placeTile(challenge, tileId) {
    const tile = challenge.tiles.find(function (candidate) { return candidate.id === tileId; });
    if (!tile || challenge.filled.includes(tileId)) return { challenge, accepted: false };
    if (tile.letter !== nextLetter(challenge)) return { challenge, accepted: false };
    return {
      challenge: { ...challenge, filled: challenge.filled.concat(tileId) },
      accepted: true,
    };
  }

  function revealHint(challenge) {
    const wanted = nextLetter(challenge);
    if (!wanted) return challenge;
    const tile = challenge.tiles.find(function (candidate) {
      return candidate.letter === wanted && !challenge.filled.includes(candidate.id);
    });
    if (!tile) return challenge;
    return {
      ...challenge,
      filled: challenge.filled.concat(tile.id),
      hintsUsed: challenge.hintsUsed + 1,
    };
  }

  function isComplete(challenge) {
    return challenge.filled.length === challenge.lemma.length;
  }

  function scoreChallenge(challenge, options) {
    const settings = options || {};
    if (settings.timedOut || !isComplete(challenge)) {
      return { score: SCORE_TIMEOUT, tier: 'timeout' };
    }
    if (challenge.hintsUsed === 0) {
      return { score: SCORE_PERFECT, tier: 'perfect' };
    }
    const score = Math.max(
      SCORE_TIMEOUT,
      SCORE_PERFECT - challenge.hintsUsed * SCORE_HINT_PENALTY
    );
    return { score, tier: 'hinted' };
  }

  return {
    buildChallenge,
    placeTile,
    revealHint,
    isComplete,
    scoreChallenge,
    GAME_TYPE,
    DISTRACTOR_COUNT,
    HINT_DELAY_MS,
  };
});
