const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDurationSeconds,
  buildAssessmentResponse,
} = require('../routes/pronunciation');
const {
  savePronunciationAssessmentWithDeps,
} = require('../data-store/queries/pronunciation');
const pronunciationCoachUI = require('../../frontend/js/practice/pronunciation-coach-ui');

const coaching = {
  version: 'coach-v1',
  evidence_level: 'transcript_alignment',
  headline: '先把 school 说清楚',
  summary: '系统没有稳定识别到 school。',
  strengths: ['bus 已经说清楚'],
  issues: [{ type: 'missing_word', target: 'school' }],
  next_action: { type: 'retry_focus', label: '重点重读 school', target_text: 'school bus' },
  disclaimer: '证据说明',
};

const fixtureAssessment = {
  text: 'School bus.',
  overall: 50,
  accuracy: 50,
  fluency: 45,
  completeness: 47,
  words: [
    { type: 'missing', word: 'school' },
    { type: 'correct', word: 'bus' },
  ],
  phonemes: [],
  provider: 'custom',
  coaching,
  analysis_version: 'coach-v1',
  duration_seconds: 1.8,
  speech_rate_wpm: 67,
};

test('duration validation accepts credible recordings and rejects unsafe values', () => {
  assert.equal(normalizeDurationSeconds(1.8), 1.8);
  assert.equal(normalizeDurationSeconds('2.25'), 2.25);
  assert.equal(normalizeDurationSeconds(0.1), null);
  assert.equal(normalizeDurationSeconds(121), null);
  assert.equal(normalizeDurationSeconds('not-a-number'), null);
  assert.equal(normalizeDurationSeconds(null), null);
});

test('assessment response keeps the stored row and appends coaching fields', () => {
  const stored = { id: 7, user_id: 3, accuracy: 50, words: fixtureAssessment.words };
  const response = buildAssessmentResponse(stored, fixtureAssessment);

  assert.equal(response.id, 7);
  assert.equal(response.user_id, 3);
  assert.equal(response.accuracy, 50);
  assert.deepEqual(response.coaching, coaching);
  assert.equal(response.analysis_version, 'coach-v1');
  assert.equal(response.duration_seconds, 1.8);
  assert.equal(response.speech_rate_wpm, 67);
});

test('assessment response falls back to the live assessment when persistence returns no row', () => {
  const response = buildAssessmentResponse(null, fixtureAssessment);

  assert.equal(response.accuracy, 50);
  assert.deepEqual(response.words, fixtureAssessment.words);
  assert.deepEqual(response.coaching, coaching);
  assert.equal(response.hypothesis, undefined);
});

test('pronunciation insert sends coaching metadata to the database boundary', async () => {
  const calls = [];
  const dependencies = {
    init: async () => {},
    dbUnavailable: () => false,
    pool: {
      query: async (text, values) => {
        calls.push({ text, values });
        return { rows: [{ id: 7, accuracy: 50, coaching }] };
      },
    },
  };

  const saved = await savePronunciationAssessmentWithDeps(
    dependencies,
    3,
    fixtureAssessment,
  );

  assert.equal(saved.id, 7);
  assert.equal(calls.length, 1);
  const normalizedSql = calls[0].text.replace(/\s+/g, ' ').trim();
  assert.match(normalizedSql, /coaching, analysis_version, duration_seconds, speech_rate_wpm/);
  assert.match(normalizedSql, /RETURNING \*/);
  assert.equal(calls[0].values[0], 3);
  assert.deepEqual(JSON.parse(calls[0].values[12]), coaching);
  assert.equal(calls[0].values[13], 'coach-v1');
  assert.equal(calls[0].values[14], 1.8);
  assert.equal(calls[0].values[15], 67);
});

test('database-unavailable boundary returns null without issuing an insert', async () => {
  let queryCalled = false;
  const saved = await savePronunciationAssessmentWithDeps({
    init: async () => {},
    dbUnavailable: () => true,
    pool: { query: async () => { queryCalled = true; } },
  }, 3, fixtureAssessment);

  assert.equal(saved, null);
  assert.equal(queryCalled, false);
});

test('shared renderer escapes provider text and exposes evidence semantics', () => {
  const html = pronunciationCoachUI.buildMarkup({
    version: 'coach-v1',
    evidence_level: 'transcript_alignment',
    headline: '<img src=x onerror=alert(1)>',
    summary: '先改 <script>alert(1)</script>',
    strengths: ['bus <b>clear</b>'],
    issues: [{
      type: 'missing_word',
      target: 'school',
      title: '目标词 <svg onload=alert(1)>',
      reason: '<script>x</script>',
      drill: '重读 school bus',
    }],
    next_action: { type: 'retry_focus', label: '重点重读', target_text: 'school bus' },
    disclaimer: '证据说明',
  });

  assert.doesNotMatch(html, /<script|<img|<svg/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /AI 教练诊断/);
  assert.match(html, /基于词级对齐/);
  assert.match(html, /为什么/);
  assert.match(html, /怎么练/);
});

test('shared renderer labels provider phoneme evidence without changing the action contract', () => {
  const html = pronunciationCoachUI.buildMarkup({
    ...coaching,
    evidence_level: 'provider_phoneme',
    issues: [{
      type: 'phoneme',
      target: 'θ',
      title: '先稳定 /θ/',
      reason: '服务返回低分',
      drill: '先单独读，再回到原句',
    }],
  });

  assert.match(html, /音素证据/);
  assert.match(html, /先稳定 \/θ\//);
  assert.doesNotMatch(html, /onclick=/i);
});

test('shared renderer returns an empty string for absent or malformed coaching', () => {
  assert.equal(pronunciationCoachUI.buildMarkup(null), '');
  assert.equal(pronunciationCoachUI.buildMarkup({}), '');
  assert.equal(pronunciationCoachUI.buildMarkup({ headline: 'x', issues: 'bad' }), '');
});
