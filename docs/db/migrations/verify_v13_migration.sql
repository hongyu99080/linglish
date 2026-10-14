-- ============================================================================
-- V13 迁移验证脚本
-- ============================================================================
-- 用途: 快速验证词汇V2迁移是否成功
-- 使用: psql linklish -f verify_v9_migration.sql
-- ============================================================================

\echo '========================================'
\echo '  V13 Vocabulary Migration Verification'
\echo '========================================'
\echo ''

-- 1. 检查表结构
\echo '1. Checking table structures...'
SELECT
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'words')
        THEN '✓ words table exists'
        ELSE '✗ words table MISSING'
    END as words_check,
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_vocabulary')
        THEN '✓ user_vocabulary table exists'
        ELSE '✗ user_vocabulary table MISSING'
    END as user_vocabulary_check,
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_vocab_items')
        THEN '✓ user_vocab_items table exists (old)'
        ELSE '⚠ user_vocab_items table MISSING'
    END as old_table_check;

\echo ''

-- 2. 数据统计
\echo '2. Data Statistics:'
SELECT
    (SELECT COUNT(*) FROM user_vocab_items) as "Old Records (user_vocab_items)",
    (SELECT COUNT(DISTINCT lemma) FROM user_vocab_items WHERE lemma IS NOT NULL) as "Unique Words in Old Table",
    (SELECT COUNT(*) FROM words) as "Global Words (words)",
    (SELECT COUNT(*) FROM user_vocabulary) as "User Associations (user_vocabulary)",
    (SELECT COUNT(DISTINCT user_id) FROM user_vocabulary) as "Users with Vocabulary";

\echo ''

-- 3. 数据完整性检查
\echo '3. Data Integrity Checks:'

-- 检查孤立记录
SELECT
    COUNT(*) as orphaned_records,
    CASE
        WHEN COUNT(*) = 0 THEN '✓ No orphaned records'
        ELSE '✗ Found ' || COUNT(*) || ' orphaned records!'
    END as status
FROM user_vocabulary uv
LEFT JOIN words w ON w.id = uv.word_id
WHERE w.id IS NULL;

\echo ''

-- 检查迁移完整性（用户词汇数应该 >= 原始记录数）
WITH migration_stats AS (
    SELECT
        (SELECT COUNT(*) FROM user_vocab_items) as original_count,
        (SELECT COUNT(*) FROM user_vocabulary) as migrated_count
)
SELECT
    original_count,
    migrated_count,
    ROUND((migrated_count::numeric / NULLIF(original_count, 0) * 100), 2) as "Migration Completeness (%)",
    CASE
        WHEN migrated_count >= original_count * 0.95
        THEN '✓ Migration completeness OK (>95%)'
        ELSE '✗ WARNING: Migration may be incomplete!'
    END as status
FROM migration_stats;

\echo ''

-- 4. 全局词汇统计
\echo '4. Global Vocabulary Statistics:'
SELECT
    MIN(lookup_count) as "Min Learners",
    MAX(lookup_count) as "Max Learners",
    ROUND(AVG(lookup_count), 2) as "Avg Learners",
    COUNT(*) FILTER (WHERE lookup_count = 1) as "Words Learned by 1 User",
    COUNT(*) FILTER (WHERE lookup_count >= 2) as "Words Learned by 2+ Users"
FROM words;

\echo ''

-- 5. 用户词汇分布
\echo '5. User Vocabulary Distribution (Top 10 Users):'
SELECT
    u.username,
    COUNT(uv.id) as vocabulary_count,
    COUNT(*) FILTER (WHERE uv.status = 'mastered') as mastered,
    COUNT(*) FILTER (WHERE uv.status = 'learning') as learning,
    COUNT(*) FILTER (WHERE uv.status = 'unknown') as unknown
FROM users u
LEFT JOIN user_vocabulary uv ON uv.user_id = u.id
GROUP BY u.id, u.username
ORDER BY vocabulary_count DESC
LIMIT 10;

\echo ''

-- 6. 状态分布
\echo '6. Vocabulary Status Distribution:'
SELECT
    status,
    COUNT(*) as count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM user_vocabulary
GROUP BY status
ORDER BY count DESC;

\echo ''

-- 7. 迁移日志
\echo '7. Migration Log:'
SELECT
    version,
    description,
    executed_at,
    status
FROM migration_log
WHERE version = 'V13'
ORDER BY executed_at DESC
LIMIT 1;

\echo ''

-- 8. 抽样验证 - 随机检查3个词汇
\echo '8. Sample Words (Random 3):'
SELECT
    w.word,
    w.lookup_count as "Learners",
    COUNT(uv.id) as "Actual Associations",
    CASE
        WHEN w.lookup_count = COUNT(uv.id) THEN '✓ Match'
        ELSE '⚠ Mismatch'
    END as validation
FROM words w
LEFT JOIN user_vocabulary uv ON uv.word_id = w.id
GROUP BY w.id, w.word, w.lookup_count
ORDER BY RANDOM()
LIMIT 3;

\echo ''

-- 9. 重复检查
\echo '9. Duplicate Check:'
SELECT
    COUNT(*) as duplicate_user_words,
    CASE
        WHEN COUNT(*) = 0 THEN '✓ No duplicate user-word associations'
        ELSE '✗ Found ' || COUNT(*) || ' duplicate associations!'
    END as status
FROM (
    SELECT user_id, word_id, COUNT(*)
    FROM user_vocabulary
    GROUP BY user_id, word_id
    HAVING COUNT(*) > 1
) duplicates;

\echo ''

-- 10. 最终总结
\echo '========================================'
\echo '  Migration Verification Summary'
\echo '========================================'

DO $$
DECLARE
    words_count INTEGER;
    associations_count INTEGER;
    original_count INTEGER;
    orphaned_count INTEGER;
    migration_exists INTEGER;
    completeness NUMERIC;
    all_checks_passed BOOLEAN := TRUE;
BEGIN
    -- 收集所有统计数据
    SELECT COUNT(*) INTO words_count FROM words;
    SELECT COUNT(*) INTO associations_count FROM user_vocabulary;
    SELECT COUNT(*) INTO original_count FROM user_vocab_items;
    SELECT COUNT(*) INTO orphaned_count
    FROM user_vocabulary uv
    LEFT JOIN words w ON w.id = uv.word_id
    WHERE w.id IS NULL;
    SELECT COUNT(*) INTO migration_exists
    FROM migration_log WHERE version = 'V13';

    IF original_count > 0 THEN
        completeness := (associations_count::numeric / original_count * 100);
    ELSE
        completeness := 100;
    END IF;

    -- 输出统计
    RAISE NOTICE 'Global Words:       %', words_count;
    RAISE NOTICE 'User Associations:  %', associations_count;
    RAISE NOTICE 'Original Records:   %', original_count;
    RAISE NOTICE 'Completeness:       %%', ROUND(completeness, 2);
    RAISE NOTICE 'Orphaned Records:   %', orphaned_count;
    RAISE NOTICE 'Migration Logged:   %', CASE WHEN migration_exists > 0 THEN 'Yes' ELSE 'No' END;
    RAISE NOTICE '';

    -- 检查各项指标
    IF words_count = 0 THEN
        RAISE WARNING '✗ No words in global vocabulary!';
        all_checks_passed := FALSE;
    ELSE
        RAISE NOTICE '✓ Global vocabulary contains % words', words_count;
    END IF;

    IF associations_count < original_count * 0.95 THEN
        RAISE WARNING '✗ Migration incomplete: % < 95%% of original', ROUND(completeness, 2);
        all_checks_passed := FALSE;
    ELSE
        RAISE NOTICE '✓ Migration completeness: %%', ROUND(completeness, 2);
    END IF;

    IF orphaned_count > 0 THEN
        RAISE WARNING '✗ Found % orphaned records', orphaned_count;
        all_checks_passed := FALSE;
    ELSE
        RAISE NOTICE '✓ No orphaned records';
    END IF;

    IF migration_exists = 0 THEN
        RAISE WARNING '✗ Migration not logged in migration_log table';
        all_checks_passed := FALSE;
    ELSE
        RAISE NOTICE '✓ Migration logged successfully';
    END IF;

    RAISE NOTICE '';
    RAISE NOTICE '========================================';
    IF all_checks_passed THEN
        RAISE NOTICE '🎉 All checks passed! Migration successful!';
    ELSE
        RAISE WARNING '⚠️  Some checks failed. Please review warnings above.';
    END IF;
    RAISE NOTICE '========================================';
END $$;

\echo ''
