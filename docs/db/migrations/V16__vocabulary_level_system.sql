-- ============================================================================
-- V16: Vocabulary Level Classification System
-- ============================================================================
-- Purpose: Add vocabulary and video level classification for staged learning
-- Levels: beginner (1-3000), intermediate (3001-8000), advanced (8001+)

BEGIN;

-- ============================================================================
-- 1. Extend user_profiles with learning level settings
-- ============================================================================

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS current_vocabulary_level VARCHAR(20) DEFAULT 'beginner'
    CHECK (current_vocabulary_level IN ('beginner', 'intermediate', 'advanced')),
  ADD COLUMN IF NOT EXISTS vocabulary_level_auto_progress BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS vocabulary_level_updated_at TIMESTAMP;

COMMENT ON COLUMN user_profiles.current_vocabulary_level IS 'Current learning level: beginner(1-3000), intermediate(3001-8000), advanced(8001+)';
COMMENT ON COLUMN user_profiles.vocabulary_level_auto_progress IS 'Auto-progress to next level when current level is completed';
COMMENT ON COLUMN user_profiles.vocabulary_level_updated_at IS 'Last time learning level was updated';

-- ============================================================================
-- 2. Create vocabulary level configuration table
-- ============================================================================

CREATE TABLE IF NOT EXISTS vocabulary_level_config (
  id SERIAL PRIMARY KEY,
  level VARCHAR(20) NOT NULL UNIQUE,
  level_order INTEGER NOT NULL,
  rank_start INTEGER NOT NULL,
  rank_end INTEGER NOT NULL,
  display_name VARCHAR(50) NOT NULL,
  display_name_en VARCHAR(50),
  description TEXT,
  icon VARCHAR(20),
  completion_threshold DECIMAL(5,2) DEFAULT 80.00,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default level configurations
INSERT INTO vocabulary_level_config (level, level_order, rank_start, rank_end, display_name, display_name_en, description, icon, completion_threshold) VALUES
  ('beginner', 1, 1, 3000, '初级词汇', 'Beginner', '最常用的3000个核心词汇，日常交流必备', '🌱', 80.00),
  ('intermediate', 2, 3001, 8000, '中级词汇', 'Intermediate', '进阶5000个词汇，扩展表达能力', '🌿', 80.00),
  ('advanced', 3, 8001, 999999, '高级词汇', 'Advanced', '高级词汇，阅读与写作进阶', '🌳', 70.00)
ON CONFLICT (level) DO UPDATE SET
  rank_start = EXCLUDED.rank_start,
  rank_end = EXCLUDED.rank_end,
  display_name = EXCLUDED.display_name,
  display_name_en = EXCLUDED.display_name_en,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  completion_threshold = EXCLUDED.completion_threshold,
  updated_at = NOW();

-- ============================================================================
-- 3. Create user vocabulary level progress table
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_vocabulary_level_progress (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level VARCHAR(20) NOT NULL CHECK (level IN ('beginner', 'intermediate', 'advanced')),

  -- Progress statistics
  total_words INTEGER NOT NULL DEFAULT 0,
  learned_words INTEGER NOT NULL DEFAULT 0,
  mastered_words INTEGER NOT NULL DEFAULT 0,

  -- Completion status
  completion_percentage DECIMAL(5,2) DEFAULT 0,
  is_completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP,

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, level)
);

CREATE INDEX IF NOT EXISTS idx_vocab_level_progress_user ON user_vocabulary_level_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_vocab_level_progress_level ON user_vocabulary_level_progress(level, is_completed);

-- ============================================================================
-- 4. Create function to get word level by frequency rank
-- ============================================================================

CREATE OR REPLACE FUNCTION get_word_level_by_rank(freq_rank INTEGER)
RETURNS VARCHAR(20) AS $$
BEGIN
  IF freq_rank IS NULL OR freq_rank <= 0 THEN
    RETURN 'intermediate'; -- Default to intermediate if no rank
  ELSIF freq_rank <= 3000 THEN
    RETURN 'beginner';
  ELSIF freq_rank <= 8000 THEN
    RETURN 'intermediate';
  ELSE
    RETURN 'advanced';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- 5. Create view for words with computed level
-- ============================================================================

CREATE OR REPLACE VIEW words_with_level AS
SELECT
  w.*,
  CASE
    WHEN w.frequency_rank IS NULL OR w.frequency_rank <= 0 THEN 'intermediate'
    WHEN w.frequency_rank <= 3000 THEN 'beginner'
    WHEN w.frequency_rank <= 8000 THEN 'intermediate'
    ELSE 'advanced'
  END AS computed_level,
  CASE
    WHEN w.frequency_rank IS NULL OR w.frequency_rank <= 0 THEN 2
    WHEN w.frequency_rank <= 3000 THEN 1
    WHEN w.frequency_rank <= 8000 THEN 2
    ELSE 3
  END AS level_order
FROM words w;

-- ============================================================================
-- 6. Create view for user vocabulary level statistics
-- ============================================================================

CREATE OR REPLACE VIEW user_vocabulary_level_stats AS
SELECT
  uv.user_id,
  CASE
    WHEN w.frequency_rank IS NULL OR w.frequency_rank <= 0 THEN 'intermediate'
    WHEN w.frequency_rank <= 3000 THEN 'beginner'
    WHEN w.frequency_rank <= 8000 THEN 'intermediate'
    ELSE 'advanced'
  END AS level,
  COUNT(*) as total_in_level,
  COUNT(*) FILTER (WHERE uv.status NOT IN ('unknown', 'new') OR uv.status IS NULL) as learned_in_level,
  COUNT(*) FILTER (WHERE uv.status IN ('known', 'mastered')) as mastered_in_level
FROM user_vocabulary uv
LEFT JOIN words w ON w.id = uv.word_id
GROUP BY uv.user_id,
  CASE
    WHEN w.frequency_rank IS NULL OR w.frequency_rank <= 0 THEN 'intermediate'
    WHEN w.frequency_rank <= 3000 THEN 'beginner'
    WHEN w.frequency_rank <= 8000 THEN 'intermediate'
    ELSE 'advanced'
  END;

-- ============================================================================
-- 7. Add indexes for better query performance
-- ============================================================================

-- Index on words.frequency_rank if not exists
CREATE INDEX IF NOT EXISTS idx_words_frequency_rank ON words(frequency_rank) WHERE frequency_rank IS NOT NULL;

-- Partial indexes for each level to speed up level-based queries
CREATE INDEX IF NOT EXISTS idx_words_level_beginner ON words(id) WHERE frequency_rank > 0 AND frequency_rank <= 3000;
CREATE INDEX IF NOT EXISTS idx_words_level_intermediate ON words(id) WHERE frequency_rank > 3000 AND frequency_rank <= 8000;
CREATE INDEX IF NOT EXISTS idx_words_level_advanced ON words(id) WHERE frequency_rank > 8000;

-- ============================================================================
-- 8. Helper function to get global word count by level
-- ============================================================================

CREATE OR REPLACE FUNCTION get_level_word_counts()
RETURNS TABLE(level VARCHAR(20), word_count BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    CASE
      WHEN w.frequency_rank IS NULL OR w.frequency_rank <= 0 THEN 'intermediate'::VARCHAR(20)
      WHEN w.frequency_rank <= 3000 THEN 'beginner'::VARCHAR(20)
      WHEN w.frequency_rank <= 8000 THEN 'intermediate'::VARCHAR(20)
      ELSE 'advanced'::VARCHAR(20)
    END AS level,
    COUNT(*) as word_count
  FROM words w
  GROUP BY 1
  ORDER BY
    CASE
      WHEN level = 'beginner' THEN 1
      WHEN level = 'intermediate' THEN 2
      ELSE 3
    END;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
