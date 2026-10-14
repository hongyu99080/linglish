/**
 * Redis Cache Service
 *
 * Provides a consistent caching interface following the service-based architecture.
 * Graceful degradation: cache failures fall through to database queries.
 */

const { createClient } = require('redis');
const performanceConfig = require('../config/performance');

let client = null;
let isConnected = false;

/**
 * Initialize Redis connection
 */
async function init() {
  if (!performanceConfig.cache.enabled) {
    console.log('[Cache] Caching disabled via configuration');
    return false;
  }

  try {
    const url = performanceConfig.cache.password
      ? `redis://:${performanceConfig.cache.password}@${performanceConfig.cache.host}:${performanceConfig.cache.port}/${performanceConfig.cache.db}`
      : `redis://${performanceConfig.cache.host}:${performanceConfig.cache.port}/${performanceConfig.cache.db}`;

    client = createClient({ url });

    client.on('error', (err) => {
      console.error('[Cache] Redis client error:', err.message);
      isConnected = false;
    });

    client.on('connect', () => {
      console.log('[Cache] Connected to Redis');
      isConnected = true;
    });

    client.on('disconnect', () => {
      console.log('[Cache] Disconnected from Redis');
      isConnected = false;
    });

    await client.connect();
    return true;
  } catch (err) {
    console.error('[Cache] Failed to connect to Redis:', err.message);
    isConnected = false;
    return false;
  }
}

/**
 * Build cache key with prefix
 * @param {string} key - The cache key
 * @returns {string} Prefixed cache key
 */
function buildKey(key) {
  return `${performanceConfig.cache.keyPrefix}${key}`;
}

/**
 * Get cached value
 * @param {string} key - Cache key following pattern {domain}:{entity}:{id}
 * @returns {Promise<object|null>} Parsed JSON data or null if miss/error
 */
async function get(key) {
  if (!isConnected || !client) {
    return null;
  }

  try {
    const data = await client.get(buildKey(key));
    if (!data) {
      return null;
    }

    const parsed = JSON.parse(data);
    return parsed.data;
  } catch (err) {
    console.error('[Cache] Get error for key', key, ':', err.message);
    return null;
  }
}

/**
 * Set cached value
 * @param {string} key - Cache key
 * @param {object} value - Data to cache (will be JSON serialized)
 * @param {number} [ttl] - Time-to-live in seconds (default from config)
 * @returns {Promise<boolean>} True if cached successfully
 */
async function set(key, value, ttl = performanceConfig.cache.defaultTTL) {
  if (!isConnected || !client) {
    return false;
  }

  try {
    // Clamp TTL to valid range (60-300 seconds per spec)
    const clampedTTL = Math.max(60, Math.min(300, ttl));

    const cacheEntry = {
      data: value,
      cachedAt: new Date().toISOString(),
      ttl: clampedTTL,
    };

    await client.setEx(buildKey(key), clampedTTL, JSON.stringify(cacheEntry));
    return true;
  } catch (err) {
    console.error('[Cache] Set error for key', key, ':', err.message);
    return false;
  }
}

/**
 * Delete cached value
 * @param {string} key - Exact cache key to delete
 * @returns {Promise<boolean>} True if deleted (or didn't exist)
 */
async function del(key) {
  if (!isConnected || !client) {
    return false;
  }

  try {
    await client.del(buildKey(key));
    return true;
  } catch (err) {
    console.error('[Cache] Delete error for key', key, ':', err.message);
    return false;
  }
}

/**
 * Invalidate all keys matching a pattern
 * @param {string} pattern - Redis SCAN pattern (e.g., vocabulary:user:123*)
 * @returns {Promise<number>} Count of keys deleted
 */
async function invalidate(pattern) {
  if (!isConnected || !client) {
    return 0;
  }

  try {
    const fullPattern = buildKey(pattern);
    let count = 0;

    // Use SCAN for non-blocking iteration
    for await (const key of client.scanIterator({ MATCH: fullPattern, COUNT: 100 })) {
      await client.del(key);
      count++;
    }

    if (count > 0) {
      console.log(`[Cache] Invalidated ${count} keys matching pattern: ${pattern}`);
    }
    return count;
  } catch (err) {
    console.error('[Cache] Invalidate error for pattern', pattern, ':', err.message);
    return 0;
  }
}

/**
 * Check if Redis is connected
 * @returns {boolean} Connection status
 */
function getConnectionStatus() {
  return isConnected;
}

/**
 * Close Redis connection
 */
async function close() {
  if (client) {
    await client.quit();
    client = null;
    isConnected = false;
    console.log('[Cache] Connection closed');
  }
}

module.exports = {
  init,
  get,
  set,
  del,
  invalidate,
  isConnected: getConnectionStatus,
  close,
};
