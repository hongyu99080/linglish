/**
 * Smart Import Service
 *
 * Intelligent vocabulary import system with user confirmation.
 *
 * Core Flow:
 * 1. Video playing → Record occurrences and clicks (facts only)
 * 2. Video ends → Generate personalized recommendations
 * 3. User confirms → Import selected words to vocabulary/SRS
 *
 * Key Constraints:
 * - Lemma as primary key (walk/walked/walking → walk)
 * - user_vocabulary must reference words table (global vocabulary)
 * - known/mastered words are filtered at both recommendation and import stages
 * - Session state machine: active → finished → committed/expired
 * - Idempotent operations (repeated calls don't corrupt data)
 * - Learning context persists sentence text (video-independent)
 */

const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const lemmatizer = require('./lemmatizer');
const { createCurationService } = require('./dictionary/curation');

// Get pool from environment or create new
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
const curation = createCurationService();

// ============================================================================
// Session Management
// ============================================================================

function normalizePositiveDecimalId(value, name) {
  const text = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string' ? value : '';
  if (!/^\d+$/.test(text)) {
    throw Object.assign(new Error(`${name} must be a positive decimal ID`), { code: 'SMART_IMPORT_VALIDATION' });
  }
  const normalized = text.replace(/^0+(?=\d)/, '');
  if (normalized === '0') {
    throw Object.assign(new Error(`${name} must be a positive decimal ID`), { code: 'SMART_IMPORT_VALIDATION' });
  }
  return normalized;
}

function normalizeLifecycleKey(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) {
    throw Object.assign(new Error('lifecycleKey must be a UUID v4'), { code: 'SMART_IMPORT_VALIDATION' });
  }
  return key;
}

function lifecycleResult(row) {
  return {
    sessionId: row.session_id,
    lifecycleKey: row.lifecycle_key,
    userLevel: row.user_level || 'beginner',
    importBudget: Number(row.import_budget) || 12,
    status: row.status,
  };
}

function createSessionLifecycleStore({ query, sessionIdFactory = uuidv4, lifecycleKeyFactory = uuidv4 } = {}) {
  if (typeof query !== 'function') throw new TypeError('query is required');

  async function loadUserContext(userId) {
    const result = await query(`
      SELECT
        COALESCE(up.current_vocabulary_level, 'beginner') AS user_level,
        COALESCE(vlc.import_budget, 12) AS import_budget
      FROM users u
      LEFT JOIN user_profiles up ON up.user_id = u.id
      LEFT JOIN vocabulary_level_config vlc
        ON vlc.level = COALESCE(up.current_vocabulary_level, 'beginner')
      WHERE u.id = $1
    `, [userId]);
    return {
      userLevel: result.rows[0]?.user_level || 'beginner',
      importBudget: Number(result.rows[0]?.import_budget) || 12,
    };
  }

  async function findLifecycle(userId, lifecycleKey) {
    const result = await query(`
      SELECT session_id, user_id, video_id, lifecycle_key, user_level, import_budget, status
      FROM video_learning_sessions
      WHERE user_id = $1 AND lifecycle_key = $2
      LIMIT 1
    `, [userId, lifecycleKey]);
    return result.rows[0] || null;
  }

  async function startSession(userIdValue, videoIdValue, lifecycleKeyValue) {
    const userId = normalizePositiveDecimalId(userIdValue, 'userId');
    const videoId = normalizePositiveDecimalId(videoIdValue, 'videoId');
    const lifecycleKey = normalizeLifecycleKey(
      lifecycleKeyValue == null ? lifecycleKeyFactory() : lifecycleKeyValue,
    );
    const { userLevel, importBudget } = await loadUserContext(userId);
    const sessionId = sessionIdFactory();
    const inserted = await query(`
      INSERT INTO video_learning_sessions
        (session_id, user_id, video_id, user_level, import_budget, lifecycle_key, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'active')
      ON CONFLICT (user_id, lifecycle_key) WHERE lifecycle_key IS NOT NULL
      DO NOTHING
      RETURNING session_id, user_id, video_id, lifecycle_key, user_level, import_budget, status
    `, [sessionId, userId, videoId, userLevel, importBudget, lifecycleKey]);
    const row = inserted.rows[0] || await findLifecycle(userId, lifecycleKey);
    if (!row) throw new Error('Unable to create SmartImport lifecycle');
    if (String(row.video_id) !== videoId) throw new Error('lifecycleKey already belongs to another video');
    return lifecycleResult(row);
  }

  async function closeLifecycle(userIdValue, videoIdValue, lifecycleKeyValue) {
    const userId = normalizePositiveDecimalId(userIdValue, 'userId');
    const videoId = normalizePositiveDecimalId(videoIdValue, 'videoId');
    const lifecycleKey = normalizeLifecycleKey(lifecycleKeyValue);
    const { userLevel, importBudget } = await loadUserContext(userId);
    const sessionId = sessionIdFactory();
    const closed = await query(`
      INSERT INTO video_learning_sessions
        (session_id, user_id, video_id, user_level, import_budget, lifecycle_key, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'abandoned')
      ON CONFLICT (user_id, lifecycle_key) WHERE lifecycle_key IS NOT NULL
      DO UPDATE SET status = 'abandoned', updated_at = NOW()
      WHERE video_learning_sessions.video_id = EXCLUDED.video_id
        AND video_learning_sessions.status = 'active'
      RETURNING session_id, user_id, video_id, lifecycle_key, user_level, import_budget, status
    `, [sessionId, userId, videoId, userLevel, importBudget, lifecycleKey]);
    const row = closed.rows[0] || await findLifecycle(userId, lifecycleKey);
    if (!row) throw new Error('Unable to close SmartImport lifecycle');
    if (String(row.video_id) !== videoId) throw new Error('lifecycleKey already belongs to another video');
    return lifecycleResult(row);
  }

  return { startSession, closeLifecycle };
}

const sessionLifecycleStore = createSessionLifecycleStore({
  query: pool.query.bind(pool),
});

/**
 * Start a new learning session for video watching
 *
 * @param {number} userId - User ID
 * @param {number} videoId - Video ID
 * @returns {Promise<{sessionId: string, userLevel: string, importBudget: number}>}
 */
async function startSession(userId, videoId, lifecycleKey) {
  const result = await sessionLifecycleStore.startSession(userId, videoId, lifecycleKey);
  console.log(`[SmartImport] Lifecycle ${result.lifecycleKey} resolved to session ${result.sessionId} for user ${userId}, video ${videoId}, status ${result.status}`);
  return result;
}

async function closeSessionLifecycle(userId, videoId, lifecycleKey) {
  const result = await sessionLifecycleStore.closeLifecycle(userId, videoId, lifecycleKey);
  console.log(`[SmartImport] Closed lifecycle ${result.lifecycleKey} for user ${userId}, video ${videoId}`);
  return result;
}

/**
 * Get session info
 */
async function getSession(sessionId) {
  const result = await pool.query(`
    SELECT * FROM video_learning_sessions WHERE session_id = $1
  `, [sessionId]);
  return result.rows[0] || null;
}

async function getSessionForUser(userId, sessionId, lifecycleKey = null) {
  const result = await pool.query(`
    SELECT * FROM video_learning_sessions
    WHERE session_id = $1 AND user_id = $2
      AND ($3::varchar IS NULL OR lifecycle_key = $3)
  `, [sessionId, userId, lifecycleKey]);
  return result.rows[0] || null;
}

// ============================================================================
// Event Recording
// ============================================================================

/**
 * Record word occurrence(s) for a segment
 * Constraint: Same segment + same word + occurrence = one record (deduplication via unique index)
 *
 * @param {number} userId - User ID
 * @param {string} sessionId - Session ID
 * @param {Array<{originalForm: string, clientLemma?: string, segmentIndex: number, sentenceText: string, wordPositionStart?: number, wordPositionEnd?: number, prevSentence?: string}>} words
 */
async function recordWordOccurrences(userId, sessionId, words) {
  if (!words || words.length === 0) return { recorded: 0, skipped: 0 };

  // Verify session is active
  const session = await getSessionForUser(userId, sessionId);
  if (!session || session.status !== 'active') {
    console.warn(`[SmartImport] Session ${sessionId} not active, skipping occurrence recording`);
    return { recorded: 0, skipped: words.length };
  }

  let recorded = 0;
  let skipped = 0;

  for (const word of words) {
    // Lemmatize the word
    const { lemma, source, confidence } = lemmatizer.lemmatize(word.originalForm, word.clientLemma);

    if (!lemma) {
      skipped++;
      continue;
    }

    // Get word frequency info from words table
    const wordInfo = await pool.query(`
      SELECT frequency_rank FROM words WHERE word_lowercase = $1
    `, [lemma.toLowerCase()]);

    const frequencyRank = wordInfo.rows[0]?.frequency_rank || null;
    const computedLevel = getWordLevelByRank(frequencyRank);

    try {
      // Insert with ON CONFLICT DO NOTHING (idempotent for occurrences)
      const result = await pool.query(`
        INSERT INTO video_word_events
          (user_id, video_id, session_id, lemma, original_form, frequency_rank, computed_level,
           event_type, segment_index, sentence_text, word_position_start, word_position_end,
           prev_sentence, lemma_source, lemma_confidence)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'occurrence', $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        userId, session.video_id, sessionId, lemma.toLowerCase(), word.originalForm,
        frequencyRank, computedLevel, word.segmentIndex, word.sentenceText,
        word.wordPositionStart, word.wordPositionEnd, word.prevSentence, source, confidence
      ]);

      if (result.rowCount > 0) {
        recorded++;
      } else {
        skipped++; // Already recorded for this segment
      }
    } catch (err) {
      // Unique constraint violation = already recorded
      if (err.code === '23505') {
        skipped++;
      } else {
        console.error(`[SmartImport] Error recording occurrence for "${word.originalForm}":`, err.message);
        skipped++;
      }
    }
  }

  return { recorded, skipped };
}

/**
 * Record user click on a word (looking up definition)
 * Click events allow multiple records (no deduplication)
 *
 * @param {number} userId - User ID
 * @param {string} sessionId - Session ID
 * @param {Object} clickData - Click event data
 * @returns {Promise<{lemma: string, lemmaSource: string, confidence: number}>}
 */
async function recordWordClick(userId, sessionId, clickData) {
  const { originalForm, clientLemma, segmentIndex, sentenceText, wordPositionStart, wordPositionEnd, prevSentence, nextSentence } = clickData;

  // Verify session is active
  const session = await getSessionForUser(userId, sessionId);
  if (!session || session.status !== 'active') {
    throw new Error('Session not active');
  }

  // Lemmatize the word
  const { lemma, source, confidence } = lemmatizer.lemmatize(originalForm, clientLemma);

  if (!lemma) {
    throw new Error('Could not lemmatize word');
  }

  // Get word frequency info
  const wordInfo = await pool.query(`
    SELECT frequency_rank FROM words WHERE word_lowercase = $1
  `, [lemma.toLowerCase()]);

  const frequencyRank = wordInfo.rows[0]?.frequency_rank || null;
  const computedLevel = getWordLevelByRank(frequencyRank);

  // Insert click event (no deduplication, allow multiple clicks)
  await pool.query(`
    INSERT INTO video_word_events
      (user_id, video_id, session_id, lemma, original_form, frequency_rank, computed_level,
       event_type, segment_index, sentence_text, word_position_start, word_position_end,
       prev_sentence, next_sentence, lemma_source, lemma_confidence)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'click', $8, $9, $10, $11, $12, $13, $14, $15)
  `, [
    userId, session.video_id, sessionId, lemma.toLowerCase(), originalForm,
    frequencyRank, computedLevel, segmentIndex, sentenceText,
    wordPositionStart, wordPositionEnd, prevSentence, nextSentence, source, confidence
  ]);

  console.log(`[SmartImport] Recorded click for "${originalForm}" → "${lemma}" in session ${sessionId}`);

  return {
    lemma: lemma.toLowerCase(),
    lemmaSource: source,
    confidence
  };
}

// ============================================================================
// Session Finish & Recommendation Generation
// ============================================================================

/**
 * Finish a learning session and generate recommendations
 * Constraint: watched_segment_indices only written on finish
 *
 * @param {number} userId - User ID
 * @param {string} sessionId - Session ID
 * @param {number[]} watchedSegments - Array of watched segment indices
 * @param {number} watchDurationSec - Total watch duration in seconds
 * @returns {Promise<Object>} Recommendation summary
 */
function createSessionFinisher({ getSessionForUser: findSession, query, generateRecommendations: recommend } = {}) {
  if (typeof findSession !== 'function' || typeof query !== 'function' || typeof recommend !== 'function') {
    throw new TypeError('getSessionForUser, query, and generateRecommendations are required');
  }

  return {
    async finishSession(userIdValue, sessionId, watchedSegments = [], watchDurationSec = 0, lifecycleKeyValue = null) {
      const userId = normalizePositiveDecimalId(userIdValue, 'userId');
      const lifecycleKey = lifecycleKeyValue == null
        ? null
        : normalizeLifecycleKey(lifecycleKeyValue);
      const session = await findSession(userId, sessionId, lifecycleKey);
      if (!session) {
        throw Object.assign(new Error('Session not found'), { code: 'SMART_IMPORT_SESSION_NOT_FOUND' });
      }
      if (session.status === 'committed') throw new Error('Session already committed');

      await query(`
        UPDATE video_learning_sessions
        SET status = 'finished',
            finished_at = NOW(),
            watched_segment_indices = $1,
            total_watch_duration_sec = $2,
            updated_at = NOW()
        WHERE session_id = $3 AND user_id = $4
          AND ($5::varchar IS NULL OR lifecycle_key = $5)
      `, [watchedSegments, watchDurationSec, sessionId, userId, lifecycleKey]);

      const recommendations = await recommend(userId, sessionId);
      await query(`
        UPDATE video_learning_sessions
        SET unique_lemmas_encountered = $1,
            lemmas_clicked = $2,
            total_occurrences = $3,
            updated_at = NOW()
        WHERE session_id = $4 AND user_id = $5
      `, [
        recommendations.uniqueLemmas,
        recommendations.clickedCount,
        recommendations.totalOccurrences,
        sessionId,
        userId,
      ]);
      return recommendations;
    },
  };
}

async function finishSession(userId, sessionId, watchedSegments = [], watchDurationSec = 0, lifecycleKey = null) {
  const finisher = createSessionFinisher({
    getSessionForUser,
    query: pool.query.bind(pool),
    generateRecommendations,
  });
  const recommendations = await finisher.finishSession(
    userId,
    sessionId,
    watchedSegments,
    watchDurationSec,
    lifecycleKey,
  );
  console.log(`[SmartImport] Finished session ${sessionId}: ${recommendations.recommendedCount} words recommended`);
  return recommendations;
}

/**
 * Generate personalized word recommendations
 * Constraint: Does not overwrite user_selected (only updates where user_selected IS NULL)
 *
 * @param {number} userId - User ID
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object>}
 */
async function generateRecommendations(userId, sessionId) {
  const session = await getSessionForUser(userId, sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // 1. Get all events for this session, aggregated by lemma
  const eventsResult = await pool.query(`
    SELECT
      lemma,
      array_agg(DISTINCT original_form) as original_forms,
      COUNT(*) FILTER (WHERE event_type = 'occurrence') as occurrence_count,
      COUNT(*) FILTER (WHERE event_type = 'click') as click_count,
      MIN(segment_index) as first_seen_segment,
      MAX(frequency_rank) as frequency_rank,
      MAX(computed_level) as computed_level,
      -- Best context: prefer click context, then first occurrence
      (array_agg(sentence_text ORDER BY
        CASE WHEN event_type = 'click' THEN 0 ELSE 1 END,
        created_at
      ) FILTER (WHERE sentence_text IS NOT NULL))[1] as best_sentence_text,
      (array_agg(word_position_start ORDER BY
        CASE WHEN event_type = 'click' THEN 0 ELSE 1 END,
        created_at
      ) FILTER (WHERE word_position_start IS NOT NULL))[1] as best_word_position_start,
      (array_agg(word_position_end ORDER BY
        CASE WHEN event_type = 'click' THEN 0 ELSE 1 END,
        created_at
      ) FILTER (WHERE word_position_end IS NOT NULL))[1] as best_word_position_end,
      (array_agg(prev_sentence ORDER BY
        CASE WHEN event_type = 'click' THEN 0 ELSE 1 END,
        created_at
      ) FILTER (WHERE prev_sentence IS NOT NULL))[1] as best_prev_sentence,
      (array_agg(next_sentence ORDER BY
        CASE WHEN event_type = 'click' THEN 0 ELSE 1 END,
        created_at
      ) FILTER (WHERE next_sentence IS NOT NULL))[1] as best_next_sentence,
      (array_agg(segment_index ORDER BY
        CASE WHEN event_type = 'click' THEN 0 ELSE 1 END,
        created_at
      ) FILTER (WHERE segment_index IS NOT NULL))[1] as best_segment_index
    FROM video_word_events
    WHERE session_id = $1 AND user_id = $2
    GROUP BY lemma
  `, [sessionId, userId]);

  const events = eventsResult.rows;

  // 2. Get user's known/mastered lemmas (Constraint #4: first filter)
  const knownResult = await pool.query(`
    SELECT DISTINCT LOWER(w.word) as lemma
    FROM user_vocabulary uv
    JOIN words w ON w.id = uv.word_id
    WHERE uv.user_id = $1 AND uv.status IN ('known', 'mastered')
  `, [userId]);
  const knownLemmas = new Set(knownResult.rows.map(r => r.lemma));

  // 3. Calculate priority scores and filter
  const candidates = [];
  const userLevel = session.user_level;
  const importBudget = session.import_budget;

  for (const event of events) {
    // Skip known/mastered words
    if (knownLemmas.has(event.lemma)) {
      continue;
    }

    // Calculate priority score
    const priorityScore = calculatePriorityScore(
      event.click_count,
      event.occurrence_count,
      event.computed_level,
      userLevel,
      event.frequency_rank
    );

    // Determine recommendation reason
    let reason = 'level_match';
    if (event.click_count > 0) {
      reason = 'user_clicked';
    } else if (event.occurrence_count >= 2) {
      reason = 'high_frequency';
    }

    // Level filtering (except for clicked words)
    const isLevelMatch = isWithinLevelRange(event.computed_level, userLevel);
    const isRecommended = event.click_count > 0 || (isLevelMatch && priorityScore >= 10);

    candidates.push({
      lemma: event.lemma,
      originalForms: event.original_forms,
      occurrenceCount: event.occurrence_count,
      clickCount: event.click_count,
      firstSeenSegment: event.first_seen_segment,
      priorityScore,
      reason,
      isRecommended,
      isClicked: event.click_count > 0,
      bestSentenceText: event.best_sentence_text,
      bestWordPositionStart: event.best_word_position_start,
      bestWordPositionEnd: event.best_word_position_end,
      bestPrevSentence: event.best_prev_sentence,
      bestNextSentence: event.best_next_sentence,
      bestSegmentIndex: event.best_segment_index,
      computedLevel: event.computed_level,
      frequencyRank: event.frequency_rank
    });
  }

  // 4. Sort by priority and apply budget
  candidates.sort((a, b) => b.priorityScore - a.priorityScore);

  // Clicked words always included, others up to budget
  const clickedWords = candidates.filter(c => c.isClicked);
  const otherWords = candidates.filter(c => !c.isClicked && c.isRecommended);
  const remainingBudget = Math.max(0, importBudget - clickedWords.length);
  const recommendedOthers = otherWords.slice(0, remainingBudget);

  const finalRecommended = [...clickedWords, ...recommendedOthers];
  const recommendedLemmas = new Set(finalRecommended.map(c => c.lemma));

  // 5. Upsert decisions (Constraint #5: don't overwrite user_selected)
  for (const candidate of candidates) {
    await pool.query(`
      INSERT INTO video_import_decisions
        (user_id, session_id, lemma, original_forms, occurrence_count, click_count,
         first_seen_segment, best_sentence_text, best_word_position_start, best_word_position_end,
         best_prev_sentence, best_next_sentence, best_segment_index,
         priority_score, recommendation_reason, is_recommended)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (user_id, session_id, lemma)
      DO UPDATE SET
        original_forms = EXCLUDED.original_forms,
        occurrence_count = EXCLUDED.occurrence_count,
        click_count = EXCLUDED.click_count,
        priority_score = EXCLUDED.priority_score,
        recommendation_reason = EXCLUDED.recommendation_reason,
        is_recommended = EXCLUDED.is_recommended,
        updated_at = NOW()
      WHERE video_import_decisions.user_selected IS NULL
    `, [
      userId, sessionId, candidate.lemma, candidate.originalForms,
      candidate.occurrenceCount, candidate.clickCount, candidate.firstSeenSegment,
      candidate.bestSentenceText, candidate.bestWordPositionStart, candidate.bestWordPositionEnd,
      candidate.bestPrevSentence, candidate.bestNextSentence, candidate.bestSegmentIndex,
      candidate.priorityScore, candidate.reason, recommendedLemmas.has(candidate.lemma)
    ]);
  }

  return {
    uniqueLemmas: events.length,
    clickedCount: clickedWords.length,
    totalOccurrences: events.reduce((sum, e) => sum + e.occurrence_count, 0),
    recommendedCount: finalRecommended.length,
    skippedKnown: knownLemmas.size,
    candidates: candidates.length,
    budget: importBudget,
    clickedWords: clickedWords.map(c => ({
      lemma: c.lemma,
      sentence: c.bestSentenceText,
      wordSpan: c.bestWordPositionStart != null ? [c.bestWordPositionStart, c.bestWordPositionEnd] : null
    })),
    recommendedWords: recommendedOthers.map(c => ({
      lemma: c.lemma,
      reason: c.reason,
      sentence: c.bestSentenceText
    }))
  };
}

/**
 * Get recommendations for a session
 */
async function getRecommendations(userId, sessionId) {
  const result = await pool.query(`
    SELECT *
    FROM video_import_decisions
    WHERE session_id = $1 AND user_id = $2
    ORDER BY
      CASE WHEN click_count > 0 THEN 0 ELSE 1 END,
      priority_score DESC
  `, [sessionId, userId]);

  return result.rows;
}

// ============================================================================
// Import Confirmation
// ============================================================================

/**
 * Confirm and import selected words
 * Constraint #4: Double-check known/mastered at import time
 * Constraint #7: user_vocabulary must reference words table
 *
 * @param {number} userId - User ID
 * @param {string} sessionId - Session ID
 * @param {string} mode - Import mode: 'recommended', 'clicked_only', 'custom', 'none'
 * @param {string[]} selectedLemmas - Lemmas to import (for 'custom' mode)
 * @returns {Promise<Object>}
 */
async function confirmImport(userId, sessionId, mode, selectedLemmas = []) {
  const session = await getSessionForUser(userId, sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  if (session.status === 'committed') {
    // Already committed - return existing results (idempotent)
    const existingResult = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE imported = TRUE) as imported_count
      FROM video_import_decisions
      WHERE session_id = $1
    `, [sessionId]);
    return {
      imported: parseInt(existingResult.rows[0]?.imported_count || 0),
      skipped: 0,
      skippedLemmas: [],
      alreadyCommitted: true
    };
  }

  if (session.status !== 'finished') {
    throw new Error('Session must be finished before confirming import');
  }

  // Determine which lemmas to import based on mode
  let lemmasToImport = [];

  if (mode === 'none') {
    lemmasToImport = [];
  } else if (mode === 'clicked_only') {
    const clickedResult = await pool.query(`
      SELECT lemma FROM video_import_decisions
      WHERE session_id = $1 AND click_count > 0
    `, [sessionId]);
    lemmasToImport = clickedResult.rows.map(r => r.lemma);
  } else if (mode === 'recommended') {
    const recommendedResult = await pool.query(`
      SELECT lemma FROM video_import_decisions
      WHERE session_id = $1 AND is_recommended = TRUE
    `, [sessionId]);
    lemmasToImport = recommendedResult.rows.map(r => r.lemma);
  } else if (mode === 'custom') {
    lemmasToImport = selectedLemmas.map(l => l.toLowerCase());
  }

  // Constraint #4: Second filter - check known/mastered at import time
  const knownResult = await pool.query(`
    SELECT DISTINCT LOWER(w.word) as lemma
    FROM user_vocabulary uv
    JOIN words w ON w.id = uv.word_id
    WHERE uv.user_id = $1 AND uv.status IN ('known', 'mastered')
  `, [userId]);
  const knownLemmas = new Set(knownResult.rows.map(r => r.lemma));

  const skippedLemmas = lemmasToImport.filter(l => knownLemmas.has(l));
  lemmasToImport = lemmasToImport.filter(l => !knownLemmas.has(l));

  let importedCount = 0;

  // Import each word
  for (const lemma of lemmasToImport) {
    // Get decision data for context
    const decisionResult = await pool.query(`
      SELECT * FROM video_import_decisions
      WHERE session_id = $1 AND lemma = $2
    `, [sessionId, lemma]);
    const decision = decisionResult.rows[0];

    if (!decision) continue;

    try {
      // Constraint #7: Ensure word exists in global vocabulary
      // Constraint #8: Skip blacklisted words
      let wordRecord = await ensureWordInGlobalVocabulary(lemma);

      // 如果词在黑名单中，跳过导入
      if (!wordRecord) {
        console.log(`[SmartImport] Skipping blacklisted word: ${lemma}`);
        continue;
      }

      // Build learning context (Constraint #6)
      const learningContext = {
        version: 1,
        sentence: decision.best_sentence_text,
        wordSpan: decision.best_word_position_start != null
          ? [decision.best_word_position_start, decision.best_word_position_end]
          : null,
        prevSentence: decision.best_prev_sentence,
        nextSentence: decision.best_next_sentence,
        source: {
          type: 'video',
          videoId: session.video_id,
          segmentIndex: decision.best_segment_index
        }
      };

      // Create user_vocabulary entry
      const uvResult = await pool.query(`
        INSERT INTO user_vocabulary (user_id, word_id, word, status, learning_context, created_at, updated_at)
        VALUES ($1, $2, $3, 'learning', $4, NOW(), NOW())
        ON CONFLICT (user_id, word_id) DO UPDATE SET
          learning_context = COALESCE(user_vocabulary.learning_context, EXCLUDED.learning_context),
          updated_at = NOW()
        RETURNING id
      `, [userId, wordRecord.id, wordRecord.word, JSON.stringify(learningContext)]);

      // Update decision record
      await pool.query(`
        UPDATE video_import_decisions
        SET imported = TRUE,
            imported_at = NOW(),
            word_id = $1,
            user_vocabulary_id = $2,
            user_selected = TRUE,
            decision_at = NOW(),
            updated_at = NOW()
        WHERE session_id = $3 AND lemma = $4
      `, [wordRecord.id, uvResult.rows[0].id, sessionId, lemma]);

      importedCount++;
    } catch (err) {
      console.error(`[SmartImport] Failed to import "${lemma}":`, err.message);
    }
  }

  // Update session as committed
  await pool.query(`
    UPDATE video_learning_sessions
    SET status = 'committed',
        committed_at = NOW(),
        import_mode = $1,
        words_imported = $2,
        words_skipped = $3,
        updated_at = NOW()
    WHERE session_id = $4
  `, [mode, importedCount, skippedLemmas.length, sessionId]);

  console.log(`[SmartImport] Committed session ${sessionId}: imported ${importedCount}, skipped ${skippedLemmas.length}`);

  return {
    imported: importedCount,
    skipped: skippedLemmas.length,
    skippedLemmas,
    alreadyCommitted: false
  };
}

/**
 * Ensure word exists in global vocabulary (words table)
 * Constraint #7: user_vocabulary must reference words table
 * Constraint #8: blacklisted words should not be re-imported
 */
async function ensureWordInGlobalVocabulary(lemma) {
  const normalizedLemma = lemma.toLowerCase().trim();

  // Check if word exists (including blacklisted)
  let result = await pool.query(`
    SELECT * FROM words WHERE word_lowercase = $1
  `, [normalizedLemma]);

  if (result.rows.length > 0) {
    const word = result.rows[0];
    // 如果词在黑名单中，拒绝导入
    if (word.is_blacklisted === true) {
      console.log(`[SmartImport] Word "${normalizedLemma}" is blacklisted, skipping import`);
      return null;
    }
    return word;
  }

  // 检查是否在黑名单中（可能已被删除但保留了黑名单记录）
  // 这里不需要额外检查，因为上面的查询已经包含了所有情况

  const curated = await curation.apply({
    write: {
      word: normalizedLemma,
      candidate: { word: normalizedLemma, word_lowercase: normalizedLemma },
      source: 'smart_import',
      reviewed: false,
      metadata: { path: 'smart-import.ensureWordInGlobalVocabulary' },
    },
    actor: { type: 'system', id: 'smart-import' },
  });

  console.log(`[SmartImport] Added new word to global vocabulary: ${normalizedLemma}`);

  return curated.after;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get word level by frequency rank
 */
function getWordLevelByRank(frequencyRank) {
  if (!frequencyRank || frequencyRank <= 0) {
    return 'intermediate'; // Default for unknown rank
  }
  if (frequencyRank <= 3000) {
    return 'beginner';
  }
  if (frequencyRank <= 8000) {
    return 'intermediate';
  }
  return 'advanced';
}

/**
 * Check if word level is within acceptable range of user level
 */
function isWithinLevelRange(wordLevel, userLevel) {
  const levelOrder = { beginner: 1, intermediate: 2, advanced: 3 };
  const wordLevelNum = levelOrder[wordLevel] || 2;
  const userLevelNum = levelOrder[userLevel] || 1;

  // Accept same level, one level up, or one level down
  return Math.abs(wordLevelNum - userLevelNum) <= 1;
}

/**
 * Calculate priority score (0-100)
 */
function calculatePriorityScore(clickCount, occurrenceCount, wordLevel, userLevel, frequencyRank) {
  // 1. User clicked = highest priority (not limited by level)
  if (clickCount > 0) {
    return 100;
  }

  let score = 0;

  // 2. Occurrence count (0-30 points)
  score += Math.min(30, occurrenceCount * 15);

  // 3. Level matching (0-40 points)
  const levelOrder = { beginner: 1, intermediate: 2, advanced: 3 };
  const wordLevelNum = levelOrder[wordLevel] || 2;
  const userLevelNum = levelOrder[userLevel] || 1;

  if (wordLevelNum === userLevelNum) {
    score += 40; // Same level
  } else if (wordLevelNum === userLevelNum + 1) {
    score += 30; // One level higher
  } else if (wordLevelNum === userLevelNum - 1) {
    score += 10; // One level lower
  }
  // More than 1 level difference = 0 points

  // 4. Frequency rank bonus (0-15 points)
  if (frequencyRank && frequencyRank > 0) {
    score += Math.max(0, 15 - Math.floor(frequencyRank / 1000));
  }

  return score;
}

/**
 * Abandon a session (user left without finishing)
 */
async function abandonSession(userId, sessionId, lifecycleKey = null) {
  await pool.query(`
    UPDATE video_learning_sessions
    SET status = 'abandoned',
        updated_at = NOW()
    WHERE session_id = $1 AND user_id = $2 AND status = 'active'
      AND ($3::varchar IS NULL OR lifecycle_key = $3)
  `, [sessionId, userId, lifecycleKey]);
}

/**
 * Update user's word selection in a decision
 */
async function updateWordSelection(userId, sessionId, lemma, selected) {
  await pool.query(`
    UPDATE video_import_decisions
    SET user_selected = $1,
        decision_at = NOW(),
        updated_at = NOW()
    WHERE user_id = $2 AND session_id = $3 AND lemma = $4
  `, [selected, userId, sessionId, lemma]);
}

module.exports = {
  createSessionLifecycleStore,
  createSessionFinisher,
  startSession,
  closeSessionLifecycle,
  getSession,
  getSessionForUser,
  recordWordOccurrences,
  recordWordClick,
  finishSession,
  generateRecommendations,
  getRecommendations,
  confirmImport,
  abandonSession,
  updateWordSelection,
  ensureWordInGlobalVocabulary,
  getWordLevelByRank,
  calculatePriorityScore
};
