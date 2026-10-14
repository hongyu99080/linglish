-- V10: Learning Statistics Tables
-- Tracks per-user streaks and daily learning activity for the stats dashboard.

-- ============================================================
-- learning_streaks
-- One row per user; updated whenever a learning activity is logged.
-- ============================================================
CREATE TABLE IF NOT EXISTS learning_streaks (
  id                SERIAL       PRIMARY KEY,
  user_id           INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_streak    INTEGER      NOT NULL DEFAULT 0,
  longest_streak    INTEGER      NOT NULL DEFAULT 0,
  last_active_date  DATE,
  updated_at        TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_learning_streaks_user UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_learning_streaks_user ON learning_streaks(user_id);

-- ============================================================
-- daily_learning_stats
-- One row per (user, date); upserted on each logged activity.
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_learning_stats (
  id                          SERIAL   PRIMARY KEY,
  user_id                     INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date                        DATE     NOT NULL DEFAULT CURRENT_DATE,
  minutes_studied             INTEGER  NOT NULL DEFAULT 0,
  words_learned               INTEGER  NOT NULL DEFAULT 0,
  words_reviewed              INTEGER  NOT NULL DEFAULT 0,
  articles_read               INTEGER  NOT NULL DEFAULT 0,
  training_sessions_completed INTEGER  NOT NULL DEFAULT 0,
  xp_earned                   INTEGER  NOT NULL DEFAULT 0,
  updated_at                  TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_daily_learning_stats_user_date UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_learning_stats_user      ON daily_learning_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_learning_stats_user_date ON daily_learning_stats(user_id, date DESC);

-- ============================================================
-- updated_at trigger (reuse existing function if present)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column'
  ) THEN
    CREATE FUNCTION update_updated_at_column()
    RETURNS TRIGGER LANGUAGE plpgsql AS '
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    ';
  END IF;
END;
$$;

CREATE TRIGGER trg_learning_streaks_updated_at
  BEFORE UPDATE ON learning_streaks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_daily_learning_stats_updated_at
  BEFORE UPDATE ON daily_learning_stats
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
