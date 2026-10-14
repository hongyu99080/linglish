CREATE TABLE IF NOT EXISTS password_resets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  requester_ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash
  ON password_resets (token_hash);

CREATE INDEX IF NOT EXISTS idx_password_resets_user_created
  ON password_resets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_resets_expiry
  ON password_resets (expires_at)
  WHERE used_at IS NULL;
