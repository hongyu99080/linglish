-- ============================================
-- V6: 阅读和词汇系统核心表
-- ============================================
-- 基于LingQ模式的沉浸式学习平台数据模型
-- 创建日期: 2025-10-21
-- 依赖: V1-V5已执行

BEGIN;

-- ============================================
-- 1. 文章和内容管理
-- ============================================

-- 文章表(核心内容)
CREATE TABLE IF NOT EXISTS articles (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  language VARCHAR(10) DEFAULT 'en',

  -- 元数据
  source_url TEXT,
  author VARCHAR(200),
  published_at DATE,
  imported_by BIGINT REFERENCES users(id),
  imported_at TIMESTAMP DEFAULT NOW(),

  -- 学习相关属性
  difficulty_level VARCHAR(20) CHECK (difficulty_level IN ('beginner', 'intermediate', 'advanced')),
  word_count INT,
  unique_word_count INT,
  cefr_level VARCHAR(5), -- A1, A2, B1, B2, C1, C2

  -- 音频关联
  audio_url TEXT,
  audio_duration INT, -- 秒
  has_timestamps BOOLEAN DEFAULT FALSE,

  -- 社区属性
  visibility VARCHAR(20) DEFAULT 'public' CHECK (visibility IN ('public', 'private', 'friends')),
  is_featured BOOLEAN DEFAULT FALSE,

  -- 统计数据
  view_count INT DEFAULT 0,
  learn_count INT DEFAULT 0,
  avg_rating DECIMAL(3, 2),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE articles IS '文章内容表 - 用户学习的核心素材';
COMMENT ON COLUMN articles.difficulty_level IS '难度等级: beginner/intermediate/advanced';
COMMENT ON COLUMN articles.cefr_level IS 'CEFR欧洲语言等级: A1-C2';
COMMENT ON COLUMN articles.visibility IS '可见性: public(公开)/private(私有)/friends(好友可见)';

CREATE INDEX idx_articles_difficulty ON articles(difficulty_level, language);
CREATE INDEX idx_articles_imported_by ON articles(imported_by);
CREATE INDEX idx_articles_visibility ON articles(visibility, is_featured);
CREATE INDEX idx_articles_created ON articles(created_at DESC);

-- 文章分类关联表
CREATE TABLE IF NOT EXISTS article_categories (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT REFERENCES articles(id) ON DELETE CASCADE,
  category VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(article_id, category)
);

CREATE INDEX idx_article_cat_category ON article_categories(category);

-- 文章句子表(用于音频同步和逐句分析)
CREATE TABLE IF NOT EXISTS article_sentences (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT REFERENCES articles(id) ON DELETE CASCADE,
  sentence_index INT NOT NULL,
  text TEXT NOT NULL,

  -- 音频时间戳
  audio_start DECIMAL(10, 3),
  audio_end DECIMAL(10, 3),

  -- 分析数据
  word_count INT,
  difficulty_score DECIMAL(3, 2),

  UNIQUE(article_id, sentence_index)
);

COMMENT ON TABLE article_sentences IS '文章句子表 - 支持逐句播放和精细化学习';

CREATE INDEX idx_sentences_article ON article_sentences(article_id, sentence_index);

-- ============================================
-- 2. 词典系统
-- ============================================

-- 词典主表(预置英文词典数据)
CREATE TABLE IF NOT EXISTS dictionary (
  id BIGSERIAL PRIMARY KEY,
  word VARCHAR(100) NOT NULL UNIQUE,
  lemma VARCHAR(100), -- 词根/原形
  pos VARCHAR(20), -- part of speech: noun, verb, adj, adv, etc.

  -- 释义(JSON格式存储多个释义)
  definitions JSONB,
  -- 示例: [{"en": "to meet unexpectedly", "cn": "偶遇", "level": "B1", "example": "I encountered an old friend."}]

  -- 音标和发音
  ipa_us VARCHAR(100),  -- 美式音标
  ipa_uk VARCHAR(100),  -- 英式音标
  audio_url_us TEXT,
  audio_url_uk TEXT,

  -- 频率和难度
  frequency_rank INT, -- 词频排名(越小越常用)
  cefr_level VARCHAR(5), -- A1-C2

  -- 例句(JSON数组)
  examples JSONB,
  -- 示例: [{"sentence": "We encountered many problems.", "translation": "我们遇到了很多问题。"}]

  -- 搭配(JSON数组)
  collocations JSONB,
  -- 示例: ["encounter problems", "encounter difficulties", "chance encounter"]

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE dictionary IS '英文词典表 - 存储10万+常用词的详细信息';
COMMENT ON COLUMN dictionary.lemma IS '词根形式,如encountered的lemma是encounter';
COMMENT ON COLUMN dictionary.frequency_rank IS '基于COCA语料库的词频排名';

CREATE INDEX idx_dict_word ON dictionary(word);
CREATE INDEX idx_dict_lemma ON dictionary(lemma);
CREATE INDEX idx_dict_frequency ON dictionary(frequency_rank);
CREATE INDEX idx_dict_cefr ON dictionary(cefr_level);
CREATE INDEX idx_dict_pos ON dictionary(pos);

-- ============================================
-- 3. 用户词汇系统(核心)
-- ============================================

-- 用户词汇表 - LingQ的三色标记系统
CREATE TABLE IF NOT EXISTS user_vocabulary (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  word VARCHAR(100) NOT NULL,
  lemma VARCHAR(100),

  -- 词汇状态(LingQ的核心机制)
  status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new', 'learning', 'known', 'ignored')),
  -- new: 黄色(新词)
  -- learning: 蓝色(学习中)
  -- known: 白色(已掌握)
  -- ignored: 用户标记为忽略

  -- 学习时间追踪
  first_seen_at TIMESTAMP DEFAULT NOW(),
  last_reviewed_at TIMESTAMP,
  marked_as_known_at TIMESTAMP, -- 何时标记为已掌握

  -- 学习数据
  review_count INT DEFAULT 0, -- 复习次数
  correct_count INT DEFAULT 0, -- 答对次数
  encounter_count INT DEFAULT 1, -- 在阅读中遇到的次数

  -- 间隔重复算法(SRS)参数
  ease_factor DECIMAL(3,2) DEFAULT 2.5, -- 难度系数(SuperMemo算法)
  interval_days INT DEFAULT 0, -- 当前间隔天数
  next_review_at TIMESTAMP, -- 下次复习时间

  -- 上下文记忆
  context_sentence TEXT, -- 第一次遇到时的句子
  source_article_id BIGINT REFERENCES articles(id), -- 来源文章

  -- 用户个性化
  tags TEXT[], -- 用户自定义标签
  notes TEXT, -- 用户笔记
  difficulty_rating INT CHECK (difficulty_rating BETWEEN 1 AND 5), -- 用户主观难度评级

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id, word, lemma)
);

COMMENT ON TABLE user_vocabulary IS '用户词汇表 - LingQ三色标记系统的核心';
COMMENT ON COLUMN user_vocabulary.status IS '词汇状态: new(黄色新词) / learning(蓝色学习中) / known(白色已掌握) / ignored';
COMMENT ON COLUMN user_vocabulary.ease_factor IS 'SRS算法难度系数,范围1.3-3.0,越高表示越容易记住';
COMMENT ON COLUMN user_vocabulary.encounter_count IS '在阅读中遇到的次数,用于判断高频词';

CREATE INDEX idx_uv_user_status ON user_vocabulary(user_id, status);
CREATE INDEX idx_uv_next_review ON user_vocabulary(user_id, next_review_at) WHERE next_review_at IS NOT NULL;
CREATE INDEX idx_uv_word ON user_vocabulary(word);
CREATE INDEX idx_uv_created ON user_vocabulary(user_id, created_at DESC);

-- 全文搜索索引(快速查找单词)
CREATE INDEX idx_uv_word_trgm ON user_vocabulary USING gin(word gin_trgm_ops);

-- 词汇遇到记录(详细日志,用于统计和分析)
CREATE TABLE IF NOT EXISTS vocabulary_encounters (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  word VARCHAR(100) NOT NULL,
  article_id BIGINT REFERENCES articles(id) ON DELETE SET NULL,

  encountered_at TIMESTAMP DEFAULT NOW(),
  sentence_context TEXT, -- 遇到时的句子上下文

  -- 用户行为
  looked_up BOOLEAN DEFAULT FALSE, -- 是否查看了释义
  status_before VARCHAR(20), -- 遇到前的状态
  status_after VARCHAR(20) -- 遇到后的状态(如果改变了)
);

COMMENT ON TABLE vocabulary_encounters IS '词汇遇到日志 - 记录用户每次遇到单词的详细信息';

CREATE INDEX idx_ve_user_time ON vocabulary_encounters(user_id, encountered_at DESC);
CREATE INDEX idx_ve_word ON vocabulary_encounters(word);
CREATE INDEX idx_ve_article ON vocabulary_encounters(article_id);

-- ============================================
-- 4. 复习系统
-- ============================================

-- 复习记录表
CREATE TABLE IF NOT EXISTS vocabulary_reviews (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  word VARCHAR(100) NOT NULL,

  reviewed_at TIMESTAMP DEFAULT NOW(),
  review_mode VARCHAR(20) NOT NULL, -- flashcard, cloze, listening, spelling

  -- 复习结果
  result VARCHAR(20) NOT NULL CHECK (result IN ('correct', 'incorrect', 'partial', 'skipped')),
  quality_rating INT CHECK (quality_rating BETWEEN 0 AND 5), -- 0=完全不记得, 5=完美记住
  time_spent_ms INT, -- 答题耗时(毫秒)

  -- SRS算法参数变化(用于分析)
  old_ease_factor DECIMAL(3,2),
  new_ease_factor DECIMAL(3,2),
  old_interval_days INT,
  new_interval_days INT,

  -- 上下文
  review_session_id BIGINT -- 关联复习会话(可选)
);

COMMENT ON TABLE vocabulary_reviews IS '词汇复习记录 - 用于SRS算法和学习分析';
COMMENT ON COLUMN vocabulary_reviews.review_mode IS '复习模式: flashcard(卡片)/cloze(填空)/listening(听力)/spelling(拼写)';
COMMENT ON COLUMN vocabulary_reviews.quality_rating IS 'SuperMemo质量评分: 0-5,影响下次复习间隔';

CREATE INDEX idx_vr_user_time ON vocabulary_reviews(user_id, reviewed_at DESC);
CREATE INDEX idx_vr_word ON vocabulary_reviews(word);

-- 复习会话表(可选,用于组织复习)
CREATE TABLE IF NOT EXISTS review_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  duration_seconds INT,

  -- 统计
  total_cards INT DEFAULT 0,
  correct_count INT DEFAULT 0,
  incorrect_count INT DEFAULT 0,

  review_mode VARCHAR(20),
  completed BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_rs_user ON review_sessions(user_id, started_at DESC);

-- ============================================
-- 5. 阅读会话和行为追踪
-- ============================================

-- 阅读会话表
CREATE TABLE IF NOT EXISTS reading_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  article_id BIGINT REFERENCES articles(id) ON DELETE SET NULL,

  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  duration_seconds INT,

  -- 阅读进度
  completion_percentage INT DEFAULT 0, -- 读到百分之几
  last_position INT, -- 最后阅读位置(字符偏移)

  -- 学习行为
  words_looked_up INT DEFAULT 0, -- 查询了多少个单词
  new_words_added INT DEFAULT 0, -- 添加了多少个新词到词库
  words_marked_known INT DEFAULT 0, -- 标记了多少词为已掌握

  -- 音频使用
  audio_played BOOLEAN DEFAULT FALSE,
  audio_playback_count INT DEFAULT 0,
  audio_time_seconds INT DEFAULT 0
);

COMMENT ON TABLE reading_sessions IS '阅读会话表 - 记录用户每次阅读的详细数据';

CREATE INDEX idx_reading_user ON reading_sessions(user_id, started_at DESC);
CREATE INDEX idx_reading_article ON reading_sessions(article_id);

-- ============================================
-- 6. 内容质量和社区
-- ============================================

-- 内容评分表
CREATE TABLE IF NOT EXISTS content_ratings (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT REFERENCES articles(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review TEXT,
  difficulty_feedback VARCHAR(20) CHECK (difficulty_feedback IN ('too_easy', 'just_right', 'too_hard')),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(article_id, user_id)
);

COMMENT ON TABLE content_ratings IS '内容评分表 - 用户对文章质量的反馈';

CREATE INDEX idx_rating_article ON content_ratings(article_id);
CREATE INDEX idx_rating_user ON content_ratings(user_id);

-- 内容报告表(举报不良内容)
CREATE TABLE IF NOT EXISTS content_reports (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT REFERENCES articles(id) ON DELETE CASCADE,
  reporter_id BIGINT REFERENCES users(id) ON DELETE SET NULL,

  reason VARCHAR(50) NOT NULL CHECK (reason IN ('inappropriate', 'copyright', 'low_quality', 'spam', 'other')),
  description TEXT,

  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMP,
  resolution_note TEXT,

  created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE content_reports IS '内容举报表 - 社区内容质量管理';

CREATE INDEX idx_report_status ON content_reports(status, created_at DESC);
CREATE INDEX idx_report_article ON content_reports(article_id);

-- ============================================
-- 7. 统计和分析视图
-- ============================================

-- 用户词汇统计视图
CREATE OR REPLACE VIEW user_vocabulary_stats AS
SELECT
  user_id,
  COUNT(*) as total_words,
  COUNT(*) FILTER (WHERE status = 'new') as new_words,
  COUNT(*) FILTER (WHERE status = 'learning') as learning_words,
  COUNT(*) FILTER (WHERE status = 'known') as known_words,
  COUNT(*) FILTER (WHERE status = 'ignored') as ignored_words,
  COUNT(*) FILTER (WHERE next_review_at IS NOT NULL AND next_review_at <= NOW()) as due_for_review,
  MAX(created_at) as last_word_added,
  MAX(last_reviewed_at) as last_review_time
FROM user_vocabulary
GROUP BY user_id;

COMMENT ON VIEW user_vocabulary_stats IS '用户词汇统计 - 实时计算各状态词汇数量';

-- 文章质量分数视图
CREATE OR REPLACE VIEW article_quality_scores AS
SELECT
  a.id,
  a.title,
  a.difficulty_level,
  COUNT(DISTINCT r.user_id) as rating_count,
  AVG(r.rating) as avg_rating,
  COUNT(DISTINCT rs.user_id) as users_read,
  COUNT(DISTINCT rs.user_id) FILTER (WHERE rs.completion_percentage >= 80) as users_completed,
  COUNT(DISTINCT rep.id) FILTER (WHERE rep.status != 'dismissed') as active_reports,

  -- 综合质量分(0-100)
  LEAST(100, GREATEST(0,
    COALESCE(AVG(r.rating), 3) * 15 + -- 评分占15分(满分75)
    LOG(COUNT(DISTINCT rs.user_id) + 1) * 10 + -- 阅读人数占10分
    (COUNT(DISTINCT rs.user_id) FILTER (WHERE rs.completion_percentage >= 80)::DECIMAL /
     NULLIF(COUNT(DISTINCT rs.user_id), 0) * 100 * 0.1) - -- 完成率占10分
    COUNT(DISTINCT rep.id) FILTER (WHERE rep.status != 'dismissed') * 5 -- 举报扣分
  ))::INT as quality_score

FROM articles a
LEFT JOIN content_ratings r ON a.id = r.article_id
LEFT JOIN reading_sessions rs ON a.id = rs.article_id
LEFT JOIN content_reports rep ON a.id = rep.article_id
GROUP BY a.id, a.title, a.difficulty_level;

COMMENT ON VIEW article_quality_scores IS '文章质量分数 - 综合评分、阅读量、完成率等计算';

-- 每日学习统计物化视图
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_learning_stats AS
SELECT
  user_id,
  DATE(activity_date) as date,

  -- 阅读统计
  COUNT(DISTINCT article_id) FILTER (WHERE activity_type = 'reading') as articles_read,
  SUM(duration_seconds) FILTER (WHERE activity_type = 'reading') as reading_seconds,

  -- 词汇统计
  COUNT(DISTINCT word) FILTER (WHERE activity_type = 'word_add') as words_added,
  COUNT(*) FILTER (WHERE activity_type = 'word_review') as words_reviewed,
  COUNT(*) FILTER (WHERE activity_type = 'word_review' AND result = 'correct') as reviews_correct,

  -- 训练统计(关联现有的training_sessions)
  SUM(duration_seconds) FILTER (WHERE activity_type IN ('shadowing', 'dictogloss', '432')) as training_seconds,
  COUNT(*) FILTER (WHERE activity_type IN ('dictogloss', '432')) as effective_outputs,

  -- 总计
  SUM(duration_seconds) as total_learning_seconds,
  COUNT(DISTINCT activity_type) as activity_variety

FROM (
  -- 阅读活动
  SELECT
    user_id,
    started_at as activity_date,
    'reading' as activity_type,
    article_id,
    NULL as word,
    NULL as result,
    COALESCE(duration_seconds, 0) as duration_seconds
  FROM reading_sessions
  WHERE started_at IS NOT NULL

  UNION ALL

  -- 词汇添加
  SELECT
    user_id,
    first_seen_at,
    'word_add',
    source_article_id,
    word,
    NULL,
    0
  FROM user_vocabulary
  WHERE first_seen_at IS NOT NULL

  UNION ALL

  -- 词汇复习
  SELECT
    user_id,
    reviewed_at,
    'word_review',
    NULL,
    word,
    result,
    time_spent_ms / 1000
  FROM vocabulary_reviews

  UNION ALL

  -- 训练会话(关联现有表)
  SELECT
    user_id,
    started_at,
    type,
    media_id,
    NULL,
    NULL,
    COALESCE(duration, 0)
  FROM training_sessions
  WHERE started_at IS NOT NULL

) combined
GROUP BY user_id, DATE(activity_date);

COMMENT ON MATERIALIZED VIEW daily_learning_stats IS '每日学习统计 - 汇总用户每天的所有学习活动';

-- 创建唯一索引以支持并发刷新
CREATE UNIQUE INDEX idx_daily_stats_unique ON daily_learning_stats(user_id, date);

-- ============================================
-- 8. 触发器和自动化
-- ============================================

-- 更新updated_at时间戳
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 为需要的表添加触发器
CREATE TRIGGER update_articles_updated_at BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_vocabulary_updated_at BEFORE UPDATE ON user_vocabulary
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_dictionary_updated_at BEFORE UPDATE ON dictionary
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 词汇状态改变时更新时间戳
CREATE OR REPLACE FUNCTION update_vocabulary_status_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'known' AND OLD.status != 'known' THEN
        NEW.marked_as_known_at = NOW();
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER vocabulary_status_change BEFORE UPDATE ON user_vocabulary
  FOR EACH ROW EXECUTE FUNCTION update_vocabulary_status_timestamp();

-- 自动更新文章的学习人数
CREATE OR REPLACE FUNCTION update_article_learn_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE articles
    SET learn_count = (
        SELECT COUNT(DISTINCT user_id)
        FROM reading_sessions
        WHERE article_id = NEW.article_id
    )
    WHERE id = NEW.article_id;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER article_learn_count_update AFTER INSERT ON reading_sessions
  FOR EACH ROW EXECUTE FUNCTION update_article_learn_count();

-- ============================================
-- 9. 初始数据和配置
-- ============================================

-- 插入一些示例分类
INSERT INTO article_categories (article_id, category)
SELECT a.id, 'uncategorized'
FROM articles a
WHERE NOT EXISTS (
  SELECT 1 FROM article_categories WHERE article_id = a.id
)
ON CONFLICT (article_id, category) DO NOTHING;

-- ============================================
-- 10. 权限设置(生产环境需调整)
-- ============================================

-- 为应用用户授予必要权限(示例)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO linglish_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO linglish_app;

COMMIT;

-- ============================================
-- 验证脚本
-- ============================================

-- 检查表是否创建成功
DO $$
DECLARE
  expected_tables TEXT[] := ARRAY[
    'articles',
    'article_categories',
    'article_sentences',
    'dictionary',
    'user_vocabulary',
    'vocabulary_encounters',
    'vocabulary_reviews',
    'review_sessions',
    'reading_sessions',
    'content_ratings',
    'content_reports'
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
    RAISE NOTICE 'All tables created successfully!';
  END IF;
END $$;

-- 显示统计信息
SELECT
  'Migration V6 completed at ' || NOW() as status,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public') as total_tables,
  (SELECT COUNT(*) FROM information_schema.views WHERE table_schema = 'public') as total_views;
