-- V18: OAuth Support and Registration Flow Optimization
-- Purpose: Support Google OAuth and future OAuth providers (WeChat, Twitter, GitHub)
-- Also enables two-step registration (email first, level selection later)

BEGIN;

-- ============================================================================
-- 1. User OAuth Accounts Table
-- ============================================================================
-- Stores OAuth provider links, supports multiple providers per user

CREATE TABLE IF NOT EXISTS user_oauth_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Provider identification
  provider VARCHAR(50) NOT NULL,           -- 'google', 'wechat', 'twitter', 'github'
  provider_user_id VARCHAR(255) NOT NULL,  -- Provider's unique user ID

  -- Provider profile data
  provider_email VARCHAR(255),             -- Email from provider (may differ from user.email)
  provider_name VARCHAR(255),              -- Display name from provider
  provider_avatar_url TEXT,                -- Avatar URL from provider
  provider_profile JSONB,                  -- Full profile data from provider

  -- OAuth tokens (optional, for providers requiring refresh)
  access_token_encrypted TEXT,             -- Encrypted access token (if needed)
  refresh_token_encrypted TEXT,            -- Encrypted refresh token (if needed)
  token_expires_at TIMESTAMP,              -- Token expiration time

  -- Metadata
  scope TEXT[],                            -- Granted scopes
  raw_response JSONB,                      -- Raw OAuth response for debugging

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP,

  -- Constraints
  UNIQUE(provider, provider_user_id)       -- One account per provider user
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_oauth_user_id ON user_oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_provider_email ON user_oauth_accounts(provider, provider_email);
CREATE INDEX IF NOT EXISTS idx_oauth_provider_lookup ON user_oauth_accounts(provider, provider_user_id);

COMMENT ON TABLE user_oauth_accounts IS 'OAuth provider links for user accounts';
COMMENT ON COLUMN user_oauth_accounts.provider IS 'OAuth provider: google, wechat, twitter, github';
COMMENT ON COLUMN user_oauth_accounts.provider_user_id IS 'Unique user ID from the OAuth provider';


-- ============================================================================
-- 2. OAuth State Table (for CSRF prevention)
-- ============================================================================
-- Temporary storage for OAuth state parameter to prevent CSRF attacks

CREATE TABLE IF NOT EXISTS oauth_states (
  id BIGSERIAL PRIMARY KEY,
  state VARCHAR(64) UNIQUE NOT NULL,       -- Random state token
  provider VARCHAR(50) NOT NULL,           -- OAuth provider
  redirect_url TEXT,                       -- URL to redirect after auth
  extra_data JSONB,                        -- Additional data (e.g., registration intent)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL            -- State expires after 10 minutes
);

CREATE INDEX IF NOT EXISTS idx_oauth_state_lookup ON oauth_states(state);
CREATE INDEX IF NOT EXISTS idx_oauth_state_expiry ON oauth_states(expires_at);

COMMENT ON TABLE oauth_states IS 'Temporary OAuth state storage for CSRF prevention';


-- ============================================================================
-- 3. Update users table for OAuth-only users
-- ============================================================================
-- Allow password_hash to be NULL for OAuth-only users

ALTER TABLE users
  ALTER COLUMN password_hash DROP NOT NULL;

-- Add column to track registration method
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS registration_method VARCHAR(50) DEFAULT 'email';

-- Add columns for future email verification (reserved, not used yet)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email_verification_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMP;

COMMENT ON COLUMN users.registration_method IS 'How user registered: email, google, wechat, twitter, github';
COMMENT ON COLUMN users.email_verification_token IS 'Reserved: Token for email verification (future use)';


-- ============================================================================
-- 4. Helper function: Link OAuth account to user
-- ============================================================================

CREATE OR REPLACE FUNCTION link_oauth_account(
  p_user_id BIGINT,
  p_provider VARCHAR(50),
  p_provider_user_id VARCHAR(255),
  p_provider_email VARCHAR(255),
  p_provider_name VARCHAR(255),
  p_provider_avatar_url TEXT,
  p_provider_profile JSONB
)
RETURNS BIGINT AS $$
DECLARE
  v_oauth_id BIGINT;
BEGIN
  INSERT INTO user_oauth_accounts (
    user_id, provider, provider_user_id, provider_email,
    provider_name, provider_avatar_url, provider_profile,
    last_login_at
  )
  VALUES (
    p_user_id, p_provider, p_provider_user_id, p_provider_email,
    p_provider_name, p_provider_avatar_url, p_provider_profile,
    NOW()
  )
  ON CONFLICT (provider, provider_user_id)
  DO UPDATE SET
    provider_email = EXCLUDED.provider_email,
    provider_name = EXCLUDED.provider_name,
    provider_avatar_url = EXCLUDED.provider_avatar_url,
    provider_profile = EXCLUDED.provider_profile,
    last_login_at = NOW(),
    updated_at = NOW()
  RETURNING id INTO v_oauth_id;

  RETURN v_oauth_id;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 5. Cleanup function: Remove expired OAuth states
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_expired_oauth_states()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM oauth_states WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 6. Trigger: Auto-update updated_at on user_oauth_accounts
-- ============================================================================

-- Create update_timestamp function if not exists (may already exist from other migrations)
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_oauth_accounts_timestamp ON user_oauth_accounts;
CREATE TRIGGER update_oauth_accounts_timestamp
  BEFORE UPDATE ON user_oauth_accounts
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();


COMMIT;
