-- V30: retention loop — 计划反馈 + 本地XP迁移标记

CREATE TABLE IF NOT EXISTS plan_feedback (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_date DATE NOT NULL DEFAULT CURRENT_DATE,
  item_type VARCHAR(20) NOT NULL,  -- 'watch' | 'shadowing' | 'review' | 'overall'
  action VARCHAR(20) NOT NULL,     -- 'completed'|'skipped'|'too_hard'|'too_easy'|'boring'|'rating'
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  client_id VARCHAR(64),           -- 客户端幂等ID(仅非 rating 行);离线队列重放去重
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_feedback_user_time
  ON plan_feedback(user_id, created_at DESC);

-- 同一用户同日 action='rating' 仅一条(并发提交由此约束兜底)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_feedback_one_rating_per_day
  ON plan_feedback(user_id, plan_date) WHERE action = 'rating';

-- 离线队列重放幂等:请求已提交但响应丢失时,重放不会写入第二行。
-- rating 行的 client_id 恒为 NULL,故与上面的每日唯一索引互不冲突。
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_feedback_client_id
  ON plan_feedback(user_id, client_id) WHERE client_id IS NOT NULL;

-- 本地XP一次性迁移标记(user_id 主键即幂等锁)
CREATE TABLE IF NOT EXISTS local_xp_migrations (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  migrated_xp INTEGER NOT NULL DEFAULT 0,
  payload JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
