const mediaLibrary = require('../services/media-library');

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return false;
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
  return true;
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (_) {
    return {};
  }
}

async function handle(res, work) {
  try {
    const payload = await work();
    return sendJson(res, 200, { success: true, ...payload });
  } catch (error) {
    const message = error && error.message ? error.message : '请求失败';
    const status = /拉取失败|网络请求失败|请求超时|内容过大/.test(message) ? 502 : 400;
    return sendJson(res, status, { success: false, error: message });
  }
}

async function registerMediaLibraryRoutes(pathname, req, res) {
  if (!pathname.startsWith('/media/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, JSON_HEADERS);
    res.end();
    return true;
  }
  if (req.method !== 'POST') return false;

  if (pathname === '/media/channels/preview') {
    const body = await parseBody(req);
    return handle(res, async () => ({ channel: await mediaLibrary.loadYouTubeChannel(body.url || body.input) }));
  }
  if (pathname === '/media/podcasts/search') {
    const body = await parseBody(req);
    return handle(res, async () => ({ podcasts: await mediaLibrary.searchPodcasts(body.query) }));
  }
  if (pathname === '/media/podcasts/preview') {
    const body = await parseBody(req);
    return handle(res, async () => ({ podcast: await mediaLibrary.loadPodcastFeed(body.url) }));
  }
  if (pathname === '/media/cues') {
    const body = await parseBody(req);
    return handle(res, async () => ({ cues: await mediaLibrary.loadTranscriptCues(body.url) }));
  }
  return false;
}

module.exports = { registerMediaLibraryRoutes };
