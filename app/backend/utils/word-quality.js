function analyzeWordQuality(input) {
  const original = (input ?? '').toString();
  const word = original.trim();
  const lower = word.toLowerCase();

  const reasons = [];
  if (!word) reasons.push('empty');
  if (word.length > 45) reasons.push('too_long');

  // Allow letters + apostrophe + hyphen only (no spaces, digits, underscores, emoji, etc.)
  if (word && !/^[A-Za-z'-]+$/.test(word)) reasons.push('invalid_chars');
  if (/[0-9]/.test(word)) reasons.push('has_digits');

  // Single-letter words are usually noise (keep "a" and "i")
  if (word.length === 1 && !['a', 'i'].includes(lower)) reasons.push('single_letter');

  // Excessive repeated characters like "aaahhhhh"
  if (/([a-z])\1\1\1/.test(lower)) reasons.push('repeated_chars');

  // No vowel words (likely noise) when long enough
  if (word.length >= 7 && !/[aeiouy]/.test(lower)) reasons.push('no_vowels');

  return {
    word,
    lower,
    reasons,
    ok: reasons.length === 0,
  };
}

function isLowQualityWord(input) {
  const a = analyzeWordQuality(input);
  return !a.ok;
}

module.exports = {
  analyzeWordQuality,
  isLowQualityWord,
};

