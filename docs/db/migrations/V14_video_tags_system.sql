BEGIN;

-- 全局标签表
CREATE TABLE IF NOT EXISTS tags (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  scope TEXT NOT NULL DEFAULT 'global', -- 目前只存 'global'
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 个人标签表（仅 owner 可见/可改）
CREATE TABLE IF NOT EXISTS user_tags (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

-- 视频-标签关联（可同时存在全局标签和个人标签）：
-- 方案 A：拆两张表
CREATE TABLE IF NOT EXISTS video_tags (
  video_id BIGINT NOT NULL REFERENCES video_resources(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id), -- 谁打的标签，可选
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, tag_id)
);

CREATE TABLE IF NOT EXISTS video_user_tags (
  video_id BIGINT NOT NULL REFERENCES video_resources(id) ON DELETE CASCADE,
  user_tag_id BIGINT NOT NULL REFERENCES user_tags(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- 限定 owner
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, user_tag_id)
);

-- 用户对全局标签的偏好（隐藏/置顶/别名）
CREATE TABLE IF NOT EXISTS user_tag_preferences (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  alias TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, tag_id)
);

COMMIT;

