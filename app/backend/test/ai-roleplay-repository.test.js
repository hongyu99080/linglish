const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAIRoleplayRepositoryWithDeps,
} = require('../data-store/queries/ai-roleplay');

const TURN_RESULT = {
  version: 1,
  assistant: {
    text: 'Here is your coffee.',
    translation_zh: '这是你的咖啡。',
    tone: 'supportive',
  },
  evaluation: {
    understood: true,
    goal_updates: [{ goal_id: 'order', status: 'completed', evidence: 'coffee' }],
    correction: null,
    suggested_phrase: null,
  },
  controls: {
    should_end: false,
    needs_clarification: false,
    difficulty_adjustment: 'same',
  },
};

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function clone(row) {
  if (row == null) return row;
  return JSON.parse(JSON.stringify(row));
}

function cloneMap(map) {
  return new Map([...map.entries()].map(([key, value]) => [key, clone(value)]));
}

function restoreMap(target, snapshot) {
  target.clear();
  for (const [key, value] of snapshot.entries()) {
    target.set(key, clone(value));
  }
}

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function createRoleplayFakeDatabase() {
  let nowMs = Date.parse('2026-08-21T00:00:00.000Z');
  let nextSessionId = 101n;
  let nextTurnId = 501n;
  const sessions = new Map();
  const turns = new Map();
  const pronunciationAssessments = new Map([
    ['7:17', {
      id: '17',
      user_id: '7',
      overall: 86.2,
      accuracy: 82.1,
      fluency: 88.4,
      completeness: 91.5,
      coaching: { summary_zh: '元音更稳定。' },
      created_at: isoNow(),
    }],
  ]);
  const sessionLocks = new Map();
  let failAfterNextTurnInsert = false;
  const scenarios = new Map([
    ['coffee-order-a1', {
      id: 'coffee-order-a1',
      title_zh: '点咖啡',
      title_en: 'Order coffee',
      category: 'travel',
      cefr_min: 'A1',
      cefr_max: 'A1',
      learner_role: 'customer',
      assistant_role: 'barista',
      opening_line: 'Hi, what would you like?',
      opening_translation_zh: '你好，你想要什么？',
      goals: [{ id: 'order', required: true }],
      target_phrases: [{ text: 'I would like...' }],
      fallback_turns: { clarification_prompt: 'Please order a drink.' },
      turn_limit: 4,
      is_active: true,
      sort_order: 10,
      created_at: isoNow(),
      updated_at: isoNow(),
    }],
    ['job-interview-b1', {
      id: 'job-interview-b1',
      title_zh: '工作面试',
      title_en: 'Job interview',
      category: 'work',
      cefr_min: 'B1',
      cefr_max: 'B1',
      learner_role: 'candidate',
      assistant_role: 'interviewer',
      opening_line: 'Tell me about yourself.',
      opening_translation_zh: '介绍一下你自己。',
      goals: [{ id: 'intro', required: true }],
      target_phrases: [],
      fallback_turns: {},
      turn_limit: 5,
      is_active: true,
      sort_order: 20,
      created_at: isoNow(),
      updated_at: isoNow(),
    }],
  ]);
  const activeClients = new Set();
  const committedTransactionActions = [];
  const allClientQueries = [];

  function isoNow() {
    return new Date(nowMs).toISOString();
  }

  function setNow(value) {
    nowMs = Date.parse(value);
  }

  function now() {
    return new Date(nowMs);
  }

  function turnKey(sessionId, turnKey) {
    return `${String(sessionId)}:${String(turnKey)}`;
  }

  function addSession({
    id = String(nextSessionId++),
    user_id = '7',
    scenario_id = 'coffee-order-a1',
    status = 'active',
    cefr_level = 'A1',
    turn_count = 0,
    turn_limit = 4,
    source = 'catalog',
    mission_progress = { completed_goal_ids: [] },
  } = {}) {
    const row = {
      id: String(id),
      user_id: String(user_id),
      scenario_id,
      status,
      cefr_level,
      turn_count,
      turn_limit,
      source,
      mission_progress,
      review_summary: null,
      transport_mode: 'asr_tts',
      model_used: null,
      started_at: isoNow(),
      completed_at: null,
      updated_at: isoNow(),
      expires_at: null,
    };
    sessions.set(row.id, row);
    return row;
  }

  function addTurn({
    session_id,
    turn_key,
    turn_index,
    status = 'pending',
    learner_text = 'Coffee, please.',
    pronunciation_summary = null,
    turn_result = null,
    updated_at = isoNow(),
  }) {
    const row = {
      id: String(nextTurnId++),
      session_id: String(session_id),
      turn_key,
      turn_index,
      status,
      learner_text,
      assistant_text: null,
      assistant_translation_zh: null,
      evaluation: null,
      turn_result: clone(turn_result),
      pronunciation_summary,
      response_mode: null,
      latency_ms: null,
      created_at: updated_at,
      updated_at,
    };
    turns.set(turnKey(row.session_id, row.turn_key), row);
    return row;
  }

  function refreshPendingTurnLease(sessionId, key) {
    const row = turns.get(turnKey(sessionId, key));
    if (!row || row.status !== 'pending') return null;
    row.updated_at = isoNow();
    return row;
  }

  function completeTurn(row, result, missionProgress, modelUsed, latencyMs) {
    if (row.status === 'completed') return row;
    row.status = 'completed';
    row.assistant_text = result.assistant.text;
    row.assistant_translation_zh = result.assistant.translation_zh;
    row.evaluation = result.evaluation;
    row.turn_result = clone(result);
    row.response_mode = modelUsed === 'fallback' ? 'fallback' : 'ai';
    row.latency_ms = latencyMs;
    row.updated_at = isoNow();
    return row;
  }

  async function acquireSessionLock(client, sessionId) {
    let lock = sessionLocks.get(sessionId);
    if (!lock) {
      lock = { owner: null, waiters: [] };
      sessionLocks.set(sessionId, lock);
    }
    if (lock.owner === client) return;
    if (!lock.owner) {
      lock.owner = client;
      client.lockedSessionId = sessionId;
      client.actions.push(`LOCK:${sessionId}`);
      return;
    }
    await new Promise((resolve) => {
      lock.waiters.push(() => {
        lock.owner = client;
        client.lockedSessionId = sessionId;
        client.actions.push(`LOCK:${sessionId}`);
        resolve();
      });
    });
  }

  function releaseSessionLock(client) {
    const sessionId = client.lockedSessionId;
    if (!sessionId) return;
    const lock = sessionLocks.get(sessionId);
    if (!lock || lock.owner !== client) return;
    client.lockedSessionId = null;
    const next = lock.waiters.shift();
    if (next) {
      next();
    } else {
      lock.owner = null;
      sessionLocks.delete(sessionId);
    }
  }

  function createClient() {
    const client = {
      inTransaction: false,
      released: false,
      lockedSessionId: null,
      snapshot: null,
      actions: [],
      async query(sql, params = []) {
        const text = normalizeSql(sql);
        allClientQueries.push({ text, params });
        if (text === 'BEGIN') {
          assert.equal(client.inTransaction, false, 'cannot begin twice on one client');
          client.inTransaction = true;
          client.snapshot = {
            sessions: cloneMap(sessions),
            turns: cloneMap(turns),
            nextSessionId,
            nextTurnId,
          };
          client.actions.push('BEGIN');
          return { rows: [], rowCount: 0 };
        }
        if (text === 'COMMIT') {
          assert.equal(client.inTransaction, true, 'commit requires an open transaction');
          client.inTransaction = false;
          client.actions.push('COMMIT');
          committedTransactionActions.push([...client.actions]);
          client.snapshot = null;
          releaseSessionLock(client);
          return { rows: [], rowCount: 0 };
        }
        if (text === 'ROLLBACK') {
          if (client.snapshot) {
            restoreMap(sessions, client.snapshot.sessions);
            restoreMap(turns, client.snapshot.turns);
            nextSessionId = client.snapshot.nextSessionId;
            nextTurnId = client.snapshot.nextTurnId;
          }
          client.inTransaction = false;
          client.actions.push('ROLLBACK');
          client.snapshot = null;
          releaseSessionLock(client);
          return { rows: [], rowCount: 0 };
        }

        assert.equal(client.inTransaction, true, `transactional query outside BEGIN: ${text}`);

        if (/FROM ai_roleplay_sessions/i.test(text) && /FOR UPDATE/i.test(text)) {
          const [sessionId, userId] = params.map(String);
          const row = sessions.get(sessionId);
          if (!row || row.user_id !== userId) return { rows: [], rowCount: 0 };
          await acquireSessionLock(client, sessionId);
          return { rows: [clone(row)], rowCount: 1 };
        }

        if (/FROM ai_roleplay_turns/i.test(text) && /turn_key\s*=\s*\$2/i.test(text)) {
          const [sessionId, key] = params.map(String);
          assert.equal(client.lockedSessionId, sessionId, 'turn lookup requires the session row lock');
          const row = turns.get(turnKey(sessionId, key));
          return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
        }

        if (/FROM ai_roleplay_turns/i.test(text) && /status\s*=\s*'pending'/i.test(text)) {
          const [sessionId] = params.map(String);
          assert.equal(client.lockedSessionId, sessionId, 'pending lookup requires the session row lock');
          const rows = [...turns.values()]
            .filter((turn) => turn.session_id === sessionId && turn.status === 'pending')
            .sort((a, b) => a.turn_index - b.turn_index);
          return { rows: rows.map(clone), rowCount: rows.length };
        }

        if (/INSERT INTO ai_roleplay_turns/i.test(text)) {
          const [
            sessionId,
            key,
            turnIndex,
            learnerText,
            pronunciationSummary,
          ] = params;
          assert.equal(client.lockedSessionId, String(sessionId), 'turn insert requires the session row lock');
          const uniqueKey = turnKey(sessionId, key);
          if (turns.has(uniqueKey)) {
            throw makeError('23505');
          }
          const row = addTurn({
            session_id: String(sessionId),
            turn_key: key,
            turn_index: Number(turnIndex),
            learner_text: learnerText,
            pronunciation_summary: clone(pronunciationSummary),
          });
          if (failAfterNextTurnInsert) {
            failAfterNextTurnInsert = false;
            throw new Error('insert side effect failed');
          }
          return { rows: [clone(row)], rowCount: 1 };
        }

        if (/UPDATE ai_roleplay_turns/i.test(text) && /updated_at = NOW\(\)/i.test(text) && !/status = 'completed'/i.test(text)) {
          const [sessionId, key] = params.map(String);
          assert.equal(client.lockedSessionId, String(sessionId), 'lease refresh requires the session row lock');
          const row = refreshPendingTurnLease(sessionId, key);
          return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
        }

        if (/UPDATE ai_roleplay_turns/i.test(text)) {
          const [result, missionProgress, modelUsed, latencyMs, sessionId, key] = params;
          assert.equal(client.lockedSessionId, String(sessionId), 'turn finalize requires the session row lock');
          const row = turns.get(turnKey(sessionId, key));
          if (!row || row.status !== 'pending') return { rows: [], rowCount: 0 };
          const completed = completeTurn(row, result, missionProgress, modelUsed, latencyMs);
          return { rows: [clone(completed)], rowCount: 1 };
        }

        if (/UPDATE ai_roleplay_sessions/i.test(text) && /mission_progress/i.test(text)) {
          const [missionProgress, modelUsed, sessionId, userId] = params;
          const row = sessions.get(String(sessionId));
          assert.equal(client.lockedSessionId, String(sessionId), 'session finalize requires the session row lock');
          if (!row || row.user_id !== String(userId)) return { rows: [], rowCount: 0 };
          row.turn_count += 1;
          row.mission_progress = clone(missionProgress);
          row.model_used = modelUsed;
          row.updated_at = isoNow();
          return { rows: [clone(row)], rowCount: 1 };
        }

        if (/UPDATE ai_roleplay_sessions/i.test(text) && /review_summary/i.test(text)) {
          const [reviewSummary, sessionId, userId] = params;
          const row = sessions.get(String(sessionId));
          assert.equal(client.lockedSessionId, String(sessionId), 'completion requires the session row lock');
          if (!row || row.user_id !== String(userId)) return { rows: [], rowCount: 0 };
          if (row.status !== 'completed') {
            row.status = 'completed';
            row.review_summary = clone(reviewSummary);
            row.completed_at = isoNow();
            row.updated_at = isoNow();
          }
          return { rows: [clone(row)], rowCount: 1 };
        }

        throw new Error(`Unexpected transactional SQL: ${text}`);
      },
      release() {
        assert.equal(client.released, false, 'client released twice');
        assert.equal(client.inTransaction, false, 'client released with open transaction');
        assert.equal(client.lockedSessionId, null, 'client released while holding a session lock');
        client.released = true;
        activeClients.delete(client);
        client.actions.push('RELEASE');
      },
    };
    activeClients.add(client);
    return client;
  }

  async function query(sql, params = []) {
    const text = normalizeSql(sql);
    if (/FROM ai_roleplay_scenarios/i.test(text) && /WHERE id = \$1/i.test(text)) {
      const row = scenarios.get(String(params[0]));
      return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM ai_roleplay_scenarios/i.test(text)) {
      let rows = [...scenarios.values()].filter((scenario) => scenario.is_active);
      if (/category =/i.test(text)) {
        rows = rows.filter((scenario) => scenario.category === params[0]);
      }
      if (/cefr_min <=/i.test(text)) {
        const level = params.find((value) => ['A1', 'A2', 'B1', 'B2', 'C1'].includes(value));
        if (level) {
          rows = rows.filter((scenario) => scenario.cefr_min <= level && scenario.cefr_max >= level);
        }
      }
      rows.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
      const limit = Number(params.at(-1));
      return { rows: rows.slice(0, limit).map(clone), rowCount: Math.min(rows.length, limit) };
    }
    if (/INSERT INTO ai_roleplay_sessions/i.test(text)) {
      const [userId, scenarioId, cefrLevel, turnLimit, source, expiresAt] = params;
      const row = addSession({
        user_id: String(userId),
        scenario_id: scenarioId,
        cefr_level: cefrLevel,
        turn_limit: Number(turnLimit),
        source,
      });
      row.expires_at = expiresAt;
      return { rows: [clone(row)], rowCount: 1 };
    }
    if (/FROM ai_roleplay_sessions/i.test(text)) {
      const [sessionId, userId] = params.map(String);
      const row = sessions.get(sessionId);
      return { rows: row && row.user_id === userId ? [clone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM user_pronunciation_assessments/i.test(text)) {
      const [assessmentId, userId] = params.map(String);
      const row = pronunciationAssessments.get(`${userId}:${assessmentId}`);
      return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM ai_roleplay_turns/i.test(text)) {
      const [sessionId] = params.map(String);
      const rows = [...turns.values()]
        .filter((turn) => turn.session_id === sessionId)
        .sort((a, b) => a.turn_index - b.turn_index);
      return { rows: rows.map(clone), rowCount: rows.length };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  return {
    sessions,
    turns,
    pronunciationAssessments,
    scenarios,
    allClientQueries,
    committedTransactionActions,
    setNow,
    now,
    failAfterNextTurnInsert() {
      failAfterNextTurnInsert = true;
    },
    addSession,
    addTurn,
    pool: {
      query,
      async connect() {
        return createClient();
      },
      activeClientCount() {
        return activeClients.size;
      },
    },
  };
}

function createRepository(fakeDb, overrides = {}) {
  return createAIRoleplayRepositoryWithDeps({
    init: async () => fakeDb.pool,
    dbUnavailable: () => false,
    now: fakeDb.now,
    pool: fakeDb.pool,
    ...overrides,
  });
}

test('scenario listing, lookup, and session creation preserve canonical string identifiers', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  const repo = createRepository(fakeDb);

  const scenarios = await repo.listAIRoleplayScenarios({ level: 'A1', category: 'travel', limit: 10 });
  const scenario = await repo.getAIRoleplayScenario('coffee-order-a1');
  const session = await repo.createAIRoleplaySession({
    userId: '9007199254740993',
    scenarioId: 'coffee-order-a1',
    cefrLevel: 'A1',
    turnLimit: 4,
    source: 'catalog',
    expiresAt: '2026-08-22T00:00:00.000Z',
  });

  assert.deepEqual(scenarios.map((item) => item.id), ['coffee-order-a1']);
  assert.equal(scenario.id, 'coffee-order-a1');
  assert.equal(typeof session.id, 'string');
  assert.equal(session.user_id, '9007199254740993');
});

test('claim commits before model work, duplicate pending returns pending, and duplicate completed returns the stored turn', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '101', user_id: '7', turn_count: 0 });
  const repo = createRepository(fakeDb);
  const input = {
    sessionId: '101',
    userId: '7',
    turnKey: '11111111-1111-4111-8111-111111111111',
    transcript: 'Coffee, please.',
    pronunciationSummary: { assessment_id: '123' },
    staleAfterMs: 30_000,
  };

  const first = await repo.claimAIRoleplayTurn(input);
  const duplicatePending = await repo.claimAIRoleplayTurn(input);

  assert.equal(first.kind, 'claimed');
  assert.equal(first.turn.turn_index, 1);
  assert.equal(fakeDb.pool.activeClientCount(), 0, 'claim must release its client before returning');
  assert.equal(duplicatePending.kind, 'pending');
  assert.deepEqual(fakeDb.committedTransactionActions[0], ['BEGIN', 'LOCK:101', 'COMMIT']);

  await repo.finalizeAIRoleplayTurn({
    sessionId: '101',
    userId: '7',
    turnKey: input.turnKey,
    result: TURN_RESULT,
    missionProgress: { completed_goal_ids: ['order'] },
    modelUsed: 'gpt-roleplay',
    latencyMs: 87,
  });
  const duplicateDone = await repo.claimAIRoleplayTurn(input);

  assert.equal(duplicateDone.kind, 'completed');
  assert.equal(duplicateDone.turn.turn_index, 1);
  assert.equal(duplicateDone.turn.assistant_text, 'Here is your coffee.');
  assert.deepEqual(duplicateDone.turn.turn_result, TURN_RESULT);
  assert.equal(fakeDb.sessions.get('101').turn_count, 1);
  assert.equal(fakeDb.pool.activeClientCount(), 0, 'finalize must release its client before returning');
});

test('claim uses server-owned stale lease threshold and ignores caller supplied staleAfterMs', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '102', user_id: '7', turn_count: 0 });
  const repo = createRepository(fakeDb, { pendingTurnStaleAfterMs: 60_000 });
  const input = {
    sessionId: '102',
    userId: '7',
    turnKey: '12121212-1212-4212-8212-121212121212',
    transcript: 'Coffee, please.',
  };

  const first = await repo.claimAIRoleplayTurn(input);
  fakeDb.turns.get(`102:${input.turnKey}`).updated_at = '2026-08-20T23:59:50.000Z';
  fakeDb.setNow('2026-08-21T00:00:00.000Z');
  const callerForcedStale = await repo.claimAIRoleplayTurn({
    ...input,
    staleAfterMs: 1,
  });

  assert.equal(first.kind, 'claimed');
  assert.equal(callerForcedStale.kind, 'pending');
  assert.equal(fakeDb.turns.size, 1);
});

test('session reads and turn claims are user scoped', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '202', user_id: '7' });
  const repo = createRepository(fakeDb);

  const ownSession = await repo.getAIRoleplaySessionForUser('202', '7');

  assert.equal(ownSession.id, '202');
  assert.equal(await repo.getAIRoleplaySessionForUser('202', '8'), null);
  await assert.rejects(
    repo.claimAIRoleplayTurn({
      sessionId: '202',
      userId: '8',
      turnKey: '22222222-2222-4222-8222-222222222222',
      transcript: 'Hello',
      staleAfterMs: 30_000,
    }),
    (error) => error?.code === 'SESSION_NOT_FOUND',
  );
});

test('completed sessions reject new turns', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '303', user_id: '7', status: 'completed' });
  const repo = createRepository(fakeDb);

  await assert.rejects(
    repo.claimAIRoleplayTurn({
      sessionId: '303',
      userId: '7',
      turnKey: '33333333-3333-4333-8333-333333333333',
      transcript: 'Hello',
      staleAfterMs: 30_000,
    }),
    (error) => error?.code === 'SESSION_NOT_ACTIVE',
  );
});

test('completed same-key retry returns the stored turn before active and turn-limit eligibility checks', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '606', user_id: '7', turn_count: 0, turn_limit: 1 });
  const repo = createRepository(fakeDb);
  const input = {
    sessionId: '606',
    userId: '7',
    turnKey: '77777777-7777-4777-8777-777777777777',
    transcript: 'One coffee, please.',
    staleAfterMs: 30_000,
  };

  await repo.claimAIRoleplayTurn(input);
  await repo.finalizeAIRoleplayTurn({
    sessionId: '606',
    userId: '7',
    turnKey: input.turnKey,
    result: TURN_RESULT,
    missionProgress: { completed_goal_ids: ['order'] },
    modelUsed: 'gpt-roleplay',
    latencyMs: 87,
  });
  const duplicateAtTurnLimit = await repo.claimAIRoleplayTurn(input);
  fakeDb.sessions.get('606').status = 'completed';
  const duplicateAfterCompletion = await repo.claimAIRoleplayTurn(input);

  assert.equal(duplicateAtTurnLimit.kind, 'completed');
  assert.equal(duplicateAtTurnLimit.turn.turn_index, 1);
  assert.equal(duplicateAfterCompletion.kind, 'completed');
  assert.equal(duplicateAfterCompletion.turn.assistant_text, 'Here is your coffee.');
});

test('stale pending work is reclaimable only by the same turn key', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '404', user_id: '7' });
  const repo = createRepository(fakeDb);
  const staleKey = '44444444-4444-4444-8444-444444444444';
  const otherKey = '55555555-5555-4555-8555-555555555555';

  const first = await repo.claimAIRoleplayTurn({
    sessionId: '404',
    userId: '7',
    turnKey: staleKey,
    transcript: 'Can I have tea?',
    staleAfterMs: 30_000,
  });
  fakeDb.turns.get(`404:${staleKey}`).updated_at = '2026-08-20T23:00:00.000Z';
  fakeDb.setNow('2026-08-21T00:10:00.000Z');

  const differentKey = await repo.claimAIRoleplayTurn({
    sessionId: '404',
    userId: '7',
    turnKey: otherKey,
    transcript: 'Can I have tea?',
    staleAfterMs: 30_000,
  });
  const sameKey = await repo.claimAIRoleplayTurn({
    sessionId: '404',
    userId: '7',
    turnKey: staleKey,
    transcript: 'Can I have tea?',
    staleAfterMs: 30_000,
  });
  const immediateSameKey = await repo.claimAIRoleplayTurn({
    sessionId: '404',
    userId: '7',
    turnKey: staleKey,
    transcript: 'Can I have tea?',
    staleAfterMs: 30_000,
  });

  assert.equal(first.kind, 'claimed');
  assert.equal(differentKey.kind, 'pending');
  assert.equal(differentKey.turn.turn_key, staleKey);
  assert.equal(sameKey.kind, 'claimed');
  assert.equal(sameKey.turn.turn_index, 1);
  assert.equal(immediateSameKey.kind, 'pending');
  assert.equal(fakeDb.turns.size, 1);
});

test('claim rejects UUID v1, invalid, and noncanonical turn keys before SQL mutation', async () => {
  const invalidKeys = [
    '11111111-1111-1111-8111-111111111111',
    'not-a-uuid',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
  ];

  for (const turnKey of invalidKeys) {
    const fakeDb = createRoleplayFakeDatabase();
    fakeDb.addSession({ id: '707', user_id: '7' });
    const repo = createRepository(fakeDb);

    await assert.rejects(
      repo.claimAIRoleplayTurn({
        sessionId: '707',
        userId: '7',
        turnKey,
        transcript: 'Hello',
        staleAfterMs: 30_000,
      }),
      (error) => error?.code === 'TURN_KEY_INVALID',
    );
    assert.equal(fakeDb.turns.size, 0);
    assert.equal(fakeDb.pool.activeClientCount(), 0);
  }
});

test('concurrent duplicate same-key claims serialize to exactly one claimed and one pending', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '808', user_id: '7' });
  const repo = createRepository(fakeDb);
  const input = {
    sessionId: '808',
    userId: '7',
    turnKey: '99999999-9999-4999-8999-999999999999',
    transcript: 'Coffee, please.',
    staleAfterMs: 30_000,
  };

  const results = await Promise.all([
    repo.claimAIRoleplayTurn(input),
    repo.claimAIRoleplayTurn(input),
  ]);

  assert.deepEqual(results.map((result) => result.kind).sort(), ['claimed', 'pending']);
  assert.equal(fakeDb.turns.size, 1);
  assert.equal(fakeDb.sessions.get('808').turn_count, 0);
  assert.equal(fakeDb.pool.activeClientCount(), 0);
});

test('rollback restores partial turn insert mutations when claim transaction fails', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '909', user_id: '7' });
  fakeDb.failAfterNextTurnInsert();
  const repo = createRepository(fakeDb);

  await assert.rejects(
    repo.claimAIRoleplayTurn({
      sessionId: '909',
      userId: '7',
      turnKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      transcript: 'Coffee, please.',
      staleAfterMs: 30_000,
    }),
    /insert side effect failed/,
  );

  assert.equal(fakeDb.turns.size, 0);
  assert.equal(fakeDb.sessions.get('909').turn_count, 0);
  assert.equal(fakeDb.pool.activeClientCount(), 0);
});

test('failed turn finalization rejects without advancing the session count', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '1001', user_id: '7', turn_count: 0 });
  fakeDb.addTurn({
    session_id: '1001',
    turn_key: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    turn_index: 1,
    status: 'failed',
    learner_text: 'Coffee, please.',
  });
  const repo = createRepository(fakeDb);

  await assert.rejects(
    repo.finalizeAIRoleplayTurn({
      sessionId: '1001',
      userId: '7',
      turnKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      result: TURN_RESULT,
      missionProgress: { completed_goal_ids: ['order'] },
      modelUsed: 'gpt-roleplay',
      latencyMs: 91,
    }),
    (error) => error?.code === 'TURN_NOT_PENDING',
  );

  const turn = fakeDb.turns.get('1001:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(turn.status, 'failed');
  assert.equal(turn.assistant_text, null);
  assert.equal(fakeDb.sessions.get('1001').turn_count, 0);
  assert.deepEqual(fakeDb.sessions.get('1001').mission_progress, { completed_goal_ids: [] });
  assert.equal(fakeDb.sessions.get('1001').model_used, null);
  assert.equal(fakeDb.pool.activeClientCount(), 0);
});

test('pending finalization rejects when the session is no longer active', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '1002', user_id: '7', turn_count: 0, status: 'completed' });
  fakeDb.addTurn({
    session_id: '1002',
    turn_key: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
    turn_index: 1,
    status: 'pending',
    learner_text: 'Coffee, please.',
  });
  const repo = createRepository(fakeDb);

  await assert.rejects(
    repo.finalizeAIRoleplayTurn({
      sessionId: '1002',
      userId: '7',
      turnKey: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
      result: TURN_RESULT,
      missionProgress: { completed_goal_ids: ['order'] },
      modelUsed: 'gpt-roleplay',
      latencyMs: 91,
    }),
    (error) => error?.code === 'SESSION_NOT_ACTIVE',
  );

  const turn = fakeDb.turns.get('1002:bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc');
  assert.equal(turn.status, 'pending');
  assert.equal(turn.turn_result, null);
  assert.equal(fakeDb.sessions.get('1002').turn_count, 0);
});

test('finalization is idempotent and increments the session turn count once', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '505', user_id: '7', turn_count: 0 });
  const repo = createRepository(fakeDb);
  const turnKey = '66666666-6666-4666-8666-666666666666';
  await repo.claimAIRoleplayTurn({
    sessionId: '505',
    userId: '7',
    turnKey,
    transcript: 'I need to rebook.',
    staleAfterMs: 30_000,
  });
  const finalizeInput = {
    sessionId: '505',
    userId: '7',
    turnKey,
    result: TURN_RESULT,
    missionProgress: { completed_goal_ids: ['order'] },
    modelUsed: 'gpt-roleplay',
    latencyMs: 91,
  };

  const first = await repo.finalizeAIRoleplayTurn(finalizeInput);
  const retry = await repo.finalizeAIRoleplayTurn(finalizeInput);

  assert.equal(first.turn.turn_index, 1);
  assert.equal(first.session.turn_count, 1);
  assert.deepEqual(first.session.mission_progress, { completed_goal_ids: ['order'] });
  assert.equal(first.session.model_used, 'gpt-roleplay');
  assert.equal(retry.turn.turn_index, 1);
  assert.equal(retry.session.turn_count, 1);
  assert.equal(fakeDb.sessions.get('505').turn_count, 1);
});

test('completion rejects while a turn is pending and leaves review summary untouched', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  fakeDb.addSession({ id: '506', user_id: '7', turn_count: 0 });
  fakeDb.addTurn({
    session_id: '506',
    turn_key: '56565656-5656-4656-8656-565656565656',
    turn_index: 1,
    status: 'pending',
    learner_text: 'Coffee, please.',
  });
  const repo = createRepository(fakeDb);

  await assert.rejects(
    repo.completeAIRoleplaySession({
      sessionId: '506',
      userId: '7',
      reviewSummary: { stale: true },
    }),
    (error) => error?.code === 'TURN_IN_PROGRESS',
  );

  assert.equal(fakeDb.sessions.get('506').status, 'active');
  assert.equal(fakeDb.sessions.get('506').review_summary, null);
});

test('pronunciation summary is resolved from a user-owned assessment with an allowlisted shape', async () => {
  const fakeDb = createRoleplayFakeDatabase();
  const repo = createRepository(fakeDb);

  const owned = await repo.getAIRoleplayPronunciationSummaryForUser('17', '7');
  const unowned = await repo.getAIRoleplayPronunciationSummaryForUser('17', '8');

  assert.deepEqual(owned, {
    trusted: true,
    owned_by_user: true,
    credible: true,
    assessment_id: '17',
    summary: '元音更稳定。',
  });
  assert.equal(unowned, null);
});
