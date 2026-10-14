-- V9: Stripe Subscription System
-- Adds Stripe customer/subscription fields to users table
-- and a payments table to track payment history

-- ── Users table: add Stripe subscription columns ─────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_customer_id       TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS subscription_id          TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status      TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS subscription_end_date    TIMESTAMP;

-- Fast lookup by Stripe customer ID (used in webhook handler)
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id
  ON users(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ── Payments table ────────────────────────────────────────────────────────────
-- Records every completed Stripe payment / invoice.
-- stripe_payment_id holds either a PaymentIntent ID (pi_...) or Invoice ID (in_...).

CREATE TABLE IF NOT EXISTS payments (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  stripe_payment_id  TEXT NOT NULL UNIQUE,
  amount             INTEGER NOT NULL,         -- amount in cents (e.g. 999 = $9.99)
  currency           TEXT NOT NULL DEFAULT 'usd',
  status             TEXT NOT NULL,            -- 'succeeded', 'pending', 'failed', etc.
  description        TEXT,                     -- human-readable label (e.g. 'Monthly VIP')
  created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id
  ON payments(user_id);

CREATE INDEX IF NOT EXISTS idx_payments_stripe_payment_id
  ON payments(stripe_payment_id);
