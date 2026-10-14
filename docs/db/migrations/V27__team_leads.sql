CREATE TABLE IF NOT EXISTS team_leads (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  visitor_id TEXT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  organization TEXT NOT NULL,
  role TEXT,
  team_size TEXT,
  use_case TEXT,
  source TEXT DEFAULT 'pricing',
  intent TEXT DEFAULT 'team',
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_leads_created_at
  ON team_leads (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_leads_status_created
  ON team_leads (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_leads_email
  ON team_leads (lower(email));
