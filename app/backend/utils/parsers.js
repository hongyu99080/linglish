/**
 * Request parsing utilities
 */

/**
 * Parse JSON request body
 */
async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    throw new Error('INVALID_JSON');
  }
}

/**
 * Parse optional JSON without allowing telemetry metadata to block a request.
 * Oversized or stalled streams are discarded in the background and never reject.
 */
async function parseOptionalJsonBody(req, {
  maxBytes = 8 * 1024,
  timeoutMs = 500,
  onDiscard = null,
} = {}) {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 8 * 1024;
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : 500;

  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let readTimer;

    function removeReadListeners() {
      clearTimeout(readTimer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onReadError);
      req.removeListener('aborted', onAborted);
    }

    function discardRemainingRequest() {
      const absorbError = () => {};

      function cleanup() {
        req.removeListener('end', cleanup);
        req.removeListener('close', cleanup);
        req.removeListener('error', absorbError);
      }

      req.on('error', absorbError);
      req.once('end', cleanup);
      req.once('close', cleanup);
      try {
        if (typeof req.resume === 'function') req.resume();
      } catch (_) { }
    }

    function finish(value, { discard = false } = {}) {
      if (settled) return;
      settled = true;
      removeReadListeners();
      if (discard) {
        try {
          if (typeof onDiscard === 'function') onDiscard();
        } catch (_) { }
        discardRemainingRequest();
      }
      resolve(value);
    }

    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + buffer.length > limit) {
        chunks.length = 0;
        finish({}, { discard: true });
        return;
      }
      chunks.push(buffer);
      size += buffer.length;
    }

    function onEnd() {
      if (!chunks.length) return finish({});
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return finish({});
      try {
        finish(JSON.parse(text));
      } catch (_) {
        finish({});
      }
    }

    function onReadError() {
      finish({});
    }

    function onAborted() {
      finish({});
    }

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onReadError);
    req.once('aborted', onAborted);
    readTimer = setTimeout(() => finish({}, { discard: true }), timeout);
    if (typeof readTimer.unref === 'function') readTimer.unref();
  });
}

/**
 * Parse base64 data URL (for audio/video uploads)
 */
function parseBase64DataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new Error('INVALID_AUDIO_DATA');
  }
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('INVALID_AUDIO_DATA');
  }
  const mimeType = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');
  if (!buffer.length) {
    throw new Error('INVALID_AUDIO_DATA');
  }
  return { mimeType, buffer };
}

/**
 * Read raw request body as a Buffer (required for Stripe webhook signature verification)
 */
async function parseRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

module.exports = {
  parseBody,
  parseOptionalJsonBody,
  parseRawBody,
  parseBase64DataUrl,
};
