/**
 * AI Service authentication (scoped tokens)
 *
 * Use-case: allow a trusted AI agent to call a limited set of maintenance endpoints
 * without granting full admin access.
 *
 * Env:
 * - AI_VOCAB_TOKEN: one or more tokens (comma-separated) that can access AI vocab routes
 *
 * Headers:
 * - Authorization: Bearer <token>
 * - X-AI-Token: <token>
 * - X-Linglish-AI-Token: <token>
 */

function extractAiToken(req) {
  const header =
    req.headers?.['x-ai-token'] ||
    req.headers?.['x-linglish-ai-token'] ||
    req.headers?.['X-AI-Token'] ||
    req.headers?.['X-Linglish-AI-Token'];

  if (header && typeof header === 'string') return header.trim();

  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length >= 2 && parts[0].toLowerCase() === 'bearer' && parts[1]) return parts[1].trim();
    if (parts.length === 1 && parts[0]) return parts[0].trim();
  }
  return null;
}

function requireAiVocabToken(req) {
  const configured = (process.env.AI_VOCAB_TOKEN || '').trim();
  if (!configured) {
    const err = new Error('AI_VOCAB_TOKEN not configured');
    err.status = 503;
    throw err;
  }

  const token = extractAiToken(req);
  if (!token) {
    const err = new Error('UNAUTHORIZED');
    err.status = 401;
    throw err;
  }

  const allowList = configured
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!allowList.includes(token)) {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    throw err;
  }

  return { actor: 'ai', scope: 'vocab' };
}

function shouldBypassExpensiveRateLimit(req, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/ai/vocab/')) {
    return false;
  }

  try {
    requireAiVocabToken(req);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  requireAiVocabToken,
  shouldBypassExpensiveRateLimit,
};
