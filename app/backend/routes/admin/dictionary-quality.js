const { authenticate } = require('../../middleware/auth');
const { sendError, sendJson, mapErrorToStatus } = require('../../middleware/error-handler');
const { createCurationService, normalizeScope } = require('../../services/dictionary/curation');

const service = createCurationService();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function requireAdmin(req) {
  const user = await authenticate(req);
  if (!user?.is_admin) {
    const error = new Error('FORBIDDEN');
    error.status = 403;
    throw error;
  }
  return user;
}

async function parseLimitedJson(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_JSON');
    return parsed;
  } catch (error) {
    if (error.message === 'BODY_TOO_LARGE') throw error;
    throw new Error('INVALID_JSON');
  }
}

function scopeFromQuery(url, { curatedOnly = true } = {}) {
  const value = url.searchParams.get('scope');
  if (value == null || !value.trim()) return curatedOnly ? undefined : null;
  return normalizeScope(value.split(','), { curatedOnly });
}

function statusForError(error) {
  const mapped = mapErrorToStatus(error, 0);
  if (mapped) return mapped;
  if (/^(REVISION_CONFLICT|ROLLBACK_SUPERSEDED)/.test(error.message)) return 409;
  if (/^(WORD_NOT_FOUND|BATCH_NOT_FOUND)/.test(error.message)) return 404;
  if (/^(INVALID_|SCOPE_|EXPECTED_|CONFIRM_|BODY_)/.test(error.message)) return 400;
  return 500;
}

async function registerDictionaryQualityRoutes(pathname, req, res, url) {
  if (!pathname.startsWith('/admin/dictionary-quality/')) return false;

  try {
    const admin = await requireAdmin(req);

    if (pathname === '/admin/dictionary-quality/audit' && req.method === 'GET') {
      const scope = scopeFromQuery(url, { curatedOnly: false });
      const limit = Number(url.searchParams.get('limit') || 500);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('INVALID_LIMIT');
      return sendJson(res, 200, await service.audit({ scope, limit }));
    }

    if (pathname === '/admin/dictionary-quality/plan' && req.method === 'GET') {
      const scope = scopeFromQuery(url);
      return sendJson(res, 200, await service.preview(scope ? { scope } : {}));
    }

    if (pathname === '/admin/dictionary-quality/apply' && req.method === 'POST') {
      const body = await parseLimitedJson(req);
      if (body.confirm !== 'APPLY_DICTIONARY_QUALITY') throw new Error('CONFIRM_REQUIRED');
      const scope = normalizeScope(body.scope, { required: true });
      if (!body.expected_revisions || typeof body.expected_revisions !== 'object' || Array.isArray(body.expected_revisions)) {
        throw new Error('EXPECTED_REVISIONS_REQUIRED');
      }
      return sendJson(res, 200, await service.apply({
        scope,
        expectedRevisions: body.expected_revisions,
        actor: { type: 'admin', id: admin.id },
      }));
    }

    if (pathname === '/admin/dictionary-quality/rollback' && req.method === 'POST') {
      const body = await parseLimitedJson(req);
      if (body.confirm !== 'ROLLBACK_DICTIONARY_QUALITY') throw new Error('CONFIRM_REQUIRED');
      if (!UUID_PATTERN.test(String(body.batch_id || ''))) throw new Error('INVALID_BATCH_ID');
      return sendJson(res, 200, await service.rollback({
        batchId: body.batch_id,
        actor: { type: 'admin', id: admin.id },
      }));
    }

    return sendError(res, 405, 'Method Not Allowed');
  } catch (error) {
    const status = statusForError(error);
    const publicMessage = status >= 500 ? 'Dictionary quality operation failed' : error.message;
    return sendError(res, status, publicMessage);
  }
}

module.exports = { registerDictionaryQualityRoutes };
