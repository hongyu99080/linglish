const https = require('https');
const querystring = require('querystring');

const aiConfig = require('../config/ai-config');

let cachedToken = null;

function getBaiduConfig() {
  return aiConfig.speechToText?.baidu || {};
}

async function fetchAccessToken() {
  const config = getBaiduConfig();
  if (!config.apiKey || !config.secretKey) {
    throw new Error('Baidu ASR credentials are missing. Please set BAIDU_ASR_API_KEY and BAIDU_ASR_SECRET_KEY.');
  }

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const params = querystring.stringify({
    grant_type: 'client_credentials',
    client_id: config.apiKey,
    client_secret: config.secretKey,
  });

  const tokenUrl = `/oauth/2.0/token?${params}`;

  const body = await httpRequest({
    hostname: 'aip.baidubce.com',
    path: tokenUrl,
    method: 'GET',
  });

  if (!body.access_token) {
    throw new Error(`Failed to retrieve Baidu access token: ${JSON.stringify(body)}`);
  }

  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };

  return cachedToken.token;
}

function httpRequest(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const data = text ? JSON.parse(text) : {};
            if (res.statusCode >= 400) {
              const err = new Error(`Baidu request failed with status ${res.statusCode}: ${text}`);
              err.status = res.statusCode;
              err.response = data;
              return reject(err);
            }
            resolve(data);
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.on('error', reject);

    if (payload) {
      req.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }

    req.end();
  });
}

async function transcribe(buffer, options = {}) {
  const config = getBaiduConfig();
  const token = await fetchAccessToken();

  const speech = buffer.toString('base64');

  const payload = {
    format: options.format || config.format || 'pcm',
    rate: options.sampleRate || config.sampleRate || 16000,
    channel: 1,
    token,
    cuid: options.cuid || config.cuid || 'linglish-app',
    speech,
    len: buffer.length,
    dev_pid: options.devPid || config.devPid || 1536, // English default: 1536, Chinese: 1537
  };

  const result = await httpRequest(
    {
      hostname: 'vop.baidu.com',
      path: '/server_api',
      method: 'POST',
    },
    payload,
  );

  if (result.err_no !== 0) {
    const error = new Error(result.err_msg || 'Baidu ASR request failed');
    error.code = result.err_no;
    error.response = result;
    throw error;
  }

  const text = Array.isArray(result.result) ? result.result.join('\n') : '';

  return {
    text,
    segments: Array.isArray(result.result)
      ? result.result.map((line, index) => ({
          index,
          start: 0,
          end: 0,
          text: line.trim(),
        }))
      : [],
    language: options.language || 'zh',
  };
}

module.exports = {
  transcribe,
};
