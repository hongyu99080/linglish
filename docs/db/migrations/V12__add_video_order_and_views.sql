-- V12: Add video manual ordering and view count tracking
-- This migration adds fields for manual video ordering and view count tracking

-- Add manual_order field for admin-controlled video ordering
ALTER TABLE video_resources
ADD COLUMN IF NOT EXISTS manual_order INTEGER DEFAULT NULL;

-- Add view_count field for tracking video popularity
ALTER TABLE video_resources
ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0 NOT NULL;

-- Create index for manual_order (for efficient sorting)
CREATE INDEX IF NOT EXISTS idx_video_resources_manual_order
ON video_resources(manual_order NULLS LAST);

-- Create index for view_count (for popularity sorting)
CREATE INDEX IF NOT EXISTS idx_video_resources_view_count
ON video_resources(view_count DESC);

-- Create composite index for sorting by manual_order first, then view_count
CREATE INDEX IF NOT EXISTS idx_video_resources_order_views
ON video_resources(manual_order NULLS LAST, view_count DESC);

-- Add comments
COMMENT ON COLUMN video_resources.manual_order IS 'Admin-set manual ordering priority. Lower numbers appear first. NULL means no manual order set.';
COMMENT ON COLUMN video_resources.view_count IS 'Number of times this video has been viewed/played';
