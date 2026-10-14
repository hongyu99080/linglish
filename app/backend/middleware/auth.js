const authService = require('../services/auth');

/**
 * Authentication middleware
 * Verifies JWT token and attaches user to request
 */
function readCookie(req, key) {
  try {
    const raw = req.headers?.cookie;
    if (!raw || typeof raw !== 'string') return null;
    const parts = raw.split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      if (k !== key) continue;
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  } catch (_) { }
  return null;
}

function extractToken(req) {
  // 1) Authorization header (Bearer token)
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length >= 2 && parts[0].toLowerCase() === 'bearer' && parts[1]) return parts[1];
    // Some proxies forward the token without the "Bearer " prefix
    if (parts.length === 1 && parts[0]) return parts[0];
  }

  // 2) Account cookie fallback. Legacy media query credentials are handled
  // only by the explicit static media authorization path.
  return readCookie(req, 'linglish_token') || readCookie(req, 'authToken') || readCookie(req, 'token');
}

function extractBearerToken(req) {
  const value = req.headers?.authorization || req.headers?.Authorization;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

async function authenticate(req) {
  const token = extractToken(req);
  if (!token) {
    throw new Error('UNAUTHORIZED');
  }
  try {
    return await authService.requireUser(token);
  } catch (err) {
    if (process.env.AUTH_DEBUG === 'true') {
      try {
        console.warn('[Auth] authenticate failed:', {
          code: err?.code || err?.message || 'AUTH_FAILED',
          authHeaderPresent: Boolean(req.headers?.authorization || req.headers?.Authorization),
        });
      } catch (_) { }
    }
    throw err;
  }
}

async function authenticateBearer(req) {
  const token = extractBearerToken(req);
  if (!token) throw new Error('UNAUTHORIZED');
  return authService.requireUser(token);
}

/**
 * Optional authentication - doesn't throw if no token provided
 * Returns user object if authenticated, null otherwise
 */
async function optionalAuth(req) {
  try {
    return await authenticate(req);
  } catch (err) {
    return null;
  }
}

module.exports = {
  authenticate,
  authenticateBearer,
  optionalAuth,
};
