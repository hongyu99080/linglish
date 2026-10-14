/**
 * Base AI Service
 * Core OpenAI integration with caching, cost tracking, and error handling
 */

const OpenAI = require('openai');
const aiConfig = require('../config/ai-config');
const redisClient = require('../utils/redis-client');
const CostTracker = require('../utils/cost-tracker');
const { HttpsProxyAgent } = require('https-proxy-agent');

class BaseAIService {
  constructor(db) {
    this.db = db;

    // OpenAI客户端配置
    const openaiConfig = {
      apiKey: aiConfig.openai.apiKey,
      baseURL: aiConfig.openai.baseURL
    };

    // 如果配置了代理,添加httpAgent
    if (process.env.OPENAI_PROXY) {
      try {
        openaiConfig.httpAgent = new HttpsProxyAgent(process.env.OPENAI_PROXY);
        console.log('✅ OpenAI API using proxy:', process.env.OPENAI_PROXY.replace(/:[^:]*@/, ':***@'));
      } catch (error) {
        console.warn('⚠️ Proxy configuration failed:', error.message);
      }
    }

    this.openai = new OpenAI(openaiConfig);
    this.costTracker = new CostTracker(db);
  }

  /**
   * Select appropriate model based on task complexity
   */
  selectModel(purpose, estimatedTokens = 500) {
    // Check if purpose prefers specific model
    if (aiConfig.modelStrategy.preferGPT4For.includes(purpose)) {
      return aiConfig.openai.models.gpt4;
    }

    if (aiConfig.modelStrategy.preferGPT35For.includes(purpose)) {
      return aiConfig.openai.models.gpt35;
    }

    // Simple tasks: GPT-3.5, Complex tasks: GPT-4
    return estimatedTokens < aiConfig.modelStrategy.simpleTaskThreshold
      ? aiConfig.openai.models.gpt35
      : aiConfig.openai.models.gpt4;
  }

  /**
   * Generate cache key
   */
  generateCacheKey(purpose, params) {
    const sorted = Object.keys(params).sort().map(k => `${k}:${params[k]}`).join('|');
    return `${purpose}:${sorted}`;
  }

  /**
   * Call OpenAI API with caching, retries, and cost tracking
   */
  async callOpenAI({
    userId = null,
    purpose,
    messages,
    model = null,
    temperature = null,
    maxTokens = null,
    responseFormat = null,
    cacheKey = null,
    cacheTTL = null
  }) {
    const startTime = Date.now();

    // Select model if not specified
    const selectedModel = model || this.selectModel(purpose, this.estimateTokens(messages));

    // Check cache first
    if (cacheKey && aiConfig.cache.enabled) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log(`✅ Cache hit: ${cacheKey}`);

        // Log as cache hit (no cost)
        await this.costTracker.logApiCall({
          userId,
          model: selectedModel,
          purpose,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          responseTimeMs: Date.now() - startTime,
          cacheHit: true,
          cacheKey
        });

        return cached;
      }
    }

    // Check budget before calling
    const budget = await this.costTracker.checkBudget();
    if (!budget.canProceed) {
      const alert = budget.alerts.find(a => a.severity === 'critical');
      throw new Error(`Budget exceeded: ${alert.message}`);
    }

    // Call OpenAI with retry logic
    let lastError;
    for (let attempt = 1; attempt <= aiConfig.openai.maxRetries; attempt++) {
      try {
        const params = {
          model: selectedModel,
          messages,
          temperature: temperature ?? aiConfig.openai.temperature,
          max_tokens: maxTokens ?? aiConfig.openai.maxTokens,
          top_p: aiConfig.openai.topP,
          frequency_penalty: aiConfig.openai.frequencyPenalty,
          presence_penalty: aiConfig.openai.presencePenalty
        };

        if (responseFormat) {
          params.response_format = responseFormat;
        }

        const response = await this.openai.chat.completions.create(params);

        const responseTimeMs = Date.now() - startTime;
        const usage = response.usage;

        // Extract content
        const content = response.choices[0].message.content;

        // Log the call
        await this.costTracker.logApiCall({
          userId,
          model: selectedModel,
          endpoint: '/chat/completions',
          purpose,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          responseTimeMs,
          status: 'success',
          cacheKey
        });

        // Cache the result
        if (cacheKey && aiConfig.cache.enabled) {
          await redisClient.set(cacheKey, content, cacheTTL);
        }

        return content;

      } catch (error) {
        lastError = error;
        console.error(`OpenAI call attempt ${attempt} failed:`, error.message);

        // Log error
        await this.costTracker.logApiCall({
          userId,
          model: selectedModel,
          purpose,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          responseTimeMs: Date.now() - startTime,
          status: 'error',
          errorMessage: error.message,
          errorCode: error.code
        });

        // Don't retry on certain errors
        if (error.code === 'invalid_api_key' || error.code === 'insufficient_quota') {
          throw error;
        }

        // Wait before retry
        if (attempt < aiConfig.openai.maxRetries) {
          await this.sleep(1000 * attempt);
        }
      }
    }

    throw lastError;
  }

  /**
   * Estimate token count (rough approximation)
   */
  estimateTokens(messages) {
    const text = messages.map(m => m.content).join(' ');
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Parse JSON response safely
   */
  parseJSON(content) {
    try {
      return JSON.parse(content);
    } catch (error) {
      console.error('Failed to parse JSON response:', content);
      throw new Error('AI returned invalid JSON');
    }
  }

  /**
   * Build user context from database
   */
  async getUserContext(userId) {
    try {
      const [userResult, statsResult] = await Promise.all([
        this.db.query(`
          SELECT
            id,
            username,
            email,
            created_at
          FROM users
          WHERE id = $1
        `, [userId]),

        this.db.query(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'known') as known_words,
            COUNT(*) FILTER (WHERE status = 'learning') as learning_words,
            COUNT(*) FILTER (WHERE status = 'new') as new_words
          FROM user_vocabulary
          WHERE user_id = $1
        `, [userId])
      ]);

      const user = userResult.rows[0];
      const stats = statsResult.rows[0];

      return {
        userId: user.id,
        userName: user.username || 'there',
        email: user.email,
        joinedDays: Math.floor((Date.now() - new Date(user.created_at)) / (1000 * 60 * 60 * 24)),
        knownWords: parseInt(stats.known_words || 0),
        learningWords: parseInt(stats.learning_words || 0),
        newWords: parseInt(stats.new_words || 0),
        totalWords: parseInt(stats.known_words || 0) +
                    parseInt(stats.learning_words || 0) +
                    parseInt(stats.new_words || 0)
      };
    } catch (error) {
      console.error('Failed to get user context:', error.message);
      return {
        userId,
        userName: 'there',
        knownWords: 0,
        learningWords: 0,
        newWords: 0,
        totalWords: 0
      };
    }
  }
}

module.exports = BaseAIService;
