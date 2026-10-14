const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveSkillObservations,
  computeNextSkillState,
  buildPronunciationProfile,
} = require('../services/pronunciation-skill-model');

const now = new Date('2026-08-21T00:00:00.000Z');
const issueObservation = {
  skill_type: 'missing_word', target_key: 'school', display_target: 'school',
  evidence_level: 'transcript_alignment', outcome: 'issue', observed_score: 20,
  sample_text: 'School bus', assessment_id: 10, video_resource_id: 3,
};
const successObservation = { ...issueObservation, outcome: 'success', observed_score: 100, assessment_id: 11 };

test('recording signal never creates a language skill', () => {
  const items = deriveSkillObservations({
    id: 1,
    coaching: { evidence_level: 'recording_signal', issues: [{ type: 'recording_signal' }] },
  });
  assert.deepEqual(items, []);
});

test('missing word creates transcript-grounded issue while fake phoneme is ignored', () => {
  const items = deriveSkillObservations({
    id: 2,
    text: 'School bus',
    video_resource_id: 8,
    coaching: {
      evidence_level: 'transcript_alignment',
      issues: [
        { type: 'missing_word', target: 'School', evidence: 'transcript_alignment' },
        { type: 'phoneme', target: 'θ', evidence: 'transcript_alignment' },
      ],
    },
  });
  assert.deepEqual(items.map(({ skill_type, target_key, outcome }) => ({ skill_type, target_key, outcome })), [
    { skill_type: 'missing_word', target_key: 'school', outcome: 'issue' },
  ]);
});

test('provider phoneme issue is retained only with explicit provider evidence', () => {
  const items = deriveSkillObservations({
    id: 3,
    text: 'Think clearly',
    coaching: {
      evidence_level: 'provider_phoneme',
      issues: [{ type: 'phoneme', target: 'θ', evidence: 'provider_phoneme' }],
    },
  });

  assert.deepEqual(items.map(({ skill_type, target_key, evidence_level, outcome }) => ({
    skill_type, target_key, evidence_level, outcome,
  })), [{
    skill_type: 'phoneme', target_key: 'θ', evidence_level: 'provider_phoneme', outcome: 'issue',
  }]);
});

test('correct word resolves an active missing word', () => {
  const items = deriveSkillObservations({
    id: 4,
    text: 'School bus',
    words: [{ type: 'correct', word: 'School' }],
    coaching: { evidence_level: 'transcript_alignment', issues: [] },
  }, [{ skill_type: 'missing_word', target_key: 'school' }]);

  assert.deepEqual(items.map(({ skill_type, target_key, outcome }) => ({ skill_type, target_key, outcome })), [
    { skill_type: 'missing_word', target_key: 'school', outcome: 'success' },
  ]);
});

test('valid pace resolves active pace while absent phoneme data never resolves phoneme', () => {
  const items = deriveSkillObservations({
    id: 5,
    text: 'One two three four',
    speech_rate_wpm: 120,
    coaching: { evidence_level: 'transcript_alignment', issues: [] },
  }, [
    { skill_type: 'pace', target_key: 'pace' },
    { skill_type: 'phoneme', target_key: 'θ' },
  ]);

  assert.deepEqual(items.map(({ skill_type, target_key, outcome }) => ({ skill_type, target_key, outcome })), [
    { skill_type: 'pace', target_key: 'pace', outcome: 'success' },
  ]);
});

test('untrusted targets and text are normalized, bounded, and stripped of controls', () => {
  const target = `  SCHOOL${'x'.repeat(120)}!!!\u0000  `;
  const sample = `Sentence\u0007 ${'y'.repeat(300)}`;
  const [item] = deriveSkillObservations({
    id: 6,
    text: sample,
    coaching: {
      evidence_level: 'transcript_alignment',
      issues: [{ type: 'missing_word', target, evidence: 'transcript_alignment' }],
    },
  });

  assert.equal(item.target_key, `school${'x'.repeat(74)}`);
  assert.equal(item.target_key.length, 80);
  assert.equal(item.display_target.length, 80);
  assert.equal(item.sample_text.length, 240);
  assert.doesNotMatch(item.display_target, /[\u0000-\u001f\u007f]/);
  assert.doesNotMatch(item.sample_text, /[\u0000-\u001f\u007f]/);
});

test('three successes with a sub-80 EMA remain improving while extending review', () => {
  const issue = computeNextSkillState(null, issueObservation, now);
  const one = computeNextSkillState(issue, successObservation, now);
  const two = computeNextSkillState(one, successObservation, now);
  const three = computeNextSkillState(two, successObservation, now);
  assert.equal(three.success_streak, 3);
  assert.equal(three.ema_score, 72.56);
  assert.equal(three.status, 'improving');
  assert.equal(three.next_review_at, '2026-08-29T00:00:00.000Z');
});

test('a three-success streak becomes stable only when its EMA is at least 80', () => {
  const prior = {
    ...computeNextSkillState(null, successObservation, now),
    ema_score: 80,
    success_streak: 2,
  };
  const state = computeNextSkillState(prior, successObservation, now);

  assert.equal(state.success_streak, 3);
  assert.equal(state.ema_score, 86);
  assert.equal(state.status, 'stable');
});

test('a new issue resets streak, schedules one day, and uses the 0.7/0.3 EMA', () => {
  const prior = {
    ...computeNextSkillState(null, successObservation, now),
    ema_score: 80,
    success_streak: 2,
  };
  const state = computeNextSkillState(prior, issueObservation, now);

  assert.equal(state.success_streak, 0);
  assert.equal(state.ema_score, 62);
  assert.equal(state.next_review_at, '2026-08-22T00:00:00.000Z');
  assert.equal(state.status, 'focus');
});

test('a stable skill recurrence preserves its full ledger history and original creation time', () => {
  const previous = {
    ...computeNextSkillState(null, successObservation, now),
    attempt_count: 12,
    issue_count: 4,
    success_count: 8,
    success_streak: 4,
    ema_score: 88,
    status: 'stable',
    created_at: '2026-07-01T00:00:00.000Z',
  };
  const state = computeNextSkillState(previous, issueObservation, new Date('2026-08-22T00:00:00.000Z'));

  assert.equal(state.attempt_count, 13);
  assert.equal(state.issue_count, 5);
  assert.equal(state.success_count, 8);
  assert.equal(state.success_streak, 0);
  assert.equal(state.status, 'focus');
  assert.equal(state.created_at, '2026-07-01T00:00:00.000Z');
});

test('an observation without video keeps the previous assessment context instead of mixing it with null video', () => {
  const previous = {
    ...computeNextSkillState(null, issueObservation, now),
    last_assessment_id: '9007199254740993',
    video_resource_id: '9223372036854775807',
    sample_text: 'The school bus is here',
  };
  const state = computeNextSkillState(previous, {
    ...successObservation,
    assessment_id: '9007199254740994',
    video_resource_id: null,
    sample_text: 'School bus',
  }, new Date('2026-08-22T00:00:00.000Z'));

  assert.equal(state.last_assessment_id, '9007199254740993');
  assert.equal(state.video_resource_id, '9223372036854775807');
  assert.equal(state.sample_text, 'The school bus is here');
});

test('transition display fields are normalized again at the persistence boundary', () => {
  const state = computeNextSkillState(null, {
    ...issueObservation,
    display_target: `school\u0000 ${'x'.repeat(100)}`,
    sample_text: `sentence\u0007 ${'y'.repeat(300)}`,
  }, now);

  assert.equal(state.display_target.length, 80);
  assert.equal(state.sample_text.length, 240);
  assert.doesNotMatch(state.display_target, /[\u0000-\u001f\u007f]/);
  assert.doesNotMatch(state.sample_text, /[\u0000-\u001f\u007f]/);
});

test('confidence uses evidence weight and never exceeds one', () => {
  let state = null;
  for (let index = 0; index < 8; index += 1) {
    state = computeNextSkillState(state, issueObservation, now);
  }

  assert.equal(state.confidence, 0.9);
  assert.ok(state.confidence <= 1);
});

test('null or empty pace never creates or resolves a pace skill', () => {
  const issue = deriveSkillObservations({
    id: 7,
    speech_rate_wpm: null,
    coaching: { evidence_level: 'recording_signal', issues: [{ type: 'pace' }] },
  });
  const success = deriveSkillObservations({
    id: 8,
    speech_rate_wpm: '',
    coaching: { evidence_level: 'transcript_alignment', issues: [] },
  }, [{ skill_type: 'pace', target_key: 'pace' }]);

  assert.deepEqual(issue, []);
  assert.deepEqual(success, []);
});

test('one or two credible assessments keep the profile collecting with null scores', () => {
  const profile = buildPronunciationProfile({
    assessments: [
      { id: 1, accuracy: 90, completeness: 80, coaching: { evidence_level: 'transcript_alignment' } },
      { id: 2, accuracy: 70, completeness: 60, coaching: { evidence_level: 'transcript_alignment' } },
    ],
    skills: [],
    now,
  });

  assert.equal(profile.status, 'collecting');
  assert.equal(profile.sample_count, 2);
  assert.ok(profile.dimensions.every((dimension) => dimension.score === null));
  assert.equal(profile.trend.direction, 'collecting');
});

test('three assessments produce hand-computed recency-weighted clarity and completeness', () => {
  const profile = buildPronunciationProfile({
    assessments: [
      { id: 3, accuracy: 100, completeness: 90, coaching: { evidence_level: 'transcript_alignment' } },
      { id: 2, accuracy: 80, completeness: 70, coaching: { evidence_level: 'transcript_alignment' } },
      { id: 1, accuracy: 60, completeness: 50, coaching: { evidence_level: 'transcript_alignment' } },
    ],
    skills: [],
    now,
  });
  const byKey = Object.fromEntries(profile.dimensions.map((dimension) => [dimension.key, dimension]));

  assert.equal(profile.status, 'ready');
  assert.equal(byKey.clarity.score, 83);
  assert.equal(byKey.completeness.score, 73);
  assert.equal(byKey.phoneme.score, null);
  assert.equal(profile.trend.direction, 'collecting');
});

test('null or empty pace stays unavailable in a ready profile', () => {
  const profile = buildPronunciationProfile({
    assessments: [
      { accuracy: 100, completeness: 90, speech_rate_wpm: null, coaching: { evidence_level: 'transcript_alignment' } },
      { accuracy: 80, completeness: 70, speech_rate_wpm: '', coaching: { evidence_level: 'transcript_alignment' } },
      { accuracy: 60, completeness: 50, coaching: { evidence_level: 'transcript_alignment' } },
    ],
    skills: [],
    now,
  });
  const pace = profile.dimensions.find((dimension) => dimension.key === 'pace');

  assert.equal(profile.status, 'ready');
  assert.equal(pace.score, null);
  assert.equal(pace.confidence, 0);
});

test('profile prioritizes due high-problem items, limits focus, and limits types', () => {
  const profile = buildPronunciationProfile({
    assessments: [
      { id: 3, accuracy: 90, completeness: 90, coaching: { evidence_level: 'transcript_alignment' } },
      { id: 2, accuracy: 80, completeness: 80, coaching: { evidence_level: 'transcript_alignment' } },
      { id: 1, accuracy: 70, completeness: 70, coaching: { evidence_level: 'transcript_alignment' } },
    ],
    skills: [
      { skill_type: 'missing_word', target_key: 'school', display_target: 'school', status: 'focus', issue_count: 4, attempt_count: 4, confidence: 0.9, next_review_at: '2026-08-20T00:00:00.000Z' },
      { skill_type: 'missing_word', target_key: 'bus', display_target: 'bus', status: 'focus', issue_count: 3, attempt_count: 4, confidence: 0.9, next_review_at: '2026-08-20T00:00:00.000Z' },
      { skill_type: 'missing_word', target_key: 'stop', display_target: 'stop', status: 'focus', issue_count: 9, attempt_count: 9, confidence: 1, next_review_at: '2026-08-20T00:00:00.000Z' },
      { skill_type: 'pace', target_key: 'pace', display_target: '短语节奏', status: 'focus', issue_count: 2, attempt_count: 2, confidence: 0.75, next_review_at: '2026-08-20T00:00:00.000Z' },
      { skill_type: 'phoneme', target_key: 'θ', display_target: 'θ', status: 'stable', issue_count: 1, attempt_count: 5, confidence: 1, next_review_at: '2026-08-30T00:00:00.000Z' },
    ],
    now,
  });

  assert.deepEqual(profile.focus_items.map((item) => item.target_key), ['stop', 'school', 'pace']);
  assert.ok(profile.focus_items.length <= 3);
  assert.ok(profile.focus_items.filter((item) => item.skill_type === 'missing_word').length <= 2);
});

test('trend compares two qualified windows only', () => {
  const profile = buildPronunciationProfile({
    assessments: [
      { accuracy: 90, completeness: 90, coaching: { evidence_level: 'transcript_alignment' } },
      { accuracy: 80, completeness: 80, coaching: { evidence_level: 'transcript_alignment' } },
      { accuracy: 50, completeness: 50, coaching: { evidence_level: 'transcript_alignment' } },
      { accuracy: 40, completeness: 40, coaching: { evidence_level: 'transcript_alignment' } },
    ],
    skills: [],
    now,
  });

  assert.deepEqual(profile.trend, { direction: 'up', delta: 40 });
});
