-- V2.6: Add YouTube video support
-- This migration adds fields to support YouTube videos alongside local videos

-- Add video_type column to distinguish between local and YouTube videos
ALTER TABLE video_resources
ADD COLUMN IF NOT EXISTS video_type VARCHAR(20) DEFAULT 'local' CHECK (video_type IN ('local', 'youtube'));

-- Add youtube_video_id for YouTube videos
ALTER TABLE video_resources
ADD COLUMN IF NOT EXISTS youtube_video_id VARCHAR(50);

-- Add index for youtube_video_id for quick lookups
CREATE INDEX IF NOT EXISTS idx_video_resources_youtube_id ON video_resources(youtube_video_id);
CREATE INDEX IF NOT EXISTS idx_video_resources_video_type ON video_resources(video_type);

-- Add comments
COMMENT ON COLUMN video_resources.video_type IS 'Type of video source: local (uploaded) or youtube (embedded)';
COMMENT ON COLUMN video_resources.youtube_video_id IS 'YouTube video ID (e.g., dQw4w9WgXcQ) for youtube type videos';

-- For YouTube videos, video_path will contain the YouTube watch URL
-- For local videos, video_path contains the file path as before
COMMENT ON COLUMN video_resources.video_path IS 'For local: file path; For youtube: YouTube watch URL';
