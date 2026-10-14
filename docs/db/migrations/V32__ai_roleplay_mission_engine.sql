-- V32: AI roleplay mission engine schema and curated scenario seeds.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_roleplay_scenarios (
  id TEXT PRIMARY KEY,
  title_zh TEXT NOT NULL,
  title_en TEXT NOT NULL,
  category TEXT NOT NULL,
  cefr_min TEXT NOT NULL,
  cefr_max TEXT NOT NULL,
  learner_role TEXT NOT NULL,
  assistant_role TEXT NOT NULL,
  opening_line TEXT NOT NULL,
  opening_translation_zh TEXT NOT NULL,
  goals JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_phrases JSONB NOT NULL DEFAULT '[]'::jsonb,
  fallback_turns JSONB NOT NULL DEFAULT '{}'::jsonb,
  turn_limit INTEGER NOT NULL DEFAULT 4 CHECK (turn_limit BETWEEN 1 AND 8),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_roleplay_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL REFERENCES ai_roleplay_scenarios(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned','failed')),
  cefr_level TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  turn_limit INTEGER NOT NULL CHECK (turn_limit BETWEEN 1 AND 8),
  mission_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_summary JSONB,
  source TEXT NOT NULL DEFAULT 'catalog',
  transport_mode TEXT NOT NULL DEFAULT 'asr_tts',
  model_used TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ai_roleplay_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES ai_roleplay_sessions(id) ON DELETE CASCADE,
  turn_key UUID NOT NULL,
  turn_index INTEGER NOT NULL CHECK (turn_index BETWEEN 1 AND 8),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  learner_text TEXT NOT NULL,
  assistant_text TEXT,
  assistant_translation_zh TEXT,
  evaluation JSONB,
  turn_result JSONB,
  pronunciation_summary JSONB,
  response_mode TEXT CHECK (response_mode IS NULL OR response_mode IN ('ai','fallback')),
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, turn_key),
  UNIQUE (session_id, turn_index)
);

ALTER TABLE ai_roleplay_turns
  ADD COLUMN IF NOT EXISTS turn_result JSONB;

CREATE INDEX IF NOT EXISTS idx_ai_roleplay_scenarios_catalog
  ON ai_roleplay_scenarios(is_active, category, sort_order);

CREATE INDEX IF NOT EXISTS idx_ai_roleplay_sessions_user_status
  ON ai_roleplay_sessions(user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_roleplay_sessions_scenario
  ON ai_roleplay_sessions(scenario_id);

CREATE INDEX IF NOT EXISTS idx_ai_roleplay_sessions_expires
  ON ai_roleplay_sessions(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_roleplay_turns_session_status
  ON ai_roleplay_turns(session_id, status, updated_at DESC);

INSERT INTO ai_roleplay_scenarios
  (id, title_zh, title_en, category, cefr_min, cefr_max, learner_role, assistant_role,
   opening_line, opening_translation_zh, goals, target_phrases, fallback_turns, turn_limit, is_active, sort_order)
VALUES
  (
    'coffee-order-a1',
    '点咖啡',
    'Order coffee',
    'daily',
    'A1',
    'A1',
    'customer',
    'barista',
    'Hi! What would you like to drink today?',
    '你好！你今天想喝点什么？',
    '[{"id":"greet","required":true,"description_zh":"打招呼"},{"id":"order","required":true,"description_zh":"点一杯饮品"},{"id":"size","required":false,"description_zh":"说明杯型或温度"}]'::jsonb,
    '[{"text":"I would like a coffee, please.","meaning_zh":"我想要一杯咖啡。"},{"text":"Can I have it hot?","meaning_zh":"可以要热的吗？"}]'::jsonb,
    '{"clarification_prompt":"Please tell me what drink you want.","closer_prompt":"Thanks for ordering. Enjoy your drink!","goals":{"greet":"Say hello first.","order":"Try: I would like a coffee, please.","size":"You can say: small, medium, or hot."}}'::jsonb,
    4,
    TRUE,
    10
  ),
  (
    'hotel-checkin-a2',
    '酒店入住',
    'Hotel check-in',
    'travel',
    'A2',
    'A2',
    'guest',
    'front desk clerk',
    'Good evening. Welcome to our hotel. How can I help you?',
    '晚上好。欢迎来到我们酒店。有什么可以帮您？',
    '[{"id":"reservation","required":true,"description_zh":"说明自己有预订"},{"id":"name","required":true,"description_zh":"提供姓名"},{"id":"question","required":false,"description_zh":"询问早餐或退房时间"}]'::jsonb,
    '[{"text":"I have a reservation.","meaning_zh":"我有预订。"},{"text":"What time is check-out?","meaning_zh":"几点退房？"}]'::jsonb,
    '{"clarification_prompt":"Please tell me your name or reservation.","closer_prompt":"You are checked in. Enjoy your stay!","goals":{"reservation":"Say: I have a reservation.","name":"Tell me your name.","question":"Ask one hotel question."}}'::jsonb,
    5,
    TRUE,
    20
  ),
  (
    'job-interview-b1',
    '工作面试',
    'Job interview',
    'work',
    'B1',
    'B1',
    'candidate',
    'interviewer',
    'Thanks for coming in. Could you tell me about yourself?',
    '谢谢你来面试。可以介绍一下你自己吗？',
    '[{"id":"intro","required":true,"description_zh":"介绍背景"},{"id":"strength","required":true,"description_zh":"说明一个优势"},{"id":"example","required":false,"description_zh":"给出具体例子"}]'::jsonb,
    '[{"text":"I have experience in customer support.","meaning_zh":"我有客服经验。"},{"text":"One of my strengths is communication.","meaning_zh":"我的优势之一是沟通。"}]'::jsonb,
    '{"clarification_prompt":"Please answer with one short work detail.","closer_prompt":"Thank you. We will contact you soon.","goals":{"intro":"Tell me about your background.","strength":"Name one strength.","example":"Give a short example."}}'::jsonb,
    6,
    TRUE,
    30
  ),
  (
    'meeting-clarify-b1',
    '会议澄清',
    'Clarify in a meeting',
    'work',
    'B1',
    'B1',
    'teammate',
    'project lead',
    'Let us review the launch plan. Does everything make sense?',
    '我们来回顾发布计划。都清楚了吗？',
    '[{"id":"signal","required":true,"description_zh":"表示需要澄清"},{"id":"specific","required":true,"description_zh":"指出具体不清楚的点"},{"id":"confirm","required":false,"description_zh":"复述确认"}]'::jsonb,
    '[{"text":"Could you clarify the deadline?","meaning_zh":"你能澄清一下截止日期吗？"},{"text":"Do you mean this Friday?","meaning_zh":"你的意思是这个周五吗？"}]'::jsonb,
    '{"clarification_prompt":"Ask me to clarify one specific thing.","closer_prompt":"Great, the plan is clear now.","goals":{"signal":"Say you need clarification.","specific":"Ask about deadline, owner, or next step.","confirm":"Repeat what you understood."}}'::jsonb,
    6,
    TRUE,
    40
  ),
  (
    'travel-rebook-a2',
    '改签旅行',
    'Rebook travel',
    'travel',
    'A2',
    'A2',
    'traveler',
    'airline agent',
    'Hello. How can I help with your booking today?',
    '你好。今天我能如何帮助你的预订？',
    '[{"id":"problem","required":true,"description_zh":"说明需要改签"},{"id":"new_time","required":true,"description_zh":"提出新的时间"},{"id":"polite_close","required":false,"description_zh":"礼貌结束"}]'::jsonb,
    '[{"text":"I need to change my flight.","meaning_zh":"我需要改签航班。"},{"text":"Is there a flight tomorrow morning?","meaning_zh":"明天早上有航班吗？"}]'::jsonb,
    '{"clarification_prompt":"Please tell me what you want to change.","closer_prompt":"Your booking has been updated.","goals":{"problem":"Say you need to change your trip.","new_time":"Give a new day or time.","polite_close":"Say thank you."}}'::jsonb,
    5,
    TRUE,
    50
  ),
  (
    'colleague-smalltalk-a1',
    '同事闲聊',
    'Small talk with a colleague',
    'daily',
    'A1',
    'A1',
    'colleague',
    'coworker',
    'Hi! How is your day going?',
    '嗨！你今天过得怎么样？',
    '[{"id":"answer","required":true,"description_zh":"回答近况"},{"id":"ask_back","required":true,"description_zh":"反问对方"},{"id":"detail","required":false,"description_zh":"补充一个简单细节"}]'::jsonb,
    '[{"text":"My day is good.","meaning_zh":"我今天不错。"},{"text":"How about you?","meaning_zh":"你呢？"}]'::jsonb,
    '{"clarification_prompt":"Answer how your day is, then ask me back.","closer_prompt":"Nice talking with you. See you later!","goals":{"answer":"Say how your day is.","ask_back":"Ask: How about you?","detail":"Add one simple detail."}}'::jsonb,
    4,
    TRUE,
    60
  )
ON CONFLICT (id) DO UPDATE
SET title_zh = EXCLUDED.title_zh,
    title_en = EXCLUDED.title_en,
    category = EXCLUDED.category,
    cefr_min = EXCLUDED.cefr_min,
    cefr_max = EXCLUDED.cefr_max,
    learner_role = EXCLUDED.learner_role,
    assistant_role = EXCLUDED.assistant_role,
    opening_line = EXCLUDED.opening_line,
    opening_translation_zh = EXCLUDED.opening_translation_zh,
    goals = EXCLUDED.goals,
    target_phrases = EXCLUDED.target_phrases,
    fallback_turns = EXCLUDED.fallback_turns,
    turn_limit = EXCLUDED.turn_limit,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    updated_at = NOW();

COMMIT;
