/**
 * 修复缺失definitions的词汇
 *
 * 此脚本会：
 * 1. 查找所有definitions为NULL的词汇
 * 2. 调用字典API获取英文定义和音标
 * 3. 更新数据库
 */

// 加载环境变量
require('dotenv').config();

const { pool, init } = require('../data-store/core');
const dictionary = require('../services/dictionary');

async function fixMissingDefinitions() {
  await init();

  console.log('[Fix Definitions] 开始修复缺失的词汇定义...\n');

  // 查找所有需要修复的词汇（包括NULL和占位符）
  const result = await pool.query(`
    SELECT id, word, word_lowercase, phonetic, definitions
    FROM words
    WHERE definitions IS NULL
       OR definitions::text LIKE '%[待翻译]%'
       OR NOT (definitions ? 'en')
    ORDER BY lookup_count DESC, id ASC
  `);

  const words = result.rows;
  console.log(`[Fix Definitions] 找到 ${words.length} 个需要修复的词汇\n`);

  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const progress = `[${i + 1}/${words.length}]`;

    console.log(`${progress} 处理: "${word.word}"...`);

    try {
      // 调用字典API获取定义
      const dictResult = await dictionary.lookup(word.word);

      if (!dictResult || !dictResult.entry) {
        console.log(`${progress} ⚠️  未找到定义: "${word.word}"`);
        skipped++;
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
        skipped++;
        continue;
      }

      // 构造JSONB格式，保留现有的中文翻译（如果有）
      const existingZh = word.definitions?.zh || '[待翻译]';
      const definitions = {
        en: enDefinition,
        zh: existingZh
      };

      // 更新数据库
      await pool.query(
        `UPDATE words
         SET phonetic = $1, definitions = $2, updated_at = NOW()
         WHERE id = $3`,
        [phonetic, JSON.stringify(definitions), word.id]
      );

      console.log(`${progress} ✓ 已修复: "${word.word}"`);
      console.log(`          音标: ${phonetic || '(无)'}`);
      console.log(`          定义: ${enDefinition.substring(0, 60)}${enDefinition.length > 60 ? '...' : ''}`);
      fixed++;

      // 避免API速率限制
      if (i < words.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

    } catch (err) {
      console.log(`${progress} ✗ 失败: "${word.word}" - ${err.message}`);
      failed++;

      // 如果是429错误（速率限制），等待更长时间
      if (err.statusCode === 429) {
        console.log('          ⏳ 遇到速率限制，等待5秒...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  console.log('\n=== 修复完成 ===');
  console.log(`✓ 成功修复: ${fixed} 个`);
  console.log(`⚠️  跳过: ${skipped} 个`);
  console.log(`✗ 失败: ${failed} 个`);
  console.log(`总计: ${words.length} 个\n`);

  process.exit(0);
}

// 运行修复
fixMissingDefinitions().catch(err => {
  console.error('修复脚本出错:', err);
  process.exit(1);
});
