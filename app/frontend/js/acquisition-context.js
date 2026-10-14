(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishAcquisition = api.createAcquisitionContext(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const CONTEXT_KEY = 'linglish_acquisition_v1';
  const VISITOR_KEY = 'linglish_visitor_id';

  function safeGet(storage, key) {
    try { return storage && storage.getItem(key); } catch (_) { return null; }
  }

  function safeSet(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (_) {}
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeSource(value) {
    const source = text(value).toLowerCase();
    if (/^(twitter|t\.co)$/.test(source)) return 'x';
    if (/^(weixin|weixin_mp|wechat_mp)$/.test(source)) return 'wechat';
    return source || 'direct';
  }

  function classifyReferrer(referrer, currentOrigin) {
    if (!text(referrer)) return { source: 'direct', medium: 'none' };
    try {
      const parsed = new URL(referrer);
      if (currentOrigin && parsed.origin === currentOrigin) return { source: 'direct', medium: 'none' };
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (/(^|\.)google\.|(^|\.)bing\.com$|(^|\.)baidu\.com$/.test(host)) {
        const source = host.includes('bing') ? 'bing' : host.includes('baidu') ? 'baidu' : 'google';
        return { source, medium: 'organic' };
      }
      if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com') || host === 't.co') {
        return { source: 'x', medium: 'social' };
      }
      if (host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com') || host === 'wechat.com' || host.endsWith('.wechat.com')) {
        return { source: 'wechat', medium: 'social' };
      }
      return { source: host || 'referral', medium: 'referral' };
    } catch (_) {
      return { source: 'direct', medium: 'none' };
    }
  }

  function createVisitorId(environment) {
    const existing = safeGet(environment.localStorage, VISITOR_KEY);
    if (existing) return existing;
    let random = '';
    try {
      if (environment.crypto && typeof environment.crypto.randomUUID === 'function') {
        random = environment.crypto.randomUUID();
      }
    } catch (_) {}
    if (!random) random = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const visitorId = `llv_${random}`;
    safeSet(environment.localStorage, VISITOR_KEY, visitorId);
    return visitorId;
  }

  function readStoredContext(environment) {
    const raw = safeGet(environment.localStorage, CONTEXT_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function createAcquisitionContext(environment) {
    if (!environment) throw new Error('WINDOW_ENVIRONMENT_REQUIRED');

    function currentCandidate() {
      const location = environment.location || {};
      const params = new URLSearchParams(location.search || '');
      const referrer = text(environment.document && environment.document.referrer);
      const referral = classifyReferrer(referrer, location.origin || '');
      const utmSource = text(params.get('utm_source'));
      const source = utmSource ? normalizeSource(utmSource) : referral.source;
      const medium = text(params.get('utm_medium')) || (utmSource ? 'campaign' : referral.medium);
      const DateObject = environment.Date || Date;
      return {
        visitor_id: createVisitorId(environment),
        first_source: source,
        first_medium: medium,
        first_campaign: text(params.get('utm_campaign')) || null,
        first_content: text(params.get('utm_content')) || null,
        first_term: text(params.get('utm_term')) || null,
        first_referrer: referrer || null,
        first_landing_path: text(location.pathname) || '/',
        first_captured_at: new DateObject().toISOString(),
      };
    }

    function capture() {
      const candidate = currentCandidate();
      const stored = readStoredContext(environment);
      if (!stored) {
        safeSet(environment.localStorage, CONTEXT_KEY, JSON.stringify(candidate));
        return candidate;
      }

      const merged = Object.assign({}, stored);
      for (const [key, value] of Object.entries(candidate)) {
        if (merged[key] === undefined || merged[key] === null || merged[key] === '') merged[key] = value;
      }
      if (!merged.visitor_id) merged.visitor_id = candidate.visitor_id;
      safeSet(environment.localStorage, VISITOR_KEY, merged.visitor_id);
      safeSet(environment.localStorage, CONTEXT_KEY, JSON.stringify(merged));
      return merged;
    }

    function decorate(properties = {}) {
      return Object.assign({}, capture(), properties || {});
    }

    return { capture, decorate };
  }

  return { createAcquisitionContext, classifyReferrer, normalizeSource };
});
