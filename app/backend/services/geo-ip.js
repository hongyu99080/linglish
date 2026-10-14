/**
 * GeoIP Service
 * Detects user's geographic location based on IP address
 */

const axios = require('axios');

function log(prefix, msg, user = 'unknown') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [GeoIP] user=${user} ${prefix}${msg}`);
}

function warn(prefix, msg, user = 'unknown') {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] [GeoIP] user=${user} ${prefix}${msg}`);
}

// Cache for IP lookup results (TTL: 1 hour)
const ipCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Clean up expired cache entries
 */
function cleanupCache() {
  const now = Date.now();
  for (const [ip, data] of ipCache.entries()) {
    if (now - data.timestamp > CACHE_TTL) {
      ipCache.delete(ip);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupCache, 10 * 60 * 1000);

/**
 * Extract IP address from request
 * @param {Object} req - HTTP request object
 * @returns {string} IP address
 */
function extractIP(req) {
  // Check for proxied IP addresses
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for may contain multiple IPs, take the first one
    return forwarded.split(',')[0].trim();
  }

  const realIP = req.headers['x-real-ip'];
  if (realIP) {
    return realIP.trim();
  }

  // Fallback to direct connection IP
  return req.socket.remoteAddress || req.connection.remoteAddress;
}

/**
 * Check if IP is from mainland China
 * @param {string} ip - IP address
 * @returns {Promise<Object>} Result with isChina flag and country info
 */
async function checkIsChina(ip, userLabel = 'unknown') {
  // Handle localhost and private IPs
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    log('', 'Localhost or private IP detected, assuming non-China for development', userLabel);
    return {
      isChina: false,
      country: 'LOCAL',
      ip,
      source: 'local',
    };
  }

  // Check cache
  const cached = ipCache.get(ip);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    log('', `Cache hit for IP: ${ip}`, userLabel);
    return cached.data;
  }

  try {
    // Use free IP geolocation API (ip-api.com)
    // Note: This service is free for non-commercial use, limited to 45 requests/minute
    const response = await axios.get(`http://ip-api.com/json/${ip}`, {
      timeout: 5000,
      params: {
        fields: 'status,message,country,countryCode,query'
      }
    });

    if (response.data.status === 'success') {
      const isChina = response.data.countryCode === 'CN';
      const result = {
        isChina,
        country: response.data.country,
        countryCode: response.data.countryCode,
        ip: response.data.query || ip,
        source: 'ip-api.com',
      };

      // Cache the result
      ipCache.set(ip, {
        data: result,
        timestamp: Date.now(),
      });

      log('', `IP lookup successful: ${ip} -> Country: ${response.data.country} isChina: ${isChina}`, userLabel);
      return result;
    } else {
      throw new Error(`GeoIP API error: ${response.data.message || 'Unknown error'}`);
    }
  } catch (error) {
    warn('', `Failed to lookup IP: ${ip} ${error.message}`, userLabel);

    // Fallback: assume not China on error to avoid blocking users
    const fallbackResult = {
      isChina: false,
      country: 'UNKNOWN',
      countryCode: null,
      ip,
      source: 'fallback',
      error: error.message,
    };

    return fallbackResult;
  }
}

/**
 * Check if request is from mainland China
 * @param {Object} req - HTTP request object
 * @returns {Promise<Object>} Result with isChina flag and geo info
 */
async function isRequestFromChina(req, userLabel = 'unknown') {
  let label = userLabel || 'unknown';
  if (label === 'unknown') {
    try {
      const authHeader = req?.headers?.['authorization'] || '';
      const [, token] = authHeader.split(' ');
      if (token) {
        const authService = require('./auth');
        const user = await authService.requireUser(token);
        if (user?.username || user?.email) {
          label = user.username || user.email;
        } else if (user?.id) {
          label = `user-${user.id}`;
        }
      }
    } catch (_) { /* ignore */ }
  }
  const ip = extractIP(req);
  return await checkIsChina(ip, label);
}

module.exports = {
  extractIP,
  checkIsChina,
  isRequestFromChina,
};
