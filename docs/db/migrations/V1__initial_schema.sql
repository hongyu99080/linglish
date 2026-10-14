-- Users & Profiles, Articles, Rights, Media, Segments (基础骨架)

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  phone VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  level VARCHAR(20),
  membership_type VARCHAR(20) DEFAULT 'free',
  membership_expires_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'active',
  email_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP
);

CREATE TABLE user_profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  native_language VARCHAR(10) DEFAULT 'zh-CN',
  target_language VARCHAR(10) DEFAULT 'en',
  daily_goal INTEGER DEFAULT 15,
  interests TEXT[],
  theme VARCHAR(20) DEFAULT 'light',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
);

CREATE TABLE articles (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  content TEXT NOT NULL,
  author VARCHAR(200),
  source_url VARCHAR(1000),
  source_type VARCHAR(50),        -- original/imported/ugc
  category VARCHAR(100),
  tags TEXT[],
  level VARCHAR(20),
  word_count INTEGER,
  difficulty_score DECIMAL(3,2),
  audio_url VARCHAR(500),
  audio_duration INTEGER,
  read_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  save_count INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft',
  is_featured BOOLEAN DEFAULT FALSE,
  is_premium BOOLEAN DEFAULT FALSE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP
);

CREATE TABLE content_rights (
  id BIGSERIAL PRIMARY KEY,
  source_type VARCHAR(30),
  license_type VARCHAR(50),
  source_url VARCHAR(1000),
  owner VARCHAR(200),
  valid_from DATE, valid_to DATE,
  usage_scope VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE media_assets (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT REFERENCES articles(id) ON DELETE SET NULL,
  kind VARCHAR(20),               -- audio/image/subtitle
  url VARCHAR(1000) NOT NULL,
  duration_sec INTEGER,
  meta JSONB,
  rights_id BIGINT REFERENCES content_rights(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audio_segments (
  id BIGSERIAL PRIMARY KEY,
  media_id BIGINT REFERENCES media_assets(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT,
  confidence NUMERIC(4,3),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_articles_status ON articles(status);
CREATE INDEX idx_media_article ON media_assets(article_id);
CREATE INDEX idx_segments_media ON audio_segments(media_id);

