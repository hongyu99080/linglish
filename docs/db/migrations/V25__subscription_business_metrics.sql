-- V25: Subscription business metrics durability
-- Ensures fresh deployments have the payment ledger and LemonSqueezy user columns
-- required by webhook processing and admin revenue analytics.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ls_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS ls_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS ls_variant_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS subscription_end_date TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_users_ls_customer_id
  ON users(ls_customer_id)
  WHERE ls_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_ls_subscription_id
  ON users(ls_subscription_id)
  WHERE ls_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ls_payment_id TEXT NOT NULL UNIQUE,
  amount        INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'usd',
  status        TEXT NOT NULL,
  description   TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS ls_payment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_user_id
  ON payments(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_ls_payment_id_unique
  ON payments(ls_payment_id);

CREATE INDEX IF NOT EXISTS idx_payments_ls_payment_id
  ON payments(ls_payment_id);

CREATE INDEX IF NOT EXISTS idx_payments_status_created
  ON payments(status, created_at DESC);
