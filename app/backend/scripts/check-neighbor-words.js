#!/usr/bin/env node

/**
 * 检查数据库中 neighbor 相关的单词
 *
 * 使用方法：
 * node scripts/check-neighbor-words.js --user-id=1
 */

require('dotenv').config();

const dataStore = require('../data-store');

async function main() {
  const args = process.argv.slice(2);
  const userIdArg = args.find(arg => arg.startsWith('--user-id='));

  if (!userIdArg) {
    console.error('请指定用户ID: --user-id=<ID>');
    process.exit(1);
  }

  const userId = parseInt(userIdArg.split('=')[1]);

  try {
    await dataStore.init();
    console.log('✅ 数据库连接成功\n');

    // 查询包含 neighbor 的所有单词
    const pool = dataStore.pool;
    const { rows } = await pool.query(
      `SELECT lemma, state, exposures, translation, created_at
       FROM user_vocab_items
       WHERE user_id = $1 AND lemma LIKE '%neighbor%'
       ORDER BY lemma`,
      [userId]
    );

    console.log(`找到 ${rows.length} 个包含 "neighbor" 的单词:\n`);

    rows.forEach((row, index) => {
      console.log(`${index + 1}. "${row.lemma}"`);
      console.log(`   状态: ${row.state}`);
      console.log(`   曝光次数: ${row.exposures}`);
      console.log(`   翻译: ${row.translation || '(无)'}`);
      console.log(`   创建时间: ${row.created_at}`);
      console.log('');
    });

    // 检查这两个单词是否都存在
    const hasNeighbor = rows.some(r => r.lemma === 'neighbor');
    const hasNeighborhood = rows.some(r => r.lemma === 'neighborhood');

    console.log('='.repeat(50));
    console.log('总结:');
    console.log('='.repeat(50));
    console.log(`包含 "neighbor": ${hasNeighbor ? '✅ 是' : '❌ 否'}`);
    console.log(`包含 "neighborhood": ${hasNeighborhood ? '✅ 是' : '❌ 否'}`);

    if (hasNeighbor && !hasNeighborhood) {
      console.log('\n⚠️  问题确认: 数据库中只有 "neighbor" 而没有 "neighborhood"');
      console.log('   这说明在导入过程中 "neighborhood" 被错误地保存为了 "neighbor"');
    }

    process.exit(0);
  } catch (err) {
    console.error('错误:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
