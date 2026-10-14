-- V9: Word Deep Analysis Cache
-- Stores AI-generated deep word analysis (etymology, core image, comparisons, mermaid chart, philosophy)
-- Cached permanently - generated once, reused forever

CREATE TABLE IF NOT EXISTS word_deep_cache (
  word        TEXT PRIMARY KEY,
  etymology   JSONB,
  core_image  JSONB,
  comparisons JSONB,
  mermaid_chart TEXT,
  philosophy  TEXT,
  raw_json    JSONB,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_word_deep_cache_word ON word_deep_cache(word);
