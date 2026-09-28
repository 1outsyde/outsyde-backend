-- Migration 033: appointment settlement marker
-- settled_at is claimed once per appointment before the vendor payout and
-- pending points run, so Accept and the payment_intent.succeeded webhook
-- cannot both settle the same booking. Existing confirmed/completed rows are
-- backfilled as already settled so the new code never pays them out again.
-- No statement may contain a semicolon: scripts/migrate.ts splits on it.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS settled_at timestamptz;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stripe_transfer_id text;

UPDATE appointments SET settled_at = COALESCE(updated_at, now()) WHERE status IN ('confirmed','completed') AND settled_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_points_reference ON pending_points_transactions (reference_type, reference_id);
