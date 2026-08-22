-- Migration 006: Promo codes table for points redemption
-- Rules enforced by this schema:
--   1. Each code is tied to one user_id — only that user can apply it
--   2. status can only be 'active', 'used', or 'expired' — no other values
--   3. used_at, used_on_order_id, used_on_reference_type only populate when status = 'used'
--   4. One active code per user per dollar value enforced at application layer

CREATE TABLE IF NOT EXISTS promo_codes (
  id                       VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     TEXT UNIQUE NOT NULL,
  user_id                  VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points_cost              INTEGER NOT NULL,
  discount_cents           INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'used', 'expired')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ NOT NULL,
  used_at                  TIMESTAMPTZ,
  used_on_order_id         VARCHAR,
  used_on_reference_type   TEXT
                             CHECK (used_on_reference_type IN ('order', 'appointment', 'shoot_booking') OR used_on_reference_type IS NULL)
);

-- Fast lookup by user (show my active codes)
CREATE INDEX IF NOT EXISTS idx_promo_codes_user_id ON promo_codes(user_id);
-- Fast lookup by code string at checkout validation
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
-- Fast lookup by status (find all active codes for a user)
CREATE INDEX IF NOT EXISTS idx_promo_codes_user_status ON promo_codes(user_id, status);

-- Add discount tracking columns to orders
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS promo_code_used       TEXT,
  ADD COLUMN IF NOT EXISTS discount_amount_cents  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_redeemed        INTEGER DEFAULT 0;

-- Add discount tracking columns to appointments
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS promo_code_used       TEXT,
  ADD COLUMN IF NOT EXISTS discount_amount_cents  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_redeemed        INTEGER DEFAULT 0;

-- Add discount tracking columns to shoot_bookings
ALTER TABLE shoot_bookings
  ADD COLUMN IF NOT EXISTS promo_code_used       TEXT,
  ADD COLUMN IF NOT EXISTS discount_amount_cents  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_redeemed        INTEGER DEFAULT 0;
