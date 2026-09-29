-- Migration 035: shoot booking settlement marker
-- Same columns and types as migration 033 added to appointments. settled_at
-- is claimed once per shoot booking before the photographer payout and points
-- run, so Accept and the payment_intent.succeeded webhook cannot both settle
-- the same booking. Existing confirmed/completed rows are backfilled as
-- already settled so the new code never pays them out or awards points again.
-- No statement may contain a semicolon: scripts/migrate.ts splits on it.

ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS settled_at timestamptz;

ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS stripe_transfer_id text;

UPDATE shoot_bookings SET settled_at = COALESCE(updated_at, now()) WHERE status IN ('confirmed','completed') AND settled_at IS NULL;
