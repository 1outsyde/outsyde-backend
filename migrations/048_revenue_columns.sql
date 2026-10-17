-- Migration 048: revenue columns (Part A, pending bookings & revenue fix)
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- Every full-row read of orders, appointments and shoot_bookings selects these columns once the
-- code is live, so deploying the code first would break those reads with "column does not exist".
-- Every statement is idempotent: safe to re-run. Additive only: no existing column changes, no data written.
--
--   orders.paid_at                              when the order became paid. Existing paid orders stay NULL;
--                                               the code reads COALESCE(paid_at, created_at).
--   appointments.cancellation_fee_kept_cents    fee charged when a customer cancels a confirmed booking.
--   shoot_bookings.cancellation_fee_kept_cents  same for photographer bookings. The fee is charged to
--                                               Outsyde's platform account, so it is Outsyde revenue only.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_fee_kept_cents INTEGER;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS cancellation_fee_kept_cents INTEGER;

-- Verify (read-only), expect 3 rows:
-- SELECT table_name, column_name, data_type FROM information_schema.columns
--  WHERE (table_name = 'orders' AND column_name = 'paid_at')
--     OR (table_name IN ('appointments','shoot_bookings') AND column_name = 'cancellation_fee_kept_cents');
