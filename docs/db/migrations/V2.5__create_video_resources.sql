-- V2.5: Create video_resources table
-- This migration creates the core video_resources table that was missing from the original migrations
-- It includes all fields needed for video management, content classification, and roleplay features

-- Create video_resources table
CREATE TABLE IF NOT EXISTS video_resources (
  id SERIAL PRIMARY KEY,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  video_path VARCHAR(1000) NOT NULL,
  thumbnail_path VARCHAR(1000),
  original_filename VARCHAR(500),
  duration_sec INTEGER,
  status VARCHAR(50) DEFAULT 'processing',
  failure_reason TEXT,

  -- File information
  file_size BIGINT,
  mime_type VARCHAR(100),
  file_hash VARCHAR(128),

  -- Content classification (from V9)
  tags TEXT[],
  category VARCHAR(100),
  difficulty_level VARCHAR(50),
  is_public BOOLEAN DEFAULT true,

  -- Learning-related
  subtitle_language VARCHAR(10),

  -- Roleplay fields (from V10)
  characters JSONB,
  is_roleplay_enabled BOOLEAN DEFAULT false,
  default_user_character VARCHAR(255),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_video_resources_uploader ON video_resources(uploader_id);
CREATE INDEX IF NOT EXISTS idx_video_resources_status ON video_resources(status);
CREATE INDEX IF NOT EXISTS idx_video_resources_created ON video_resources(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_resources_difficulty ON video_resources(difficulty_level);
CREATE INDEX IF NOT EXISTS idx_video_resources_category ON video_resources(category);
CREATE INDEX IF NOT EXISTS idx_video_resources_is_public ON video_resources(is_public);

-- Create video_sentences table for transcriptions
CREATE TABLE IF NOT EXISTS video_sentences (
  id SERIAL PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES video_resources(id) ON DELETE CASCADE,
  sentence_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_time_sec NUMERIC(10,3) NOT NULL,
  end_time_sec NUMERIC(10,3) NOT NULL,
  speaker VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(video_id, sentence_index)
);

CREATE INDEX IF NOT EXISTS idx_video_sentences_video ON video_sentences(video_id, sentence_index);
CREATE INDEX IF NOT EXISTS idx_video_sentences_time ON video_sentences(video_id, start_time_sec);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for video_resources
DROP TRIGGER IF EXISTS update_video_resources_updated_at ON video_resources;
CREATE TRIGGER update_video_resources_updated_at
  BEFORE UPDATE ON video_resources
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Add helpful comments
COMMENT ON TABLE video_resources IS 'Core table for video learning resources with metadata, classification, and roleplay support';
COMMENT ON TABLE video_sentences IS 'Timestamped transcript segments for videos with optional speaker identification';
COMMENT ON COLUMN video_resources.tags IS 'Array of tag names for categorization (e.g., 我的, 职场, 购物, 生活, 影视)';
COMMENT ON COLUMN video_resources.difficulty_level IS 'Learning difficulty: beginner, intermediate, or advanced';
COMMENT ON COLUMN video_resources.characters IS 'JSON array of roleplay character definitions with name, description, etc.';
COMMENT ON COLUMN video_resources.is_roleplay_enabled IS 'Whether this video supports roleplay practice mode';
COMMENT ON COLUMN video_resources.default_user_character IS 'Default character name for user in roleplay mode';
