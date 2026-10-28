-- Migration 076: business setup checklist defaults (Manage Business step 3, 2026-10-28).
--
--   businesses.cancellation_policy_set_at  when the business last chose its cancellation policy.
--     NULL = never chosen. full_refund_window defaults to 'never', so before this column a business
--     that picked "no refunds" looked the same as one that never picked anything.
--     Stamped by PUT /api/vendor/my-business/cancellation-policy and
--     POST /api/vendor/services/:id/apply-cancellation-policy-to-all.
--   businesses.default_deposit_cents  deposit the app and sites pre-fill on NEW services only.
--     NULL = no default. Never applied by the backend, never changes existing services or bookings.
--
-- Backfill: until now the business policy could only be written by apply-cancellation-policy-to-all,
-- so a business whose policy differs from the column defaults has already chosen one. On 2026-10-28
-- that is 1 of 18 businesses (New York Braids). The others stay NULL (not chosen yet).
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: two nullable columns, no defaults.
-- Every full-row select on businesses needs these columns to exist before the code deploys.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cancellation_policy_set_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS default_deposit_cents      INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_default_deposit_cents_check') THEN
    ALTER TABLE businesses ADD CONSTRAINT businesses_default_deposit_cents_check
      CHECK (default_deposit_cents IS NULL OR default_deposit_cents >= 700);
  END IF;
END $$;

UPDATE businesses
   SET cancellation_policy_set_at = now()
 WHERE cancellation_policy_set_at IS NULL
   AND (COALESCE(full_refund_window, 'never') <> 'never'
        OR COALESCE(has_partial_refund, false)
        OR COALESCE(has_cancellation_fee, false));
