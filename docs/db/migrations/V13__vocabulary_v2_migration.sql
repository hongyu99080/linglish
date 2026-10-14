-- ============================================================================
-- V13: Vocabulary V2 Migration - 全局唯一词汇系统数据迁移
-- ============================================================================
-- 描述: 将词汇数据从旧的 user_vocab_items 表迁移到新的全局唯一词汇系统
--       - words: 全局唯一词汇库（所有用户共享）
--       - user_vocabulary: 用户-词汇关联表（个人学习进度）
--
-- 设计理念:
--   每个单词全局只存储一次，多个用户可以学习同一个词
--   用户从视频导入词汇时自动贡献到全局词库
--
-- 执行时间: 预计 < 1分钟 (取决于词汇数量)
-- 可回滚: 是（见文件末尾的回滚脚本）
-- ============================================================================

-- 开始事务
BEGIN;

-- ============================================================================
-- STEP 1: 数据验证 - 确保源表存在且有数据
-- ============================================================================

DO $$
DECLARE
    vocab_count INTEGER;
BEGIN
    -- 检查 user_vocab_items 表是否存在
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'user_vocab_items'
    ) THEN
        RAISE NOTICE 'Warning: user_vocab_items table does not exist. Skipping migration.';
        RETURN;
    END IF;

    -- 统计现有词汇数量
    SELECT COUNT(*) INTO vocab_count FROM user_vocab_items;
    RAISE NOTICE 'Found % vocabulary records in user_vocab_items', vocab_count;

    IF vocab_count = 0 THEN
        RAISE NOTICE 'No vocabulary records to migrate.';
        RETURN;
    END IF;
END $$;


-- ============================================================================
-- STEP 2: 迁移唯一词汇到全局词汇表 (words)
-- ============================================================================

DO $$ BEGIN
    RAISE NOTICE 'Step 2: Migrating unique words to global vocabulary (words table)...';
END $$;

INSERT INTO words (
    word,                    -- 词汇原型
    word_lowercase,          -- 小写形式（用于查询）
    lookup_count,            -- 学习人数统计
    created_at,
    updated_at
)
SELECT DISTINCT
    uvi.lemma AS word,
    LOWER(uvi.lemma) AS word_lowercase,
    COUNT(DISTINCT uvi.user_id) AS lookup_count,  -- 统计有多少用户学习了这个词
    MIN(uvi.created_at) AS created_at,            -- 使用最早的创建时间
    NOW() AS updated_at
FROM user_vocab_items uvi
WHERE uvi.lemma IS NOT NULL
  AND TRIM(uvi.lemma) != ''
GROUP BY uvi.lemma
ON CONFLICT (word) DO UPDATE SET
    -- 如果词汇已存在（例如部分迁移后重新执行），更新统计信息
    lookup_count = words.lookup_count + EXCLUDED.lookup_count,
    updated_at = NOW();

-- 报告迁移结果
DO $$
DECLARE
    words_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO words_count FROM words;
    RAISE NOTICE '✓ Global vocabulary now contains % unique words', words_count;
END $$;


-- ============================================================================
-- STEP 3: 创建用户-词汇关联 (user_vocabulary)
-- ============================================================================

DO $$ BEGIN
    RAISE NOTICE 'Step 3: Creating user-vocabulary associations...';
END $$;

INSERT INTO user_vocabulary (
    user_id,
    word_id,
    word,
    status,                  -- 学习状态: unknown, learning, mastered
    mastery_level,           -- 掌握程度 0-100
    first_seen_at,
    last_reviewed_at,
    review_count,
    ease_factor,             -- SRS难度系数
    interval_days,           -- SRS复习间隔
    created_at,
    updated_at
)
SELECT
    uvi.user_id::bigint,
    w.id AS word_id,
    uvi.lemma AS word,
    -- 状态映射
    CASE uvi.state
        WHEN 'mastered' THEN 'mastered'
        WHEN 'reviewing' THEN 'learning'
        WHEN 'learning' THEN 'learning'
        ELSE 'unknown'
    END AS status,
    -- 掌握程度映射
    CASE uvi.state
        WHEN 'mastered' THEN 100
        WHEN 'reviewing' THEN 50
        WHEN 'learning' THEN 20
        ELSE 0
    END AS mastery_level,
    uvi.first_seen_at,
    uvi.last_review_at AS last_reviewed_at,
    COALESCE(uvi.review_count, 0) AS review_count,
    COALESCE(uvi.ease_factor, 2.5)::numeric(3,2) AS ease_factor,
    COALESCE(FLOOR(uvi.interval_days), 0)::integer AS interval_days,
    uvi.created_at,
    uvi.updated_at
FROM user_vocab_items uvi
JOIN words w ON w.word = uvi.lemma
WHERE uvi.lemma IS NOT NULL
  AND TRIM(uvi.lemma) != ''
ON CONFLICT (user_id, word_id) DO UPDATE SET
    -- 如果关联已存在，保留现有的学习进度（避免覆盖新数据）
    status = CASE
        WHEN user_vocabulary.mastery_level > EXCLUDED.mastery_level
        THEN user_vocabulary.status
        ELSE EXCLUDED.status
    END,
    mastery_level = GREATEST(user_vocabulary.mastery_level, EXCLUDED.mastery_level),
    updated_at = NOW();

-- 报告迁移结果
DO $$
DECLARE
    associations_count INTEGER;
    users_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO associations_count FROM user_vocabulary;
    SELECT COUNT(DISTINCT user_id) INTO users_count FROM user_vocabulary;
    RAISE NOTICE '✓ Created % user-vocabulary associations for % users',
        associations_count, users_count;
END $$;


-- ============================================================================
-- STEP 4: 数据验证
-- ============================================================================

DO $$ BEGIN
    RAISE NOTICE 'Step 4: Validating migration data integrity...';
END $$;

DO $$
DECLARE
    original_count INTEGER;
    migrated_count INTEGER;
    words_count INTEGER;
    orphaned_count INTEGER;
BEGIN
    -- 统计原始数据
    SELECT COUNT(*) INTO original_count FROM user_vocab_items;

    -- 统计迁移后的数据
    SELECT COUNT(*) INTO migrated_count FROM user_vocabulary;
    SELECT COUNT(*) INTO words_count FROM words;

    -- 检查是否有孤立的关联记录（没有对应的word_id）
    SELECT COUNT(*) INTO orphaned_count
    FROM user_vocabulary uv
    LEFT JOIN words w ON w.id = uv.word_id
    WHERE w.id IS NULL;

    RAISE NOTICE '----------------------------------------';
    RAISE NOTICE 'Migration Summary:';
    RAISE NOTICE '  Original records:      %', original_count;
    RAISE NOTICE '  Migrated associations: %', migrated_count;
    RAISE NOTICE '  Global unique words:   %', words_count;
    RAISE NOTICE '  Orphaned records:      %', orphaned_count;
    RAISE NOTICE '----------------------------------------';

    -- 数据完整性检查
    IF orphaned_count > 0 THEN
        RAISE WARNING 'Found % orphaned user_vocabulary records!', orphaned_count;
    END IF;

    IF migrated_count < original_count * 0.95 THEN
        RAISE WARNING 'Migration may be incomplete: expected ~% records, got %',
            original_count, migrated_count;
    END IF;

    IF migrated_count >= original_count * 0.95 THEN
        RAISE NOTICE '✓ Data integrity check passed!';
    END IF;
END $$;


-- ============================================================================
-- STEP 5: 创建迁移标记（可选，用于追踪迁移状态）
-- ============================================================================

-- 如果需要追踪迁移状态，可以创建一个标记表
CREATE TABLE IF NOT EXISTS migration_log (
    id SERIAL PRIMARY KEY,
    version VARCHAR(50) NOT NULL,
    description TEXT,
    executed_at TIMESTAMP DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'success'
);

INSERT INTO migration_log (version, description, status)
VALUES (
    'V13',
    'Vocabulary V2 Migration - Migrated vocabulary data to global unique words system',
    'success'
);

DO $$ BEGIN
    RAISE NOTICE '✓ Migration V13 completed successfully!';
END $$;


-- 提交事务
COMMIT;


-- ============================================================================
-- 迁移完成提示
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE '🎉 Vocabulary V2 Migration Complete!';
    RAISE NOTICE '========================================';
    RAISE NOTICE '';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '1. Update application code to use new vocabulary V2 APIs';
    RAISE NOTICE '2. Test the new vocabulary system thoroughly';
    RAISE NOTICE '3. Keep user_vocab_items table for backup (do not drop yet)';
    RAISE NOTICE '4. After 1-2 weeks of stable operation, consider dropping old table';
    RAISE NOTICE '';
    RAISE NOTICE 'API Endpoints:';
    RAISE NOTICE '  GET  /vocabulary/v2/my          - Get user vocabulary';
    RAISE NOTICE '  POST /vocabulary/v2/import-from-video - Import from video';
    RAISE NOTICE '  GET  /vocabulary/v2/full        - Browse full vocabulary';
    RAISE NOTICE '  GET  /vocabulary/v2/stats       - Get statistics';
    RAISE NOTICE '';
END $$;


-- ============================================================================
-- 回滚脚本 (如果需要回滚，请执行以下命令)
-- ============================================================================
--
-- 注意: 回滚将清空 words 和 user_vocabulary 表中的迁移数据
--       请在回滚前确保数据已备份！
--
-- BEGIN;
--
-- -- 删除本次迁移的记录
-- DELETE FROM migration_log WHERE version = 'V13';
--
-- -- 可选: 清空迁移的数据（谨慎操作！）
-- -- TRUNCATE TABLE user_vocabulary CASCADE;
-- -- DELETE FROM words WHERE id IN (
-- --     SELECT DISTINCT word_id FROM user_vocabulary
-- -- );
--
-- RAISE NOTICE 'Migration V13 rollback completed';
--
-- COMMIT;
-- ============================================================================
