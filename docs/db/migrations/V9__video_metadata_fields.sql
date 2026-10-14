-- V9: Add metadata fields to video_resources table
-- This migration adds comprehensive metadata tracking for video resources

-- File information fields
ALTER TABLE video_resources
  ADD COLUMN IF NOT EXISTS file_size BIGINT,
  ADD COLUMN IF NOT EXISTS mime_type VARCHAR(64),
  ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);

-- Content classification and management fields
ALTER TABLE video_resources
  ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS category VARCHAR(32),
  ADD COLUMN IF NOT EXISTS difficulty_level VARCHAR(16),
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS practice_count INTEGER DEFAULT 0;

-- Learning-related fields
ALTER TABLE video_resources
  ADD COLUMN IF NOT EXISTS subtitle_language VARCHAR(16),
  ADD COLUMN IF NOT EXISTS has_subtitles BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS word_count INTEGER,
  ADD COLUMN IF NOT EXISTS unique_word_count INTEGER;

-- Create index on file_hash for deduplication queries
CREATE INDEX IF NOT EXISTS idx_video_resources_file_hash
  ON video_resources (file_hash)
  WHERE file_hash IS NOT NULL;

-- Create index on category for filtering
CREATE INDEX IF NOT EXISTS idx_video_resources_category
  ON video_resources (category)
  WHERE category IS NOT NULL;

-- Create index on difficulty_level for filtering
CREATE INDEX IF NOT EXISTS idx_video_resources_difficulty
  ON video_resources (difficulty_level)
  WHERE difficulty_level IS NOT NULL;

-- Create index on is_public for access control
CREATE INDEX IF NOT EXISTS idx_video_resources_public
  ON video_resources (is_public);

-- Create index on tags using GIN for efficient JSONB queries
CREATE INDEX IF NOT EXISTS idx_video_resources_tags
  ON video_resources USING gin (tags);

-- Create index on view_count for sorting popular videos
CREATE INDEX IF NOT EXISTS idx_video_resources_view_count
  ON video_resources (view_count DESC);

-- Add comment to the table
COMMENT ON COLUMN video_resources.file_size IS '文件大小（字节）';
COMMENT ON COLUMN video_resources.mime_type IS 'MIME类型（如 video/mp4）';
COMMENT ON COLUMN video_resources.file_hash IS '文件哈希值（用于去重）';
COMMENT ON COLUMN video_resources.tags IS '标签数组';
COMMENT ON COLUMN video_resources.category IS '分类（如 education, entertainment）';
COMMENT ON COLUMN video_resources.difficulty_level IS '难度级别（如 beginner, intermediate, advanced）';
COMMENT ON COLUMN video_resources.is_public IS '是否公开';
COMMENT ON COLUMN video_resources.view_count IS '观看次数';
COMMENT ON COLUMN video_resources.practice_count IS '练习次数';
COMMENT ON COLUMN video_resources.subtitle_language IS '字幕语言';
COMMENT ON COLUMN video_resources.has_subtitles IS '是否有字幕';
COMMENT ON COLUMN video_resources.word_count IS '单词数量';
COMMENT ON COLUMN video_resources.unique_word_count IS '唯一单词数量';
