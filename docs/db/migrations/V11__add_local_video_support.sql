-- V11: Add local video support for YouTube videos (mainland China optimization)
-- This migration adds fields to support downloading YouTube videos locally for mainland users

-- Add local_video_path field to store downloaded video file path
ALTER TABLE video_resources
  ADD COLUMN IF NOT EXISTS local_video_path VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS local_video_status VARCHAR(50) DEFAULT 'not_downloaded',
  ADD COLUMN IF NOT EXISTS youtube_video_id VARCHAR(20);

-- Create index for quick lookup of videos needing download
CREATE INDEX IF NOT EXISTS idx_video_resources_local_status
  ON video_resources(local_video_status)
  WHERE local_video_status IN ('downloading', 'pending');

-- Add comments
COMMENT ON COLUMN video_resources.local_video_path IS 'Local file path for downloaded YouTube videos (for mainland China users)';
COMMENT ON COLUMN video_resources.local_video_status IS 'Download status: not_downloaded, pending, downloading, completed, failed';
COMMENT ON COLUMN video_resources.youtube_video_id IS 'YouTube video ID (11 characters) for YouTube videos';
