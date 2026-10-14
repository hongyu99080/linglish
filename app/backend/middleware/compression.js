/**
 * Compression Middleware
 *
 * Automatically compresses HTTP responses using Brotli or gzip based on
 * client Accept-Encoding header.
 */

const zlib = require('zlib');
const performanceConfig = require('../config/performance');

const COMPRESSIBLE_TYPES = performanceConfig.compression.mimeTypes;
const THRESHOLD = performanceConfig.compression.threshold;
const BROTLI_QUALITY = performanceConfig.compression.brotliQuality;
const GZIP_LEVEL = performanceConfig.compression.gzipLevel;

/**
 * Check if content type is compressible
 * @param {string} contentType - Content-Type header value
 * @returns {boolean}
 */
function isCompressible(contentType) {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return COMPRESSIBLE_TYPES.includes(type);
}

/**
 * Get best compression encoding from Accept-Encoding header
 * @param {string} acceptEncoding - Accept-Encoding header value
 * @returns {'br'|'gzip'|null}
 */
function getBestEncoding(acceptEncoding) {
  if (!acceptEncoding) return null;
  const lower = acceptEncoding.toLowerCase();
  if (lower.includes('br')) return 'br';
  if (lower.includes('gzip')) return 'gzip';
  return null;
}

/**
 * Compress content synchronously
 * @param {Buffer|string} content - Content to compress
 * @param {'br'|'gzip'} encoding - Compression encoding
 * @returns {Buffer}
 */
function compressSync(content, encoding) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

  if (encoding === 'br') {
    return zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      },
    });
  }

  return zlib.gzipSync(buffer, { level: GZIP_LEVEL });
}

/**
 * Compression middleware
 * Wraps res.end to compress response body before sending
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Function} next
 */
function compressionMiddleware(req, res, next) {
  if (!performanceConfig.compression.enabled) {
    return next();
  }

  if (res.headersSent || res.writableEnded || res.disableCompression) {
    return next();
  }

  const acceptEncoding = req.headers['accept-encoding'] || '';
  const encoding = getBestEncoding(acceptEncoding);

  if (!encoding) {
    return next();
  }

  // Store original end method
  const originalEnd = res.end.bind(res);
  let chunks = [];
  let originalWrite = res.write.bind(res);

  // Override write to collect chunks
  res.write = function (chunk, encodingArg, callback) {
    if (res.disableCompression) {
      res.write = originalWrite;
      return originalWrite(chunk, encodingArg, callback);
    }
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    // Don't call original write - we'll send everything in end()
    if (typeof encodingArg === 'function') {
      encodingArg();
    } else if (typeof callback === 'function') {
      callback();
    }
    return true;
  };

  // Override end to compress and send
  res.end = function (chunk, encodingArg, callback) {
    if (res.disableCompression) {
      res.write = originalWrite;
      return originalEnd(chunk, encodingArg, callback);
    }
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const contentType = res.getHeader('content-type');
    const body = Buffer.concat(chunks);
    const headersAlreadySent = res.headersSent || res.writableEnded;

    // Check if we should compress
    if (
      headersAlreadySent ||
      res.getHeader('Content-Encoding') ||
      body.length < THRESHOLD ||
      !isCompressible(contentType)
    ) {
      // Send uncompressed
      res.write = originalWrite;
      return originalEnd(body, encodingArg, callback);
    }

    try {
      const compressed = compressSync(body, encoding);

      // Update headers
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');
      res.setHeader('Content-Length', compressed.length);

      // Send compressed response
      res.write = originalWrite;
      return originalEnd(compressed, encodingArg, callback);
    } catch (err) {
      console.error('[Compression] Error compressing response:', err.message);
      // Fallback to uncompressed
      res.write = originalWrite;
      return originalEnd(body, encodingArg, callback);
    }
  };

  next();
}

module.exports = compressionMiddleware;
