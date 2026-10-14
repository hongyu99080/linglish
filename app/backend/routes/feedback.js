const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const dataStore = require('../data-store');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const { handleFileUpload, cleanupFile, UPLOAD_DIR } = require('../upload-handler');

const FEEDBACK_UPLOAD_DIR = path.join(UPLOAD_DIR, 'feedback');
if (!fs.existsSync(FEEDBACK_UPLOAD_DIR)) {
  fs.mkdirSync(FEEDBACK_UPLOAD_DIR, { recursive: true });
}

/**
 * Register and handle user feedback routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerFeedbackRoutes(pathname, req, res, url) {
  // POST /feedback
  if (pathname === '/feedback' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const category = (body.category || 'general').toLowerCase();
      const content = (body.content || '').trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!content) return sendError(res, 400, 'content is required');
      const item = await dataStore.saveFeedback(user.id, { category, content, attachments });
      return sendJson(res, 200, { item });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /feedback/upload (image attachments)
  if (pathname === '/feedback/upload' && req.method === 'POST') {
    let uploaded = [];
    try {
      await authenticate(req);
      const { files } = await handleFileUpload(req, { maxTotalBytes: 8 * 1024 * 1024 });
      const fileList = [];
      Object.values(files || {}).forEach((entry) => {
        if (Array.isArray(entry)) fileList.push(...entry);
        else if (entry) fileList.push(entry);
      });
      if (!fileList.length) return sendError(res, 400, 'image is required');

      for (const file of fileList.slice(0, 3)) {
        const filepath = file.path;
        if (!filepath) continue;
        const mime = String(file.mimetype || '').toLowerCase();
        if (!mime.startsWith('image/')) {
          await cleanupFile(filepath);
          continue;
        }
        const ext = path.extname(filepath || '').toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
          await cleanupFile(filepath);
          continue;
        }
        const stat = await fsp.stat(filepath);
        if (stat.size > 5 * 1024 * 1024) {
          await cleanupFile(filepath);
          continue;
        }
        const filename = path.basename(filepath);
        const dest = path.join(FEEDBACK_UPLOAD_DIR, filename);
        await fsp.rename(filepath, dest);
        uploaded.push({
          url: `/feedback-uploads/${filename}`,
          name: file.filename || filename,
          type: mime,
          size: stat.size
        });
      }

      if (!uploaded.length) return sendError(res, 400, 'invalid image');
      return sendJson(res, 200, { files: uploaded });
    } catch (err) {
      for (const f of uploaded) {
        try {
          const p = path.join(FEEDBACK_UPLOAD_DIR, path.basename(f.url || ''));
          if (p.startsWith(FEEDBACK_UPLOAD_DIR)) await fsp.unlink(p);
        } catch (_) { }
      }
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /feedback/my
  if (pathname === '/feedback/my' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;
      const items = await dataStore.listFeedbackByUser(user.id, { limit, offset });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerFeedbackRoutes };
