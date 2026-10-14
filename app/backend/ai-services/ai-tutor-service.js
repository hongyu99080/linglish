/**
 * AI Tutor Service
 * Generates daily plans, provides chat support, and learning guidance
 */

const BaseAIService = require('./base-ai-service');
const aiConfig = require('../config/ai-config');

class AITutorService extends BaseAIService {
  /**
   * Generate daily learning plan
   */
  async generateDailyPlan(userId) {
    if (!aiConfig.features.dailyPlan) {
      throw new Error('Daily plan feature is disabled');
    }

    const today = new Date().toISOString().split('T')[0];

    // Check if plan already exists for today
    const existing = await this.db.query(`
      SELECT plan_data
      FROM daily_plans
      WHERE user_id = $1 AND plan_date = $2
    `, [userId, today]);

    if (existing.rows.length > 0) {
      return existing.rows[0].plan_data;
    }

    // Get user context and recent history
    const context = await this.getUserContext(userId);
    const recentHistory = await this.getRecentHistory(userId);
    const dueReviews = await this.getDueReviews(userId);

    // Build prompt
    const prompt = this.buildDailyPlanPrompt(context, recentHistory, dueReviews);

    // Generate plan using GPT-4
    const cacheKey = this.generateCacheKey('daily_plan', { userId, date: today });

    const planJSON = await this.callOpenAI({
      userId,
      purpose: 'daily_plan',
      messages: [
        {
          role: 'system',
          content: 'You are an expert English learning coach. Generate personalized daily plans in JSON format.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      model: aiConfig.openai.models.gpt4,
      responseFormat: { type: 'json_object' },
      cacheKey,
      cacheTTL: 86400 // Cache for 24 hours
    });

    const plan = this.parseJSON(planJSON);

    // Save to database
    await this.db.query(`
      INSERT INTO daily_plans (
        user_id, plan_date, estimated_minutes,
        plan_data, generated_by
      ) VALUES ($1, $2, $3, $4, $5)
    `, [userId, today, plan.estimatedTime || 30, plan, aiConfig.openai.models.gpt4]);

    return plan;
  }

  /**
   * Build daily plan prompt
   */
  buildDailyPlanPrompt(context, history, dueReviews) {
    return `Generate a personalized daily English learning plan.

USER PROFILE:
- Name: ${context.userName}
- Total words learned: ${context.totalWords}
- Known words: ${context.knownWords}
- Words currently learning: ${context.learningWords}
- Days using app: ${context.joinedDays}

RECENT ACTIVITY (last 7 days):
${history.summary}

DUE REVIEWS:
- ${dueReviews.length} words due for review today

REQUIREMENTS:
1. Generate a plan for approximately 30 minutes
2. Include 3-5 activities
3. Prioritize reviews if there are due items
4. Mix reading and practice activities
5. Provide encouraging, personal greeting
6. Explain WHY each activity is recommended

Return JSON with this exact structure:
{
  "greeting": "Good morning, [name]! 🌅",
  "yesterdaySummary": {
    "achievements": ["achievement 1", "achievement 2"]
  },
  "estimatedTime": 30,
  "activities": [
    {
      "type": "review",
      "title": "Morning vocabulary review",
      "description": "Review 15 words",
      "duration": 10,
      "reasoning": "Best time for memory recall"
    }
  ],
  "motivation": "Encouraging message",
  "tips": ["tip 1", "tip 2"]
}`;
  }

  /**
   * AI Chat
   */
  async chat(userId, message, conversationId = null) {
    if (!aiConfig.features.aiChat) {
      throw new Error('AI chat feature is disabled');
    }

    // Get user context
    const context = await this.getUserContext(userId);

    // Get conversation history if exists
    const history = conversationId
      ? await this.getConversationHistory(conversationId)
      : [];

    // Build messages array
    const messages = [
      {
        role: 'system',
        content: this.buildChatSystemPrompt(context)
      }
    ];

    // Add history
    history.forEach(h => {
      messages.push(
        { role: 'user', content: h.user_message },
        { role: 'assistant', content: h.ai_response }
      );
    });

    // Add current message
    messages.push({ role: 'user', content: message });

    // Classify intent
    const intent = this.classifyIntent(message);

    // Call OpenAI (use GPT-3.5 for simple chats)
    const model = ['greeting', 'simple_question'].includes(intent)
      ? aiConfig.openai.models.gpt35
      : aiConfig.openai.models.gpt4;

    const response = await this.callOpenAI({
      userId,
      purpose: 'chat',
      messages,
      model,
      temperature: 0.8
    });

    // Save to database
    const newConvId = conversationId || this.generateUUID();
    await this.db.query(`
      INSERT INTO ai_chat_history (
        user_id, conversation_id, message_index,
        user_message, ai_response,
        intent, model_used
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [userId, newConvId, history.length, message, response, intent, model]);

    return {
      response,
      conversationId: newConvId
    };
  }

  /**
   * Build chat system prompt
   */
  buildChatSystemPrompt(context) {
    return `You are a friendly, encouraging English learning assistant for ${context.userName}.

USER INFO:
- Known words: ${context.knownWords}
- Total words: ${context.totalWords}
- Learning for: ${context.joinedDays} days

GUIDELINES:
- Be warm, encouraging, and supportive
- Provide specific, actionable advice
- Reference their actual progress and data
- Keep responses concise (2-3 sentences usually)
- Use simple language suitable for their level
- Use emojis sparingly but effectively

NEVER:
- Make up data you don't have
- Be overly wordy
- Use complex vocabulary unnecessarily`;
  }

  /**
   * Classify user message intent
   */
  classifyIntent(message) {
    const lower = message.toLowerCase();

    if (lower.match(/^(hi|hello|hey|good morning)/)) return 'greeting';
    if (lower.match(/what|how|why|when|where/)) return 'question';
    if (lower.match(/explain|tell me about|what does/)) return 'explanation';
    if (lower.match(/recommend|suggest|should i/)) return 'recommendation';
    if (lower.match(/weak|improve|better/)) return 'improvement';
    if (lower.match(/progress|how am i/)) return 'progress_check';

    return 'general';
  }

  /**
   * Get recent learning history
   */
  async getRecentHistory(userId, days = 7) {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(DISTINCT rs.id) as sessions,
          COALESCE(SUM(rs.duration_seconds), 0) as total_seconds,
          COUNT(DISTINCT uv.word) FILTER (WHERE uv.created_at >= CURRENT_DATE - INTERVAL '${days} days') as new_words
        FROM users u
        LEFT JOIN reading_sessions rs ON u.id = rs.user_id
          AND rs.started_at >= CURRENT_DATE - INTERVAL '${days} days'
        LEFT JOIN user_vocabulary uv ON u.id = uv.user_id
        WHERE u.id = $1
        GROUP BY u.id
      `, [userId]);

      const data = result.rows[0] || {};

      return {
        sessions: parseInt(data.sessions || 0),
        totalMinutes: Math.floor((data.total_seconds || 0) / 60),
        newWords: parseInt(data.new_words || 0),
        summary: `- ${data.sessions || 0} reading sessions
- ${Math.floor((data.total_seconds || 0) / 60)} minutes of reading
- ${data.new_words || 0} new words learned`
      };
    } catch (error) {
      console.error('Failed to get history:', error.message);
      return {
        sessions: 0,
        totalMinutes: 0,
        newWords: 0,
        summary: 'No recent activity'
      };
    }
  }

  /**
   * Get due reviews
   */
  async getDueReviews(userId) {
    try {
      const result = await this.db.query(`
        SELECT word, next_review_at
        FROM user_vocabulary
        WHERE user_id = $1
          AND status = 'learning'
          AND next_review_at IS NOT NULL
          AND next_review_at <= NOW()
        ORDER BY next_review_at
        LIMIT 50
      `, [userId]);

      return result.rows;
    } catch (error) {
      console.error('Failed to get due reviews:', error.message);
      return [];
    }
  }

  /**
   * Get conversation history
   */
  async getConversationHistory(conversationId, limit = 10) {
    try {
      const result = await this.db.query(`
        SELECT user_message, ai_response
        FROM ai_chat_history
        WHERE conversation_id = $1
        ORDER BY message_index DESC
        LIMIT $2
      `, [conversationId, limit]);

      return result.rows.reverse();
    } catch (error) {
      console.error('Failed to get conversation history:', error.message);
      return [];
    }
  }

  /**
   * Generate deep word analysis (etymology, core image, comparisons, mermaid chart, philosophy)
   * Results are cached permanently in word_deep_cache table.
   */
  async generateDeepWordExplain(word, opts = {}) {
    const wordKey = word.toLowerCase().trim();
    const forceRefresh = !!opts.forceRefresh;

    // Check DB cache first (skip if force refresh)
    if (!forceRefresh) {
      try {
        const cached = await this.db.query(
          'SELECT raw_json FROM word_deep_cache WHERE word = $1',
          [wordKey]
        );
        if (cached.rows.length > 0 && cached.rows[0].raw_json) {
          console.log(`[DeepWord] Cache hit for "${wordKey}"`);
          return cached.rows[0].raw_json;
        }
      } catch (dbErr) {
        console.warn('[DeepWord] DB cache lookup failed:', dbErr.message);
      }
    } else {
      console.log(`[DeepWord] Force refresh for "${wordKey}"`);
    }

    // Redis cache key (TTL 30 days)
    const cacheKey = `word:deep:${wordKey}`;
    const cacheTTL = 30 * 24 * 3600;

    const systemPrompt = `你是一名英文单词的灵魂解剖师，用李继刚式深度拆解法分析英语单词。
你的任务是用JSON格式输出以下字段，必须严格按照示例结构：
{
  "etymology": {
    "roots": [{"root": "词根", "lang": "来源语言", "meaning": "原始含义"}],
    "cognates": ["同源词1", "同源词2"],
    "evolution": "简短演变描述"
  },
  "core_image": {
    "formula": "词根组合公式，如 IN+STITUT+ION",
    "metaphor": "中文意象比喻，用一句话点明本质"
  },
  "comparisons": [
    {"word": "易混词", "similarity": "相似点", "difference": "关键区别"}
  ],
  "mermaid": "graph LR 格式的词根扩散图，纯文本Mermaid语法，不要代码块标记",
  "philosophy": "一句中英双语哲学金句，格式：英文\\n中文"
}
只输出JSON，不要任何额外文字。comparisons提供2-3个易混词。mermaid图展示该词根衍生的其他单词。每个mermaid节点必须同时显示英文单词和中文释义，严格使用双引号方括号格式，示例：off["off\\n远离"] --> offend["offend\\n冒犯"]，禁止使用单引号，中文放\\n之后。`;

    const userPrompt = `请深度解析英文单词：${word}`;

    const rawJSON = await this.callOpenAI({
      purpose: 'word_deep_explain',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      model: aiConfig.openai.models.gpt4mini,
      responseFormat: { type: 'json_object' },
      maxTokens: 2000,
      temperature: 0.1,
      cacheKey,
      cacheTTL
    });

    const parsed = this.parseJSON(rawJSON);

    // Sanitize and validate mermaid before storing
    let mermaidRaw = parsed.mermaid || '';
    if (mermaidRaw) {
      // Fix single-quoted labels ['word\n中文'] → ["word\n中文"]
      mermaidRaw = mermaidRaw.replace(/\['([^']*)'\]/g, (_, inner) =>
        '["' + inner.replace(/\r?\n/g, '\\n') + '"]'
      );
      // Fix standalone 'word\n中文' bare node IDs
      const nodeMap = {};
      let nodeCount = 0;
      mermaidRaw = mermaidRaw.replace(/'([^']*)'/g, (_, inner) => {
        const key = inner.replace(/\r?\n/g, '\\n');
        if (!key.trim()) return "''";
        if (!nodeMap[key]) nodeMap[key] = 'n' + (nodeCount++);
        return nodeMap[key] + '["' + key + '"]';
      });
      // Fix single-dash arrows -> to double-dash --> (AI sometimes generates invalid ->)
      mermaidRaw = mermaidRaw.replace(/(?<!-)->/g, '-->');
      // Strip diacritics
      mermaidRaw = mermaidRaw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      // Must contain '-->' to be a real graph
      if (!mermaidRaw.includes('-->')) {
        console.warn(`[DeepWord] Mermaid invalid for "${wordKey}" (no arrows), clearing`);
        mermaidRaw = '';
      }
    }
    parsed.mermaid = mermaidRaw;

    // Save to DB cache
    try {
      await this.db.query(`
        INSERT INTO word_deep_cache (word, etymology, core_image, comparisons, mermaid_chart, philosophy, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (word) DO UPDATE SET
          etymology = EXCLUDED.etymology,
          core_image = EXCLUDED.core_image,
          comparisons = EXCLUDED.comparisons,
          mermaid_chart = EXCLUDED.mermaid_chart,
          philosophy = EXCLUDED.philosophy,
          raw_json = EXCLUDED.raw_json,
          created_at = NOW()
      `, [
        wordKey,
        JSON.stringify(parsed.etymology || {}),
        JSON.stringify(parsed.core_image || {}),
        JSON.stringify(parsed.comparisons || []),
        parsed.mermaid || '',
        parsed.philosophy || '',
        JSON.stringify(parsed)
      ]);
      console.log(`[DeepWord] Saved to DB cache: "${wordKey}"`);
    } catch (saveErr) {
      console.warn('[DeepWord] Failed to save to DB cache:', saveErr.message);
    }

    return parsed;
  }

  /**
   * Generate UUID
   */
  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}

module.exports = AITutorService;
