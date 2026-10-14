const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AI_ROLEPLAY_WORD_LIMITS,
  normalizeCefrLevel,
  normalizeTranscript,
  validateTurnResult,
  buildFallbackTurn,
  buildReview,
} = require('../services/ai-roleplay/contracts');

test('AI_ROLEPLAY_WORD_LIMITS exports the canonical frozen CEFR mapping', () => {
  assert.deepEqual(AI_ROLEPLAY_WORD_LIMITS, {
    A1: 18,
    A2: 18,
    B1: 28,
    B2: 28,
    C1: 40,
  });
  assert.equal(Object.isFrozen(AI_ROLEPLAY_WORD_LIMITS), true);
});

test('normalizeCefrLevel clamps and uppercases supported levels', () => {
  assert.equal(normalizeCefrLevel('b1'), 'B1');
  assert.equal(normalizeCefrLevel('C2'), 'C1');
});

test('normalizeTranscript trims whitespace, removes control chars, and enforces the max length', () => {
  assert.equal(normalizeTranscript('  hello\u0000   world  '), 'hello world');
  assert.throws(() => normalizeTranscript('x'.repeat(1001)), /TRANSCRIPT_TOO_LONG/);
});

test('validateTurnResult filters unknown goal IDs, drops unsupported fields, and keeps only evidenced updates', () => {
  const modelPayload = {
    version: 1,
    assistant: {
      text: 'Sure, what drink would you like today at the cafe?',
      translation_zh: '当然，您今天想在咖啡馆喝点什么？',
      tone: 'helpful',
      ignored: true,
    },
    evaluation: {
      understood: true,
      goal_updates: [
        { goal_id: 'order', status: 'completed', evidence: 'I would like a coffee.' },
        { goal_id: 'unknown', status: 'completed', evidence: 'Hello there.' },
        { goal_id: 'greet', status: 'completed', evidence: 'Nice to meet you.' },
      ],
      correction: {
        original: 'I want coffee.',
        rewrite: "I'd like a coffee.",
        reason_zh: '更礼貌自然。',
        extra: 'drop-me',
      },
      suggested_phrase: {
        text: 'Could I have a latte, please?',
        meaning_zh: '请给我一杯拿铁，好吗？',
        extra: 'drop-me',
      },
      unknown_field: true,
    },
    controls: {
      should_end: false,
      needs_clarification: false,
      difficulty_adjustment: 'same',
      override_turn_limit: true,
    },
    extra_root: true,
  };

  const validated = validateTurnResult(modelPayload, {
    level: 'A2',
    allowedGoalIds: ['greet', 'order'],
    learnerTexts: ['Hello. I would like a coffee.'],
  });

  assert.equal(validated.assistant.text.split(/\s+/).length <= 18, true);
  assert.deepEqual(validated.evaluation.goal_updates.map((x) => x.goal_id), ['order']);
  assert.deepEqual(validated, {
    version: 1,
    assistant: {
      text: 'Sure, what drink would you like today at the cafe?',
      translation_zh: '当然，您今天想在咖啡馆喝点什么？',
      tone: 'helpful',
    },
    evaluation: {
      understood: true,
      goal_updates: [
        { goal_id: 'order', status: 'completed', evidence: 'I would like a coffee.' },
      ],
      correction: {
        original: 'I want coffee.',
        rewrite: "I'd like a coffee.",
        reason_zh: '更礼貌自然。',
      },
      suggested_phrase: {
        text: 'Could I have a latte, please?',
        meaning_zh: '请给我一杯拿铁，好吗？',
      },
    },
    controls: {
      should_end: false,
      needs_clarification: false,
      difficulty_adjustment: 'same',
    },
  });
});

test('validateTurnResult rejects invalid JSON-shaped values', () => {
  assert.throws(() => validateTurnResult({
    version: 1,
    assistant: {
      text: 'Okay.',
      translation_zh: '好的。',
      tone: 'helpful',
    },
    evaluation: {
      understood: 'yes',
      goal_updates: [],
      correction: null,
      suggested_phrase: null,
    },
    controls: {
      should_end: false,
      needs_clarification: false,
      difficulty_adjustment: 'same',
    },
  }, {
    level: 'A1',
    allowedGoalIds: ['greet'],
    learnerTexts: ['Hello'],
  }), /AI_TURN_INVALID/);
});

test('validateTurnResult rejects overlong model-controlled strings across the contract', () => {
  const overlong = 'x'.repeat(1001);
  const basePayload = {
    version: 1,
    assistant: {
      text: 'Okay, let us continue.',
      translation_zh: '好的，我们继续。',
      tone: 'helpful',
    },
    evaluation: {
      understood: true,
      goal_updates: [
        { goal_id: 'greet', status: 'completed', evidence: 'Hello there.' },
      ],
      correction: {
        original: 'I want coffee.',
        rewrite: "I'd like a coffee.",
        reason_zh: '更礼貌自然。',
      },
      suggested_phrase: {
        text: 'Could I have a coffee, please?',
        meaning_zh: '请给我一杯咖啡，好吗？',
      },
    },
    controls: {
      should_end: false,
      needs_clarification: false,
      difficulty_adjustment: 'same',
    },
  };
  const context = {
    level: 'A1',
    allowedGoalIds: ['greet'],
    learnerTexts: ['Hello there.'],
  };

  const variants = [
    {
      name: 'assistant.text',
      payload: {
        ...basePayload,
        assistant: { ...basePayload.assistant, text: overlong },
      },
    },
    {
      name: 'assistant.translation_zh',
      payload: {
        ...basePayload,
        assistant: { ...basePayload.assistant, translation_zh: overlong },
      },
    },
    {
      name: 'evaluation.goal_updates[0].evidence',
      payload: {
        ...basePayload,
        evaluation: {
          ...basePayload.evaluation,
          goal_updates: [{ goal_id: 'greet', status: 'completed', evidence: overlong }],
        },
      },
    },
    {
      name: 'evaluation.correction.original',
      payload: {
        ...basePayload,
        evaluation: {
          ...basePayload.evaluation,
          correction: { ...basePayload.evaluation.correction, original: overlong },
        },
      },
    },
    {
      name: 'evaluation.correction.rewrite',
      payload: {
        ...basePayload,
        evaluation: {
          ...basePayload.evaluation,
          correction: { ...basePayload.evaluation.correction, rewrite: overlong },
        },
      },
    },
    {
      name: 'evaluation.correction.reason_zh',
      payload: {
        ...basePayload,
        evaluation: {
          ...basePayload.evaluation,
          correction: { ...basePayload.evaluation.correction, reason_zh: overlong },
        },
      },
    },
    {
      name: 'evaluation.suggested_phrase.text',
      payload: {
        ...basePayload,
        evaluation: {
          ...basePayload.evaluation,
          suggested_phrase: { ...basePayload.evaluation.suggested_phrase, text: overlong },
        },
      },
    },
    {
      name: 'evaluation.suggested_phrase.meaning_zh',
      payload: {
        ...basePayload,
        evaluation: {
          ...basePayload.evaluation,
          suggested_phrase: { ...basePayload.evaluation.suggested_phrase, meaning_zh: overlong },
        },
      },
    },
  ];

  for (const { name, payload } of variants) {
    assert.throws(() => validateTurnResult(payload, context), /AI_TURN_INVALID/, name);
  }
});

test('buildFallbackTurn uses the first incomplete required goal and closes after the turn limit', () => {
  const fallback = buildFallbackTurn({
    scenario: {
      closer_prompt: 'Thanks for practicing today. See you next time.',
      clarification_prompt: 'Sorry, please say that again in a short sentence.',
      goals: [
        { id: 'greet', required: true, fallback_prompt: 'Please greet the clerk first.' },
        { id: 'order', required: true, fallback_prompt: 'Now order your drink clearly.' },
      ],
    },
    completedGoalIds: ['greet'],
    turnCount: 1,
    turnLimit: 3,
  });

  assert.equal(fallback.assistant.text, 'Now order your drink clearly.');
  assert.equal(fallback.controls.should_end, false);
  assert.equal(fallback.controls.needs_clarification, true);

  const closer = buildFallbackTurn({
    scenario: {
      closer_prompt: 'Thanks for practicing today. See you next time.',
      clarification_prompt: 'Sorry, please say that again in a short sentence.',
      goals: [
        { id: 'greet', required: true, fallback_prompt: 'Please greet the clerk first.' },
      ],
    },
    completedGoalIds: [],
    turnCount: 3,
    turnLimit: 3,
  });

  assert.equal(closer.assistant.text, 'Thanks for practicing today. See you next time.');
  assert.equal(closer.controls.should_end, true);
});

test('buildFallbackTurn clamps oversized turn limits and still forces closeout on turn 8', () => {
  const closer = buildFallbackTurn({
    scenario: {
      closer_prompt: 'Thanks for practicing today. See you next time.',
      clarification_prompt: 'Sorry, please say that again in a short sentence.',
      goals: [
        { id: 'greet', required: true, fallback_prompt: 'Please greet the clerk first.' },
      ],
    },
    completedGoalIds: [],
    turnCount: 8,
    turnLimit: 99,
  });

  assert.equal(closer.assistant.text, 'Thanks for practicing today. See you next time.');
  assert.equal(closer.controls.should_end, true);
});

test('buildReview omits pronunciation when no credible assessment is supplied', () => {
  const review = buildReview({
    scenarioGoals: [
      { id: 'greet', label_zh: '打招呼', required: true },
      { id: 'order', label_zh: '点单', required: true },
    ],
    turns: [
      {
        learner_text: 'Hello there.',
        evaluation: {
          understood: true,
          goal_updates: [{ goal_id: 'greet', status: 'completed', evidence: 'Hello there.' }],
          correction: null,
          suggested_phrase: null,
        },
      },
      {
        learner_text: 'I would like a coffee.',
        evaluation: {
          understood: true,
          goal_updates: [{ goal_id: 'order', status: 'completed', evidence: 'I would like a coffee.' }],
          correction: {
            original: 'I want coffee.',
            rewrite: "I'd like a coffee.",
            reason_zh: '更礼貌自然。',
          },
          suggested_phrase: {
            text: 'Could I have a coffee, please?',
            meaning_zh: '请给我一杯咖啡，好吗？',
          },
        },
      },
    ],
    pronunciationSummary: {
      credible: false,
      assessment_id: '17',
      score: 88,
    },
  });

  assert.deepEqual(review.goals, [
    { goal_id: 'greet', label_zh: '打招呼', completed: true, required: true },
    { goal_id: 'order', label_zh: '点单', completed: true, required: true },
  ]);
  assert.equal(review.best_turn.text, 'Hello there.');
  assert.deepEqual(review.correction, {
    original: 'I want coffee.',
    rewrite: "I'd like a coffee.",
    reason_zh: '更礼貌自然。',
  });
  assert.deepEqual(review.suggested_phrase, {
    text: 'Could I have a coffee, please?',
    meaning_zh: '请给我一杯咖啡，好吗？',
  });
  assert.equal('pronunciation' in review, false);
});

test('buildReview only includes trusted owned pronunciation summaries with an allowlisted shape', () => {
  const review = buildReview({
    scenarioGoals: [
      { id: 'greet', label_zh: '打招呼', required: true },
    ],
    turns: [
      {
        learner_text: 'Hello there.',
        evaluation: {
          understood: true,
          goal_updates: [{ goal_id: 'greet', status: 'completed', evidence: 'Hello there.' }],
          correction: null,
          suggested_phrase: null,
        },
      },
    ],
    pronunciationSummary: {
      trusted: true,
      owned_by_user: true,
      credible: true,
      assessment_id: '17',
      summary: '元音更稳定。',
      extra: 'drop-me',
    },
  });

  assert.deepEqual(review.pronunciation, {
    trusted: true,
    owned_by_user: true,
    credible: true,
    assessment_id: '17',
    summary: '元音更稳定。',
  });

  const unowned = buildReview({
    scenarioGoals: [],
    turns: [],
    pronunciationSummary: {
      trusted: true,
      owned_by_user: false,
      credible: true,
      assessment_id: '17',
      summary: '元音更稳定。',
    },
  });
  assert.equal('pronunciation' in unowned, false);

  const invalidId = buildReview({
    scenarioGoals: [],
    turns: [],
    pronunciationSummary: {
      trusted: true,
      owned_by_user: true,
      credible: true,
      assessment_id: '017',
      summary: '元音更稳定。',
    },
  });
  assert.equal('pronunciation' in invalidId, false);
});
