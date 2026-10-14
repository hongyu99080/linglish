/**
 * Review Scheduler Service
 *
 * Generates daily review plans and manages review queues
 * Integrates with event system for tracking learning progress
 */

const dataStore = require('../data-store');
const spacedRepetition = require('./spaced-repetition');

/**
 * Generate daily review plan for a user
 *
 * @param {number} userId - User ID
 * @param {Date} planDate - Plan date (default: today)
 * @returns {Object} Daily review plan
 */
async function generateDailyPlan(userId, planDate = new Date()) {
  await dataStore.init();

  const dateStr = planDate.toISOString().split('T')[0];

  // Check if plan already exists
  const existingPlan = await dataStore.pool.query(
    'SELECT * FROM daily_review_plans WHERE user_id = $1 AND plan_date = $2',
    [userId, dateStr]
  );

  if (existingPlan.rows.length > 0) {
    return existingPlan.rows[0];
  }

  // Get due items (reviews + relearning)
  const reviewItems = await spacedRepetition.getDueItems(userId, {
    limit: 50,
    includeNew: false,
    includeReview: true,
    includeRelearn: true
  });

  // Get new items (limit to 10 new per day)
  const newItems = await spacedRepetition.getDueItems(userId, {
    limit: 10,
    includeNew: true,
    includeReview: false,
    includeRelearn: false
  });

  // Separate relearning items
  const relearnItems = reviewItems.filter(item =>
    item.state === spacedRepetition.STATE.RELEARNING ||
    item.state === spacedRepetition.STATE.LEARNING
  );

  const regularReviewItems = reviewItems.filter(item =>
    item.state === spacedRepetition.STATE.REVIEWING
  );

  // Create plan
  const totalCount = newItems.length + reviewItems.length;

  const plan = await dataStore.pool.query(
    `INSERT INTO daily_review_plans (
      user_id, plan_date,
      new_items, review_items, relearn_items,
      total_count, completed_count,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 0, NOW(), NOW())
    RETURNING *`,
    [
      userId,
      dateStr,
      JSON.stringify(newItems.map(item => item.id)),
      JSON.stringify(regularReviewItems.map(item => item.id)),
      JSON.stringify(relearnItems.map(item => item.id)),
      totalCount
    ]
  );

  return plan.rows[0];
}

/**
 * Get daily review plan with item details
 *
 * @param {number} userId - User ID
 * @param {Date} planDate - Plan date (default: today)
 * @returns {Object} Detailed review plan
 */
async function getDailyPlan(userId, planDate = new Date()) {
  await dataStore.init();

  const dateStr = planDate.toISOString().split('T')[0];

  // Get or create plan
  let plan = await dataStore.pool.query(
    'SELECT * FROM daily_review_plans WHERE user_id = $1 AND plan_date = $2',
    [userId, dateStr]
  );

  if (plan.rows.length === 0) {
    const newPlan = await generateDailyPlan(userId, planDate);
    plan = { rows: [newPlan] };
  }

  const planData = plan.rows[0];

  // Get item details
  const allItemIds = [
    ...(planData.new_items || []),
    ...(planData.review_items || []),
    ...(planData.relearn_items || [])
  ];

  if (allItemIds.length === 0) {
    return {
      ...planData,
      items: [],
      new_items_detail: [],
      review_items_detail: [],
      relearn_items_detail: []
    };
  }

  const items = await dataStore.pool.query(
    `SELECT rs.*,
            uv.word as vocab_lemma,
            w.definitions->>'zh' as translation
    FROM review_schedule rs
    LEFT JOIN user_vocabulary uv ON rs.item_id = uv.id AND rs.item_type = 'vocabulary'
    LEFT JOIN words w ON uv.word_id = w.id
    WHERE rs.id = ANY($1)
    ORDER BY
      CASE rs.state
        WHEN 'relearning' THEN 1
        WHEN 'learning' THEN 2
        WHEN 'reviewing' THEN 3
        WHEN 'new' THEN 4
      END,
      rs.next_review_at ASC NULLS FIRST`,
    [allItemIds]
  );

  // Group items by type
  const newItemsDetail = items.rows.filter(item =>
    (planData.new_items || []).includes(item.id)
  );

  const reviewItemsDetail = items.rows.filter(item =>
    (planData.review_items || []).includes(item.id)
  );

  const relearnItemsDetail = items.rows.filter(item =>
    (planData.relearn_items || []).includes(item.id)
  );

  return {
    ...planData,
    items: items.rows,
    new_items_detail: newItemsDetail,
    review_items_detail: reviewItemsDetail,
    relearn_items_detail: relearnItemsDetail
  };
}

/**
 * Mark review plan item as completed
 *
 * @param {number} userId - User ID
 * @param {number} scheduleId - Schedule item ID
 * @param {Date} planDate - Plan date
 * @returns {Object} Updated plan
 */
async function markItemCompleted(userId, scheduleId, planDate = new Date()) {
  await dataStore.init();

  const dateStr = planDate.toISOString().split('T')[0];

  const result = await dataStore.pool.query(
    `UPDATE daily_review_plans
    SET completed_count = completed_count + 1,
        updated_at = NOW()
    WHERE user_id = $1 AND plan_date = $2
    RETURNING *`,
    [userId, dateStr]
  );

  return result.rows[0];
}

/**
 * Process training session and add vocabulary to review schedule
 *
 * @param {number} userId - User ID
 * @param {number} sessionId - Training session ID
 * @param {Array} vocabularyItems - Vocabulary items to add
 * @returns {Array} Created schedule items
 */
async function addVocabularyFromSession(userId, sessionId, vocabularyItems) {
  const scheduleItems = [];

  for (const vocab of vocabularyItems) {
    const { lemma, itemId, context } = vocab;

    try {
      const scheduleItem = await spacedRepetition.addToSchedule(userId, {
        itemType: 'vocabulary',
        itemId: itemId,
        lemma: lemma,
        sourceSessionId: sessionId,
        sourceContext: context || null
      });

      scheduleItems.push(scheduleItem);
    } catch (error) {
      console.error(`Failed to add vocabulary ${lemma} to schedule:`, error);
    }
  }

  // Create event
  await dataStore.createEvent({
    user_id: userId,
    event_time: new Date().toISOString(),
    event_name: 'vocabulary_added_to_schedule',
    properties: {
      session_id: sessionId,
      count: scheduleItems.length,
      items: vocabularyItems.map(v => v.lemma)
    },
    source: 'web'
  });

  return scheduleItems;
}

/**
 * Process Dictogloss session and extract vocabulary/phrases
 *
 * @param {number} userId - User ID
 * @param {number} sessionId - Training session ID
 * @param {Object} sessionData - Session output data
 * @returns {Object} Processing results
 */
async function processDictoglossSession(userId, sessionId, sessionData) {
  await dataStore.init();

  const { keywords, reconstruction } = sessionData;

  if (!keywords && !reconstruction) {
    return { vocabularyAdded: [], phrasesAdded: [] };
  }

  const vocabularyAdded = [];
  const phrasesAdded = [];

  // Extract keywords
  if (keywords) {
    const keywordList = keywords
      .split(/[,\n]+/)
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);

    for (const keyword of keywordList) {
      // TODO: 迁移到 vocabulary-v2 后，改用 user_vocabulary 表
      // Check if it exists in user_vocab_items (deprecated - 使用旧表)
      const vocabItem = await dataStore.getVocabItem(userId, keyword);

      if (vocabItem) {
        // Add to review schedule
        const scheduleItem = await spacedRepetition.addToSchedule(userId, {
          itemType: 'vocabulary',
          itemId: vocabItem.id,
          lemma: keyword,
          sourceSessionId: sessionId,
          sourceContext: reconstruction || null
        });

        vocabularyAdded.push(scheduleItem);
      } else {
        // Create new vocab item and add to schedule
        const newVocabItem = await dataStore.upsertVocabItem(userId, keyword, {
          state: 'encountered',
          exposures: 1
        });

        const scheduleItem = await spacedRepetition.addToSchedule(userId, {
          itemType: 'vocabulary',
          itemId: newVocabItem.id,
          lemma: keyword,
          sourceSessionId: sessionId,
          sourceContext: reconstruction || null
        });

        vocabularyAdded.push(scheduleItem);
      }
    }
  }

  // Extract phrases (simple heuristic: multi-word expressions)
  if (reconstruction) {
    const sentences = reconstruction.split(/[.!?]+/).filter(Boolean);

    for (const sentence of sentences.slice(0, 3)) { // Limit to 3 sentences
      const trimmed = sentence.trim();
      if (trimmed.length > 10 && trimmed.length < 100) {
        // Save as phrase
        const phrase = await dataStore.pool.query(
          `INSERT INTO vocabulary_phrases (
            user_id, phrase_text, phrase_type,
            source_session_id, source_context,
            exposure_count, created_at
          ) VALUES ($1, $2, $3, $4, $5, 1, NOW())
          ON CONFLICT (user_id, phrase_text)
          DO UPDATE SET
            exposure_count = vocabulary_phrases.exposure_count + 1,
            last_seen_at = NOW()
          RETURNING *`,
          [userId, trimmed, 'sentence_pattern', sessionId, reconstruction]
        );

        if (phrase.rows[0]) {
          // Add phrase to review schedule
          const scheduleItem = await spacedRepetition.addToSchedule(userId, {
            itemType: 'phrase',
            itemId: phrase.rows[0].id,
            lemma: trimmed.slice(0, 50), // First 50 chars as lemma
            sourceSessionId: sessionId,
            sourceContext: reconstruction
          });

          phrasesAdded.push(scheduleItem);
        }
      }
    }
  }

  // Create event
  await dataStore.createEvent({
    user_id: userId,
    event_time: new Date().toISOString(),
    event_name: 'dictogloss_processed',
    properties: {
      session_id: sessionId,
      vocabulary_count: vocabularyAdded.length,
      phrase_count: phrasesAdded.length
    },
    source: 'web'
  });

  return {
    vocabularyAdded,
    phrasesAdded
  };
}

/**
 * Get review statistics for dashboard
 *
 * @param {number} userId - User ID
 * @returns {Object} Review statistics
 */
async function getReviewDashboard(userId) {
  const stats = await spacedRepetition.getReviewStats(userId);
  const todayPlan = await getDailyPlan(userId);

  return {
    ...stats,
    todayPlan: {
      totalItems: todayPlan.total_count || 0,
      completedItems: todayPlan.completed_count || 0,
      newItems: (todayPlan.new_items || []).length,
      reviewItems: (todayPlan.review_items || []).length,
      relearnItems: (todayPlan.relearn_items || []).length
    }
  };
}

module.exports = {
  generateDailyPlan,
  getDailyPlan,
  markItemCompleted,
  addVocabularyFromSession,
  processDictoglossSession,
  getReviewDashboard
};
