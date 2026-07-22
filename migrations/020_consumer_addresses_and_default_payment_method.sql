-- Migration 020: Consumer saved addresses + default payment method
-- Run in Neon SQL Editor

-- 1. New column on users: stores the Stripe pm_xxx the consumer has chosen as default
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_payment_method_id TEXT;

-- 2. New table: per-consumer address book
CREATE TABLE IF NOT EXISTS consumer_addresses (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT,                                      -- user-defined label, e.g. "Home"
  line1        TEXT        NOT NULL,
  city         TEXT        NOT NULL,
  state        TEXT        NOT NULL,
  zip_code     TEXT        NOT NULL,
  is_default   BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consumer_addresses_user_id_idx ON consumer_addresses(user_id);
