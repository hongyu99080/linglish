const crypto = require('crypto');
const dataStore = require('../data-store');

const MEDIA_AUDIENCE = 'linglish-media';
const MEDIA_SCOPE = 'media:read';
const MEDIA_TOKEN_VERSION = 1;
const MEDIA_TOKEN_TTL_SECONDS = 900;
const MEDIA_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;
const MEDIA_TOKEN_SECRET_MIN_BYTES = 32;
const PRODUCTION_COOKIE_NAME = '__Host-linglish_media';
const DEVELOPMENT_COOKIE_NAME = 'linglish_media_dev';

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function getMediaTokenSecret(explicitSecret) {
  const secret = explicitSecret == null ? process.env.MEDIA_TOKEN_SECRET : explicitSecret;
  if (!secret) {
    const err = new Error('MEDIA_TOKEN_SECRET_REQUIRED');
    err.status = 503;
    throw err;
  }
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MEDIA_TOKEN_SECRET_MIN_BYTES) {
    const err = new Error('MEDIA_TOKEN_SECRET_INVALID');
    err.status = 503;
    throw err;
  }
  return secret;
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

function createMediaSessionToken(user, options = {}) {
  if (!user || user.id == null) throw new Error('INVALID_USER');
  const issuedAt = Math.floor((options.now || nowSeconds)());
  const ttlSeconds = options.ttlSeconds == null
    ? MEDIA_TOKEN_TTL_SECONDS
    : Math.floor(Number(options.ttlSeconds));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('INVALID_TOKEN_OPTIONS');
  }

  const payload = {
    typ: 'media',
    aud: MEDIA_AUDIENCE,
    sub: user.id,
    scope: MEDIA_SCOPE,
    ver: MEDIA_TOKEN_VERSION,
    jti: crypto.randomBytes(16).toString('hex'),
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const body = encodeJson(payload);
  const data = `${header}.${body}`;
  return `${data}.${sign(data, getMediaTokenSecret(options.secret))}`;
}

function decodeAndVerify(token, options = {}) {
  if (typeof token !== 'string') throw new Error('INVALID_TOKEN');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) throw new Error('INVALID_TOKEN');

  try {
    const [headerPart, payloadPart, signature] = parts;
    const header = decodeJson(headerPart);
    if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error('INVALID_TOKEN');
    const expected = sign(`${headerPart}.${payloadPart}`, getMediaTokenSecret(options.secret));
    if (!signaturesMatch(signature, expected)) throw new Error('INVALID_TOKEN');

    const payload = decodeJson(payloadPart);
    const numericClaims = ['iat', 'nbf', 'exp'];
    if (
      payload.typ !== 'media' ||
      payload.aud !== MEDIA_AUDIENCE ||
      payload.scope !== MEDIA_SCOPE ||
      payload.ver !== MEDIA_TOKEN_VERSION ||
      payload.sub == null ||
      typeof payload.jti !== 'string' ||
      !/^[a-f0-9]{32}$/.test(payload.jti) ||
      numericClaims.some(claim => !Number.isInteger(payload[claim])) ||
      payload.exp <= payload.iat
    ) {
      throw new Error('INVALID_TOKEN');
    }

    const currentTime = Math.floor((options.now || nowSeconds)());
    if (!Number.isFinite(currentTime)) throw new Error('INVALID_TOKEN');
    if (payload.iat > currentTime + MEDIA_TOKEN_CLOCK_TOLERANCE_SECONDS) {
      throw new Error('INVALID_TOKEN');
    }
    if (payload.nbf > currentTime + MEDIA_TOKEN_CLOCK_TOLERANCE_SECONDS) {
      throw new Error('INVALID_TOKEN');
    }
    if (payload.exp + MEDIA_TOKEN_CLOCK_TOLERANCE_SECONDS < currentTime) {
      throw new Error('TOKEN_EXPIRED');
    }
    return payload;
  } catch (err) {
    if (err?.message === 'TOKEN_EXPIRED' || err?.status === 503) throw err;
    throw new Error('INVALID_TOKEN');
  }
}

async function requireMediaSession(token, options = {}) {
  const payload = decodeAndVerify(token, options);
  const findUserById = options.findUserById || dataStore.findUserById;
  const user = await findUserById(payload.sub);
  if (!user) throw new Error('UNAUTHORIZED');
  if (String(user.status || '').toLowerCase() === 'banned') {
    const err = new Error('BANNED');
    err.status = 403;
    throw err;
  }

  const { password_hash, ...safeUser } = user;
  return safeUser;
}

function isProduction(options = {}) {
  return options.production == null
    ? process.env.NODE_ENV === 'production'
    : Boolean(options.production);
}

function getMediaSessionCookieName(options = {}) {
  return isProduction(options) ? PRODUCTION_COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
}

function serializeMediaSessionCookie(token, options = {}) {
  const maxAge = options.maxAge == null ? MEDIA_TOKEN_TTL_SECONDS : Math.max(0, Number(options.maxAge) || 0);
  const attributes = [
    `${getMediaSessionCookieName(options)}=${encodeURIComponent(String(token || ''))}`,
    `Max-Age=${Math.floor(maxAge)}`,
    'Path=/',
    'HttpOnly',
  ];
  if (isProduction(options)) attributes.push('Secure');
  attributes.push('SameSite=Lax');
  return attributes.join('; ');
}

module.exports = {
  MEDIA_TOKEN_TTL_SECONDS,
  MEDIA_TOKEN_CLOCK_TOLERANCE_SECONDS,
  createMediaSessionToken,
  requireMediaSession,
  serializeMediaSessionCookie,
  getMediaSessionCookieName,
};
