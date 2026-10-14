-- Ensure onboarding profile fields are present for first-day personalization.

CREATE TABLE IF NOT EXISTS user_profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  native_language VARCHAR(10) DEFAULT 'zh-CN',
  target_language VARCHAR(10) DEFAULT 'en',
  daily_goal INTEGER DEFAULT 15,
  interests TEXT[],
  theme VARCHAR(20) DEFAULT 'light',
  current_vocabulary_level VARCHAR(20) DEFAULT 'beginner',
  vocabulary_level_updated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
);

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS daily_goal INTEGER DEFAULT 15,
  ADD COLUMN IF NOT EXISTS interests TEXT[],
  ADD COLUMN IF NOT EXISTS current_vocabulary_level VARCHAR(20) DEFAULT 'beginner',
  ADD COLUMN IF NOT EXISTS vocabulary_level_updated_at TIMESTAMP;
