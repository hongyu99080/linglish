/**
 * V7 AI Learning Engine - Simplified Version
 * Only creates essential AI tables without complex views
 * This version avoids column reference issues with existing tables
 */

BEGIN;

-- ============================================
-- 1. User Learning Goals
-- ============================================
CREATE TABLE IF NOT EXISTS user_learning_goals (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_type VARCHAR(50) NOT NULL, -- 'vocabulary_size', 'reading_speed', 'comprehension', 'fluency'
  target_value INTEGER,
  current_value INTEGER DEFAULT 0,
  target_date DATE,
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'completed', 'paused'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_goals ON user_learning_goals(user_id, status);

COMMENT ON TABLE user_learning_goals IS '用户学习目标';

-- ============================================
-- 2. User Interests
-- ============================================
CREATE TABLE IF NOT EXISTS user_interests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_type VARCHAR(30) NOT NULL, -- 'topic', 'genre', 'difficulty'
  interest_value VARCHAR(100) NOT NULL,
  preference_score DECIMAL(3,2) DEFAULT 0.50, -- 0-1, learned from user behavior
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, interest_type, interest_value)
);

CREATE INDEX idx_user_interests_user ON user_interests(user_id, preference_score DESC);

-- ============================================
-- 3. Learning Paths
-- ============================================
CREATE TABLE IF NOT EXISTS learning_paths (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path_name VARCHAR(200) NOT NULL,
  path_description TEXT,
  difficulty_level VARCHAR(20), -- A1-C2
  estimated_weeks INTEGER,
  ai_reasoning TEXT, -- Why this path was chosen
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'completed', 'paused'
  progress_percentage INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_paths_user_status ON learning_paths(user_id, status);

COMMENT ON TABLE learning_paths IS 'AI生成的个性化学习路径';
COMMENT ON COLUMN learning_paths.ai_reasoning IS 'AI选择此路径的理由';

-- ============================================
-- 4. Learning Milestones
-- ============================================
CREATE TABLE IF NOT EXISTS learning_milestones (
  id BIGSERIAL PRIMARY KEY,
  path_id BIGINT NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  milestone_number INTEGER NOT NULL,
  milestone_title VARCHAR(200),
  milestone_description TEXT,
  target_date DATE,
  completed_date DATE,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'in_progress', 'completed'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_milestones_path ON learning_milestones(path_id, milestone_number);

-- ============================================
-- 5. Daily Plans
-- ============================================
CREATE TABLE IF NOT EXISTS daily_plans (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_date DATE NOT NULL,
  ai_reasoning TEXT, -- Why this plan was generated
  estimated_minutes INTEGER,
  actual_minutes INTEGER,
  completion_rate DECIMAL(3,2), -- 0-1
  user_feedback TEXT,
  feedback_rating INTEGER CHECK (feedback_rating BETWEEN 1 AND 5),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, plan_date)
);

CREATE INDEX idx_daily_plans_user_date ON daily_plans(user_id, plan_date DESC);

COMMENT ON TABLE daily_plans IS 'AI生成的每日学习计划';
COMMENT ON COLUMN daily_plans.ai_reasoning IS 'AI生成此计划的理由';

-- ============================================
-- 6. Daily Plan Activities
-- ============================================
CREATE TABLE IF NOT EXISTS daily_plan_activities (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
  activity_order INTEGER NOT NULL,
  activity_type VARCHAR(50) NOT NULL, -- 'reading', 'shadowing', 'vocabulary_review', etc.
  activity_title VARCHAR(200),
  activity_description TEXT,
  estimated_minutes INTEGER,
  target_resource_id BIGINT, -- article_id, media_id, etc.
  target_resource_type VARCHAR(50), -- 'article', 'media', 'vocabulary_set'
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP,
  ai_reasoning TEXT, -- Why this activity was included
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_activities_plan ON daily_plan_activities(plan_id, activity_order);

-- ============================================
-- 7. AI Chat History
-- ============================================
CREATE TABLE IF NOT EXISTS ai_chat_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  message_number INTEGER NOT NULL,
  role VARCHAR(20) NOT NULL, -- 'user', 'assistant', 'system'
  content TEXT NOT NULL,
  intent VARCHAR(50), -- 'question', 'explanation', 'encouragement', etc.
  referenced_resource_id BIGINT,
  referenced_resource_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_chat_user_convo ON ai_chat_history(user_id, conversation_id, message_number);

COMMENT ON TABLE ai_chat_history IS 'AI对话历史记录';

-- ============================================
-- 8. Competency Assessments
-- ============================================
CREATE TABLE IF NOT EXISTS competency_assessments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assessment_date DATE NOT NULL,
  dimension VARCHAR(50) NOT NULL, -- 'vocabulary', 'reading', 'listening', 'speaking'
  score_value DECIMAL(5,2),
  cefr_level VARCHAR(10), -- A1, A2, B1, B2, C1, C2
  ai_analysis TEXT,
  confidence_score DECIMAL(3,2), -- 0-1, how confident is the assessment
  data_source VARCHAR(50), -- 'user_activity', 'explicit_test', 'ai_inference'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_assess_user_date ON competency_assessments(user_id, assessment_date DESC);
CREATE INDEX idx_assess_dimension ON competency_assessments(user_id, dimension, assessment_date DESC);

COMMENT ON TABLE competency_assessments IS 'AI能力评估记录';

-- ============================================
-- 9. Learning Interventions
-- ============================================
CREATE TABLE IF NOT EXISTS learning_interventions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intervention_type VARCHAR(50) NOT NULL, -- 'difficulty_adjustment', 'encouragement', 'strategy_suggestion'
  trigger_condition TEXT, -- What triggered this intervention
  intervention_content TEXT, -- What the AI suggested/did
  delivered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  user_response VARCHAR(20), -- 'accepted', 'rejected', 'ignored'
  effectiveness_score DECIMAL(3,2), -- 0-1, measured by subsequent behavior
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_interventions_user ON learning_interventions(user_id, delivered_at DESC);

COMMENT ON TABLE learning_interventions IS 'AI学习干预记录';

-- ============================================
-- 10. Content Recommendations
-- ============================================
CREATE TABLE IF NOT EXISTS content_recommendations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type VARCHAR(50) NOT NULL, -- 'article', 'media', 'vocabulary_set'
  content_id BIGINT NOT NULL,
  recommendation_score DECIMAL(5,4), -- 0-1
  recommendation_reason TEXT, -- AI reasoning
  context VARCHAR(100), -- 'daily_plan', 'browse_suggestion', 'post_activity'
  presented_at TIMESTAMP,
  user_action VARCHAR(20), -- 'viewed', 'skipped', 'saved', 'completed'
  action_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reco_user ON content_recommendations(user_id, created_at DESC);
CREATE INDEX idx_reco_content ON content_recommendations(content_type, content_id);
CREATE INDEX idx_reco_score ON content_recommendations(user_id, recommendation_score DESC);

COMMENT ON TABLE content_recommendations IS 'AI内容推荐记录';

-- ============================================
-- 11. AI API Calls (Cost Tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS ai_api_calls (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  model VARCHAR(100) NOT NULL,
  endpoint VARCHAR(100),
  purpose VARCHAR(100), -- 'daily_plan', 'chat', 'assessment', etc.
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd DECIMAL(10,6),
  response_time_ms INTEGER,
  status VARCHAR(20) DEFAULT 'success', -- 'success', 'error', 'timeout'
  error_message TEXT,
  error_code VARCHAR(50),
  cache_hit BOOLEAN DEFAULT FALSE,
  cache_key VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_api_calls_user ON ai_api_calls(user_id, created_at DESC);
CREATE INDEX idx_api_calls_date ON ai_api_calls(created_at DESC);
CREATE INDEX idx_api_calls_purpose ON ai_api_calls(purpose, created_at DESC);
CREATE INDEX idx_api_calls_cost ON ai_api_calls(created_at DESC, cost_usd);

COMMENT ON TABLE ai_api_calls IS 'OpenAI API调用日志和成本追踪';

-- ============================================
-- 12. Learning Goal Templates
-- ============================================
CREATE TABLE IF NOT EXISTS learning_goal_templates (
  id BIGSERIAL PRIMARY KEY,
  template_name VARCHAR(200) NOT NULL,
  goal_type VARCHAR(50) NOT NULL,
  description TEXT,
  target_value INTEGER,
  recommended_duration_weeks INTEGER,
  difficulty_level VARCHAR(20),
  prerequisites TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_goal_templates_type ON learning_goal_templates(goal_type);

COMMENT ON TABLE learning_goal_templates IS '学习目标模板库';

-- ============================================
-- Insert Default Goal Templates
-- ============================================
INSERT INTO learning_goal_templates (template_name, goal_type, target_value, recommended_duration_weeks, difficulty_level, description) VALUES
('Beginner Vocabulary Builder', 'vocabulary_size', 1000, 12, 'A1-A2', 'Build foundational vocabulary for everyday conversations'),
('Intermediate Reader', 'vocabulary_size', 3000, 24, 'B1-B2', 'Develop vocabulary for reading intermediate texts'),
('Advanced Learner', 'vocabulary_size', 5000, 36, 'C1', 'Master advanced vocabulary for academic and professional contexts'),
('Reading Speed Improvement', 'reading_speed', 200, 12, 'B1+', 'Increase reading speed to 200 words per minute'),
('Fluency Development', 'fluency', 80, 24, 'B2+', 'Achieve 80% fluency in spoken English')
ON CONFLICT DO NOTHING;

COMMIT;

-- ============================================
-- Verification
-- ============================================
DO $$
DECLARE
  table_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN (
    'user_learning_goals', 'user_interests', 'learning_paths',
    'learning_milestones', 'daily_plans', 'daily_plan_activities',
    'ai_chat_history', 'competency_assessments', 'learning_interventions',
    'content_recommendations', 'ai_api_calls', 'learning_goal_templates'
  );

  IF table_count = 12 THEN
    RAISE NOTICE '✅ All 12 AI tables created successfully!';
  ELSE
    RAISE WARNING '⚠️ Only % out of 12 tables were created', table_count;
  END IF;
END $$;

-- Cost summary query for verification
SELECT
  'Total API calls logged: ' || COUNT(*) as summary
FROM ai_api_calls;
