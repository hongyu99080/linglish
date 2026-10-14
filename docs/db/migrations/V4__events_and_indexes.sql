-- Events table for analytics + useful indexes

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  event_time TIMESTAMP NOT NULL,
  event_name VARCHAR(100) NOT NULL,
  properties JSONB,
  source VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_events_user_time ON events(user_id, event_time DESC);
CREATE INDEX idx_events_name_time ON events(event_name, event_time DESC);

-- Fulltext index for articles (English config)
CREATE INDEX idx_articles_fulltext
  ON articles USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')));

-- Helpful partial index for published articles
CREATE INDEX idx_articles_published
  ON articles(id) WHERE status='published';

