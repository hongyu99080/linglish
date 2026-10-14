(function (root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (root) {
    let storage = null;
    try {
      storage = root.localStorage;
    } catch (_) { }
    root.LinglishVisitor = api.createVisitorContext({ storage });
  }
})(typeof window !== 'undefined' ? window : null, function () {
  const VISITOR_ID_KEY = 'linglish_visitor_id';
  const URL_SAFE_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function isValidVisitorId(value) {
    return typeof value === 'string' && /^llv_[A-Za-z0-9_-]{12,64}$/.test(value);
  }

  function createRandomPart() {
    const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      const values = new Uint8Array(24);
      cryptoApi.getRandomValues(values);
      return Array.from(values, (value) => URL_SAFE_CHARACTERS[value & 63]).join('');
    }

    let value = Date.now().toString(36);
    while (value.length < 24) value += Math.random().toString(36).slice(2) || '0';
    return value.slice(0, 24);
  }

  function createVisitorContext({ storage, createRandomPart: randomPart = createRandomPart } = {}) {
    function getId() {
      try {
        const existing = storage.getItem(VISITOR_ID_KEY);
        if (isValidVisitorId(existing)) return existing;
        const next = `llv_${randomPart()}`.slice(0, 68);
        if (!isValidVisitorId(next)) return null;
        storage.setItem(VISITOR_ID_KEY, next);
        return next;
      } catch (_) {
        return null;
      }
    }

    function decorateEvent(payload = {}) {
      const visitorId = getId();
      if (!visitorId) return { ...payload, properties: { ...(payload.properties || {}) } };
      return {
        ...payload,
        visitor_id: visitorId,
        properties: { ...(payload.properties || {}), visitor_id: visitorId },
      };
    }

    return { getId, decorateEvent };
  }

  return { createVisitorContext, isValidVisitorId };
});
