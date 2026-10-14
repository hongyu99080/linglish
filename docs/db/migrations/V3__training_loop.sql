-- Training Sessions & AI Scores

CREATE TABLE training_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(30),               -- shadowing/dictogloss/432/picture_label
  media_id BIGINT REFERENCES media_assets(id),
  segment_id BIGINT REFERENCES audio_segments(id),
  start_at TIMESTAMP,
  end_at TIMESTAMP,
  duration_sec INTEGER,
  output_blob TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_training_user_time ON training_sessions(user_id, created_at DESC);

CREATE TABLE ai_scores (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT REFERENCES training_sessions(id) ON DELETE CASCADE,
  metrics JSONB,                  -- {stress_hit:0.82, timing_var:0.15, wpm:140}
  grade VARCHAR(10),              -- A/B/C
  cost_cents INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ai_scores_session ON ai_scores(session_id);

