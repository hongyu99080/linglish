-- V15: User Retention System (学习报告、排行榜、社交分享、学习小组)
-- 提升用户留存的核心功能模块

-- ============================================================================
-- 1. 学习报告系统 (Learning Reports)
-- ============================================================================

-- 用户学习统计聚合表 (定期更新的统计数据)
CREATE TABLE user_learning_stats (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stat_date DATE NOT NULL,
  stat_type VARCHAR(20) NOT NULL, -- 'daily', 'weekly', 'monthly'

  -- 学习时长统计
  total_study_minutes INTEGER DEFAULT 0,
  training_minutes INTEGER DEFAULT 0,
  reading_minutes INTEGER DEFAULT 0,
  video_minutes INTEGER DEFAULT 0,

  -- 训练统计
  shadowing_count INTEGER DEFAULT 0,
  dictogloss_count INTEGER DEFAULT 0,
  timer_432_count INTEGER DEFAULT 0,
  pronunciation_count INTEGER DEFAULT 0,

  -- 词汇统计
  words_learned INTEGER DEFAULT 0,
  words_reviewed INTEGER DEFAULT 0,
  vocab_accuracy DECIMAL(5,2), -- 复习正确率

  -- 内容消费
  articles_read INTEGER DEFAULT 0,
  videos_watched INTEGER DEFAULT 0,
  sentences_practiced INTEGER DEFAULT 0,

  -- 成就数据
  xp_gained INTEGER DEFAULT 0,
  coins_earned INTEGER DEFAULT 0,
  streak_days INTEGER DEFAULT 0,

  -- 能力评估 (0-100分)
  listening_score DECIMAL(5,2),
  speaking_score DECIMAL(5,2),
  reading_score DECIMAL(5,2),
  vocabulary_score DECIMAL(5,2),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, stat_date, stat_type)
);

CREATE INDEX idx_user_stats_user_date ON user_learning_stats(user_id, stat_date DESC);
CREATE INDEX idx_user_stats_type_date ON user_learning_stats(stat_type, stat_date DESC);

-- 学习报告表 (生成的报告记录)
CREATE TABLE learning_reports (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_type VARCHAR(20) NOT NULL, -- 'weekly', 'monthly', 'yearly'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,

  -- 报告内容 (JSON格式存储详细数据)
  summary JSONB NOT NULL, -- 总体概况
  achievements JSONB, -- 本期成就
  progress JSONB, -- 进步数据
  recommendations JSONB, -- AI推荐建议

  -- 报告状态
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  viewed_at TIMESTAMP,
  shared BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reports_user_type ON learning_reports(user_id, report_type, start_date DESC);

-- 技能进度表 (听说读写各维度详细追踪)
CREATE TABLE skill_progress (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_type VARCHAR(20) NOT NULL, -- 'listening', 'speaking', 'reading', 'vocabulary', 'grammar'

  -- 进度数据
  current_level INTEGER NOT NULL DEFAULT 1, -- 1-100级别
  current_score DECIMAL(5,2) DEFAULT 0, -- 当前分数
  total_practice_time INTEGER DEFAULT 0, -- 总练习时长(分钟)
  practice_count INTEGER DEFAULT 0, -- 练习次数

  -- 历史最高
  best_score DECIMAL(5,2) DEFAULT 0,
  best_score_date DATE,

  -- 近期表现 (JSON数组存储最近30天数据点)
  recent_scores JSONB, -- [{date: '2024-01-01', score: 85}, ...]

  last_practiced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, skill_type)
);

CREATE INDEX idx_skill_progress_user ON skill_progress(user_id);

-- ============================================================================
-- 2. 排行榜系统 (Leaderboards)
-- ============================================================================

-- 排行榜配置表
CREATE TABLE leaderboards (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE, -- 'global_xp', 'weekly_study_time', 'vocab_master', etc.
  display_name VARCHAR(100) NOT NULL,
  description TEXT,

  -- 排行榜类型
  scope VARCHAR(20) NOT NULL, -- 'global', 'friends', 'group'
  metric VARCHAR(50) NOT NULL, -- 'xp', 'study_minutes', 'words_learned', 'streak'
  time_range VARCHAR(20), -- 'all_time', 'monthly', 'weekly', 'daily'

  -- 配置
  max_entries INTEGER DEFAULT 100, -- 最多显示条数
  update_frequency VARCHAR(20) DEFAULT 'hourly', -- 'realtime', 'hourly', 'daily'

  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 预设排行榜数据
INSERT INTO leaderboards (name, display_name, description, scope, metric, time_range, max_entries) VALUES
  ('global_xp', '全球经验榜', '所有用户总经验值排行', 'global', 'total_xp', 'all_time', 100),
  ('weekly_study', '本周学霸榜', '本周学习时长排行', 'global', 'study_minutes', 'weekly', 50),
  ('monthly_vocab', '月度词汇王', '本月学习词汇数量排行', 'global', 'words_learned', 'monthly', 50),
  ('streak_master', '连胜达人榜', '学习连胜天数排行', 'global', 'streak_days', 'all_time', 100);

-- 排行榜条目缓存表 (定期更新)
CREATE TABLE leaderboard_entries (
  id BIGSERIAL PRIMARY KEY,
  leaderboard_id BIGINT NOT NULL REFERENCES leaderboards(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  rank INTEGER NOT NULL,
  score DECIMAL(10,2) NOT NULL, -- 排行指标的值
  rank_change INTEGER DEFAULT 0, -- 排名变化 (+5表示上升5名)

  -- 附加显示信息
  display_data JSONB, -- 显示用的额外数据

  valid_from TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  valid_to TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(leaderboard_id, user_id, valid_from)
);

CREATE INDEX idx_leaderboard_entries_board_rank ON leaderboard_entries(leaderboard_id, rank, valid_from DESC);
CREATE INDEX idx_leaderboard_entries_user ON leaderboard_entries(user_id, leaderboard_id);

-- 好友关系表 (用于好友排行榜)
CREATE TABLE user_friendships (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'accepted', 'blocked'
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP,

  -- 互动数据
  last_interaction_at TIMESTAMP,
  interaction_count INTEGER DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, friend_id),
  CHECK (user_id != friend_id)
);

CREATE INDEX idx_friendships_user ON user_friendships(user_id, status);
CREATE INDEX idx_friendships_friend ON user_friendships(friend_id, status);

-- ============================================================================
-- 3. 社交分享系统 (Social Sharing)
-- ============================================================================

-- 分享记录表
CREATE TABLE share_records (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 分享内容
  share_type VARCHAR(50) NOT NULL, -- 'weekly_report', 'achievement', 'milestone', 'practice_score', 'study_streak'
  content_id BIGINT, -- 关联的内容ID (如report_id, achievement_id等)
  share_data JSONB NOT NULL, -- 分享的具体数据

  -- 分享渠道
  platform VARCHAR(50), -- 'wechat', 'weibo', 'twitter', 'facebook', 'link'
  share_url VARCHAR(500), -- 生成的分享链接
  poster_url VARCHAR(500), -- 生成的海报图片URL

  -- 效果追踪
  view_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  conversion_count INTEGER DEFAULT 0, -- 通过分享带来的注册数

  -- 奖励状态
  reward_claimed BOOLEAN DEFAULT FALSE,
  reward_type VARCHAR(50), -- 'xp', 'coins', 'premium_days'
  reward_amount INTEGER,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP -- 分享链接过期时间
);

CREATE INDEX idx_shares_user ON share_records(user_id, created_at DESC);
CREATE INDEX idx_shares_url ON share_records(share_url) WHERE share_url IS NOT NULL;

-- 分享奖励配置表
CREATE TABLE share_reward_configs (
  id BIGSERIAL PRIMARY KEY,
  share_type VARCHAR(50) NOT NULL UNIQUE,

  -- 奖励配置
  enabled BOOLEAN DEFAULT TRUE,
  reward_type VARCHAR(50) NOT NULL, -- 'xp', 'coins', 'premium_days'
  reward_amount INTEGER NOT NULL,

  -- 限制条件
  daily_limit INTEGER, -- 每日最多奖励次数
  requires_conversion BOOLEAN DEFAULT FALSE, -- 是否需要转化才给奖励

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 预设分享奖励
INSERT INTO share_reward_configs (share_type, reward_type, reward_amount, daily_limit, requires_conversion) VALUES
  ('weekly_report', 'xp', 50, 1, FALSE),
  ('achievement', 'xp', 30, 3, FALSE),
  ('study_streak', 'xp', 100, 1, FALSE),
  ('milestone', 'coins', 100, 1, FALSE),
  ('referral', 'premium_days', 7, 10, TRUE);

-- 成就解锁记录表 (扩展user_rewards)
CREATE TABLE achievement_unlocks (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_type VARCHAR(100) NOT NULL,
  achievement_name VARCHAR(200) NOT NULL,
  achievement_description TEXT,

  -- 成就数据
  achievement_data JSONB, -- 成就的详细数据
  icon_url VARCHAR(500),
  rarity VARCHAR(20), -- 'common', 'rare', 'epic', 'legendary'

  -- 奖励
  xp_reward INTEGER DEFAULT 0,
  coin_reward INTEGER DEFAULT 0,

  unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  viewed BOOLEAN DEFAULT FALSE,
  shared BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_achievements_user ON achievement_unlocks(user_id, unlocked_at DESC);
CREATE INDEX idx_achievements_type ON achievement_unlocks(achievement_type, unlocked_at DESC);

-- ============================================================================
-- 4. 学习小组系统 (Study Groups)
-- ============================================================================

-- 学习小组表
CREATE TABLE study_groups (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,

  -- 小组配置
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_type VARCHAR(50) DEFAULT 'public', -- 'public', 'private', 'invite_only'
  max_members INTEGER DEFAULT 50,

  -- 学习目标
  learning_goal TEXT,
  target_language VARCHAR(10) DEFAULT 'en',
  difficulty_level VARCHAR(20), -- 'beginner', 'intermediate', 'advanced'

  -- 统计数据
  member_count INTEGER DEFAULT 1,
  total_study_minutes INTEGER DEFAULT 0,
  total_xp INTEGER DEFAULT 0,

  -- 状态
  is_active BOOLEAN DEFAULT TRUE,
  avatar_url VARCHAR(500),
  cover_url VARCHAR(500),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_groups_owner ON study_groups(owner_id);
CREATE INDEX idx_groups_type ON study_groups(group_type, is_active);
CREATE INDEX idx_groups_created ON study_groups(created_at DESC);

-- 小组成员表
CREATE TABLE study_group_members (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 成员角色
  role VARCHAR(20) DEFAULT 'member', -- 'owner', 'admin', 'member'

  -- 贡献统计
  contribution_xp INTEGER DEFAULT 0,
  study_minutes INTEGER DEFAULT 0,
  active_days INTEGER DEFAULT 0,

  -- 状态
  status VARCHAR(20) DEFAULT 'active', -- 'pending', 'active', 'inactive', 'banned'
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(group_id, user_id)
);

CREATE INDEX idx_group_members_group ON study_group_members(group_id, status);
CREATE INDEX idx_group_members_user ON study_group_members(user_id, status);

-- 小组挑战表
CREATE TABLE group_challenges (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,

  -- 挑战信息
  title VARCHAR(200) NOT NULL,
  description TEXT,
  challenge_type VARCHAR(50) NOT NULL, -- 'study_time', 'vocab_count', 'training_count', 'streak'

  -- 挑战目标
  target_value INTEGER NOT NULL, -- 目标值
  current_value INTEGER DEFAULT 0, -- 当前进度

  -- 时间范围
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,

  -- 奖励
  reward_type VARCHAR(50), -- 'xp', 'coins', 'badge'
  reward_amount INTEGER,

  -- 状态
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'completed', 'failed', 'cancelled'

  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX idx_group_challenges_group ON group_challenges(group_id, status);
CREATE INDEX idx_group_challenges_dates ON group_challenges(start_date, end_date);

-- 小组挑战参与表
CREATE TABLE group_challenge_participants (
  id BIGSERIAL PRIMARY KEY,
  challenge_id BIGINT NOT NULL REFERENCES group_challenges(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 个人进度
  progress_value INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,

  -- 奖励
  reward_claimed BOOLEAN DEFAULT FALSE,

  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,

  UNIQUE(challenge_id, user_id)
);

CREATE INDEX idx_challenge_participants_challenge ON group_challenge_participants(challenge_id, completed);
CREATE INDEX idx_challenge_participants_user ON group_challenge_participants(user_id);

-- 小组活动表 (动态/公告)
CREATE TABLE group_activities (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,

  -- 活动内容
  activity_type VARCHAR(50) NOT NULL, -- 'member_join', 'challenge_complete', 'milestone', 'announcement'
  content TEXT,
  activity_data JSONB, -- 活动相关数据

  -- 互动
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_group_activities_group ON group_activities(group_id, created_at DESC);

-- ============================================================================
-- 5. 辅助功能表
-- ============================================================================

-- 用户每日活跃记录 (用于计算streak等)
CREATE TABLE user_daily_activity (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_date DATE NOT NULL,

  -- 活跃指标
  is_active BOOLEAN DEFAULT TRUE,
  study_minutes INTEGER DEFAULT 0,
  completed_goals BOOLEAN DEFAULT FALSE,

  -- 打卡数据
  first_activity_at TIMESTAMP,
  last_activity_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, activity_date)
);

CREATE INDEX idx_daily_activity_user_date ON user_daily_activity(user_id, activity_date DESC);

-- 用户里程碑表
CREATE TABLE user_milestones (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  milestone_type VARCHAR(100) NOT NULL, -- 'first_week', '100_words', '10_hours', 'level_10'
  milestone_name VARCHAR(200) NOT NULL,
  milestone_description TEXT,

  -- 里程碑数据
  value INTEGER, -- 达成时的数值
  threshold INTEGER, -- 达成门槛

  -- 奖励
  xp_reward INTEGER DEFAULT 0,
  coin_reward INTEGER DEFAULT 0,
  badge_url VARCHAR(500),

  achieved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  celebrated BOOLEAN DEFAULT FALSE, -- 是否已庆祝展示

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_milestones_user ON user_milestones(user_id, achieved_at DESC);
CREATE INDEX idx_milestones_type ON user_milestones(milestone_type);

-- ============================================================================
-- 6. 触发器和函数
-- ============================================================================

-- 更新updated_at触发器函数 (如果不存在)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 应用触发器
CREATE TRIGGER update_user_stats_updated_at BEFORE UPDATE ON user_learning_stats
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_skill_progress_updated_at BEFORE UPDATE ON skill_progress
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_leaderboards_updated_at BEFORE UPDATE ON leaderboards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_study_groups_updated_at BEFORE UPDATE ON study_groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 7. 视图 (便捷查询)
-- ============================================================================

-- 用户综合排行视图
CREATE OR REPLACE VIEW user_rankings AS
SELECT
  u.id AS user_id,
  u.username,
  u.level,
  up.daily_goal,

  -- 从user_learning_stats汇总数据
  COALESCE(SUM(uls.xp_gained), 0) AS total_xp,
  COALESCE(SUM(uls.total_study_minutes), 0) AS total_study_minutes,
  COALESCE(SUM(uls.words_learned), 0) AS total_words_learned,
  COALESCE(MAX(uls.streak_days), 0) AS current_streak,

  -- 从skill_progress获取能力评分
  COALESCE(AVG((sp.current_score)), 0) AS avg_skill_score

FROM users u
LEFT JOIN user_profiles up ON u.id = up.user_id
LEFT JOIN user_learning_stats uls ON u.id = uls.user_id
LEFT JOIN skill_progress sp ON u.id = sp.user_id
WHERE u.status = 'active'
GROUP BY u.id, u.username, u.level, up.daily_goal;

-- 小组排行视图
CREATE OR REPLACE VIEW group_rankings AS
SELECT
  sg.id AS group_id,
  sg.name,
  sg.member_count,
  sg.total_study_minutes,
  sg.total_xp,

  -- 计算人均数据
  CASE WHEN sg.member_count > 0
    THEN sg.total_study_minutes / sg.member_count
    ELSE 0
  END AS avg_study_minutes_per_member,

  CASE WHEN sg.member_count > 0
    THEN sg.total_xp / sg.member_count
    ELSE 0
  END AS avg_xp_per_member,

  sg.created_at
FROM study_groups sg
WHERE sg.is_active = TRUE;

-- ============================================================================
-- 8. 初始化数据
-- ============================================================================

-- 为现有用户初始化skill_progress (如果有用户的话)
INSERT INTO skill_progress (user_id, skill_type, current_level, current_score)
SELECT
  u.id,
  skill_type,
  1,
  0
FROM users u
CROSS JOIN (
  VALUES ('listening'), ('speaking'), ('reading'), ('vocabulary'), ('grammar')
) AS skills(skill_type)
WHERE u.status = 'active'
ON CONFLICT (user_id, skill_type) DO NOTHING;

-- ============================================================================
-- 完成
-- ============================================================================

COMMENT ON TABLE user_learning_stats IS '用户学习统计聚合表，按日/周/月汇总学习数据';
COMMENT ON TABLE learning_reports IS '学习报告表，存储自动生成的周报/月报';
COMMENT ON TABLE skill_progress IS '技能进度表，追踪听说读写各维度的详细进度';
COMMENT ON TABLE leaderboards IS '排行榜配置表';
COMMENT ON TABLE leaderboard_entries IS '排行榜条目缓存表';
COMMENT ON TABLE user_friendships IS '好友关系表';
COMMENT ON TABLE share_records IS '社交分享记录表';
COMMENT ON TABLE achievement_unlocks IS '成就解锁记录表';
COMMENT ON TABLE study_groups IS '学习小组表';
COMMENT ON TABLE group_challenges IS '小组挑战表';
COMMENT ON TABLE user_milestones IS '用户里程碑表';
