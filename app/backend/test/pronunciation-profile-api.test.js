const test = require('node:test');
const assert = require('node:assert/strict');
const { types: pgTypes } = require('pg');

const {
  updateProfileAfterAssessment,
  loadPronunciationProfile,
} = require('../services/pronunciation-profile');
const {
  normalizeProfileLimit,
  buildAssessmentApiResponse,
  buildAssessmentFocusResponse,
  registerPronunciationRoutes,
} = require('../routes/pronunciation');

const now = new Date('2026-08-21T00:00:00.000Z');
const parsePgInt8 = pgTypes.getTypeParser(20);

function assessment({ id, text = 'School bus', videoId = 8, words = [], issues = [], evidence = 'transcript_alignment' }) {
  return {
    id,
    video_resource_id: videoId,
    text,
    accuracy: 80,
    completeness: 80,
    words,
    phonemes: [],
    coaching: {
      evidence_level: evidence,
      issues,
    },
  };
}

function createInMemoryStore({ assessments = [], skills = [], failUpsertAt = null } = {}) {
  const state = {
    assessments: [...assessments],
    skills: skills.map((skill) => ({ ...skill })),
    listAssessmentOptions: [],
    listSkillOptions: [],
    upserts: [],
    transactions: 0,
  };

  let transactionTail = Promise.resolve();

  function listSkills(source, options = {}) {
    return source
      .filter((skill) => options.includeStable || skill.status !== 'stable')
      .slice(0, options.limit)
      .map((skill) => ({ ...skill }));
  }

  function writeSkill(target, nextState) {
    const index = target.findIndex((skill) => skill.skill_type === nextState.skill_type
      && skill.target_key === nextState.target_key);
    if (index >= 0) target[index] = { ...nextState };
    else target.push({ ...nextState });
  }

  const store = {
    state,
    async listPronunciationAssessments(_userId, options = {}) {
      state.listAssessmentOptions.push({ ...options });
      return state.assessments.slice(0, options.limit);
    },
    async listPronunciationSkills(_userId, options = {}) {
      state.listSkillOptions.push({ ...options });
      return listSkills(state.skills, options);
    },
    async upsertPronunciationSkill(_userId, nextState) {
      state.upserts.push({ ...nextState });
      if (failUpsertAt && state.upserts.length === failUpsertAt) throw new Error('forced upsert failure');
      writeSkill(state.skills, nextState);
      return { ...nextState };
    },
    withPronunciationSkillTransaction(_userId, work) {
      const run = transactionTail.then(async () => {
        state.transactions += 1;
        const transactionSkills = state.skills.map((skill) => ({ ...skill }));
        let transactionUpserts = 0;
        const tx = {
          async listPronunciationSkillsForUpdate() {
            return transactionSkills.map((skill) => ({ ...skill }));
          },
          async upsertPronunciationSkill(_innerUserId, nextState) {
            transactionUpserts += 1;
            state.upserts.push({ ...nextState });
            if (failUpsertAt && transactionUpserts === failUpsertAt) throw new Error('forced upsert failure');
            writeSkill(transactionSkills, nextState);
            return { ...nextState };
          },
        };
        const result = await work(tx);
        state.skills = transactionSkills;
        return result;
      });
      transactionTail = run.catch(() => {});
      return run;
    },
  };
  return store;
}

test('update persists each observed state and returns an anonymous focus summary', async () => {
  const saved = assessment({ id: 10, issues: [{ type: 'missing_word', target: 'school', evidence: 'transcript_alignment' }] });
  const store = createInMemoryStore({ assessments: [saved] });

  const update = await updateProfileAfterAssessment(store, 42, saved, { ...saved, id: undefined }, now);

  assert.deepEqual(update, {
    improved: [],
    needs_focus: [{ type: 'missing_word', evidence: 'transcript_alignment', status: 'focus', display_target: 'school' }],
    sample_count: 1,
  });
  assert.equal(store.state.upserts.length, 1);
  assert.equal(store.state.upserts[0].last_assessment_id, 10);
  assert.equal(store.state.transactions, 1);
  assert.ok(!Object.hasOwn(update.needs_focus[0], 'target_key'));
  assert.ok(!Object.hasOwn(update.needs_focus[0], 'sample_text'));
});

test('a later correct word changes an existing missing-word skill to improving', async () => {
  const first = assessment({ id: 10, issues: [{ type: 'missing_word', target: 'school', evidence: 'transcript_alignment' }] });
  const store = createInMemoryStore({ assessments: [first] });
  await updateProfileAfterAssessment(store, 42, first, { ...first, id: undefined }, now);

  const second = assessment({ id: 11, words: [{ type: 'correct', word: 'school' }] });
  store.state.assessments.unshift(second);
  const update = await updateProfileAfterAssessment(store, 42, second, { ...second, id: undefined }, now);

  assert.deepEqual(update, {
    improved: [{ type: 'missing_word', evidence: 'transcript_alignment', status: 'improving', display_target: 'school' }],
    needs_focus: [],
    sample_count: 2,
  });
  assert.equal(store.state.skills[0].status, 'improving');
  assert.equal(store.state.skills[0].success_count, 1);
});

test('a stable skill can regress without losing attempts, issues, successes, or created_at', async () => {
  const stable = {
    skill_type: 'missing_word',
    target_key: 'school',
    display_target: 'school',
    evidence_level: 'transcript_alignment',
    attempt_count: 12,
    issue_count: 4,
    success_count: 8,
    success_streak: 4,
    ema_score: 88,
    confidence: 0.9,
    status: 'stable',
    next_review_at: '2026-09-01T00:00:00.000Z',
    last_assessment_id: '9007199254740992',
    video_resource_id: '8',
    sample_text: 'School bus',
    last_issue_at: '2026-07-01T00:00:00.000Z',
    last_success_at: '2026-08-20T00:00:00.000Z',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
  };
  const recurrence = assessment({
    id: '9007199254740993',
    issues: [{ type: 'missing_word', target: 'school', evidence: 'transcript_alignment' }],
  });
  const store = createInMemoryStore({ assessments: [recurrence], skills: [stable] });

  await updateProfileAfterAssessment(store, '42', recurrence, recurrence, now);

  assert.equal(store.state.skills[0].attempt_count, 13);
  assert.equal(store.state.skills[0].issue_count, 5);
  assert.equal(store.state.skills[0].success_count, 8);
  assert.equal(store.state.skills[0].created_at, '2026-07-01T00:00:00.000Z');
  assert.equal(store.state.skills[0].status, 'focus');
});

test('two concurrent assessments for one user serialize and retain both observations', async () => {
  const initial = {
    skill_type: 'missing_word', target_key: 'school', display_target: 'school',
    evidence_level: 'transcript_alignment', attempt_count: 1, issue_count: 1,
    success_count: 0, success_streak: 0, ema_score: 20, confidence: 0.18,
    status: 'focus', created_at: '2026-08-20T00:00:00.000Z',
  };
  const one = assessment({ id: '101', issues: [{ type: 'missing_word', target: 'school', evidence: 'transcript_alignment' }] });
  const two = assessment({ id: '102', issues: [{ type: 'missing_word', target: 'school', evidence: 'transcript_alignment' }] });
  const store = createInMemoryStore({ assessments: [two, one], skills: [initial] });

  await Promise.all([
    updateProfileAfterAssessment(store, '42', one, one, now),
    updateProfileAfterAssessment(store, '42', two, two, new Date('2026-08-21T00:00:01.000Z')),
  ]);

  assert.equal(store.state.transactions, 2);
  assert.equal(store.state.skills[0].attempt_count, 3);
  assert.equal(store.state.skills[0].issue_count, 3);
});

test('a failure on the second observation rolls back the entire assessment ledger update', async () => {
  const saved = assessment({
    id: '103',
    issues: [
      { type: 'missing_word', target: 'school', evidence: 'transcript_alignment' },
      { type: 'extra_word', target: 'um', evidence: 'transcript_alignment' },
    ],
  });
  const store = createInMemoryStore({ assessments: [saved], failUpsertAt: 2 });

  await assert.rejects(
    updateProfileAfterAssessment(store, '42', saved, saved, now),
    /forced upsert failure/,
  );
  assert.deepEqual(store.state.skills, []);
  assert.equal(store.state.transactions, 1);
});

test('an assessment without observations returns an empty update and makes no skill writes', async () => {
  const saved = assessment({ id: 12, evidence: 'recording_signal' });
  const store = createInMemoryStore({ assessments: [saved] });

  const update = await updateProfileAfterAssessment(store, 42, saved, { ...saved, id: undefined }, now);

  assert.deepEqual(update, { improved: [], needs_focus: [], sample_count: 0 });
  assert.deepEqual(store.state.upserts, []);
});

test('profile loading bounds recent assessment and skill reads to twenty rows', async () => {
  const store = createInMemoryStore({ assessments: [assessment({ id: 13 })] });

  const profile = await loadPronunciationProfile(store, 42, { limit: 99, now });

  assert.equal(profile.status, 'collecting');
  assert.deepEqual(store.state.listAssessmentOptions, [{ limit: 20 }]);
  assert.deepEqual(store.state.listSkillOptions, [{ limit: 20, includeStable: true }]);
});

test('profile limit normalizes zero, oversized, and non-numeric input', () => {
  assert.equal(normalizeProfileLimit('0'), 1);
  assert.equal(normalizeProfileLimit('99'), 5);
  assert.equal(normalizeProfileLimit('not-a-number'), 3);
  assert.equal(normalizeProfileLimit(null), 3);
});

test('assessment focus response exposes only its locator fields', () => {
  const focus = buildAssessmentFocusResponse({
    id: 17,
    video_resource_id: 8,
    text: 'School bus',
    audio_path: '/private/audio.wav',
    next_action: { type: 'retry_focus', target_text: 'school' },
  });

  assert.deepEqual(focus, {
    id: 17,
    video_resource_id: 8,
    text: 'School bus',
    next_action: { type: 'retry_focus', target_text: 'school' },
  });
});

test('assessment focus response preserves real pg int8 strings exactly', () => {
  const id = parsePgInt8('9223372036854775807');
  const videoId = parsePgInt8('9007199254740993');

  assert.deepEqual(buildAssessmentFocusResponse({
    id,
    video_resource_id: videoId,
    text: 'School bus',
    next_action: null,
  }), {
    id: '9223372036854775807',
    video_resource_id: '9007199254740993',
    text: 'School bus',
    next_action: null,
  });
});

test('assessment response remains compatible when the profile update rejects', async () => {
  const warnings = [];
  const saved = { id: 17, text: 'School bus', overall: 50, accuracy: 50 };
  const assessed = {
    coaching: { evidence_level: 'transcript_alignment', issues: [] },
    analysis_version: 'coach-v1',
    duration_seconds: 1.8,
    speech_rate_wpm: 67,
    hypothesis: { verdict: 'retry' },
  };
  const quota = { used_today: 1, limit: 3, remaining: 2 };

  const response = await buildAssessmentApiResponse({
    store: {},
    userId: 42,
    saved,
    assessed,
    quota,
    updateProfile: async () => { throw new Error('profile store unavailable'); },
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(response, {
    assessment: {
      ...saved,
      coaching: assessed.coaching,
      analysis_version: 'coach-v1',
      duration_seconds: 1.8,
      speech_rate_wpm: 67,
    },
    hypothesis: assessed.hypothesis,
    quota,
  });
  assert.deepEqual(warnings, ['[Pronunciation] Profile update failed']);
  assert.doesNotMatch(warnings.join(' '), /School bus/);
});

test('assessment response appends skill_update without moving hypothesis or quota', async () => {
  const saved = { id: 18, text: 'School bus', overall: 50 };
  const assessed = { hypothesis: { verdict: 'retry' }, duration_seconds: 2, speech_rate_wpm: 60 };
  const quota = { used_today: 1, limit: 3, remaining: 2 };
  const skillUpdate = {
    improved: [{ type: 'missing_word', evidence: 'transcript_alignment', status: 'improving' }],
    needs_focus: [],
    sample_count: 3,
  };

  const response = await buildAssessmentApiResponse({
    store: {},
    userId: 42,
    saved,
    assessed,
    quota,
    updateProfile: async () => skillUpdate,
  });

  assert.equal(response.hypothesis, assessed.hypothesis);
  assert.equal(response.quota, quota);
  assert.equal(response.skill_update, skillUpdate);
  assert.equal(response.assessment.id, 18);
  assert.equal(response.assessment.overall, 50);
});

function invokeRoute(pathname, { search = '', dependencies = {} } = {}) {
  const result = {};
  const url = new URL(`http://linglish.test${pathname}${search}`);
  return registerPronunciationRoutes(pathname, { method: 'GET' }, {}, url, {
    authenticate: async () => ({ id: 42 }),
    sendJson: (_res, status, body) => {
      result.status = status;
      result.body = body;
      return true;
    },
    sendError: (_res, status, message) => {
      result.status = status;
      result.body = { message };
      return true;
    },
    ...dependencies,
  }).then((handled) => ({ handled, ...result }));
}

test('profile route authenticates and sends a normalized profile limit to the loader', async () => {
  let authenticated = 0;
  let receivedLimit = null;

  const response = await invokeRoute('/pronunciation/profile', {
    search: '?limit=99',
    dependencies: {
      authenticate: async () => { authenticated += 1; return { id: 42 }; },
      loadProfile: async (_store, _userId, options) => {
        receivedLimit = options.limit;
        return { status: 'collecting', sample_count: 1 };
      },
    },
  });

  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'collecting', sample_count: 1 });
  assert.equal(authenticated, 1);
  assert.equal(receivedLimit, 5);
});

test('focus route authenticates, scopes its lookup, and returns 404 for an absent assessment', async () => {
  let authenticated = 0;
  const calls = [];
  const found = await invokeRoute('/pronunciation/assessments/17/focus', {
    dependencies: {
      authenticate: async () => { authenticated += 1; return { id: 42 }; },
      dataStore: {
        getPronunciationAssessmentFocus: async (userId, assessmentId) => {
          calls.push([userId, assessmentId]);
          return {
            id: 17,
            video_resource_id: 8,
            text: 'School bus',
            audio_path: '/private/audio.wav',
            next_action: { type: 'retry_focus' },
          };
        },
      },
    },
  });
  const missing = await invokeRoute('/pronunciation/assessments/18/focus', {
    dependencies: {
      authenticate: async () => ({ id: 42 }),
      dataStore: { getPronunciationAssessmentFocus: async () => null },
    },
  });

  assert.equal(found.handled, true);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, {
    id: 17,
    video_resource_id: 8,
    text: 'School bus',
    next_action: { type: 'retry_focus' },
  });
  assert.equal(authenticated, 1);
  assert.deepEqual(calls, [[42, '17']]);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.message, 'ASSESSMENT_NOT_FOUND');
});

test('focus route passes a canonical decimal string to storage without lossy Number conversion', async () => {
  const assessmentId = parsePgInt8('9223372036854775807');
  const calls = [];
  const response = await invokeRoute(`/pronunciation/assessments/${assessmentId}/focus`, {
    dependencies: {
      dataStore: {
        getPronunciationAssessmentFocus: async (userId, receivedId) => {
          calls.push([userId, receivedId, typeof receivedId]);
          return {
            id: assessmentId,
            video_resource_id: parsePgInt8('9007199254740993'),
            text: 'School bus',
            next_action: null,
          };
        },
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [[42, '9223372036854775807', 'string']]);
  assert.equal(response.body.id, '9223372036854775807');
  assert.equal(response.body.video_resource_id, '9007199254740993');
});
