const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '';
const DEEPL_API_TYPE = process.env.DEEPL_API_TYPE || 'free'; // 'free' or 'pro'
const DEEPL_TIMEOUT_MS = Number(process.env.DEEPL_TIMEOUT_MS || 8000);
const PROXY_URL = process.env.OPENAI_PROXY || '';

// DeepL API endpoints
const DEEPL_ENDPOINTS = {
  free: 'api-free.deepl.com',
  pro: 'api.deepl.com'
};

/**
 * Translate text using DeepL API
 * DeepL provides high-quality translations with generous rate limits
 *
 * Free tier: 500,000 characters/month
 * Rate limit: Typically more lenient than Google Translate
 *
 * @param {string} text - Text to translate
 * @param {string} targetLang - Target language code (default: 'ZH')
 * @returns {Promise<string>} - Translated text
 */
async function translateWithDeepL(text, targetLang = 'ZH') {
  if (!text || typeof text !== 'string') {
    throw new Error('DEEPL_INVALID_INPUT');
  }

  // Check if API key is configured (not the placeholder value)
  if (!DEEPL_API_KEY || DEEPL_API_KEY === 'your-deepl-api-key-here') {
    console.log('[DeepL] API key not configured, skipping DeepL translation');
    throw new Error('DEEPL_API_KEY_NOT_CONFIGURED');
  }

  // DeepL uses 'ZH' for Chinese (simplified)
  // Map our target language to DeepL format
  const deeplTargetLang = targetLang === 'zh-CN' || targetLang === 'zh' ? 'ZH' : targetLang.toUpperCase();

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      text: [text],
      target_lang: deeplTargetLang,
      source_lang: 'EN'
    });

    const hostname = DEEPL_ENDPOINTS[DEEPL_API_TYPE] || DEEPL_ENDPOINTS.free;
    const options = {
      hostname,
      port: 443,
      path: '/v2/translate',
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: DEEPL_TIMEOUT_MS
    };

    // Use proxy if configured
    if (PROXY_URL) {
      options.agent = new HttpsProxyAgent(PROXY_URL);
      console.log('[DeepL] Using proxy for this request');
    }

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const response = JSON.parse(data);
            if (response.translations && response.translations.length > 0) {
              const translated = response.translations[0].text.trim();
              if (translated) {
                console.log(`[DeepL] Success: "${text}" -> "${translated}"`);
                resolve(translated);
              } else {
                reject(new Error('DEEPL_EMPTY_RESPONSE'));
              }
            } else {
              reject(new Error('DEEPL_INVALID_RESPONSE_FORMAT'));
            }
          } else if (res.statusCode === 456) {
            // Quota exceeded
            reject(new Error('DEEPL_QUOTA_EXCEEDED'));
          } else if (res.statusCode === 429) {
            // Too many requests
            reject(new Error('DEEPL_HTTP_429'));
          } else if (res.statusCode === 403) {
            // Invalid API key
            reject(new Error('DEEPL_INVALID_API_KEY'));
          } else {
            reject(new Error(`DEEPL_HTTP_${res.statusCode}: ${data}`));
          }
        } catch (err) {
          reject(new Error(`DEEPL_PARSE_ERROR: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`DEEPL_REQUEST_ERROR: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('DEEPL_TIMEOUT'));
    });

    req.write(postData);
    req.end();
  });
}

module.exports = {
  translateWithDeepL
};
