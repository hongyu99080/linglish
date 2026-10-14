-- Commercial video publishing workflow.
-- User uploads remain private by default; publishing/featuring happens through
-- an auditable review request.

ALTER TABLE video_resources
ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_vip_only BOOLEAN DEFAULT FALSE;

ALTER TABLE video_resources
ALTER COLUMN is_public SET DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_video_resources_is_featured
ON video_resources (is_featured);

CREATE TABLE IF NOT EXISTS video_share_requests (
  id BIGSERIAL PRIMARY KEY,
  requester_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  video_resource_id INTEGER REFERENCES video_resources(id) ON DELETE CASCADE,
  request_type VARCHAR(20) NOT NULL DEFAULT 'public',
  note TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  review_note TEXT,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (request_type IN ('public', 'featured')),
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_video_share_requests_status
ON video_share_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_share_requests_video
ON video_share_requests (video_resource_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_share_requests_pending_unique
ON video_share_requests (requester_id, video_resource_id, request_type)
WHERE status = 'pending';
