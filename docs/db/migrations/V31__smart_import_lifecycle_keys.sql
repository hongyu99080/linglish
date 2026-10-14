-- V31: close SmartImport sessions even when start-session is still in flight.

BEGIN;

ALTER TABLE video_learning_sessions
  ADD COLUMN IF NOT EXISTS lifecycle_key VARCHAR(36);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vls_user_lifecycle_key
  ON video_learning_sessions(user_id, lifecycle_key)
  WHERE lifecycle_key IS NOT NULL;

COMMENT ON COLUMN video_learning_sessions.lifecycle_key IS
  'Client-generated UUID v4. Unique per user and stable across start retries/unload closure.';

COMMIT;
