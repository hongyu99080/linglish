/**
 * Batch Re-translation Script
 * Re-translates vocabulary using the new OpenAI-powered translation service
 *
 * Usage:
 *   node scripts/retranslate-vocabulary.js [options]
 *
 * Options:
 *   --dry-run          Show what would be translated without actually doing it
 *   --limit N          Limit to N words (default: all)
 *   --source SOURCE    Only retranslate from specific source (libretranslate, mymemory, fallback)
 *   --all              Retranslate ALL vocabulary regardless of source
 */

require('dotenv').config();
const dataStore = require('../data-store');
const { translateWord } = require('../services/translation');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes('--dry-run'),
  limit: null,
  source: null,
  all: args.includes('--all')
};

// Parse --limit N
const limitIndex = args.indexOf('--limit');
if (limitIndex >= 0 && args[limitIndex + 1]) {
  options.limit = parseInt(args[limitIndex + 1], 10);
}

// Parse --source SOURCE
const sourceIndex = args.indexOf('--source');
if (sourceIndex >= 0 && args[sourceIndex + 1]) {
  options.source = args[sourceIndex + 1];
}

async function main() {
  console.log('='.repeat(60));
  console.log('批量重新翻译词汇');
  console.log('='.repeat(60));
  console.log('选项:', JSON.stringify(options, null, 2));
  console.log('');

  // Connect to database
  if (!dataStore.isDatabaseAvailable || !dataStore.isDatabaseAvailable()) {
    console.error('❌ 数据库不可用');
    process.exit(1);
  }

  // Query vocabulary that needs retranslation
  let query = `
    SELECT DISTINCT lemma, translation
    FROM user_vocabulary
    WHERE translation IS NOT NULL
      AND translation != ''
      AND translation NOT LIKE '[待翻译]%'
  `;

  if (!options.all) {
    // Only retranslate non-OpenAI, non-dictionary translations
    query += `
      AND lemma IN (
        SELECT word FROM translation_cache
        WHERE source NOT IN ('dictionary', 'openai', 'proper-noun-detection')
      )
    `;
  }

  if (options.source) {
    query += `
      AND lemma IN (
        SELECT word FROM translation_cache WHERE source = $1
      )
    `;
  }

  if (options.limit) {
    query += ` LIMIT ${options.limit}`;
  }

  const params = options.source ? [options.source] : [];
  const result = await dataStore.query(query, params);

  const vocabularyToTranslate = result.rows || [];
  console.log(`📊 找到 ${vocabularyToTranslate.length} 个需要重新翻译的词汇\n`);

  if (vocabularyToTranslate.length === 0) {
    console.log('✅ 没有需要重新翻译的词汇');
    process.exit(0);
  }

  if (options.dryRun) {
    console.log('🔍 试运行模式 - 不会实际翻译\n');
    console.log('将要翻译的词汇示例 (前20个):');
    vocabularyToTranslate.slice(0, 20).forEach((row, index) => {
      console.log(`  ${index + 1}. ${row.lemma} (当前: ${row.translation})`);
    });
    console.log('');
    console.log('要开始实际翻译，请移除 --dry-run 参数');
    process.exit(0);
  }

  // Start actual translation
  console.log('🚀 开始批量翻译...\n');

  let successCount = 0;
  let failCount = 0;
  let unchangedCount = 0;

  for (let i = 0; i < vocabularyToTranslate.length; i++) {
    const { lemma, translation: oldTranslation } = vocabularyToTranslate[i];
    const progress = `[${i + 1}/${vocabularyToTranslate.length}]`;

    try {
      // Translate using new service (will use OpenAI)
      const result = await translateWord(lemma, { userLabel: 'batch-retranslate' });
      const newTranslation = result.translation;

      if (newTranslation === oldTranslation) {
        console.log(`${progress} ⚪ ${lemma}: 翻译未变 "${newTranslation}"`);
        unchangedCount++;
      } else if (newTranslation === lemma) {
        // Translation failed, keep old translation
        console.log(`${progress} ⚠️  ${lemma}: 翻译失败，保持原翻译 "${oldTranslation}"`);
        failCount++;
      } else {
        // Update all user_vocabulary entries with this word
        await dataStore.query(
          'UPDATE user_vocabulary SET translation = $1 WHERE lemma = $2',
          [newTranslation, lemma]
        );
        console.log(`${progress} ✅ ${lemma}: "${oldTranslation}" → "${newTranslation}"`);
        successCount++;
      }

      // Rate limiting: wait 100ms between translations to avoid hitting OpenAI rate limits
      if (i < vocabularyToTranslate.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`${progress} ❌ ${lemma}: 翻译失败 - ${error.message}`);
      failCount++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('翻译完成摘要');
  console.log('='.repeat(60));
  console.log(`✅ 成功更新: ${successCount}`);
  console.log(`⚪ 保持不变: ${unchangedCount}`);
  console.log(`❌ 翻译失败: ${failCount}`);
  console.log(`📊 总计处理: ${vocabularyToTranslate.length}`);
  console.log('');

  process.exit(0);
}

// Run script
main().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});
