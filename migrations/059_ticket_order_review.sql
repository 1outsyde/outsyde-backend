-- Migration 059: ticket order job bookkeeping (Events & Ticketing Phase 2, paid checkout)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: three nullable columns + one index on ticket_orders (0 rows today).
--
--   last_checked_at  when the every-minute job last asked Stripe about this pending order. The job takes
--                    the least recently checked first, so a few stuck orders can't block newer ones.
--   needs_review_at  set once when a paid order can't be settled automatically (amount or payment doesn't
--                    match). The job skips it from then on and the admin is emailed once, not every minute.
--   review_reason    short reason for that flag.

ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS needs_review_at TIMESTAMPTZ;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS review_reason   TEXT;

CREATE INDEX IF NOT EXISTS idx_ticket_orders_pending_check
  ON ticket_orders (last_checked_at NULLS FIRST, created_at)
  WHERE status = 'pending' AND needs_review_at IS NULL;

-- Verify (read-only): expect the 3 columns and 0 rows.
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'ticket_orders'
--   AND column_name IN ('last_checked_at', 'needs_review_at', 'review_reason');
