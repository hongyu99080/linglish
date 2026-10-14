/**
 * Clean Translation Cache Script
 * Removes low-quality translations from cache to allow re-translation
 *
 * Usage:
 *   node scripts/clean-translation-cache.js [options]
 *
 * Options:
 *   --dry-run          Show what would be deleted without actually doing it
 *   --source SOURCE    Only delete from specific source (libretranslate, mymemory, fallback)
 *   --all              Delete ALL cached translations (use with caution!)
 */

require('dotenv').config();
const dataStore = require('../data-store');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes('--dry-run'),
  source: null,
  all: args.includes('--all')
};

// Parse --source SOURCE
const sourceIndex = args.indexOf('--source');
if (sourceIndex >= 0 && args[sourceIndex + 1]) {
  options.source = args[sourceIndex + 1];
}

async function main() {
  console.log('='.repeat(60));
  console.log('清理翻译缓存');
  console.log('='.repeat(60));
  console.log('选项:', JSON.stringify(options, null, 2));
  console.log('');

  // Connect to database
  if (!dataStore.isDatabaseAvailable || !dataStore.isDatabaseAvailable()) {
    console.error('❌ 数据库不可用');
    process.exit(1);
  }

  // Query cache entries to delete
  let query = 'SELECT word, translation, source FROM translation_cache WHERE 1=1';
  const params = [];

  if (!options.all) {
    // Only delete low-quality translations (not from dictionary or OpenAI)
    query += ` AND source NOT IN ('dictionary', 'openai', 'proper-noun-detection')`;
  }

  if (options.source) {
    params.push(options.source);
    query += ` AND source = $${params.length}`;
  }

  const result = await dataStore.query(query, params);
  const cacheEntries = result.rows || [];

  console.log(`📊 找到 ${cacheEntries.length} 个缓存条目\n`);

  if (cacheEntries.length === 0) {
    console.log('✅ 没有需要清理的缓存');
    process.exit(0);
  }

  // Group by source for summary
  const bySource = {};
  cacheEntries.forEach(entry => {
    if (!bySource[entry.source]) {
      bySource[entry.source] = 0;
    }
    bySource[entry.source]++;
  });

  console.log('按来源分组:');
  Object.entries(bySource).forEach(([source, count]) => {
    console.log(`  ${source}: ${count} 条`);
  });
  console.log('');

  if (options.dryRun) {
    console.log('🔍 试运行模式 - 不会实际删除\n');
    console.log('将要删除的缓存示例 (前20个):');
    cacheEntries.slice(0, 20).forEach((entry, index) => {
      console.log(`  ${index + 1}. ${entry.word} → "${entry.translation}" (来源: ${entry.source})`);
    });
    console.log('');
    console.log('要开始实际删除，请移除 --dry-run 参数');
    process.exit(0);
  }

  // Confirm before deleting
  console.log('⚠️  警告: 即将删除 ' + cacheEntries.length + ' 个缓存条目');
  console.log('这些词汇将在下次查询时重新翻译');
  console.log('');

  // Start deletion
  console.log('🗑️  开始清理缓存...\n');

  let deleteQuery = 'DELETE FROM translation_cache WHERE 1=1';
  const deleteParams = [];

  if (!options.all) {
    deleteQuery += ` AND source NOT IN ('dictionary', 'openai', 'proper-noun-detection')`;
  }

  if (options.source) {
    deleteParams.push(options.source);
    deleteQuery += ` AND source = $${deleteParams.length}`;
  }

  const deleteResult = await dataStore.query(deleteQuery, deleteParams);
  const deletedCount = deleteResult.rowCount || 0;

  console.log('\n' + '='.repeat(60));
  console.log('清理完成');
  console.log('='.repeat(60));
  console.log(`🗑️  删除了 ${deletedCount} 个缓存条目`);
  console.log('');
  console.log('下一步: 运行重新翻译脚本');
  console.log('  node scripts/retranslate-vocabulary.js');
  console.log('');

  process.exit(0);
}

// Run script
main().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});
