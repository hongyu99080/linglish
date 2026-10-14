/**
 * 清理所有字典缓存
 *
 * 清理：
 * 1. dictionary_cache 表 - 字典API响应缓存
 * 2. words 表的 definitions 字段 - 包含罕见定义的词汇
 * 3. translation_cache 表 - 包含罕见关键词的翻译缓存
 */

require('dotenv').config();

const { pool, init } = require('../data-store/core');

const RARE_KEYWORDS = [
  'grub', 'maggot', 'larva', 'archaic', 'obsolete', 'dialectal'
];

async function clearDictionaryCache() {
  await init();

  console.log('[Clear Cache] 开始清理字典缓存...\n');

  // 1. 清理 dictionary_cache 表中包含罕见定义的缓存
  try {
    // 先找出有问题的缓存
    const conditions = RARE_KEYWORDS.map((kw, idx) =>
      `entry::text ILIKE $${idx + 1}`
    ).join(' OR ');
    const params = RARE_KEYWORDS.map(kw => `%${kw}%`);

    const findResult = await pool.query(
      `SELECT word FROM dictionary_cache WHERE ${conditions}`,
      params
    );

    if (findResult.rows.length > 0) {
      console.log(`[Dictionary Cache] 找到 ${findResult.rows.length} 个需要清理的缓存:`);
      for (const row of findResult.rows) {
        console.log(`  - ${row.word}`);
      }

      const deleteResult = await pool.query(
        `DELETE FROM dictionary_cache WHERE ${conditions}`,
        params
      );
      console.log(`[Dictionary Cache] 已删除 ${deleteResult.rowCount} 条缓存\n`);
    } else {
      console.log('[Dictionary Cache] 没有找到包含罕见定义的缓存\n');
    }
  } catch (err) {
    console.log('[Dictionary Cache] 表可能不存在或查询失败:', err.message, '\n');
  }

  // 2. 清理 words 表中的错误定义
  try {
    const conditions = RARE_KEYWORDS.map((kw, idx) =>
      `definitions::text ILIKE $${idx + 1}`
    ).join(' OR ');
    const params = RARE_KEYWORDS.map(kw => `%${kw}%`);

    const findResult = await pool.query(
      `SELECT word FROM words WHERE ${conditions}`,
      params
    );

    if (findResult.rows.length > 0) {
      console.log(`[Words] 找到 ${findResult.rows.length} 个需要清理的词汇:`);
      for (const row of findResult.rows) {
        console.log(`  - ${row.word}`);
      }

      const updateResult = await pool.query(
        `UPDATE words SET definitions = NULL, updated_at = NOW() WHERE ${conditions}`,
        params
      );
      console.log(`[Words] 已清理 ${updateResult.rowCount} 个词汇的定义\n`);
    } else {
      console.log('[Words] 没有找到包含罕见定义的词汇\n');
    }
  } catch (err) {
    console.log('[Words] 查询失败:', err.message, '\n');
  }

  // 3. 清理 translation_cache 表中包含罕见关键词的翻译
  try {
    const conditions = RARE_KEYWORDS.map((kw, idx) =>
      `source_text ILIKE $${idx + 1}`
    ).join(' OR ');
    const params = RARE_KEYWORDS.map(kw => `%${kw}%`);

    const deleteResult = await pool.query(
      `DELETE FROM translation_cache WHERE ${conditions}`,
      params
    );
    console.log(`[Translation Cache] 已删除 ${deleteResult.rowCount} 条翻译缓存\n`);
  } catch (err) {
    console.log('[Translation Cache] 表可能不存在或查询失败:', err.message, '\n');
  }

  console.log('[Clear Cache] 完成！请重启服务器以清除内存缓存。');
  process.exit(0);
}

clearDictionaryCache().catch(err => {
  console.error('[Clear Cache] 脚本执行失败:', err);
  process.exit(1);
});
