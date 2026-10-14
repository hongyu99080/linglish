/**
 * Detect Suspicious Translations Script
 * Automatically identifies vocabulary items with potentially incorrect translations
 * Results can be reviewed by admin in the management dashboard
 *
 * Usage:
 *   node scripts/detect-suspicious-translations.js [options]
 *
 * Options:
 *   --mark          Mark suspicious items in database for admin review
 *   --output FILE   Output results to JSON file
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  mark: args.includes('--mark'),
  output: null
};

const outputIndex = args.indexOf('--output');
if (outputIndex >= 0 && args[outputIndex + 1]) {
  options.output = args[outputIndex + 1];
}

/**
 * Check if translation is suspicious
 * Returns { suspicious: boolean, reasons: string[] }
 */
function checkTranslation(lemma, translation, source) {
  const reasons = [];

  // 1. Translation is missing or placeholder
  if (!translation || translation.trim() === '') {
    reasons.push('翻译为空');
  } else if (translation.startsWith('[待翻译]')) {
    reasons.push('翻译标记为待翻译');
  }

  // 2. Translation equals original word (might be proper noun or failed translation)
  if (translation === lemma) {
    reasons.push('翻译与原词相同');
  }

  // 3. Translation contains English letters (might indicate failed translation)
  if (translation && /[a-zA-Z]{3,}/.test(translation)) {
    reasons.push('翻译包含英文单词');
  }

  // 4. Translation from low-quality source (fallback, mymemory)
  if (source && ['fallback', 'mymemory'].includes(source)) {
    reasons.push(`来自低质量来源: ${source}`);
  }

  // 5. Translation is too long (> 50 characters, unusual for single word)
  if (translation && translation.length > 50) {
    reasons.push(`翻译过长 (${translation.length} 字符)`);
  }

  // 6. Translation contains unusual patterns
  if (translation) {
    // Contains multiple parentheses (might be verbose explanation)
    if ((translation.match(/（/g) || []).length >= 3) {
      reasons.push('翻译包含过多括号说明');
    }

    // Contains "缩写" (abbreviation note) - often messy
    if (translation.includes('缩写') && translation.length > 20) {
      reasons.push('翻译包含缩写说明且较长');
    }
  }

  // 7. Translation source is libretranslate with potential issues
  if (source === 'libretranslate' && translation) {
    // LibreTranslate sometimes produces awkward translations
    if (translation.includes('；') && translation.split('；').length > 2) {
      reasons.push('LibreTranslate 翻译包含多个分号');
    }
  }

  return {
    suspicious: reasons.length > 0,
    reasons
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('检测可疑翻译');
  console.log('='.repeat(60));
  console.log('选项:', JSON.stringify(options, null, 2));
  console.log('');

  // Create database connection pool
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  // Test database connection
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('❌ 数据库连接失败:', err.message);
    await pool.end();
    process.exit(1);
  }

  // Get all vocabulary with translations
  const query = `
    SELECT DISTINCT ON (uv.lemma)
      uv.lemma,
      uv.translation,
      tc.source,
      COUNT(*) OVER (PARTITION BY uv.lemma) as user_count
    FROM user_vocabulary uv
    LEFT JOIN translation_cache tc ON tc.word = uv.lemma
    WHERE uv.translation IS NOT NULL
      AND uv.translation != ''
    ORDER BY uv.lemma, uv.created_at DESC
  `;

  const result = await pool.query(query);
  const allVocab = result.rows || [];

  console.log(`📊 检查 ${allVocab.length} 个不同的词汇...\n`);

  const suspiciousItems = [];
  const stats = {
    total: allVocab.length,
    suspicious: 0,
    byReason: {}
  };

  for (const vocab of allVocab) {
    const check = checkTranslation(vocab.lemma, vocab.translation, vocab.source);

    if (check.suspicious) {
      stats.suspicious++;

      suspiciousItems.push({
        lemma: vocab.lemma,
        translation: vocab.translation,
        source: vocab.source || 'unknown',
        userCount: vocab.user_count || 0,
        reasons: check.reasons
      });

      // Count reasons
      check.reasons.forEach(reason => {
        stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
      });
    }
  }

  // Sort by user count (most used first) and lemma
  suspiciousItems.sort((a, b) => {
    if (b.userCount !== a.userCount) return b.userCount - a.userCount;
    return a.lemma.localeCompare(b.lemma);
  });

  console.log('='.repeat(60));
  console.log('检测结果统计');
  console.log('='.repeat(60));
  console.log(`总词汇数: ${stats.total}`);
  console.log(`可疑翻译: ${stats.suspicious} (${(stats.suspicious/stats.total*100).toFixed(1)}%)`);
  console.log('');
  console.log('按问题类型分布:');
  Object.entries(stats.byReason)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count}`);
    });
  console.log('');

  // Show top suspicious items
  console.log('前 20 个可疑翻译（按使用人数排序）:');
  console.log('-'.repeat(60));
  suspiciousItems.slice(0, 20).forEach((item, index) => {
    console.log(`${index + 1}. ${item.lemma}`);
    console.log(`   翻译: "${item.translation}"`);
    console.log(`   来源: ${item.source} | 使用人数: ${item.userCount}`);
    console.log(`   问题: ${item.reasons.join(', ')}`);
    console.log('');
  });

  // Mark in database if requested
  if (options.mark) {
    console.log('标记可疑翻译到数据库...');

    // Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS suspicious_translations (
        id SERIAL PRIMARY KEY,
        lemma TEXT NOT NULL,
        translation TEXT,
        source TEXT,
        reasons TEXT[],
        user_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',  -- pending, reviewed, corrected, dismissed
        detected_at TIMESTAMP DEFAULT NOW(),
        reviewed_at TIMESTAMP,
        reviewed_by INTEGER,
        UNIQUE(lemma)
      )
    `);

    // Insert or update suspicious items
    for (const item of suspiciousItems) {
      await pool.query(`
        INSERT INTO suspicious_translations (lemma, translation, source, reasons, user_count, status)
        VALUES ($1, $2, $3, $4, $5, 'pending')
        ON CONFLICT (lemma)
        DO UPDATE SET
          translation = $2,
          source = $3,
          reasons = $4,
          user_count = $5,
          detected_at = NOW()
        WHERE suspicious_translations.status = 'pending'
      `, [item.lemma, item.translation, item.source, item.reasons, item.userCount]);
    }

    console.log(`✅ 已标记 ${suspiciousItems.length} 个可疑翻译`);
  }

  // Close database connection
  await pool.end();

  // Output to file if requested
  if (options.output) {
    const output = {
      generatedAt: new Date().toISOString(),
      stats,
      suspiciousItems
    };
    fs.writeFileSync(options.output, JSON.stringify(output, null, 2));
    console.log(`✅ 结果已保存到: ${options.output}`);
  }

  console.log('');
  console.log('下一步:');
  console.log('  1. 访问管理后台查看可疑翻译列表');
  console.log('  2. 管理员审核并修正翻译');
  console.log('  3. 修正后的翻译会自动更新到所有用户');
  console.log('');

  process.exit(0);
}

// Run script
main().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});
