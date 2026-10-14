/**
 * 数据迁移脚本：user_vocab_items -> user_vocabulary + words
 *
 * 将旧的 user_vocab_items 表的数据迁移到新的词汇V2系统
 * - user_vocab_items 使用平面结构存储用户词汇
 * - 新系统使用 words（全局词库）+ user_vocabulary（用户词汇关联）
 *
 * 运行方法：
 * node scripts/migrate-vocab-to-v2.js
 *
 * 或者只运行分析（不实际迁移）：
 * node scripts/migrate-vocab-to-v2.js --dry-run
 */

// 加载环境变量
require('dotenv').config();

const { pool, init } = require('../data-store/core');

const DRY_RUN = process.argv.includes('--dry-run');

// 状态映射：旧系统 -> 新系统
const STATE_MAPPING = {
  'new': 'unknown',
  'encountered': 'learning',
  'learning': 'learning',
  'known': 'known',
  'mastered': 'known'
};

async function migrateVocabulary() {
  await init();

  console.log('\n========================================');
  console.log('词汇数据迁移：V1 -> V2');
  console.log(`模式：${DRY_RUN ? '分析模式（不会修改数据）' : '实际迁移模式'}`);
  console.log('========================================\n');

  try {
    // 1. 统计数据
    const oldCount = await pool.query('SELECT COUNT(*) FROM user_vocab_items');
    const newCount = await pool.query('SELECT COUNT(*) FROM user_vocabulary');
    const wordsCount = await pool.query('SELECT COUNT(*) FROM words');

    console.log('📊 当前数据统计：');
    console.log(`  - user_vocab_items（旧表）: ${oldCount.rows[0].count} 条`);
    console.log(`  - user_vocabulary（新表）: ${newCount.rows[0].count} 条`);
    console.log(`  - words（全局词库）: ${wordsCount.rows[0].count} 条\n`);

    // 2. 查找需要迁移的数据
    const toMigrate = await pool.query(`
      SELECT
        uvi.*,
        uv.id as already_in_new
      FROM user_vocab_items uvi
      LEFT JOIN words w ON w.word_lowercase = LOWER(uvi.lemma)
      LEFT JOIN user_vocabulary uv ON uv.user_id = uvi.user_id AND uv.word_id = w.id
      WHERE uv.id IS NULL  -- 只选择新表中不存在的
      ORDER BY uvi.user_id, uvi.lemma
    `);

    console.log(`🔍 分析结果：`);
    console.log(`  - 需要迁移的记录：${toMigrate.rows.length} 条\n`);

    if (toMigrate.rows.length === 0) {
      console.log('✅ 没有需要迁移的数据，所有词汇已在新系统中！');
      return;
    }

    // 3. 显示示例数据
    console.log('📝 前5条待迁移数据示例：');
    toMigrate.rows.slice(0, 5).forEach((row, i) => {
      console.log(`  ${i + 1}. user_id=${row.user_id}, lemma="${row.lemma}", translation="${row.translation || 'N/A'}", state=${row.state}`);
    });
    console.log('');

    if (DRY_RUN) {
      console.log('⚠️  这是分析模式，未执行实际迁移。');
      console.log('💡 运行 `node scripts/migrate-vocab-to-v2.js` 进行实际迁移。\n');
      return;
    }

    // 4. 执行迁移
    console.log('🚀 开始迁移...\n');

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of toMigrate.rows) {
      try {
        const { user_id, lemma, translation, state, exposures, first_seen_at } = row;
        const normalized = lemma.toLowerCase();
        const newStatus = STATE_MAPPING[state] || 'learning';

        // 4.1 确保词汇在全局 words 表中存在
        let wordResult = await pool.query(
          'SELECT id FROM words WHERE word_lowercase = $1',
          [normalized]
        );

        let wordId;
        if (wordResult.rows.length === 0) {
          // 插入到 words 表
          const definitions = translation ? JSON.stringify({ zh: translation, en: '' }) : null;
          const insertWord = await pool.query(
            `INSERT INTO words (word, word_lowercase, definitions, lookup_count, created_at, updated_at)
             VALUES ($1, $2, $3, 1, NOW(), NOW())
             RETURNING id`,
            [lemma, normalized, definitions]
          );
          wordId = insertWord.rows[0].id;
        } else {
          wordId = wordResult.rows[0].id;

          // 如果 words 表中没有中文翻译，但旧表有，则更新
          if (translation) {
            await pool.query(
              `UPDATE words
               SET definitions = COALESCE(
                 jsonb_set(definitions, '{zh}', to_jsonb($1::text)),
                 jsonb_build_object('zh', $1::text)
               ),
               updated_at = NOW()
               WHERE id = $2 AND (definitions IS NULL OR definitions->>'zh' IS NULL OR definitions->>'zh' = '[待翻译]')`,
              [translation, wordId]
            );
          }
        }

        // 4.2 插入到 user_vocabulary 表
        await pool.query(
          `INSERT INTO user_vocabulary (
            user_id, word_id, word, status,
            first_seen_at, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          ON CONFLICT (user_id, word_id) DO NOTHING`,
          [user_id, wordId, lemma, newStatus, first_seen_at || new Date()]
        );

        migrated++;

        if (migrated % 100 === 0) {
          console.log(`  ✓ 已迁移 ${migrated} 条...`);
        }
      } catch (err) {
        console.error(`  ✗ 迁移失败 lemma="${row.lemma}", user_id=${row.user_id}: ${err.message}`);
        errors++;
      }
    }

    console.log('\n========================================');
    console.log('✅ 迁移完成！');
    console.log('========================================');
    console.log(`  - 成功迁移：${migrated} 条`);
    console.log(`  - 跳过：${skipped} 条`);
    console.log(`  - 错误：${errors} 条\n`);

    // 5. 再次统计
    const newCountAfter = await pool.query('SELECT COUNT(*) FROM user_vocabulary');
    const wordsCountAfter = await pool.query('SELECT COUNT(*) FROM words');

    console.log('📊 迁移后数据统计：');
    console.log(`  - user_vocabulary: ${newCount.rows[0].count} -> ${newCountAfter.rows[0].count} (+${newCountAfter.rows[0].count - newCount.rows[0].count})`);
    console.log(`  - words: ${wordsCount.rows[0].count} -> ${wordsCountAfter.rows[0].count} (+${wordsCountAfter.rows[0].count - wordsCount.rows[0].count})\n`);

    console.log('💡 下一步：');
    console.log('  1. 测试新系统功能是否正常');
    console.log('  2. 确认无误后，运行清理脚本：node scripts/cleanup-old-vocab-table.js\n');

  } catch (err) {
    console.error('❌ 迁移失败：', err);
    throw err;
  } finally {
    await pool.end();
  }
}

// 运行迁移
migrateVocabulary().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
