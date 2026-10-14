/**
 * AI Cost Tracker
 * Tracks and manages AI API costs
 */

const aiConfig = require('../config/ai-config');
const redisClient = require('./redis-client');

class CostTracker {
  constructor(db) {
    this.db = db;
  }

  /**
   * Calculate cost for API call
   */
  calculateCost(model, promptTokens, completionTokens) {
    const pricing = aiConfig.pricing[model];
    if (!pricing) {
      console.warn(`Unknown model pricing: ${model}`);
      return 0;
    }

    const inputCost = (promptTokens / 1000) * pricing.input;
    const outputCost = (completionTokens / 1000) * pricing.output;
    const totalCost = inputCost + outputCost;

    return parseFloat(totalCost.toFixed(6));
  }

  /**
   * Log API call to database
   */
  async logApiCall({
    userId,
    apiType = 'openai',
    model,
    endpoint,
    purpose,
    promptTokens,
    completionTokens,
    totalTokens,
    responseTimeMs,
    status = 'success',
    cacheHit = false,
    cacheKey = null,
    errorMessage = null,
    errorCode = null
  }) {
    if (!aiConfig.costTracking.enabled) {
      return null;
    }

    const costUsd = this.calculateCost(model, promptTokens, completionTokens);

    try {
      const result = await this.db.query(`
        INSERT INTO ai_api_calls (
          user_id, model, endpoint, purpose,
          prompt_tokens, completion_tokens, total_tokens,
          cost_usd, response_time_ms, status,
          cache_hit, cache_key,
          error_message, error_code
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id, cost_usd
      `, [
        userId, model, endpoint, purpose,
        promptTokens, completionTokens, totalTokens,
        costUsd, responseTimeMs, status,
        cacheHit, cacheKey,
        errorMessage, errorCode
      ]);

      // Update Redis counter for today's cost
      const today = new Date().toISOString().split('T')[0];
      await redisClient.increment(`daily_cost:${today}`, costUsd);

      return result.rows[0];
    } catch (error) {
      console.error('Failed to log API call:', error.message);
      return null;
    }
  }

  /**
   * Get today's cost
   */
  async getTodayCost() {
    const today = new Date().toISOString().split('T')[0];

    // Try Redis first (fast)
    const cachedCost = await redisClient.get(`daily_cost:${today}`);
    if (cachedCost !== null) {
      return parseFloat(cachedCost);
    }

    // Fallback to database
    try {
      const result = await this.db.query(`
        SELECT COALESCE(SUM(cost_usd), 0) as total_cost
        FROM ai_api_calls
        WHERE DATE(created_at) = $1
      `, [today]);

      const cost = parseFloat(result.rows[0].total_cost);

      // Cache it
      await redisClient.set(`daily_cost:${today}`, cost, 3600);

      return cost;
    } catch (error) {
      console.error('Failed to get today cost:', error.message);
      return 0;
    }
  }

  /**
   * Get this month's cost
   */
  async getMonthCost() {
    try {
      const result = await this.db.query(`
        SELECT COALESCE(SUM(cost_usd), 0) as total_cost
        FROM ai_api_calls
        WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE)
          AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)
      `);

      return parseFloat(result.rows[0].total_cost);
    } catch (error) {
      console.error('Failed to get month cost:', error.message);
      return 0;
    }
  }

  /**
   * Check if budget exceeded
   */
  async checkBudget() {
    const [todayCost, monthCost] = await Promise.all([
      this.getTodayCost(),
      this.getMonthCost()
    ]);

    const dailyLimit = aiConfig.costTracking.dailyBudget;
    const monthlyLimit = aiConfig.costTracking.monthlyBudget;

    const alerts = [];

    if (todayCost >= dailyLimit) {
      alerts.push({
        type: 'daily_exceeded',
        message: `Daily budget exceeded: $${todayCost.toFixed(2)} / $${dailyLimit}`,
        severity: 'critical'
      });
    } else if (todayCost >= dailyLimit * aiConfig.costTracking.alertThreshold) {
      alerts.push({
        type: 'daily_warning',
        message: `Daily budget at ${((todayCost / dailyLimit) * 100).toFixed(0)}%`,
        severity: 'warning'
      });
    }

    if (monthCost >= monthlyLimit) {
      alerts.push({
        type: 'monthly_exceeded',
        message: `Monthly budget exceeded: $${monthCost.toFixed(2)} / $${monthlyLimit}`,
        severity: 'critical'
      });
    }

    return {
      todayCost,
      monthCost,
      dailyLimit,
      monthlyLimit,
      dailyRemaining: Math.max(0, dailyLimit - todayCost),
      monthlyRemaining: Math.max(0, monthlyLimit - monthCost),
      alerts,
      canProceed: todayCost < dailyLimit && monthCost < monthlyLimit
    };
  }

  /**
   * Get cost statistics
   */
  async getStatistics(days = 7) {
    try {
      const result = await this.db.query(`
        SELECT
          DATE(created_at) as date,
          purpose,
          model,
          COUNT(*) as call_count,
          SUM(total_tokens) as total_tokens,
          SUM(cost_usd) as total_cost,
          AVG(response_time_ms) as avg_response_time,
          AVG(CASE WHEN cache_hit THEN 1 ELSE 0 END) * 100 as cache_hit_rate
        FROM ai_api_calls
        WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY DATE(created_at), purpose, model
        ORDER BY date DESC, total_cost DESC
      `);

      return result.rows;
    } catch (error) {
      console.error('Failed to get statistics:', error.message);
      return [];
    }
  }
}

module.exports = CostTracker;
