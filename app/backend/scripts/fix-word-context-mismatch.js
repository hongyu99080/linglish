#!/usr/bin/env node

/**
 * 修复词汇上下文中的子串匹配错误
 *
 * 问题：当保存 "neighbor" 时，错误地关联了包含 "neighborhood" 的句子
 *
 * 使用方法：
 * node scripts/fix-word-context-mismatch.js --user-id=1 --dry-run
 * node scripts/fix-word-context-mismatch.js --user-id=1
 */

require('dotenv').config();

const { Pool } = require('pg');

const DEFAULT_DATABASE_URL = 'postgresql://localhost/linglish?sslmode=disable';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
});

/**
 * 检查句子中是否包含完整的单词（使用单词边界）
 */
function containsWord(sentence, word) {
  if (!sentence || !word) return false;
  const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return regex.test(sentence);
}

async function main() {
  const args = process.argv.slice(2);
  const userIdArg = args.find(arg => arg.startsWith('--user-id='));
  const dryRun = args.includes('--dry-run');

  if (!userIdArg) {
    console.error('请指定用户ID: --user-id=<ID>');
    console.error('');
    console.error('使用方法:');
    console.error('  node scripts/fix-word-context-mismatch.js --user-id=1 --dry-run  (预览模式)');
    console.error('  node scripts/fix-word-context-mismatch.js --user-id=1            (执行修复)');
    process.exit(1);
  }

  const userId = parseInt(userIdArg.split('=')[1]);

  try {
    // Test database connection
    await pool.query('SELECT 1');
    console.log('✅ 数据库连接成功\n');

    // 查询所有 vocab contexts
    const { rows: contexts } = await pool.query(
      `SELECT id, lemma, sentence, video_resource_id, segment_index, start_sec, end_sec
       FROM vocab_contexts
       WHERE user_id = $1
       ORDER BY lemma, id`,
      [userId]
    );

    console.log(`📋 检查 ${contexts.length} 条词汇上下文记录...\n`);

    const mismatches = [];

    for (const ctx of contexts) {
      const lemma = ctx.lemma;
      const sentence = ctx.sentence || '';

      // 检查句子中是否真正包含这个单词（完整匹配）
      if (!containsWord(sentence, lemma)) {
        mismatches.push({
          id: ctx.id,
          lemma: ctx.lemma,
          sentence: ctx.sentence,
          videoId: ctx.video_resource_id,
          segmentIndex: ctx.segment_index,
        });
      }
    }

    if (mismatches.length === 0) {
      console.log('✅ 没有发现不匹配的记录！\n');
      await pool.end();
      process.exit(0);
    }

    console.log(`⚠️  发现 ${mismatches.length} 条不匹配的记录:\n`);

    // 按单词分组统计
    const groupedByWord = {};
    mismatches.forEach(m => {
      if (!groupedByWord[m.lemma]) {
        groupedByWord[m.lemma] = [];
      }
      groupedByWord[m.lemma].push(m);
    });

    console.log('按单词统计:');
    Object.entries(groupedByWord).forEach(([word, items]) => {
      console.log(`  "${word}": ${items.length} 条错误关联`);
    });
    console.log('');

    // 显示前10个示例
    console.log('示例（前10条）:');
    mismatches.slice(0, 10).forEach((m, idx) => {
      console.log(`${idx + 1}. [ID=${m.id}] lemma="${m.lemma}"`);
      const sentenceText = m.sentence || '(空)';
      console.log(`   句子: ${sentenceText.substring(0, 100)}${sentenceText.length > 100 ? '...' : ''}`);
      console.log('');
    });

    if (dryRun) {
      console.log('🔍 [预览模式] 以上记录将被删除');
      console.log('💡 移除 --dry-run 参数来执行实际删除\n');
      await pool.end();
      process.exit(0);
    }

    // 执行删除
    console.log('🗑️  开始删除不匹配的记录...\n');

    let deleted = 0;
    let failed = 0;

    for (const m of mismatches) {
      try {
        await pool.query(
          `DELETE FROM vocab_contexts WHERE id = $1`,
          [m.id]
        );
        deleted++;
        if (deleted % 10 === 0) {
          console.log(`  已删除 ${deleted}/${mismatches.length}`);
        }
      } catch (err) {
        failed++;
        console.error(`  ✗ 删除失败 (ID=${m.id}):`, err.message);
      }
    }

    console.log('');
    console.log('='.repeat(50));
    console.log('📊 修复完成统计:');
    console.log('='.repeat(50));
    console.log(`✅ 成功删除: ${deleted} 条记录`);
    console.log(`❌ 删除失败: ${failed} 条记录`);
    console.log(`📝 总计: ${mismatches.length} 条不匹配记录`);
    console.log('='.repeat(50));
    console.log('');

    console.log('💡 提示：这些单词的上下文已被清理，但单词本身仍在词汇表中');
    console.log('   下次点击视频中的单词时，会重新关联正确的句子\n');

    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ 错误:', err.message);
    console.error(err.stack);
    await pool.end();
    process.exit(1);
  }
}

main();
