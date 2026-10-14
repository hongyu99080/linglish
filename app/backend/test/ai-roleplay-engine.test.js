const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAIRoleplayEngine,
} = require('../services/ai-roleplay/engine');

const SAFE_TURN_KEY = '11111111-1111-4111-8111-111111111111';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validTurn(overrides = {}) {
  return {
    version: 1,
    assistant: {
      text: 'Sure, I can help you order coffee now.',
      translation_zh: '当然，我可以帮你点咖啡。',
      tone: 'helpful',
      ...(overrides.assistant || {}),
    },
    evaluation: {
      understood: true,
      goal_updates: [
        { goal_id: 'order', status: 'completed', evidence: 'coffee' },
      ],
      correction: null,
      suggested_phrase: null,
      ...(overrides.evaluation || {}),
    },
    controls: {
      should_end: false,
      needs_clarification: false,
      difficulty_adjustment: 'same',
      ...(overrides.controls || {}),
    },
  };
}

function createManualTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(callback, delayMs) {
      const entry = { callback, delayMs, cleared: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimeout(entry) {
      if (entry) entry.cleared = true;
    },
    fireNext() {
      const entry = scheduled.find((item) => !item.cleared);
      assert.ok(entry, 'expected a pending timer');
      entry.callback();
    },
  };
}

function createFakeRepository() {
  let nextSessionId = 101;
  let nextTurnId = 501;
  const calls = {
    createSession: 0,
    claim: 0,
    finalize: 0,
    complete: 0,
    pronunciation: 0,
  };
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
      goals: [
        {
          id: 'greet',
          label_zh: '打招呼',
          required: true,
          fallback_prompt: 'Please greet the clerk first.',
        },
        {
          id: 'order',
          label_zh: '点咖啡',
          required: true,
          fallback_prompt: 'Please order a drink clearly.',
        },
      ],
      target_phrases: [{ text: 'I would like a coffee.' }],
      fallback_turns: {
        clarification_prompt: 'Sorry, please say that again in a short sentence.',
        closer_prompt: 'Thanks for practicing today. See you next time.',
      },
      turn_limit: 4,
      is_active: true,
      sort_order: 10,
    }],
  ]);
  const sessions = new Map();
  const turns = new Map();
  const pronunciationAssessments = new Map([
    ['7:17', {
      trusted: true,
      owned_by_user: true,
      credible: true,
      assessment_id: '17',
      summary: '元音更稳定。',
    }],
  ]);

  function turnMapKey(sessionId, turnKey) {
    return `${String(sessionId)}:${String(turnKey)}`;
  }

  function sessionTurns(sessionId) {
    return [...turns.values()]
      .filter((turn) => turn.session_id === String(sessionId))
      .sort((a, b) => a.turn_index - b.turn_index);
  }

  function addSession({
    id = String(nextSessionId++),
    user_id = '7',
    scenario_id = 'coffee-order-a1',
    status = 'active',
    cefr_level = 'A1',
    turn_count = 0,
    turn_limit = 4,
    mission_progress = { completed_goal_ids: [] },
    review_summary = null,
  } = {}) {
    const session = {
      id: String(id),
      user_id: String(user_id),
      scenario_id,
      status,
      cefr_level,
      turn_count,
      turn_limit,
      mission_progress: clone(mission_progress),
      review_summary: clone(review_summary),
      model_used: null,
      completed_at: null,
    };
    sessions.set(session.id, session);
    return session;
  }

  function addCompletedTurn({
    session_id,
    turn_key = `${nextTurnId}`.padStart(8, '0') + '-2222-4222-8222-222222222222',
    turn_index = sessionTurns(session_id).length + 1,
    learner_text = 'I would like coffee.',
    result = validTurn(),
    pronunciation_summary = null,
    response_mode = 'ai',
    turn_result = clone(result),
  }) {
    const turn = {
      id: String(nextTurnId++),
      session_id: String(session_id),
      turn_key,
      turn_index,
      status: 'completed',
      learner_text,
      assistant_text: result.assistant.text,
      assistant_translation_zh: result.assistant.translation_zh,
      evaluation: clone(result.evaluation),
      turn_result: clone(turn_result),
      pronunciation_summary: clone(pronunciation_summary),
      response_mode,
      latency_ms: 17,
    };
    turns.set(turnMapKey(turn.session_id, turn.turn_key), turn);
    return turn;
  }

  async function listAIRoleplayScenarios(filters = {}) {
    let rows = [...scenarios.values()].filter((scenario) => scenario.is_active);
    if (filters.category) {
      rows = rows.filter((scenario) => scenario.category === filters.category);
    }
    return rows.map(clone);
  }

  async function getAIRoleplayScenario(id) {
    return clone(scenarios.get(String(id)) || null);
  }

  async function createAIRoleplaySession({ userId, scenarioId, cefrLevel, turnLimit }) {
    calls.createSession += 1;
    return clone(addSession({
      user_id: userId,
      scenario_id: scenarioId,
      cefr_level: cefrLevel,
      turn_limit: turnLimit,
    }));
  }

  async function getAIRoleplaySessionForUser(sessionId, userId, options = {}) {
    const session = sessions.get(String(sessionId));
    if (!session || session.user_id !== String(userId)) return null;
    const output = clone(session);
    if (options.includeTurns) {
      output.turns = sessionTurns(sessionId).map(clone);
    }
    return output;
  }

  async function listAIRoleplayTurnsForUser(sessionId, userId, limit = 50) {
    const session = sessions.get(String(sessionId));
    if (!session || session.user_id !== String(userId)) return [];
    return sessionTurns(sessionId).slice(-limit).map(clone);
  }

  async function claimAIRoleplayTurn({
    sessionId,
    userId,
    turnKey,
    transcript,
    pronunciationSummary,
    staleAfterMs,
  }) {
    calls.claim += 1;
    const session = sessions.get(String(sessionId));
    if (!session || session.user_id !== String(userId)) throw makeError('SESSION_NOT_FOUND');
    const existing = turns.get(turnMapKey(sessionId, turnKey));
    if (existing?.status === 'completed') {
      return { kind: 'completed', session: clone(session), turn: clone(existing) };
    }
    if (existing?.status === 'pending' && Number(staleAfterMs) <= 1) {
      return { kind: 'claimed', session: clone(session), turn: clone(existing) };
    }
    if (existing?.status === 'pending') {
      return { kind: 'pending', session: clone(session), turn: clone(existing) };
    }
    const pending = sessionTurns(sessionId).find((turn) => turn.status === 'pending');
    if (pending) {
      return { kind: 'pending', session: clone(session), turn: clone(pending) };
    }
    if (session.status !== 'active') throw makeError('SESSION_NOT_ACTIVE');
    if (session.turn_count >= session.turn_limit) throw makeError('TURN_LIMIT_REACHED');
    const turn = {
      id: String(nextTurnId++),
      session_id: String(sessionId),
      turn_key: turnKey,
      turn_index: session.turn_count + 1,
      status: 'pending',
      learner_text: transcript,
      assistant_text: null,
      assistant_translation_zh: null,
      evaluation: null,
      turn_result: null,
      pronunciation_summary: clone(pronunciationSummary),
      response_mode: null,
      latency_ms: null,
    };
    turns.set(turnMapKey(sessionId, turnKey), turn);
    return { kind: 'claimed', session: clone(session), turn: clone(turn) };
  }

  async function finalizeAIRoleplayTurn({
    sessionId,
    userId,
    turnKey,
    result,
    missionProgress,
    modelUsed,
    latencyMs,
  }) {
    calls.finalize += 1;
    const session = sessions.get(String(sessionId));
    if (!session || session.user_id !== String(userId)) throw makeError('SESSION_NOT_FOUND');
    const turn = turns.get(turnMapKey(sessionId, turnKey));
    if (!turn || turn.status !== 'pending') throw makeError('TURN_NOT_PENDING');
    turn.status = 'completed';
    turn.assistant_text = result.assistant.text;
    turn.assistant_translation_zh = result.assistant.translation_zh;
    turn.evaluation = clone(result.evaluation);
    turn.turn_result = clone(result);
    turn.response_mode = modelUsed === 'fallback' ? 'fallback' : 'ai';
    turn.latency_ms = latencyMs;
    session.turn_count += 1;
    session.mission_progress = clone(missionProgress);
    session.model_used = modelUsed;
    return { session: clone(session), turn: clone(turn) };
  }

  async function completeAIRoleplaySession({ sessionId, userId, reviewSummary }) {
    calls.complete += 1;
    const session = sessions.get(String(sessionId));
    if (!session || session.user_id !== String(userId)) throw makeError('SESSION_NOT_FOUND');
    if (session.status !== 'completed') {
      session.status = 'completed';
      session.completed_at = '2026-08-21T00:00:00.000Z';
      session.review_summary = clone(reviewSummary);
    }
    return clone(session);
  }

  async function getAIRoleplayPronunciationSummaryForUser(assessmentId, userId) {
    calls.pronunciation += 1;
    return clone(pronunciationAssessments.get(`${String(userId)}:${String(assessmentId)}`) || null);
  }

  return {
    calls,
    scenarios,
    sessions,
    turns,
    pronunciationAssessments,
    addSession,
    addCompletedTurn,
    listAIRoleplayScenarios,
    getAIRoleplayScenario,
    createAIRoleplaySession,
    getAIRoleplaySessionForUser,
    listAIRoleplayTurnsForUser,
    claimAIRoleplayTurn,
    finalizeAIRoleplayTurn,
    completeAIRoleplaySession,
    getAIRoleplayPronunciationSummaryForUser,
  };
}

function createEngineHarness(options = {}) {
  const repository = options.repository || createFakeRepository();
  const events = [];
  const nowValues = Array.isArray(options.nowValues)
    ? [...options.nowValues]
    : [1000, 1087, 1200, 1287, 1400, 1487];
  const engine = createAIRoleplayEngine({
    repository,
    generateTurn: options.generateTurn || (async () => validTurn()),
    createEvent: async (event) => {
      events.push(clone(event));
    },
    now: () => new Date(nowValues.length ? nowValues.shift() : 2000),
    timeoutMs: options.timeoutMs,
    staleAfterMs: options.staleAfterMs,
    timers: options.timers,
  });
  return { engine, repository, events };
}

function assertNoUnsafeTextInEventProperties(events, unsafeTexts) {
  for (const event of events) {
    const properties = JSON.stringify(event.properties || {});
    for (const unsafeText of unsafeTexts) {
      assert.equal(
        properties.includes(unsafeText),
        false,
        `event properties leaked unsafe text: ${unsafeText}`,
      );
    }
  }
}

test('advanceTurn rejects a concurrent same-key request but same-key retry returns the stored turn', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '101', user_id: '7' });
  let generatorCalls = 0;
  const { engine } = createEngineHarness({
    repository,
    generateTurn: async () => {
      generatorCalls += 1;
      return validTurn();
    },
  });
  const turnInput = {
    turnKey: SAFE_TURN_KEY,
    transcript: 'I would like coffee.',
  };

  const [a, b] = await Promise.allSettled([
    engine.advanceTurn('7', '101', turnInput),
    engine.advanceTurn('7', '101', turnInput),
  ]);

  assert.equal(generatorCalls, 1);
  assert.equal([a, b].filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal([a, b].filter((x) => x.status === 'rejected')[0].reason.code, 'TURN_IN_PROGRESS');

  const retry = await engine.advanceTurn('7', '101', turnInput);
  assert.equal(generatorCalls, 1);
  assert.equal(retry.turn.assistant.text, 'Sure, I can help you order coffee now.');
  assert.equal(retry.turn.response_mode, 'ai');
});

test('engine keeps repository ownership rejection scoped and does not invoke the generator', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '201', user_id: '7' });
  let generatorCalls = 0;
  const { engine } = createEngineHarness({
    repository,
    generateTurn: async () => {
      generatorCalls += 1;
      return validTurn();
    },
  });

  await assert.rejects(
    engine.getSession('8', '201'),
    (error) => error?.code === 'SESSION_NOT_FOUND',
  );
  await assert.rejects(
    engine.advanceTurn('8', '201', {
      turnKey: '22222222-2222-4222-8222-222222222222',
      transcript: 'I would like coffee.',
    }),
    (error) => error?.code === 'SESSION_NOT_FOUND',
  );
  assert.equal(generatorCalls, 0);
});

test('advanceTurn rejects transcripts over 1000 characters before claim or generation', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '301', user_id: '7' });
  let generatorCalls = 0;
  const { engine } = createEngineHarness({
    repository,
    generateTurn: async () => {
      generatorCalls += 1;
      return validTurn();
    },
  });

  await assert.rejects(
    engine.advanceTurn('7', '301', {
      turnKey: '33333333-3333-4333-8333-333333333333',
      transcript: 'x'.repeat(1001),
    }),
    (error) => error?.code === 'TRANSCRIPT_TOO_LONG',
  );
  assert.equal(repository.calls.claim, 0);
  assert.equal(generatorCalls, 0);
});

test('startSession rejects an unknown scenario without creating a session', async () => {
  const repository = createFakeRepository();
  const { engine } = createEngineHarness({ repository });

  await assert.rejects(
    engine.startSession('7', { scenarioId: 'missing-scenario', cefrLevel: 'A1' }),
    (error) => error?.code === 'SCENARIO_NOT_FOUND',
  );
  assert.equal(repository.calls.createSession, 0);
});

test('advanceTurn completes the session when the finalized turn reaches the turn limit', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '401', user_id: '7', turn_count: 1, turn_limit: 2 });
  const { engine } = createEngineHarness({
    repository,
    generateTurn: async () => validTurn({ controls: { should_end: false } }),
  });

  const output = await engine.advanceTurn('7', '401', {
    turnKey: '44444444-4444-4444-8444-444444444444',
    transcript: 'I would like coffee.',
  });

  assert.equal(output.session.status, 'completed');
  assert.equal(repository.sessions.get('401').status, 'completed');
  assert.deepEqual(repository.sessions.get('401').review_summary.goals.map((goal) => goal.completed), [false, true]);
});

test('advanceTurn ignores model should_end until deterministic required goals are complete', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '402', user_id: '7', turn_count: 0, turn_limit: 4 });
  const { engine } = createEngineHarness({
    repository,
    generateTurn: async () => validTurn({
      controls: { should_end: true },
      evaluation: {
        understood: true,
        goal_updates: [{ goal_id: 'order', status: 'completed', evidence: 'coffee' }],
      },
    }),
  });

  const output = await engine.advanceTurn('7', '402', {
    turnKey: '44444444-4444-4444-9444-444444444444',
    transcript: 'I would like coffee.',
  });

  assert.equal(output.session.status, 'active');
  assert.equal(repository.calls.complete, 0);
  assert.equal(repository.sessions.get('402').status, 'active');
});

test('completed-key retry reconstructs canonical turn result and resumes deterministic completion', async () => {
  const repository = createFakeRepository();
  repository.addSession({
    id: '403',
    user_id: '7',
    turn_count: 1,
    turn_limit: 4,
    mission_progress: { completed_goal_ids: ['greet', 'order'] },
  });
  const canonical = validTurn({
    assistant: {
      text: 'You ordered coffee politely.',
      translation_zh: '你礼貌地点了咖啡。',
      tone: 'friendly',
    },
    evaluation: {
      understood: true,
      goal_updates: [
        { goal_id: 'greet', status: 'completed', evidence: 'Hello' },
        { goal_id: 'order', status: 'completed', evidence: 'coffee' },
      ],
    },
    controls: {
      should_end: false,
      needs_clarification: false,
      difficulty_adjustment: 'harder',
    },
  });
  repository.addCompletedTurn({
    session_id: '403',
    turn_key: '44444444-4444-4444-a444-444444444444',
    turn_index: 1,
    learner_text: 'Hello. I would like coffee.',
    result: canonical,
    turn_result: canonical,
  });
  let generatorCalls = 0;
  const { engine } = createEngineHarness({
    repository,
    generateTurn: async () => {
      generatorCalls += 1;
      return validTurn();
    },
  });

  const retry = await engine.advanceTurn('7', '403', {
    turnKey: '44444444-4444-4444-a444-444444444444',
    transcript: 'Hello. I would like coffee.',
  });

  assert.equal(generatorCalls, 0);
  assert.equal(retry.turn.assistant.tone, 'friendly');
  assert.deepEqual(retry.turn.controls, {
    should_end: false,
    needs_clarification: false,
    difficulty_adjustment: 'harder',
  });
  assert.equal(retry.session.status, 'completed');
  assert.equal(repository.calls.complete, 1);
});

test('advanceTurn falls back deterministically for invalid model output', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '501', user_id: '7' });
  const { engine, events } = createEngineHarness({
    repository,
    generateTurn: async () => ({ version: 1, assistant: { text: '' } }),
  });

  const output = await engine.advanceTurn('7', '501', {
    turnKey: '55555555-5555-4555-8555-555555555555',
    transcript: 'unclear words',
  });

  assert.equal(output.turn.response_mode, 'fallback');
  assert.equal(output.turn.assistant.text, 'Please greet the clerk first.');
  assert.equal(output.turn.evaluation.understood, false);
  assert.equal(events.at(-1).properties.reason_code, 'AI_TURN_INVALID');
});

test('advanceTurn falls back for rejected generation without leaking transcript or provider text to events', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '601', user_id: '7' });
  const secretTranscript = 'coffee with private allergy note';
  const providerError = new Error(`provider echoed ${secretTranscript}`);
  providerError.body = { text: 'assistant private body' };
  const { engine, events } = createEngineHarness({
    repository,
    generateTurn: async () => {
      throw providerError;
    },
  });

  const output = await engine.advanceTurn('7', '601', {
    turnKey: '66666666-6666-4666-8666-666666666666',
    transcript: secretTranscript,
  });

  assert.equal(output.turn.response_mode, 'fallback');
  assert.deepEqual(events.at(-1).properties, {
    scenario_id: 'coffee-order-a1',
    turn_index: 1,
    turn_status: 'completed',
    required_goal_count: 2,
    completed_goal_count: 0,
    response_mode: 'fallback',
    reason_code: 'GENERATOR_REJECTED',
    latency_ms: 87,
  });
  assertNoUnsafeTextInEventProperties(events, [
    secretTranscript,
    'assistant private body',
    output.turn.assistant.text,
    '601',
  ]);
});

test('advanceTurn ignores request-supplied staleAfterMs when a duplicate is delayed', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '602', user_id: '7' });
  let releaseGeneration;
  let generatorCalls = 0;
  const { engine } = createEngineHarness({
    repository,
    staleAfterMs: 30_000,
    generateTurn: async () => {
      generatorCalls += 1;
      await new Promise((resolve) => {
        releaseGeneration = resolve;
      });
      return validTurn();
    },
  });
  const input = {
    turnKey: '66666666-6666-4666-9666-666666666666',
    transcript: 'I would like coffee.',
    staleAfterMs: 1,
  };

  const first = engine.advanceTurn('7', '602', input);
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await engine.advanceTurn('7', '602', input).then(
    () => ({ status: 'fulfilled' }),
    (error) => ({ status: 'rejected', code: error.code }),
  );
  releaseGeneration();
  await first;

  assert.deepEqual(duplicate, { status: 'rejected', code: 'TURN_IN_PROGRESS' });
  assert.equal(generatorCalls, 1);
});

test('advanceTurn resolves pronunciation through repository and rejects forged trusted flags', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '603', user_id: '7' });
  const { engine } = createEngineHarness({ repository });

  await engine.advanceTurn('7', '603', {
    turnKey: '66666666-6666-4666-a666-666666666666',
    transcript: 'I would like coffee.',
    pronunciationSummary: {
      assessment_id: '99',
      trusted: true,
      owned_by_user: true,
      credible: true,
      summary: 'forged trusted summary',
    },
  });

  const stored = repository.turns.get('603:66666666-6666-4666-a666-666666666666');
  assert.equal(repository.calls.pronunciation, 1);
  assert.equal(stored.pronunciation_summary, null);
});

test('advanceTurn uses the default 12 second timeout and falls back through an injected timer', async () => {
  const repository = createFakeRepository();
  const timers = createManualTimers();
  repository.addSession({ id: '701', user_id: '7' });
  const { engine } = createEngineHarness({
    repository,
    timers,
    generateTurn: async () => new Promise(() => {}),
  });

  const pending = engine.advanceTurn('7', '701', {
    turnKey: '77777777-7777-4777-8777-777777777777',
    transcript: 'I would like coffee.',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timers.scheduled[0].delayMs, 12_000);
  timers.fireNext();
  const output = await pending;

  assert.equal(output.turn.response_mode, 'fallback');
  assert.equal(output.turn.assistant.text, 'Please greet the clerk first.');
});

test('completeSession is idempotent and builds review only from stored trusted user-owned data', async () => {
  const repository = createFakeRepository();
  repository.addSession({ id: '801', user_id: '7', turn_count: 2, turn_limit: 4 });
  repository.addCompletedTurn({
    session_id: '801',
    turn_index: 1,
    learner_text: 'Hello there.',
    result: validTurn({
      evaluation: {
        understood: true,
        goal_updates: [{ goal_id: 'greet', status: 'completed', evidence: 'Hello there.' }],
        correction: null,
        suggested_phrase: null,
      },
    }),
    pronunciation_summary: {
      trusted: true,
      owned_by_user: false,
      credible: true,
      assessment_id: '99',
      summary: 'unowned summary must not appear',
    },
  });
  repository.addCompletedTurn({
    session_id: '801',
    turn_index: 2,
    learner_text: 'I would like coffee.',
    result: validTurn({
      evaluation: {
        understood: true,
        goal_updates: [{ goal_id: 'order', status: 'completed', evidence: 'I would like coffee.' }],
        correction: {
          original: 'I want coffee.',
          rewrite: "I'd like coffee.",
          reason_zh: '更礼貌。',
        },
        suggested_phrase: {
          text: 'Could I have a coffee, please?',
          meaning_zh: '请给我一杯咖啡，好吗？',
        },
      },
    }),
    pronunciation_summary: {
      trusted: true,
      owned_by_user: true,
      credible: true,
      assessment_id: '17',
      summary: '元音更稳定。',
      raw_transcript: 'must be dropped',
    },
  });
  const { engine } = createEngineHarness({ repository });

  const first = await engine.completeSession('7', '801');
  const second = await engine.completeSession('7', '801');

  assert.equal(repository.calls.complete, 1);
  assert.deepEqual(first.review_summary, second.review_summary);
  assert.deepEqual(first.review_summary.goals, [
    { goal_id: 'greet', label_zh: '打招呼', completed: true, required: true },
    { goal_id: 'order', label_zh: '点咖啡', completed: true, required: true },
  ]);
  assert.equal(first.review_summary.best_turn.text, 'Hello there.');
  assert.deepEqual(first.review_summary.pronunciation, {
    trusted: true,
    owned_by_user: true,
    credible: true,
    assessment_id: '17',
    summary: '元音更稳定。',
  });
  assert.equal(JSON.stringify(first.review_summary).includes('unowned summary must not appear'), false);
  assert.equal(JSON.stringify(first.review_summary).includes('must be dropped'), false);
});
