-- V9: Video Tags System
-- 视频标签系统：支持预设标签和用户自定义标签

-- 标签表
CREATE TABLE IF NOT EXISTS video_tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  icon VARCHAR(10) DEFAULT '🏷️',
  color VARCHAR(7) DEFAULT '#667eea',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 唯一约束：系统标签不重复，用户标签在用户范围内不重复
CREATE UNIQUE INDEX idx_video_tags_system_unique ON video_tags(name) WHERE user_id IS NULL;
CREATE UNIQUE INDEX idx_video_tags_user_unique ON video_tags(user_id, name) WHERE user_id IS NOT NULL;

-- 视频-标签关联表（多对多关系）
CREATE TABLE IF NOT EXISTS video_tag_assignments (
  id SERIAL PRIMARY KEY,
  video_resource_id INTEGER NOT NULL REFERENCES video_resources(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES video_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(video_resource_id, tag_id)
);

-- 索引优化查询性能
CREATE INDEX idx_video_tag_assignments_video ON video_tag_assignments(video_resource_id);
CREATE INDEX idx_video_tag_assignments_tag ON video_tag_assignments(tag_id);
CREATE INDEX idx_video_tags_user ON video_tags(user_id);

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_video_tags_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_video_tags_updated_at
  BEFORE UPDATE ON video_tags
  FOR EACH ROW EXECUTE FUNCTION update_video_tags_updated_at();

-- 插入预设标签（系统全局标签，user_id 为 NULL）
INSERT INTO video_tags (name, icon, color, user_id) VALUES
  ('我的', '⭐', '#fbbf24', NULL),
  ('职场', '💼', '#3b82f6', NULL),
  ('购物', '🛒', '#10b981', NULL),
  ('生活', '🏠', '#8b5cf6', NULL),
  ('影视', '🎬', '#ef4444', NULL)
ON CONFLICT DO NOTHING;

-- 注释
COMMENT ON TABLE video_tags IS '视频标签表，支持系统预设标签和用户自定义标签';
COMMENT ON TABLE video_tag_assignments IS '视频-标签关联表，多对多关系';
COMMENT ON COLUMN video_tags.user_id IS 'NULL表示系统预设标签，非NULL表示用户自定义标签';
COMMENT ON COLUMN video_tags.icon IS '标签图标（emoji）';
COMMENT ON COLUMN video_tags.color IS '标签颜色（十六进制）';
