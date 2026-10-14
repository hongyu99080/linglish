const fs = require('fs');
const fsp = require('fs/promises');
const { getCorsHeaders } = require('../utils/cors');

/**
 * Get MIME type for a file based on extension
 * @param {string} filePath - File path
 * @returns {string} MIME type
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
 * Serve static file with Range request support for videos
 * @param {http.ServerResponse} res - HTTP response object
 * @param {string} filePath - File path to serve
 * @param {http.IncomingMessage} req - HTTP request object
 * @returns {Promise<boolean>} True if file was served, false otherwise
 */
async function serveStatic(res, filePath, req) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }

    const contentType = getContentType(filePath);
    const fileSize = stat.size;

    // Check if video file with Range request (needed for mobile playback)
    const isVideo = contentType.startsWith('video/');
    const range = req && req.headers.range;
    const corsHeaders = getCorsHeaders(req?.headers?.origin, { logUnknown: false });

    if (isVideo && range) {
      // Support Range requests (needed for mobile video playback)
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

      // HTML files must never be cached — they hold versioned ?v= query strings
      // for JS/CSS, and stale HTML defeats cache-busting entirely.
      if (filePath.endsWith('.html')) {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        headers['Pragma'] = 'no-cache';
        headers['Expires'] = '0';
      }

      // Always declare Range support for videos
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
  serveStatic,
  getContentType,
};
