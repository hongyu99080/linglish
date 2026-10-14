const dataStore = require('../../data-store');
const { parseBody } = require('../../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../../middleware/error-handler');
const { authenticate } = require('../../middleware/auth');
const { analyzeWordQuality } = require('../../utils/word-quality');
const { createCurationService } = require('../../services/dictionary/curation');

const curation = createCurationService();

function isDryRun(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function curateLegacyWrite({ admin, dryRun = false, ...write }) {
  if (isDryRun(dryRun)) return curation.preview({ write, actor: { type: 'admin', id: admin?.id } });
  return curation.apply({ write, actor: { type: 'admin', id: admin?.id } });
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

function aggregateCurationResponses(results = []) {
  const summaries = results.map(curationResponse);
  const sources = [...new Set(summaries.map((item) => item.source).filter(Boolean))];
  const reasons = [...new Set(summaries.flatMap((item) => item.reasons || []))];
  const conflicts = [];
  const seenConflicts = new Set();
  for (const conflict of summaries.flatMap((item) => item.conflicts || [])) {
    const key = JSON.stringify(conflict);
    if (seenConflicts.has(key)) continue;
    seenConflicts.add(key);
    conflicts.push(conflict);
  }
  return {
    source: sources.length === 1 ? sources[0] : (sources.length > 1 ? 'mixed' : null),
    reasons,
    conflicts,
  };
}

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
 * Register and handle admin translation management routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - URL object for query parameters
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerAdminTranslationsRoutes(pathname, req, res, url) {
  // GET /admin/translations/missing
  // 新版：从全局 words 表获取缺失翻译的词汇
  if (pathname === '/admin/translations/missing' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 100;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;

      const { rows: items } = await dataStore.pool.query(`
        SELECT
          w.id,
          w.word as lemma,
          w.word_lowercase,
          w.phonetic,
          w.definitions,
          COALESCE(w.definitions->>'zh', '[待翻译]') as translation,
          COALESCE(w.definitions->>'en', '') as english_definition,
          w.lookup_count as user_count,
          w.lookup_count as total_exposures,
          w.created_at as first_seen_at,
          w.updated_at as last_seen_at
        FROM words w
        WHERE (
          w.definitions IS NULL
          OR w.definitions::text LIKE '%[待翻译]%'
          OR NOT (w.definitions ? 'zh')
        )
        AND (w.is_blacklisted = FALSE OR w.is_blacklisted IS NULL)
        ORDER BY w.lookup_count DESC NULLS LAST, w.word
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      // 获取活跃词汇缺翻译数量（排除黑名单）
      const { rows: [{ total }] } = await dataStore.pool.query(`
        SELECT COUNT(*) as total
        FROM words
        WHERE (
          definitions IS NULL
          OR definitions::text LIKE '%[待翻译]%'
          OR NOT (definitions ? 'zh')
        )
        AND (is_blacklisted = FALSE OR is_blacklisted IS NULL)
      `);

      // 获取黑名单词汇数量
      const { rows: [{ blacklisted_count }] } = await dataStore.pool.query(`
        SELECT COUNT(*) as blacklisted_count
        FROM words
        WHERE is_blacklisted = TRUE
      `);

      return sendJson(res, 200, { items, total: Number(total), blacklisted_count: Number(blacklisted_count) });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/translations/retranslate
  // 新版：更新全局 words 表的翻译
  if (pathname === '/admin/translations/retranslate' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { lemma, retryCount = 0, dry_run = false, reviewed = false } = await parseBody(req);

      if (!lemma) {
        return sendError(res, 400, '缺少 lemma 参数');
      }

      // 记录重试次数到日志
      if (retryCount > 0) {
        console.log(`[Admin Retranslate] Retry attempt ${retryCount} for "${lemma}"`);
      }

      // 1. 获取字典信息（英文定义和音标）
      const dictionary = require('../../services/dictionary');
      let enDefinition = '';
      let phonetic = '';

      try {
        const dictResult = await dictionary.lookup(lemma, { persist: !isDryRun(dry_run) });
        if (dictResult?.entry) {
          const entry = dictResult.entry;

          // 提取英文定义
          if (entry.meanings?.[0]?.definitions?.[0]?.definition) {
            enDefinition = entry.meanings[0].definitions[0].definition;
          }

          // 提取音标
          phonetic = entry.phonetic || '';
          if (!phonetic && Array.isArray(entry.phonetics) && entry.phonetics.length > 0) {
            const phoneticEntry = entry.phonetics.find(p => p && (p.text || p.phonetic));
            phonetic = phoneticEntry?.text || phoneticEntry?.phonetic || '';
          }

          console.log(`[Admin Retranslate] Dictionary lookup for "${lemma}": phonetic=${phonetic || 'none'}, definition=${enDefinition ? 'found' : 'none'}`);
        }
      } catch (dictErr) {
        console.log(`[Admin Retranslate] Dictionary API failed for "${lemma}": ${dictErr.message}`);
      }

      // 2. 使用翻译服务获取中文翻译
      const { translateWord } = require('../../services/translation.js');
      const userLabel = admin?.username || admin?.email || `admin-${admin?.id || 'unknown'}`;
      const result = await translateWord(lemma, { userLabel, persist: !isDryRun(dry_run) });

      console.log(`[Admin Retranslate] Translation result for "${lemma}":`, result.translation, 'needsReview:', result.needsReview);

      // Low-confidence providers are allowed to write only through curation and remain noindex/review.
      const isValidTranslation = result.translation &&
        !result.translation.startsWith('[待翻译]') &&
        result.translation.toLowerCase() !== lemma.toLowerCase();

      if (isValidTranslation) {
        const curated = await curateLegacyWrite({
          admin,
          dryRun: dry_run,
          word: lemma,
          candidate: {
            ...(phonetic ? { phonetic } : {}),
            ...(enDefinition ? { definitions: { en: enDefinition, zh: result.translation } } : { zh: result.translation }),
          },
          source: result.source || 'translation_service',
          reviewed,
          metadata: { path: pathname, score: result.score ?? null },
        });

        console.log(`[Admin Retranslate] ✓ Updated "${lemma}": phonetic=${phonetic || 'none'}, en=${enDefinition ? 'found' : 'kept existing'}, zh=${result.translation}`);

        return sendJson(res, 200, {
          success: true,
          dry_run: isDryRun(dry_run),
          lemma,
          phonetic: phonetic || '',
          english_definition: enDefinition || '',
          translation: result.translation,
          updated_count: curated.applied || 0,
          word_id: curated.after?.id,
          ...curationResponse(curated),
        });
      } else {
        console.log(`[Admin Retranslate] ✗ Skipped "${lemma}": translation="${result.translation}", needsReview=${result.needsReview}`);

        return sendJson(res, 200, {
          success: false,
          lemma,
          message: '翻译失败或质量不佳',
          translation: result.translation,
          needsReview: result.needsReview,
          phonetic: phonetic || '',
          english_definition: enDefinition || ''
        });
      }
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/translations/retranslate-batch
  // 新版：批量更新 words 表的翻译
  if (pathname === '/admin/translations/retranslate-batch' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { limit = 50, dry_run = false, reviewed = false } = await parseBody(req);

      // 获取需要翻译的词汇（从 words 表）
      const { rows: items } = await dataStore.pool.query(`
        SELECT id, word, word_lowercase, definitions, phonetic
        FROM words
        WHERE (
          definitions IS NULL
          OR definitions::text LIKE '%[待翻译]%'
          OR NOT (definitions ? 'zh')
        )
        ORDER BY lookup_count DESC NULLS LAST, word
        LIMIT $1
      `, [limit]);

      const { translateWord } = require('../../services/translation.js');
      const dictionary = require('../../services/dictionary');
      let successCount = 0;
      let failCount = 0;
      const batchIds = [];

      console.log(`[Batch Translation] Starting batch translation for ${items.length} items`);

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
          const userLabel = admin?.username || admin?.email || `admin-${admin?.id || 'unknown'}`;

          // 1. 获取字典信息（英文定义和音标）
          let enDefinition = item.definitions?.en || '';
          let phonetic = item.phonetic || '';

          // 如果缺少英文定义或音标，从字典API获取
          if (!enDefinition || !phonetic) {
            try {
              const dictResult = await dictionary.lookup(item.word, { persist: !isDryRun(dry_run) });
              if (dictResult?.entry) {
                const entry = dictResult.entry;

                // 提取英文定义
                if (!enDefinition && entry.meanings?.[0]?.definitions?.[0]?.definition) {
                  enDefinition = entry.meanings[0].definitions[0].definition;
                }

                // 提取音标
                if (!phonetic) {
                  phonetic = entry.phonetic || '';
                  if (!phonetic && Array.isArray(entry.phonetics) && entry.phonetics.length > 0) {
                    const phoneticEntry = entry.phonetics.find(p => p && (p.text || p.phonetic));
                    phonetic = phoneticEntry?.text || phoneticEntry?.phonetic || '';
                  }
                }
                console.log(`[Batch] Dictionary lookup success for "${item.word}": phonetic=${phonetic || 'none'}, definition=${enDefinition ? 'found' : 'none'}`);
              } else {
                console.log(`[Batch] Dictionary returned empty entry for "${item.word}"`);
              }
            } catch (dictErr) {
              console.log(`[Batch] Dictionary API failed for "${item.word}": ${dictErr.message}`);
            }
          }

          // 2. 获取中文翻译
          const result = await translateWord(item.word, { userLabel, persist: !isDryRun(dry_run) });

          console.log(`[Batch Translation] (${i + 1}/${items.length}) Translation result for "${item.word}":`, result.translation, 'needsReview:', result.needsReview);

          // Low-confidence translations remain review/noindex after curation.
          const isValidTranslation = result.translation &&
            !result.translation.startsWith('[待翻译]') &&
            result.translation.toLowerCase() !== item.word.toLowerCase();

          if (isValidTranslation) {
            const curated = await curateLegacyWrite({
              admin,
              dryRun: dry_run,
              id: item.id,
              word: item.word,
              candidate: {
                ...(phonetic ? { phonetic } : {}),
                ...(enDefinition ? { definitions: { en: enDefinition, zh: result.translation } } : { zh: result.translation }),
              },
              source: result.source || 'translation_service',
              reviewed,
              metadata: { path: pathname, score: result.score ?? null },
            });
            if (curated.batch_id) batchIds.push(curated.batch_id);

            if (isDryRun(dry_run) || curated.applied > 0) {
              successCount++;
              console.log(`[Batch Translation] (${i + 1}/${items.length}) ✓ ${item.word} [${phonetic || 'no phonetic'}] -> EN: ${enDefinition ? enDefinition.substring(0, 50) + '...' : 'kept existing'} / ZH: ${result.translation}`);
            } else {
              failCount++;
              console.log(`[Batch Translation] (${i + 1}/${items.length}) ✗ ${item.word} - UPDATE matched 0 rows (id: ${item.id})`);
            }
          } else {
            failCount++;
            console.log(`[Batch Translation] (${i + 1}/${items.length}) ✗ ${item.word} - Translation failed or is placeholder: "${result.translation}"`);
          }

          // 【速率控制】更长的延迟以避免API限流
          // 使用1500ms延迟，更保守但可靠（每秒最多0.6个请求）
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (err) {
          console.error(`[Batch Translation] (${i + 1}/${items.length}) ✗ ${item.word} - Error:`, err.message);
          failCount++;

          // 如果遇到速率限制错误，增加额外延迟
          if (err.message && err.message.includes('429')) {
            console.log('[Batch Translation] Rate limit detected, adding extra 5s delay');
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      }

      console.log(`[Batch Translation] Completed: ${successCount} success, ${failCount} failed`);

      return sendJson(res, 200, {
        success: true,
        dry_run: isDryRun(dry_run),
        batch_ids: batchIds,
        processed: items.length,
        successCount,
        failCount
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/translations/update
  if (pathname === '/admin/translations/update' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { lemma, translation, dry_run = false, reviewed = true, source = 'manual' } = await parseBody(req);

      if (!lemma || translation === undefined) {
        return sendError(res, 400, '缺少 lemma 或 translation 参数');
      }

      const curated = await curateLegacyWrite({
        admin, dryRun: dry_run, word: lemma, candidate: { zh: translation }, source, reviewed,
        metadata: { path: pathname },
      });

      return sendJson(res, 200, {
        success: true,
        lemma,
        translation,
        updated_count: curated.applied || 0,
        dry_run: isDryRun(dry_run),
        ...curationResponse(curated),
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/translations/delete
  if (pathname === '/admin/translations/delete' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { lemma } = await parseBody(req);

      if (!lemma) {
        return sendError(res, 400, '缺少 lemma 参数');
      }

      // 从全局 words 表删除（会级联删除所有用户的 user_vocabulary 记录）
      // ⚠️ 注意：这会影响所有用户！
      const curated = await curateLegacyWrite({ admin, word: lemma, action: 'delete', source: 'manual', reviewed: true, metadata: { path: pathname } });

      return sendJson(res, 200, {
        success: true,
        lemma,
        deleted_count: curated.deleted || curated.applied || 0,
        ...curationResponse(curated),
        warning: '已从全局词库删除，所有用户的该词汇关联也已删除'
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/translations/export
  // 导出缺失翻译的词汇到CSV
  if (pathname === '/admin/translations/export' && req.method === 'GET') {
    try {
      await requireAdmin(req);

      // 查询所有缺失翻译的词汇
      const { rows: items } = await dataStore.pool.query(`
        SELECT
          w.word as lemma,
          w.phonetic,
          COALESCE(w.definitions->>'en', '') as english_definition,
          COALESCE(w.definitions->>'zh', '[待翻译]') as translation,
          w.lookup_count as user_count
        FROM words w
        WHERE (
          w.definitions IS NULL
          OR w.definitions::text LIKE '%[待翻译]%'
          OR NOT (w.definitions ? 'zh')
        )
        ORDER BY w.lookup_count DESC NULLS LAST, w.word
      `);

      console.log(`[Admin Export] Exporting ${items.length} items to CSV`);

      // 生成CSV内容
      const csvRows = [];

      // CSV表头（只导出词汇和中文翻译两列）
      csvRows.push('词汇,中文翻译');

      // CSV数据行
      for (const item of items) {
        const lemma = escapeCsvField(item.lemma || '');
        const zhTrans = escapeCsvField(item.translation === '[待翻译]' ? '' : item.translation);

        csvRows.push(`${lemma},${zhTrans}`);
      }

      const csvContent = csvRows.join('\n');

      // 设置响应头
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="translations-${new Date().toISOString().split('T')[0]}.csv"`
      });

      // 添加UTF-8 BOM以确保Excel正确显示中文
      res.end('\uFEFF' + csvContent);

    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/translations/export-csv
  // 导出词汇+多释义+例句（原文与翻译）为 CSV（便于人工翻译/再导入）
  if (pathname === '/admin/translations/export-csv' && req.method === 'GET') {
    try {
      await requireAdmin(req);

      console.log('[Admin Export CSV] start exporting...');

      // 获取URL参数
      const limitWords = parseInt(url.searchParams.get('limit') || '200');
      const onlyMissing = url.searchParams.get('only_missing') === 'true';

      // 词汇定义查询
      let wordsQuery = `
        SELECT word, phonetic, definitions, lookup_count
        FROM words
      `;

      // 如果只导出缺失翻译的词汇
      if (onlyMissing) {
        wordsQuery += `
        WHERE (
          definitions IS NULL
          OR definitions::text LIKE '%[待翻译]%'
          OR NOT (definitions ? 'zh')
          OR (definitions->>'zh' = '')
        )
        `;
      }

      wordsQuery += `
        ORDER BY lookup_count DESC NULLS LAST, word
        LIMIT $1
      `;

      const { rows: wordsRows } = await dataStore.pool.query(wordsQuery, [limitWords]);
      console.log(`[Admin Export CSV] words rows: ${wordsRows.length} (only_missing: ${onlyMissing}, limit: ${limitWords})`);

      // 字幕句子（热门视频，限制 200 个视频）
      const { rows: transcriptRows } = await dataStore.pool.query(`
        SELECT id, transcript_segments
        FROM video_resources
        WHERE transcript_segments IS NOT NULL
        ORDER BY view_count DESC NULLS LAST, id DESC
        LIMIT 200
      `);
      console.log(`[Admin Export CSV] video rows: ${transcriptRows.length}`);

      const csvRows = [];
      // 增加结构化列，避免覆盖：pos/meaning_index/def_index/example_index
      csvRows.push('type,word_or_sentence,phonetic,en_text,zh_text,video_id,seg_index,pos,meaning_index,def_index,example_index');
      // 示例行，便于人工翻译对照
      csvRows.push([
        'word_def',
        'seen',
        '/siːn/',
        '(stative) To perceive or detect with the eyes, or as if by sight.',
        '（静态）用眼睛感知或检测，或仿佛用视觉感知或检测',
        '',
        '',
        'verb',
        0,
        0,
        ''
      ].map(escapeCsvField).join(','));

      // Word definitions（优先使用数据库已有的完整definitions，缺失时才从字典补齐）
      const dictionary = require('../../services/dictionary');
      for (const r of wordsRows) {
        let defJson = r.definitions;
        if (typeof defJson === 'string') {
          try { defJson = JSON.parse(defJson); } catch (_) { defJson = {}; }
        }
        let meanings = Array.isArray(defJson?.meanings) ? defJson.meanings : [];
        let phonetic = r.phonetic || '';
        const zhSummary = (defJson?.zh || '').toString().replace(/\r?\n/g, ' ').trim();

        // 只有当数据库没有 meanings 时，才从字典API获取（避免覆盖已有的中文翻译）
        if (!meanings || meanings.length === 0) {
          try {
            const dict = await dictionary.lookup(r.word, { allowCommon: true });
            if (dict?.entry?.meanings && Array.isArray(dict.entry.meanings) && dict.entry.meanings.length) {
              meanings = dict.entry.meanings;
            }
            if (!phonetic) {
              phonetic = dict?.entry?.phonetic || '';
              if (!phonetic && Array.isArray(dict?.entry?.phonetics)) {
                const p = dict.entry.phonetics.find(p => p && (p.text || p.phonetic));
                phonetic = p?.text || p?.phonetic || '';
              }
            }
          } catch (err) {
            // 字典失败则用数据库已有数据
          }
        }

        meanings.forEach((m, mIdx) => {
          const pos = m?.partOfSpeech || '';
          const defs = Array.isArray(m?.definitions) ? m.definitions : [];
          defs.forEach((d, dIdx) => {
            const en = (d?.definition || '').toString().replace(/\r?\n/g, ' ').trim();
            const zh = (d?.zh || '').toString().replace(/\r?\n/g, ' ').trim();
            csvRows.push([
              escapeCsvField('word_def'),
              escapeCsvField(r.word),
              escapeCsvField(phonetic || ''),
              escapeCsvField(en),
              escapeCsvField(zh),
              '', '', // video_id, seg_index
              escapeCsvField(pos),
              mIdx,
              dIdx,
              '' // example_index
            ].join(','));

            // 例句（如果有）
            const examples = Array.isArray(d?.examples) ? d.examples : (d?.example ? [d.example] : []);
            examples.forEach((ex, exIdx) => {
              const exZh = (Array.isArray(d?.examplesZh) ? d.examplesZh[exIdx] : '').toString().replace(/\r?\n/g, ' ').trim();
              csvRows.push([
                escapeCsvField('word_example'),
                escapeCsvField(r.word),
                escapeCsvField(phonetic || ''),
                escapeCsvField(ex.toString().replace(/\r?\n/g, ' ').trim()),
                escapeCsvField(exZh),
                '', '',
                escapeCsvField(pos),
                mIdx,
                dIdx,
                exIdx
              ].join(','));
            });
          });
        });

        // 若缺少 meanings，仍导出一行占位，便于人工补齐
        if (!meanings.length) {
          csvRows.push([
            escapeCsvField('word_def'),
            escapeCsvField(r.word),
            escapeCsvField(phonetic || ''),
            '',                              // en_text 留空待人工填
            escapeCsvField(zhSummary || ''), // 已有的中文汇总
            '', '',
            '',  // pos
            0,   // meaning_index
            0,   // def_index
            ''   // example_index
          ].join(','));
        }
      }

      // Transcript sentences
      for (const v of transcriptRows) {
        let segs = v.transcript_segments;
        if (typeof segs === 'string') {
          try { segs = JSON.parse(segs); } catch (_) { segs = []; }
        }
        if (!Array.isArray(segs)) continue;
        segs.forEach((seg, idx) => {
          const en = String(seg.text || '').replace(/\r?\n/g, ' ').trim();
          const zh = String(seg.translation || '').replace(/\r?\n/g, ' ').trim();
          if (!en) return;
          csvRows.push([
            escapeCsvField('sentence'),
            escapeCsvField(en),
            '',
            escapeCsvField(en),
            escapeCsvField(zh),
            escapeCsvField(v.id),
            idx,
            '',
            '',
            '',
            ''
          ].join(','));
        });
      }

      const csvContent = csvRows.join('\n');
      console.log(`[Admin Export CSV] total rows (including header): ${csvRows.length}`);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="translations-export-${new Date().toISOString().split('T')[0]}.csv"`
      });
      res.end('\uFEFF' + csvContent);
      console.log('[Admin Export CSV] done.');
      return true;
    } catch (err) {
      console.error('[Admin Export CSV] Error:', err);
      const status = err.status || mapErrorToStatus(err, 500);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/translations/export-words-csv
  // Export all words with phonetic + zh translation (lightweight, for IPA audit).
  if (pathname === '/admin/translations/export-words-csv' && req.method === 'GET') {
    try {
      await requireAdmin(req);

      const batchSize = Math.max(200, Math.min(20000, parseInt(url.searchParams.get('batch') || '5000', 10)));
      const limitParam = url.searchParams.get('limit');
      const hardLimit = limitParam ? Math.max(0, parseInt(limitParam, 10) || 0) : 0; // 0 = no limit

      const today = new Date().toISOString().split('T')[0];
      res.disableCompression = true;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="words-all-${today}.csv"`,
      });
      // UTF-8 BOM (Excel-friendly)
      res.write('\uFEFF');

      res.write('word,phonetic,zh\n');

      let lastId = 0;
      let exported = 0;

      while (true) {
        const remaining = hardLimit > 0 ? Math.max(0, hardLimit - exported) : batchSize;
        const take = hardLimit > 0 ? Math.min(batchSize, remaining) : batchSize;
        if (hardLimit > 0 && take <= 0) break;

        const { rows } = await dataStore.pool.query(
          `
            SELECT
              id,
              word,
              phonetic,
              CASE
                WHEN definitions IS NULL THEN ''
                WHEN COALESCE(definitions->>'zh', '') LIKE '[待翻译]%' THEN ''
                ELSE COALESCE(definitions->>'zh', '')
              END AS zh
            FROM words
            WHERE id > $1
            ORDER BY id ASC
            LIMIT $2
          `,
          [lastId, take]
        );

        if (!rows.length) break;

        for (const r of rows) {
          res.write([
            escapeCsvField(r.word || ''),
            escapeCsvField(r.phonetic || ''),
            escapeCsvField(r.zh || ''),
          ].join(',') + '\n');
          lastId = r.id;
          exported++;
          if (hardLimit > 0 && exported >= hardLimit) break;
        }

        if (hardLimit > 0 && exported >= hardLimit) break;
      }

      res.end();
      return true;
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message || '导出失败');
    }
  }

  // POST /admin/translations/import-words-csv
  // Import lightweight 3-column CSV/TSV: word,phonetic,zh
  // - Only updates non-empty phonetic/zh (won't blank existing values)
  // - By default, non-empty values from file overwrite existing (including non-empty existing values)
  //   You can disable overwrite by passing { overwriteExisting: false } to only fill missing fields.
  // - If word doesn't exist, inserts it into global words table
  if (pathname === '/admin/translations/import-words-csv' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const body = await parseBody(req);
      const { csvData } = body || {};
      const overwriteExisting = body?.overwriteExisting !== false;
      const dryRun = isDryRun(body?.dry_run);
      const source = body?.source || 'admin_import';
      const reviewed = body?.reviewed === true;

      if (!csvData) {
        return sendError(res, 400, '缺少 csvData 参数');
      }

      const raw = String(csvData).replace(/^\uFEFF/, '').trim();
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

      if (lines.length < 1) {
        return sendError(res, 400, 'CSV文件为空或格式错误（至少需要1行数据）');
      }

      // Detect delimiter from a small sample of lines instead of header only.
      const delimiter = detectDelimiter(lines.slice(0, Math.min(lines.length, 20)));

      const firstLine = lines[0].replace(/^\uFEFF/, '');
      const firstFields = parseDelimitedLine(firstLine, delimiter).map(v => String(v || '').trim());
      const firstFieldsLower = firstFields.map(v => v.toLowerCase());

      const looksLikeHeader = firstFieldsLower.includes('word') || firstFieldsLower.includes('lemma');
      if (looksLikeHeader && lines.length < 2) {
        return sendError(res, 400, 'CSV/TSV只有表头，没有数据行');
      }

      const idxWord = looksLikeHeader
        ? (firstFieldsLower.indexOf('word') >= 0 ? firstFieldsLower.indexOf('word') : firstFieldsLower.indexOf('lemma'))
        : 0;
      const idxPhonetic = looksLikeHeader ? firstFieldsLower.indexOf('phonetic') : 1;
      const idxZh = looksLikeHeader
        ? (firstFieldsLower.indexOf('zh') >= 0 ? firstFieldsLower.indexOf('zh') : firstFieldsLower.indexOf('translation'))
        : 2;

      if (looksLikeHeader) {
        if (idxWord < 0) {
          return sendError(res, 400, 'CSV表头缺少 word 列（需要：word,phonetic,zh）');
        }
        if (idxPhonetic < 0 && idxZh < 0) {
          return sendError(res, 400, 'CSV表头缺少 phonetic/zh 列（需要：word,phonetic,zh）');
        }
      } else {
        // Headerless: require at least word + one of (phonetic/zh).
        if (firstFields.length < 2) {
          return sendError(res, 400, 'CSV/TSV缺少列（需要：word,phonetic,zh；可不带表头）');
        }
      }

      const dataLines = looksLikeHeader ? lines.slice(1) : lines.slice(0);

      const importId = new Date().toISOString();
      console.log(`[Admin Import Words CSV] start=${importId} bytes=${raw.length} lines=${lines.length} delimiter=${delimiter === '\\t' ? 'TSV' : 'CSV'} header=${looksLikeHeader ? 'yes' : 'no'} overwriteExisting=${overwriteExisting}`);

      let processed = 0;
      let inserted = 0;
      let updated = 0;
      let updatedPhonetic = 0;
      let updatedZh = 0;
      let updatedUserVocab = 0;
      let updatedWordCache = 0;
      let skipped = 0;
      let failed = 0;
      const errors = [];
      const batchIds = [];
      const curationResults = [];

      for (let i = 0; i < dataLines.length; i++) {
        const line = dataLines[i];
        if (!line) continue;

        try {
          const fields = parseDelimitedLine(line, delimiter);
          const wordRaw = (fields[idxWord] ?? '').toString().replace(/^\uFEFF/, '').trim();
          const phoneticRaw = idxPhonetic >= 0 ? (fields[idxPhonetic] ?? '').toString().trim() : '';
          const zhRaw = idxZh >= 0 ? (fields[idxZh] ?? '').toString().trim() : '';

          if (!wordRaw) {
            skipped++;
            continue;
          }

          const wordLower = wordRaw.toLowerCase();
          const phonetic = phoneticRaw;
          const zh = (zhRaw && !zhRaw.startsWith('[待翻译]')) ? zhRaw : '';

          const hasPhonetic = !!phonetic;
          const hasZh = !!zh;

          if (!hasPhonetic && !hasZh) {
            skipped++;
            continue;
          }

          const { rows: existingRows } = await dataStore.pool.query(
            `
              SELECT
                id,
                COALESCE(phonetic, '') AS phonetic,
                CASE
                  WHEN definitions IS NULL THEN ''
                  WHEN COALESCE(definitions->>'zh', '') LIKE '[待翻译]%' THEN ''
                  ELSE COALESCE(definitions->>'zh', '')
                END AS zh
              FROM words
              WHERE word_lowercase = $1
              LIMIT 1
            `,
            [wordLower]
          );

          if (existingRows.length > 0) {
            const wordId = existingRows[0].id;
            const existingPhonetic = (existingRows[0].phonetic || '').trim();
            const existingZh = (existingRows[0].zh || '').trim();

            const shouldUpdatePhonetic = hasPhonetic && (overwriteExisting || !existingPhonetic);
            const shouldUpdateZh = hasZh && (overwriteExisting || !existingZh);

            if (!shouldUpdatePhonetic && !shouldUpdateZh) {
              skipped++;
              continue;
            }

            const curated = await curateLegacyWrite({
              admin, dryRun, id: wordId, word: wordLower,
              candidate: { ...(shouldUpdatePhonetic ? { phonetic } : {}), ...(shouldUpdateZh ? { zh } : {}) },
              source, reviewed, metadata: { path: pathname, import_id: importId },
            });
            if (dryRun || curated.applied > 0) {
              updated++;
              if (shouldUpdatePhonetic) updatedPhonetic++;
              if (shouldUpdateZh) updatedZh++;
            }
            if (curated.batch_id) batchIds.push(curated.batch_id);
            curationResults.push(curated);

            const translationAccepted = shouldUpdateZh
              && !dryRun
              && curated.applied > 0
              && !(curated.conflicts || []).some((item) => item.field === 'definitions');
            if (translationAccepted && typeof dataStore.upsertTranslationCache === 'function') {
              try {
                await dataStore.upsertTranslationCache(wordLower, zh, 'admin-import');
                updatedWordCache++;
              } catch (_) { }
            }
            if (translationAccepted) {
              try {
                const { rowCount } = await dataStore.pool.query(
                  `UPDATE user_vocabulary
                   SET translation = $1, updated_at = NOW()
                   WHERE word_id = $2`,
                  [zh, wordId]
                );
                updatedUserVocab += rowCount || 0;
              } catch (_) { }
            }

            processed++;
            continue;
          }

          const curated = await curateLegacyWrite({
            admin, dryRun, word: wordLower,
            candidate: { word: wordRaw, word_lowercase: wordLower, ...(hasPhonetic ? { phonetic } : {}), ...(hasZh ? { zh } : {}) },
            source, reviewed, metadata: { path: pathname, import_id: importId },
          });
          if (curated.batch_id) batchIds.push(curated.batch_id);
          curationResults.push(curated);
          if (dryRun || curated.applied > 0) {
            inserted++;
            if (hasPhonetic) updatedPhonetic++;
            if (hasZh) updatedZh++;
          }

          if (hasZh && !dryRun && curated.applied > 0 && typeof dataStore.upsertTranslationCache === 'function') {
            try {
              await dataStore.upsertTranslationCache(wordLower, zh, 'admin-import');
              updatedWordCache++;
            } catch (_) { }
          }

          // New word has no user_vocabulary rows yet; no sync needed.

          processed++;
        } catch (err) {
          failed++;
          const lineNo = looksLikeHeader ? (i + 2) : (i + 1);
          errors.push(`第 ${lineNo} 行：${err.message}`);
        }
      }

      return sendJson(res, 200, {
        success: true,
        dry_run: dryRun,
        batch_ids: batchIds,
        ...aggregateCurationResponses(curationResults),
        results: {
          total: dataLines.length,
          processed,
          inserted,
          updated,
          updatedPhonetic,
          updatedZh,
          updatedWordCache,
          updatedUserVocab,
          skipped,
          failed,
          delimiter: delimiter === '\t' ? 'TSV' : 'CSV',
        },
        errors: errors.slice(0, 30),
      });
    } catch (err) {
      console.error('[Admin Import Words CSV] Error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message || '导入失败');
    }
  }

  // POST /admin/translations/import
  // 从CSV导入修正后的翻译（简单格式：词汇,中文翻译）
  if (pathname === '/admin/translations/import' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { csvData, dry_run = false, source = 'admin_import', reviewed = false } = await parseBody(req);
      const dryRun = isDryRun(dry_run);

      if (!csvData) {
        return sendError(res, 400, '缺少 csvData 参数');
      }

      console.log(`[Admin Import] Starting CSV import, data length: ${csvData.length}`);

      // 解析CSV
      const lines = csvData.trim().split(/\r?\n/);

      if (lines.length < 2) {
        return sendError(res, 400, 'CSV文件为空或格式错误');
      }

      // 跳过表头
      const dataLines = lines.slice(1);

      let updated = 0;
      let failed = 0;
      const errors = [];
      const batchIds = [];
      const curationResults = [];

      for (let i = 0; i < dataLines.length; i++) {
        const line = dataLines[i].trim();
        if (!line) continue;

        try {
          // 简单的CSV解析（支持引号包裹的字段）
          const fields = parseCsvLine(line);

          if (fields.length < 2) {
            errors.push(`第 ${i + 2} 行：字段数量不足（需要2个字段：词汇,中文翻译）`);
            failed++;
            continue;
          }

          const [lemma, zhTrans] = fields;

          if (!lemma) {
            errors.push(`第 ${i + 2} 行：缺少词汇`);
            failed++;
            continue;
          }

          if (!zhTrans || zhTrans === '[待翻译]') {
            errors.push(`第 ${i + 2} 行：缺少有效的中文翻译`);
            failed++;
            continue;
          }

          const curated = await curateLegacyWrite({
            admin, dryRun, word: lemma, candidate: { zh: zhTrans }, source, reviewed,
            metadata: { path: pathname },
          });
          if (curated.batch_id) batchIds.push(curated.batch_id);
          curationResults.push(curated);

          if (dryRun || curated.applied > 0) {
            updated++;
            console.log(`[Admin Import] Updated "${lemma}" -> "${zhTrans}"`);
          } else {
            errors.push(`第 ${i + 2} 行：未找到词汇 "${lemma}"`);
            failed++;
          }

        } catch (err) {
          errors.push(`第 ${i + 2} 行：${err.message}`);
          failed++;
        }
      }

      console.log(`[Admin Import] Completed: ${updated} updated, ${failed} failed`);

      return sendJson(res, 200, {
        success: true,
        dry_run: dryRun,
        batch_ids: batchIds,
        ...aggregateCurationResponses(curationResults),
        results: {
          total: dataLines.length,
          updated,
          failed
        },
        errors: errors.slice(0, 20) // 最多返回前20个错误
      });

    } catch (err) {
      console.error('[Admin Import] Error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/translations/import-csv
  // 从CSV导入扩展格式（包含词义、例句等详细信息）
  // 格式：type,word_or_sentence,phonetic,en_text,zh_text,video_id,seg_index,pos,meaning_index,def_index,example_index
  if (pathname === '/admin/translations/import-csv' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { csvData, dry_run = false, source = 'admin_import', reviewed = false } = await parseBody(req);
      const dryRun = isDryRun(dry_run);

      if (!csvData) {
        return sendError(res, 400, '缺少 csvData 参数');
      }

      console.log(`[Admin Import CSV] Starting extended CSV import, data length: ${csvData.length}`);

      // 解析CSV
      const lines = csvData.trim().split(/\r?\n/);

      if (lines.length < 2) {
        return sendError(res, 400, 'CSV文件为空或格式错误');
      }

      // 解析表头
      const headerFields = parseCsvLine(lines[0]);
      console.log(`[Admin Import CSV] Header: ${headerFields.join(', ')}`);

      // 创建列索引映射（支持灵活的列顺序和缺失列）
      const colIndex = {};
      headerFields.forEach((header, idx) => {
        colIndex[header.trim()] = idx;
      });

      // 检测CSV格式（支持两种格式）
      const hasFormat1 = colIndex['word_or_sentence'] !== undefined; // 格式1: word_or_sentence, en_text, zh_text
      const hasFormat2 = colIndex['word'] !== undefined && colIndex['definition'] !== undefined; // 格式2: word, definition, cn_definition

      if (!hasFormat1 && !hasFormat2) {
        return sendError(res, 400, 'CSV格式不正确，请使用导出功能生成的CSV格式');
      }

      console.log(`[Admin Import CSV] Detected format: ${hasFormat1 ? 'Format 1 (word_or_sentence)' : 'Format 2 (word/definition)'}`);
      console.log(`[Admin Import CSV] Column mapping:`, colIndex);

      // 跳过表头和示例行
      const dataLines = lines.slice(1).filter(line => {
        const trimmed = line.trim();
        // 跳过空行和示例行（word_def,seen,/siːn/...）
        return trimmed && !trimmed.startsWith('word_def,seen,');
      });

      let updated = 0;
      let failed = 0;
      const errors = [];
      const batchIds = [];
      const curationResults = [];

      // 按word分组处理，构建完整的definitions结构
      const wordMap = new Map(); // word_lowercase -> { word, phonetic, meanings: [] }

      for (let i = 0; i < dataLines.length; i++) {
        const line = dataLines[i].trim();
        if (!line) continue;

        try {
          const fields = parseCsvLine(line);

          // 使用列索引映射提取字段（支持缺失列）
          const getField = (colName) => {
            const idx = colIndex[colName];
            return idx !== undefined && idx < fields.length ? fields[idx] : '';
          };

          // 根据检测到的格式提取字段
          let type, wordOrSentence, phonetic, enText, zhText, videoId, segIndex, pos, meaningIndex, defIndex, exampleIndex;

          if (hasFormat1) {
            // 格式1: word_or_sentence, phonetic, en_text, zh_text, meaning_index, def_index, example_index
            type = getField('type');
            wordOrSentence = getField('word_or_sentence');
            phonetic = getField('phonetic');
            enText = getField('en_text');
            zhText = getField('zh_text');
            videoId = getField('video_id');
            segIndex = getField('seg_index');
            pos = getField('pos');
            meaningIndex = getField('meaning_index');
            defIndex = getField('def_index');
            exampleIndex = getField('example_index');
          } else {
            // 格式2: word, ipa, definition, cn_definition, sense_index, sub_index, example_index
            type = getField('type');
            wordOrSentence = getField('word');
            phonetic = getField('ipa');
            enText = getField('definition');
            zhText = getField('cn_definition');
            videoId = '';
            segIndex = '';
            pos = getField('pos');
            meaningIndex = getField('sense_index');
            defIndex = getField('sub_index');
            exampleIndex = getField('example_index');
          }

          // 跳过句子类型的行（暂不处理）
          if (type === 'sentence') {
            continue;
          }

          // 处理词汇定义和例句
          if (type === 'word_def' || type === 'word_example') {
            if (!wordOrSentence) {
              errors.push(`第 ${i + 2} 行：缺少词汇`);
              failed++;
              continue;
            }

            const wordLower = wordOrSentence.toLowerCase();

            // 初始化词汇条目
            if (!wordMap.has(wordLower)) {
              wordMap.set(wordLower, {
                word: wordOrSentence,
                phonetic: phonetic || '',
                meanings: []
              });
            }

            const wordData = wordMap.get(wordLower);

            // 更新音标（如果当前行有值）
            if (phonetic && !wordData.phonetic) {
              wordData.phonetic = phonetic;
            }

            const mIdx = parseInt(meaningIndex) || 0;
            const dIdx = parseInt(defIndex) || 0;

            // 确保 meanings 数组有足够的元素
            while (wordData.meanings.length <= mIdx) {
              wordData.meanings.push({
                partOfSpeech: '',
                definitions: []
              });
            }

            const meaning = wordData.meanings[mIdx];

            // 设置词性（如果当前行有值）
            if (pos && !meaning.partOfSpeech) {
              meaning.partOfSpeech = pos;
            }

            if (type === 'word_def') {
              // 确保 definitions 数组有足够的元素
              while (meaning.definitions.length <= dIdx) {
                meaning.definitions.push({
                  definition: '',
                  zh: '',
                  examples: [],
                  examplesZh: []
                });
              }

              const def = meaning.definitions[dIdx];

              // 更新英文和中文定义
              if (enText) def.definition = enText;
              if (zhText) def.zh = zhText;

            } else if (type === 'word_example') {
              // 例句
              if (meaning.definitions.length <= dIdx) {
                // 如果定义不存在，创建一个空定义
                while (meaning.definitions.length <= dIdx) {
                  meaning.definitions.push({
                    definition: '',
                    zh: '',
                    examples: [],
                    examplesZh: []
                  });
                }
              }

              const def = meaning.definitions[dIdx];
              const exIdx = parseInt(exampleIndex) || 0;

              // 确保 examples 数组有足够的元素
              while (def.examples.length <= exIdx) {
                def.examples.push('');
                def.examplesZh.push('');
              }

              if (enText) def.examples[exIdx] = enText;
              if (zhText) def.examplesZh[exIdx] = zhText;
            }
          }

        } catch (err) {
          errors.push(`第 ${i + 2} 行：${err.message}`);
          failed++;
        }
      }

      // 批量更新数据库
      console.log(`[Admin Import CSV] Processed ${wordMap.size} unique words, updating database...`);

      for (const [wordLower, wordData] of wordMap.entries()) {
        try {
          // 构建 definitions JSON
          // 保存详细的 meanings 结构，同时为兼容性添加简化的 zh/en 字段
          const definitions = {
            meanings: wordData.meanings
          };

          // 提取第一个定义的中英文，作为简化显示（兼容旧版前端）
          if (wordData.meanings.length > 0 && wordData.meanings[0].definitions.length > 0) {
            const firstDef = wordData.meanings[0].definitions[0];
            definitions.zh = firstDef.zh || '';
            definitions.en = firstDef.definition || '';
          }

          const curated = await curateLegacyWrite({
            admin, dryRun, word: wordLower,
            candidate: { word: wordData.word, word_lowercase: wordLower, phonetic: wordData.phonetic || '', definitions },
            source, reviewed, metadata: { path: pathname },
          });
          if (curated.batch_id) batchIds.push(curated.batch_id);
          curationResults.push(curated);
          const rowCount = dryRun ? 1 : (curated.applied || 0);

          if (rowCount > 0) {
            updated++;
            console.log(`[Admin Import CSV] ✓ Updated "${wordData.word}" with ${wordData.meanings.length} meanings`);
          } else {
            failed++;
            errors.push(`更新词汇 "${wordData.word}" 失败`);
          }

        } catch (err) {
          failed++;
          errors.push(`更新词汇 "${wordData.word}" 失败: ${err.message}`);
          console.error(`[Admin Import CSV] Error updating "${wordData.word}":`, err);
        }
      }

      console.log(`[Admin Import CSV] Completed: ${updated} updated, ${failed} failed`);

      return sendJson(res, 200, {
        success: true,
        dry_run: dryRun,
        batch_ids: batchIds,
        ...aggregateCurationResponses(curationResults),
        results: {
          total: wordMap.size,
          updated,
          failed
        },
        errors: errors.slice(0, 50) // 返回前50个错误
      });

    } catch (err) {
      console.error('[Admin Import CSV] Error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/translations/translate-text
  // 翻译任意文本（词、释义、句子），并写入 translation_cache 供全局复用
  if (pathname === '/admin/translations/translate-text' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { text } = await parseBody(req);
      const clean = (text || '').trim();
      if (!clean) return sendError(res, 400, '缺少 text');

      const { translateWord } = require('../../services/translation.js');
      const userLabel = admin?.username || admin?.email || `admin-${admin?.id || 'unknown'}`;
      const result = await translateWord(clean, { userLabel });

      if (!result?.translation) {
        return sendError(res, 502, '翻译失败');
      }

      return sendJson(res, 200, {
        success: true,
        text: clean,
        translation: result.translation,
        fromCache: !!result.fromCache
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message || '翻译失败');
    }
  }

  // POST /admin/translations/prewarm
  // 自动为高频缺失翻译的词汇预翻译（写入 words 与 translation_cache）
  if (pathname === '/admin/translations/prewarm' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { limit = 200, dry_run = false, source = 'prewarm', reviewed = false } = await parseBody(req);
      const dryRun = isDryRun(dry_run);

      const userLabel = admin?.username || admin?.email || `admin-${admin?.id || 'unknown'}`;
      const { translateWord } = require('../../services/translation.js');
      const dictionary = require('../../services/dictionary');

      // 按 lookup_count 选取缺失 zh 的高频词
      const { rows: items } = await dataStore.pool.query(`
        SELECT id, word, word_lowercase, definitions, phonetic
        FROM words
        WHERE (
          definitions IS NULL
          OR definitions::text LIKE '%[待翻译]%'
          OR NOT (definitions ? 'zh')
        )
        ORDER BY lookup_count DESC NULLS LAST, word
        LIMIT $1
      `, [limit]);

      let successCount = 0;
      let failCount = 0;
      const batchIds = [];

      for (const item of items) {
        try {
          // 1) 翻译单词（写缓存 + 返回译文）
          const tr = await translateWord(item.word, { userLabel, persist: !dryRun });
          const zh = tr?.translation;
          if (!zh || zh.toLowerCase() === item.word_lowercase) {
            failCount++;
            continue;
          }

          // 2) 尝试获取英文定义以补全（可选）
          let enDefinition = item.definitions?.en || '';
          let phonetic = item.phonetic || '';
          if (!enDefinition || !phonetic) {
            try {
              const dictResult = await dictionary.lookup(item.word, { persist: !dryRun });
              if (dictResult?.entry) {
                if (!enDefinition && dictResult.entry.meanings?.[0]?.definitions?.[0]?.definition) {
                  enDefinition = dictResult.entry.meanings[0].definitions[0].definition;
                }
                if (!phonetic) {
                  phonetic = dictResult.entry.phonetic || '';
                  if (!phonetic && Array.isArray(dictResult.entry.phonetics)) {
                    const p = dictResult.entry.phonetics.find(p => p && (p.text || p.phonetic));
                    phonetic = p?.text || p?.phonetic || '';
                  }
                }
              }
            } catch (_) { /* ignore */ }
          }

          const curated = await curateLegacyWrite({
            admin, dryRun, id: item.id, word: item.word_lowercase,
            candidate: {
              ...(phonetic ? { phonetic } : {}),
              ...(enDefinition ? { definitions: { en: enDefinition, zh } } : { zh }),
            },
            source: tr.source || source,
            reviewed,
            metadata: { path: pathname, score: tr.score ?? null },
          });
          if (curated.batch_id) batchIds.push(curated.batch_id);

          successCount++;
        } catch (err) {
          failCount++;
          console.warn('[Admin Prewarm] Failed for', item.word, err.message || err);
        }
      }

      return sendJson(res, 200, {
        success: true,
        dry_run: dryRun,
        batch_ids: batchIds,
        stats: {
          total: items.length,
          success: successCount,
          failed: failCount
        }
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message || '预翻译失败');
    }
  }

  // GET /admin/translations/rate-limiter-status
  // 查看翻译服务速率限制器状态
  if (pathname === '/admin/translations/rate-limiter-status' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const rateLimiter = require('../../services/translation/rate-limiter');
      const status = rateLimiter.getStatus();

      return sendJson(res, 200, {
        success: true,
        status
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/translations/prewarm-transcripts
  // 从最热视频的字幕片段预翻译句子，缓存到 translation_cache
  if (pathname === '/admin/translations/prewarm-transcripts' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { videoLimit = 30, segmentLimitPerVideo = 200 } = await parseBody(req);
      const userLabel = admin?.username || admin?.email || `admin-${admin?.id || 'unknown'}`;
      const { translateWord } = require('../../services/translation.js');

      const { rows: videos } = await dataStore.pool.query(`
        SELECT id, title, transcript_segments
        FROM video_resources
        WHERE transcript_segments IS NOT NULL
        ORDER BY view_count DESC NULLS LAST, id DESC
        LIMIT $1
      `, [videoLimit]);

      let totalSegments = 0;
      let successCount = 0;
      let failCount = 0;

      for (const v of videos) {
        let segs = v.transcript_segments;
        if (typeof segs === 'string') {
          try { segs = JSON.parse(segs); } catch (_) { segs = []; }
        }
        if (!Array.isArray(segs) || segs.length === 0) continue;
        const list = segs.slice(0, segmentLimitPerVideo);
        for (const seg of list) {
          const text = String(seg.text || '').trim();
          if (!text || text.length < 3) continue;
          // Skip if already cached (best-effort)
          try {
            const res = await dataStore.pool.query(
              'SELECT 1 FROM translation_cache WHERE word = $1 LIMIT 1',
              [text.toLowerCase()]
            );
            if (res.rows.length > 0) continue;
          } catch (_) { }
          totalSegments++;
          try {
            await translateWord(text, { userLabel });
            successCount++;
          } catch (_) {
            failCount++;
          }
        }
      }

      return sendJson(res, 200, {
        success: true,
        stats: { videos: videos.length, totalSegments, success: successCount, failed: failCount }
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message || '字幕预翻译失败');
    }
  }

  // Route not handled
  return false;
}

/**
 * Escape CSV field value
 */
function escapeCsvField(value) {
  if (value == null) return '';
  const str = String(value);

  // 如果包含逗号、引号或换行符，需要用引号包裹并转义内部引号
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }

  return str;
}

/**
 * Parse a CSV line (handles quoted fields)
 */
function parseCsvLine(line) {
  const fields = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // 转义的引号
        currentField += '"';
        i++; // 跳过下一个引号
      } else {
        // 切换引号状态
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // 字段分隔符
      fields.push(currentField);
      currentField = '';
    } else {
      currentField += char;
    }
  }

  // 添加最后一个字段
  fields.push(currentField);

  return fields;
}

function detectDelimiter(sample) {
  const lines = Array.isArray(sample) ? sample : [String(sample || '')];
  let tabCount = 0;
  let commaCount = 0;
  for (const line of lines) {
    const s = String(line || '');
    tabCount += (s.match(/\t/g) || []).length;
    commaCount += (s.match(/,/g) || []).length;
  }
  if (tabCount > 0 && tabCount >= commaCount) return '\t';
  return ',';
}

function parseDelimitedLine(line, delimiter) {
  if (delimiter === '\t') {
    // TSV: keep it simple; Excel-exported TSV typically doesn't use quoted fields
    return String(line || '').split('\t');
  }
  return parseCsvLine(String(line || ''));
}

/**
 * Register and handle admin words management routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - URL object for query parameters
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerAdminWordsRoutes(pathname, req, res, url) {
  // GET /admin/words/schema - Get words table schema (for AI/automation)
  if (pathname === '/admin/words/schema' && req.method === 'GET') {
    try {
      await requireAdmin(req);
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
      return sendJson(res, 200, {
        success: true,
        table: 'words',
        columns: rows || [],
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

  // GET /admin/words/item - Get a single word by id or word text
  if (pathname === '/admin/words/item' && req.method === 'GET') {
    try {
      await requireAdmin(req);
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
      const defs = row.definitions || null;
      const zh = defs && typeof defs === 'object' ? (defs.zh || '') : '';

      return sendJson(res, 200, {
        success: true,
        item: {
          ...row,
          translation_zh: zh && !String(zh).startsWith('[待翻译]') ? zh : '',
          quality_reasons: q.reasons,
        }
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/words/batch-apply - Batch update/delete words (supports dry-run preview)
  // Body:
  // {
  //   dry_run: true|false,
  //   operations: [
  //     { id: 123, action: "update", word?: "Apple", phonetic?: "...", part_of_speech?: "noun", zh?: "苹果" },
  //     { id: 456, action: "delete" }
  //   ]
  // }
  if (pathname === '/admin/words/batch-apply' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const body = await parseBody(req);
      const dryRun = isDryRun(body.dry_run);
      const operations = Array.isArray(body.operations) ? body.operations : [];
      if (!operations.length) return sendError(res, 400, 'operations is required');
      if (operations.length > 500) return sendError(res, 400, 'Too many operations (max 500)');

      const curatedResults = new Array(operations.length);
      const batchIds = new Set();
      let curatedUpdated = 0;
      let curatedDeleted = 0;
      let curatedUserVocabUpdated = 0;
      let curatedUserVocabDeleted = 0;
      const prepared = [];
      for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
        const op = operations[operationIndex];
        const id = Number(op?.id);
        const action = String(op?.action || 'update').toLowerCase();
        if (!Number.isInteger(id) || id <= 0 || !['update', 'delete'].includes(action)) {
          curatedResults[operationIndex] = { success: false, id: op?.id, error: 'Invalid operation' };
          continue;
        }
        if (action === 'update' && Object.hasOwn(op, 'definitions')
            && op.definitions !== null
            && (!op.definitions || typeof op.definitions !== 'object' || Array.isArray(op.definitions))) {
          curatedResults[operationIndex] = { success: false, id, action, error: 'definitions must be an object or null' };
          continue;
        }
        const candidate = Object.fromEntries(Object.entries(op).filter(([key]) => !['id', 'action'].includes(key)));
        prepared.push({ operationIndex, id, action, write: {
          id, action: action === 'update' ? 'upsert' : 'delete', candidate,
          source: body.source || 'manual', reviewed: body.reviewed === true,
          metadata: { path: pathname },
        } });
      }
      const validatedPrepared = [];
      for (const item of prepared) {
        try {
          const preview = await curation.preview({ write: item.write, actor: { type: 'admin', id: admin?.id } });
          if (preview.status === 'missing') {
            curatedResults[item.operationIndex] = { success: false, id: item.id, action: item.action, error: 'Word not found' };
            continue;
          }
          validatedPrepared.push({ ...item, preview });
        } catch (error) {
          curatedResults[item.operationIndex] = { success: false, id: item.id, action: item.action, error: error.message };
        }
      }
      const appliedResults = validatedPrepared.length === 0
        ? []
        : dryRun
          ? validatedPrepared.map(({ preview }) => preview)
          : (await curation.applyBatch({ writes: validatedPrepared.map(({ write }) => write), actor: { type: 'admin', id: admin?.id } })).results;
      for (let index = 0; index < validatedPrepared.length; index++) {
        const { operationIndex, id, action } = validatedPrepared[index];
        const result = appliedResults[index];
        if (result.batch_id) batchIds.add(result.batch_id);
        if (!dryRun && action === 'update') curatedUpdated += result.applied || 0;
        if (!dryRun && action === 'delete') curatedDeleted += result.deleted || result.applied || 0;
        curatedUserVocabUpdated += result.user_vocabulary_updated || 0;
        curatedUserVocabDeleted += result.user_vocabulary_deleted || 0;
        curatedResults[operationIndex] = {
          success: true,
          id,
          action,
          before: result.before,
          after: result.after,
          ...(action === 'delete'
            ? dryRun
              ? { wouldDeleteUserVocab: true }
              : {
                  deleted: result.deleted || result.applied || 0,
                  userVocabDeleted: result.user_vocabulary_deleted || 0,
                  soft_deleted: true,
                }
            : {}),
          ...curationResponse(result),
        };
      }
      return sendJson(res, 200, {
        success: true,
        dry_run: dryRun,
        summary: { updated: curatedUpdated, deleted: curatedDeleted, userVocabUpdated: curatedUserVocabUpdated, userVocabDeleted: curatedUserVocabDeleted },
        results: curatedResults,
        batch_ids: [...batchIds],
      });

    } catch (err) {
      console.error('[Admin Words] Batch apply error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/words/low-quality - List low-quality words (candidate cleanup)
  if (pathname === '/admin/words/low-quality' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
      const offset = Number(url.searchParams.get('offset')) || 0;
      const onlyUnused = (url.searchParams.get('only_unused') || '1') !== '0';

      const where = [];
      const params = [];

      // SQL prefilter: keep it fast, then compute detailed reasons in JS
      where.push(`(
        (LENGTH(word_lowercase) >= 8 AND word_lowercase ~ '([a-z])\\1\\1\\1') OR
        (word_lowercase ~ '[0-9]') OR
        (word_lowercase ~ '[^a-z\\-\\']') OR
        (LENGTH(word_lowercase) > 45) OR
        ((LENGTH(word_lowercase) = 1) AND word_lowercase NOT IN ('a','i')) OR
        ((LENGTH(word_lowercase) >= 7) AND word_lowercase !~ '[aeiouy]')
      )`);

      if (onlyUnused) {
        where.push(`COALESCE(learned_by_count, 0) = 0`);
      }

      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const countQuery = `SELECT COUNT(*)::int AS total FROM words ${whereClause}`;
      const { rows: countRows } = await dataStore.pool.query(countQuery, params);
      const totalCount = countRows?.[0]?.total || 0;

      const itemsQuery = `
        SELECT
          id,
          word,
          word_lowercase,
          phonetic,
          part_of_speech,
          definitions,
          lookup_count,
          learned_by_count,
          created_at,
          updated_at
        FROM words
        ${whereClause}
        ORDER BY COALESCE(learned_by_count, 0) ASC, COALESCE(lookup_count, 0) ASC, id DESC
        LIMIT $1 OFFSET $2
      `;
      const { rows } = await dataStore.pool.query(itemsQuery, [limit, offset]);

      const items = (rows || []).map(r => {
        const q = analyzeWordQuality(r.word);
        return {
          ...r,
          quality_reasons: q.reasons,
        };
      }).filter(r => Array.isArray(r.quality_reasons) && r.quality_reasons.length);

      return sendJson(res, 200, { items, totalCount, limit, offset, onlyUnused });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/words/batch-delete - Batch delete words (and user_vocabulary)
  if (pathname === '/admin/words/batch-delete' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const body = await parseBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const safeIds = Array.from(new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))).slice(0, 1000);
      if (!safeIds.length) return sendError(res, 400, '缺少 ids');

      const batch = await curation.applyBatch({
        writes: safeIds.map((id) => ({
          id, action: 'delete', source: 'manual', reviewed: true, metadata: { path: pathname },
        })),
        actor: { type: 'admin', id: admin?.id },
      });
      let wordsDeleted = 0;
      let uvDeleted = 0;
      for (const curated of batch.results) {
        wordsDeleted += curated.deleted || curated.applied || 0;
        uvDeleted += curated.user_vocabulary_deleted || 0;
      }
      return sendJson(res, 200, {
        success: true,
        deleted: wordsDeleted,
        userVocabDeleted: uvDeleted,
        soft_deleted: true,
        note: '词汇已停用并从用户词库移除，可回滚恢复',
        batch_id: batch.batch_id,
        ...aggregateCurationResponses(batch.results),
      });
    } catch (err) {
      console.error('[Admin Words] Batch delete error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/words - List all words with pagination, search, and filters
  if (pathname === '/admin/words' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
      const offset = Number(url.searchParams.get('offset')) || 0;
      const search = (url.searchParams.get('search') || '').trim();
      const filterPhonetic = (url.searchParams.get('filter_phonetic') || '').trim(); // 'has', 'missing', ''
      const filterZh = (url.searchParams.get('filter_zh') || '').trim(); // 'has', 'missing', ''
      // 黑名单筛选
      const onlyBlacklisted = (url.searchParams.get('only_blacklisted') || '') === '1';
      const includeBlacklisted = (url.searchParams.get('include_blacklisted') || '') === '1';

      const whereClauses = [];
      const params = [];

      if (search) {
        params.push(`%${search.toLowerCase()}%`);
        whereClauses.push(`word_lowercase LIKE $${params.length}`);
      }

      // Filter by phonetic
      if (filterPhonetic === 'has') {
        whereClauses.push(`(phonetic IS NOT NULL AND phonetic != '')`);
      } else if (filterPhonetic === 'missing') {
        whereClauses.push(`(phonetic IS NULL OR phonetic = '')`);
      }

      // Filter by Chinese translation
      if (filterZh === 'has') {
        whereClauses.push(`(definitions IS NOT NULL AND definitions->>'zh' IS NOT NULL AND definitions->>'zh' != '' AND definitions->>'zh' NOT LIKE '[待翻译]%')`);
      } else if (filterZh === 'missing') {
        whereClauses.push(`(definitions IS NULL OR definitions->>'zh' IS NULL OR definitions->>'zh' = '' OR definitions->>'zh' LIKE '[待翻译]%')`);
      }

      // 黑名单过滤
      if (onlyBlacklisted) {
        whereClauses.push(`is_blacklisted = TRUE`);
      } else if (!includeBlacklisted) {
        whereClauses.push(`(is_blacklisted = FALSE OR is_blacklisted IS NULL)`);
      }

      const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      // Get total count
      const countQuery = `SELECT COUNT(*) as total FROM words ${whereClause}`;
      const { rows: [{ total }] } = await dataStore.pool.query(countQuery, params);

      // Get items with sorting: exact match first, then starts with, then contains
      let orderClause;
      if (search) {
        const searchLower = search.toLowerCase();
        orderClause = `
          ORDER BY
            CASE
              WHEN word_lowercase = $${params.length + 1} THEN 0
              WHEN word_lowercase LIKE $${params.length + 2} THEN 1
              ELSE 2
            END,
            LENGTH(word_lowercase) ASC,
            word_lowercase ASC
        `;
        params.push(searchLower, `${searchLower}%`);
      } else {
        orderClause = `ORDER BY id DESC`;
      }

      const limitOffset = `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const itemsQuery = `
        SELECT
          id,
          word,
          word_lowercase,
          phonetic,
          part_of_speech,
          definitions,
          frequency_rank,
          lookup_count,
          learned_by_count,
          is_blacklisted,
          blacklisted_at,
          blacklist_reason,
          created_at,
          updated_at
        FROM words
        ${whereClause}
        ${orderClause}
        ${limitOffset}
      `;

      const { rows: items } = await dataStore.pool.query(itemsQuery, params);

      return sendJson(res, 200, {
        items,
        totalCount: Number(total),
        limit,
        offset
      });

    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/words/add - Add a new word
  if (pathname === '/admin/words/add' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { word, phonetic, zh, part_of_speech, dry_run = false, reviewed = false, source = 'manual' } = await parseBody(req);

      if (!word || !word.trim()) {
        return sendError(res, 400, '词汇不能为空');
      }

      const wordLower = word.trim().toLowerCase();
      const wordClean = word.trim();

      const q = analyzeWordQuality(wordClean);
      if (!q.ok) {
        return sendError(res, 400, `低质量/无效词汇，已拒绝添加：${q.reasons.join(',')}`);
      }

      const curated = await curateLegacyWrite({
        admin, dryRun: dry_run, word: wordLower,
        candidate: { word: wordClean, word_lowercase: wordLower, ...(phonetic !== undefined ? { phonetic } : {}), ...(zh !== undefined ? { zh } : {}), ...(part_of_speech !== undefined ? { part_of_speech } : {}) },
        source, reviewed, create_only: true, metadata: { path: pathname },
      });
      if (curated.status === 'exists') {
        return sendError(res, 400, `词汇 "${wordClean}" 已存在 (ID: ${curated.after?.id || 'unknown'})`);
      }
      const newWord = curated.after;

      if (!newWord) throw new Error('CURATION_RESULT_MISSING_WORD');

      console.log(`[Admin Words] Added word: "${wordClean}" (ID: ${newWord.id})`);

      return sendJson(res, 200, {
        success: true,
        word: newWord,
        dry_run: isDryRun(dry_run),
        ...curationResponse(curated),
      });

    } catch (err) {
      console.error('[Admin Words] Add error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/words/update - Update a word
  if (pathname === '/admin/words/update' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { id, phonetic, zh, part_of_speech, dry_run = false, reviewed = false, source = 'manual' } = await parseBody(req);

      if (!id) {
        return sendError(res, 400, '缺少词汇 ID');
      }

      const curated = await curateLegacyWrite({
        admin, dryRun: dry_run, id,
        candidate: { ...(phonetic !== undefined ? { phonetic } : {}), ...(zh !== undefined ? { zh } : {}), ...(part_of_speech !== undefined ? { part_of_speech } : {}) },
        source, reviewed, metadata: { path: pathname },
      });

      return sendJson(res, 200, {
        success: true,
        updated: curated.applied || 0,
        dry_run: isDryRun(dry_run),
        ...curationResponse(curated),
      });

    } catch (err) {
      console.error('[Admin Words] Update error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/words/delete - Delete a word (soft delete: mark as blacklisted)
  if (pathname === '/admin/words/delete' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { id } = await parseBody(req);

      if (!id) {
        return sendError(res, 400, '缺少词汇 ID');
      }

      const curated = await curateLegacyWrite({
        admin, id, action: 'blacklist', source: 'manual', reviewed: true, metadata: { path: pathname },
      });

      console.log(`[Admin Words] Blacklisted word ID ${id}, also deleted ${curated.user_vocabulary_deleted || 0} user_vocabulary records`);

      return sendJson(res, 200, {
        success: true,
        blacklisted: curated.blacklisted || curated.applied || 0,
        userVocabDeleted: curated.user_vocabulary_deleted || 0,
        soft_deleted: true,
        ...curationResponse(curated),
        note: '词汇已停用并从用户词库移除，可回滚恢复'
      });

    } catch (err) {
      console.error('[Admin Words] Delete error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/words/export - Export filtered words as CSV
  if (pathname === '/admin/words/export' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const search = (url.searchParams.get('search') || '').trim();
      const filterPhonetic = (url.searchParams.get('filter_phonetic') || '').trim();
      const filterZh = (url.searchParams.get('filter_zh') || '').trim();

      const whereClauses = [];
      const params = [];

      if (search) {
        params.push(`%${search.toLowerCase()}%`);
        whereClauses.push(`word_lowercase LIKE $${params.length}`);
      }

      // Filter by phonetic
      if (filterPhonetic === 'has') {
        whereClauses.push(`(phonetic IS NOT NULL AND phonetic != '')`);
      } else if (filterPhonetic === 'missing') {
        whereClauses.push(`(phonetic IS NULL OR phonetic = '')`);
      }

      // Filter by Chinese translation
      if (filterZh === 'has') {
        whereClauses.push(`(definitions IS NOT NULL AND definitions->>'zh' IS NOT NULL AND definitions->>'zh' != '' AND definitions->>'zh' NOT LIKE '[待翻译]%')`);
      } else if (filterZh === 'missing') {
        whereClauses.push(`(definitions IS NULL OR definitions->>'zh' IS NULL OR definitions->>'zh' = '' OR definitions->>'zh' LIKE '[待翻译]%')`);
      }

      const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      // Query all matching words (no pagination for export)
      const query = `
        SELECT
          word,
          phonetic,
          CASE
            WHEN definitions IS NULL THEN ''
            WHEN COALESCE(definitions->>'zh', '') LIKE '[待翻译]%' THEN ''
            ELSE COALESCE(definitions->>'zh', '')
          END AS zh,
          part_of_speech,
          lookup_count
        FROM words
        ${whereClause}
        ORDER BY lookup_count DESC NULLS LAST, word ASC
      `;

      const { rows } = await dataStore.pool.query(query, params);

      console.log(`[Admin Words Export] Exporting ${rows.length} words with filters: search=${search || 'none'}, phonetic=${filterPhonetic || 'all'}, zh=${filterZh || 'all'}`);

      // Generate CSV content
      const csvRows = [];
      csvRows.push('word,phonetic,zh,part_of_speech,lookup_count');

      for (const r of rows) {
        csvRows.push([
          escapeCsvField(r.word || ''),
          escapeCsvField(r.phonetic || ''),
          escapeCsvField(r.zh || ''),
          escapeCsvField(r.part_of_speech || ''),
          r.lookup_count || 0
        ].join(','));
      }

      const csvContent = csvRows.join('\n');

      // Build filename with filter info
      let filename = 'words-filtered';
      if (search) filename += `-search`;
      if (filterPhonetic) filename += `-phonetic_${filterPhonetic}`;
      if (filterZh) filename += `-zh_${filterZh}`;
      filename += `-${new Date().toISOString().split('T')[0]}.csv`;

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });

      // Add UTF-8 BOM for Excel compatibility
      res.end('\uFEFF' + csvContent);
      return true;

    } catch (err) {
      console.error('[Admin Words Export] Error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/words/unblacklist - 从黑名单恢复词汇
  if (pathname === '/admin/words/unblacklist' && req.method === 'POST') {
    try {
      const admin = await requireAdmin(req);
      const { ids } = await parseBody(req);

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return sendError(res, 400, '缺少 ids 参数或格式不正确');
      }

      // 限制一次最多恢复100个
      if (ids.length > 100) {
        return sendError(res, 400, '一次最多恢复100个词汇');
      }

      const validIds = Array.from(new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0)));
      if (validIds.length === 0) {
        return sendError(res, 400, 'ids 中没有有效的数字ID');
      }

      console.log(`[Admin Words] Unblacklisting ${validIds.length} words:`, validIds);

      const batch = await curation.applyBatch({
        writes: validIds.map((id) => ({
          id, action: 'unblacklist', source: 'manual', reviewed: true, metadata: { path: pathname },
        })),
        actor: { type: 'admin', id: admin?.id },
      });
      const rowCount = batch.results.reduce(
        (sum, curated) => sum + Number(curated.unblacklisted || curated.applied || 0),
        0,
      );

      console.log(`[Admin Words] Unblacklisted ${rowCount} words`);

      return sendJson(res, 200, {
        success: true,
        recovered: rowCount,
        requested: validIds.length,
        batch_id: batch.batch_id,
        ...aggregateCurationResponses(batch.results),
      });

    } catch (err) {
      console.error('[Admin Words Unblacklist] Error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  return false;
}

module.exports = { registerAdminTranslationsRoutes, registerAdminWordsRoutes };
