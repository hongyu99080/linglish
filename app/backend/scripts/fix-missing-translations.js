#!/usr/bin/env node

/**
 * 修复能量站中缺少翻译的词汇
 * 查找所有translation为空或占位符的词，并重新获取翻译
 */

// 加载环境变量
require('dotenv').config();

const dataStore = require('../data-store.js');
const { translateWord } = require('../services/translation.js');

async function fixMissingTranslations() {
  try {
    console.log('开始检查缺少翻译的词汇...\n');

    // 获取所有用户
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
    });

    // 查询所有缺少翻译的词汇
    const { rows: missingTranslations } = await pool.query(`
      SELECT DISTINCT user_id, lemma, translation
      FROM user_vocab_items
      WHERE translation IS NULL
         OR translation LIKE '[待翻译%'
         OR translation = '未设置翻译'
         OR translation = ''
      ORDER BY user_id, lemma
      LIMIT 1000
    `);

    console.log(`找到 ${missingTranslations.length} 个缺少翻译的词汇\n`);

    if (missingTranslations.length === 0) {
      console.log('✅ 所有词汇都有翻译！');
      await pool.end();
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const row of missingTranslations) {
      const { user_id, lemma, translation: oldTranslation } = row;

      console.log(`处理: "${lemma}" (当前翻译: ${oldTranslation || '空'})`);

      try {
        // 获取翻译
        const result = await translateWord(lemma);
        const newTranslation = result.translation;

        // 检查是否仍然是占位符
        if (newTranslation && !newTranslation.startsWith('[待翻译]')) {
          // 更新数据库
          await pool.query(
            'UPDATE user_vocab_items SET translation = $1 WHERE user_id = $2 AND lemma = $3',
            [newTranslation, user_id, lemma]
          );
          console.log(`  ✅ 更新为: ${newTranslation}`);
          successCount++;
        } else {
          console.log(`  ⚠️  仍然无法翻译: ${newTranslation}`);
          failCount++;
        }

        // 避免过快请求API
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.log(`  ❌ 翻译失败: ${error.message}`);
        failCount++;
      }
    }

    console.log('\n==================');
    console.log(`处理完成！`);
    console.log(`✅ 成功: ${successCount}`);
    console.log(`❌ 失败: ${failCount}`);
    console.log('==================\n');

    await pool.end();

  } catch (error) {
    console.error('脚本执行失败:', error);
    process.exit(1);
  }
}

fixMissingTranslations();
