-- Spaced Repetition System for Vocabulary and Phrases
-- Inspired by Anki's SM-2 algorithm

-- Review Schedule Table
CREATE TABLE review_schedule (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  item_type VARCHAR(20) NOT NULL,        -- 'vocabulary', 'phrase', 'sentence'
  item_id BIGINT NOT NULL,               -- Reference to vocab item or other content
  lemma TEXT,                            -- Denormalized for quick lookup

  -- Spaced Repetition Algorithm (SM-2/Anki)
  ease_factor REAL NOT NULL DEFAULT 2.5, -- 容易度系数 (1.3-4.0)
  interval_days REAL NOT NULL DEFAULT 1, -- 当前间隔天数
  repetitions INTEGER NOT NULL DEFAULT 0,-- 连续正确次数

  -- Review Status
  state VARCHAR(20) NOT NULL DEFAULT 'new',  -- 'new', 'learning', 'reviewing', 'relearning', 'mastered'
  last_review_at TIMESTAMP,              -- 上次复习时间
  next_review_at TIMESTAMP,              -- 下次复习时间
  due_date DATE,                         -- 到期日期（便于查询）

  -- Performance Tracking
  total_reviews INTEGER NOT NULL DEFAULT 0,
  correct_reviews INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,     -- 遗忘次数

  -- Context
  source_session_id BIGINT REFERENCES training_sessions(id) ON DELETE SET NULL,
  source_context TEXT,                   -- 首次出现的上下文

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, item_type, item_id)
);

CREATE INDEX idx_review_schedule_user_due ON review_schedule(user_id, due_date) WHERE state != 'mastered';
CREATE INDEX idx_review_schedule_user_next ON review_schedule(user_id, next_review_at) WHERE state != 'mastered';
CREATE INDEX idx_review_schedule_lemma ON review_schedule(user_id, lemma);
CREATE INDEX idx_review_schedule_state ON review_schedule(user_id, state);

-- Review History Table (记录每次复习的详细信息)
CREATE TABLE review_history (
  id BIGSERIAL PRIMARY KEY,
  schedule_id BIGINT REFERENCES review_schedule(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  -- Review Details
  review_time TIMESTAMP NOT NULL,
  rating INTEGER NOT NULL,               -- 1-5: Again, Hard, Good, Easy, Perfect
  time_taken_ms INTEGER,                 -- 用时（毫秒）

  -- State Before Review
  ease_factor_before REAL,
  interval_days_before REAL,

  -- State After Review
  ease_factor_after REAL,
  interval_days_after REAL,
  next_review_at TIMESTAMP,

  -- Performance Metrics (if applicable)
  pronunciation_score INTEGER,           -- 发音评分 (0-100)
  fluency_score INTEGER,                 -- 流利度评分 (0-100)
  accuracy_score INTEGER,                -- 准确度评分 (0-100)

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_review_history_schedule ON review_history(schedule_id, review_time DESC);
CREATE INDEX idx_review_history_user_time ON review_history(user_id, review_time DESC);

-- Enhanced AI Scores Table (扩展现有的 ai_scores 表)
-- 添加音调、连读、节奏等 Prosody 分析指标
ALTER TABLE ai_scores
  ADD COLUMN IF NOT EXISTS prosody JSONB,
  ADD COLUMN IF NOT EXISTS audio_path TEXT,
  ADD COLUMN IF NOT EXISTS reference_text TEXT,
  ADD COLUMN IF NOT EXISTS hypothesis_text TEXT;

COMMENT ON COLUMN ai_scores.prosody IS 'Prosody analysis: {pitch: {score, range, variance}, rhythm: {score, consistency}, linking: {score, detected_links}, intonation: {score, patterns}}';

-- Daily Review Plan (每日复习计划缓存)
CREATE TABLE daily_review_plans (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  plan_date DATE NOT NULL,

  -- Review Items
  new_items JSONB,                       -- 新学习的项目列表
  review_items JSONB,                    -- 待复习的项目列表
  relearn_items JSONB,                   -- 需要重新学习的项目列表

  -- Progress
  completed_count INTEGER DEFAULT 0,
  total_count INTEGER,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, plan_date)
);

CREATE INDEX idx_daily_review_plans_user_date ON daily_review_plans(user_id, plan_date DESC);

-- Vocabulary Phrases (存储 Dictogloss 中提取的短语和句型)
CREATE TABLE vocabulary_phrases (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

  phrase_text TEXT NOT NULL,
  phrase_type VARCHAR(20),               -- 'collocation', 'idiom', 'sentence_pattern'

  -- Source
  source_session_id BIGINT REFERENCES training_sessions(id) ON DELETE SET NULL,
  source_media_id BIGINT REFERENCES media_assets(id) ON DELETE SET NULL,
  source_context TEXT,

  -- Metadata
  difficulty_level VARCHAR(10),          -- 'easy', 'medium', 'hard'
  tags TEXT[],
  notes TEXT,

  -- Tracking
  first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  exposure_count INTEGER DEFAULT 1,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, phrase_text)
);

CREATE INDEX idx_vocabulary_phrases_user ON vocabulary_phrases(user_id, created_at DESC);
CREATE INDEX idx_vocabulary_phrases_source ON vocabulary_phrases(source_session_id);
