-- Events & Ticketing Phase 2, PR 4: refunds.
--
-- A refund happens in two steps so a Stripe error can never lose it:
--   1. One SQL statement records the refund on the order (status 'refunding', how much, why), gives the
--      seats back and marks the tickets refunded.
--   2. Stripe is asked for the refund with a fixed key (ticket_refund_<orderId>_<reason>). On success the
--      order becomes 'refunded'. On an error the every-minute job tries again later.
--
-- Amounts (decided by Legend 2026-10-19):
--   buyer refund under the host's policy, or a host refunding one order: the ticket price back, Outsyde keeps the service fee
--   host cancels the event: everything back, fees included (Outsyde absorbs the Stripe fee)
--
-- Safe to run twice. Adds nullable or defaulted columns only and widens one CHECK.

ALTER TABLE ticket_orders DROP CONSTRAINT IF EXISTS ticket_orders_status_check;
ALTER TABLE ticket_orders ADD CONSTRAINT ticket_orders_status_check
  CHECK (status IN ('pending', 'completed', 'expired', 'cancelled', 'refunding', 'refunded'));

ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS refund_reason          TEXT;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS refund_amount_cents    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS refund_requested_at    TIMESTAMPTZ;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS refund_requested_by    VARCHAR(36);
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS refund_attempts        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS refund_next_attempt_at TIMESTAMPTZ;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS refund_last_error      TEXT;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS stripe_refund_id       TEXT;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS refunded_at            TIMESTAMPTZ;

ALTER TABLE ticket_orders DROP CONSTRAINT IF EXISTS ticket_orders_refund_reason_valid;
ALTER TABLE ticket_orders ADD CONSTRAINT ticket_orders_refund_reason_valid
  CHECK (refund_reason IS NULL OR refund_reason IN ('buyer', 'host', 'event_cancelled'));

-- refund_amount_cents is the refund still to send. Already refunded plus still to send never passes the total.
ALTER TABLE ticket_orders DROP CONSTRAINT IF EXISTS ticket_orders_refund_pending_valid;
ALTER TABLE ticket_orders ADD CONSTRAINT ticket_orders_refund_pending_valid
  CHECK (refund_amount_cents >= 0 AND refund_attempts >= 0 AND refunded_cents + refund_amount_cents <= total_cents);

-- A refunding order always knows why and how much.
ALTER TABLE ticket_orders DROP CONSTRAINT IF EXISTS ticket_orders_refunding_has_amount;
ALTER TABLE ticket_orders ADD CONSTRAINT ticket_orders_refunding_has_amount
  CHECK (status <> 'refunding' OR (refund_reason IS NOT NULL AND refund_amount_cents > 0));

CREATE INDEX IF NOT EXISTS idx_ticket_orders_refunding
  ON ticket_orders (refund_next_attempt_at NULLS FIRST)
  WHERE status = 'refunding' AND needs_review_at IS NULL;

-- Verify (read-only): expect the new columns, 0 refunding orders.
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'ticket_orders' AND column_name LIKE 'refund%' OR column_name IN ('stripe_refund_id', 'refunded_at');
-- SELECT status, count(*) FROM ticket_orders GROUP BY status;
