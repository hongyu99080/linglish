/**
 * 管理员API：修复缺失的词汇定义
 *
 * 使用方法：
 * POST /admin/fix-definitions
 *
 * Query参数：
 * - limit: 每次修复的最大数量（默认50）
 * - offset: 从第几个开始（默认0）
 */

const { pool } = require('../../data-store/core');
const dictionary = require('../../services/dictionary');
const { authenticate } = require('../../middleware/auth');
const { createCurationService } = require('../../services/dictionary/curation');

const curation = createCurationService();

async function handleFixDefinitions(req, res) {
  try {
    const admin = await authenticate(req);
    if (!admin?.is_admin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'FORBIDDEN' }));
      return;
    }
    // 从query string获取参数
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const dryRun = ['1', 'true'].includes(String(url.searchParams.get('dry_run') || '').toLowerCase());

    console.log(`[Admin Fix] 开始修复词汇定义 (limit=${limit}, offset=${offset})`);

    // 查找缺失definitions的词汇（包括NULL和占位符）
    const result = await pool.query(`
      SELECT id, word, word_lowercase, phonetic, definitions
      FROM words
      WHERE definitions IS NULL
         OR definitions::text LIKE '%[待翻译]%'
         OR NOT (definitions ? 'en')  -- 没有英文定义
      ORDER BY lookup_count DESC, id ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const words = result.rows;
    console.log(`[Admin Fix] 找到 ${words.length} 个需要修复的词汇`);

    const results = {
      total: words.length,
      fixed: 0,
      skipped: 0,
      failed: 0,
      details: []
    };
    const batchIds = [];

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const progress = `[${i + 1}/${words.length}]`;

      try {
        console.log(`${progress} 处理: "${word.word}"...`);

        // 调用字典API
        const dictResult = await dictionary.lookup(word.word, { persist: !dryRun });

        if (!dictResult || !dictResult.entry) {
          console.log(`${progress} ⚠️  未找到定义: "${word.word}"`);
          results.skipped++;
          results.details.push({
            word: word.word,
            status: 'skipped',
            reason: '字典中未找到'
          });
          continue;
        }

        const entry = dictResult.entry;

        // 提取音标
        let phonetic = entry.phonetic || '';
        if (!phonetic && Array.isArray(entry.phonetics) && entry.phonetics.length > 0) {
          const phoneticEntry = entry.phonetics.find(p => p && (p.text || p.phonetic));
          phonetic = phoneticEntry?.text || phoneticEntry?.phonetic || '';
        }

        // 提取英文定义
        let enDefinition = '';
        if (Array.isArray(entry.meanings) && entry.meanings.length > 0) {
          const firstMeaning = entry.meanings[0];
          if (Array.isArray(firstMeaning.definitions) && firstMeaning.definitions.length > 0) {
            enDefinition = firstMeaning.definitions[0].definition || '';
          }
        }

        if (!enDefinition) {
          console.log(`${progress} ⚠️  定义为空: "${word.word}"`);
          results.skipped++;
          results.details.push({
            word: word.word,
            status: 'skipped',
            reason: '定义为空'
          });
          continue;
        }

        // 构造JSONB格式，保留现有的中文翻译（如果有）
        const existingZh = word.definitions?.zh || '[待翻译]';
        const definitions = {
          en: enDefinition,
          zh: existingZh
        };

        const write = {
          id: word.id,
          word: word.word_lowercase || word.word,
          candidate: { phonetic, definitions },
          source: 'dictionary_external',
          reviewed: false,
          metadata: { path: '/admin/fix-definitions' },
        };
        const curated = dryRun
          ? await curation.preview({ write, actor: { type: 'admin', id: admin.id } })
          : await curation.apply({ write, actor: { type: 'admin', id: admin.id } });
        if (curated.batch_id) batchIds.push(curated.batch_id);

        console.log(`${progress} ✓ 已修复: "${word.word}"`);
        if (!dryRun) results.fixed += curated.applied || 0;
        results.details.push({
          word: word.word,
          status: 'fixed',
          phonetic: phonetic || '(无)',
          definition: enDefinition.substring(0, 100)
        });

        // 避免API速率限制
        if (i < words.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (err) {
        console.log(`${progress} ✗ 失败: "${word.word}" - ${err.message}`);
        results.failed++;
        results.details.push({
          word: word.word,
          status: 'failed',
          error: err.message
        });

        // 遇到速率限制，等待更长时间
        if (err.statusCode === 429) {
          console.log('遇到速率限制，等待5秒...');
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    // 查询还剩多少需要修复
    const remainingResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM words
      WHERE definitions IS NULL
         OR definitions::text LIKE '%[待翻译]%'
         OR NOT (definitions ? 'en')
    `);
    const remaining = parseInt(remainingResult.rows[0].count);

    console.log(`[Admin Fix] 修复完成: ${results.fixed} 成功, ${results.skipped} 跳过, ${results.failed} 失败`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      dry_run: dryRun,
      batch_ids: batchIds,
      message: `修复完成：成功 ${results.fixed} 个，跳过 ${results.skipped} 个，失败 ${results.failed} 个`,
      results,
      remaining: remaining,
      nextOffset: offset + limit
    }));

  } catch (err) {
    console.error('[Admin Fix] 错误:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: err.message
    }));
  }
}

module.exports = {
  handleFixDefinitions
};
