/**
 * AI Service Configuration
 * Centralized configuration for all AI-related services
 */

require('dotenv').config();

const aiConfig = {
  // OpenAI Configuration (支持自定义API)
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE || 'https://api.openai.com/v1',

    models: {
      gpt4: process.env.OPENAI_MODEL_GPT4 || 'gpt-4o',
      gpt35: process.env.OPENAI_MODEL_GPT35 || 'gpt-4o',
      gpt4mini: process.env.OPENAI_MODEL_GPT4_MINI || 'gpt-4o-mini',
      roleplay: process.env.OPENAI_MODEL_ROLEPLAY || process.env.OPENAI_MODEL_GPT4_MINI || 'gpt-4o-mini',
    },
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS) || 2000,
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE) || 1.0,
    topP: parseFloat(process.env.OPENAI_TOP_P) || 1.0,
    frequencyPenalty: parseFloat(process.env.OPENAI_FREQUENCY_PENALTY) || 0.0,
    presencePenalty: parseFloat(process.env.OPENAI_PRESENCE_PENALTY) || 0.0,
    maxRetries: parseInt(process.env.AI_MAX_RETRY_ATTEMPTS) || 3,

    // HTTP代理配置(如果需要)
    httpAgent: process.env.OPENAI_PROXY ? {
      proxy: process.env.OPENAI_PROXY
    } : null,

    // 系统提示词前缀
    systemPrefix: process.env.OPENAI_SYSTEM_PREFIX || '你是一个友好的英语学习助手。'
  },

  // Redis Configuration
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0
  },

  // Cache Configuration
  cache: {
    enabled: process.env.AI_CACHE_ENABLED === 'true',
    ttl: parseInt(process.env.AI_CACHE_TTL_SECONDS) || 86400, // 24 hours
    keyPrefix: 'linglish:ai:'
  },

  // Cost Tracking
  costTracking: {
    enabled: process.env.AI_COST_TRACKING_ENABLED === 'true',
    dailyBudget: parseFloat(process.env.AI_DAILY_BUDGET) || 10.0,
    monthlyBudget: parseFloat(process.env.AI_MONTHLY_BUDGET) || 300.0,
    alertThreshold: parseFloat(process.env.AI_COST_ALERT_THRESHOLD) || 0.8
  },

  // Feature Flags
  features: {
    aiTutor: process.env.ENABLE_AI_TUTOR === 'true',
    aiChat: process.env.ENABLE_AI_CHAT === 'true',
    aiRoleplay: process.env.ENABLE_AI_ROLEPLAY === 'true',
    dailyPlan: process.env.ENABLE_DAILY_PLAN === 'true',
    contentRecommendation: process.env.ENABLE_CONTENT_RECOMMENDATION === 'true',
    videoTranscription: process.env.ENABLE_VIDEO_TRANSCRIPTION !== 'false'
  },

  // Speech-to-Text / Transcription Configuration
  speechToText: {
    provider: (process.env.STT_PROVIDER || 'openai').toLowerCase(),
    fallbackProvider: process.env.STT_FALLBACK_PROVIDER ? process.env.STT_FALLBACK_PROVIDER.toLowerCase() : 'auto',
    model: process.env.OPENAI_WHISPER_MODEL || 'whisper-1',
    fallbackModel: process.env.OPENAI_WHISPER_FALLBACK_MODEL || null, // Whisper only has whisper-1, no fallback model
    baidu: {
      appId: process.env.BAIDU_ASR_APP_ID || process.env.BAIDU_YUYIN_APPID || '',
      apiKey: process.env.BAIDU_ASR_API_KEY || process.env.BAIDU_YUYIN_API_KEY || '',
      secretKey: process.env.BAIDU_ASR_SECRET_KEY || process.env.BAIDU_YUYIN_SECRET_KEY || '',
      cuid: process.env.BAIDU_ASR_CUID || 'linglish-app',
      format: process.env.BAIDU_ASR_FORMAT || 'pcm',
      sampleRate: parseInt(process.env.BAIDU_ASR_SAMPLE_RATE, 10) || 16000
    },
    custom: {
      endpoint: process.env.STT_CUSTOM_ENDPOINT || '',
      method: process.env.STT_CUSTOM_METHOD || 'POST',
      fileField: process.env.STT_CUSTOM_FILE_FIELD || 'audio_file',
      languageParam: process.env.STT_CUSTOM_LANGUAGE_PARAM || '',
      outputParam: process.env.STT_CUSTOM_OUTPUT_PARAM || 'output',
      outputFormat: process.env.STT_CUSTOM_OUTPUT || 'text',
      debugSegments: process.env.STT_CUSTOM_DEBUG_SEGMENTS === 'true',
      diarizeParam: process.env.STT_CUSTOM_DIARIZE_PARAM || 'diarize',
      diarizeValue: process.env.STT_CUSTOM_DIARIZE || 'false',
      wordTimestampsParam: process.env.STT_CUSTOM_WORD_TIMESTAMPS_PARAM || 'word_timestamps',
      wordTimestampsValue: process.env.STT_CUSTOM_WORD_TIMESTAMPS || 'true',
      headers: (() => {
        if (!process.env.STT_CUSTOM_HEADERS_JSON) return {};
        try {
          return JSON.parse(process.env.STT_CUSTOM_HEADERS_JSON);
        } catch (err) {
          console.warn(
            'Invalid STT_CUSTOM_HEADERS_JSON, expected JSON object:',
            err.message,
          );
          return {};
        }
      })(),
      // Chunking configuration for large files
      enableChunking: process.env.STT_ENABLE_CHUNKING !== 'false', // Default enabled
      chunkDurationMinutes: parseInt(process.env.STT_CHUNK_DURATION_MINUTES, 10) || 10, // 10 minutes per chunk
      chunkThresholdMinutes: parseInt(process.env.STT_CHUNK_THRESHOLD_MINUTES, 10) || 15, // Chunk if > 15 minutes
      timeout: parseInt(process.env.STT_TIMEOUT_MS, 10) || 3600000, // 60 minutes default timeout
    }
  },

  // Model Pricing (USD per 1K tokens)
  pricing: {
    'gpt-4-turbo-preview': {
      input: 0.01,
      output: 0.03
    },
    'gpt-3.5-turbo': {
      input: 0.0005,
      output: 0.0015
    },
    'gpt-4o': {
      input: 0.005,
      output: 0.015
    }
  },

  // Model Selection Strategy
  modelStrategy: {
    // 简单任务用GPT-3.5,复杂任务用GPT-4
    simpleTaskThreshold: 500, // tokens
    preferGPT35For: ['greeting', 'simple_question', 'encouragement'],
    preferGPT4For: ['path_generation', 'complex_analysis', 'personalized_plan']
  }
};

module.exports = aiConfig;
