const dataStore = require('../data-store');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { requireAiVocabToken } = require('../middleware/ai-auth');
const { analyzeWordQuality } = require('../utils/word-quality');
const { createCurationService } = require('../services/dictionary/curation');

const curation = createCurationService();

function normalizeNullableString(v) {
  if (v === null) return null;
  if (typeof v === 'undefined') return undefined;
  const s = String(v).trim();
  return s ? s : null;
}

function isObject(val) {
  return val && typeof val === 'object' && !Array.isArray(val);
}

function curationResponse(result) {
  return {
    batch_id: result.batch_id || null,
    source: result.source || null,
    reasons: result.reasons || [],
    conflicts: result.conflicts || [],
    quality_status: result.quality_status || result.after?.quality_status || 'review',
    seo_indexable: result.seo_indexable === true || result.after?.seo_indexable === true,
  };
}

async function readWordsSchema() {
  const { rows } = await dataStore.pool.query(
    `
      SELECT
        column_name,
        data_type,
        is_nullable,
        udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'words'
      ORDER BY ordinal_position ASC
    `
  );
  return rows || [];
}

function buildLowQualitySql(prefix = 'w.') {
  // Must match the heuristics used in /vocab/full-library and /admin/words/low-quality
  return `
    (LENGTH(${prefix}word_lowercase) >= 8 AND ${prefix}word_lowercase ~ '([a-z])\\1\\1\\1')
    OR (${prefix}word_lowercase ~ '[0-9]')
    OR (${prefix}word_lowercase ~ '[^a-z\\-\\']')
    OR (LENGTH(${prefix}word_lowercase) > 45)
    OR ((LENGTH(${prefix}word_lowercase) = 1) AND ${prefix}word_lowercase NOT IN ('a','i'))
    OR ((LENGTH(${prefix}word_lowercase) >= 7) AND ${prefix}word_lowercase !~ '[aeiouy]')
  `;
}

async function resolveWordId({ id, word }) {
  const n = Number(id);
  if (Number.isInteger(n) && n > 0) return n;
  const w = (word || '').trim();
  if (!w) return null;
  const wl = w.toLowerCase();
  const { rows } = await dataStore.pool.query('SELECT id FROM words WHERE word_lowercase = $1 LIMIT 1', [wl]);
  return rows?.[0]?.id ? Number(rows[0].id) : null;
}

async function registerAiVocabRoutes(pathname, req, res, url) {
  // GET /ai/vocab/schema
  if (pathname === '/ai/vocab/schema' && req.method === 'GET') {
    try {
      requireAiVocabToken(req);
      const columns = await readWordsSchema();
      return sendJson(res, 200, {
        success: true,
        table: 'words',
        columns,
        notes: {
          primaryKey: 'id',
          globalUnique: 'word_lowercase',
          userLink: 'user_vocabulary(word_id -> words.id)',
          translationField: 'definitions->>zh',
        }
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /ai/vocab/candidates
  // Query params:
  // - limit, offset
  // - search
  // - missing_zh=1
  // - missing_phonetic=1
  // - low_quality=1
  // - only_unused=1 (learned_by_count=0)
  // - min_lookup, max_lookup
  if (pathname === '/ai/vocab/candidates' && req.method === 'GET') {
    try {
      requireAiVocabToken(req);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
      const offset = Number(url.searchParams.get('offset')) || 0;
      const search = (url.searchParams.get('search') || '').trim();

      const missingZh = (url.searchParams.get('missing_zh') || '') === '1';
      const missingPhonetic = (url.searchParams.get('missing_phonetic') || '') === '1';
      const lowQuality = (url.searchParams.get('low_quality') || '') === '1';
      const onlyUnused = (url.searchParams.get('only_unused') || '1') !== '0';
      // 是否包含黑名单词汇，默认不包含
      const includeBlacklisted = (url.searchParams.get('include_blacklisted') || '') === '1';
      // 是否只显示黑名单词汇
      const onlyBlacklisted = (url.searchParams.get('only_blacklisted') || '') === '1';

      const minLookup = url.searchParams.get('min_lookup') ? Number(url.searchParams.get('min_lookup')) : null;
      const maxLookup = url.searchParams.get('max_lookup') ? Number(url.searchParams.get('max_lookup')) : null;

      const where = [];
      const params = [];
      let idx = 1;

      if (search) {
        where.push(`w.word_lowercase LIKE $${idx++}`);
        params.push(`%${search.toLowerCase()}%`);
      }

      if (onlyUnused) {
        where.push(`COALESCE(w.learned_by_count, 0) = 0`);
      }

      if (Number.isFinite(minLookup)) {
        where.push(`COALESCE(w.lookup_count, 0) >= $${idx++}`);
        params.push(minLookup);
      }
      if (Number.isFinite(maxLookup)) {
        where.push(`COALESCE(w.lookup_count, 0) <= $${idx++}`);
        params.push(maxLookup);
      }

      if (missingPhonetic) {
        where.push(`(w.phonetic IS NULL OR w.phonetic = '')`);
      }

      if (missingZh) {
        where.push(`(w.definitions IS NULL OR w.definitions->>'zh' IS NULL OR w.definitions->>'zh' = '' OR w.definitions->>'zh' LIKE '[待翻译]%')`);
      }

      if (lowQuality) {
        where.push(`(${buildLowQualitySql('w.')})`);
      }

      // 黑名单过滤
      if (onlyBlacklisted) {
        where.push(`w.is_blacklisted = TRUE`);
      } else if (!includeBlacklisted) {
        where.push(`(w.is_blacklisted = FALSE OR w.is_blacklisted IS NULL)`);
      }

      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const countQuery = `SELECT COUNT(*)::int AS total FROM words w ${whereClause}`;
      const { rows: countRows } = await dataStore.pool.query(countQuery, params);
      const totalCount = countRows?.[0]?.total || 0;

      params.push(limit, offset);
      const itemsQuery = `
        SELECT
          w.id,
          w.word,
          w.word_lowercase,
          w.phonetic,
          w.part_of_speech,
          w.definitions,
          w.example_sentences,
          w.lookup_count,
          w.learned_by_count,
          w.is_blacklisted,
          w.blacklisted_at,
          w.blacklist_reason,
          w.created_at,
          w.updated_at
        FROM words w
        ${whereClause}
        ORDER BY COALESCE(w.learned_by_count, 0) ASC, COALESCE(w.lookup_count, 0) ASC, w.id DESC
        LIMIT $${idx++} OFFSET $${idx++}
      `;

      const { rows } = await dataStore.pool.query(itemsQuery, params);
      const items = (rows || []).map(r => {
        const q = analyzeWordQuality(r.word);
        const defs = r.definitions && typeof r.definitions === 'object' ? r.definitions : null;
        const zh = defs ? (defs.zh || '') : '';
        return {
          ...r,
          translation_zh: (zh && !String(zh).startsWith('[待翻译]')) ? zh : '',
          quality_reasons: q.reasons,
        };
      });

      return sendJson(res, 200, {
        success: true,
        items,
        totalCount,
        limit,
        offset,
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // Backward-compatible aliases (some AI skills expect these paths)
  // GET /ai/vocab -> same as /ai/vocab/candidates
  if (pathname === '/ai/vocab' && req.method === 'GET') {
    const u = new URL(req.url || '', 'http://localhost');
    u.pathname = '/ai/vocab/candidates';
    // Re-run route handler by delegating with updated URL object.
    return registerAiVocabRoutes('/ai/vocab/candidates', req, res, u);
  }

  // GET /ai/vocab/low-quality -> shortcut for low_quality=1
  if (pathname === '/ai/vocab/low-quality' && req.method === 'GET') {
    const u = new URL(req.url || '', 'http://localhost');
    u.pathname = '/ai/vocab/candidates';
    if (!u.searchParams.has('low_quality')) u.searchParams.set('low_quality', '1');
    return registerAiVocabRoutes('/ai/vocab/candidates', req, res, u);
  }

  // GET /ai/vocab/item?id=... or ?word=...
  if (pathname === '/ai/vocab/item' && req.method === 'GET') {
    try {
      requireAiVocabToken(req);
      const idRaw = url.searchParams.get('id');
      const wordRaw = url.searchParams.get('word');
      const id = idRaw ? Number(idRaw) : null;
      const word = (wordRaw || '').trim();
      if (!id && !word) return sendError(res, 400, 'id or word is required');

      let row = null;
      if (Number.isInteger(id) && id > 0) {
        const { rows } = await dataStore.pool.query('SELECT * FROM words WHERE id = $1 LIMIT 1', [id]);
        row = rows?.[0] || null;
      } else {
        const wl = word.toLowerCase();
        const { rows } = await dataStore.pool.query('SELECT * FROM words WHERE word_lowercase = $1 LIMIT 1', [wl]);
        row = rows?.[0] || null;
      }
      if (!row) return sendError(res, 404, 'word not found');

      const q = analyzeWordQuality(row.word);
      const defs = row.definitions && typeof row.definitions === 'object' ? row.definitions : null;
      const zh = defs ? (defs.zh || '') : '';

      return sendJson(res, 200, {
        success: true,
        item: {
          ...row,
          translation_zh: (zh && !String(zh).startsWith('[待翻译]')) ? zh : '',
          quality_reasons: q.reasons,
        }
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /ai/vocab/apply
  // Body:
  // {
  //   dry_run: true|false,
  //   operations: [
  //     { id?: number, word?: string, action: "update"|"delete", word_new?: string, phonetic?: string|null, part_of_speech?: string|null, zh?: string|null, definitions?: object|null }
  //   ]
  // }
  if (pathname === '/ai/vocab/apply' && req.method === 'POST') {
    try {
      const aiActor = requireAiVocabToken(req);
      const body = await parseBody(req);
      const dryRun = !!body.dry_run;
      const operations = Array.isArray(body.operations) ? body.operations : [];
      if (!operations.length) return sendError(res, 400, 'operations is required');
      if (operations.length > 500) return sendError(res, 400, 'Too many operations (max 500)');

      {
        const curatedResults = new Array(operations.length);
        const batchIds = new Set();
        let curatedUpdated = 0;
        let curatedDeleted = 0;
        let curatedUserVocabUpdated = 0;
        let curatedUserVocabDeleted = 0;
        const prepared = [];
        for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
          const opRaw = operations[operationIndex];
          const op = opRaw && typeof opRaw === 'object' ? opRaw : {};
          const action = String(op.action || 'update').toLowerCase();
          if (!['update', 'delete'].includes(action)) {
            curatedResults[operationIndex] = { success: false, error: 'Invalid action (update|delete)', op: opRaw };
            continue;
          }
          if (action === 'update' && Object.hasOwn(op, 'definitions')
              && op.definitions !== null && !isObject(op.definitions)) {
            curatedResults[operationIndex] = { success: false, error: 'definitions must be an object or null', op: opRaw };
            continue;
          }
          const id = await resolveWordId({ id: op.id, word: op.word });
          if (!id) {
            curatedResults[operationIndex] = { success: false, error: 'Word not found (id/word)', op: opRaw };
            continue;
          }
          const candidate = {};
          if (Object.hasOwn(op, 'word_new')) {
            candidate.word = op.word_new;
            candidate.word_lowercase = String(op.word_new || '').trim().toLowerCase();
          }
          for (const field of ['phonetic', 'part_of_speech', 'zh', 'definitions']) {
            if (Object.hasOwn(op, field)) candidate[field] = op[field];
          }
          const write = {
            id,
            action: action === 'delete' ? 'blacklist' : 'upsert',
            candidate,
            source: 'ai_vocab',
            reviewed: false,
            metadata: { path: pathname },
          };
          prepared.push({ operationIndex, action, id, write });
        }
        const validatedPrepared = [];
        for (const item of prepared) {
          try {
            const preview = await curation.preview({ write: item.write, actor: { type: 'ai', id: aiActor?.id } });
            if (preview.status === 'missing') {
              curatedResults[item.operationIndex] = { success: false, action: item.action, id: item.id, error: 'Word not found' };
              continue;
            }
            validatedPrepared.push({ ...item, preview });
          } catch (error) {
            curatedResults[item.operationIndex] = { success: false, action: item.action, id: item.id, error: error.message };
          }
        }
        const appliedResults = validatedPrepared.length === 0
          ? []
          : dryRun
            ? validatedPrepared.map(({ preview }) => preview)
            : (await curation.applyBatch({ writes: validatedPrepared.map(({ write }) => write), actor: { type: 'ai', id: aiActor?.id } })).results;
        for (let index = 0; index < validatedPrepared.length; index++) {
          const { operationIndex, action, id } = validatedPrepared[index];
          const curated = appliedResults[index];
          if (curated.batch_id) batchIds.add(curated.batch_id);
          if (!dryRun && action === 'update') curatedUpdated += curated.applied || 0;
          if (!dryRun && action === 'delete') curatedDeleted += curated.blacklisted || curated.applied || 0;
          curatedUserVocabUpdated += curated.user_vocabulary_updated || 0;
          curatedUserVocabDeleted += curated.user_vocabulary_deleted || 0;
          curatedResults[operationIndex] = {
            success: true,
            action,
            id,
            before: curated.before,
            after: curated.after,
            ...(action === 'delete'
              ? dryRun
                ? { wouldBlacklist: true, wouldDeleteUserVocab: true }
                : {
                    blacklisted: curated.blacklisted || curated.applied || 0,
                    userVocabDeleted: curated.user_vocabulary_deleted || 0,
                    note: '已停用并从用户词库移除，可回滚恢复',
                  }
              : {}),
            ...curationResponse(curated),
          };
        }
        return sendJson(res, 200, {
          success: true,
          dry_run: dryRun,
          summary: {
            updated: curatedUpdated,
            deleted: curatedDeleted,
            userVocabUpdated: dryRun ? 0 : curatedUserVocabUpdated,
            userVocabDeleted: dryRun ? 0 : curatedUserVocabDeleted,
          },
          results: curatedResults,
          batch_ids: [...batchIds],
        });
      }

    } catch (err) {
      console.error('[AI Vocab] apply error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /ai/vocab/batch-apply -> alias for /ai/vocab/apply
  if (pathname === '/ai/vocab/batch-apply' && req.method === 'POST') {
    const u = new URL(req.url || '', 'http://localhost');
    u.pathname = '/ai/vocab/apply';
    return registerAiVocabRoutes('/ai/vocab/apply', req, res, u);
  }

  // POST /ai/vocab/unblacklist - 从黑名单中恢复词汇
  if (pathname === '/ai/vocab/unblacklist' && req.method === 'POST') {
    try {
      const aiActor = requireAiVocabToken(req);
      const body = await parseBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];

      if (!ids.length) {
        return sendError(res, 400, 'ids is required (array of word IDs)');
      }

      const batch = await curation.applyBatch({
        writes: ids.map((id) => ({ id, action: 'unblacklist', source: 'ai_vocab', reviewed: false, metadata: { path: pathname } })),
        actor: { type: 'ai', id: aiActor?.id },
      });
      const rowCount = batch.results.reduce((sum, curated) => sum + Number(curated.unblacklisted || curated.applied || 0), 0);

      return sendJson(res, 200, {
        success: true,
        recovered: rowCount || 0,
        batch_id: batch.batch_id,
        message: `已从黑名单恢复 ${rowCount || 0} 个词汇`
      });
    } catch (err) {
      console.error('[AI Vocab] unblacklist error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /ai/vocab/blacklist-stats - 获取黑名单统计
  if (pathname === '/ai/vocab/blacklist-stats' && req.method === 'GET') {
    try {
      requireAiVocabToken(req);
      const { rows } = await dataStore.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE is_blacklisted = TRUE)::int AS blacklisted_count,
          COUNT(*) FILTER (WHERE is_blacklisted = FALSE OR is_blacklisted IS NULL)::int AS active_count,
          COUNT(*)::int AS total_count
        FROM words
      `);
      return sendJson(res, 200, {
        success: true,
        stats: rows[0] || { blacklisted_count: 0, active_count: 0, total_count: 0 }
      });
    } catch (err) {
      console.error('[AI Vocab] blacklist-stats error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  return false;
}

module.exports = {
  registerAiVocabRoutes,
};
