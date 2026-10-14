const dataStore = require('../data-store');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_VISITOR_ID = /^llv_[a-zA-Z0-9_-]{12,64}$/;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown');
}

function cleanText(value, max = 300) {
  if (value == null) return '';
  return String(value).trim().replace(/\s+/g, ' ').slice(0, max);
}

function cleanLongText(value, max = 1200) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

function normalizeVisitorId(value) {
  const visitorId = cleanText(value, 80);
  return VALID_VISITOR_ID.test(visitorId) ? visitorId : null;
}

async function optionalUser(req) {
  try {
    const user = await authenticate(req);
    return user || null;
  } catch (_) {
    return null;
  }
}

async function requireAdmin(req) {
  const user = await authenticate(req);
  if (!user?.is_admin) {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    throw err;
  }
  return user;
}

function buildLeadPayload(body, req, user) {
  const name = cleanText(body?.name, 120);
  const email = cleanText(body?.email, 180).toLowerCase();
  const organization = cleanText(body?.organization, 180);
  const role = cleanText(body?.role, 120) || null;
  const teamSize = cleanText(body?.team_size, 80) || null;
  const useCase = cleanLongText(body?.use_case, 1200) || null;
  const source = cleanText(body?.source, 80) || 'pricing';
  const intent = cleanText(body?.intent, 80) || 'team';
  const visitorId = normalizeVisitorId(body?.visitor_id || body?.properties?.visitor_id);

  if (!name) throw new Error('NAME_REQUIRED');
  if (!VALID_EMAIL.test(email)) throw new Error('EMAIL_INVALID');
  if (!organization) throw new Error('ORGANIZATION_REQUIRED');

  return {
    user_id: user?.id || null,
    visitor_id: visitorId,
    name,
    email,
    organization,
    role,
    team_size: teamSize,
    use_case: useCase,
    source,
    intent,
    ip: getClientIp(req),
    user_agent: req.headers['user-agent'] || null,
  };
}

async function registerTeamLeadRoutes(pathname, req, res, url) {
  // POST /api/team-leads - public Team/School/Enterprise inquiry
  if (pathname === '/api/team-leads' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const user = await optionalUser(req);
      const payload = buildLeadPayload(body, req, user);
      const lead = await dataStore.createTeamLead(payload);

      try {
        await dataStore.createEvent({
          user_id: payload.user_id,
          event_time: new Date().toISOString(),
          event_name: 'team_lead_submitted',
          properties: {
            lead_id: lead.id,
            visitor_id: payload.visitor_id,
            organization: payload.organization,
            role: payload.role,
            team_size: payload.team_size,
            source: payload.source,
            intent: payload.intent,
            ip: payload.ip,
            user_agent: payload.user_agent,
          },
          source: 'web',
        });
      } catch (err) {
        console.warn('[TeamLead] Failed to record event:', err?.message || err);
      }

      return sendJson(res, 201, { ok: true, item: lead });
    } catch (err) {
      const status = err.message === 'EMAIL_INVALID'
        || err.message === 'NAME_REQUIRED'
        || err.message === 'ORGANIZATION_REQUIRED'
        ? 400
        : mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/team-leads - admin lead inbox
  if (pathname === '/admin/team-leads' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const status = url.searchParams.get('status') || null;
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;
      const items = await dataStore.listTeamLeads({ status, limit, offset });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  const updateMatch = pathname.match(/^\/admin\/team-leads\/(\d+)$/);
  if (updateMatch && req.method === 'PATCH') {
    try {
      await requireAdmin(req);
      const body = await parseBody(req);
      const item = await dataStore.updateTeamLead(Number(updateMatch[1]), {
        status: body?.status,
        notes: body?.notes,
      });
      if (!item) return sendError(res, 404, 'TEAM_LEAD_NOT_FOUND');
      return sendJson(res, 200, { item });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  return false;
}

module.exports = { registerTeamLeadRoutes };
