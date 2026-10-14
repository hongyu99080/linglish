const http = require('http');
const https = require('https');
const { URL } = require('url');

const LIBRETRANSLATE_URL = process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com/translate';
const LIBRETRANSLATE_API_KEY = process.env.LIBRETRANSLATE_API_KEY || '';
const LIBRETRANSLATE_TIMEOUT_MS = Number(process.env.LIBRETRANSLATE_TIMEOUT_MS || 5000);

/**
 * Translate text using LibreTranslate API
 * @param {string} text - Text to translate
 * @param {string} targetLang - Target language code (default: 'zh')
 * @returns {Promise<string>} - Translated text
 */
function translateViaLibreTranslate(text, targetLang = 'zh') {
  return new Promise((resolve, reject) => {
    if (!LIBRETRANSLATE_URL) {
      return reject(new Error('TRANSLATE_URL_NOT_CONFIGURED'));
    }

    let endpoint;
    try {
      endpoint = new URL(LIBRETRANSLATE_URL);
    } catch (err) {
      return reject(err);
    }

    const requestPayload = {
      q: text,
      source: 'en',
      target: targetLang,
      format: 'text',
    };
    if (LIBRETRANSLATE_API_KEY) {
      requestPayload.api_key = LIBRETRANSLATE_API_KEY;
    }
    const body = JSON.stringify(requestPayload);

    const requestOptions = {
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: endpoint.pathname + (endpoint.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: LIBRETRANSLATE_TIMEOUT_MS,
    };

    const client = endpoint.protocol === 'https:' ? https : http;

    const req = client.request(requestOptions, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`TRANSLATE_HTTP_${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const translated = payload?.translatedText?.trim();
          if (!translated) {
            return reject(new Error('TRANSLATE_EMPTY_RESPONSE'));
          }
          resolve(translated);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('TRANSLATE_TIMEOUT'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Translate text using LibreTranslate with retry logic and multiple language codes
 * @param {string} text - Text to translate
 * @returns {Promise<string>} - Translated text
 */
async function translateWithLibreTranslate(text) {
  // 尝试多个target参数（不同的LibreTranslate实例可能支持不同的语言代码）
  const targetLangCodes = ['zh', 'zh-CN', 'zh-Hans'];
  const maxRetries = 3;
  const baseDelayMs = 1000; // Start with 1 second delay

  for (const targetLang of targetLangCodes) {
    let lastError = null;

    // Retry logic with exponential backoff for rate limiting
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await translateViaLibreTranslate(text, targetLang);
        if (result) {
          console.log(`[LibreTranslate] Success with target=${targetLang} (attempt ${attempt + 1})`);
          return result;
        }
      } catch (err) {
        lastError = err;

        // For HTTP 429 (rate limit), retry with exponential backoff
        if (err.message.includes('HTTP_429')) {
          const delayMs = baseDelayMs * Math.pow(2, attempt);
          console.log(`[LibreTranslate] Rate limited (attempt ${attempt + 1}/${maxRetries}), retrying after ${delayMs}ms...`);

          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            continue;
          }
          // Max retries reached for this language code, try next language code
          console.log(`[LibreTranslate] Max retries reached for target=${targetLang}`);
          break;
        }

        // 对于400错误，尝试下一个language code
        if (err.message.includes('HTTP_400')) {
          console.log(`[LibreTranslate] Failed with target=${targetLang}, trying next...`);
          break;
        }

        // 对于其他错误（超时、网络错误等），直接抛出
        throw err;
      }
    }

    // If we got a 429 error after all retries, continue to try next language code
    if (lastError && lastError.message.includes('HTTP_429')) {
      continue;
    }
  }

  // 所有language code都失败
  throw new Error('TRANSLATE_HTTP_429');
}

module.exports = {
  translateWithLibreTranslate,
};
