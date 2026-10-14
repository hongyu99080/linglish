'use strict';

const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
const AI_ROLEPLAY_WORD_LIMITS = Object.freeze({
  A1: 18,
  A2: 18,
  B1: 28,
  B2: 28,
  C1: 40,
});
const GOAL_STATUSES = new Set(['pending', 'completed']);
const DIFFICULTY_ADJUSTMENTS = new Set(['easier', 'same', 'harder']);
const TONES = new Set(['helpful', 'supportive', 'friendly', 'neutral']);
const MAX_MODEL_STRING_LENGTH = 1000;
const MAX_TURN_LIMIT = 8;
const CANONICAL_POSITIVE_DECIMAL = /^[1-9]\d*$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requiredString(raw, code = 'AI_TURN_INVALID', maxLength = MAX_MODEL_STRING_LENGTH) {
  const value = normalizeString(raw);
  if (!value || value.length > maxLength) {
    fail(code);
  }
  return value;
}

function normalizeCefrLevel(raw) {
  const upper = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (upper === 'C2') {
    return 'C1';
  }
  return CEFR_LEVELS.includes(upper) ? upper : 'A1';
}

function normalizeTranscript(raw) {
  if (typeof raw !== 'string') {
    fail('TRANSCRIPT_INVALID');
  }
  const transcript = normalizeString(raw);
  if (transcript.length > MAX_MODEL_STRING_LENGTH) {
    fail('TRANSCRIPT_TOO_LONG');
  }
  return transcript;
}

function wordLimitForLevel(level) {
  return AI_ROLEPLAY_WORD_LIMITS[normalizeCefrLevel(level)];
}

function ensureWordLimit(text, level) {
  const normalizedText = requiredString(text);
  const words = normalizedText.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > wordLimitForLevel(level)) {
    fail('AI_TURN_INVALID');
  }
  return words.join(' ');
}

function coerceNullableObject(value) {
  if (value == null) {
    return null;
  }
  if (!isPlainObject(value)) {
    fail('AI_TURN_INVALID');
  }
  return value;
}

function normalizeGoalUpdates(rawGoalUpdates, context) {
  if (!Array.isArray(rawGoalUpdates)) {
    fail('AI_TURN_INVALID');
  }

  const allowedGoalIds = new Set(context.allowedGoalIds || []);
  const learnerTexts = (context.learnerTexts || [])
    .map((text) => normalizeTranscript(text).toLowerCase());

  return rawGoalUpdates.flatMap((entry) => {
    if (!isPlainObject(entry)) {
      fail('AI_TURN_INVALID');
    }

    const goalId = requiredString(entry.goal_id);
    const status = requiredString(entry.status);
    const normalizedEvidence = requiredString(entry.evidence);

    if (!allowedGoalIds.has(goalId)) {
      return [];
    }
    if (!GOAL_STATUSES.has(status)) {
      fail('AI_TURN_INVALID');
    }

    const matched = learnerTexts.some((text) => text.includes(normalizedEvidence.toLowerCase()));
    if (!matched) {
      return [];
    }

    return [{
      goal_id: goalId,
      status,
      evidence: normalizedEvidence,
    }];
  });
}

function normalizeCorrection(rawCorrection) {
  const correction = coerceNullableObject(rawCorrection);
  if (!correction) {
    return null;
  }
  return {
    original: requiredString(correction.original),
    rewrite: requiredString(correction.rewrite),
    reason_zh: requiredString(correction.reason_zh),
  };
}

function normalizeSuggestedPhrase(rawSuggestedPhrase) {
  const suggestedPhrase = coerceNullableObject(rawSuggestedPhrase);
  if (!suggestedPhrase) {
    return null;
  }
  return {
    text: requiredString(suggestedPhrase.text),
    meaning_zh: requiredString(suggestedPhrase.meaning_zh),
  };
}

function validateTurnResult(raw, context) {
  if (!isPlainObject(raw) || !isPlainObject(context)) {
    fail('AI_TURN_INVALID');
  }
  if (raw.version !== 1) {
    fail('AI_TURN_INVALID');
  }
  if (!isPlainObject(raw.assistant) || !isPlainObject(raw.evaluation) || !isPlainObject(raw.controls)) {
    fail('AI_TURN_INVALID');
  }

  const tone = requiredString(raw.assistant.tone);
  if (!TONES.has(tone)) {
    fail('AI_TURN_INVALID');
  }

  const understood = raw.evaluation.understood;
  if (typeof understood !== 'boolean') {
    fail('AI_TURN_INVALID');
  }

  const difficultyAdjustment = requiredString(raw.controls.difficulty_adjustment);
  if (!DIFFICULTY_ADJUSTMENTS.has(difficultyAdjustment)) {
    fail('AI_TURN_INVALID');
  }
  if (typeof raw.controls.should_end !== 'boolean' || typeof raw.controls.needs_clarification !== 'boolean') {
    fail('AI_TURN_INVALID');
  }

  return {
    version: 1,
    assistant: {
      text: ensureWordLimit(raw.assistant.text, context.level),
      translation_zh: requiredString(raw.assistant.translation_zh),
      tone,
    },
    evaluation: {
      understood,
      goal_updates: normalizeGoalUpdates(raw.evaluation.goal_updates, context),
      correction: normalizeCorrection(raw.evaluation.correction),
      suggested_phrase: normalizeSuggestedPhrase(raw.evaluation.suggested_phrase),
    },
    controls: {
      should_end: raw.controls.should_end,
      needs_clarification: raw.controls.needs_clarification,
      difficulty_adjustment: difficultyAdjustment,
    },
  };
}

function canonicalTurn(assistantText, translationZh, overrides = {}) {
  return {
    version: 1,
    assistant: {
      text: requiredString(assistantText, 'AI_TURN_INVALID'),
      translation_zh: requiredString(translationZh, 'AI_TURN_INVALID'),
      tone: 'supportive',
    },
    evaluation: {
      understood: false,
      goal_updates: [],
      correction: null,
      suggested_phrase: null,
    },
    controls: {
      should_end: false,
      needs_clarification: true,
      difficulty_adjustment: 'same',
      ...overrides,
    },
  };
}

function buildFallbackTurn(input) {
  if (!isPlainObject(input) || !isPlainObject(input.scenario) || !Array.isArray(input.scenario.goals)) {
    fail('AI_TURN_INVALID');
  }

  const turnCount = Number.isInteger(input.turnCount) ? input.turnCount : 0;
  const turnLimit = Number.isInteger(input.turnLimit)
    ? Math.min(input.turnLimit, MAX_TURN_LIMIT)
    : 0;

  if (turnLimit > 0 && turnCount >= turnLimit) {
    return canonicalTurn(
      input.scenario.closer_prompt,
      input.scenario.closer_prompt,
      { should_end: true, needs_clarification: false }
    );
  }

  const completed = new Set(Array.isArray(input.completedGoalIds) ? input.completedGoalIds : []);
  const nextGoal = input.scenario.goals.find((goal) => goal && goal.required && !completed.has(goal.id));
  const prompt = nextGoal?.fallback_prompt || input.scenario.clarification_prompt;

  return canonicalTurn(prompt, input.scenario.clarification_prompt || prompt);
}

function completedGoalIdsFromTurns(turns) {
  const completed = new Set();
  for (const turn of turns) {
    if (!isPlainObject(turn) || !isPlainObject(turn.evaluation)) {
      continue;
    }
    const goalUpdates = Array.isArray(turn.evaluation.goal_updates) ? turn.evaluation.goal_updates : [];
    for (const update of goalUpdates) {
      if (isPlainObject(update) && update.status === 'completed' && typeof update.goal_id === 'string') {
        completed.add(update.goal_id);
      }
    }
  }
  return completed;
}

function strongestUnderstoodTurn(turns) {
  return turns.find((turn) => turn?.evaluation?.understood && normalizeString(turn.learner_text));
}

function latestDefined(turns, key) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const value = turns[index]?.evaluation?.[key];
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizePronunciationSummary(rawSummary) {
  if (!isPlainObject(rawSummary)) {
    return null;
  }
  if (rawSummary.trusted !== true || rawSummary.owned_by_user !== true || rawSummary.credible !== true) {
    return null;
  }

  const assessmentId = normalizeString(rawSummary.assessment_id);
  if (!CANONICAL_POSITIVE_DECIMAL.test(assessmentId)) {
    return null;
  }

  const summary = normalizeString(rawSummary.summary);
  if (!summary || summary.length > MAX_MODEL_STRING_LENGTH) {
    return null;
  }

  return {
    trusted: true,
    owned_by_user: true,
    credible: true,
    assessment_id: assessmentId,
    summary,
  };
}

function buildReview(input) {
  if (!isPlainObject(input) || !Array.isArray(input.scenarioGoals) || !Array.isArray(input.turns)) {
    fail('AI_TURN_INVALID');
  }

  const completedGoalIds = completedGoalIdsFromTurns(input.turns);
  const bestTurn = strongestUnderstoodTurn(input.turns);
  const correction = latestDefined(input.turns, 'correction');
  const suggestedPhrase = latestDefined(input.turns, 'suggested_phrase');

  const review = {
    goals: input.scenarioGoals.map((goal) => ({
      goal_id: requiredString(goal.id),
      label_zh: requiredString(goal.label_zh),
      completed: completedGoalIds.has(goal.id),
      required: !!goal.required,
    })),
    best_turn: {
      text: bestTurn ? normalizeString(bestTurn.learner_text) : '',
    },
    correction: correction ? {
      original: requiredString(correction.original),
      rewrite: requiredString(correction.rewrite),
      reason_zh: requiredString(correction.reason_zh),
    } : null,
    suggested_phrase: suggestedPhrase ? {
      text: requiredString(suggestedPhrase.text),
      meaning_zh: requiredString(suggestedPhrase.meaning_zh),
    } : null,
  };

  const pronunciation = normalizePronunciationSummary(input.pronunciationSummary);
  if (pronunciation) {
    review.pronunciation = pronunciation;
  }

  return review;
}

module.exports = {
  AI_ROLEPLAY_WORD_LIMITS,
  normalizeCefrLevel,
  normalizeTranscript,
  validateTurnResult,
  buildFallbackTurn,
  buildReview,
};
