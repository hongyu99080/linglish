const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCoaching,
  computeSpeechRateWpm,
} = require('../services/pronunciation-coach');

test('missing target word creates one transcript-grounded retry drill', () => {
  const coaching = buildCoaching({
    referenceText: 'School bus.',
    hypothesis: 'bus',
    accuracy: 50,
    words: [
      { type: 'missing', word: 'school' },
      { type: 'correct', word: 'bus' },
    ],
  });

  assert.equal(coaching.version, 'coach-v1');
  assert.equal(coaching.evidence_level, 'transcript_alignment');
  assert.equal(coaching.issues[0].type, 'missing_word');
  assert.equal(coaching.issues[0].target, 'school');
  assert.match(coaching.next_action.target_text, /school bus/i);
  assert.deepEqual(coaching.strengths, ['bus 已经说清楚']);
  assert.doesNotMatch(JSON.stringify(coaching), /舌位|唇形|音素错误/);
});

test('empty recognition creates a recording-signal action instead of a zero-score judgement', () => {
  const coaching = buildCoaching({
    referenceText: 'Good morning.',
    hypothesis: '',
    accuracy: 0,
    words: [],
  });

  assert.equal(coaching.evidence_level, 'recording_signal');
  assert.equal(coaching.issues[0].type, 'recording_signal');
  assert.equal(coaching.next_action.type, 'retry_recording');
  assert.doesNotMatch(coaching.headline, /0\s*分|很差|失败/);
});

test('provider phoneme evidence is required for a phoneme issue', () => {
  const coaching = buildCoaching({
    referenceText: 'think',
    hypothesis: 'think',
    accuracy: 75,
    words: [{ type: 'correct', word: 'think' }],
    phonemes: [{ symbol: 'θ', accuracy: 42, error: true }],
  });

  assert.equal(coaching.evidence_level, 'provider_phoneme');
  assert.equal(coaching.issues[0].type, 'phoneme');
  assert.equal(coaching.issues[0].target, 'θ');
  assert.match(coaching.issues[0].reason, /42%/);
});

test('phoneme-looking data without an explicit error stays transcript-grounded', () => {
  const coaching = buildCoaching({
    referenceText: 'think',
    hypothesis: 'think',
    accuracy: 96,
    words: [{ type: 'correct', word: 'think' }],
    phonemes: [{ symbol: 'θ', accuracy: 91 }],
  });

  assert.equal(coaching.evidence_level, 'transcript_alignment');
  assert.equal(coaching.issues.some((issue) => issue.type === 'phoneme'), false);
});

test('a clear match reinforces the result and continues without inventing issues', () => {
  const coaching = buildCoaching({
    referenceText: 'English singsing.',
    hypothesis: 'English singsing.',
    accuracy: 100,
    words: [
      { type: 'correct', word: 'english' },
      { type: 'correct', word: 'singsing' },
    ],
  });

  assert.equal(coaching.issues.length, 0);
  assert.equal(coaching.next_action.type, 'continue');
  assert.match(coaching.headline, /说清楚|清晰/);
  assert.equal(coaching.strengths.length, 1);
});

test('speech rate is emitted only for a credible sentence duration', () => {
  assert.equal(computeSpeechRateWpm('One two three four five.', 3), 100);
  assert.equal(computeSpeechRateWpm('One two three.', 3), null);
  assert.equal(computeSpeechRateWpm('One two three four.', 0.1), null);

  const coaching = buildCoaching({
    referenceText: 'One two three four five.',
    hypothesis: 'One two three four five.',
    accuracy: 95,
    durationSeconds: 8,
    words: [
      { type: 'correct', word: 'one' },
      { type: 'correct', word: 'two' },
      { type: 'correct', word: 'three' },
      { type: 'correct', word: 'four' },
      { type: 'correct', word: 'five' },
    ],
  });

  assert.equal(coaching.speech_rate_wpm, 38);
  assert.equal(coaching.issues[0].type, 'pace');
  assert.equal(coaching.next_action.type, 'retry_pace');
});

test('coaching bounds untrusted provider content and output density', () => {
  const hugeWord = `word${'x'.repeat(300)}`;
  const coaching = buildCoaching({
    referenceText: `${hugeWord} alpha beta gamma delta`,
    hypothesis: 'delta',
    accuracy: -30,
    words: [
      { type: 'missing', word: hugeWord },
      { type: 'missing', word: 'alpha' },
      { type: 'missing', word: 'beta' },
      { type: 'missing', word: 'gamma' },
      { type: 'correct', word: 'delta' },
    ],
  });

  assert.ok(coaching.issues.length <= 3);
  assert.ok(coaching.strengths.length <= 2);
  assert.ok(coaching.issues.every((issue) => issue.target.length <= 80));
  assert.equal(coaching.accuracy, 0);
});
