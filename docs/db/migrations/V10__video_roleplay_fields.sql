-- V10: Add roleplay and character information to video_resources table
-- This migration adds fields for tracking video characters and roleplay capabilities

-- Roleplay and character fields
ALTER TABLE video_resources
  ADD COLUMN IF NOT EXISTS characters JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_roleplay_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_user_character TEXT,
  ADD COLUMN IF NOT EXISTS total_segments INTEGER DEFAULT 0;

-- Create index on is_roleplay_enabled for filtering roleplay videos
CREATE INDEX IF NOT EXISTS idx_video_resources_roleplay_enabled
  ON video_resources (is_roleplay_enabled)
  WHERE is_roleplay_enabled = TRUE;

-- Create GIN index on characters for efficient JSONB queries
CREATE INDEX IF NOT EXISTS idx_video_resources_characters
  ON video_resources USING gin (characters);

-- Add comments to describe the fields
COMMENT ON COLUMN video_resources.characters IS '视频中的角色列表，包含角色名称、台词数等信息 [{"name": "角色名", "line_count": 10, "segment_indices": [1,3,5]}]';
COMMENT ON COLUMN video_resources.is_roleplay_enabled IS '是否启用角色扮演功能';
COMMENT ON COLUMN video_resources.default_user_character IS '推荐用户扮演的默认角色名称';
COMMENT ON COLUMN video_resources.total_segments IS '视频转录的总片段数';
COMMENT ON COLUMN video_resources.duration_sec IS '视频时长（秒）';
