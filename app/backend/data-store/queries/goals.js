/**
 * Goal-related database queries
 */

const { pool } = require('../index');

/**
 * Create a new user goal
 * @param {number} userId - User ID
 * @param {Object} goalData - Goal data
 * @returns {Promise<Object>} Created goal
 */
async function createGoal(userId, goalData) {
  const {
    goalType,
    targetValue,
    timeRange,
    startDate,
    endDate,
    rewardXp = 0,
    rewardCoins = 0,
    rewardBadge = null
  } = goalData;

  const result = await pool.query(
    `INSERT INTO user_goals
     (user_id, goal_type, target_value, time_range, start_date, end_date, reward_xp, reward_coins, reward_badge)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, goal_type, time_range, start_date)
     DO UPDATE SET
       target_value = EXCLUDED.target_value,
       reward_xp = EXCLUDED.reward_xp,
       reward_coins = EXCLUDED.reward_coins,
       reward_badge = EXCLUDED.reward_badge,
       status = 'active',
       current_value = 0,
       completed_at = NULL
     RETURNING *`,
    [userId, goalType, targetValue, timeRange, startDate, endDate, rewardXp, rewardCoins, rewardBadge]
  );

  return result.rows[0];
}

/**
 * Get user's active goals
 * @param {number} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} List of goals
 */
async function getUserGoals(userId, options = {}) {
  const { status = 'active', limit = 10 } = options;

  let query = `
    SELECT * FROM user_goals
    WHERE user_id = $1
  `;
  const params = [userId];

  if (status === 'active') {
    query += ` AND status = 'active' AND end_date >= CURRENT_DATE`;
  } else if (status) {
    query += ` AND status = $2`;
    params.push(status);
  }

  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Update goal progress
 * @param {number} goalId - Goal ID
 * @param {number} currentValue - Current progress value
 * @returns {Promise<Object>} Updated goal
 */
async function updateGoalProgress(goalId, currentValue) {
  const result = await pool.query(
    `UPDATE user_goals
     SET current_value = $2
     WHERE id = $1
     RETURNING *`,
    [goalId, currentValue]
  );
  return result.rows[0];
}

/**
 * Mark goal as completed
 * @param {number} goalId - Goal ID
 * @param {number} achievedValue - Final achieved value
 * @returns {Promise<Object>} Updated goal
 */
async function completeGoal(goalId, achievedValue) {
  const result = await pool.query(
    `UPDATE user_goals
     SET status = 'completed',
         current_value = $2,
         completed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [goalId, achievedValue]
  );

  const goal = result.rows[0];

  // Record in history
  if (goal) {
    await pool.query(
      `INSERT INTO goal_completion_history
       (user_id, goal_id, goal_type, target_value, achieved_value, time_range, reward_xp, reward_coins, reward_badge)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [goal.user_id, goal.id, goal.goal_type, goal.target_value, achievedValue,
       goal.time_range, goal.reward_xp, goal.reward_coins, goal.reward_badge]
    );
  }

  return goal;
}

/**
 * Mark goal as failed (end date passed without completion)
 * @param {number} goalId - Goal ID
 * @returns {Promise<Object>} Updated goal
 */
async function failGoal(goalId) {
  const result = await pool.query(
    `UPDATE user_goals
     SET status = 'failed'
     WHERE id = $1
     RETURNING *`,
    [goalId]
  );
  return result.rows[0];
}

/**
 * Cancel a goal
 * @param {number} goalId - Goal ID
 * @param {number} userId - User ID (for verification)
 * @returns {Promise<boolean>} Success status
 */
async function cancelGoal(goalId, userId) {
  const result = await pool.query(
    `UPDATE user_goals
     SET status = 'cancelled'
     WHERE id = $1 AND user_id = $2 AND status = 'active'
     RETURNING id`,
    [goalId, userId]
  );
  return result.rowCount > 0;
}

/**
 * Get goal presets
 * @param {Object} options - Query options
 * @returns {Promise<Array>} List of presets
 */
async function getGoalPresets(options = {}) {
  const { timeRange, goalType, isActive = true } = options;

  let query = `SELECT * FROM goal_presets WHERE 1=1`;
  const params = [];

  if (isActive !== null) {
    params.push(isActive);
    query += ` AND is_active = $${params.length}`;
  }

  if (timeRange) {
    params.push(timeRange);
    query += ` AND time_range = $${params.length}`;
  }

  if (goalType) {
    params.push(goalType);
    query += ` AND goal_type = $${params.length}`;
  }

  query += ` ORDER BY sort_order ASC, id ASC`;

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get goal preset by key
 * @param {string} presetKey - Preset key
 * @returns {Promise<Object|null>} Preset or null
 */
async function getGoalPresetByKey(presetKey) {
  const result = await pool.query(
    `SELECT * FROM goal_presets WHERE preset_key = $1 AND is_active = true`,
    [presetKey]
  );
  return result.rows[0] || null;
}

/**
 * Get user's goal completion stats
 * @param {number} userId - User ID
 * @returns {Promise<Object>} Completion stats
 */
async function getGoalCompletionStats(userId) {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
       COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
       COUNT(*) FILTER (WHERE status = 'active') as active_count,
       COUNT(*) as total_count
     FROM user_goals
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0];
}

/**
 * Get user's current week accuracy average
 * @param {number} userId - User ID
 * @returns {Promise<Object>} Accuracy stats
 */
async function getUserWeeklyAccuracy(userId) {
  const result = await pool.query(
    `SELECT
       COALESCE(AVG(accuracy), 0) as avg_accuracy,
       COUNT(*) as practice_count
     FROM user_pronunciation_assessments
     WHERE user_id = $1
       AND created_at >= date_trunc('week', CURRENT_DATE)`,
    [userId]
  );
  return result.rows[0];
}

/**
 * Get user's practice count for time range
 * @param {number} userId - User ID
 * @param {string} timeRange - 'daily', 'weekly', 'monthly'
 * @returns {Promise<number>} Practice count
 */
async function getUserPracticeCount(userId, timeRange) {
  let dateFilter;
  switch (timeRange) {
    case 'daily':
      dateFilter = `created_at >= CURRENT_DATE`;
      break;
    case 'weekly':
      dateFilter = `created_at >= date_trunc('week', CURRENT_DATE)`;
      break;
    case 'monthly':
      dateFilter = `created_at >= date_trunc('month', CURRENT_DATE)`;
      break;
    default:
      dateFilter = `created_at >= date_trunc('week', CURRENT_DATE)`;
  }

  const result = await pool.query(
    `SELECT COUNT(*) as count
     FROM user_pronunciation_assessments
     WHERE user_id = $1 AND ${dateFilter}`,
    [userId]
  );

  return parseInt(result.rows[0]?.count || 0, 10);
}

/**
 * Get user's average accuracy for time range
 * @param {number} userId - User ID
 * @param {string} timeRange - 'daily', 'weekly', 'monthly'
 * @returns {Promise<number>} Average accuracy
 */
async function getUserAverageAccuracy(userId, timeRange) {
  let dateFilter;
  switch (timeRange) {
    case 'daily':
      dateFilter = `created_at >= CURRENT_DATE`;
      break;
    case 'weekly':
      dateFilter = `created_at >= date_trunc('week', CURRENT_DATE)`;
      break;
    case 'monthly':
      dateFilter = `created_at >= date_trunc('month', CURRENT_DATE)`;
      break;
    default:
      dateFilter = `created_at >= date_trunc('week', CURRENT_DATE)`;
  }

  const result = await pool.query(
    `SELECT COALESCE(AVG(accuracy), 0) as avg_accuracy
     FROM user_pronunciation_assessments
     WHERE user_id = $1 AND ${dateFilter}`,
    [userId]
  );

  return parseFloat(result.rows[0]?.avg_accuracy || 0);
}

/**
 * Get expired active goals (for cleanup/failure marking)
 * @returns {Promise<Array>} List of expired goals
 */
async function getExpiredGoals() {
  const result = await pool.query(
    `SELECT * FROM user_goals
     WHERE status = 'active' AND end_date < CURRENT_DATE`
  );
  return result.rows;
}

module.exports = {
  createGoal,
  getUserGoals,
  updateGoalProgress,
  completeGoal,
  failGoal,
  cancelGoal,
  getGoalPresets,
  getGoalPresetByKey,
  getGoalCompletionStats,
  getUserWeeklyAccuracy,
  getUserPracticeCount,
  getUserAverageAccuracy,
  getExpiredGoals
};
