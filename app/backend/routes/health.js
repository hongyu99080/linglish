const os = require('os');
const dataStore = require('../data-store');
const { sendJson, sendError } = require('../middleware/error-handler');

const START_TIME = Date.now();

/**
 * GET /api/health
 * Returns server health status including DB connectivity, memory usage, and uptime.
 */
async function handleApiHealth(req, res) {
  let dbStatus = 'ok';
  try {
    await dataStore.query('SELECT 1');
  } catch (err) {
    dbStatus = 'error';
  }

  const memUsage = process.memoryUsage();
  return sendJson(res, 200, {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    database: dbStatus,
    node_version: process.version,
    memory: {
      rss_mb: Math.round(memUsage.rss / 1024 / 1024),
      heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /admin/status-page
 * Serves an HTML admin status page that fetches /api/health and DB stats,
 * auto-refreshing every 30 seconds.
 */
async function handleStatusPage(req, res) {
  let activeUsers = 0;
  let totalArticles = 0;

  try {
    const usersResult = await dataStore.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE last_login_at >= NOW() - INTERVAL '7 days'`
    );
    activeUsers = parseInt(usersResult.rows[0]?.cnt ?? 0, 10);
  } catch (_) {}

  try {
    const articlesResult = await dataStore.query('SELECT COUNT(*) AS cnt FROM articles');
    totalArticles = parseInt(articlesResult.rows[0]?.cnt ?? 0, 10);
  } catch (_) {}

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Linglish — Server Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; padding: 32px; }
    h1 { font-size: 1.6rem; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
    .card h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 8px; }
    .card .value { font-size: 1.8rem; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.85rem; font-weight: 500; }
    .badge.ok { background: #d1fae5; color: #065f46; }
    .badge.error, .badge.degraded { background: #fee2e2; color: #991b1b; }
    .badge.unknown { background: #e5e7eb; color: #374151; }
    .meta { font-size: 0.8rem; color: #888; margin-top: 16px; }
    #refresh-countdown { font-weight: 600; color: #555; }
  </style>
</head>
<body>
  <h1>Linglish — Server Status</h1>

  <div class="grid">
    <div class="card">
      <h2>Server Status</h2>
      <div class="value" id="server-status"><span class="badge unknown">loading…</span></div>
    </div>
    <div class="card">
      <h2>Database</h2>
      <div class="value" id="db-status"><span class="badge unknown">loading…</span></div>
    </div>
    <div class="card">
      <h2>Uptime</h2>
      <div class="value" id="uptime">—</div>
    </div>
    <div class="card">
      <h2>Node.js Version</h2>
      <div class="value" id="node-version">—</div>
    </div>
    <div class="card">
      <h2>Memory (Heap Used)</h2>
      <div class="value" id="memory">—</div>
    </div>
    <div class="card">
      <h2>Active Users (7 days)</h2>
      <div class="value">${activeUsers}</div>
    </div>
    <div class="card">
      <h2>Total Articles</h2>
      <div class="value">${totalArticles}</div>
    </div>
  </div>

  <p class="meta">Last updated: <span id="last-updated">—</span> &nbsp;|&nbsp; Refreshing in <span id="refresh-countdown">30</span>s</p>

  <script>
    const REFRESH_INTERVAL = 30;
    let countdown = REFRESH_INTERVAL;

    function formatUptime(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    function badgeHtml(status) {
      const cls = ['ok', 'error', 'degraded'].includes(status) ? status : 'unknown';
      return '<span class="badge ' + cls + '">' + status + '</span>';
    }

    async function fetchHealth() {
      try {
        const resp = await fetch('/api/health');
        const data = await resp.json();
        document.getElementById('server-status').innerHTML = badgeHtml(data.status || 'unknown');
        document.getElementById('db-status').innerHTML = badgeHtml(data.database || 'unknown');
        document.getElementById('uptime').textContent = formatUptime(data.uptime || 0);
        document.getElementById('node-version').textContent = data.node_version || '—';
        document.getElementById('memory').textContent = (data.memory?.heap_used_mb ?? '—') + ' MB';
        document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
      } catch (err) {
        document.getElementById('server-status').innerHTML = badgeHtml('error');
      }
    }

    fetchHealth();

    setInterval(() => {
      countdown--;
      document.getElementById('refresh-countdown').textContent = countdown;
      if (countdown <= 0) {
        countdown = REFRESH_INTERVAL;
        fetchHealth();
      }
    }, 1000);
  </script>
</body>
</html>`;

  if (res.headersSent || res.writableEnded) return true;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
  return true;
}

/**
 * Register health-related routes.
 * @returns {Promise<boolean>} true if handled
 */
async function registerHealthRoutes(pathname, req, res) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return handleApiHealth(req, res);
  }
  if (pathname === '/admin/status-page' && req.method === 'GET') {
    return handleStatusPage(req, res);
  }
  return false;
}

module.exports = { registerHealthRoutes };
