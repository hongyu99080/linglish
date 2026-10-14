/**
 * Cache Headers Middleware
 *
 * Sets appropriate HTTP caching headers based on resource type.
 * Supports versioned static assets with long-term caching and
 * HTML pages with must-revalidate policy.
 */

const path = require('path');
const crypto = require('crypto');
const performanceConfig = require('../config/performance');
const { appendVary } = require('../utils/cors');

const STATIC_EXTENSIONS = ['.js', '.css', '.woff', '.woff2', '.ttf', '.eot'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.ico'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg'];

/**
 * Check if URL has version query parameter
 * @param {string} url - Request URL
 * @returns {boolean}
 */
function hasVersionParam(url) {
  return /[?&]v=/.test(url);
}

/**
 * Get resource type from pathname
 * @param {string} pathname - Request pathname
 * @returns {'html'|'static'|'image'|'audio'|'video'|'api'|'other'}
 */
function getResourceType(pathname) {
  const ext = path.extname(pathname).toLowerCase();

  if (ext === '.html' || ext === '') return 'html';
  if (STATIC_EXTENSIONS.includes(ext)) return 'static';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) return 'api';

  return 'other';
}

/**
 * Generate ETag from content
 * @param {Buffer|string} content - Response content
 * @returns {string} ETag value
 */
function generateETag(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return `"${crypto.createHash('md5').update(buffer).digest('hex').slice(0, 16)}"`;
}

/**
 * Cache headers middleware for static file serving
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Function} next
 */
function cacheHeadersMiddleware(req, res, next) {
  const url = req.url || '';
  const pathname = url.split('?')[0];
  const resourceType = getResourceType(pathname);
  const isVersioned = hasVersionParam(url);

  // Always set Vary header for proper CDN behavior
  res.setHeader('Vary', appendVary(res.getHeader('Vary'), 'Accept-Encoding'));

  switch (resourceType) {
    case 'static':
    case 'image':
      if (isVersioned) {
        // Versioned static assets - cache forever
        res.setHeader(
          'Cache-Control',
          `public, max-age=${performanceConfig.staticAssets.maxAge}, immutable`
        );
      } else {
        // Unversioned static assets - cache with revalidation
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
      break;

    case 'audio':
    case 'video':
      if (pathname.startsWith('/recordings/')) {
        res.setHeader('Cache-Control', 'private, no-store');
      } else if (pathname.startsWith('/videos/')) {
        res.setHeader('Cache-Control', 'private, no-store');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }
      if (resourceType === 'audio') {
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length');
      }
      break;

    case 'html':
      // HTML pages - always revalidate
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      break;

    case 'api':
      // API responses - no caching (handled by Redis at service layer)
      res.setHeader('Cache-Control', 'private, no-store');
      break;

    default:
      // Other resources - short cache
      res.setHeader('Cache-Control', 'public, max-age=3600');
  }

  next();
}

/**
 * Handle conditional requests (If-None-Match)
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Buffer|string} content - Response content
 * @returns {boolean} True if 304 response was sent
 */
function handleConditionalRequest(req, res, content) {
  if (!performanceConfig.staticAssets.etag) {
    return false;
  }

  const etag = generateETag(content);
  const ifNoneMatch = req.headers['if-none-match'];

  res.setHeader('ETag', etag);

  if (ifNoneMatch && ifNoneMatch === etag) {
    res.statusCode = 304;
    res.end();
    return true;
  }

  return false;
}

module.exports = cacheHeadersMiddleware;
module.exports.handleConditionalRequest = handleConditionalRequest;
module.exports.generateETag = generateETag;
