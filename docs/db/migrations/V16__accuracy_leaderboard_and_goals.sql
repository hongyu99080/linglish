-- V16: Accuracy Leaderboard and Personal Goals System
-- This migration adds:
-- 1. Weekly accuracy leaderboard configuration
-- 2. Personal goals table for tracking user-defined targets

-- ============================================
-- 1. Insert accuracy leaderboard configuration
-- ============================================
INSERT INTO leaderboards (name, display_name, scope, metric, time_range, max_entries, update_frequency)
VALUES ('weekly_accuracy', '本周发音达人榜', 'global', 'accuracy', 'weekly', 50, 'hourly')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 2. Personal Goals Table
-- ============================================
CREATE TABLE IF NOT EXISTS user_goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Goal definition
  goal_type VARCHAR(32) NOT NULL,        -- 'accuracy', 'practice_count', 'study_minutes'
  target_value REAL NOT NULL,            -- Target value (e.g., 85.0 for 85%)
  current_value REAL DEFAULT 0,          -- Current progress

  -- Time range
  time_range VARCHAR(16) NOT NULL,       -- 'daily', 'weekly', 'monthly'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,

  -- Status tracking
  status VARCHAR(16) DEFAULT 'active',   -- 'active', 'completed', 'failed', 'cancelled'
  completed_at TIMESTAMP,

  -- Rewards
  reward_xp INTEGER DEFAULT 0,
  reward_coins INTEGER DEFAULT 0,
  reward_badge VARCHAR(64),

  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),

  -- Prevent duplicate active goals of same type/range
  UNIQUE(user_id, goal_type, time_range, start_date)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_user_goals_user ON user_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_user_goals_active ON user_goals(user_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_user_goals_end_date ON user_goals(end_date, status);

-- ============================================
-- 3. Goal Presets Table (optional, for customizable presets)
-- ============================================
CREATE TABLE IF NOT EXISTS goal_presets (
  id SERIAL PRIMARY KEY,
  preset_key VARCHAR(64) UNIQUE NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  display_name_en VARCHAR(128),
  goal_type VARCHAR(32) NOT NULL,
  target_value REAL NOT NULL,
  time_range VARCHAR(16) NOT NULL,
  reward_xp INTEGER DEFAULT 0,
  reward_coins INTEGER DEFAULT 0,
  reward_badge VARCHAR(64),
  difficulty VARCHAR(16) DEFAULT 'medium',  -- 'easy', 'medium', 'hard'
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Insert default goal presets
INSERT INTO goal_presets (preset_key, display_name, display_name_en, goal_type, target_value, time_range, reward_xp, reward_coins, reward_badge, difficulty, sort_order)
VALUES
  ('accuracy_weekly_70', '本周准确度达70%', 'Weekly accuracy 70%', 'accuracy', 70, 'weekly', 50, 25, NULL, 'easy', 1),
  ('accuracy_weekly_80', '本周准确度达80%', 'Weekly accuracy 80%', 'accuracy', 80, 'weekly', 100, 50, NULL, 'medium', 2),
  ('accuracy_weekly_85', '本周准确度达85%', 'Weekly accuracy 85%', 'accuracy', 85, 'weekly', 200, 100, NULL, 'medium', 3),
  ('accuracy_weekly_90', '本周准确度达90%', 'Weekly accuracy 90%', 'accuracy', 90, 'weekly', 500, 200, 'accuracy_master', 'hard', 4),
  ('practice_weekly_10', '本周练习10次', 'Practice 10 times this week', 'practice_count', 10, 'weekly', 50, 25, NULL, 'easy', 10),
  ('practice_weekly_20', '本周练习20次', 'Practice 20 times this week', 'practice_count', 20, 'weekly', 150, 75, NULL, 'medium', 11),
  ('practice_weekly_50', '本周练习50次', 'Practice 50 times this week', 'practice_count', 50, 'weekly', 300, 150, 'practice_warrior', 'hard', 12),
  ('accuracy_daily_80', '今日准确度达80%', 'Daily accuracy 80%', 'accuracy', 80, 'daily', 30, 15, NULL, 'medium', 20),
  ('practice_daily_5', '今日练习5次', 'Practice 5 times today', 'practice_count', 5, 'daily', 20, 10, NULL, 'easy', 21)
ON CONFLICT (preset_key) DO NOTHING;

-- ============================================
-- 4. Goal completion history (for analytics)
-- ============================================
CREATE TABLE IF NOT EXISTS goal_completion_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id INTEGER REFERENCES user_goals(id) ON DELETE SET NULL,
  goal_type VARCHAR(32) NOT NULL,
  target_value REAL NOT NULL,
  achieved_value REAL NOT NULL,
  time_range VARCHAR(16) NOT NULL,
  reward_xp INTEGER DEFAULT 0,
  reward_coins INTEGER DEFAULT 0,
  reward_badge VARCHAR(64),
  completed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goal_history_user ON goal_completion_history(user_id);
CREATE INDEX IF NOT EXISTS idx_goal_history_date ON goal_completion_history(completed_at);

-- ============================================
-- Comments
-- ============================================
COMMENT ON TABLE user_goals IS 'User personal goals with progress tracking and rewards';
COMMENT ON TABLE goal_presets IS 'Predefined goal templates that users can choose from';
COMMENT ON TABLE goal_completion_history IS 'Historical record of completed goals for analytics';
COMMENT ON COLUMN user_goals.goal_type IS 'Type of goal: accuracy, practice_count, study_minutes';
COMMENT ON COLUMN user_goals.status IS 'Goal status: active, completed, failed, cancelled';
