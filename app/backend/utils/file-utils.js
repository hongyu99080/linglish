const fs = require('fs');
const fsp = require('fs/promises');
const { getCorsHeaders } = require('./cors');

/**
 * File handling utilities
 */

/**
 * Get content type from file extension
 */
function getContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.js')) return 'application/javascript';
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.wav')) return 'audio/wav';
  if (filePath.endsWith('.mp3')) return 'audio/mpeg';
  if (filePath.endsWith('.pdf')) return 'application/pdf';
  if (filePath.endsWith('.mp4')) return 'video/mp4';
  if (filePath.endsWith('.webm')) return 'video/webm';
  if (filePath.endsWith('.mov')) return 'video/quicktime';
  if (filePath.endsWith('.mkv')) return 'video/x-matroska';
  return 'application/octet-stream';
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMime(mimeType = '') {
  if (!mimeType) return 'webm';
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  const map = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
  };
  return map[normalized] || 'webm';
}

/**
 * Safely remove file (ignores ENOENT)
 */
async function removeFileSafe(absPath, options = {}) {
  if (!absPath) return;
  const silent = options && options.silent === true;
  try {
    await fsp.unlink(absPath);
  } catch (err) {
    if (err.code !== 'ENOENT' && !silent) {
      console.warn('Failed to remove file:', absPath, err.message);
    }
  }
}

/**
 * Serve static file with support for Range requests (for video streaming)
 */
async function serveStatic(res, filePath, req) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }

    const contentType = getContentType(filePath);
    const fileSize = stat.size;

    // Check if it's a video file and has Range request (required for mobile playback)
    const isVideo = contentType.startsWith('video/');
    const range = req && req.headers.range;
    const corsHeaders = getCorsHeaders(req?.headers?.origin, { logUnknown: false });

    if (isVideo && range) {
      // Support Range requests (required for mobile video playback)
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const readStream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        ...corsHeaders,
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
      });
      readStream.pipe(res);
    } else {
      // Regular file or no Range request
      const readStream = fs.createReadStream(filePath);
      const headers = {
        'Content-Type': contentType,
        'Content-Length': fileSize,
        ...corsHeaders,
      };

      // Always declare Range support for video files
      if (isVideo) {
        headers['Accept-Ranges'] = 'bytes';
        headers['Access-Control-Expose-Headers'] = 'Content-Range, Accept-Ranges, Content-Length';
      }

      res.writeHead(200, headers);
      readStream.pipe(res);
    }

    return true;
  } catch (err) {
    // Avoid noisy logs for normal 404s on random crawler paths
    if (err && err.code !== 'ENOENT') {
      console.error('Error serving static file:', err);
    }
    return false;
  }
}

module.exports = {
  getContentType,
  getExtensionFromMime,
  removeFileSafe,
  serveStatic,
};
