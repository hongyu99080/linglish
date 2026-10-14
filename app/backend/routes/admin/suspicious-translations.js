/**
 * Admin Routes - Suspicious Translations Management
 * Allows administrators to review and correct suspicious translations
 */

const dataStore = require('../../data-store');
const translationService = require('../../services/translation');
const { parseBody } = require('../../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../../middleware/error-handler');
const { authenticate } = require('../../middleware/auth');

/**
 * Check if user is admin and throw error if not
 * @param {http.IncomingMessage} req - HTTP request object
 * @returns {Promise<Object>} Admin user object
 */
async function requireAdmin(req) {
  const u = await authenticate(req);
  if (!u?.is_admin) {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    throw err;
  }
  return u;
}

/**
 * Register suspicious translations admin routes
 */
async function registerSuspiciousTranslationsRoutes(pathname, req, res, url) {
  // GET /admin/suspicious-translations - List all suspicious translations
  if (pathname === '/admin/suspicious-translations' && req.method === 'GET') {
    try {
      await requireAdmin(req);  // Verify admin access
      const status = url.searchParams.get('status') || 'pending';
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);

      const query = `
        SELECT
          id,
          lemma,
          translation,
          source,
          reasons,
          user_count,
          status,
          detected_at,
          reviewed_at,
          reviewed_by
        FROM suspicious_translations
        WHERE status = $1
        ORDER BY user_count DESC, lemma ASC
        LIMIT $2 OFFSET $3
      `;

      const result = await dataStore.query(query, [status, limit, offset]);

      // Get total count
      const countResult = await dataStore.query(
        'SELECT COUNT(*) as total FROM suspicious_translations WHERE status = $1',
        [status]
      );

      return sendJson(res, 200, {
        success: true,
        items: result.rows || [],
        total: parseInt(countResult.rows[0]?.total || 0, 10),
        limit,
        offset
      });
    } catch (err) {
      console.error('[Admin] Failed to list suspicious translations:', err);
      return sendError(res, 500, 'Failed to fetch suspicious translations');
    }
  }

  // GET /admin/suspicious-translations/stats - Get statistics
  if (pathname === '/admin/suspicious-translations/stats' && req.method === 'GET') {
    try {
      await requireAdmin(req);  // Verify admin access
      const statsQuery = `
        SELECT
          status,
          COUNT(*) as count
        FROM suspicious_translations
        GROUP BY status
      `;

      const reasonsQuery = `
        SELECT
          UNNEST(reasons) as reason,
          COUNT(*) as count
        FROM suspicious_translations
        WHERE status = 'pending'
        GROUP BY reason
        ORDER BY count DESC
        LIMIT 10
      `;

      const [statsResult, reasonsResult] = await Promise.all([
        dataStore.query(statsQuery),
        dataStore.query(reasonsQuery)
      ]);

      const stats = {
        byStatus: {},
        topReasons: reasonsResult.rows || []
      };

      (statsResult.rows || []).forEach(row => {
        stats.byStatus[row.status] = parseInt(row.count, 10);
      });

      return sendJson(res, 200, { success: true, stats });
    } catch (err) {
      console.error('[Admin] Failed to get suspicious translations stats:', err);
      return sendError(res, 500, 'Failed to get statistics');
    }
  }

  // POST /admin/suspicious-translations/correct - Correct translation using OpenAI
  if (pathname === '/admin/suspicious-translations/correct' && req.method === 'POST') {
    try {
      const user = await requireAdmin(req);  // Verify admin access and get user
      const body = await parseBody(req);
      const { lemma, id } = body;

      if (!lemma) {
        return sendError(res, 400, 'Lemma is required');
      }

      // Get current translation
      const itemQuery = await dataStore.query(
        'SELECT translation FROM suspicious_translations WHERE lemma = $1',
        [lemma]
      );

      if (!itemQuery.rows || itemQuery.rows.length === 0) {
        return sendError(res, 404, 'Suspicious translation not found');
      }

      const currentTranslation = itemQuery.rows[0].translation;
      const adminLabel = user.username || user.email || `admin-${user.id}`;

      console.log(`[Admin] ${adminLabel} correcting translation for: ${lemma}`);

      // Call OpenAI correction service (PAID API)
      const result = await translationService.correctTranslation(
        lemma,
        currentTranslation,
        { userLabel: adminLabel }
      );

      // Update suspicious_translations table
      await dataStore.query(`
        UPDATE suspicious_translations
        SET status = 'corrected',
            reviewed_at = NOW(),
            reviewed_by = $1
        WHERE lemma = $2
      `, [user.id, lemma]);

      console.log(`[Admin] Successfully corrected: ${lemma} | "${currentTranslation}" → "${result.translation}"`);

      return sendJson(res, 200, {
        success: true,
        lemma,
        oldTranslation: currentTranslation,
        newTranslation: result.translation,
        source: result.source
      });
    } catch (err) {
      console.error('[Admin] Failed to correct translation:', err);
      return sendError(res, 500, err.message || 'Failed to correct translation');
    }
  }

  // POST /admin/suspicious-translations/batch-correct - Batch correct translations
  if (pathname === '/admin/suspicious-translations/batch-correct' && req.method === 'POST') {
    try {
      const user = await requireAdmin(req);  // Verify admin access and get user
      const body = await parseBody(req);
      const { lemmas, limit } = body;

      if (!Array.isArray(lemmas) || lemmas.length === 0) {
        return sendError(res, 400, 'Lemmas array is required');
      }

      const maxBatch = Math.min(lemmas.length, limit || 50);
      const results = {
        total: lemmas.length,
        processed: 0,
        corrected: 0,
        failed: 0,
        details: []
      };

      const adminLabel = user.username || user.email || `admin-${user.id}`;

      for (let i = 0; i < maxBatch; i++) {
        const lemma = lemmas[i];

        try {
          // Get current translation
          const itemQuery = await dataStore.query(
            'SELECT translation FROM suspicious_translations WHERE lemma = $1',
            [lemma]
          );

          if (!itemQuery.rows || itemQuery.rows.length === 0) {
            results.details.push({ lemma, success: false, error: 'Not found' });
            results.failed++;
            continue;
          }

          const currentTranslation = itemQuery.rows[0].translation;

          // Correct translation
          const result = await translationService.correctTranslation(
            lemma,
            currentTranslation,
            { userLabel: adminLabel }
          );

          // Update status
          await dataStore.query(`
            UPDATE suspicious_translations
            SET status = 'corrected',
                reviewed_at = NOW(),
                reviewed_by = $1
            WHERE lemma = $2
          `, [user.id, lemma]);

          results.details.push({
            lemma,
            success: true,
            oldTranslation: currentTranslation,
            newTranslation: result.translation
          });
          results.corrected++;

          // Rate limiting: wait 100ms between API calls
          if (i < maxBatch - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (err) {
          results.details.push({ lemma, success: false, error: err.message });
          results.failed++;
        }

        results.processed++;
      }

      return sendJson(res, 200, {
        success: true,
        results
      });
    } catch (err) {
      console.error('[Admin] Failed to batch correct translations:', err);
      return sendError(res, 500, 'Failed to batch correct translations');
    }
  }

  // POST /admin/suspicious-translations/dismiss - Dismiss a suspicious translation
  if (pathname === '/admin/suspicious-translations/dismiss' && req.method === 'POST') {
    try {
      const user = await requireAdmin(req);  // Verify admin access and get user
      const body = await parseBody(req);
      const { lemma } = body;

      if (!lemma) {
        return sendError(res, 400, 'Lemma is required');
      }

      await dataStore.query(`
        UPDATE suspicious_translations
        SET status = 'dismissed',
            reviewed_at = NOW(),
            reviewed_by = $1
        WHERE lemma = $2
      `, [user.id, lemma]);

      return sendJson(res, 200, {
        success: true,
        message: 'Translation dismissed successfully'
      });
    } catch (err) {
      console.error('[Admin] Failed to dismiss translation:', err);
      return sendError(res, 500, 'Failed to dismiss translation');
    }
  }

  // GET /admin/suspicious-translations/export - Export suspicious translations to CSV
  if (pathname === '/admin/suspicious-translations/export' && req.method === 'GET') {
    try {
      await requireAdmin(req);  // Verify admin access
      const status = url.searchParams.get('status') || 'pending';

      const query = `
        SELECT
          lemma,
          translation,
          source,
          user_count,
          reasons
        FROM suspicious_translations
        WHERE status = $1
        ORDER BY user_count DESC, lemma ASC
      `;

      const result = await dataStore.query(query, [status]);
      let items = result.rows || [];
      console.log(`[Admin Export] suspicious_translations rows for status=${status}:`, items.length);

      // Also include vocabulary items that are missing translations (for manual translation pipeline)
      if (status === 'pending') {
        const missingQuery = `
          SELECT
            lemma,
            '' AS translation,
            'user_vocab_items' AS source,
            COUNT(*) AS user_count,
            ARRAY['missing translation'] AS reasons
          FROM user_vocab_items
          WHERE
            translation IS NULL
            OR trim(translation) = ''
            OR translation LIKE '[待翻译]%'
            OR translation = lemma
          GROUP BY lemma
          ORDER BY user_count DESC, lemma ASC
        `;
        const missingResult = await dataStore.query(missingQuery);
        const missingItems = missingResult.rows || [];
        console.log('[Admin Export] missing translation vocab rows:', missingItems.length);

        // Merge suspicious items and missing-translation vocab, de-duplicating by lemma
        const merged = new Map();
        [...items, ...missingItems].forEach((row) => {
          const key = row.lemma;
          const existing = merged.get(key) || {};
          merged.set(key, {
            lemma: key,
            translation: existing.translation || row.translation || '',
            source: existing.source || row.source || '',
            user_count: Math.max(existing.user_count || 0, row.user_count || 0),
            reasons: Array.from(new Set([...(existing.reasons || []), ...(row.reasons || [])])),
          });
        });
        items = Array.from(merged.values());
        console.log('[Admin Export] merged export rows:', items.length);
      }

      // Generate CSV content
      let csv = '\uFEFF'; // UTF-8 BOM for Excel compatibility
      csv += 'lemma,translation,source,user_count,reasons\n';

      items.forEach(item => {
        const lemma = escapeCsvField(item.lemma);
        const translation = escapeCsvField(item.translation || '');
        const source = escapeCsvField(item.source || '');
        const userCount = item.user_count || 0;
        const reasons = escapeCsvField(Array.isArray(item.reasons) ? item.reasons.join('; ') : '');
        csv += `${lemma},${translation},${source},${userCount},${reasons}\n`;
      });

      // Set headers for CSV download
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="suspicious-translations-${status}-${new Date().toISOString().split('T')[0]}.csv"`);
      res.writeHead(200);
      return res.end(csv);
    } catch (err) {
      console.error('[Admin] Failed to export suspicious translations:', err);
      return sendError(res, 500, 'Failed to export translations');
    }
  }

  // POST /admin/suspicious-translations/import - Import corrected translations from CSV
  if (pathname === '/admin/suspicious-translations/import' && req.method === 'POST') {
    try {
      const user = await requireAdmin(req);  // Verify admin access and get user
      const body = await parseBody(req);
      const { csvData } = body;

      if (!csvData || typeof csvData !== 'string') {
        return sendError(res, 400, 'CSV data is required');
      }

      // Parse CSV (skip BOM if present)
      const lines = csvData.replace(/^\uFEFF/, '').split('\n').map(line => line.trim()).filter(Boolean);

      if (lines.length < 2) {
        return sendError(res, 400, 'CSV file is empty or invalid');
      }

      // Parse header
      const header = lines[0].toLowerCase();
      if (!header.includes('lemma') || !header.includes('translation')) {
        return sendError(res, 400, 'CSV must contain "lemma" and "translation" columns');
      }

      const results = {
        total: lines.length - 1,
        processed: 0,
        updated: 0,
        failed: 0,
        details: []
      };

      // Process each line (skip header)
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        try {
          // Simple CSV parsing (handles quoted fields)
          const fields = parseCsvLine(line);

          if (fields.length < 2) {
            results.details.push({ line: i + 1, error: 'Invalid format' });
            results.failed++;
            continue;
          }

          const lemma = fields[0].trim();
          const translation = fields[1].trim();

          if (!lemma) {
            results.details.push({ line: i + 1, error: 'Empty lemma' });
            results.failed++;
            continue;
          }

          if (!translation) {
            results.details.push({ line: i + 1, lemma, error: 'Empty translation' });
            results.failed++;
            continue;
          }

          // Update translation in user_vocab_items for all users
          const updateResult = await dataStore.query(`
            UPDATE user_vocab_items
            SET translation = $1,
                updated_at = NOW()
            WHERE lemma = $2
          `, [translation, lemma]);

          const updatedCount = updateResult.rowCount || 0;

          // Update suspicious_translations status if exists
          await dataStore.query(`
            UPDATE suspicious_translations
            SET status = 'corrected',
                reviewed_at = NOW(),
                reviewed_by = $1
            WHERE lemma = $2
          `, [user.id, lemma]);

          results.details.push({
            line: i + 1,
            lemma,
            translation,
            updatedCount,
            success: true
          });
          results.updated++;
        } catch (err) {
          console.error(`[Admin] Failed to import line ${i + 1}:`, err);
          results.details.push({
            line: i + 1,
            error: err.message
          });
          results.failed++;
        }

        results.processed++;
      }

      console.log(`[Admin] ${user.username || user.email} imported ${results.updated} translations`);

      return sendJson(res, 200, {
        success: true,
        results
      });
    } catch (err) {
      console.error('[Admin] Failed to import translations:', err);
      return sendError(res, 500, err.message || 'Failed to import translations');
    }
  }

  // Not a suspicious translations route
  return false;
}

/**
 * Escape CSV field (add quotes if contains comma, quote, or newline)
 */
function escapeCsvField(str) {
  if (str == null) return '';
  str = String(str);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Parse a single CSV line (handles quoted fields)
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  // Add last field
  fields.push(current);

  return fields;
}

module.exports = {
  registerSuspiciousTranslationsRoutes
};
