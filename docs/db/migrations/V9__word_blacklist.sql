-- V9: 词汇黑名单机制
-- 用于防止被清理的垃圾词汇被重新导入

-- 添加黑名单标记字段
ALTER TABLE words ADD COLUMN IF NOT EXISTS is_blacklisted BOOLEAN DEFAULT FALSE;

-- 添加黑名单时间字段
ALTER TABLE words ADD COLUMN IF NOT EXISTS blacklisted_at TIMESTAMP;

-- 添加黑名单原因字段（可选，用于记录为什么被加入黑名单）
ALTER TABLE words ADD COLUMN IF NOT EXISTS blacklist_reason VARCHAR(255);

-- 创建索引以便快速查询黑名单词汇
CREATE INDEX IF NOT EXISTS idx_words_blacklisted ON words(is_blacklisted) WHERE is_blacklisted = TRUE;

-- 注释说明
COMMENT ON COLUMN words.is_blacklisted IS '是否在黑名单中，黑名单词汇不会被自动导入';
COMMENT ON COLUMN words.blacklisted_at IS '加入黑名单的时间';
COMMENT ON COLUMN words.blacklist_reason IS '加入黑名单的原因';
