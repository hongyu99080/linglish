-- ============================================================================
-- V17: Smart Vocabulary Import System
-- ============================================================================
-- Purpose: Implement intelligent vocabulary import with user confirmation
--
-- Features:
--   1. Record word occurrences and clicks during video watching
--   2. Generate personalized word recommendations based on user level
--   3. User confirms which words to import after video ends
--   4. Persist learning context for SRS review (video-independent)
--
-- Key Tables:
--   - video_word_events: Raw events (occurrences, clicks) - append-only
--   - video_learning_sessions: Session state machine (active → finished → committed)
--   - video_import_decisions: User selection and import status
--
-- Constraints:
--   - user_vocabulary must reference words table (global vocabulary)
--   - New words are auto-added to global vocabulary during import
--   - learning_context persists sentence text for video-independent review
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Video Word Events - Fact Layer (append-only)
-- ============================================================================
-- Records occurrences and clicks during video watching
-- Only stores facts, no business logic

CREATE TABLE IF NOT EXISTS video_word_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id BIGINT NOT NULL REFERENCES video_resources(id) ON DELETE CASCADE,
  session_id VARCHAR(36) NOT NULL,

  -- Word information (lemma is the key)
  lemma VARCHAR(100) NOT NULL,
  original_form VARCHAR(100) NOT NULL,
  frequency_rank INTEGER,
  computed_level VARCHAR(20),

  -- Event type and location
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('occurrence', 'click')),
  segment_index INTEGER,

  -- Context (persisted sentence text)
  sentence_text TEXT,
  word_position_start INTEGER,
  word_position_end INTEGER,
  prev_sentence TEXT,
  next_sentence TEXT,

  -- Lemmatization metadata
  lemma_source VARCHAR(20) DEFAULT 'rules',
  lemma_confidence DECIMAL(3,2) DEFAULT 1.0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Deduplication: same segment, same word, same event type (occurrence) = one record
-- Click events allow multiple records
CREATE UNIQUE INDEX idx_unique_occurrence_per_segment
  ON video_word_events (user_id, session_id, lemma, segment_index, event_type)
  WHERE event_type = 'occurrence';

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_vwe_session ON video_word_events(session_id);
CREATE INDEX IF NOT EXISTS idx_vwe_user_session ON video_word_events(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_vwe_user_session_lemma ON video_word_events(user_id, session_id, lemma);
CREATE INDEX IF NOT EXISTS idx_vwe_video ON video_word_events(video_id);
CREATE INDEX IF NOT EXISTS idx_vwe_created ON video_word_events(created_at);

COMMENT ON TABLE video_word_events IS 'Raw word events during video watching - append-only facts';
COMMENT ON COLUMN video_word_events.lemma IS 'Normalized word root (walk for walked/walking)';
COMMENT ON COLUMN video_word_events.event_type IS 'occurrence=word appeared, click=user clicked to look up';
COMMENT ON COLUMN video_word_events.lemma_source IS 'Source of lemmatization: nlp, rules, fallback';


-- ============================================================================
-- 2. Video Learning Sessions - State Machine Layer
-- ============================================================================
-- Tracks session lifecycle: active → finished → committed/expired/abandoned

CREATE TABLE IF NOT EXISTS video_learning_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(36) UNIQUE NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id BIGINT NOT NULL REFERENCES video_resources(id) ON DELETE CASCADE,

  -- User context at session start
  user_level VARCHAR(20) NOT NULL DEFAULT 'beginner'
    CHECK (user_level IN ('beginner', 'intermediate', 'advanced')),
  import_budget INTEGER NOT NULL DEFAULT 12,

  -- Watching progress (only written on finish)
  watched_segment_indices INTEGER[] DEFAULT '{}',
  total_watch_duration_sec INTEGER DEFAULT 0,

  -- Aggregated statistics (computed on finish)
  unique_lemmas_encountered INTEGER DEFAULT 0,
  lemmas_clicked INTEGER DEFAULT 0,
  total_occurrences INTEGER DEFAULT 0,

  -- State machine
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'finished', 'committed', 'expired', 'abandoned')),
  finished_at TIMESTAMP,
  committed_at TIMESTAMP,
  expired_at TIMESTAMP,

  -- Import decision (filled after user confirms)
  import_mode VARCHAR(20) CHECK (import_mode IN ('recommended', 'clicked_only', 'custom', 'none')),
  words_imported INTEGER DEFAULT 0,
  words_skipped INTEGER DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vls_user ON video_learning_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_vls_user_status ON video_learning_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_vls_video ON video_learning_sessions(video_id);
CREATE INDEX IF NOT EXISTS idx_vls_created ON video_learning_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_vls_status_finished ON video_learning_sessions(status, finished_at)
  WHERE status = 'finished';

COMMENT ON TABLE video_learning_sessions IS 'Video learning session state machine';
COMMENT ON COLUMN video_learning_sessions.watched_segment_indices IS 'Array of segment indices actually watched';
COMMENT ON COLUMN video_learning_sessions.status IS 'active→finished→committed/expired/abandoned';


-- ============================================================================
-- 3. Video Import Decisions - Decision Layer
-- ============================================================================
-- Stores system recommendations and user selections for each word

CREATE TABLE IF NOT EXISTS video_import_decisions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id VARCHAR(36) NOT NULL,

  -- Word info
  lemma VARCHAR(100) NOT NULL,
  original_forms TEXT[], -- All original forms seen (walked, walking)

  -- Statistics from events
  occurrence_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  first_seen_segment INTEGER,

  -- Best context (for import to SRS)
  best_sentence_text TEXT,
  best_word_position_start INTEGER,
  best_word_position_end INTEGER,
  best_prev_sentence TEXT,
  best_next_sentence TEXT,
  best_segment_index INTEGER,

  -- System recommendation (generated on finish)
  priority_score DECIMAL(5,2) DEFAULT 0,
  recommendation_reason VARCHAR(50),
  is_recommended BOOLEAN DEFAULT FALSE,

  -- User decision (filled when user makes choice)
  user_selected BOOLEAN, -- NULL=undecided, true=selected, false=deselected
  decision_at TIMESTAMP,

  -- Import result
  imported BOOLEAN DEFAULT FALSE,
  imported_at TIMESTAMP,
  word_id BIGINT REFERENCES words(id), -- Link to global vocabulary
  user_vocabulary_id BIGINT REFERENCES user_vocabulary(id), -- Link to user's vocabulary

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, session_id, lemma)
);

CREATE INDEX IF NOT EXISTS idx_vid_session ON video_import_decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_vid_user_session ON video_import_decisions(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_vid_recommended ON video_import_decisions(session_id, is_recommended)
  WHERE is_recommended = TRUE;
CREATE INDEX IF NOT EXISTS idx_vid_user_selected ON video_import_decisions(session_id, user_selected)
  WHERE user_selected = TRUE;

COMMENT ON TABLE video_import_decisions IS 'Word import decisions - system recommendations and user choices';
COMMENT ON COLUMN video_import_decisions.user_selected IS 'NULL=undecided, true=user selected, false=user deselected';
COMMENT ON COLUMN video_import_decisions.recommendation_reason IS 'user_clicked, high_frequency, level_match, etc.';


-- ============================================================================
-- 4. Extend vocabulary_level_config with import_budget
-- ============================================================================

ALTER TABLE vocabulary_level_config
  ADD COLUMN IF NOT EXISTS import_budget INTEGER DEFAULT 12;

UPDATE vocabulary_level_config SET import_budget = 8 WHERE level = 'beginner';
UPDATE vocabulary_level_config SET import_budget = 12 WHERE level = 'intermediate';
UPDATE vocabulary_level_config SET import_budget = 18 WHERE level = 'advanced';

COMMENT ON COLUMN vocabulary_level_config.import_budget IS 'Max words to recommend per video session';


-- ============================================================================
-- 5. Extend user_vocabulary with learning_context
-- ============================================================================
-- Stores sentence context for SRS review (video-independent)

ALTER TABLE user_vocabulary
  ADD COLUMN IF NOT EXISTS learning_context JSONB;

COMMENT ON COLUMN user_vocabulary.learning_context IS 'Learning context JSON: {version, sentence, wordSpan, prevSentence, nextSentence, source}';

-- Index for querying words with/without context
CREATE INDEX IF NOT EXISTS idx_uv_has_context ON user_vocabulary((learning_context IS NOT NULL))
  WHERE learning_context IS NOT NULL;


-- ============================================================================
-- 6. Helper function: Get known/mastered lemmas for a user
-- ============================================================================

CREATE OR REPLACE FUNCTION get_user_known_lemmas(p_user_id BIGINT)
RETURNS TABLE(lemma VARCHAR(100)) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT w.word_lowercase::VARCHAR(100) AS lemma
  FROM user_vocabulary uv
  JOIN words w ON w.id = uv.word_id
  WHERE uv.user_id = p_user_id
    AND uv.status IN ('known', 'mastered');
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_user_known_lemmas(BIGINT) IS 'Get all known/mastered lemmas for filtering recommendations';


-- ============================================================================
-- 7. Helper function: Calculate word priority score
-- ============================================================================

CREATE OR REPLACE FUNCTION calculate_word_priority(
  p_click_count INTEGER,
  p_occurrence_count INTEGER,
  p_word_level VARCHAR(20),
  p_user_level VARCHAR(20),
  p_frequency_rank INTEGER
)
RETURNS DECIMAL(5,2) AS $$
DECLARE
  score DECIMAL(5,2) := 0;
  level_order_word INTEGER;
  level_order_user INTEGER;
BEGIN
  -- 1. User clicked = highest priority (not limited by level)
  IF p_click_count > 0 THEN
    RETURN 100.0;
  END IF;

  -- 2. Occurrence count (0-30 points)
  score := score + LEAST(30, p_occurrence_count * 15);

  -- 3. Level matching (0-40 points)
  level_order_word := CASE p_word_level
    WHEN 'beginner' THEN 1
    WHEN 'intermediate' THEN 2
    WHEN 'advanced' THEN 3
    ELSE 2
  END;
  level_order_user := CASE p_user_level
    WHEN 'beginner' THEN 1
    WHEN 'intermediate' THEN 2
    WHEN 'advanced' THEN 3
    ELSE 1
  END;

  IF level_order_word = level_order_user THEN
    score := score + 40;  -- Same level
  ELSIF level_order_word = level_order_user + 1 THEN
    score := score + 30;  -- One level higher
  ELSIF level_order_word = level_order_user - 1 THEN
    score := score + 10;  -- One level lower
  END IF;
  -- More than 1 level difference = 0 points

  -- 4. Frequency rank bonus (0-15 points)
  IF p_frequency_rank IS NOT NULL AND p_frequency_rank > 0 THEN
    score := score + GREATEST(0, 15 - FLOOR(p_frequency_rank / 1000.0));
  END IF;

  RETURN score;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION calculate_word_priority IS 'Calculate priority score for word recommendation (0-100)';


-- ============================================================================
-- 8. Session expiration: Mark old finished sessions as expired
-- ============================================================================
-- This can be run periodically via cron job

CREATE OR REPLACE FUNCTION expire_old_sessions()
RETURNS INTEGER AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE video_learning_sessions
  SET status = 'expired',
      expired_at = NOW(),
      updated_at = NOW()
  WHERE status = 'finished'
    AND finished_at < NOW() - INTERVAL '24 hours';

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION expire_old_sessions() IS 'Mark finished sessions older than 24h as expired';


-- ============================================================================
-- 9. View: Session summary with word counts
-- ============================================================================

CREATE OR REPLACE VIEW video_session_summary AS
SELECT
  vls.id,
  vls.session_id,
  vls.user_id,
  vls.video_id,
  vls.user_level,
  vls.status,
  vls.unique_lemmas_encountered,
  vls.lemmas_clicked,
  vls.words_imported,
  vls.created_at,
  vls.finished_at,
  vls.committed_at,
  vr.title AS video_title,
  u.username,
  (SELECT COUNT(*) FROM video_import_decisions vid
   WHERE vid.session_id = vls.session_id AND vid.is_recommended = TRUE) AS recommended_count,
  (SELECT COUNT(*) FROM video_import_decisions vid
   WHERE vid.session_id = vls.session_id AND vid.user_selected = TRUE) AS selected_count
FROM video_learning_sessions vls
LEFT JOIN video_resources vr ON vr.id = vls.video_id
LEFT JOIN users u ON u.id = vls.user_id;

COMMENT ON VIEW video_session_summary IS 'Summary view of learning sessions with video and user info';


-- ============================================================================
-- 10. Trigger: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to new tables
DROP TRIGGER IF EXISTS update_video_learning_sessions_timestamp ON video_learning_sessions;
CREATE TRIGGER update_video_learning_sessions_timestamp
  BEFORE UPDATE ON video_learning_sessions
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_video_import_decisions_timestamp ON video_import_decisions;
CREATE TRIGGER update_video_import_decisions_timestamp
  BEFORE UPDATE ON video_import_decisions
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();


COMMIT;

-- ============================================================================
-- Migration Summary
-- ============================================================================
-- Tables created:
--   1. video_word_events - Raw occurrence/click events
--   2. video_learning_sessions - Session state machine
--   3. video_import_decisions - Recommendations and user choices
--
-- Columns added:
--   - vocabulary_level_config.import_budget
--   - user_vocabulary.learning_context (JSONB)
--
-- Functions created:
--   - get_user_known_lemmas(user_id)
--   - calculate_word_priority(click_count, occurrence_count, word_level, user_level, frequency_rank)
--   - expire_old_sessions()
--
-- Views created:
--   - video_session_summary
-- ============================================================================
