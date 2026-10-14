/**
 * Simple UTM tracking for landing pages
 * Records page visits with UTM parameters to daily_learning_stats or a simple log
 */

const dataStore = require('../data-store');
const { sendJson, sendError } = require('../middleware/error-handler');
const { parseBody } = require('../utils/parsers');

/**
 * Register tracking routes
 */
async function registerTrackingRoutes(pathname, req, res, url) {
  // POST /api/track/visit - Record a landing page visit
  if (pathname === '/api/track/visit' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { page, utm_source, utm_medium, utm_campaign, utm_content, referrer } = body;

      if (!page) return sendError(res, 400, 'page is required');

      // Insert into tracking table (create if not exists on first call)
      await ensureTrackingTable();
      await dataStore.query(
        `INSERT INTO page_visits (page, utm_source, utm_medium, utm_campaign, utm_content, referrer, visited_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [page, utm_source || null, utm_medium || null, utm_campaign || null, utm_content || null, referrer || null]
      );

      return sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('Track visit error:', err);
      return sendJson(res, 200, { success: true }); // Don't fail the page load
    }
  }

  // GET /api/track/stats - Get visit stats (admin only, no auth for now)
  if (pathname === '/api/track/stats' && req.method === 'GET') {
    try {
      await ensureTrackingTable();
      const days = parseInt(url.searchParams.get('days')) || 7;

      const result = await dataStore.query(`
        SELECT
          page,
          utm_source,
          utm_campaign,
          utm_content,
          COUNT(*) as visits,
          MIN(visited_at) as first_visit,
          MAX(visited_at) as last_visit
        FROM page_visits
        WHERE visited_at >= NOW() - INTERVAL '${days} days'
        GROUP BY page, utm_source, utm_campaign, utm_content
        ORDER BY visits DESC
      `);

      const total = await dataStore.query(`
        SELECT COUNT(*) as total FROM page_visits
        WHERE visited_at >= NOW() - INTERVAL '${days} days'
      `);

      return sendJson(res, 200, {
        total: parseInt(total.rows[0]?.total || 0),
        breakdown: result.rows,
        days
      });
    } catch (err) {
      console.error('Track stats error:', err);
      return sendError(res, 500, err.message);
    }
  }

  return false;
}

let tableCreated = false;
async function ensureTrackingTable() {
  if (tableCreated) return;
  await dataStore.query(`
    CREATE TABLE IF NOT EXISTS page_visits (
      id SERIAL PRIMARY KEY,
      page VARCHAR(100) NOT NULL,
      utm_source VARCHAR(50),
      utm_medium VARCHAR(50),
      utm_campaign VARCHAR(50),
      utm_content VARCHAR(50),
      referrer TEXT,
      visited_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await dataStore.query(`
    CREATE INDEX IF NOT EXISTS idx_page_visits_time ON page_visits(visited_at DESC)
  `);
  tableCreated = true;
}

module.exports = { registerTrackingRoutes };
