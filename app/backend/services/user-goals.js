/**
 * User Goals Service
 * Manages personal learning goals, progress tracking, and reward distribution
 */

const goalsQueries = require('../data-store/queries/goals');

/**
 * Create a goal from a preset
 * @param {number} userId - User ID
 * @param {string} presetKey - Preset key
 * @returns {Promise<Object>} Created goal
 */
async function createGoalFromPreset(userId, presetKey) {
  const preset = await goalsQueries.getGoalPresetByKey(presetKey);
  if (!preset) {
    throw new Error('PRESET_NOT_FOUND');
  }

  const { startDate, endDate } = calculateDateRange(preset.time_range);

  return await goalsQueries.createGoal(userId, {
    goalType: preset.goal_type,
    targetValue: preset.target_value,
    timeRange: preset.time_range,
    startDate,
    endDate,
    rewardXp: preset.reward_xp,
    rewardCoins: preset.reward_coins,
    rewardBadge: preset.reward_badge
  });
}

/**
 * Create a custom goal
 * @param {number} userId - User ID
 * @param {Object} goalData - Goal data
 * @returns {Promise<Object>} Created goal
 */
async function createCustomGoal(userId, goalData) {
  const { goalType, targetValue, timeRange, rewardXp = 0, rewardCoins = 0, rewardBadge = null } = goalData;

  // Validate goal type
  const validTypes = ['accuracy', 'practice_count', 'study_minutes'];
  if (!validTypes.includes(goalType)) {
    throw new Error('INVALID_GOAL_TYPE');
  }

  // Validate time range
  const validRanges = ['daily', 'weekly', 'monthly'];
  if (!validRanges.includes(timeRange)) {
    throw new Error('INVALID_TIME_RANGE');
  }

  // Validate target value
  if (goalType === 'accuracy' && (targetValue < 0 || targetValue > 100)) {
    throw new Error('INVALID_TARGET_VALUE');
  }
  if (targetValue <= 0) {
    throw new Error('INVALID_TARGET_VALUE');
  }

  const { startDate, endDate } = calculateDateRange(timeRange);

  return await goalsQueries.createGoal(userId, {
    goalType,
    targetValue,
    timeRange,
    startDate,
    endDate,
    rewardXp,
    rewardCoins,
    rewardBadge
  });
}

/**
 * Calculate date range based on time range
 * @param {string} timeRange - 'daily', 'weekly', 'monthly'
 * @returns {Object} { startDate, endDate }
 */
function calculateDateRange(timeRange) {
  const now = new Date();
  let startDate, endDate;

  switch (timeRange) {
    case 'daily':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      break;

    case 'weekly':
      // Start from Monday
      const dayOfWeek = now.getDay();
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 7);
      break;

    case 'monthly':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;

    default:
      throw new Error('INVALID_TIME_RANGE');
  }

  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
  };
}

/**
 * Get user's goals with current progress
 * @param {number} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Goals with progress
 */
async function getUserGoalsWithProgress(userId, options = {}) {
  const goals = await goalsQueries.getUserGoals(userId, options);

  // Fetch current progress for each active goal
  const goalsWithProgress = await Promise.all(goals.map(async (goal) => {
    if (goal.status !== 'active') {
      return goal;
    }

    let currentValue = goal.current_value;

    // Fetch real-time progress based on goal type
    if (goal.goal_type === 'accuracy') {
      currentValue = await goalsQueries.getUserAverageAccuracy(userId, goal.time_range);
    } else if (goal.goal_type === 'practice_count') {
      currentValue = await goalsQueries.getUserPracticeCount(userId, goal.time_range);
    }

    return {
      ...goal,
      current_value: currentValue,
      progress_percent: calculateProgressPercent(currentValue, goal.target_value, goal.goal_type),
      is_completed: isGoalCompleted(currentValue, goal.target_value, goal.goal_type)
    };
  }));

  return goalsWithProgress;
}

/**
 * Calculate progress percentage
 * @param {number} current - Current value
 * @param {number} target - Target value
 * @param {string} goalType - Goal type
 * @returns {number} Progress percentage (0-100)
 */
function calculateProgressPercent(current, target, goalType) {
  if (target <= 0) return 0;

  if (goalType === 'accuracy') {
    // For accuracy, current value IS the percentage
    return Math.min(100, Math.round((current / target) * 100));
  }

  // For count-based goals
  return Math.min(100, Math.round((current / target) * 100));
}

/**
 * Check if goal is completed
 * @param {number} current - Current value
 * @param {number} target - Target value
 * @returns {boolean} Is completed
 */
function isGoalCompleted(current, target) {
  return current >= target;
}

/**
 * Update goal progress and check completion
 * @param {number} userId - User ID
 * @returns {Promise<Array>} List of newly completed goals
 */
async function updateAndCheckGoals(userId) {
  const activeGoals = await goalsQueries.getUserGoals(userId, { status: 'active' });
  const completedGoals = [];

  for (const goal of activeGoals) {
    let currentValue;

    // Get current progress based on goal type
    if (goal.goal_type === 'accuracy') {
      currentValue = await goalsQueries.getUserAverageAccuracy(userId, goal.time_range);
    } else if (goal.goal_type === 'practice_count') {
      currentValue = await goalsQueries.getUserPracticeCount(userId, goal.time_range);
    } else {
      continue;
    }

    // Update progress
    await goalsQueries.updateGoalProgress(goal.id, currentValue);

    // Check completion
    if (isGoalCompleted(currentValue, goal.target_value, goal.goal_type)) {
      const completedGoal = await goalsQueries.completeGoal(goal.id, currentValue);
      if (completedGoal) {
        completedGoals.push(completedGoal);
      }
    }
  }

  return completedGoals;
}

/**
 * Process expired goals (mark as failed)
 * @returns {Promise<number>} Number of goals marked as failed
 */
async function processExpiredGoals() {
  const expiredGoals = await goalsQueries.getExpiredGoals();
  let failedCount = 0;

  for (const goal of expiredGoals) {
    await goalsQueries.failGoal(goal.id);
    failedCount++;
  }

  return failedCount;
}

/**
 * Get goal presets with user's completion status
 * @param {number} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Presets with status
 */
async function getPresetsWithStatus(userId, options = {}) {
  const presets = await goalsQueries.getGoalPresets(options);
  const activeGoals = await goalsQueries.getUserGoals(userId, { status: 'active' });

  return presets.map(preset => {
    const hasActiveGoal = activeGoals.some(
      g => g.goal_type === preset.goal_type &&
           g.time_range === preset.time_range &&
           g.target_value === preset.target_value
    );

    return {
      ...preset,
      has_active_goal: hasActiveGoal
    };
  });
}

/**
 * Cancel a user's goal
 * @param {number} goalId - Goal ID
 * @param {number} userId - User ID
 * @returns {Promise<boolean>} Success status
 */
async function cancelGoal(goalId, userId) {
  return await goalsQueries.cancelGoal(goalId, userId);
}

/**
 * Get goal completion statistics for user
 * @param {number} userId - User ID
 * @returns {Promise<Object>} Completion stats
 */
async function getCompletionStats(userId) {
  const stats = await goalsQueries.getGoalCompletionStats(userId);

  const total = parseInt(stats.total_count || 0, 10);
  const completed = parseInt(stats.completed_count || 0, 10);

  return {
    ...stats,
    completion_rate: total > 0 ? Math.round((completed / total) * 100) : 0
  };
}

module.exports = {
  createGoalFromPreset,
  createCustomGoal,
  getUserGoalsWithProgress,
  updateAndCheckGoals,
  processExpiredGoals,
  getPresetsWithStatus,
  cancelGoal,
  getCompletionStats,
  calculateDateRange,
  calculateProgressPercent,
  isGoalCompleted
};
