/**
 * OpenAI-based translation provider for high-quality word translations
 * Uses GPT-3.5-turbo for cost-effective, accurate translations
 */

const OpenAI = require('openai');
const aiConfig = require('../../../config/ai-config');
const { HttpsProxyAgent } = require('https-proxy-agent');

let openaiClient = null;

/**
 * Initialize OpenAI client (lazy initialization)
 */
function getOpenAIClient() {
  if (openaiClient) return openaiClient;

  const openaiConfig = {
    apiKey: aiConfig.openai.apiKey,
    baseURL: aiConfig.openai.baseURL
  };

  if (process.env.OPENAI_PROXY) {
    try {
      openaiConfig.httpAgent = new HttpsProxyAgent(process.env.OPENAI_PROXY);
    } catch (error) {
      console.warn('[OpenAI Translation] Proxy configuration failed:', error.message);
    }
  }

  openaiClient = new OpenAI(openaiConfig);
  return openaiClient;
}

/**
 * Translate English word to Chinese using OpenAI GPT-3.5-turbo
 * @param {string} word - English word or phrase to translate
 * @returns {Promise<string>} - Chinese translation
 */
async function translateWithOpenAI(word) {
  if (!word || typeof word !== 'string') {
    throw new Error('Invalid word provided for translation');
  }

  const normalizedWord = word.trim();

  try {
    const client = getOpenAIClient();

    // Use GPT-3.5-turbo for cost-effective translation
    const response = await client.chat.completions.create({
      model: aiConfig.openai.models.gpt35,
      messages: [
        {
          role: 'system',
          content: `You are a professional English-Chinese translator specializing in vocabulary translation for language learners.

Translation Rules:
1. Provide concise, accurate Chinese translations suitable for vocabulary learning
2. For single words: give the most common meaning(s), separated by commas if multiple
3. For phrases: provide natural Chinese translation
4. Include part of speech context only when necessary for clarity
5. Avoid verbose explanations - keep it simple and clear
6. DO NOT translate proper nouns (names, places, brands) - return them as-is
7. For idioms or expressions, provide the equivalent Chinese expression
8. Focus on the most practical, commonly used meanings

Examples:
- "lucky" → "幸运的"
- "wed" → "结婚"
- "hole" → "洞，孔"
- "make sense" → "有道理，说得通"
- "John" → "John"
- "ti" → "唱名（音阶第七音）"`
        },
        {
          role: 'user',
          content: `Translate to Chinese: ${normalizedWord}`
        }
      ],
      temperature: 0.3, // Lower temperature for more consistent translations
      max_tokens: 100,
      timeout: 10000 // 10 second timeout
    });

    const translation = response.choices[0]?.message?.content?.trim();

    if (!translation) {
      throw new Error('Empty translation response from OpenAI');
    }

    // Log token usage for cost tracking
    const usage = response.usage;
    console.log(`[OpenAI Translation] Word: "${normalizedWord}" → "${translation}" | Tokens: ${usage.total_tokens} (prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens})`);

    return translation;
  } catch (error) {
    console.error(`[OpenAI Translation] Failed for word "${normalizedWord}":`, error.message);

    // Re-throw with more context
    if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      throw new Error('TRANSLATE_TIMEOUT');
    }
    if (error.status === 429) {
      throw new Error('TRANSLATE_RATE_LIMIT');
    }
    if (error.status === 401) {
      throw new Error('TRANSLATE_AUTH_FAILED');
    }

    throw new Error(`TRANSLATE_OPENAI_ERROR: ${error.message}`);
  }
}

module.exports = {
  translateWithOpenAI,
};
