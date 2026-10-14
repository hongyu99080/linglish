-- ============================================================================
-- V20: Streak Enhancement System
-- 连胜增强系统：冻结卡、里程碑、召回通知
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Streak Freeze Configuration
-- ============================================================================

CREATE TABLE IF NOT EXISTS streak_freeze_config (
  id SERIAL PRIMARY KEY,
  freeze_type VARCHAR(20) NOT NULL UNIQUE,
  freeze_name VARCHAR(50) NOT NULL,
  freeze_name_en VARCHAR(50),
  description TEXT,
  cost_coins INTEGER DEFAULT 0,
  cost_gems INTEGER DEFAULT 0,
  duration_days INTEGER DEFAULT 1,
  max_per_month INTEGER DEFAULT 4,
  cooldown_days INTEGER DEFAULT 0,
  is_premium_only BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE streak_freeze_config IS 'Configuration for different types of streak freeze cards';
COMMENT ON COLUMN streak_freeze_config.freeze_type IS 'Types: daily, weekend, premium';
COMMENT ON COLUMN streak_freeze_config.max_per_month IS 'Maximum purchases allowed per month';

-- Default freeze types
INSERT INTO streak_freeze_config (freeze_type, freeze_name, freeze_name_en, description, cost_coins, duration_days, max_per_month) VALUES
  ('daily', '日常冻结卡', 'Daily Freeze', '保护一天的连胜', 200, 1, 4),
  ('weekend', '周末冻结卡', 'Weekend Freeze', '周末专用，更便宜', 100, 1, 2),
  ('premium', '高级冻结卡', 'Premium Freeze', 'VIP专属免费冻结', 0, 1, 999)
ON CONFLICT (freeze_type) DO NOTHING;


-- ============================================================================
-- 2. User Streak Freeze Inventory
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_streak_freeze_inventory (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  freeze_type VARCHAR(20) NOT NULL REFERENCES streak_freeze_config(freeze_type),
  quantity INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, freeze_type)
);

CREATE INDEX IF NOT EXISTS idx_streak_freeze_inv_user ON user_streak_freeze_inventory(user_id);

COMMENT ON TABLE user_streak_freeze_inventory IS 'User inventory of streak freeze cards';


-- ============================================================================
-- 3. Streak Freeze History
-- ============================================================================

CREATE TABLE IF NOT EXISTS streak_freeze_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  freeze_type VARCHAR(20) NOT NULL,
  action VARCHAR(20) NOT NULL,  -- 'purchase', 'use', 'expire', 'gift'
  protected_date DATE,          -- The date that was protected (for 'use' action)
  source VARCHAR(20),           -- 'shop', 'gift', 'reward', 'inventory'
  cost_type VARCHAR(10),        -- 'coins', 'gems', 'free'
  cost_amount INTEGER DEFAULT 0,
  streak_at_use INTEGER,        -- Streak count when freeze was used
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_streak_freeze_hist_user ON streak_freeze_history(user_id);
CREATE INDEX IF NOT EXISTS idx_streak_freeze_hist_date ON streak_freeze_history(protected_date);
CREATE INDEX IF NOT EXISTS idx_streak_freeze_hist_action ON streak_freeze_history(action);

COMMENT ON TABLE streak_freeze_history IS 'History of streak freeze purchases and usage';


-- ============================================================================
-- 4. Streak Milestones Definition
-- ============================================================================

CREATE TABLE IF NOT EXISTS streak_milestones (
  id SERIAL PRIMARY KEY,
  days_required INTEGER NOT NULL UNIQUE,
  milestone_name VARCHAR(50) NOT NULL,
  milestone_name_en VARCHAR(50),
  description TEXT,
  xp_reward INTEGER DEFAULT 0,
  coins_reward INTEGER DEFAULT 0,
  gems_reward INTEGER DEFAULT 0,
  badge_icon VARCHAR(100),
  celebration_type VARCHAR(20) DEFAULT 'standard',  -- 'standard', 'epic', 'legendary'
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE streak_milestones IS 'Definition of streak milestones and their rewards';
COMMENT ON COLUMN streak_milestones.celebration_type IS 'Types: standard (small animation), epic (medium), legendary (full screen)';

-- Default milestones
INSERT INTO streak_milestones (days_required, milestone_name, milestone_name_en, xp_reward, coins_reward, gems_reward, badge_icon, celebration_type) VALUES
  (3, '三天小试', 'Three Days', 30, 15, 0, 'streak_3.svg', 'standard'),
  (7, '一周坚持', 'One Week', 100, 50, 0, 'streak_7.svg', 'standard'),
  (14, '两周达人', 'Two Weeks', 200, 100, 5, 'streak_14.svg', 'standard'),
  (21, '三周学霸', 'Three Weeks', 300, 150, 10, 'streak_21.svg', 'epic'),
  (30, '月度冠军', 'Monthly Champion', 500, 250, 20, 'streak_30.svg', 'epic'),
  (50, '五十天传奇', 'Fifty Days', 800, 400, 30, 'streak_50.svg', 'epic'),
  (100, '百日大师', 'Century Master', 2000, 1000, 100, 'streak_100.svg', 'legendary'),
  (200, '双百英雄', 'Double Century', 4000, 2000, 200, 'streak_200.svg', 'legendary'),
  (365, '年度传奇', 'Year Legend', 10000, 5000, 500, 'streak_365.svg', 'legendary'),
  (500, '五百天神话', 'Five Hundred', 20000, 10000, 1000, 'streak_500.svg', 'legendary'),
  (1000, '千日圣者', 'Thousand Days', 50000, 25000, 2500, 'streak_1000.svg', 'legendary')
ON CONFLICT (days_required) DO NOTHING;


-- ============================================================================
-- 5. User Streak Milestones (Achieved)
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_streak_milestones (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone_id INTEGER NOT NULL REFERENCES streak_milestones(id),
  achieved_at TIMESTAMP DEFAULT NOW(),
  streak_at_achievement INTEGER,
  celebrated BOOLEAN DEFAULT FALSE,
  celebrated_at TIMESTAMP,
  UNIQUE(user_id, milestone_id)
);

CREATE INDEX IF NOT EXISTS idx_user_milestones_user ON user_streak_milestones(user_id);
CREATE INDEX IF NOT EXISTS idx_user_milestones_milestone ON user_streak_milestones(milestone_id);

COMMENT ON TABLE user_streak_milestones IS 'Milestones achieved by users';


-- ============================================================================
-- 6. Streak Recall Notifications
-- ============================================================================

CREATE TABLE IF NOT EXISTS streak_recall_notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(30) NOT NULL,  -- 'danger_warning', 'broken', 'comeback_3d', 'comeback_7d'
  channel VARCHAR(20) DEFAULT 'push',      -- 'push', 'email', 'sms'
  sent_at TIMESTAMP DEFAULT NOW(),
  opened_at TIMESTAMP,
  resulted_in_activity BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_streak_notif_user ON streak_recall_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_streak_notif_type ON streak_recall_notifications(notification_type);
CREATE INDEX IF NOT EXISTS idx_streak_notif_sent ON streak_recall_notifications(sent_at);

COMMENT ON TABLE streak_recall_notifications IS 'Tracking streak danger and recall notifications';
COMMENT ON COLUMN streak_recall_notifications.notification_type IS 'Types: danger_warning (9pm), broken (next day), comeback_Xd (X days later)';


-- ============================================================================
-- 7. Enhanced User Streak Tracking
-- ============================================================================

-- Add columns to existing users table for enhanced streak tracking
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS current_streak INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS longest_streak INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS streak_protected_today BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_streak_break_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS streak_breaks_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_streak_started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_activity_date DATE;

COMMENT ON COLUMN users.current_streak IS 'Current consecutive days streak';
COMMENT ON COLUMN users.longest_streak IS 'Longest streak ever achieved';
COMMENT ON COLUMN users.streak_protected_today IS 'Whether today is protected by a freeze';
COMMENT ON COLUMN users.current_streak_started_at IS 'When the current streak started';
COMMENT ON COLUMN users.last_activity_date IS 'Last date user had learning activity';


-- ============================================================================
-- 8. Helper Functions
-- ============================================================================

-- Function: Get user streak status
CREATE OR REPLACE FUNCTION get_user_streak_status(p_user_id INTEGER)
RETURNS TABLE (
  current_streak INTEGER,
  longest_streak INTEGER,
  streak_protected_today BOOLEAN,
  days_since_last_activity INTEGER,
  is_in_danger BOOLEAN,
  next_milestone_days INTEGER,
  next_milestone_name VARCHAR(50),
  available_freezes JSONB
) AS $$
DECLARE
  v_last_activity_date DATE;
  v_current_hour INTEGER;
BEGIN
  -- Get current streak and last activity
  SELECT
    COALESCE(u.current_streak, 0),
    COALESCE(u.longest_streak, 0),
    COALESCE(u.streak_protected_today, FALSE),
    u.last_activity_date
  INTO current_streak, longest_streak, streak_protected_today, v_last_activity_date
  FROM users u
  WHERE u.id = p_user_id;

  -- Calculate days since last activity
  IF v_last_activity_date IS NULL THEN
    days_since_last_activity := NULL;
  ELSE
    days_since_last_activity := CURRENT_DATE - v_last_activity_date;
  END IF;

  -- Check if in danger (after 9pm and no activity today)
  v_current_hour := EXTRACT(HOUR FROM CURRENT_TIMESTAMP);
  is_in_danger := (v_current_hour >= 21 AND (v_last_activity_date IS NULL OR v_last_activity_date < CURRENT_DATE));

  -- Get next milestone
  SELECT sm.days_required, sm.milestone_name
  INTO next_milestone_days, next_milestone_name
  FROM streak_milestones sm
  WHERE sm.days_required > current_streak
    AND NOT EXISTS (
      SELECT 1 FROM user_streak_milestones usm
      WHERE usm.user_id = p_user_id AND usm.milestone_id = sm.id
    )
  ORDER BY sm.days_required ASC
  LIMIT 1;

  -- Get available freezes
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'freeze_type', sfi.freeze_type,
    'quantity', sfi.quantity
  )), '[]'::jsonb)
  INTO available_freezes
  FROM user_streak_freeze_inventory sfi
  WHERE sfi.user_id = p_user_id AND sfi.quantity > 0;

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;


-- Function: Use a streak freeze
CREATE OR REPLACE FUNCTION use_streak_freeze(
  p_user_id INTEGER,
  p_freeze_type VARCHAR(20),
  p_protected_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB AS $$
DECLARE
  v_inventory_id INTEGER;
  v_quantity INTEGER;
  v_current_streak INTEGER;
  v_result JSONB;
BEGIN
  -- Check inventory
  SELECT id, quantity INTO v_inventory_id, v_quantity
  FROM user_streak_freeze_inventory
  WHERE user_id = p_user_id AND freeze_type = p_freeze_type;

  IF v_inventory_id IS NULL OR v_quantity <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'NO_FREEZE_AVAILABLE');
  END IF;

  -- Get current streak
  SELECT current_streak INTO v_current_streak
  FROM users WHERE id = p_user_id;

  -- Deduct from inventory
  UPDATE user_streak_freeze_inventory
  SET quantity = quantity - 1, updated_at = NOW()
  WHERE id = v_inventory_id;

  -- Record usage
  INSERT INTO streak_freeze_history (user_id, freeze_type, action, protected_date, source, streak_at_use)
  VALUES (p_user_id, p_freeze_type, 'use', p_protected_date, 'inventory', v_current_streak);

  -- Mark today as protected
  UPDATE users SET streak_protected_today = TRUE WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'protected_date', p_protected_date,
    'remaining', v_quantity - 1
  );
END;
$$ LANGUAGE plpgsql;


-- Function: Purchase a streak freeze
CREATE OR REPLACE FUNCTION purchase_streak_freeze(
  p_user_id INTEGER,
  p_freeze_type VARCHAR(20)
)
RETURNS JSONB AS $$
DECLARE
  v_config RECORD;
  v_user_coins INTEGER;
  v_user_gems INTEGER;
  v_monthly_purchases INTEGER;
BEGIN
  -- Get freeze config
  SELECT * INTO v_config
  FROM streak_freeze_config
  WHERE freeze_type = p_freeze_type AND is_active = TRUE;

  IF v_config IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FREEZE_TYPE');
  END IF;

  -- Get user balance
  SELECT COALESCE(coins, 0), COALESCE(gems, 0)
  INTO v_user_coins, v_user_gems
  FROM users WHERE id = p_user_id;

  -- Check monthly limit
  SELECT COUNT(*) INTO v_monthly_purchases
  FROM streak_freeze_history
  WHERE user_id = p_user_id
    AND freeze_type = p_freeze_type
    AND action = 'purchase'
    AND created_at >= DATE_TRUNC('month', CURRENT_DATE);

  IF v_monthly_purchases >= v_config.max_per_month THEN
    RETURN jsonb_build_object('success', false, 'error', 'MONTHLY_LIMIT_REACHED');
  END IF;

  -- Check balance and deduct
  IF v_config.cost_coins > 0 THEN
    IF v_user_coins < v_config.cost_coins THEN
      RETURN jsonb_build_object('success', false, 'error', 'INSUFFICIENT_COINS');
    END IF;
    UPDATE users SET coins = coins - v_config.cost_coins WHERE id = p_user_id;
  END IF;

  IF v_config.cost_gems > 0 THEN
    IF v_user_gems < v_config.cost_gems THEN
      RETURN jsonb_build_object('success', false, 'error', 'INSUFFICIENT_GEMS');
    END IF;
    UPDATE users SET gems = gems - v_config.cost_gems WHERE id = p_user_id;
  END IF;

  -- Add to inventory
  INSERT INTO user_streak_freeze_inventory (user_id, freeze_type, quantity)
  VALUES (p_user_id, p_freeze_type, 1)
  ON CONFLICT (user_id, freeze_type)
  DO UPDATE SET quantity = user_streak_freeze_inventory.quantity + 1, updated_at = NOW();

  -- Record purchase
  INSERT INTO streak_freeze_history (user_id, freeze_type, action, cost_type, cost_amount)
  VALUES (p_user_id, p_freeze_type, 'purchase',
    CASE WHEN v_config.cost_coins > 0 THEN 'coins' ELSE 'gems' END,
    CASE WHEN v_config.cost_coins > 0 THEN v_config.cost_coins ELSE v_config.cost_gems END);

  RETURN jsonb_build_object(
    'success', true,
    'cost_coins', v_config.cost_coins,
    'cost_gems', v_config.cost_gems
  );
END;
$$ LANGUAGE plpgsql;


-- Function: Check for new milestones
CREATE OR REPLACE FUNCTION check_streak_milestones(p_user_id INTEGER)
RETURNS TABLE (
  milestone_id INTEGER,
  milestone_name VARCHAR(50),
  days_required INTEGER,
  xp_reward INTEGER,
  coins_reward INTEGER,
  gems_reward INTEGER,
  celebration_type VARCHAR(20)
) AS $$
DECLARE
  v_current_streak INTEGER;
BEGIN
  SELECT current_streak INTO v_current_streak
  FROM users WHERE id = p_user_id;

  RETURN QUERY
  SELECT
    sm.id,
    sm.milestone_name,
    sm.days_required,
    sm.xp_reward,
    sm.coins_reward,
    sm.gems_reward,
    sm.celebration_type
  FROM streak_milestones sm
  WHERE sm.days_required <= v_current_streak
    AND NOT EXISTS (
      SELECT 1 FROM user_streak_milestones usm
      WHERE usm.user_id = p_user_id AND usm.milestone_id = sm.id
    )
  ORDER BY sm.days_required ASC;
END;
$$ LANGUAGE plpgsql;


-- Function: Claim a milestone reward
CREATE OR REPLACE FUNCTION claim_streak_milestone(
  p_user_id INTEGER,
  p_milestone_id INTEGER
)
RETURNS JSONB AS $$
DECLARE
  v_milestone RECORD;
  v_current_streak INTEGER;
  v_already_claimed BOOLEAN;
BEGIN
  -- Get milestone
  SELECT * INTO v_milestone FROM streak_milestones WHERE id = p_milestone_id;

  IF v_milestone IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'MILESTONE_NOT_FOUND');
  END IF;

  -- Get current streak
  SELECT current_streak INTO v_current_streak
  FROM users WHERE id = p_user_id;

  IF v_current_streak < v_milestone.days_required THEN
    RETURN jsonb_build_object('success', false, 'error', 'STREAK_NOT_REACHED');
  END IF;

  -- Check if already claimed
  SELECT EXISTS(
    SELECT 1 FROM user_streak_milestones
    WHERE user_id = p_user_id AND milestone_id = p_milestone_id
  ) INTO v_already_claimed;

  IF v_already_claimed THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_CLAIMED');
  END IF;

  -- Award rewards
  UPDATE users
  SET xp = COALESCE(xp, 0) + v_milestone.xp_reward,
      coins = COALESCE(coins, 0) + v_milestone.coins_reward,
      gems = COALESCE(gems, 0) + v_milestone.gems_reward
  WHERE id = p_user_id;

  -- Record achievement
  INSERT INTO user_streak_milestones (user_id, milestone_id, streak_at_achievement, celebrated, celebrated_at)
  VALUES (p_user_id, p_milestone_id, v_current_streak, TRUE, NOW())
  ON CONFLICT (user_id, milestone_id) DO UPDATE SET celebrated = TRUE, celebrated_at = NOW();

  RETURN jsonb_build_object(
    'success', true,
    'xp_reward', v_milestone.xp_reward,
    'coins_reward', v_milestone.coins_reward,
    'gems_reward', v_milestone.gems_reward,
    'badge_icon', v_milestone.badge_icon
  );
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 9. Triggers
-- ============================================================================

-- Note: update_timestamp() function should already exist from earlier migrations
-- If it doesn't exist, uncomment the following:
-- CREATE OR REPLACE FUNCTION update_timestamp()
-- RETURNS TRIGGER AS $$
-- BEGIN
--   NEW.updated_at = NOW();
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_streak_freeze_config_timestamp ON streak_freeze_config;
CREATE TRIGGER update_streak_freeze_config_timestamp
  BEFORE UPDATE ON streak_freeze_config
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_streak_freeze_inventory_timestamp ON user_streak_freeze_inventory;
CREATE TRIGGER update_streak_freeze_inventory_timestamp
  BEFORE UPDATE ON user_streak_freeze_inventory
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- ============================================================================
-- 10. Views
-- ============================================================================

-- View: User streak summary
CREATE OR REPLACE VIEW user_streak_summary AS
SELECT
  u.id AS user_id,
  u.username,
  u.current_streak,
  u.longest_streak,
  u.streak_protected_today,
  u.current_streak_started_at,
  u.streak_breaks_count,
  u.last_activity_date,
  (
    SELECT COUNT(*)
    FROM user_streak_milestones
    WHERE user_id = u.id
  ) AS milestones_achieved,
  (
    SELECT COALESCE(SUM(quantity), 0)
    FROM user_streak_freeze_inventory
    WHERE user_id = u.id
  ) AS total_freezes_available
FROM users u
WHERE u.status = 'active';

COMMENT ON VIEW user_streak_summary IS 'Summary of user streak status with milestones and freezes';


COMMIT;

-- ============================================================================
-- Migration Summary
-- ============================================================================
-- Tables created:
--   1. streak_freeze_config - Freeze card types and costs
--   2. user_streak_freeze_inventory - User's freeze card inventory
--   3. streak_freeze_history - Purchase and usage history
--   4. streak_milestones - Milestone definitions
--   5. user_streak_milestones - User milestone achievements
--   6. streak_recall_notifications - Notification tracking
--
-- Columns added to users:
--   - current_streak
--   - longest_streak
--   - streak_protected_today
--   - last_streak_break_at
--   - streak_breaks_count
--   - current_streak_started_at
--   - last_activity_date
--
-- Functions created:
--   - get_user_streak_status(user_id)
--   - use_streak_freeze(user_id, freeze_type, date)
--   - purchase_streak_freeze(user_id, freeze_type)
--   - check_streak_milestones(user_id)
--   - claim_streak_milestone(user_id, milestone_id)
--
-- Views created:
--   - user_streak_summary
-- ============================================================================
