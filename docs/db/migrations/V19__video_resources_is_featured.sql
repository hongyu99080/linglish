-- Add missing is_featured flag for video_resources queries
ALTER TABLE video_resources
ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_video_resources_is_featured
ON video_resources (is_featured);
