/**
 * Performance Configuration
 *
 * Centralized configuration for caching, compression, and performance monitoring.
 * Values can be overridden via environment variables.
 */

module.exports = {
  cache: {
    enabled: process.env.CACHE_ENABLED !== 'false',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,
    defaultTTL: parseInt(process.env.CACHE_TTL) || 300, // 5 minutes in seconds
    keyPrefix: 'linglish:',
  },

  compression: {
    enabled: process.env.COMPRESSION_ENABLED !== 'false',
    brotliQuality: 4, // Balance compression/speed (1-11)
    gzipLevel: 6, // Standard gzip level (1-9)
    threshold: 1024, // Minimum bytes to compress
    mimeTypes: [
      'text/html',
      'text/css',
      'text/javascript',
      'text/plain',
      'text/xml',
      'application/javascript',
      'application/json',
      'application/xml',
      'image/svg+xml',
    ],
  },

  staticAssets: {
    maxAge: 31536000, // 1 year in seconds
    immutable: true, // Add immutable directive for versioned assets
    etag: true, // Generate ETags
  },

  connectionPool: {
    max: parseInt(process.env.DB_POOL_MAX) || 20,
    min: parseInt(process.env.DB_POOL_MIN) || 5,
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 2000,
  },

  monitoring: {
    lighthouseSchedule: '0 6 * * *', // Daily at 6 AM
    alertThresholds: {
      lcp: { warning: 2000, critical: 2500 },
      fid: { warning: 75, critical: 100 },
      cls: { warning: 0.05, critical: 0.1 },
      lighthouse: { warning: 85, critical: 80 },
    },
  },
};
