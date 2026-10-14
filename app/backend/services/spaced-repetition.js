/**
 * Spaced Repetition Service
 *
 * Implements SuperMemo SM-2 algorithm (used by Anki)
 * for optimal vocabulary and phrase review scheduling
 *
 * Algorithm: https://www.supermemo.com/en/archives1990-2015/english/ol/sm2
 */

const dataStore = require('../data-store');

/**
 * Rating scale (1-5):
 * 1 = Again (Complete blackout)
 * 2 = Hard (Incorrect response, but remembered with effort)
 * 3 = Good (Correct response with some hesitation)
 * 4 = Easy (Correct response with perfect recall)
 * 5 = Perfect (Instant recall, overlearned)
 */
const RATING = {
  AGAIN: 1,
  HARD: 2,
  GOOD: 3,
  EASY: 4,
  PERFECT: 5
};

/**
 * Item states
 */
const STATE = {
  NEW: 'new',
  LEARNING: 'learning',
  REVIEWING: 'reviewing',
  RELEARNING: 'relearning',
  MASTERED: 'mastered'
};

/**
 * Calculate next interval using SM-2 algorithm
 *
 * @param {number} currentInterval - Current interval in days
 * @param {number} easeFactor - Current ease factor (1.3-4.0)
 * @param {number} repetitions - Number of consecutive successful reviews
 * @param {number} rating - Review rating (1-5)
 * @returns {Object} { interval, easeFactor, repetitions, state }
 */
function calculateNextReview(currentInterval, easeFactor, repetitions, rating) {
  let newEaseFactor = easeFactor;
  let newInterval = currentInterval;
  let newRepetitions = repetitions;
  let newState = STATE.REVIEWING;

  // Update ease factor based on rating
  // Formula: EF' = EF + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02))
  if (rating >= 3) {
    newEaseFactor = easeFactor + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02));
  } else {
    newEaseFactor = easeFactor - 0.2;
  }

  // Clamp ease factor to reasonable range
  newEaseFactor = Math.max(1.3, Math.min(4.0, newEaseFactor));

  // Calculate new interval based on rating
  if (rating === RATING.AGAIN) {
    // Reset to beginning
    newInterval = 1;
    newRepetitions = 0;
    newState = STATE.RELEARNING;
  } else if (rating === RATING.HARD) {
    // Reduce interval
    newInterval = Math.max(1, currentInterval * 0.5);
    newRepetitions = Math.max(0, repetitions - 1);
    newState = repetitions === 0 ? STATE.LEARNING : STATE.REVIEWING;
  } else {
    // Good, Easy, or Perfect - increase interval
    newRepetitions = repetitions + 1;

    if (newRepetitions === 1) {
      newInterval = 1;
      newState = STATE.LEARNING;
    } else if (newRepetitions === 2) {
      newInterval = 6;
      newState = STATE.REVIEWING;
    } else {
      // Apply ease factor
      let multiplier = newEaseFactor;

      if (rating === RATING.EASY) {
        multiplier *= 1.3; // 30% bonus for easy
      } else if (rating === RATING.PERFECT) {
        multiplier *= 1.5; // 50% bonus for perfect
      }

      newInterval = Math.round(currentInterval * multiplier);
      newState = STATE.REVIEWING;

      // Mark as mastered if interval > 180 days and high ease factor
      if (newInterval > 180 && newEaseFactor >= 2.5 && newRepetitions >= 8) {
        newState = STATE.MASTERED;
      }
    }
  }

  // Cap maximum interval at 365 days
  newInterval = Math.min(365, newInterval);

  return {
    interval: newInterval,
    easeFactor: newEaseFactor,
    repetitions: newRepetitions,
    state: newState
  };
}

/**
 * Calculate next review timestamp
 *
 * @param {number} intervalDays - Interval in days
 * @param {Date} fromDate - Base date (default: now)
 * @returns {Date} Next review date
 */
function getNextReviewDate(intervalDays, fromDate = new Date()) {
  const nextDate = new Date(fromDate);
  nextDate.setDate(nextDate.getDate() + intervalDays);
  return nextDate;
}

/**
 * Add a new item to the review schedule
 *
 * @param {number} userId - User ID
 * @param {Object} item - Item details
 * @returns {Object} Created schedule item
 */
async function addToSchedule(userId, item) {
  const {
    itemType,
    itemId,
    lemma,
    sourceSessionId = null,
    sourceContext = null
  } = item;

  // Check if item already exists
  const existing = await dataStore.pool.query(
    'SELECT * FROM review_schedule WHERE user_id = $1 AND item_type = $2 AND item_id = $3',
    [userId, itemType, itemId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // Create new schedule entry
  const nextReview = getNextReviewDate(1); // First review in 1 day
  const dueDate = nextReview.toISOString().split('T')[0];

  const result = await dataStore.pool.query(
    `INSERT INTO review_schedule (
      user_id, item_type, item_id, lemma,
      ease_factor, interval_days, repetitions,
      state, next_review_at, due_date,
      source_session_id, source_context,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
    RETURNING *`,
    [
      userId, itemType, itemId, lemma,
      2.5, 1, 0,
      STATE.NEW, nextReview, dueDate,
      sourceSessionId, sourceContext
    ]
  );

  return result.rows[0];
}

/**
 * Record a review and update schedule
 *
 * @param {number} userId - User ID
 * @param {number} scheduleId - Schedule item ID
 * @param {number} rating - Review rating (1-5)
 * @param {Object} options - Additional options
 * @returns {Object} Updated schedule and history
 */
async function recordReview(userId, scheduleId, rating, options = {}) {
  const {
    timeTakenMs = null,
    pronunciationScore = null,
    fluencyScore = null,
    accuracyScore = null
  } = options;

  await dataStore.init();

  // Get current schedule
  const scheduleResult = await dataStore.pool.query(
    'SELECT * FROM review_schedule WHERE id = $1 AND user_id = $2',
    [scheduleId, userId]
  );

  if (scheduleResult.rows.length === 0) {
    throw new Error('SCHEDULE_NOT_FOUND');
  }

  const schedule = scheduleResult.rows[0];

  // Calculate new schedule parameters
  const next = calculateNextReview(
    schedule.interval_days,
    schedule.ease_factor,
    schedule.repetitions,
    rating
  );

  const nextReviewDate = getNextReviewDate(next.interval);
  const dueDate = nextReviewDate.toISOString().split('T')[0];

  // Update schedule
  const updatedSchedule = await dataStore.pool.query(
    `UPDATE review_schedule SET
      ease_factor = $1,
      interval_days = $2,
      repetitions = $3,
      state = $4,
      last_review_at = NOW(),
      next_review_at = $5,
      due_date = $6,
      total_reviews = total_reviews + 1,
      correct_reviews = correct_reviews + $7,
      lapses = lapses + $8,
      updated_at = NOW()
    WHERE id = $9
    RETURNING *`,
    [
      next.easeFactor,
      next.interval,
      next.repetitions,
      next.state,
      nextReviewDate,
      dueDate,
      rating >= 3 ? 1 : 0,
      rating === RATING.AGAIN ? 1 : 0,
      scheduleId
    ]
  );

  // Record history
  const history = await dataStore.pool.query(
    `INSERT INTO review_history (
      schedule_id, user_id, review_time,
      rating, time_taken_ms,
      ease_factor_before, interval_days_before,
      ease_factor_after, interval_days_after,
      next_review_at,
      pronunciation_score, fluency_score, accuracy_score,
      created_at
    ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    RETURNING *`,
    [
      scheduleId, userId, rating, timeTakenMs,
      schedule.ease_factor, schedule.interval_days,
      next.easeFactor, next.interval,
      nextReviewDate,
      pronunciationScore, fluencyScore, accuracyScore
    ]
  );

  return {
    schedule: updatedSchedule.rows[0],
    history: history.rows[0],
    next: {
      ...next,
      nextReviewAt: nextReviewDate,
      dueDate
    }
  };
}

/**
 * Get due items for review
 *
 * @param {number} userId - User ID
 * @param {Object} options - Query options
 * @returns {Array} Due items
 */
async function getDueItems(userId, options = {}) {
  const {
    limit = 20,
    includeNew = true,
    includeReview = true,
    includeRelearn = true
  } = options;

  await dataStore.init();

  const states = [];
  if (includeNew) states.push(STATE.NEW);
  if (includeReview) states.push(STATE.REVIEWING);
  if (includeRelearn) states.push(STATE.RELEARNING, STATE.LEARNING);

  const result = await dataStore.pool.query(
    `SELECT * FROM review_schedule
    WHERE user_id = $1
      AND state = ANY($2)
      AND (next_review_at IS NULL OR next_review_at <= NOW())
      AND state != $3
    ORDER BY
      CASE state
        WHEN 'relearning' THEN 1
        WHEN 'learning' THEN 2
        WHEN 'reviewing' THEN 3
        WHEN 'new' THEN 4
      END,
      next_review_at ASC NULLS FIRST
    LIMIT $4`,
    [userId, states, STATE.MASTERED, limit]
  );

  return result.rows;
}

/**
 * Get review statistics
 *
 * @param {number} userId - User ID
 * @returns {Object} Statistics
 */
async function getReviewStats(userId) {
  await dataStore.init();

  const stats = await dataStore.pool.query(
    `SELECT
      state,
      COUNT(*) as count,
      AVG(ease_factor) as avg_ease,
      AVG(interval_days) as avg_interval
    FROM review_schedule
    WHERE user_id = $1
    GROUP BY state`,
    [userId]
  );

  const dueToday = await dataStore.pool.query(
    `SELECT COUNT(*) as count
    FROM review_schedule
    WHERE user_id = $1
      AND state != $2
      AND (next_review_at IS NULL OR next_review_at <= NOW())`,
    [userId, STATE.MASTERED]
  );

  const reviewHistory = await dataStore.pool.query(
    `SELECT
      COUNT(*) as total_reviews,
      AVG(rating) as avg_rating,
      COUNT(*) FILTER (WHERE rating >= 3) as successful_reviews,
      COUNT(*) FILTER (WHERE review_time >= CURRENT_DATE) as reviews_today
    FROM review_history
    WHERE user_id = $1`,
    [userId]
  );

  return {
    byState: stats.rows,
    dueToday: parseInt(dueToday.rows[0].count),
    history: reviewHistory.rows[0]
  };
}

module.exports = {
  RATING,
  STATE,
  calculateNextReview,
  getNextReviewDate,
  addToSchedule,
  recordReview,
  getDueItems,
  getReviewStats
};
