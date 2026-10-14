-- ============================================================================
-- V13.1: 修复词汇翻译数据
-- ============================================================================
-- 问题: V13迁移时没有将翻译数据从 user_vocab_items 迁移到 words 表
-- 解决: 将翻译数据补充到 words 表的 definitions 字段
-- ============================================================================

BEGIN;

-- 更新 words 表，添加翻译数据
-- 策略：使用每个单词最常见的翻译（出现次数最多的）
-- definitions 是 JSONB 类型，需要转换格式
UPDATE words w
SET definitions = jsonb_build_object('zh', subq.translation),
    updated_at = NOW()
FROM (
  SELECT
    uvi.lemma,
    uvi.translation,
    COUNT(*) as freq,
    ROW_NUMBER() OVER (PARTITION BY uvi.lemma ORDER BY COUNT(*) DESC, LENGTH(uvi.translation) DESC) as rn
  FROM user_vocab_items uvi
  WHERE uvi.translation IS NOT NULL
    AND TRIM(uvi.translation) != ''
  GROUP BY uvi.lemma, uvi.translation
) subq
WHERE w.word = subq.lemma
  AND subq.rn = 1  -- 只取最常见的翻译
  AND w.definitions IS NULL;

-- 报告更新结果
DO $$
DECLARE
  updated_count INTEGER;
  total_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO updated_count
  FROM words
  WHERE definitions IS NOT NULL;

  SELECT COUNT(*) INTO total_count
  FROM words;

  RAISE NOTICE '----------------------------------------';
  RAISE NOTICE '翻译数据修复完成';
  RAISE NOTICE '  总词汇数: %', total_count;
  RAISE NOTICE '  有翻译的: %', updated_count;
  RAISE NOTICE '  无翻译的: %', total_count - updated_count;
  RAISE NOTICE '----------------------------------------';
END $$;

COMMIT;
