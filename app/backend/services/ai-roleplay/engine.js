'use strict';

const {
  normalizeCefrLevel,
  normalizeTranscript,
  validateTurnResult,
  buildFallbackTurn,
  buildReview,
} = require('./contracts');

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const MAX_CONTEXT_TURNS = 6;
const MAX_REVIEW_ITEMS = 3;
const MAX_REVIEW_VALUE_LENGTH = 600;
const REVIEW_SAVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CANONICAL_DECIMAL_ID = /^[1-9]\d*$/;

function fail(code, status) {
  const error = new Error(code);
  error.code = code;
  if (status) error.status = status;
  throw error;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeReviewText(value) {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= MAX_REVIEW_VALUE_LENGTH ? normalized : '';
}

function requestedReviewItems(input) {
  const items = input?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_REVIEW_ITEMS) {
    fail('REVIEW_ITEMS_INVALID', 400);
  }
  return items.map((item) => {
    if (!isPlainObject(item)) fail('REVIEW_ITEMS_INVALID', 400);
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const value = normalizeReviewText(item.value);
    if (!['correction', 'suggested_phrase', 'pronunciation'].includes(kind) || !value) {
      fail('REVIEW_ITEM_NOT_ALLOWED', 400);
    }
    return { kind, value };
  });
}

function reviewPhraseCandidates(reviewSummary) {
  const candidates = new Map();
  const correction = reviewSummary?.correction;
  const correctionValue = normalizeReviewText(correction?.rewrite);
  if (correctionValue) {
    candidates.set(`correction\u0000${correctionValue}`, {
      kind: 'phrase',
      source_kind: 'correction',
      value: correctionValue,
      meaning_zh: normalizeReviewText(correction?.meaning_zh),
    });
  }
  const suggested = reviewSummary?.suggested_phrase;
  const suggestedValue = normalizeReviewText(suggested?.text);
  if (suggestedValue) {
    candidates.set(`suggested_phrase\u0000${suggestedValue}`, {
      kind: 'phrase',
      source_kind: 'suggested_phrase',
      value: suggestedValue,
      meaning_zh: normalizeReviewText(suggested?.meaning_zh),
    });
  }
  return candidates;
}

function toEpochMs(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function strictEpochMs(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function elapsedMs(now, startedAtMs) {
  return Math.max(0, toEpochMs(now()) - startedAtMs);
}

function normalizeReasonCode(error) {
  if (error?.code === 'AI_TURN_TIMEOUT') return 'AI_TURN_TIMEOUT';
  if (error?.code === 'AI_TURN_INVALID_JSON') return 'AI_TURN_INVALID_JSON';
  if (error?.code === 'AI_TURN_INVALID') return 'AI_TURN_INVALID';
  if (error?.code === 'TRANSCRIPT_INVALID') return 'TRANSCRIPT_INVALID';
  if (error?.code === 'TRANSCRIPT_TOO_LONG') return 'TRANSCRIPT_TOO_LONG';
  return 'GENERATOR_REJECTED';
}

function normalizeGoals(rawGoals) {
  if (!Array.isArray(rawGoals)) return [];
  return rawGoals
    .filter((goal) => isPlainObject(goal) && goal.id)
    .map((goal) => ({
      id: String(goal.id),
      label_zh: String(goal.label_zh || goal.label || goal.title_zh || goal.id),
      required: !!goal.required,
      fallback_prompt: String(goal.fallback_prompt || goal.prompt || 'Please answer with a short sentence.'),
    }));
}

function normalizeScenarioForContract(scenario) {
  const fallbackTurns = isPlainObject(scenario?.fallback_turns) ? scenario.fallback_turns : {};
  return {
    ...clone(scenario),
    goals: normalizeGoals(scenario?.goals),
    clarification_prompt: String(
      scenario?.clarification_prompt
      || fallbackTurns.clarification_prompt
      || 'Sorry, please say that again in a short sentence.',
    ),
    closer_prompt: String(
      scenario?.closer_prompt
      || fallbackTurns.closer_prompt
      || 'Thanks for practicing today. See you next time.',
    ),
  };
}

function completedGoalIdsFromTurns(turns) {
  const completed = new Set();
  for (const turn of turns || []) {
    const updates = Array.isArray(turn?.evaluation?.goal_updates)
      ? turn.evaluation.goal_updates
      : [];
    for (const update of updates) {
      if (update?.status === 'completed' && update.goal_id) {
        completed.add(String(update.goal_id));
      }
    }
  }
  return completed;
}

function mergeCompletedGoalIds(turns, result, scenario) {
  const completed = completedGoalIdsFromTurns(turns);
  const updates = Array.isArray(result?.evaluation?.goal_updates)
    ? result.evaluation.goal_updates
    : [];
  for (const update of updates) {
    if (update?.status === 'completed' && update.goal_id) {
      completed.add(String(update.goal_id));
    }
  }
  const ordered = normalizeGoals(scenario.goals)
    .map((goal) => goal.id)
    .filter((goalId) => completed.has(goalId));
  return ordered;
}

function requiredGoalIds(scenario) {
  return normalizeGoals(scenario.goals)
    .filter((goal) => goal.required)
    .map((goal) => goal.id);
}

function shouldCompleteSession(session, scenario, turns, result = null) {
  if (Number(session.turn_count) >= Number(session.turn_limit)) {
    return true;
  }
  const required = requiredGoalIds(scenario);
  if (!required.length) {
    return false;
  }
  const completed = new Set(mergeCompletedGoalIds(turns, result, scenario));
  return required.every((goalId) => completed.has(goalId));
}

function serializeTurn(row, resultOverride = null) {
  const result = resultOverride || row?.turn_result || null;
  const assistantText = result?.assistant?.text ?? row?.assistant_text ?? '';
  const assistantTranslation = result?.assistant?.translation_zh ?? row?.assistant_translation_zh ?? '';
  return {
    ...clone(row),
    assistant: {
      text: assistantText,
      translation_zh: assistantTranslation,
      tone: result?.assistant?.tone,
    },
    evaluation: clone(result?.evaluation ?? row?.evaluation ?? null),
    controls: clone(result?.controls ?? row?.controls ?? null),
  };
}

function serializeSession(session) {
  return clone(session);
}

function latestTrustedPronunciationSummary(turns) {
  for (let index = (turns || []).length - 1; index >= 0; index -= 1) {
    const summary = turns[index]?.pronunciation_summary;
    if (
      summary?.trusted === true
      && summary?.owned_by_user === true
      && summary?.credible === true
    ) {
      return clone(summary);
    }
  }
  return null;
}

function completedTurnsOnly(turns) {
  return (turns || []).filter((turn) => turn?.status === 'completed');
}

function publicScenario(scenario) {
  return clone(scenario);
}

function buildGeneratorContext({ scenario, session, turn, transcript, turns, completedGoalIds }) {
  const completedTurns = (turns || [])
    .filter((item) => item.status === 'completed')
    .slice(-MAX_CONTEXT_TURNS)
    .map((item) => ({
      turn_index: item.turn_index,
      learner_text: item.learner_text ? normalizeTranscript(item.learner_text) : '',
      assistant_text: item.assistant_text || '',
      evaluation: clone(item.evaluation || null),
    }));

  return {
    scenario: {
      id: scenario.id,
      title_zh: scenario.title_zh,
      title_en: scenario.title_en,
      learner_role: scenario.learner_role,
      assistant_role: scenario.assistant_role,
      goals: normalizeGoals(scenario.goals),
      target_phrases: clone(scenario.target_phrases || []),
      clarification_prompt: scenario.clarification_prompt,
      closer_prompt: scenario.closer_prompt,
    },
    cefrLevel: normalizeCefrLevel(session.cefr_level),
    completedGoalIds: [...completedGoalIds],
    transcript,
    turnIndex: turn.turn_index,
    turnLimit: session.turn_limit,
    recentTurns: completedTurns,
  };
}

function createTimeoutError() {
  const error = new Error('AI_TURN_TIMEOUT');
  error.code = 'AI_TURN_TIMEOUT';
  return error;
}

async function withTimeout(work, timeoutMs, timers) {
  let timeoutRef = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutRef = timers.setTimeout(() => reject(createTimeoutError()), timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(work),
      timeoutPromise,
    ]);
  } finally {
    timers.clearTimeout(timeoutRef);
  }
}

function createAIRoleplayEngine({
  repository,
  generateTurn,
  saveReviewItem = null,
  createEvent = async () => {},
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  timers = globalThis,
} = {}) {
  if (!repository || typeof generateTurn !== 'function') {
    fail('AI_ROLEPLAY_ENGINE_INVALID');
  }

  async function emitEvent(name, userId, properties) {
    try {
      await createEvent({
        name,
        userId: String(userId),
        properties: clone(properties),
      });
    } catch (_) {
      // Analytics must not alter the roleplay state machine.
    }
  }

  async function loadOwnedSession(userId, sessionId, options = {}) {
    const session = await repository.getAIRoleplaySessionForUser(sessionId, userId, options);
    if (!session) fail('SESSION_NOT_FOUND', 404);
    return session;
  }

  async function loadScenario(scenarioId) {
    const scenario = await repository.getAIRoleplayScenario(scenarioId);
    if (!scenario || scenario.is_active === false) fail('SCENARIO_NOT_FOUND', 404);
    return normalizeScenarioForContract(scenario);
  }

  async function listScenarios(_userId, filters = {}) {
    const scenarios = await repository.listAIRoleplayScenarios(filters);
    return scenarios.map(publicScenario);
  }

  async function startSession(userId, input = {}) {
    const scenarioId = input.scenarioId || input.scenario_id;
    const scenario = await loadScenario(scenarioId);
    const session = await repository.createAIRoleplaySession({
      userId,
      scenarioId: scenario.id,
      cefrLevel: normalizeCefrLevel(input.cefrLevel || input.cefr_level || scenario.cefr_min),
      turnLimit: scenario.turn_limit,
      source: input.source || 'catalog',
      expiresAt: input.expiresAt || input.expires_at || null,
    });
    return {
      session: serializeSession(session),
      scenario: publicScenario(scenario),
      opening_turn: {
        assistant: {
          text: scenario.opening_line,
          translation_zh: scenario.opening_translation_zh,
        },
      },
    };
  }

  async function getSession(userId, sessionId) {
    const session = await loadOwnedSession(userId, sessionId, { includeTurns: true, turnLimit: 50 });
    return {
      session: serializeSession({
        ...session,
        turns: (session.turns || []).map((turn) => serializeTurn(turn)),
      }),
    };
  }

  async function completeSession(userId, sessionId) {
    const session = await loadOwnedSession(userId, sessionId, { includeTurns: true, turnLimit: 50 });
    if (session.status === 'completed' && session.review_summary) {
      return serializeSession(session);
    }

    const scenario = await loadScenario(session.scenario_id);
    const turns = Array.isArray(session.turns)
      ? session.turns
      : await repository.listAIRoleplayTurnsForUser(sessionId, userId, 50);
    const completedTurns = completedTurnsOnly(turns);
    const reviewSummary = buildReview({
      scenarioGoals: normalizeGoals(scenario.goals),
      turns: completedTurns,
      pronunciationSummary: latestTrustedPronunciationSummary(completedTurns),
    });
    const completed = await repository.completeAIRoleplaySession({
      sessionId,
      userId,
      reviewSummary,
    });
    return serializeSession({
      ...completed,
      review_summary: completed.review_summary || reviewSummary,
    });
  }

  async function saveReviewItems(userId, sessionId, input = {}) {
    const session = await loadOwnedSession(userId, sessionId);
    if (session.status !== 'completed' || !isPlainObject(session.review_summary)) {
      fail('SESSION_NOT_COMPLETED', 409);
    }

    const completedAtMs = strictEpochMs(session.completed_at);
    const nowMs = strictEpochMs(now());
    if (
      !Number.isFinite(completedAtMs)
      || !Number.isFinite(nowMs)
      || completedAtMs < nowMs - REVIEW_SAVE_WINDOW_MS
    ) {
      fail('REVIEW_WINDOW_EXPIRED', 409);
    }

    const requested = requestedReviewItems(input);
    const phraseCandidates = reviewPhraseCandidates(session.review_summary);
    const canonicalItems = [];
    for (const item of requested) {
      if (item.kind === 'pronunciation') {
        const persistedAssessmentId = String(session.review_summary?.pronunciation?.assessment_id || '');
        if (!CANONICAL_DECIMAL_ID.test(item.value) || item.value !== persistedAssessmentId) {
          fail('REVIEW_ITEM_NOT_ALLOWED', 400);
        }
        const assessment = typeof repository.getAIRoleplayPronunciationSummaryForUser === 'function'
          ? await repository.getAIRoleplayPronunciationSummaryForUser(item.value, userId)
          : null;
        if (
          !assessment
          || assessment.trusted !== true
          || assessment.owned_by_user !== true
          || assessment.credible !== true
          || String(assessment.assessment_id) !== item.value
        ) {
          fail('REVIEW_ITEM_NOT_ALLOWED', 400);
        }
        canonicalItems.push({
          kind: 'pronunciation',
          source_kind: 'pronunciation',
          assessment_id: item.value,
        });
        continue;
      }

      const candidate = phraseCandidates.get(`${item.kind}\u0000${item.value}`);
      if (!candidate) fail('REVIEW_ITEM_NOT_ALLOWED', 400);
      canonicalItems.push(candidate);
    }

    const context = {
      scenario_id: String(session.scenario_id),
      session_id: String(session.id),
    };
    const results = [];
    for (const item of canonicalItems) {
      if (item.kind === 'pronunciation') {
        results.push({
          kind: 'existing',
          item_kind: item.source_kind,
        });
        await emitEvent('ai_roleplay_review_item_saved', userId, {
          item_kind: item.source_kind,
          item_count: 1,
          status: 'existing',
          reason: 'ALREADY_TRACKED',
        });
        continue;
      }

      let saved;
      try {
        if (typeof saveReviewItem !== 'function') throw new Error('REVIEW_ITEM_SAVE_UNAVAILABLE');
        saved = await saveReviewItem(String(userId), clone(item), context);
        if (!['saved', 'existing'].includes(saved?.kind)) throw new Error('REVIEW_ITEM_SAVE_INVALID');
      } catch (_) {
        results.push({
          kind: 'failed',
          item_kind: item.source_kind,
          code: 'REVIEW_ITEM_SAVE_FAILED',
        });
        await emitEvent('ai_roleplay_review_item_saved', userId, {
          item_kind: item.source_kind,
          item_count: 1,
          status: 'failed',
          reason: 'SAVE_FAILED',
        });
        continue;
      }
      const kind = saved.kind;
      const result = {
        kind,
        item_kind: item.source_kind,
      };
      if (saved?.item_id != null && CANONICAL_DECIMAL_ID.test(String(saved.item_id))) {
        result.item_id = String(saved.item_id);
      }
      results.push(result);
      await emitEvent('ai_roleplay_review_item_saved', userId, {
        item_kind: item.source_kind,
        item_count: 1,
        status: kind,
        reason: 'OK',
      });
    }
    return { items: results };
  }

  async function advanceTurn(userId, sessionId, input = {}) {
    const transcript = normalizeTranscript(input.transcript);
    const turnKey = input.turnKey || input.turn_key;
    const requestedPronunciation = input.pronunciationSummary || input.pronunciation_summary || null;
    const assessmentId = requestedPronunciation?.assessment_id;
    const pronunciationSummary = assessmentId && typeof repository.getAIRoleplayPronunciationSummaryForUser === 'function'
      ? await repository.getAIRoleplayPronunciationSummaryForUser(assessmentId, userId)
      : null;
    const claim = await repository.claimAIRoleplayTurn({
      sessionId,
      userId,
      turnKey,
      transcript,
      pronunciationSummary,
      staleAfterMs,
    });

    if (claim.kind === 'completed') {
      const scenario = await loadScenario(claim.session.scenario_id);
      const turns = await repository.listAIRoleplayTurnsForUser(sessionId, userId, 50);
      let session = claim.session;
      if (session.status === 'active' && shouldCompleteSession(session, scenario, completedTurnsOnly(turns))) {
        session = await completeSession(userId, sessionId);
      }
      return {
        session: serializeSession(session),
        turn: serializeTurn(claim.turn),
      };
    }
    if (claim.kind === 'pending') {
      fail('TURN_IN_PROGRESS', 409);
    }
    if (claim.kind !== 'claimed') {
      fail('TURN_CLAIM_INVALID');
    }

    const scenario = await loadScenario(claim.session.scenario_id);
    const turns = await repository.listAIRoleplayTurnsForUser(sessionId, userId, 50);
    const previousTurns = turns.filter((turn) => turn.status === 'completed');
    const completedGoalIds = completedGoalIdsFromTurns(previousTurns);
    const validationContext = {
      level: claim.session.cefr_level,
      allowedGoalIds: normalizeGoals(scenario.goals).map((goal) => goal.id),
      learnerTexts: [transcript],
    };
    const fallbackInput = {
      scenario,
      completedGoalIds: [...completedGoalIds],
      turnCount: claim.turn.turn_index,
      turnLimit: claim.session.turn_limit,
    };

    let result;
    let responseMode = 'ai';
    let reasonCode = 'OK';
    const startedAtMs = toEpochMs(now());
    try {
      const context = buildGeneratorContext({
        scenario,
        session: claim.session,
        turn: claim.turn,
        transcript,
        turns,
        completedGoalIds,
      });
      const rawResult = await withTimeout(
        () => generateTurn(context),
        timeoutMs,
        timers,
      );
      result = validateTurnResult(rawResult, validationContext);
    } catch (error) {
      responseMode = 'fallback';
      reasonCode = normalizeReasonCode(error);
      result = buildFallbackTurn(fallbackInput);
    }

    const latencyMs = elapsedMs(now, startedAtMs);
    const completedGoalIdsAfterTurn = mergeCompletedGoalIds(previousTurns, result, scenario);
    const finalized = await repository.finalizeAIRoleplayTurn({
      sessionId,
      userId,
      turnKey,
      result,
      missionProgress: {
        completed_goal_ids: completedGoalIdsAfterTurn,
      },
      modelUsed: responseMode,
      latencyMs,
    });

    const requiredCount = requiredGoalIds(scenario).length;
    await emitEvent('ai_roleplay_turn_completed', userId, {
      scenario_id: String(scenario.id),
      turn_index: finalized.turn.turn_index,
      turn_status: finalized.turn.status,
      required_goal_count: requiredCount,
      completed_goal_count: completedGoalIdsAfterTurn.length,
      response_mode: responseMode,
      reason_code: reasonCode,
      latency_ms: latencyMs,
    });

    let session = finalized.session;
    if (shouldCompleteSession(session, scenario, previousTurns, result)) {
      session = await completeSession(userId, sessionId);
    }

    return {
      session: serializeSession(session),
      turn: serializeTurn(finalized.turn, result),
    };
  }

  return {
    listScenarios,
    startSession,
    getSession,
    advanceTurn,
    completeSession,
    saveReviewItems,
  };
}

module.exports = {
  createAIRoleplayEngine,
};
