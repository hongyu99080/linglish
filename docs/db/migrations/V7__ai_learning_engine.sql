-- ============================================
-- V7: AI学习引擎数据模型
-- ============================================
-- 支持AI驱动的个性化学习路径和智能助手
-- 创建日期: 2025-10-21
-- 依赖: V1-V6已执行

BEGIN;

-- ============================================
-- 1. 用户学习目标和偏好
-- ============================================

-- 用户学习目标表
CREATE TABLE IF NOT EXISTS user_learning_goals (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  -- 主要目标
  primary_goal VARCHAR(50) NOT NULL,
  -- exam_prep, business_english, daily_conversation, academic, general_improvement

  -- 具体子目标
  sub_goals JSONB,
  -- 示例: ["IELTS 7.0", "Business presentations"]

  -- 目标等级
  target_level VARCHAR(5), -- A1, A2, B1, B2, C1, C2
  target_vocabulary_size INT, -- 目标词汇量

  -- 时间线
  target_date DATE,
  estimated_weeks INT,

  -- 学习偏好
  daily_time_minutes INT DEFAULT 30,
  preferred_time_of_day VARCHAR(20)[], -- ["morning", "evening"]
  learning_style VARCHAR(20), -- visual, auditory, kinesthetic, reading

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id)
);

COMMENT ON TABLE user_learning_goals IS '用户学习目标和偏好 - AI规划路径的基础';

-- 用户兴趣主题表
CREATE TABLE IF NOT EXISTS user_interests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  topic VARCHAR(100) NOT NULL,
  weight DECIMAL(3,2) DEFAULT 1.0, -- 兴趣权重,1.0=普通,2.0=非常感兴趣

  -- 来源
  source VARCHAR(50), -- 'onboarding', 'inferred', 'user_added'

  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id, topic)
);

CREATE INDEX idx_user_interests_user ON user_interests(user_id, weight DESC);

-- ============================================
-- 2. AI学习路径系统
-- ============================================

-- 学习路径主表
CREATE TABLE IF NOT EXISTS learning_paths (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  -- 路径基本信息
  path_name VARCHAR(200),
  description TEXT,

  -- 水平信息
  start_level VARCHAR(5) NOT NULL,
  target_level VARCHAR(5) NOT NULL,
  estimated_weeks INT NOT NULL,

  -- 路径内容(JSON格式,灵活存储)
  path_data JSONB NOT NULL,
  -- 包含: phases, weeks, milestones, themes等
  -- 示例: { "phases": [...], "weekly_themes": [...], "milestones": [...] }

  -- 进度追踪
  status VARCHAR(20) DEFAULT 'active', -- active, paused, completed, abandoned
  current_week INT DEFAULT 0,
  current_phase INT DEFAULT 0,
  completion_percentage INT DEFAULT 0,

  -- 时间线
  started_at TIMESTAMP DEFAULT NOW(),
  expected_completion_date DATE,
  actual_completion_date TIMESTAMP,

  -- AI生成元数据
  generated_by VARCHAR(50) DEFAULT 'gpt-4-turbo',
  generation_prompt TEXT, -- 保存生成路径的prompt,用于调试
  generation_tokens INT, -- 消耗的token数
  generation_cost DECIMAL(10,4), -- 生成成本($)

  -- 调整历史
  last_adjusted_at TIMESTAMP,
  adjustment_count INT DEFAULT 0,
  adjustment_reasons TEXT[], -- 调整原因记录

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE learning_paths IS 'AI生成的个性化学习路径 - 12周计划';
COMMENT ON COLUMN learning_paths.path_data IS 'JSON格式存储完整路径结构,灵活可扩展';

CREATE INDEX idx_learning_paths_user ON learning_paths(user_id, status);
CREATE INDEX idx_learning_paths_status ON learning_paths(status, created_at DESC);

-- 学习路径里程碑
CREATE TABLE IF NOT EXISTS learning_milestones (
  id BIGSERIAL PRIMARY KEY,
  learning_path_id BIGINT REFERENCES learning_paths(id) ON DELETE CASCADE,

  milestone_number INT NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,

  -- 目标
  target_week INT,
  objectives JSONB, -- ["达到500词汇量", "完成10篇中级文章"]

  -- 完成状态
  status VARCHAR(20) DEFAULT 'pending', -- pending, in_progress, completed
  completed_at TIMESTAMP,

  -- 奖励
  reward_type VARCHAR(50), -- badge, certificate, unlock_content
  reward_data JSONB,

  UNIQUE(learning_path_id, milestone_number)
);

CREATE INDEX idx_milestones_path ON learning_milestones(learning_path_id, status);

-- ============================================
-- 3. 每日学习计划
-- ============================================

-- 每日计划表
CREATE TABLE IF NOT EXISTS daily_plans (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  learning_path_id BIGINT REFERENCES learning_paths(id) ON DELETE SET NULL,

  -- 计划日期
  plan_date DATE NOT NULL,
  week_number INT, -- 第几周
  day_of_week INT, -- 1-7

  -- 预计时长
  estimated_minutes INT DEFAULT 30,

  -- 计划内容(AI生成的JSON)
  plan_data JSONB NOT NULL,
  -- 包含: greeting, yesterday_summary, activities, tips, motivation等
  -- 示例: {
  --   "greeting": "Good morning!",
  --   "activities": [{type: "reading", title: "...", duration: 15}],
  --   "motivation": "Keep going!"
  -- }

  -- 执行状态
  status VARCHAR(20) DEFAULT 'pending', -- pending, in_progress, completed, skipped, failed
  started_at TIMESTAMP,
  completed_at TIMESTAMP,

  -- 实际执行数据
  actual_minutes INT,
  actual_completion_percentage INT DEFAULT 0,
  activities_completed INT DEFAULT 0,
  activities_total INT,

  -- 用户反馈
  user_rating INT CHECK (user_rating BETWEEN 1 AND 5),
  user_feedback TEXT,
  difficulty_feedback VARCHAR(20), -- too_easy, just_right, too_hard, too_much, too_little
  feedback_submitted_at TIMESTAMP,

  -- AI调整
  adjusted BOOLEAN DEFAULT FALSE,
  adjustment_reason TEXT,
  adjusted_at TIMESTAMP,

  -- 元数据
  generated_by VARCHAR(50),
  generation_tokens INT,
  generation_cost DECIMAL(10,4),

  created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE daily_plans IS 'AI生成的每日学习计划 - 核心用户体验';
COMMENT ON COLUMN daily_plans.plan_data IS 'AI生成的完整计划内容,JSON格式';

CREATE INDEX idx_daily_plans_user_date ON daily_plans(user_id, plan_date DESC);
CREATE INDEX idx_daily_plans_status ON daily_plans(status, plan_date);

CREATE UNIQUE INDEX idx_daily_plans_user_date_unique ON daily_plans(user_id, plan_date);

-- 每日计划活动明细(可选,如果想单独跟踪每个活动)
CREATE TABLE IF NOT EXISTS daily_plan_activities (
  id BIGSERIAL PRIMARY KEY,
  daily_plan_id BIGINT REFERENCES daily_plans(id) ON DELETE CASCADE,

  activity_index INT NOT NULL,
  activity_type VARCHAR(50) NOT NULL, -- reading, vocabulary, listening, speaking, review
  title VARCHAR(200),
  description TEXT,

  -- 内容关联
  content_type VARCHAR(50), -- article, video, exercise
  content_id BIGINT,

  -- 预计和实际
  estimated_duration INT,
  actual_duration INT,

  -- 完成状态
  status VARCHAR(20) DEFAULT 'pending',
  started_at TIMESTAMP,
  completed_at TIMESTAMP,

  -- 推荐理由(AI生成)
  reasoning TEXT,

  UNIQUE(daily_plan_id, activity_index)
);

CREATE INDEX idx_activities_plan ON daily_plan_activities(daily_plan_id, activity_index);

-- ============================================
-- 4. AI对话系统
-- ============================================

-- AI对话历史
CREATE TABLE IF NOT EXISTS ai_chat_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  -- 对话内容
  user_message TEXT NOT NULL,
  ai_response TEXT NOT NULL,

  -- 对话上下文(用于保持连贯性)
  conversation_id UUID DEFAULT gen_random_uuid(),
  message_index INT DEFAULT 0, -- 在对话中的序号

  -- 意图分类
  intent VARCHAR(50), -- question, explanation, encouragement, recommendation, feedback
  topic VARCHAR(50), -- vocabulary, grammar, learning_strategy, progress, motivation
  confidence DECIMAL(3,2), -- AI分类的置信度

  -- AI模型信息
  model_used VARCHAR(50) DEFAULT 'gpt-4-turbo',
  tokens_used INT,
  generation_cost DECIMAL(10,4),
  response_time_ms INT,

  -- 用户反应
  helpful BOOLEAN,
  user_rating INT CHECK (user_rating BETWEEN 1 AND 5),
  user_followup TEXT, -- 用户的后续问题

  created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE ai_chat_history IS 'AI学习助手对话历史';

CREATE INDEX idx_ai_chat_user ON ai_chat_history(user_id, created_at DESC);
CREATE INDEX idx_ai_chat_conversation ON ai_chat_history(conversation_id, message_index);
CREATE INDEX idx_ai_chat_intent ON ai_chat_history(intent, topic);

-- ============================================
-- 5. 能力评估系统
-- ============================================

-- 能力评估记录
CREATE TABLE IF NOT EXISTS competency_assessments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  -- 评估数据(JSON格式,包含多维度评分)
  assessment_data JSONB NOT NULL,
  -- 包含: vocabulary, reading, listening, speaking, learning_pattern等
  -- 示例: {
  --   "vocabulary": { "totalKnown": 1200, "estimatedCEFR": "B1" },
  --   "reading": { "speed": 180, "comprehension": 85 },
  --   "strengths": ["vocabulary", "reading"],
  --   "weaknesses": ["speaking", "listening"]
  -- }

  -- 综合评估
  overall_level VARCHAR(5), -- A1-C2
  confidence_score DECIMAL(3,2), -- 评估的置信度

  -- 评估类型
  assessment_type VARCHAR(50), -- onboarding, periodic, milestone, on_demand
  triggered_by VARCHAR(50), -- system, user, achievement, schedule

  -- 变化追踪
  previous_assessment_id BIGINT REFERENCES competency_assessments(id),
  improvements JSONB, -- 进步的方面
  regressions JSONB, -- 退步的方面

  -- 元数据
  data_sources JSONB, -- 评估基于的数据来源
  algorithm_version VARCHAR(20), -- 评估算法版本

  created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE competency_assessments IS '用户多维能力评估 - AI路径规划的基础';

CREATE INDEX idx_competency_user ON competency_assessments(user_id, created_at DESC);
CREATE INDEX idx_competency_type ON competency_assessments(assessment_type, created_at DESC);

-- ============================================
-- 6. 学习干预系统
-- ============================================

-- 学习干预记录
CREATE TABLE IF NOT EXISTS learning_interventions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  -- 干预信息
  intervention_type VARCHAR(50) NOT NULL,
  -- encouragement, difficulty_warning, milestone_celebration,
  -- review_reminder, break_suggestion, streak_motivation, etc.

  trigger_event VARCHAR(50) NOT NULL,
  -- stuck_on_article, review_overdue, achievement_unlocked,
  -- fatigue_detected, struggling_detected, etc.

  trigger_data JSONB, -- 触发事件的详细数据

  -- 干预内容
  message TEXT NOT NULL,
  suggested_action VARCHAR(100), -- 建议的操作
  urgency VARCHAR(20) DEFAULT 'medium', -- low, medium, high, critical

  -- 展示方式
  display_type VARCHAR(50) DEFAULT 'notification',
  -- notification, modal, inline, email, push

  -- 用户反应
  user_action VARCHAR(50), -- accepted, dismissed, ignored, snoozed
  user_action_at TIMESTAMP,

  -- 效果追踪
  effectiveness_score INT CHECK (effectiveness_score BETWEEN 0 AND 100),
  -- 系统后续评估这次干预是否有效(基于用户后续行为)

  followed_up BOOLEAN DEFAULT FALSE,
  follow_up_data JSONB,

  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

COMMENT ON TABLE learning_interventions IS 'AI主动学习干预 - 实时检测问题并提供帮助';

CREATE INDEX idx_interventions_user ON learning_interventions(user_id, created_at DESC);
CREATE INDEX idx_interventions_type ON learning_interventions(intervention_type, trigger_event);
CREATE INDEX idx_interventions_effectiveness ON learning_interventions(effectiveness_score DESC);

-- ============================================
-- 7. 内容推荐系统
-- ============================================

-- 内容推荐日志
CREATE TABLE IF NOT EXISTS content_recommendations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  article_id BIGINT REFERENCES articles(id) ON DELETE SET NULL,

  -- 推荐上下文
  recommendation_context VARCHAR(50) NOT NULL,
  -- daily_plan, browse_page, post_reading, search_result

  recommendation_session_id UUID DEFAULT gen_random_uuid(),
  position INT, -- 在推荐列表中的位置(1, 2, 3...)

  -- 推荐算法
  algorithm_version VARCHAR(20),
  algorithm_name VARCHAR(50), -- 'hyper_personalized', 'collaborative', 'content_based'

  -- 推荐分数明细
  difficulty_score DECIMAL(5,2),
  interest_score DECIMAL(5,2),
  freshness_score DECIMAL(5,2),
  quality_score DECIMAL(5,2),
  goal_alignment_score DECIMAL(5,2),
  total_score DECIMAL(5,2),

  -- 推荐理由(AI生成)
  reasoning TEXT,

  -- 用户反应
  shown BOOLEAN DEFAULT TRUE,
  clicked BOOLEAN DEFAULT FALSE,
  clicked_at TIMESTAMP,

  started_reading BOOLEAN DEFAULT FALSE,
  started_at TIMESTAMP,

  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP,
  completion_percentage INT,

  -- 用户评价
  user_rating INT CHECK (user_rating BETWEEN 1 AND 5),
  relevance_feedback VARCHAR(20), -- very_relevant, relevant, somewhat_relevant, not_relevant

  recommended_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE content_recommendations IS '内容推荐日志 - 追踪推荐效果';

CREATE INDEX idx_recommendations_user ON content_recommendations(user_id, recommended_at DESC);
CREATE INDEX idx_recommendations_article ON content_recommendations(article_id);
CREATE INDEX idx_recommendations_session ON content_recommendations(recommendation_session_id, position);
CREATE INDEX idx_recommendations_performance ON content_recommendations(clicked, completed);

-- ============================================
-- 8. AI成本追踪
-- ============================================

-- AI API调用日志
CREATE TABLE IF NOT EXISTS ai_api_calls (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,

  -- 调用信息
  api_type VARCHAR(50) NOT NULL, -- openai, anthropic, cohere
  model VARCHAR(50) NOT NULL, -- gpt-4-turbo, gpt-3.5-turbo
  endpoint VARCHAR(100), -- /chat/completions, /embeddings

  -- 用途
  purpose VARCHAR(50) NOT NULL,
  -- daily_plan, chat, content_recommendation, path_generation, intervention

  -- Token使用
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,

  -- 成本
  cost_usd DECIMAL(10,6),

  -- 性能
  response_time_ms INT,
  status VARCHAR(20), -- success, error, timeout

  -- 缓存
  cache_hit BOOLEAN DEFAULT FALSE,
  cache_key VARCHAR(200),

  -- 错误信息
  error_message TEXT,
  error_code VARCHAR(50),

  created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE ai_api_calls IS 'AI API调用日志 - 成本和性能追踪';

CREATE INDEX idx_ai_calls_user ON ai_api_calls(user_id, created_at DESC);
CREATE INDEX idx_ai_calls_purpose ON ai_api_calls(purpose, created_at DESC);
CREATE INDEX idx_ai_calls_cost ON ai_api_calls(created_at DESC, cost_usd);
CREATE INDEX idx_ai_calls_performance ON ai_api_calls(model, response_time_ms);

-- ============================================
-- 9. 学习行为分析视图
-- ============================================

-- 用户学习行为模式视图
CREATE OR REPLACE VIEW user_learning_patterns AS
SELECT
  u.id as user_id,
  u.username,

  -- 学习时间偏好
  (
    SELECT mode() WITHIN GROUP (ORDER BY EXTRACT(HOUR FROM started_at))
    FROM reading_sessions
    WHERE user_id = u.id AND started_at IS NOT NULL
  ) as preferred_hour,

  -- 平均会话时长
  (
    SELECT AVG(duration_seconds) / 60
    FROM reading_sessions
    WHERE user_id = u.id AND duration_seconds IS NOT NULL
  ) as avg_session_minutes,

  -- 学习规律性(连续学习天数)
  (
    SELECT MAX(streak_days)
    FROM (
      SELECT
        COUNT(*) as streak_days,
        ROW_NUMBER() OVER (ORDER BY streak_start) as streak_num
      FROM (
        SELECT
          MIN(DATE(started_at)) as streak_start,
          MAX(DATE(started_at)) as streak_end
        FROM reading_sessions
        WHERE user_id = u.id
        GROUP BY DATE(started_at)
      ) dates
    ) streaks
  ) as longest_streak,

  -- 完成率
  (
    SELECT AVG(completion_percentage)
    FROM reading_sessions
    WHERE user_id = u.id AND completion_percentage IS NOT NULL
  ) as avg_completion_rate

FROM users u;

COMMENT ON VIEW user_learning_patterns IS '用户学习行为模式分析';

-- 每日AI活动汇总视图
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_ai_metrics AS
SELECT
  DATE(created_at) as date,

  -- 计划生成
  COUNT(*) FILTER (WHERE purpose = 'daily_plan') as plans_generated,
  SUM(cost_usd) FILTER (WHERE purpose = 'daily_plan') as plan_cost,

  -- 对话
  COUNT(*) FILTER (WHERE purpose = 'chat') as chat_interactions,
  SUM(cost_usd) FILTER (WHERE purpose = 'chat') as chat_cost,

  -- 推荐
  COUNT(*) FILTER (WHERE purpose = 'content_recommendation') as recommendations_made,
  SUM(cost_usd) FILTER (WHERE purpose = 'content_recommendation') as recommendation_cost,

  -- 总计
  COUNT(*) as total_calls,
  SUM(total_tokens) as total_tokens,
  SUM(cost_usd) as total_cost,

  -- 性能
  AVG(response_time_ms) as avg_response_time,
  AVG(CASE WHEN cache_hit THEN 1 ELSE 0 END) * 100 as cache_hit_rate,

  -- 错误率
  AVG(CASE WHEN status = 'error' THEN 1 ELSE 0 END) * 100 as error_rate

FROM ai_api_calls
GROUP BY DATE(created_at);

COMMENT ON MATERIALIZED VIEW daily_ai_metrics IS 'AI系统每日指标汇总';

CREATE UNIQUE INDEX idx_daily_ai_metrics ON daily_ai_metrics(date DESC);

-- ============================================
-- 10. 触发器和自动化
-- ============================================

-- 更新updated_at
CREATE TRIGGER update_learning_paths_updated_at BEFORE UPDATE ON learning_paths
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_goals_updated_at BEFORE UPDATE ON user_learning_goals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 计算每日计划的activities_total
CREATE OR REPLACE FUNCTION calculate_daily_plan_totals()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.plan_data IS NOT NULL THEN
    NEW.activities_total = jsonb_array_length(NEW.plan_data->'activities');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER daily_plan_calculate_totals BEFORE INSERT OR UPDATE ON daily_plans
  FOR EACH ROW EXECUTE FUNCTION calculate_daily_plan_totals();

-- 自动标记计划完成
CREATE OR REPLACE FUNCTION auto_complete_daily_plan()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.actual_completion_percentage >= 80 AND NEW.status != 'completed' THEN
    NEW.status = 'completed';
    NEW.completed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER daily_plan_auto_complete BEFORE UPDATE ON daily_plans
  FOR EACH ROW EXECUTE FUNCTION auto_complete_daily_plan();

-- ============================================
-- 11. 初始数据
-- ============================================

-- 插入一些默认的学习目标选项(用于前端下拉菜单)
CREATE TABLE IF NOT EXISTS learning_goal_templates (
  id SERIAL PRIMARY KEY,
  goal_type VARCHAR(50) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  icon VARCHAR(50),
  typical_duration_weeks INT,
  UNIQUE(goal_type)
);

INSERT INTO learning_goal_templates (goal_type, display_name, description, icon, typical_duration_weeks) VALUES
  ('exam_prep', 'Exam Preparation', 'Prepare for IELTS, TOEFL, or other English exams', '📝', 12),
  ('business_english', 'Business English', 'Improve English for professional settings', '💼', 16),
  ('daily_conversation', 'Daily Conversation', 'Speak English confidently in everyday situations', '💬', 12),
  ('academic', 'Academic Success', 'Read papers, write essays, participate in seminars', '🎓', 20),
  ('general_improvement', 'General Improvement', 'All-around English skill development', '🌟', 24),
  ('travel', 'Travel English', 'Essential English for traveling abroad', '✈️', 8)
ON CONFLICT (goal_type) DO NOTHING;

-- ============================================
-- 12. 权限设置
-- ============================================

-- 为应用用户授予权限(示例)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO linglish_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO linglish_app;

COMMIT;

-- ============================================
-- 验证脚本
-- ============================================

DO $$
DECLARE
  expected_tables TEXT[] := ARRAY[
    'user_learning_goals',
    'user_interests',
    'learning_paths',
    'learning_milestones',
    'daily_plans',
    'daily_plan_activities',
    'ai_chat_history',
    'competency_assessments',
    'learning_interventions',
    'content_recommendations',
    'ai_api_calls',
    'learning_goal_templates'
  ];
  tbl TEXT;
  missing_tables TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOREACH tbl IN ARRAY expected_tables
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = tbl) THEN
      missing_tables := array_append(missing_tables, tbl);
    END IF;
  END LOOP;

  IF array_length(missing_tables, 1) > 0 THEN
    RAISE WARNING 'Missing tables: %', array_to_string(missing_tables, ', ');
  ELSE
    RAISE NOTICE '✅ All AI Learning Engine tables created successfully!';
  END IF;
END $$;

-- 显示统计信息
SELECT
  'Migration V7 completed at ' || NOW() as status,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public') as total_tables,
  (SELECT COUNT(*) FROM ai_api_calls WHERE created_at > NOW() - INTERVAL '1 day') as ai_calls_last_24h;
