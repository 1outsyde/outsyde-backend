-- Migration 050: promo codes can be held by one checkout ('reserved')
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- The new checkout code sets status = 'reserved' while a payment is in progress; without this
-- the old CHECK constraint rejects it and every checkout that uses a code fails.
-- Idempotent: safe to re-run. Widens the allowed values only; no data changes.

ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_status_check;
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'reserved'::text, 'used'::text, 'expired'::text]));

-- Looks up the code a checkout holds or used (release / restore by reference).
CREATE INDEX IF NOT EXISTS idx_promo_codes_reference
  ON promo_codes (used_on_reference_type, used_on_order_id)
  WHERE used_on_order_id IS NOT NULL;
