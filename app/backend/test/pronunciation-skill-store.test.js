const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listPronunciationSkillsWithDeps,
  upsertPronunciationSkillWithDeps,
  getPronunciationAssessmentFocusWithDeps,
  withPronunciationSkillTransactionWithDeps,
} = require('../data-store/queries/pronunciation');
const { buildAssessmentFocusResponse } = require('../routes/pronunciation');

const skillState = {
  skill_type: 'missing_word',
  target_key: 'school',
  display_target: 'school',
  evidence_level: 'transcript_alignment',
  attempt_count: 4,
  issue_count: 2,
  success_count: 2,
  success_streak: 1,
  ema_score: 72.56,
  confidence: 0.72,
  status: 'improving',
  next_review_at: '2026-08-23T00:00:00.000Z',
  last_assessment_id: 17,
  video_resource_id: 8,
  sample_text: 'School bus',
  last_issue_at: '2026-08-21T00:00:00.000Z',
  last_success_at: '2026-08-22T00:00:00.000Z',
  created_at: '2026-08-21T00:00:00.000Z',
  updated_at: '2026-08-22T00:00:00.000Z',
};

function recordingDependencies(rows = []) {
  const calls = [];
  return {
    calls,
    dependencies: {
      init: async () => {},
      dbUnavailable: () => false,
      pool: {
        query: async (text, values) => {
          calls.push({ text, values });
          return { rows };
        },
      },
    },
  };
}

function normalizedSql(text) {
  return text.replace(/\s+/g, ' ').trim();
}

test('skill list scopes to its user and clamps the requested limit', async () => {
  const { calls, dependencies } = recordingDependencies([{ target_key: 'school' }]);

  const minimum = await listPronunciationSkillsWithDeps(dependencies, 42, { limit: 0, includeStable: false });
  const maximum = await listPronunciationSkillsWithDeps(dependencies, 42, { limit: 99, includeStable: true });

  assert.deepEqual(minimum, [{ target_key: 'school' }]);
  assert.deepEqual(maximum, [{ target_key: 'school' }]);
  assert.equal(calls.length, 2);
  assert.match(normalizedSql(calls[0].text), /WHERE user_id = \$1/);
  assert.match(normalizedSql(calls[0].text), /status <> 'stable'/);
  assert.match(
    normalizedSql(calls[0].text),
    /ORDER BY next_review_at ASC NULLS LAST, updated_at DESC LIMIT \$2/,
  );
  assert.deepEqual(calls[0].values, [42, 1]);
  assert.match(normalizedSql(calls[1].text), /WHERE user_id = \$1/);
  assert.doesNotMatch(normalizedSql(calls[1].text), /status <> 'stable'/);
  assert.deepEqual(calls[1].values, [42, 50]);
});

test('skill upsert writes every SkillState field with its composite conflict key', async () => {
  const { calls, dependencies } = recordingDependencies([{ ...skillState, user_id: 42 }]);

  const saved = await upsertPronunciationSkillWithDeps(dependencies, 42, skillState);

  assert.equal(saved.user_id, 42);
  assert.equal(calls.length, 1);
  const sql = normalizedSql(calls[0].text);
  assert.match(sql, /ON CONFLICT \(user_id, skill_type, target_key\)/);
  assert.doesNotMatch(sql, /created_at = EXCLUDED\.created_at/);
  assert.deepEqual(calls[0].values, [
    42,
    skillState.skill_type,
    skillState.target_key,
    skillState.display_target,
    skillState.evidence_level,
    skillState.attempt_count,
    skillState.issue_count,
    skillState.success_count,
    skillState.success_streak,
    skillState.ema_score,
    skillState.confidence,
    skillState.status,
    skillState.next_review_at,
    skillState.last_assessment_id,
    skillState.video_resource_id,
    skillState.sample_text,
    skillState.last_issue_at,
    skillState.last_success_at,
    skillState.created_at,
    skillState.updated_at,
  ]);
});

test('skill list enumerates persisted columns instead of SELECT star', async () => {
  const { calls, dependencies } = recordingDependencies([]);

  await listPronunciationSkillsWithDeps(dependencies, '42', { includeStable: true });

  const sql = normalizedSql(calls[0].text);
  assert.doesNotMatch(sql, /SELECT \*/);
  assert.match(sql, /SELECT skill_type, target_key, display_target, evidence_level, attempt_count/);
});

test('production transaction uses a dedicated client, advisory user lock, row lock, commit, and release', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text: normalizedSql(text), values });
      if (/SELECT skill_type/.test(text)) return { rows: [{ ...skillState, status: 'stable' }] };
      return { rows: [] };
    },
    release() { calls.push({ text: 'RELEASE' }); },
  };
  const dependencies = {
    init: async () => {},
    dbUnavailable: () => false,
    pool: { connect: async () => client },
  };

  const value = await withPronunciationSkillTransactionWithDeps(dependencies, '42', async (transaction) => {
    const rows = await transaction.listPronunciationSkillsForUpdate();
    return rows[0].status;
  });

  assert.equal(value, 'stable');
  assert.deepEqual(calls.map((call) => call.text), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock($1::bigint)',
    calls[2].text,
    'COMMIT',
    'RELEASE',
  ]);
  assert.match(calls[2].text, /WHERE user_id = \$1/);
  assert.match(calls[2].text, /FOR UPDATE/);
  assert.doesNotMatch(calls[2].text, /status <> 'stable'|LIMIT/);
  assert.deepEqual(calls[1].values, ['42']);
});

test('production transaction rolls back and releases when a later write fails', async () => {
  const calls = [];
  let writes = 0;
  const client = {
    async query(text, values) {
      calls.push({ text: normalizedSql(text), values });
      if (/INSERT INTO user_pronunciation_skills/.test(text)) {
        writes += 1;
        if (writes === 2) throw new Error('second write failed');
        return { rows: [{ ...skillState }] };
      }
      return { rows: [] };
    },
    release() { calls.push({ text: 'RELEASE' }); },
  };
  const dependencies = {
    init: async () => {},
    dbUnavailable: () => false,
    pool: { connect: async () => client },
  };

  await assert.rejects(withPronunciationSkillTransactionWithDeps(dependencies, '42', async (transaction) => {
    await transaction.upsertPronunciationSkill('42', skillState);
    await transaction.upsertPronunciationSkill('42', { ...skillState, target_key: 'bus' });
  }), /second write failed/);

  assert.equal(calls.at(-2).text, 'ROLLBACK');
  assert.equal(calls.at(-1).text, 'RELEASE');
  assert.ok(!calls.some((call) => call.text === 'COMMIT'));
});

test('assessment focus query returns the persisted next action for the route formatter', async () => {
  const focus = {
    id: 17,
    video_resource_id: 8,
    text: 'School bus',
    next_action: { type: 'retry_focus', target_text: 'school' },
  };
  const { calls, dependencies } = recordingDependencies([focus]);

  const result = await getPronunciationAssessmentFocusWithDeps(dependencies, 42, 17);

  assert.deepEqual(result, focus);
  assert.deepEqual(buildAssessmentFocusResponse(result), {
    id: 17,
    video_resource_id: 8,
    text: 'School bus',
    next_action: { type: 'retry_focus', target_text: 'school' },
  });
  assert.equal(calls.length, 1);
  const sql = normalizedSql(calls[0].text);
  assert.match(sql, /SELECT id, video_resource_id, text, coaching -> 'next_action' AS next_action/);
  assert.match(sql, /WHERE user_id = \$1 AND id = \$2/);
  assert.doesNotMatch(sql, /audio_path/i);
  assert.deepEqual(calls[0].values, [42, 17]);
});

test('skill storage returns empty boundaries when the database is unavailable', async () => {
  let queryCount = 0;
  const dependencies = {
    init: async () => {},
    dbUnavailable: () => true,
    pool: { query: async () => { queryCount += 1; return { rows: [] }; } },
  };

  assert.deepEqual(await listPronunciationSkillsWithDeps(dependencies, 42, {}), []);
  assert.equal(await upsertPronunciationSkillWithDeps(dependencies, 42, skillState), null);
  assert.equal(await getPronunciationAssessmentFocusWithDeps(dependencies, 42, 17), null);
  assert.equal(await withPronunciationSkillTransactionWithDeps(dependencies, 42, async () => 'must not run'), null);
  assert.equal(queryCount, 0);
});
