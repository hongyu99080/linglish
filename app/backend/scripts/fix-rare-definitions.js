/**
 * 修复包含罕见/错误定义的词汇
 *
 * 问题背景：
 * 字典API有时会返回多个词条，第一个可能是罕见的定义。
 * 例如 "made" 返回两个词条：
 *   - 第一个只有名词含义 "A grub or maggot."（蛴螬或蛆）
 *   - 第二个才有正常的动词含义 "To create."
 *
 * 之前的代码只取第一个词条，导致保存了错误的定义。
 * 现在 dictionary.js 已修复，此脚本用于清理已保存的错误数据。
 *
 * 此脚本会：
 * 1. 查找包含罕见定义关键词的词汇
 * 2. 清除其 definitions 字段
 * 3. 清除 dictionary_cache 中的缓存
 * 4. 下次查询时会自动使用修复后的逻辑重新获取
 */

require('dotenv').config();

const { pool, init } = require('../data-store/core');

// 罕见定义关键词（可能误导学习者）
const RARE_KEYWORDS = [
  'grub',
  'maggot',
  'larva',
  'archaic',
  'obsolete',
  'dialectal'
];

async function fixRareDefinitions() {
  await init();

  console.log('[Fix Rare Definitions] 开始清理包含罕见定义的词汇...\n');

  // 构建搜索条件
  const searchConditions = RARE_KEYWORDS.map((kw, idx) =>
    `definitions::text ILIKE $${idx + 1}`
  ).join(' OR ');

  const searchParams = RARE_KEYWORDS.map(kw => `%${kw}%`);

  // 查找所有包含罕见定义的词汇
  const result = await pool.query(`
    SELECT id, word, word_lowercase, definitions
    FROM words
    WHERE ${searchConditions}
    ORDER BY word_lowercase
  `, searchParams);

  const words = result.rows;
  console.log(`[Fix Rare Definitions] 找到 ${words.length} 个可能包含罕见定义的词汇\n`);

  if (words.length === 0) {
    console.log('[Fix Rare Definitions] 没有需要修复的词汇');
    process.exit(0);
  }

  // 显示将要清理的词汇
  for (const word of words) {
    const defs = word.definitions;
    let rareDefText = '';

    if (defs && defs.meanings) {
      for (const meaning of defs.meanings) {
        if (meaning.definitions) {
          for (const def of meaning.definitions) {
            const defText = (def.definition || '').toLowerCase();
            const zhText = (def.zh || '');
            for (const kw of RARE_KEYWORDS) {
              if (defText.includes(kw)) {
                rareDefText = `${def.definition} -> ${zhText}`;
                break;
              }
            }
            if (rareDefText) break;
          }
        }
        if (rareDefText) break;
      }
    }

    console.log(`  "${word.word}": ${rareDefText || '(找到关键词匹配)'}`);
  }

  console.log('\n准备清理以上词汇的定义缓存...\n');

  let cleared = 0;
  let cacheCleared = 0;

  for (const word of words) {
    try {
      // 清除 words 表中的 definitions
      await pool.query(
        'UPDATE words SET definitions = NULL, updated_at = NOW() WHERE id = $1',
        [word.id]
      );
      console.log(`  ✓ 已清除 "${word.word}" 的 definitions`);
      cleared++;

      // 清除 dictionary_cache 表中的缓存（如果存在）
      try {
        const cacheResult = await pool.query(
          'DELETE FROM dictionary_cache WHERE word = $1 RETURNING id',
          [word.word_lowercase]
        );
        if (cacheResult.rowCount > 0) {
          console.log(`  ✓ 已清除 "${word.word}" 的 dictionary_cache`);
          cacheCleared++;
        }
      } catch (cacheErr) {
        // dictionary_cache 表可能不存在，忽略错误
      }

      // 清除 translation_cache 表中与此词相关的定义翻译
      try {
        // 清除包含罕见关键词的翻译缓存
        for (const kw of RARE_KEYWORDS) {
          await pool.query(
            `DELETE FROM translation_cache WHERE source_text ILIKE $1`,
            [`%${kw}%`]
          );
        }
      } catch (transErr) {
        // 忽略错误
      }
    } catch (err) {
      console.error(`  ✗ 清除 "${word.word}" 失败:`, err.message);
    }
  }

  console.log(`\n[Fix Rare Definitions] 完成！`);
  console.log(`  - 清除了 ${cleared} 个词汇的定义`);
  console.log(`  - 清除了 ${cacheCleared} 个字典缓存`);
  console.log(`\n下次查询这些词汇时，将使用修复后的逻辑重新获取定义。`);

  process.exit(0);
}

// 运行
fixRareDefinitions().catch(err => {
  console.error('[Fix Rare Definitions] 脚本执行失败:', err);
  process.exit(1);
});
