-- ============================================================================
-- V21: League & Tier System
-- ============================================================================
-- Purpose: Implement Duolingo-style league competition system
--
-- Features:
--   1. Weekly league seasons
--   2. Five tiers: Bronze, Silver, Gold, Diamond, Master
--   3. Promotion/Demotion zones
--   4. Tier rewards and badges
--   5. Friend challenges
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. League Seasons
-- ============================================================================

CREATE TABLE IF NOT EXISTS league_seasons (
  id SERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL,
  season_year INTEGER NOT NULL,
  season_week INTEGER NOT NULL,
  season_name VARCHAR(100),
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT FALSE,
  is_completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(season_year, season_week)
);

CREATE INDEX idx_league_seasons_active ON league_seasons(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_league_seasons_dates ON league_seasons(start_date, end_date);

COMMENT ON TABLE league_seasons IS 'Weekly league season definitions';


-- ============================================================================
-- 2. League Tiers
-- ============================================================================

CREATE TABLE IF NOT EXISTS league_tiers (
  id SERIAL PRIMARY KEY,
  tier_key VARCHAR(20) NOT NULL UNIQUE,  -- 'bronze', 'silver', 'gold', 'diamond', 'master'
  tier_name VARCHAR(30) NOT NULL,
  tier_name_en VARCHAR(30) NOT NULL,
  tier_order INTEGER NOT NULL,
  min_xp_to_stay INTEGER DEFAULT 0,
  icon_url VARCHAR(100),
  color_code VARCHAR(10),
  promotion_slots INTEGER DEFAULT 10,
  demotion_slots INTEGER DEFAULT 10,
  safe_zone_slots INTEGER DEFAULT 30,
  users_per_group INTEGER DEFAULT 50,
  description TEXT,
  description_en TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE league_tiers IS 'Definition of league tiers with promotion/demotion rules';
COMMENT ON COLUMN league_tiers.promotion_slots IS 'Top N users get promoted';
COMMENT ON COLUMN league_tiers.demotion_slots IS 'Bottom N users get demoted';
COMMENT ON COLUMN league_tiers.users_per_group IS 'Users per competition group';

-- Insert default tiers
INSERT INTO league_tiers (tier_key, tier_name, tier_name_en, tier_order, min_xp_to_stay, icon_url, color_code, promotion_slots, demotion_slots, safe_zone_slots, users_per_group)
VALUES
  ('bronze', '青铜', 'Bronze', 1, 0, 'tier_bronze.svg', '#CD7F32', 15, 0, 35, 50),
  ('silver', '白银', 'Silver', 2, 50, 'tier_silver.svg', '#C0C0C0', 12, 10, 28, 50),
  ('gold', '黄金', 'Gold', 3, 100, 'tier_gold.svg', '#FFD700', 10, 12, 28, 50),
  ('diamond', '钻石', 'Diamond', 4, 200, 'tier_diamond.svg', '#B9F2FF', 8, 10, 32, 50),
  ('master', '大师', 'Master', 5, 300, 'tier_master.svg', '#9B30FF', 0, 5, 45, 50)
ON CONFLICT (tier_key) DO NOTHING;


-- ============================================================================
-- 3. League Groups (Competition Groups within a Tier)
-- ============================================================================

CREATE TABLE IF NOT EXISTS league_groups (
  id SERIAL PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
  tier_id INTEGER NOT NULL REFERENCES league_tiers(id),
  group_number INTEGER NOT NULL,
  max_users INTEGER DEFAULT 50,
  current_users INTEGER DEFAULT 0,
  is_full BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(season_id, tier_id, group_number)
);

CREATE INDEX idx_league_groups_season_tier ON league_groups(season_id, tier_id);
CREATE INDEX idx_league_groups_available ON league_groups(season_id, tier_id, is_full) WHERE is_full = FALSE;

COMMENT ON TABLE league_groups IS 'Competition groups within each tier for a season';


-- ============================================================================
-- 4. User League Status
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_league_status (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id INTEGER NOT NULL REFERENCES league_seasons(id),
  tier_id INTEGER NOT NULL REFERENCES league_tiers(id),
  group_id INTEGER REFERENCES league_groups(id),
  weekly_xp INTEGER DEFAULT 0,
  current_rank INTEGER,
  best_rank INTEGER,
  zone VARCHAR(20) DEFAULT 'safe',  -- 'promotion', 'safe', 'demotion'
  joined_at TIMESTAMP DEFAULT NOW(),
  last_xp_update TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, season_id)
);

CREATE INDEX idx_user_league_user ON user_league_status(user_id);
CREATE INDEX idx_user_league_season ON user_league_status(season_id);
CREATE INDEX idx_user_league_group ON user_league_status(group_id);
CREATE INDEX idx_user_league_ranking ON user_league_status(group_id, weekly_xp DESC);

COMMENT ON TABLE user_league_status IS 'User participation in current season';
COMMENT ON COLUMN user_league_status.zone IS 'Current zone: promotion (top), safe (middle), demotion (bottom)';


-- ============================================================================
-- 5. League History
-- ============================================================================

CREATE TABLE IF NOT EXISTS league_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id INTEGER NOT NULL REFERENCES league_seasons(id),
  tier_id INTEGER NOT NULL REFERENCES league_tiers(id),
  group_id INTEGER,
  final_rank INTEGER,
  final_xp INTEGER,
  participants_count INTEGER,
  was_promoted BOOLEAN DEFAULT FALSE,
  was_demoted BOOLEAN DEFAULT FALSE,
  rewards_claimed BOOLEAN DEFAULT FALSE,
  rewards_claimed_at TIMESTAMP,
  xp_reward INTEGER DEFAULT 0,
  coins_reward INTEGER DEFAULT 0,
  gems_reward INTEGER DEFAULT 0,
  badge_earned VARCHAR(50),
  finished_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, season_id)
);

CREATE INDEX idx_league_history_user ON league_history(user_id);
CREATE INDEX idx_league_history_season ON league_history(season_id);

COMMENT ON TABLE league_history IS 'Historical record of user league performance';


-- ============================================================================
-- 6. League Tier Rewards
-- ============================================================================

CREATE TABLE IF NOT EXISTS league_tier_rewards (
  id SERIAL PRIMARY KEY,
  tier_id INTEGER NOT NULL REFERENCES league_tiers(id),
  rank_start INTEGER,
  rank_end INTEGER,
  xp_reward INTEGER DEFAULT 0,
  coins_reward INTEGER DEFAULT 0,
  gems_reward INTEGER DEFAULT 0,
  badge_id VARCHAR(50),
  badge_icon VARCHAR(100),
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_league_rewards_tier ON league_tier_rewards(tier_id);

COMMENT ON TABLE league_tier_rewards IS 'Rewards configuration per tier and rank range';

-- Insert default rewards
INSERT INTO league_tier_rewards (tier_id, rank_start, rank_end, xp_reward, coins_reward, gems_reward, badge_id, description)
SELECT
  lt.id,
  1, 3,
  lt.tier_order * 100,
  lt.tier_order * 50,
  lt.tier_order * 2,
  lt.tier_key || '_top3',
  'Top 3 reward for ' || lt.tier_name_en
FROM league_tiers lt
ON CONFLICT DO NOTHING;

INSERT INTO league_tier_rewards (tier_id, rank_start, rank_end, xp_reward, coins_reward, gems_reward, description)
SELECT
  lt.id,
  4, 10,
  lt.tier_order * 50,
  lt.tier_order * 25,
  0,
  'Top 10 reward for ' || lt.tier_name_en
FROM league_tiers lt
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 7. Friend Challenges
-- ============================================================================

CREATE TABLE IF NOT EXISTS friend_challenges (
  id SERIAL PRIMARY KEY,
  challenger_id INTEGER NOT NULL REFERENCES users(id),
  challenged_id INTEGER NOT NULL REFERENCES users(id),
  challenge_type VARCHAR(30) NOT NULL,  -- 'weekly_xp', 'daily_xp', 'weekly_time', 'vocab_count'
  target_value INTEGER,
  duration_days INTEGER DEFAULT 7,
  start_date TIMESTAMP DEFAULT NOW(),
  end_date TIMESTAMP,
  challenger_score INTEGER DEFAULT 0,
  challenged_score INTEGER DEFAULT 0,
  winner_id INTEGER REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'active', 'completed', 'declined', 'cancelled'
  reward_xp INTEGER DEFAULT 100,
  reward_coins INTEGER DEFAULT 50,
  message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_friend_challenges_challenger ON friend_challenges(challenger_id);
CREATE INDEX idx_friend_challenges_challenged ON friend_challenges(challenged_id);
CREATE INDEX idx_friend_challenges_status ON friend_challenges(status);
CREATE INDEX idx_friend_challenges_active ON friend_challenges(status, end_date)
  WHERE status = 'active';

COMMENT ON TABLE friend_challenges IS 'One-on-one challenges between friends';
COMMENT ON COLUMN friend_challenges.challenge_type IS 'Type of competition: weekly_xp, daily_xp, weekly_time, vocab_count';


-- ============================================================================
-- 8. Add user columns for league
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS current_tier_id INTEGER REFERENCES league_tiers(id),
  ADD COLUMN IF NOT EXISTS league_joined_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS total_league_wins INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_promotions INTEGER DEFAULT 0;

-- Set default tier for existing users
UPDATE users
SET current_tier_id = (SELECT id FROM league_tiers WHERE tier_key = 'bronze')
WHERE current_tier_id IS NULL;


-- ============================================================================
-- 9. Helper Functions
-- ============================================================================

-- Function: Get or create current season
CREATE OR REPLACE FUNCTION get_or_create_current_season()
RETURNS league_seasons AS $$
DECLARE
  v_season league_seasons%ROWTYPE;
  v_week INTEGER;
  v_year INTEGER;
  v_start TIMESTAMP;
  v_end TIMESTAMP;
BEGIN
  -- Check for active season
  SELECT * INTO v_season
  FROM league_seasons
  WHERE is_active = TRUE
  LIMIT 1;

  IF v_season.id IS NOT NULL THEN
    RETURN v_season;
  END IF;

  -- Create new season
  v_year := EXTRACT(YEAR FROM CURRENT_DATE);
  v_week := EXTRACT(WEEK FROM CURRENT_DATE);
  v_start := date_trunc('week', CURRENT_DATE);
  v_end := v_start + INTERVAL '7 days' - INTERVAL '1 second';

  INSERT INTO league_seasons (season_number, season_year, season_week, season_name, start_date, end_date, is_active)
  VALUES (
    (SELECT COALESCE(MAX(season_number), 0) + 1 FROM league_seasons),
    v_year,
    v_week,
    v_year || '年第' || v_week || '周',
    v_start,
    v_end,
    TRUE
  )
  RETURNING * INTO v_season;

  RETURN v_season;
END;
$$ LANGUAGE plpgsql;


-- Function: Join user to league
CREATE OR REPLACE FUNCTION join_league(p_user_id INTEGER)
RETURNS user_league_status AS $$
DECLARE
  v_season league_seasons%ROWTYPE;
  v_tier_id INTEGER;
  v_group_id INTEGER;
  v_status user_league_status%ROWTYPE;
BEGIN
  -- Get current season
  SELECT * INTO v_season FROM get_or_create_current_season();

  -- Check if already joined
  SELECT * INTO v_status
  FROM user_league_status
  WHERE user_id = p_user_id AND season_id = v_season.id;

  IF v_status.id IS NOT NULL THEN
    RETURN v_status;
  END IF;

  -- Get user's current tier or default to bronze
  SELECT COALESCE(current_tier_id, (SELECT id FROM league_tiers WHERE tier_key = 'bronze'))
  INTO v_tier_id
  FROM users WHERE id = p_user_id;

  -- Find or create group
  SELECT id INTO v_group_id
  FROM league_groups
  WHERE season_id = v_season.id
    AND tier_id = v_tier_id
    AND is_full = FALSE
  LIMIT 1;

  IF v_group_id IS NULL THEN
    INSERT INTO league_groups (season_id, tier_id, group_number, current_users)
    VALUES (
      v_season.id,
      v_tier_id,
      (SELECT COALESCE(MAX(group_number), 0) + 1
       FROM league_groups
       WHERE season_id = v_season.id AND tier_id = v_tier_id),
      1
    )
    RETURNING id INTO v_group_id;
  ELSE
    UPDATE league_groups
    SET current_users = current_users + 1,
        is_full = (current_users + 1 >= max_users)
    WHERE id = v_group_id;
  END IF;

  -- Create user league status
  INSERT INTO user_league_status (user_id, season_id, tier_id, group_id)
  VALUES (p_user_id, v_season.id, v_tier_id, v_group_id)
  RETURNING * INTO v_status;

  -- Update user's league join date
  UPDATE users SET league_joined_at = NOW() WHERE id = p_user_id AND league_joined_at IS NULL;

  RETURN v_status;
END;
$$ LANGUAGE plpgsql;


-- Function: Add XP to user's league standing
CREATE OR REPLACE FUNCTION add_league_xp(p_user_id INTEGER, p_xp INTEGER)
RETURNS user_league_status AS $$
DECLARE
  v_status user_league_status%ROWTYPE;
  v_season league_seasons%ROWTYPE;
BEGIN
  -- Get current active season
  SELECT * INTO v_season FROM league_seasons WHERE is_active = TRUE LIMIT 1;

  IF v_season.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Get or create user status
  SELECT * INTO v_status
  FROM user_league_status
  WHERE user_id = p_user_id AND season_id = v_season.id;

  IF v_status.id IS NULL THEN
    SELECT * INTO v_status FROM join_league(p_user_id);
  END IF;

  -- Update XP
  UPDATE user_league_status
  SET weekly_xp = weekly_xp + p_xp,
      last_xp_update = NOW()
  WHERE id = v_status.id
  RETURNING * INTO v_status;

  RETURN v_status;
END;
$$ LANGUAGE plpgsql;


-- Function: Calculate rankings for a group
CREATE OR REPLACE FUNCTION calculate_group_rankings(p_group_id INTEGER)
RETURNS VOID AS $$
DECLARE
  v_tier league_tiers%ROWTYPE;
  v_total_users INTEGER;
BEGIN
  -- Get tier info
  SELECT lt.* INTO v_tier
  FROM league_tiers lt
  JOIN league_groups lg ON lg.tier_id = lt.id
  WHERE lg.id = p_group_id;

  -- Count users in group
  SELECT COUNT(*) INTO v_total_users
  FROM user_league_status
  WHERE group_id = p_group_id;

  -- Update rankings and zones
  WITH ranked AS (
    SELECT
      id,
      ROW_NUMBER() OVER (ORDER BY weekly_xp DESC, last_xp_update ASC) as new_rank
    FROM user_league_status
    WHERE group_id = p_group_id
  )
  UPDATE user_league_status uls
  SET
    current_rank = r.new_rank,
    best_rank = LEAST(COALESCE(uls.best_rank, r.new_rank), r.new_rank),
    zone = CASE
      WHEN r.new_rank <= v_tier.promotion_slots THEN 'promotion'
      WHEN r.new_rank > (v_total_users - v_tier.demotion_slots) THEN 'demotion'
      ELSE 'safe'
    END
  FROM ranked r
  WHERE uls.id = r.id;
END;
$$ LANGUAGE plpgsql;


-- Function: Process season end
CREATE OR REPLACE FUNCTION process_season_end(p_season_id INTEGER)
RETURNS INTEGER AS $$
DECLARE
  v_processed INTEGER := 0;
  v_user RECORD;
  v_new_tier_id INTEGER;
  v_reward RECORD;
BEGIN
  -- Process each user in the season
  FOR v_user IN
    SELECT uls.*, lt.tier_key, lt.tier_order
    FROM user_league_status uls
    JOIN league_tiers lt ON uls.tier_id = lt.id
    WHERE uls.season_id = p_season_id
  LOOP
    -- Determine new tier
    IF v_user.zone = 'promotion' AND v_user.tier_order < 5 THEN
      SELECT id INTO v_new_tier_id FROM league_tiers WHERE tier_order = v_user.tier_order + 1;
    ELSIF v_user.zone = 'demotion' AND v_user.tier_order > 1 THEN
      SELECT id INTO v_new_tier_id FROM league_tiers WHERE tier_order = v_user.tier_order - 1;
    ELSE
      v_new_tier_id := v_user.tier_id;
    END IF;

    -- Get rewards
    SELECT * INTO v_reward
    FROM league_tier_rewards
    WHERE tier_id = v_user.tier_id
      AND v_user.current_rank >= rank_start
      AND v_user.current_rank <= rank_end
      AND is_active = TRUE
    LIMIT 1;

    -- Create history record
    INSERT INTO league_history (
      user_id, season_id, tier_id, group_id, final_rank, final_xp,
      participants_count, was_promoted, was_demoted,
      xp_reward, coins_reward, gems_reward, badge_earned
    )
    VALUES (
      v_user.user_id, p_season_id, v_user.tier_id, v_user.group_id,
      v_user.current_rank, v_user.weekly_xp,
      (SELECT current_users FROM league_groups WHERE id = v_user.group_id),
      v_user.zone = 'promotion' AND v_user.tier_order < 5,
      v_user.zone = 'demotion' AND v_user.tier_order > 1,
      COALESCE(v_reward.xp_reward, 0),
      COALESCE(v_reward.coins_reward, 0),
      COALESCE(v_reward.gems_reward, 0),
      v_reward.badge_id
    )
    ON CONFLICT (user_id, season_id) DO NOTHING;

    -- Update user's tier
    UPDATE users
    SET current_tier_id = v_new_tier_id,
        total_promotions = total_promotions + CASE WHEN v_user.zone = 'promotion' THEN 1 ELSE 0 END,
        total_league_wins = total_league_wins + CASE WHEN v_user.current_rank = 1 THEN 1 ELSE 0 END
    WHERE id = v_user.user_id;

    v_processed := v_processed + 1;
  END LOOP;

  -- Mark season as completed
  UPDATE league_seasons
  SET is_active = FALSE, is_completed = TRUE
  WHERE id = p_season_id;

  RETURN v_processed;
END;
$$ LANGUAGE plpgsql;


-- Function: Claim league rewards
CREATE OR REPLACE FUNCTION claim_league_rewards(p_user_id INTEGER, p_season_id INTEGER)
RETURNS JSONB AS $$
DECLARE
  v_history league_history%ROWTYPE;
BEGIN
  SELECT * INTO v_history
  FROM league_history
  WHERE user_id = p_user_id AND season_id = p_season_id;

  IF v_history IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'HISTORY_NOT_FOUND');
  END IF;

  IF v_history.rewards_claimed THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'ALREADY_CLAIMED');
  END IF;

  -- Award rewards
  UPDATE users
  SET xp = xp + v_history.xp_reward,
      coins = coins + v_history.coins_reward,
      gems = gems + v_history.gems_reward
  WHERE id = p_user_id;

  -- Mark as claimed
  UPDATE league_history
  SET rewards_claimed = TRUE, rewards_claimed_at = NOW()
  WHERE id = v_history.id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'xp', v_history.xp_reward,
    'coins', v_history.coins_reward,
    'gems', v_history.gems_reward,
    'badge', v_history.badge_earned
  );
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 10. Views
-- ============================================================================

-- View: League leaderboard
CREATE OR REPLACE VIEW league_leaderboard AS
SELECT
  uls.id,
  uls.user_id,
  u.username,
  u.level,
  uls.season_id,
  uls.tier_id,
  lt.tier_key,
  lt.tier_name,
  lt.color_code,
  uls.group_id,
  uls.weekly_xp,
  uls.current_rank,
  uls.best_rank,
  uls.zone,
  uls.joined_at
FROM user_league_status uls
JOIN users u ON uls.user_id = u.id
JOIN league_tiers lt ON uls.tier_id = lt.id
ORDER BY uls.group_id, uls.weekly_xp DESC;

COMMENT ON VIEW league_leaderboard IS 'Complete leaderboard view with user and tier info';


-- View: User league summary
CREATE OR REPLACE VIEW user_league_summary AS
SELECT
  u.id AS user_id,
  u.username,
  u.current_tier_id,
  lt.tier_key,
  lt.tier_name,
  lt.tier_name_en,
  lt.color_code,
  lt.icon_url,
  u.total_league_wins,
  u.total_promotions,
  (SELECT COUNT(*) FROM league_history WHERE user_id = u.id) AS seasons_participated,
  uls.weekly_xp AS current_weekly_xp,
  uls.current_rank,
  uls.zone,
  ls.end_date AS season_ends_at
FROM users u
LEFT JOIN league_tiers lt ON u.current_tier_id = lt.id
LEFT JOIN league_seasons ls ON ls.is_active = TRUE
LEFT JOIN user_league_status uls ON uls.user_id = u.id AND uls.season_id = ls.id
WHERE u.status = 'active';

COMMENT ON VIEW user_league_summary IS 'Summary of user league status';


-- ============================================================================
-- 11. Triggers
-- ============================================================================

-- Trigger: Auto-update updated_at for friend_challenges
DROP TRIGGER IF EXISTS update_friend_challenges_timestamp ON friend_challenges;
CREATE TRIGGER update_friend_challenges_timestamp
  BEFORE UPDATE ON friend_challenges
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();


COMMIT;

-- ============================================================================
-- Migration Summary
-- ============================================================================
-- Tables created:
--   1. league_seasons - Weekly season definitions
--   2. league_tiers - Tier configurations
--   3. league_groups - Competition groups
--   4. user_league_status - User participation
--   5. league_history - Historical records
--   6. league_tier_rewards - Reward configurations
--   7. friend_challenges - 1v1 challenges
--
-- Columns added to users:
--   - current_tier_id
--   - league_joined_at
--   - total_league_wins
--   - total_promotions
--
-- Functions created:
--   - get_or_create_current_season()
--   - join_league(user_id)
--   - add_league_xp(user_id, xp)
--   - calculate_group_rankings(group_id)
--   - process_season_end(season_id)
--   - claim_league_rewards(user_id, season_id)
--
-- Views created:
--   - league_leaderboard
--   - user_league_summary
-- ============================================================================
