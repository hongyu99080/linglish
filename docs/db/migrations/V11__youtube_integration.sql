-- V11: Add YouTube integration fields to video_resources table
-- This migration adds fields for supporting YouTube videos

-- Add YouTube-related fields
ALTER TABLE video_resources
  ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS youtube_url TEXT,
  ADD COLUMN IF NOT EXISTS youtube_video_id VARCHAR(20),
  ADD COLUMN IF NOT EXISTS transcript TEXT,
  ADD COLUMN IF NOT EXISTS transcript_segments JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS has_subtitles BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS word_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unique_word_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS practice_count INTEGER DEFAULT 0;

-- Create index on source for filtering
CREATE INDEX IF NOT EXISTS idx_video_resources_source ON video_resources(source);

-- Create index on youtube_video_id for deduplication
CREATE INDEX IF NOT EXISTS idx_video_resources_youtube_id ON video_resources(youtube_video_id)
  WHERE youtube_video_id IS NOT NULL;

-- Add comments
COMMENT ON COLUMN video_resources.source IS 'Video source: upload (本地上传), youtube (YouTube导入), youtube_temp (YouTube临时观看)';
COMMENT ON COLUMN video_resources.youtube_url IS 'Original YouTube URL if source is youtube or youtube_temp';
COMMENT ON COLUMN video_resources.youtube_video_id IS 'YouTube video ID extracted from URL';
COMMENT ON COLUMN video_resources.transcript IS 'Full transcript text from video or YouTube captions';
COMMENT ON COLUMN video_resources.transcript_segments IS 'Timestamped transcript segments with speaker info';
COMMENT ON COLUMN video_resources.has_subtitles IS 'Whether video has transcript/subtitles available';
COMMENT ON COLUMN video_resources.word_count IS 'Total word count in transcript';
COMMENT ON COLUMN video_resources.unique_word_count IS 'Unique word count in transcript';
COMMENT ON COLUMN video_resources.view_count IS 'Number of times video was viewed';
COMMENT ON COLUMN video_resources.practice_count IS 'Number of practice sessions with this video';
