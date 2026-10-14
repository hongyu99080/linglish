/**
 * 词汇维护脚本
 * 功能：
 * 1. 清理低质量词汇（如 aa, abc, 纯数字等）
 * 2. 补全缺失的翻译和音标
 *
 * 使用方法：
 *   node scripts/vocab-maintenance.js [action]
 *
 * 可用操作：
 *   stats          - 统计缺失翻译/音标的词汇数量
 *   list-bad       - 列出低质量词汇（前100个）
 *   delete-bad     - 删除低质量词汇
 *   translate      - 批量翻译缺失翻译的词汇（每次50个）
 *   full           - 完整维护（先清理再翻译）
 */

require('dotenv').config();
const dataStore = require('../data-store');

// 低质量词汇判断规则
function isLowQualityWord(word) {
  if (!word) return { bad: true, reason: 'empty' };

  const w = word.trim();
  const lower = w.toLowerCase();

  // 太短（单字母除了 a, i）
  if (w.length === 1 && !['a', 'i'].includes(lower)) {
    return { bad: true, reason: 'single_letter' };
  }

  // 太长（超过45字符）
  if (w.length > 45) {
    return { bad: true, reason: 'too_long' };
  }

  // 包含数字
  if (/\d/.test(w)) {
    return { bad: true, reason: 'contains_number' };
  }

  // 包含特殊字符（除了连字符和撇号）
  if (/[^a-zA-Z\-']/.test(w)) {
    return { bad: true, reason: 'special_chars' };
  }

  // 连续重复字母超过3次（如 aaaa）
  if (/(.)\1{3,}/.test(lower)) {
    return { bad: true, reason: 'repeated_chars' };
  }

  // 纯辅音超过6个字母（无元音）
  if (w.length >= 7 && !/[aeiouy]/i.test(w)) {
    return { bad: true, reason: 'no_vowels' };
  }

  // 常见垃圾词汇
  const junkWords = ['aa', 'aaa', 'abc', 'abcd', 'xxx', 'zzz', 'test', 'asdf', 'qwerty'];
  if (junkWords.includes(lower)) {
    return { bad: true, reason: 'junk_word' };
  }

  return { bad: false };
}

// 统计缺失数据
async function showStats() {
  console.log('\n📊 词汇统计\n' + '='.repeat(40));

  // 总词汇数
  const { rows: [{ total }] } = await dataStore.pool.query('SELECT COUNT(*) as total FROM words');
  console.log(`总词汇数: ${total}`);

  // 缺失中文翻译
  const { rows: [{ missing_zh }] } = await dataStore.pool.query(`
    SELECT COUNT(*) as missing_zh FROM words
    WHERE definitions IS NULL
       OR definitions::text LIKE '%[待翻译]%'
       OR NOT (definitions ? 'zh')
       OR definitions->>'zh' = ''
  `);
  console.log(`缺失中文翻译: ${missing_zh}`);

  // 缺失音标
  const { rows: [{ missing_phonetic }] } = await dataStore.pool.query(`
    SELECT COUNT(*) as missing_phonetic FROM words
    WHERE phonetic IS NULL OR phonetic = '' OR phonetic = '-'
  `);
  console.log(`缺失音标: ${missing_phonetic}`);

  // 缺失英文定义
  const { rows: [{ missing_en }] } = await dataStore.pool.query(`
    SELECT COUNT(*) as missing_en FROM words
    WHERE definitions IS NULL
       OR NOT (definitions ? 'en')
       OR definitions->>'en' = ''
       OR definitions->>'en' = '-'
  `);
  console.log(`缺失英文定义: ${missing_en}`);

  // 低质量词汇估算（使用SQL预过滤）
  const { rows: [{ low_quality }] } = await dataStore.pool.query(`
    SELECT COUNT(*) as low_quality FROM words
    WHERE (
      (LENGTH(word_lowercase) >= 8 AND word_lowercase ~ '([a-z])\\1\\1\\1') OR
      (word_lowercase ~ '[0-9]') OR
      (word_lowercase ~ '[^a-z\\-\\']') OR
      (LENGTH(word_lowercase) > 45) OR
      ((LENGTH(word_lowercase) = 1) AND word_lowercase NOT IN ('a','i')) OR
      ((LENGTH(word_lowercase) >= 7) AND word_lowercase !~ '[aeiouy]') OR
      (word_lowercase IN ('aa', 'aaa', 'abc', 'abcd', 'xxx', 'zzz', 'test', 'asdf', 'qwerty'))
    )
  `);
  console.log(`低质量词汇: ${low_quality}`);

  console.log('\n');
}

// 列出低质量词汇
async function listBadWords(limit = 100) {
  console.log('\n🗑️  低质量词汇列表\n' + '='.repeat(40));

  const { rows } = await dataStore.pool.query(`
    SELECT id, word, phonetic, definitions->>'zh' as zh, lookup_count, learned_by_count
    FROM words
    WHERE (
      (LENGTH(word_lowercase) >= 8 AND word_lowercase ~ '([a-z])\\1\\1\\1') OR
      (word_lowercase ~ '[0-9]') OR
      (word_lowercase ~ '[^a-z\\-\\']') OR
      (LENGTH(word_lowercase) > 45) OR
      ((LENGTH(word_lowercase) = 1) AND word_lowercase NOT IN ('a','i')) OR
      ((LENGTH(word_lowercase) >= 7) AND word_lowercase !~ '[aeiouy]') OR
      (word_lowercase IN ('aa', 'aaa', 'abc', 'abcd', 'xxx', 'zzz', 'test', 'asdf', 'qwerty'))
    )
    ORDER BY COALESCE(learned_by_count, 0) ASC, COALESCE(lookup_count, 0) ASC, word
    LIMIT $1
  `, [limit]);

  if (rows.length === 0) {
    console.log('✅ 没有发现低质量词汇！\n');
    return [];
  }

  console.log(`找到 ${rows.length} 个低质量词汇：\n`);
  console.log('ID\t词汇\t\t原因\t\t查询次数\t学习人数');
  console.log('-'.repeat(70));

  const badWords = [];
  for (const row of rows) {
    const quality = isLowQualityWord(row.word);
    if (quality.bad) {
      badWords.push(row);
      const word = row.word.padEnd(15).substring(0, 15);
      const reason = quality.reason.padEnd(15);
      console.log(`${row.id}\t${word}\t${reason}\t${row.lookup_count || 0}\t\t${row.learned_by_count || 0}`);
    }
  }

  console.log(`\n共 ${badWords.length} 个词汇可以删除\n`);
  return badWords;
}

// 删除低质量词汇
async function deleteBadWords() {
  const badWords = await listBadWords(500);

  if (badWords.length === 0) {
    return;
  }

  // 只删除 learned_by_count = 0 的词汇（没有用户学习过的）
  const safeToDelte = badWords.filter(w => (w.learned_by_count || 0) === 0);

  if (safeToDelte.length === 0) {
    console.log('⚠️  所有低质量词汇都有用户学习记录，跳过删除\n');
    return;
  }

  console.log(`\n🗑️  准备删除 ${safeToDelte.length} 个无人学习的低质量词汇...\n`);

  const ids = safeToDelte.map(w => w.id);

  await dataStore.pool.query('BEGIN');
  try {
    // 先删除 user_vocabulary 关联
    const { rowCount: uvDeleted } = await dataStore.pool.query(
      `DELETE FROM user_vocabulary WHERE word_id = ANY($1::int[])`,
      [ids]
    );

    // 删除词汇
    const { rowCount: wordsDeleted } = await dataStore.pool.query(
      `DELETE FROM words WHERE id = ANY($1::int[])`,
      [ids]
    );

    await dataStore.pool.query('COMMIT');

    console.log(`✅ 删除完成：${wordsDeleted} 个词汇，${uvDeleted} 条用户词汇记录\n`);
  } catch (err) {
    await dataStore.pool.query('ROLLBACK');
    console.error('❌ 删除失败:', err.message);
  }
}

// 批量翻译缺失的词汇
async function batchTranslate(limit = 50) {
  console.log('\n🔄 批量翻译缺失词汇\n' + '='.repeat(40));

  const { translateWord } = require('../services/translation.js');
  const dictionary = require('../services/dictionary');

  // 获取缺失翻译的词汇
  const { rows: items } = await dataStore.pool.query(`
    SELECT id, word, word_lowercase, definitions, phonetic
    FROM words
    WHERE (
      definitions IS NULL
      OR definitions::text LIKE '%[待翻译]%'
      OR NOT (definitions ? 'zh')
      OR definitions->>'zh' = ''
    )
    ORDER BY lookup_count DESC NULLS LAST, word
    LIMIT $1
  `, [limit]);

  if (items.length === 0) {
    console.log('✅ 没有需要翻译的词汇！\n');
    return;
  }

  console.log(`找到 ${items.length} 个需要翻译的词汇\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    process.stdout.write(`(${i + 1}/${items.length}) ${item.word}... `);

    try {
      // 1. 获取字典信息（英文定义和音标）
      let enDefinition = '';
      let phonetic = item.phonetic || '';

      if (!phonetic || phonetic === '-') {
        try {
          const dictResult = await dictionary.lookup(item.word);
          if (dictResult?.entry) {
            if (dictResult.entry.meanings?.[0]?.definitions?.[0]?.definition) {
              enDefinition = dictResult.entry.meanings[0].definitions[0].definition;
            }
            phonetic = dictResult.entry.phonetic || '';
            if (!phonetic && Array.isArray(dictResult.entry.phonetics)) {
              const p = dictResult.entry.phonetics.find(p => p && (p.text || p.phonetic));
              phonetic = p?.text || p?.phonetic || '';
            }
          }
        } catch (dictErr) {
          // 字典API失败，继续使用翻译服务
        }
      }

      // 2. 获取中文翻译
      const result = await translateWord(item.word, { userLabel: 'maintenance-script' });

      const isValidTranslation = result.translation &&
        !result.translation.startsWith('[待翻译]') &&
        !result.needsReview &&
        result.translation.toLowerCase() !== item.word.toLowerCase();

      if (isValidTranslation) {
        // 更新数据库
        if (enDefinition) {
          await dataStore.pool.query(`
            UPDATE words
            SET phonetic = $1,
                definitions = jsonb_build_object('en', $2::text, 'zh', $3::text),
                updated_at = NOW()
            WHERE id = $4
          `, [phonetic || '', enDefinition, result.translation, item.id]);
        } else {
          await dataStore.pool.query(`
            UPDATE words
            SET phonetic = COALESCE($1, phonetic),
                definitions = jsonb_set(
                  COALESCE(definitions, '{}'::jsonb),
                  '{zh}',
                  to_jsonb($2::text)
                ),
                updated_at = NOW()
            WHERE id = $3
          `, [phonetic || null, result.translation, item.id]);
        }

        successCount++;
        console.log(`✓ ${result.translation}`);
      } else {
        failCount++;
        console.log(`✗ (${result.translation || 'failed'})`);
      }

      // 速率限制
      await new Promise(resolve => setTimeout(resolve, 1500));

    } catch (err) {
      failCount++;
      console.log(`✗ Error: ${err.message}`);

      if (err.message?.includes('429')) {
        console.log('  ⚠️ Rate limit, waiting 5s...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  console.log(`\n✅ 翻译完成: ${successCount} 成功, ${failCount} 失败\n`);
}

// 主函数
async function main() {
  const action = process.argv[2] || 'stats';

  try {
    await dataStore.pool.query('SELECT 1'); // 测试连接
    console.log('✅ 数据库连接成功');

    switch (action) {
      case 'stats':
        await showStats();
        break;

      case 'list-bad':
        await listBadWords(100);
        break;

      case 'delete-bad':
        await deleteBadWords();
        break;

      case 'translate':
        const limit = parseInt(process.argv[3]) || 50;
        await batchTranslate(limit);
        break;

      case 'full':
        console.log('🔧 开始完整维护...\n');
        await showStats();
        await deleteBadWords();
        await batchTranslate(50);
        await showStats();
        break;

      default:
        console.log(`
使用方法: node scripts/vocab-maintenance.js [action]

可用操作：
  stats           - 统计缺失翻译/音标的词汇数量
  list-bad        - 列出低质量词汇（前100个）
  delete-bad      - 删除低质量词汇
  translate [N]   - 批量翻译缺失翻译的词汇（默认50个）
  full            - 完整维护（先清理再翻译）
        `);
    }

  } catch (err) {
    console.error('❌ 错误:', err.message);
  } finally {
    await dataStore.pool.end();
    process.exit(0);
  }
}

main();
