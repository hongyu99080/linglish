-- V10: Migrate payment columns from Stripe to LemonSqueezy
-- Renames Stripe-specific columns and adds LemonSqueezy variant tracking.

ALTER TABLE users RENAME COLUMN stripe_customer_id TO ls_customer_id;
ALTER TABLE users RENAME COLUMN subscription_id TO ls_subscription_id;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ls_variant_id TEXT;

ALTER TABLE payments RENAME COLUMN stripe_payment_id TO ls_payment_id;
