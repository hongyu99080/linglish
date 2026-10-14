/**
 * OAuth Service - Handles Google OAuth and future providers
 *
 * Supported providers:
 * - google (implemented)
 * - wechat (future)
 * - twitter (future)
 * - github (future)
 */

const crypto = require('crypto');
const dataStore = require('../data-store');

// Configuration from environment
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_CALLBACK_URL || '/auth/oauth/google/callback';
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || '';
const GOOGLE_OAUTH_ENABLED = process.env.ENABLE_GOOGLE_OAUTH !== 'false';

// State TTL: 10 minutes
const STATE_TTL_SECONDS = 600;
const OAUTH_BOOTSTRAP_PROVIDER = 'oauth_bootstrap';

// Supported providers
const SUPPORTED_PROVIDERS = ['google', 'wechat', 'twitter', 'github'];

/**
 * Generate a secure random state token
 */
function generateState() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create and store OAuth state (CSRF protection)
 * @param {string} provider - OAuth provider name
 * @param {string} redirectUrl - URL to redirect after auth
 * @param {object} extraData - Additional data to store with state
 * @returns {Promise<string>} - State token
 */
async function createOAuthState(provider, redirectUrl = null, extraData = {}) {
  const state = generateState();
  const expiresAt = new Date(Date.now() + STATE_TTL_SECONDS * 1000);

  await dataStore.query(
    `INSERT INTO oauth_states (state, provider, redirect_url, extra_data, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [state, provider, redirectUrl, JSON.stringify(extraData), expiresAt]
  );

  return state;
}

/**
 * Verify and consume OAuth state
 * @param {string} state - State token to verify
 * @param {string} provider - Expected provider
 * @returns {Promise<object>} - State data
 */
async function verifyOAuthState(state, provider, options = {}) {
  const transactionHash = options.transactionHash;
  if (typeof transactionHash !== 'string' || !/^[a-f0-9]{64}$/.test(transactionHash)) {
    throw new Error('INVALID_OR_EXPIRED_STATE');
  }
  const { rows } = await dataStore.query(
    `DELETE FROM oauth_states
     WHERE state = $1 AND provider = $2 AND expires_at > NOW()
       AND extra_data ->> 'oauth_tx_hash' = $3
     RETURNING *`,
    [state, provider, transactionHash]
  );

  if (rows.length === 0) {
    throw new Error('INVALID_OR_EXPIRED_STATE');
  }

  return rows[0];
}

async function registerOAuthBootstrapJti(jti, expiresAtSeconds) {
  if (typeof jti !== 'string' || !/^[a-f0-9]{32}$/.test(jti)) {
    throw new Error('INVALID_OAUTH_BOOTSTRAP');
  }
  if (!Number.isInteger(expiresAtSeconds) || expiresAtSeconds <= 0) {
    throw new Error('INVALID_OAUTH_BOOTSTRAP');
  }
  await dataStore.query(
    `INSERT INTO oauth_states (state, provider, redirect_url, extra_data, expires_at)
     VALUES ($1, $2, NULL, '{}'::jsonb, to_timestamp($3))`,
    [jti, OAUTH_BOOTSTRAP_PROVIDER, expiresAtSeconds]
  );
  return true;
}

async function consumeOAuthBootstrapJti(jti) {
  if (typeof jti !== 'string' || !/^[a-f0-9]{32}$/.test(jti)) {
    throw new Error('OAUTH_BOOTSTRAP_REPLAYED');
  }
  const { rows } = await dataStore.query(
    `DELETE FROM oauth_states
     WHERE state = $1 AND provider = $2 AND expires_at >= NOW()
     RETURNING state`,
    [jti, OAUTH_BOOTSTRAP_PROVIDER]
  );
  if (rows.length !== 1) throw new Error('OAUTH_BOOTSTRAP_REPLAYED');
  return true;
}

/**
 * Build Google OAuth authorization URL
 * @param {string} state - CSRF state token
 * @returns {string} - Google auth URL
 */
function buildGoogleAuthUrl(state) {
  // Determine the full callback URL
  let callbackUrl = GOOGLE_REDIRECT_URI;
  if (!callbackUrl.startsWith('http')) {
    callbackUrl = `${FRONTEND_BASE_URL}${GOOGLE_REDIRECT_URI}`;
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    access_type: 'offline',
    prompt: 'consent'
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange Google authorization code for tokens
 * @param {string} code - Authorization code from Google
 * @returns {Promise<object>} - Token data
 */
async function exchangeGoogleCode(code) {
  // Determine the full callback URL
  let callbackUrl = GOOGLE_REDIRECT_URI;
  if (!callbackUrl.startsWith('http')) {
    callbackUrl = `${FRONTEND_BASE_URL}${GOOGLE_REDIRECT_URI}`;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code'
    })
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.error('[OAuth] Google token exchange failed:', data);
    throw new Error(data.error_description || 'GOOGLE_TOKEN_EXCHANGE_FAILED');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresIn: data.expires_in
  };
}

/**
 * Get Google user profile from access token
 * @param {string} accessToken - Google access token
 * @returns {Promise<object>} - User profile
 */
async function getGoogleUserProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.error('[OAuth] Google profile fetch failed:', data);
    throw new Error(data.error?.message || 'GOOGLE_PROFILE_FETCH_FAILED');
  }

  return {
    id: data.id,
    email: data.email,
    name: data.name,
    givenName: data.given_name,
    familyName: data.family_name,
    picture: data.picture,
    locale: data.locale,
    verified: data.verified_email
  };
}

/**
 * Find user by OAuth provider account
 * @param {string} provider - Provider name
 * @param {string} providerUserId - Provider's user ID
 * @returns {Promise<object|null>} - User record or null
 */
async function findUserByOAuth(provider, providerUserId) {
  const { rows } = await dataStore.query(
    `SELECT u.*, oa.id as oauth_id
     FROM user_oauth_accounts oa
     JOIN users u ON u.id = oa.user_id
     WHERE oa.provider = $1 AND oa.provider_user_id = $2
     LIMIT 1`,
    [provider, providerUserId]
  );

  return rows[0] || null;
}

/**
 * Find user by email
 * @param {string} email - User email
 * @returns {Promise<object|null>} - User record or null
 */
async function findUserByEmail(email) {
  return dataStore.findUserByEmail(email);
}

/**
 * Create new user from OAuth profile (no password)
 * @param {object} profile - OAuth profile
 * @param {string} provider - Provider name
 * @returns {Promise<object>} - Created user
 */
async function createOAuthUser(profile, provider) {
  const username = profile.name || profile.email.split('@')[0];

  const { rows } = await dataStore.query(
    `INSERT INTO users (email, username, password_hash, level, status, registration_method, created_at, updated_at)
     VALUES ($1, $2, NULL, NULL, 'active', $3, NOW(), NOW())
     RETURNING *`,
    [profile.email, username, provider]
  );

  const user = rows[0];

  // Create user profile
  try {
    await dataStore.query(
      `INSERT INTO user_profiles (user_id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );
  } catch (e) {
    console.warn('[OAuth] Failed to create user profile:', e.message);
  }

  return user;
}

/**
 * Link OAuth account to existing user
 * @param {number} userId - User ID
 * @param {string} provider - Provider name
 * @param {object} profile - OAuth profile
 * @returns {Promise<number>} - OAuth account ID
 */
async function linkOAuthAccount(userId, provider, profile) {
  const { rows } = await dataStore.query(
    `SELECT link_oauth_account($1, $2, $3, $4, $5, $6, $7::jsonb) as oauth_id`,
    [
      userId,
      provider,
      profile.id,
      profile.email,
      profile.name,
      profile.picture,
      JSON.stringify(profile)
    ]
  );

  return rows[0].oauth_id;
}

/**
 * Main OAuth login/register handler
 * Handles account creation, linking, and login
 *
 * @param {string} provider - OAuth provider name
 * @param {object} profile - User profile from provider
 * @returns {Promise<{user: object, isNewUser: boolean}>}
 */
async function handleOAuthLogin(provider, profile) {
  // 1. Check if OAuth account already linked
  let user = await findUserByOAuth(provider, profile.id);

  if (user) {
    // Update last login
    await dataStore.query(
      `UPDATE user_oauth_accounts SET last_login_at = NOW()
       WHERE provider = $1 AND provider_user_id = $2`,
      [provider, profile.id]
    );
    return { user, isNewUser: false };
  }

  // 2. Check if email exists (link to existing account)
  user = await findUserByEmail(profile.email);

  if (user) {
    // Link OAuth to existing account
    await linkOAuthAccount(user.id, provider, profile);
    return { user, isNewUser: false };
  }

  // 3. Create new user
  user = await createOAuthUser(profile, provider);
  await linkOAuthAccount(user.id, provider, profile);

  return { user, isNewUser: true };
}

/**
 * Get user's linked OAuth providers
 * @param {number} userId - User ID
 * @returns {Promise<Array>} - List of linked providers
 */
async function getUserOAuthProviders(userId) {
  const { rows } = await dataStore.query(
    `SELECT provider, provider_email, provider_name, provider_avatar_url, created_at, last_login_at
     FROM user_oauth_accounts
     WHERE user_id = $1
     ORDER BY created_at`,
    [userId]
  );

  return rows;
}

/**
 * Unlink OAuth provider from user
 * @param {number} userId - User ID
 * @param {string} provider - Provider to unlink
 * @returns {Promise<boolean>} - Success status
 */
async function unlinkOAuthProvider(userId, provider) {
  // Check if user has a password (can't unlink last auth method)
  const user = await dataStore.findUserById(userId);
  if (!user) return false;

  // Count remaining auth methods
  const { rows: oauthCount } = await dataStore.query(
    `SELECT COUNT(*) as count FROM user_oauth_accounts WHERE user_id = $1`,
    [userId]
  );

  const hasPassword = user.password_hash && user.password_hash.length > 0;
  const oauthProviders = parseInt(oauthCount[0]?.count || 0);

  // Must have at least one auth method
  if (!hasPassword && oauthProviders <= 1) {
    throw new Error('CANNOT_UNLINK_LAST_AUTH_METHOD');
  }

  await dataStore.query(
    `DELETE FROM user_oauth_accounts WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );

  return true;
}

/**
 * Cleanup expired OAuth states (call periodically)
 * @returns {Promise<number>} - Number of deleted states
 */
async function cleanupExpiredStates() {
  const { rows } = await dataStore.query('SELECT cleanup_expired_oauth_states() as count');
  return rows[0].count;
}

/**
 * Check if Google OAuth is configured
 * @returns {boolean}
 */
function isGoogleConfigured() {
  return GOOGLE_OAUTH_ENABLED && !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

module.exports = {
  // State management
  generateState,
  createOAuthState,
  verifyOAuthState,
  registerOAuthBootstrapJti,
  consumeOAuthBootstrapJti,
  cleanupExpiredStates,

  // Google OAuth
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  getGoogleUserProfile,
  isGoogleConfigured,
  isGoogleEnabled: () => GOOGLE_OAUTH_ENABLED,

  // User management
  findUserByOAuth,
  findUserByEmail,
  createOAuthUser,
  linkOAuthAccount,
  handleOAuthLogin,
  getUserOAuthProviders,
  unlinkOAuthProvider,

  // Constants
  SUPPORTED_PROVIDERS
};
