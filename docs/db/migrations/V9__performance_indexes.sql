-- V9: Performance Optimization Indexes
--
-- Adds composite indexes for frequently queried patterns to improve
-- query performance and reduce API response times.
--
-- Note: All indexes created with CONCURRENTLY to avoid table locks.
-- Run during low-traffic periods for production deployments.

-- User vocabulary queries (list by status, recently added)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_vocabulary_user_status
  ON user_vocabulary(user_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_vocabulary_user_created
  ON user_vocabulary(user_id, created_at DESC);

-- Training session queries (recent sessions, dashboard)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_training_sessions_user_created
  ON training_sessions(user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_training_sessions_user_type_created
  ON training_sessions(user_id, session_type, created_at DESC);

-- Video sentence lookups (subtitle sync)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_sentences_video_start
  ON video_sentences(video_id, start_time);

-- Daily plan retrieval
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_daily_plans_user_date
  ON daily_plans(user_id, plan_date);

-- AI chat history pagination
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_chat_history_user_created
  ON ai_chat_history(user_id, created_at DESC);

-- Article sentence lookups (reading progress)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_article_sentences_article_order
  ON article_sentences(article_id, sentence_order);

-- Vocabulary review due dates (SRS) - partial index for efficiency
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vocabulary_reviews_user_next
  ON vocabulary_reviews(user_id, next_review_date)
  WHERE next_review_date IS NOT NULL;

-- Additional useful indexes for common queries

-- User progress queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_training_events_session_created
  ON training_events(session_id, created_at DESC);

-- Content lookup by type
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_articles_type_created
  ON articles(content_type, created_at DESC);

-- Media segments for audio/video playback
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_segments_media_start
  ON segments(media_id, start_time);
