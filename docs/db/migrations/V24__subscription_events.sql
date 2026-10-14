-- V24: Subscription webhook event audit trail
-- Records Lemon Squeezy webhook delivery and processing state so billing
-- entitlement issues can be inspected from the admin side.

CREATE TABLE IF NOT EXISTS subscription_events (
  id                 BIGSERIAL PRIMARY KEY,
  provider           TEXT NOT NULL DEFAULT 'lemonsqueezy',
  event_key          TEXT NOT NULL UNIQUE,
  event_name         TEXT NOT NULL,
  user_id            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ls_subscription_id TEXT,
  ls_customer_id     TEXT,
  ls_order_id        TEXT,
  ls_variant_id      TEXT,
  status             TEXT,
  amount             INTEGER,
  currency           TEXT,
  processed_status   TEXT NOT NULL DEFAULT 'received',
  error_message      TEXT,
  payload            JSONB NOT NULL,
  received_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at       TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_user_id
  ON subscription_events(user_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_events_event_name
  ON subscription_events(event_name, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_events_processed_status
  ON subscription_events(processed_status, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_events_ls_subscription_id
  ON subscription_events(ls_subscription_id)
  WHERE ls_subscription_id IS NOT NULL;
