#!/usr/bin/env node

/**
 * 清理词汇表中包含标点符号的无效单词
 *
 * 使用方法：
 * node scripts/clean-invalid-words.js
 *
 * 或者指定用户ID：
 * node scripts/clean-invalid-words.js --user-id=123
 */

require('dotenv').config();

const dataStore = require('../data-store');

/**
 * 检查单词是否有效
 * 有效单词应该只包含字母、连字符和撇号，且首尾不能是标点
 */
function isValidWord(word) {
  if (!word || typeof word !== 'string') return false;

  // 移除所有非字母、非连字符、非撇号的字符
  const cleaned = word.replace(/[^a-z'-]/gi, '');

  // 移除首尾的连字符和撇号
  const trimmed = cleaned.replace(/^['\-]+|['\-]+$/g, '');

  // 检查是否有效：
  // 1. 长度至少2个字符
  // 2. 包含至少一个字母
  // 3. 不是纯数字
  // 4. 不包含连续的撇号
  // 5. 清理后的单词应该和原单词相同（说明没有非法字符）
  return trimmed.length >= 2 &&
         /[a-z]/i.test(trimmed) &&
         !/^\d+$/.test(trimmed) &&
         !/[']{2,}/.test(trimmed) &&
         trimmed === word;
}

/**
 * 获取所有无效的单词
 */
async function getInvalidWords(userId) {
  console.log(`\n📋 正在检查用户 ${userId} 的词汇表...`);

  try {
    // 获取所有词汇
    const items = await dataStore.listAllVocabItems(userId, {
      limit: 100000,
      offset: 0
    });

    console.log(`📊 总共 ${items.length} 个单词`);

    // 筛选出无效的单词
    const invalidWords = items.filter(item => !isValidWord(item.lemma));

    console.log(`❌ 发现 ${invalidWords.length} 个无效单词\n`);

    if (invalidWords.length > 0) {
      console.log('无效单词列表:');
      invalidWords.forEach((item, index) => {
        console.log(`  ${index + 1}. "${item.lemma}" (状态: ${item.state || 'unknown'})`);
      });
    }

    return invalidWords;
  } catch (err) {
    console.error('❌ 获取词汇列表失败:', err.message);
    throw err;
  }
}

/**
 * 删除无效单词
 */
async function deleteInvalidWords(userId, invalidWords, dryRun = false) {
  if (invalidWords.length === 0) {
    console.log('\n✅ 没有需要清理的单词！');
    return { deleted: 0, failed: 0 };
  }

  if (dryRun) {
    console.log('\n🔍 [预览模式] 以下单词将被删除:');
    invalidWords.forEach((item, index) => {
      console.log(`  ${index + 1}. "${item.lemma}"`);
    });
    console.log(`\n总计: ${invalidWords.length} 个单词`);
    console.log('\n💡 提示: 移除 --dry-run 参数来执行实际删除');
    return { deleted: 0, failed: 0 };
  }

  console.log(`\n🗑️  开始删除 ${invalidWords.length} 个无效单词...`);

  let deleted = 0;
  let failed = 0;

  for (const item of invalidWords) {
    try {
      const success = await dataStore.deleteVocabItem(userId, item.lemma);
      if (success) {
        deleted++;
        console.log(`  ✓ 已删除: "${item.lemma}"`);
      } else {
        failed++;
        console.log(`  ✗ 删除失败: "${item.lemma}" (未找到)`);
      }
    } catch (err) {
      failed++;
      console.log(`  ✗ 删除失败: "${item.lemma}" (错误: ${err.message})`);
    }

    // 每删除10个单词暂停一下，避免数据库压力过大
    if ((deleted + failed) % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return { deleted, failed };
}

/**
 * 主函数
 */
async function main() {
  console.log('🧹 词汇表清理工具');
  console.log('==================\n');

  // 解析命令行参数
  const args = process.argv.slice(2);
  const userIdArg = args.find(arg => arg.startsWith('--user-id='));
  const dryRun = args.includes('--dry-run');
  const helpFlag = args.includes('--help') || args.includes('-h');

  if (helpFlag) {
    console.log('使用方法:');
    console.log('  node scripts/clean-invalid-words.js [选项]');
    console.log('\n选项:');
    console.log('  --user-id=<ID>  指定用户ID（如果不指定，会列出所有用户）');
    console.log('  --dry-run       预览模式，不实际删除');
    console.log('  --help, -h      显示帮助信息');
    console.log('\n示例:');
    console.log('  node scripts/clean-invalid-words.js --dry-run');
    console.log('  node scripts/clean-invalid-words.js --user-id=1');
    console.log('  node scripts/clean-invalid-words.js --user-id=1 --dry-run');
    process.exit(0);
  }

  try {
    // 初始化数据库连接
    await dataStore.init();
    console.log('✅ 数据库连接成功\n');

    let userId;

    if (userIdArg) {
      // 使用指定的用户ID
      userId = parseInt(userIdArg.split('=')[1]);
      console.log(`👤 用户ID: ${userId}`);
    } else {
      // 获取所有用户并让用户选择
      console.log('⚠️  未指定用户ID');
      console.log('💡 使用 --user-id=<ID> 来指定用户，或者添加用户列表功能\n');

      // 默认使用用户ID 1（可以根据实际情况修改）
      userId = 1;
      console.log(`📌 使用默认用户ID: ${userId}\n`);
    }

    // 获取无效单词列表
    const invalidWords = await getInvalidWords(userId);

    // 删除无效单词
    const { deleted, failed } = await deleteInvalidWords(userId, invalidWords, dryRun);

    // 显示统计信息
    console.log('\n' + '='.repeat(50));
    console.log('📊 清理完成统计:');
    console.log('='.repeat(50));
    console.log(`✅ 成功删除: ${deleted} 个单词`);
    console.log(`❌ 删除失败: ${failed} 个单词`);
    console.log(`📝 总计: ${deleted + failed} 个无效单词`);
    console.log('='.repeat(50) + '\n');

    if (dryRun) {
      console.log('💡 这是预览模式，没有实际删除任何数据');
      console.log('   移除 --dry-run 参数来执行实际删除\n');
    }

  } catch (err) {
    console.error('\n❌ 错误:', err.message);
    console.error(err.stack);
    process.exit(1);
  }

  console.log('✨ 完成！\n');
  process.exit(0);
}

// 运行主函数
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { isValidWord, getInvalidWords, deleteInvalidWords };
