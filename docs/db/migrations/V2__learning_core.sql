-- Words, User Vocabulary, Reading Sessions, Word Interactions, Daily Stats

CREATE TABLE words (
  id BIGSERIAL PRIMARY KEY,
  word VARCHAR(100) UNIQUE NOT NULL,
  word_lowercase VARCHAR(100) NOT NULL,
  part_of_speech VARCHAR(20),
  frequency_rank INTEGER,
  difficulty_level VARCHAR(20),
  definitions JSONB,
  phonetic VARCHAR(100),
  audio_url VARCHAR(500),
  example_sentences JSONB,
  synonyms TEXT[], antonyms TEXT[], related_words TEXT[],
  lookup_count INTEGER DEFAULT 0,
  learned_by_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_words_lower ON words(word_lowercase);

CREATE TABLE user_vocabulary (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  word_id BIGINT REFERENCES words(id) ON DELETE CASCADE,
  word VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'unknown',
  mastery_level INTEGER DEFAULT 0,
  first_seen_at TIMESTAMP,
  last_reviewed_at TIMESTAMP,
  review_count INTEGER DEFAULT 0,
  correct_count INTEGER DEFAULT 0,
  wrong_count INTEGER DEFAULT 0,
  first_seen_context TEXT,
  first_seen_article_id BIGINT REFERENCES articles(id),
  next_review_at TIMESTAMP,
  ease_factor DECIMAL(3,2) DEFAULT 2.50,
  interval_days INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, word_id)
);
CREATE INDEX idx_user_vocab_next ON user_vocabulary(user_id, next_review_at);

CREATE TABLE reading_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  article_id BIGINT REFERENCES articles(id) ON DELETE SET NULL,
  session_start TIMESTAMP NOT NULL,
  session_end TIMESTAMP,
  duration_seconds INTEGER,
  progress_percentage INTEGER DEFAULT 0,
  words_read INTEGER DEFAULT 0,
  words_looked_up INTEGER DEFAULT 0,
  words_marked INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_reading_user ON reading_sessions(user_id);

CREATE TABLE word_interactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  word_id BIGINT REFERENCES words(id) ON DELETE CASCADE,
  article_id BIGINT REFERENCES articles(id) ON DELETE SET NULL,
  reading_session_id BIGINT REFERENCES reading_sessions(id) ON DELETE SET NULL,
  interaction_type VARCHAR(50), -- lookup, mark_unknown, mark_learning, mark_known
  context_sentence TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_word_inter_user ON word_interactions(user_id, created_at DESC);

CREATE TABLE daily_stats (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  reading_time_seconds INTEGER DEFAULT 0,
  listening_time_seconds INTEGER DEFAULT 0,
  total_time_seconds INTEGER DEFAULT 0,
  new_words_learned INTEGER DEFAULT 0,
  words_reviewed INTEGER DEFAULT 0,
  words_mastered INTEGER DEFAULT 0,
  articles_read INTEGER DEFAULT 0,
  articles_completed INTEGER DEFAULT 0,
  daily_goal_achieved BOOLEAN DEFAULT FALSE,
  streak_continued BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, date)
);
CREATE INDEX idx_daily_stats_user ON daily_stats(user_id, date DESC);

