const crypto = require('crypto');

const SCOPED_TOKEN_TTL_SECONDS = 60;
const SCOPED_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;
const SCOPED_TOKEN_SECRET_MIN_BYTES = 32;
const SCOPED_TOKEN_VERSION = 1;
const SCOPED_TOKEN_TYPE = 'scoped-browser';
const OAUTH_AUDIENCE = 'oauth-session';
const OAUTH_PURPOSE = 'oauth_bootstrap';
const GROUP_CHAT_AUDIENCE = 'group-chat';
const GROUP_CHAT_PURPOSE = 'ws_ticket';
const OAUTH_TRANSACTION_TTL_SECONDS = 600;
const PRODUCTION_OAUTH_COOKIE_NAME = '__Host-linglish_oauth_bootstrap';
const DEVELOPMENT_OAUTH_COOKIE_NAME = 'linglish_oauth_bootstrap_dev';
const PRODUCTION_OAUTH_TRANSACTION_COOKIE_NAME = '__Host-linglish_oauth_tx';
const DEVELOPMENT_OAUTH_TRANSACTION_COOKIE_NAME = 'linglish_oauth_tx_dev';
const AUTH_FRAGMENT_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'code', 'state', 'oauth', 'user_id', 'is_new',
]);

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function getScopedTokenSecret(explicitSecret) {
  const secret = explicitSecret == null ? process.env.SCOPED_TOKEN_SECRET : explicitSecret;
  if (!secret) {
    const err = new Error('SCOPED_TOKEN_SECRET_REQUIRED');
    err.status = 503;
    throw err;
  }
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < SCOPED_TOKEN_SECRET_MIN_BYTES) {
    const err = new Error('SCOPED_TOKEN_SECRET_INVALID');
    err.status = 503;
    throw err;
  }
  return secret;
}

function validateScopedTokenConfiguration(explicitSecret) {
  getScopedTokenSecret(explicitSecret);
  return true;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function signaturesMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sameKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeSubject(user) {
  const subject = user?.id == null ? '' : String(user.id);
  if (!/^[1-9]\d*$/.test(subject)) throw new Error('INVALID_USER');
  return subject;
}

function normalizeGroupId(groupId) {
  const normalized = Number(groupId);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error('INVALID_GROUP');
  return normalized;
}

function normalizeRedirectUrl(value, fallback = '/index-desktop.html') {
  const candidate = String(value || fallback).trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
  try {
    const parsed = new URL(candidate, 'http://linglish.local');
    if (parsed.origin !== 'http://linglish.local') return fallback;
    if (parsed.hash) {
      const fragment = new URLSearchParams(parsed.hash.slice(1));
      for (const key of [...fragment.keys()]) {
        if (AUTH_FRAGMENT_KEYS.has(String(key).toLowerCase())) fragment.delete(key);
      }
      const safeFragment = fragment.toString();
      parsed.hash = safeFragment ? `#${safeFragment}` : '';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (_) {
    return fallback;
  }
}

function createToken(payload, options = {}) {
  const issuedAt = Math.floor((options.now || nowSeconds)());
  if (!Number.isFinite(issuedAt)) throw new Error('INVALID_TOKEN_OPTIONS');
  const fullPayload = {
    ...payload,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + SCOPED_TOKEN_TTL_SECONDS,
    ver: SCOPED_TOKEN_VERSION,
    jti: crypto.randomBytes(16).toString('hex'),
  };
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const body = encodeJson(fullPayload);
  const data = `${header}.${body}`;
  return `${data}.${sign(data, getScopedTokenSecret(options.secret))}`;
}

function createOAuthBootstrapToken(user, options = {}) {
  return createToken({
    typ: SCOPED_TOKEN_TYPE,
    aud: OAUTH_AUDIENCE,
    purpose: OAUTH_PURPOSE,
    sub: normalizeSubject(user),
    is_new: Boolean(options.isNew),
    redirect_url: normalizeRedirectUrl(options.redirectUrl),
  }, options);
}

function createGroupChatTicket(user, groupId, options = {}) {
  return createToken({
    typ: SCOPED_TOKEN_TYPE,
    aud: GROUP_CHAT_AUDIENCE,
    purpose: GROUP_CHAT_PURPOSE,
    sub: normalizeSubject(user),
    group_id: normalizeGroupId(groupId),
  }, options);
}

function decodeAndVerify(token, expected, options = {}) {
  if (typeof token !== 'string') throw new Error('INVALID_TOKEN');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) throw new Error('INVALID_TOKEN');

  try {
    const [headerPart, payloadPart, signature] = parts;
    const header = decodeJson(headerPart);
    if (!sameKeys(header, ['alg', 'typ']) || header.alg !== 'HS256' || header.typ !== 'JWT') {
      throw new Error('INVALID_TOKEN');
    }
    const expectedSignature = sign(
      `${headerPart}.${payloadPart}`,
      getScopedTokenSecret(options.secret),
    );
    if (!signaturesMatch(signature, expectedSignature)) throw new Error('INVALID_TOKEN');

    const payload = decodeJson(payloadPart);
    if (!sameKeys(payload, expected.keys)) throw new Error('INVALID_TOKEN');
    if (
      payload.typ !== SCOPED_TOKEN_TYPE ||
      payload.aud !== expected.audience ||
      payload.purpose !== expected.purpose ||
      payload.ver !== SCOPED_TOKEN_VERSION ||
      typeof payload.sub !== 'string' ||
      !/^[1-9]\d*$/.test(payload.sub) ||
      typeof payload.jti !== 'string' ||
      !/^[a-f0-9]{32}$/.test(payload.jti) ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.nbf) ||
      !Number.isInteger(payload.exp) ||
      payload.nbf !== payload.iat ||
      payload.exp - payload.iat !== SCOPED_TOKEN_TTL_SECONDS
    ) {
      throw new Error('INVALID_TOKEN');
    }

    const currentTime = Math.floor((options.now || nowSeconds)());
    if (!Number.isFinite(currentTime)) throw new Error('INVALID_TOKEN');
    if (
      payload.iat > currentTime + SCOPED_TOKEN_CLOCK_TOLERANCE_SECONDS ||
      payload.nbf > currentTime + SCOPED_TOKEN_CLOCK_TOLERANCE_SECONDS
    ) {
      throw new Error('INVALID_TOKEN');
    }
    if (payload.exp < currentTime || currentTime - payload.iat > SCOPED_TOKEN_TTL_SECONDS) {
      throw new Error('TOKEN_EXPIRED');
    }
    return payload;
  } catch (err) {
    if (err?.message === 'TOKEN_EXPIRED' || err?.status === 503) throw err;
    throw new Error('INVALID_TOKEN');
  }
}

function verifyOAuthBootstrapToken(token, options = {}) {
  const payload = decodeAndVerify(token, {
    audience: OAUTH_AUDIENCE,
    purpose: OAUTH_PURPOSE,
    keys: [
      'typ', 'aud', 'purpose', 'sub', 'iat', 'nbf', 'exp', 'ver', 'jti', 'is_new', 'redirect_url',
    ],
  }, options);
  if (
    typeof payload.is_new !== 'boolean' ||
    typeof payload.redirect_url !== 'string' ||
    normalizeRedirectUrl(payload.redirect_url) !== payload.redirect_url
  ) {
    throw new Error('INVALID_TOKEN');
  }
  return payload;
}

function verifyGroupChatTicket(token, options = {}) {
  const payload = decodeAndVerify(token, {
    audience: GROUP_CHAT_AUDIENCE,
    purpose: GROUP_CHAT_PURPOSE,
    keys: ['typ', 'aud', 'purpose', 'sub', 'group_id', 'iat', 'nbf', 'exp', 'ver', 'jti'],
  }, options);
  if (!Number.isSafeInteger(payload.group_id) || payload.group_id <= 0) {
    throw new Error('INVALID_TOKEN');
  }
  if (options.groupId != null && normalizeGroupId(options.groupId) !== payload.group_id) {
    throw new Error('INVALID_TOKEN');
  }
  if (options.userId != null && String(options.userId) !== payload.sub) {
    throw new Error('INVALID_TOKEN');
  }
  return payload;
}

function isProduction(options = {}) {
  return options.production == null
    ? process.env.NODE_ENV === 'production'
    : Boolean(options.production);
}

function getOAuthBootstrapCookieName(options = {}) {
  return isProduction(options) ? PRODUCTION_OAUTH_COOKIE_NAME : DEVELOPMENT_OAUTH_COOKIE_NAME;
}

function getOAuthTransactionCookieName(options = {}) {
  return isProduction(options)
    ? PRODUCTION_OAUTH_TRANSACTION_COOKIE_NAME
    : DEVELOPMENT_OAUTH_TRANSACTION_COOKIE_NAME;
}

function createOAuthTransactionNonce() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashOAuthTransactionNonce(nonce) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new Error('INVALID_OAUTH_TRANSACTION');
  }
  return crypto.createHash('sha256').update(nonce).digest('hex');
}

function serializeOAuthBootstrapCookie(token, options = {}) {
  const maxAge = options.maxAge == null
    ? SCOPED_TOKEN_TTL_SECONDS
    : Math.max(0, Math.floor(Number(options.maxAge) || 0));
  const attributes = [
    `${getOAuthBootstrapCookieName(options)}=${encodeURIComponent(String(token || ''))}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
  ];
  if (isProduction(options)) attributes.push('Secure');
  attributes.push('SameSite=Lax');
  return attributes.join('; ');
}

function serializeOAuthTransactionCookie(nonce, options = {}) {
  const maxAge = options.maxAge == null
    ? OAUTH_TRANSACTION_TTL_SECONDS
    : Math.max(0, Math.floor(Number(options.maxAge) || 0));
  const attributes = [
    `${getOAuthTransactionCookieName(options)}=${encodeURIComponent(String(nonce || ''))}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
  ];
  if (isProduction(options)) attributes.push('Secure');
  attributes.push('SameSite=Lax');
  return attributes.join('; ');
}

function readCookie(req, cookieName) {
  const raw = req?.headers?.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch (_) {
      return null;
    }
  }
  return null;
}

function readOAuthBootstrapCookie(req, options = {}) {
  return readCookie(req, getOAuthBootstrapCookieName(options));
}

function readOAuthTransactionCookie(req, options = {}) {
  return readCookie(req, getOAuthTransactionCookieName(options));
}

module.exports = {
  SCOPED_TOKEN_TTL_SECONDS,
  SCOPED_TOKEN_CLOCK_TOLERANCE_SECONDS,
  validateScopedTokenConfiguration,
  createOAuthBootstrapToken,
  verifyOAuthBootstrapToken,
  createGroupChatTicket,
  verifyGroupChatTicket,
  serializeOAuthBootstrapCookie,
  getOAuthBootstrapCookieName,
  readOAuthBootstrapCookie,
  createOAuthTransactionNonce,
  hashOAuthTransactionNonce,
  serializeOAuthTransactionCookie,
  getOAuthTransactionCookieName,
  readOAuthTransactionCookie,
};
