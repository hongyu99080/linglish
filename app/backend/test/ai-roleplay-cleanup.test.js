const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const cleanupModulePath = path.resolve(__dirname, '../scripts/cleanup.js');
const pgModulePath = path.resolve(__dirname, '../node_modules/pg');

function runCleanupInChild(sessionCount = 1, turnCount = 1) {
  const script = [
    `const cleanup = require(${JSON.stringify(cleanupModulePath)});`,
    'const calls = [];',
    'const logs = [];',
    `cleanup.cleanupAIRoleplayTurns({`,
    `  query: async (sql, params = []) => { calls.push({ sql, params }); return { rows: [{ sessions_redacted: '${sessionCount}', turns_redacted: '${turnCount}' }] }; },`,
    '  log: (message) => logs.push(String(message)),',
    '  error: (message) => logs.push(String(message)),',
    '}).then((count) => {',
    "  process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ count, calls, logs }));",
    '  process.exit(0);',
    '}, (error) => {',
    "  process.stderr.write(error && error.stack ? error.stack : String(error));",
    '  process.exit(1);',
    '});',
  ].join('\n');

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: '/tmp',
    env: { ...process.env, DATABASE_URL: '' },
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const marker = child.stdout.lastIndexOf('@@RESULT@@');
  assert.notEqual(marker, -1, child.stdout);
  return JSON.parse(child.stdout.slice(marker + '@@RESULT@@'.length));
}

function runCleanupFailureInChild() {
  const script = [
    `const cleanup = require(${JSON.stringify(cleanupModulePath)});`,
    'const logs = [];',
    'cleanup.cleanupAIRoleplayTurns({',
    "  query: async () => { throw new Error('SECRET_TRANSCRIPT id=42 SQL=UPDATE'); },",
    '  log: (message) => logs.push(String(message)),',
    '  error: (message) => logs.push(String(message)),',
    '}).then(() => {',
    "  process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ rejected: false, logs }));",
    '  process.exit(0);',
    '}, (error) => {',
    "  process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ rejected: true, code: error.code, message: error.message, logs }));",
    '  process.exit(0);',
    '});',
  ].join('\n');

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: '/tmp',
    env: { ...process.env, DATABASE_URL: '' },
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const marker = child.stdout.lastIndexOf('@@RESULT@@');
  assert.notEqual(marker, -1, child.stdout);
  return JSON.parse(child.stdout.slice(marker + '@@RESULT@@'.length));
}

test('cleanup module can be imported without starting the cron runner', () => {
  const script = [
    `const cleanup = require(${JSON.stringify(cleanupModulePath)});`,
    "process.stdout.write(typeof cleanup.cleanupAIRoleplayTurns);",
    'process.exit(0);',
  ].join('\n');

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: '/tmp',
    env: { ...process.env, DATABASE_URL: '' },
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /function$/);
  assert.doesNotMatch(child.stdout, /Starting data cleanup/);
});

test('cleanup module import does not change the host process working directory', () => {
  const script = [
    'const before = process.cwd();',
    `require(${JSON.stringify(cleanupModulePath)});`,
    "process.stdout.write(process.cwd() === before ? 'unchanged' : 'changed');",
    'process.exit(0);',
  ].join('\n');

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: '/tmp',
    env: { ...process.env, DATABASE_URL: '' },
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /unchanged$/);
});

test('cleanup uses one writable-CTE statement with strict session and turn cutoffs', () => {
  const result = runCleanupInChild(1, 2);

  assert.equal(result.count, 3);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].params, []);

  const sql = result.calls[0].sql.replace(/\s+/g, ' ').trim();
  assert.match(sql, /^WITH\b/i);
  assert.match(sql, /expired_sessions\s+AS\s*\(\s*UPDATE ai_roleplay_sessions/i);
  assert.match(sql, /expired_turns\s+AS\s*\(\s*UPDATE ai_roleplay_turns/i);
  assert.match(sql, /s\.status\s*=\s*'completed'/i);
  assert.match(sql, /s\.completed_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'30 days'/i);
  assert.match(sql, /t\.status\s*=\s*'completed'/i);
  assert.match(sql, /t\.created_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'30 days'/i);
  assert.doesNotMatch(sql, /<=\s*NOW\(\)\s*-\s*INTERVAL\s*'30 days'/i);
  assert.doesNotMatch(sql, /SET\s+mission_progress/i);
  assert.match(sql, /sessions_redacted/i);
  assert.match(sql, /turns_redacted/i);
});

test('cleanup statement redacts session and turn plaintext while preserving bounded non-text fields', () => {
  const result = runCleanupInChild(2, 3);
  const sql = result.calls[0].sql.replace(/\s+/g, ' ').trim();

  assert.match(sql, /review_summary\s*=/i);
  assert.match(sql, /'best_turn'\s*,\s*NULL/i);
  assert.match(sql, /'correction'\s*,\s*NULL/i);
  assert.match(sql, /'suggested_phrase'\s*,\s*NULL/i);
  assert.match(sql, /'goal_completion'/i);
  assert.match(sql, /'score_components'/i);
  assert.match(sql, /'assessment_id'/i);
  assert.doesNotMatch(sql, /'skill_locator'/i);
  assert.doesNotMatch(sql, /'skill_type'/i);
  assert.doesNotMatch(sql, /'target_key'/i);
  assert.doesNotMatch(sql, /'phoneme'/i);
  assert.doesNotMatch(sql, /'evidence_level'/i);
  assert.match(sql, /learner_text\s*=\s*''/i);
  assert.match(sql, /assistant_text\s*=\s*NULL/i);
  assert.match(sql, /assistant_translation_zh\s*=\s*NULL/i);
  assert.match(sql, /turn_result\s*=/i);
  assert.match(sql, /pronunciation_summary\s*=/i);
  assert.match(sql, /jsonb_array_elements/i);
  assert.match(sql, /'goal_id'/i);
  assert.match(sql, /'status'/i);
  assert.doesNotMatch(sql, /'evidence'\s*,\s*goal/i);
  assert.match(sql, /jsonb_typeof/i);
});

test('cleanup logs only the affected row count and never row identifiers or text', () => {
  const result = runCleanupInChild(12, 19);

  assert.equal(result.count, 31);
  assert.deepEqual(result.logs, ['AI roleplay records redacted: 31']);
  assert.doesNotMatch(JSON.stringify(result.logs), /session|turn_key|learner|assistant|correction|suggested|evidence/i);
});

test('cleanup logs a generic failure and rejects without leaking database details', () => {
  const result = runCleanupFailureInChild();

  assert.equal(result.rejected, true);
  assert.equal(result.code, 'AI_ROLEPLAY_CLEANUP_FAILED');
  assert.equal(result.message, 'AI_ROLEPLAY_CLEANUP_FAILED');
  assert.deepEqual(result.logs, ['AI roleplay privacy cleanup failed']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_TRANSCRIPT|id=42|UPDATE/i);
});

const integrationSetupSql = `
  CREATE TABLE users (id BIGINT PRIMARY KEY);
  CREATE TABLE ai_roleplay_scenarios (id TEXT PRIMARY KEY);
  CREATE TABLE ai_roleplay_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scenario_id TEXT NOT NULL REFERENCES ai_roleplay_scenarios(id),
    status TEXT NOT NULL CHECK (status IN ('active','completed','abandoned','failed')),
    cefr_level TEXT NOT NULL,
    turn_count INTEGER NOT NULL DEFAULT 0,
    turn_limit INTEGER NOT NULL,
    mission_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    review_summary JSONB,
    source TEXT NOT NULL DEFAULT 'catalog',
    transport_mode TEXT NOT NULL DEFAULT 'asr_tts',
    model_used TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
  );
  CREATE TABLE ai_roleplay_turns (
    id BIGSERIAL PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES ai_roleplay_sessions(id) ON DELETE CASCADE,
    turn_key UUID NOT NULL,
    turn_index INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
    learner_text TEXT NOT NULL,
    assistant_text TEXT,
    assistant_translation_zh TEXT,
    evaluation JSONB,
    turn_result JSONB,
    pronunciation_summary JSONB,
    response_mode TEXT,
    latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, turn_key),
    UNIQUE (session_id, turn_index)
  );

  INSERT INTO users VALUES (7);
  INSERT INTO ai_roleplay_scenarios VALUES ('scenario-a');

  INSERT INTO ai_roleplay_sessions
    (id,user_id,scenario_id,status,cefr_level,turn_count,turn_limit,mission_progress,review_summary,source,transport_mode,completed_at)
  VALUES
    (101,7,'scenario-a','completed','A2',1,4,
      '{"completed_goal_ids":["greet"],"status":"completed"}',
      '{"goals":[{"goal_id":"greet","label_zh":"LEAK_GOAL_LABEL","completed":true,"required":true,"status":"completed","unexpected":"LEAK_GOAL_EXTRA"}],"goal_completion":{"completed":1,"total":2,"completion_rate":50,"label":"LEAK_METRIC"},"task_completion":{"completed":1,"total":1},"status":"completed","score_components":{"task_completion":50,"understandability":20,"vocabulary_grammar":15,"pronunciation":15,"comment":"LEAK_SCORE"},"best_turn":{"text":"LEAK_BEST"},"correction":{"original":"LEAK_ORIGINAL","rewrite":"LEAK_REWRITE","reason_zh":"LEAK_REASON"},"suggested_phrase":{"text":"LEAK_PHRASE","meaning_zh":"LEAK_MEANING"},"pronunciation":{"trusted":true,"owned_by_user":true,"credible":true,"assessment_id":"17","summary":"LEAK_PRON_SUMMARY","skill_id":"LEAK_SKILL_ID","skill_type":"LEAK_SKILL_TYPE","target_key":"LEAK_TARGET_KEY","phoneme":"LEAK_PHONEME","evidence_level":"LEAK_EVIDENCE_LEVEL","status":"LEAK_STATUS","overall":82,"accuracy":80,"fluency":75,"completeness":90,"confidence":0.8,"skill_locator":{"skill_id":"LEAK_NESTED_SKILL_ID","skill_type":"LEAK_NESTED_SKILL_TYPE","target_key":"LEAK_NESTED_TARGET_KEY","phoneme":"LEAK_NESTED_PHONEME","evidence_level":"LEAK_NESTED_EVIDENCE_LEVEL","description":"LEAK_LOCATOR_DESCRIPTION"}},"unknown":{"nested":"LEAK_UNKNOWN"}}',
      'catalog','asr_tts',NOW()-INTERVAL '31 days'),
    (102,7,'scenario-a','completed','A2',1,4,'{}','{"best_turn":{"text":"LEAK_EXACT_30"}}','catalog','asr_tts',NOW()-INTERVAL '30 days'),
    (103,7,'scenario-a','completed','A2',1,4,'{}','{"best_turn":{"text":"LEAK_RECENT_29"}}','catalog','asr_tts',NOW()-INTERVAL '29 days'),
    (104,7,'scenario-a','active','A2',1,4,'{}','{"best_turn":{"text":"LEAK_ACTIVE"}}','catalog','asr_tts',NOW()-INTERVAL '31 days'),
    (105,7,'scenario-a','completed','A2',1,4,'{"completed_goal_ids":[]}',
      '{"goals":"LEAK_WRONG_GOALS","pronunciation":["LEAK_WRONG_PRON"],"score_components":{"task_completion":12,"comment":"LEAK_BAD_COMMENT"},"unexpected":{"nested":"LEAK_BAD_UNKNOWN"}}',
      'catalog','asr_tts',NOW()-INTERVAL '31 days'),
    (106,7,'scenario-a','completed','A2',1,4,'{}','{"best_turn":{"text":"LEAK_RECENT_SESSION_SUMMARY"}}','catalog','asr_tts',NOW()-INTERVAL '29 days');

  INSERT INTO ai_roleplay_turns
    (id,session_id,turn_key,turn_index,status,learner_text,assistant_text,assistant_translation_zh,evaluation,turn_result,pronunciation_summary,response_mode,latency_ms,created_at)
  VALUES
    (1,101,'11111111-1111-4111-8111-111111111111',1,'completed','LEAK_LEARNER','LEAK_ASSISTANT','LEAK_TRANSLATION',
      '{"understood":true,"goal_updates":[{"goal_id":"greet","status":"completed","evidence":"LEAK_EVIDENCE","unexpected":"LEAK_UPDATE"}],"correction":{"original":"LEAK_TURN_ORIGINAL","rewrite":"LEAK_TURN_REWRITE","reason_zh":"LEAK_TURN_REASON"},"suggested_phrase":{"text":"LEAK_TURN_PHRASE","meaning_zh":"LEAK_TURN_MEANING"},"unknown":"LEAK_EVAL_UNKNOWN"}',
      '{"version":1,"assistant":{"text":"LEAK_RESULT_ASSISTANT","translation_zh":"LEAK_RESULT_TRANSLATION","tone":"helpful"},"evaluation":{"understood":true,"goal_updates":[{"goal_id":"greet","status":"completed","evidence":"LEAK_RESULT_EVIDENCE"}],"correction":{"rewrite":"LEAK_RESULT_REWRITE"},"suggested_phrase":{"text":"LEAK_RESULT_PHRASE"}},"controls":{"should_end":false,"needs_clarification":false,"difficulty_adjustment":"same","note":"LEAK_CONTROL"},"unknown":"LEAK_RESULT_UNKNOWN"}',
      '{"trusted":false,"owned_by_user":true,"credible":false,"assessment_id":"17","summary":"LEAK_TURN_PRON","skill_id":"LEAK_TURN_SKILL_ID","skill_type":"LEAK_TURN_SKILL_TYPE","target_key":"LEAK_TURN_TARGET_KEY","phoneme":"LEAK_TURN_PHONEME","evidence_level":"LEAK_TURN_EVIDENCE_LEVEL","status":"LEAK_TURN_STATUS","overall":71,"accuracy":70,"fluency":65,"completeness":76,"confidence":0.6,"skill_locator":{"skill_id":"LEAK_TURN_NESTED_SKILL_ID","skill_type":"LEAK_TURN_NESTED_SKILL_TYPE","target_key":"LEAK_TURN_NESTED_TARGET_KEY","phoneme":"LEAK_TURN_NESTED_PHONEME","evidence_level":"LEAK_TURN_NESTED_EVIDENCE_LEVEL","description":"LEAK_TURN_LOCATOR"}}',
      'ai',120,NOW()-INTERVAL '31 days'),
    (2,102,'22222222-2222-4222-8222-222222222222',1,'completed','LEAK_EXACT_LEARNER','LEAK_EXACT_ASSISTANT',NULL,'{"correction":{"rewrite":"LEAK_EXACT_CORRECTION"}}','{"assistant":{"text":"LEAK_EXACT_RESULT"}}',NULL,'ai',100,NOW()-INTERVAL '30 days'),
    (3,103,'33333333-3333-4333-8333-333333333333',1,'completed','LEAK_RECENT_LEARNER','LEAK_RECENT_ASSISTANT',NULL,NULL,NULL,NULL,'ai',100,NOW()-INTERVAL '29 days'),
    (4,101,'44444444-4444-4444-8444-444444444444',2,'pending','LEAK_PENDING_LEARNER',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NOW()-INTERVAL '31 days'),
    (5,104,'55555555-5555-4555-8555-555555555555',1,'completed','LEAK_ACTIVE_LEARNER','LEAK_ACTIVE_ASSISTANT',NULL,NULL,NULL,NULL,'ai',100,NOW()-INTERVAL '31 days'),
    (6,105,'66666666-6666-4666-8666-666666666666',1,'completed','LEAK_MALFORMED_LEARNER','LEAK_MALFORMED_ASSISTANT',NULL,
      '{"understood":"LEAK_WRONG_BOOL","goal_updates":{"bad":"LEAK_WRONG_ARRAY"},"correction":["LEAK_WRONG_CORRECTION"],"unknown":"LEAK_MALFORMED_EVAL"}',
      '{"version":"LEAK_WRONG_VERSION","assistant":["LEAK_WRONG_ASSISTANT"],"controls":{"should_end":"LEAK_WRONG_CONTROL"},"unknown":"LEAK_MALFORMED_RESULT"}',
      '{"assessment_id":{"bad":"LEAK_WRONG_ID"},"summary":"LEAK_MALFORMED_PRON","unknown":"LEAK_PRON_UNKNOWN"}',
      'fallback',90,NOW()-INTERVAL '31 days'),
    (7,106,'77777777-7777-4777-8777-777777777777',1,'completed','LEAK_OLD_TURN_RECENT_SESSION','LEAK_OLD_ASSISTANT_RECENT_SESSION',NULL,NULL,NULL,NULL,'ai',80,NOW()-INTERVAL '31 days');
`;

function runPostgresIntegration(databaseUrl) {
  const script = [
    `const assert = require('node:assert/strict');`,
    `const { Client } = require(${JSON.stringify(pgModulePath)});`,
    `const { cleanupAIRoleplayTurns } = require(${JSON.stringify(cleanupModulePath)});`,
    '(async () => {',
    '  const client = new Client({ connectionString: process.env.AI_ROLEPLAY_CLEANUP_TEST_DATABASE_URL });',
    '  await client.connect();',
    '  await client.query(\'BEGIN\');',
    "  const schema = 'ai_roleplay_cleanup_' + process.pid + '_' + Date.now();",
    '  await client.query(`CREATE SCHEMA "${schema}"`);',
    '  await client.query(`SET LOCAL search_path TO "${schema}", public`);',
    `  await client.query(${JSON.stringify(integrationSetupSql)});`,
    '  const logs = [];',
    '  const deps = { query: (sql, params) => client.query(sql, params), log: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) };',
    '  const first = await cleanupAIRoleplayTurns(deps);',
    '  const second = await cleanupAIRoleplayTurns(deps);',
    '  const sessions = (await client.query(\'SELECT id, status, mission_progress, review_summary FROM ai_roleplay_sessions ORDER BY id\')).rows;',
    '  const turns = (await client.query(\'SELECT id, status, learner_text, assistant_text, assistant_translation_zh, evaluation, turn_result, pronunciation_summary, response_mode, latency_ms FROM ai_roleplay_turns ORDER BY id\')).rows;',
    '  await client.query(\'ROLLBACK\');',
    '  await client.end();',
    "  process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ first, second, logs, sessions, turns }));",
    '  process.exit(0);',
    '})().catch(async (error) => {',
    "  process.stderr.write(error && error.stack ? error.stack : String(error));",
    '  process.exit(1);',
    '});',
  ].join('\n');

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: '/tmp',
    env: { ...process.env, DATABASE_URL: '', AI_ROLEPLAY_CLEANUP_TEST_DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const marker = child.stdout.lastIndexOf('@@RESULT@@');
  assert.notEqual(marker, -1, child.stdout);
  return JSON.parse(child.stdout.slice(marker + '@@RESULT@@'.length));
}

if (process.env.AI_ROLEPLAY_CLEANUP_TEST_DATABASE_URL) {
  test('PostgreSQL 16 cleanup enforces retention boundaries and preserves only non-text review evidence', () => {
    const result = runPostgresIntegration(process.env.AI_ROLEPLAY_CLEANUP_TEST_DATABASE_URL);
    const session = (id) => result.sessions.find((item) => String(item.id) === String(id));
    const turn = (id) => result.turns.find((item) => String(item.id) === String(id));

    assert.equal(result.first, 5);
    assert.equal(result.second, 0);
    assert.deepEqual(result.logs, ['AI roleplay records redacted: 5', 'AI roleplay records redacted: 0']);

    assert.deepEqual(session(101).mission_progress, { completed_goal_ids: ['greet'], status: 'completed' });
    assert.equal(JSON.stringify(session(101).review_summary).includes('LEAK_'), false);
    assert.deepEqual(session(101).review_summary.goals, [{ goal_id: 'greet', completed: true, required: true, status: 'completed' }]);
    assert.deepEqual(session(101).review_summary.goal_completion, { completed: 1, total: 2, completion_rate: 50 });
    assert.equal(session(101).review_summary.score_components.task_completion, 50);
    assert.deepEqual(session(101).review_summary.pronunciation, {
      trusted: true,
      owned_by_user: true,
      credible: true,
      assessment_id: '17',
      overall: 82,
      accuracy: 80,
      fluency: 75,
      completeness: 90,
      confidence: 0.8,
    });
    assert.equal('best_turn' in session(101).review_summary, false);
    assert.equal('correction' in session(101).review_summary, false);
    assert.equal('suggested_phrase' in session(101).review_summary, false);

    assert.match(JSON.stringify(session(102).review_summary), /LEAK_EXACT_30/);
    assert.match(JSON.stringify(session(103).review_summary), /LEAK_RECENT_29/);
    assert.match(JSON.stringify(session(104).review_summary), /LEAK_ACTIVE/);
    assert.match(JSON.stringify(session(106).review_summary), /LEAK_RECENT_SESSION_SUMMARY/);
    assert.equal(JSON.stringify(session(105).review_summary).includes('LEAK_'), false);
    assert.deepEqual(session(105).review_summary.score_components, { task_completion: 12 });

    assert.equal(turn(1).learner_text, '');
    assert.equal(turn(1).assistant_text, null);
    assert.equal(turn(1).assistant_translation_zh, null);
    assert.equal(JSON.stringify(turn(1)).includes('LEAK_'), false);
    assert.deepEqual(turn(1).evaluation, {
      understood: true,
      goal_updates: [{ goal_id: 'greet', status: 'completed' }],
    });
    assert.equal(turn(1).turn_result.version, 1);
    assert.deepEqual(turn(1).turn_result.controls, {
      should_end: false, needs_clarification: false, difficulty_adjustment: 'same',
    });
    assert.deepEqual(turn(1).pronunciation_summary, {
      trusted: false,
      owned_by_user: true,
      credible: false,
      assessment_id: '17',
      overall: 71,
      accuracy: 70,
      fluency: 65,
      completeness: 76,
      confidence: 0.6,
    });
    assert.equal(turn(1).response_mode, 'ai');
    assert.equal(turn(1).latency_ms, 120);

    assert.match(turn(2).learner_text, /LEAK_EXACT_LEARNER/);
    assert.match(turn(3).learner_text, /LEAK_RECENT_LEARNER/);
    assert.match(turn(4).learner_text, /LEAK_PENDING_LEARNER/);
    assert.match(turn(5).learner_text, /LEAK_ACTIVE_LEARNER/);
    assert.equal(JSON.stringify(turn(6)).includes('LEAK_'), false);
    assert.deepEqual(turn(6).evaluation, { goal_updates: [] });
    assert.equal(turn(7).learner_text, '');
    assert.equal(turn(7).assistant_text, null);
  });
}
