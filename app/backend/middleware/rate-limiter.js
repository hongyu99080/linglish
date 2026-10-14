/**
 * Rate Limiter Middleware
 *
 * Prevents API abuse by limiting the number of requests from a single IP address
 * Uses in-memory storage for simplicity (consider Redis for production with multiple servers)
 */

// Decode (and verify) the bearer token to derive a stable per-user key.
// Synchronous, DB-free, and returns null on any failure — so it's safe to call
// inside a keyGenerator without awaiting or throwing.
const { decodeToken } = require('../services/auth');

// Store for tracking requests: Map<key, Array<timestamp>>
const requestStore = new Map();

/**
 * Extract a client IP key from the request (best effort behind proxies).
 */
function getIpKey(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         'unknown';
}

/**
 * Prefer the authenticated user id as the rate-limit key so that many users
 * sharing one egress IP (NAT/CGNAT/VPN, or an frp tunnel that collapses every
 * client to a single upstream IP) are limited independently instead of sharing
 * one global counter. Falls back to IP for unauthenticated requests.
 */
function getUserOrIpKey(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const payload = decodeToken(token);
    if (payload && payload.sub) {
      return `user:${payload.sub}`;
    }
  }
  return getIpKey(req);
}

// Cleanup interval - remove old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const cleanupThreshold = 60000; // 1 minute

  for (const [ip, requests] of requestStore.entries()) {
    // Remove old timestamps
    const recentRequests = requests.filter(timestamp => now - timestamp < cleanupThreshold);

    if (recentRequests.length === 0) {
      requestStore.delete(ip);
    } else {
      requestStore.set(ip, recentRequests);
    }
  }
}, 300000); // 5 minutes

/**
 * Create a rate limiter with custom settings
 *
 * @param {Object} options - Rate limiter configuration
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000 - 1 minute)
 * @param {number} options.max - Maximum number of requests per window (default: 100)
 * @param {string} options.message - Error message to return when limit is exceeded
 * @param {number} options.statusCode - HTTP status code for rate limit errors (default: 429)
 * @param {Function} options.keyGenerator - Function to generate rate limit key from request (default: IP address)
 * @param {Function} options.skip - Function to skip rate limiting for certain requests
 * @returns {Function} Middleware function
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 60000, // 1 minute
    max = 100,         // 100 requests per window
    message = 'Too many requests, please try again later.',
    statusCode = 429,
    keyGenerator = (req) => {
      // Get IP from various possible sources
      return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
             req.headers['x-real-ip'] ||
             req.connection?.remoteAddress ||
             req.socket?.remoteAddress ||
             'unknown';
    },
    skip = () => false // Function to skip rate limiting for certain requests
  } = options;

  /**
   * Rate limiter middleware function
   *
   * @param {Object} req - HTTP request object
   * @param {Object} res - HTTP response object
   * @param {Function} next - Next middleware function
   * @returns {boolean} - Returns false if rate limit exceeded, true otherwise
   */
  return function rateLimiterMiddleware(req, res) {
    // Skip rate limiting if skip function returns true
    if (skip(req)) {
      return true;
    }

    const key = keyGenerator(req);
    const now = Date.now();

    // Get or initialize request history for this key
    let requests = requestStore.get(key) || [];

    // Filter out requests outside the current window
    requests = requests.filter(timestamp => now - timestamp < windowMs);

    // Check if limit exceeded
    if (requests.length >= max) {
      // Calculate retry-after time
      const oldestRequest = Math.min(...requests);
      const retryAfter = Math.ceil((oldestRequest + windowMs - now) / 1000); // in seconds

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', new Date(oldestRequest + windowMs).toISOString());
      res.setHeader('Retry-After', retryAfter);

      // Send error response
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Rate limit exceeded',
        message: message,
        retryAfter: retryAfter
      }));

      console.warn(`Rate limit exceeded for ${key}: ${requests.length} requests in ${windowMs}ms`);
      return false;
    }

    // Add current request timestamp
    requests.push(now);
    requestStore.set(key, requests);

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', max - requests.length);
    res.setHeader('X-RateLimit-Reset', new Date(now + windowMs).toISOString());

    return true; // Allow request
  };
}

/**
 * Preset rate limiters for common use cases
 */
const presets = {
  // Strict rate limiting for authentication endpoints
  auth: createRateLimiter({
    windowMs: 600000, // 10 minutes
    max: 120,         // allow 120 auth requests / 10min (~12 req/min) to reduce false positives
    message: 'Too many authentication attempts. Please try again in a few minutes.',
  }),

  // Standard rate limiting for general API endpoints
  api: createRateLimiter({
    windowMs: 60000,  // 1 minute
    max: 600,         // 600 requests per minute (broader limit per user request)
    message: 'Too many API requests. Please slow down.',
  }),

  // Lenient rate limiting for static assets
  static: createRateLimiter({
    windowMs: 60000,  // 1 minute
    max: 300,         // 300 requests per minute
    message: 'Too many requests for static assets.',
  }),

  // Very strict rate limiting for expensive operations (AI, transcription, etc.)
  expensive: createRateLimiter({
    windowMs: 3600000, // 1 hour
    max: 20,           // 20 requests per hour
    message: 'Rate limit for resource-intensive operations exceeded. Please try again later.',
  }),

  // Upload rate limiting.
  // Keyed per authenticated user (not per IP): behind the frp tunnel every
  // client collapses to one upstream IP, so an IP-keyed cap was effectively a
  // single global limit shared across the whole user base. Keying on user id
  // makes the cap per-account; batch uploads and retries no longer exhaust a
  // shared counter. Cap raised to 30/hr for batch + retry headroom.
  upload: createRateLimiter({
    windowMs: 3600000, // 1 hour
    max: 30,           // 30 uploads per hour per user
    message: 'Too many uploads. Please wait before uploading more files.',
    keyGenerator: getUserOrIpKey,
  }),
};

/**
 * Get current rate limit stats for monitoring
 *
 * @returns {Object} - Statistics about rate limiting
 */
function getStats() {
  const stats = {
    totalIPs: requestStore.size,
    totalRequests: 0,
    topIPs: []
  };

  // Calculate total requests and find top IPs
  const ipRequests = [];
  for (const [ip, requests] of requestStore.entries()) {
    stats.totalRequests += requests.length;
    ipRequests.push({ ip, count: requests.length });
  }

  // Sort by request count and get top 10
  ipRequests.sort((a, b) => b.count - a.count);
  stats.topIPs = ipRequests.slice(0, 10);

  return stats;
}

/**
 * Clear rate limit for a specific IP (useful for admin operations)
 *
 * @param {string} ip - IP address to clear
 */
function clearRateLimit(ip) {
  requestStore.delete(ip);
  console.log(`Rate limit cleared for IP: ${ip}`);
}

module.exports = {
  createRateLimiter,
  presets,
  getStats,
  clearRateLimit
};
