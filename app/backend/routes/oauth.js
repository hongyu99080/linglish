/**
 * OAuth Routes - Handles OAuth redirects and callbacks
 *
 * Routes:
 * - GET /auth/oauth/google - Initiate Google OAuth
 * - GET /auth/oauth/google/callback - Google OAuth callback
 * - GET /auth/oauth/providers - List user's linked OAuth providers
 * - DELETE /auth/oauth/providers/:provider - Unlink OAuth provider
 */

const oauthService = require('../services/oauth');
const authService = require('../services/auth');
const dataStore = require('../data-store');
const { sendJson, sendError } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const {
  createOAuthBootstrapToken,
  verifyOAuthBootstrapToken,
  validateScopedTokenConfiguration,
  serializeOAuthBootstrapCookie,
  readOAuthBootstrapCookie,
  createOAuthTransactionNonce,
  hashOAuthTransactionNonce,
  serializeOAuthTransactionCookie,
  readOAuthTransactionCookie,
} = require('../services/scoped-browser-token');

// Configuration
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || '';

// Desktop pages
const WELCOME_PAGE_URL = '/welcome.html';
const VIDEO_PAGE_URL = '/today.html?from=oauth';
const HOME_PAGE_URL = '/index-desktop.html';

// Mobile pages
const MOBILE_WELCOME_PAGE_URL = '/mobile-auth.html';  // Mobile handles redirect after token
const MOBILE_VIDEO_PAGE_URL = '/video-reader.html';
const MOBILE_HOME_PAGE_URL = '/mobile-auth.html';

function logWithTs(message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}

function errorWithTs(message) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${message}`);
}

/**
 * Extract client IP from request headers or socket
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown');
}

/**
 * Build JWT token for OAuth user
 * Reuses the signed token format from auth.js.
 */
function buildOAuthToken(user) {
  return authService.createAccessTokenForUser(user);
}

/**
 * Send redirect response
 */
function sendRedirect(res, url) {
  res.writeHead(302, {
    'Location': url,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end();
  return true;
}

function appendSetCookie(res, value) {
  const current = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null;
  if (!current) {
    res.setHeader('Set-Cookie', value);
  } else if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, value]);
  } else {
    res.setHeader('Set-Cookie', [current, value]);
  }
}

function addQueryParameter(target, key, value) {
  const hashIndex = target.indexOf('#');
  const hash = hashIndex >= 0 ? target.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}

/**
 * Register OAuth routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerOAuthRoutes(pathname, req, res, url) {
  const clientIp = getClientIp(req);

  // POST /auth/oauth/session - exchange the HttpOnly bootstrap cookie for the existing account JSON
  if (pathname === '/auth/oauth/session' && req.method === 'POST') {
    res.setHeader('Set-Cookie', serializeOAuthBootstrapCookie('', { maxAge: 0 }));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const bootstrap = readOAuthBootstrapCookie(req);
      if (!bootstrap) throw new Error('UNAUTHORIZED');
      const payload = verifyOAuthBootstrapToken(bootstrap);
      await oauthService.consumeOAuthBootstrapJti(payload.jti);
      const user = await dataStore.findUserById(payload.sub);
      if (!user) throw new Error('UNAUTHORIZED');
      if (String(user.status || '').toLowerCase() === 'banned') {
        const err = new Error('BANNED');
        err.status = 403;
        throw err;
      }
      const token = buildOAuthToken(user);
      return sendJson(res, 200, {
        access_token: token,
        refresh_token: token,
        user_id: user.id,
        is_new: payload.is_new,
        user: authService.sanitizeUser(user),
        redirect_url: payload.redirect_url,
      });
    } catch (err) {
      if (err?.status === 503) return sendError(res, 503, 'Service unavailable');
      return sendError(res, err?.status === 403 ? 403 : 401, err?.message || 'UNAUTHORIZED');
    }
  }

  // ============================================
  // GET /auth/oauth/google or /auth/google - Initiate Google OAuth
  // ============================================
  if ((pathname === '/auth/oauth/google' || pathname === '/auth/google') && req.method === 'GET') {
    logWithTs(`[OAuth] Google auth initiation from ${clientIp}`);

    try {
      if (!oauthService.isGoogleEnabled()) {
        errorWithTs('[OAuth] Google OAuth disabled by configuration');
        return sendError(res, 403, 'GOOGLE_OAUTH_DISABLED');
      }
      // Check if Google OAuth is configured
      if (!oauthService.isGoogleConfigured()) {
        errorWithTs('[OAuth] Google OAuth not configured - missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
        return sendError(res, 503, 'GOOGLE_OAUTH_NOT_CONFIGURED');
      }

      // Get optional redirect parameter and mobile flag
      const isMobile = url.searchParams.get('mobile') === '1';
      const cookieFlow = url.searchParams.get('flow') === 'cookie_v1';
      if (!cookieFlow && process.env.OAUTH_ALLOW_LEGACY_FRAGMENT !== 'true') {
        return sendError(res, 403, 'OAUTH_LEGACY_FLOW_DISABLED');
      }
      if (cookieFlow) validateScopedTokenConfiguration();
      const defaultRedirect = isMobile ? MOBILE_VIDEO_PAGE_URL : VIDEO_PAGE_URL;
      const redirectUrl = url.searchParams.get('redirect') || defaultRedirect;
      const transactionNonce = createOAuthTransactionNonce();
      const transactionHash = hashOAuthTransactionNonce(transactionNonce);

      // Create state with redirect info and mobile flag
      const extraData = {
        source: 'web',
        ip: clientIp,
        mobile: isMobile,
        oauth_tx_hash: transactionHash,
      };
      if (cookieFlow) extraData.flow = 'cookie_v1';
      const state = await oauthService.createOAuthState('google', redirectUrl, extraData);
      res.setHeader('Set-Cookie', serializeOAuthTransactionCookie(transactionNonce));

      // Build and redirect to Google
      const googleAuthUrl = oauthService.buildGoogleAuthUrl(state);

      logWithTs(`[OAuth] Redirecting to Google OAuth`);
      return sendRedirect(res, googleAuthUrl);

    } catch (err) {
      errorWithTs(`[OAuth] Google auth init error: ${err.message}`);
      if (err?.status === 503) return sendError(res, 503, 'Service unavailable');
      return sendError(res, 500, 'OAUTH_INIT_FAILED');
    }
  }

  // ============================================
  // GET /auth/oauth/google/callback or /auth/google/callback - Google OAuth callback
  // ============================================
  if ((pathname === '/auth/oauth/google/callback' || pathname === '/auth/google/callback') && req.method === 'GET') {
    logWithTs(`[OAuth] Google callback from ${clientIp}`);
    appendSetCookie(res, serializeOAuthTransactionCookie('', { maxAge: 0 }));

    // Declare isMobile outside try block so it's accessible in catch
    let isMobile = false;

    try {
      if (!oauthService.isGoogleEnabled()) {
        errorWithTs('[OAuth] Google OAuth disabled by configuration');
        return sendError(res, 403, 'GOOGLE_OAUTH_DISABLED');
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      // We need to verify state first to determine if it's mobile
      // But for error cases, we check state if available
      let stateData = null;
      let transactionHash = null;
      try {
        transactionHash = hashOAuthTransactionNonce(readOAuthTransactionCookie(req));
      } catch (_) { }

      if (state) {
        try {
          stateData = await oauthService.verifyOAuthState(state, 'google', { transactionHash });
          isMobile = stateData.extra_data?.mobile === true;
        } catch (err) {
          // State verification failed - will handle below
        }
      }

      // Select appropriate pages based on mobile flag
      const homePage = isMobile ? MOBILE_HOME_PAGE_URL : HOME_PAGE_URL;
      const welcomePage = isMobile ? MOBILE_WELCOME_PAGE_URL : WELCOME_PAGE_URL;
      const videoPage = isMobile ? MOBILE_VIDEO_PAGE_URL : VIDEO_PAGE_URL;

      // Handle OAuth errors from Google
      if (error) {
        errorWithTs(`[OAuth] Google returned error: ${error}`);
        return sendRedirect(res, `${FRONTEND_BASE_URL}${homePage}?error=oauth_denied`);
      }

      if (!code || !state) {
        errorWithTs('[OAuth] Missing code or state in callback');
        return sendRedirect(res, `${FRONTEND_BASE_URL}${homePage}?error=oauth_invalid`);
      }

      // State verification already done above, check result
      if (!stateData) {
        errorWithTs(`[OAuth] State verification failed`);
        return sendRedirect(res, `${FRONTEND_BASE_URL}${homePage}?error=oauth_expired`);
      }

      if (stateData.extra_data?.flow === 'cookie_v1') {
        validateScopedTokenConfiguration();
      }

      // Exchange code for tokens
      const tokens = await oauthService.exchangeGoogleCode(code);

      // Get user profile
      const profile = await oauthService.getGoogleUserProfile(tokens.accessToken);

      logWithTs(`[OAuth] Got Google profile: email=${profile.email}, name=${profile.name}, mobile=${isMobile}`);

      // Handle login/registration
      const { user, isNewUser } = await oauthService.handleOAuthLogin('google', profile);

      // Record login session
      try {
        await dataStore.recordLoginSession(user.id, clientIp, req.headers['user-agent'] || null);
        await dataStore.createEvent({
          user_id: user.id,
          event_time: new Date().toISOString(),
          event_name: isNewUser ? 'oauth_register' : 'oauth_login',
          properties: {
            provider: 'google',
            ip: clientIp,
            user_agent: req.headers['user-agent'] || null,
            mobile: isMobile
          },
          source: isMobile ? 'mobile_web' : 'web',
        });
      } catch (e) {
        console.warn('[OAuth] Failed to record login session:', e.message);
      }

      logWithTs(`[OAuth] Google ${isNewUser ? 'register' : 'login'} success user_id=${user.id} email=${user.email} mobile=${isMobile}`);

      // Redirect with token
      // For new users, redirect to welcome page for level selection
      // For existing users, redirect to their intended destination
      const redirectUrl = isNewUser
        ? `${FRONTEND_BASE_URL}${welcomePage}`
        : `${FRONTEND_BASE_URL}${stateData.redirect_url || videoPage}`;

      if (stateData.extra_data?.flow === 'cookie_v1') {
        const bootstrapToken = createOAuthBootstrapToken(user, {
          isNew: isNewUser,
          redirectUrl: isNewUser ? welcomePage : (stateData.redirect_url || videoPage),
        });
        const bootstrapPayload = verifyOAuthBootstrapToken(bootstrapToken);
        await oauthService.registerOAuthBootstrapJti(bootstrapPayload.jti, bootstrapPayload.exp);
        appendSetCookie(res, serializeOAuthBootstrapCookie(bootstrapToken));
        const bootstrapPage = `${FRONTEND_BASE_URL}${isNewUser ? welcomePage : homePage}`;
        return sendRedirect(res, addQueryParameter(bootstrapPage, 'oauth', 'cookie_v1'));
      }

      if (process.env.OAUTH_ALLOW_LEGACY_FRAGMENT === 'true') {
        const token = buildOAuthToken(user);
        const legacyFragment = `token=${encodeURIComponent(token)}&user_id=${user.id}&is_new=${isNewUser}`;
        return sendRedirect(res, `${redirectUrl}#${legacyFragment}`);
      }

      return sendRedirect(res, `${FRONTEND_BASE_URL}${homePage}?error=oauth_expired`);

    } catch (err) {
      errorWithTs(`[OAuth] Google callback error: ${err.message}`);
      if (err?.status === 503) return sendError(res, 503, 'Service unavailable');
      const errorPage = isMobile ? MOBILE_HOME_PAGE_URL : HOME_PAGE_URL;
      return sendRedirect(res, `${FRONTEND_BASE_URL}${errorPage}?error=oauth_failed`);
    }
  }

  // ============================================
  // GET /auth/oauth/providers - List user's linked OAuth providers
  // ============================================
  if (pathname === '/auth/oauth/providers' && req.method === 'GET') {
    try {
      const user = await authenticate(req);

      const providers = await oauthService.getUserOAuthProviders(user.id);

      return sendJson(res, 200, { providers });

    } catch (err) {
      return sendError(res, 401, err.message || 'UNAUTHORIZED');
    }
  }

  // ============================================
  // DELETE /auth/oauth/providers/:provider - Unlink OAuth provider
  // ============================================
  const unlinkMatch = pathname.match(/^\/auth\/oauth\/providers\/(\w+)$/);
  if (unlinkMatch && req.method === 'DELETE') {
    try {
      const user = await authenticate(req);
      const provider = unlinkMatch[1];

      if (!oauthService.SUPPORTED_PROVIDERS.includes(provider)) {
        return sendError(res, 400, 'INVALID_PROVIDER');
      }

      await oauthService.unlinkOAuthProvider(user.id, provider);

      logWithTs(`[OAuth] Unlinked ${provider} from user ${user.id}`);

      return sendJson(res, 200, { success: true, message: `${provider} unlinked` });

    } catch (err) {
      if (err.message === 'CANNOT_UNLINK_LAST_AUTH_METHOD') {
        return sendError(res, 400, err.message);
      }
      return sendError(res, 401, err.message || 'UNAUTHORIZED');
    }
  }

  // ============================================
  // GET /auth/oauth/status - Check OAuth configuration status
  // ============================================
  if (pathname === '/auth/oauth/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      google: oauthService.isGoogleConfigured(),
      wechat: false,  // Not implemented yet
      twitter: false, // Not implemented yet
      github: false   // Not implemented yet
    });
  }

  // Route not handled
  return false;
}

module.exports = { registerOAuthRoutes };
