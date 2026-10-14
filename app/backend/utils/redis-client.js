/**
 * Redis Client for Caching
 * Handles connection and basic operations
 */

const Redis = require('ioredis');
const aiConfig = require('../config/ai-config');

class RedisClient {
  constructor() {
    this.client = null;
    this.connected = false;
  }

  /**
   * Initialize Redis connection
   */
  async connect() {
    if (this.connected) {
      return this.client;
    }

    try {
      this.client = new Redis({
        host: aiConfig.redis.host,
        port: aiConfig.redis.port,
        password: aiConfig.redis.password,
        db: aiConfig.redis.db,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3
      });

      this.client.on('connect', () => {
        console.log('✅ Redis connected');
        this.connected = true;
      });

      this.client.on('error', (err) => {
        console.error('❌ Redis error:', err.message);
        this.connected = false;
      });

      // Test connection
      await this.client.ping();

      return this.client;
    } catch (error) {
      console.warn('⚠️ Redis unavailable, caching disabled:', error.message);
      this.client = null;
      this.connected = false;
      return null;
    }
  }

  /**
   * Get value from cache
   */
  async get(key) {
    if (!this.connected || !aiConfig.cache.enabled) {
      return null;
    }

    try {
      const value = await this.client.get(aiConfig.cache.keyPrefix + key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error('Redis get error:', error.message);
      return null;
    }
  }

  /**
   * Set value in cache
   */
  async set(key, value, ttl = null) {
    if (!this.connected || !aiConfig.cache.enabled) {
      return false;
    }

    try {
      const fullKey = aiConfig.cache.keyPrefix + key;
      const serialized = JSON.stringify(value);
      const expirySeconds = ttl || aiConfig.cache.ttl;

      await this.client.setex(fullKey, expirySeconds, serialized);
      return true;
    } catch (error) {
      console.error('Redis set error:', error.message);
      return false;
    }
  }

  /**
   * Delete key from cache
   */
  async delete(key) {
    if (!this.connected || !aiConfig.cache.enabled) {
      return false;
    }

    try {
      await this.client.del(aiConfig.cache.keyPrefix + key);
      return true;
    } catch (error) {
      console.error('Redis delete error:', error.message);
      return false;
    }
  }

  /**
   * Check if key exists
   */
  async exists(key) {
    if (!this.connected || !aiConfig.cache.enabled) {
      return false;
    }

    try {
      const result = await this.client.exists(aiConfig.cache.keyPrefix + key);
      return result === 1;
    } catch (error) {
      console.error('Redis exists error:', error.message);
      return false;
    }
  }

  /**
   * Increment counter
   */
  async increment(key, by = 1) {
    if (!this.connected) {
      return 0;
    }

    try {
      const fullKey = aiConfig.cache.keyPrefix + key;
      const result = await this.client.incrby(fullKey, by);
      return result;
    } catch (error) {
      console.error('Redis increment error:', error.message);
      return 0;
    }
  }

  /**
   * Close connection
   */
  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.connected = false;
    }
  }
}

// Singleton instance
const redisClient = new RedisClient();

module.exports = redisClient;
