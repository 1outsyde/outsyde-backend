-- Migration 065: booking_refund_recoveries (booking refund recovery, P1 #5)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: one new table with its indexes, plus one new nullable column on
-- event_payout_recoveries. Nothing existing changes.
--
-- After a booking refund (appointment or shoot booking), the seller's share is later taken back from their Stripe
-- transfer. One row per Stripe refund; refund_id is UNIQUE, so recording the same refund twice is a no-op.
--
--   refund_id / payment_intent_id / refund_cents   the Stripe refund recorded; refund_created_at is Stripe's created time
--   reference_type / reference_id                  the booking it belongs to (appointment or shoot_booking), once resolved
--   recipient                                      who is paid on it: business, staff or photographer
--   connected_account_id                           the seller's Stripe account the transfer went to
--   amount_cents                                   the seller share to take back for this refund
--   reversed_cents                                 how much has been reversed on Stripe so far
--   status            'pending' -> 'reversed' | 'owed' -> 'recovered', or 'nothing_sent' | 'not_booking'
--     pending        waiting to be worked out or reversed
--     reversed       the full share was taken back
--     owed           the transfer could not cover it; the seller owes the rest
--     recovered      an owed amount was later taken back
--     nothing_sent   the seller was never paid, so nothing to take back
--     not_booking    the payment intent is not a booking
--   reversal_ids      Stripe reversal ids made (comma separated)
--   attempts          tries so far; next_attempt_at is when the next try is due
--   last_error        last failure message
--   owed_at / seller_notified_at / alerted_at / recovered_at   when each of those happened
--
-- event_payout_recoveries gets seller_notified_at so event hosts can be told the same way.

CREATE TABLE IF NOT EXISTS booking_refund_recoveries (
  id                   VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id            TEXT        NOT NULL UNIQUE,
  payment_intent_id    TEXT        NOT NULL,
  refund_cents         INTEGER     NOT NULL,
  refund_created_at    TIMESTAMPTZ,
  reference_type       TEXT        CHECK (reference_type IN ('appointment', 'shoot_booking')),
  reference_id         VARCHAR(36),
  recipient            TEXT,
  connected_account_id TEXT,
  amount_cents         INTEGER     NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  reversed_cents       INTEGER     NOT NULL DEFAULT 0,
  status               TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reversed', 'owed', 'recovered', 'nothing_sent', 'not_booking')),
  reversal_ids         TEXT,
  attempts             INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at      TIMESTAMPTZ,
  last_error           TEXT,
  owed_at              TIMESTAMPTZ,
  seller_notified_at   TIMESTAMPTZ,
  alerted_at           TIMESTAMPTZ,
  recovered_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_refund_recoveries_due ON booking_refund_recoveries (status, next_attempt_at) WHERE status IN ('pending', 'owed');
CREATE INDEX IF NOT EXISTS idx_booking_refund_recoveries_owed_account ON booking_refund_recoveries (connected_account_id) WHERE status = 'owed';
CREATE INDEX IF NOT EXISTS idx_booking_refund_recoveries_reference ON booking_refund_recoveries (reference_type, reference_id);

ALTER TABLE event_payout_recoveries ADD COLUMN IF NOT EXISTS seller_notified_at TIMESTAMPTZ;

-- Verify (read-only): expect the table with 0 rows and 5 indexes (pkey, refund_id unique, the 3 above), and the new column.
-- SELECT count(*) FROM booking_refund_recoveries;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'booking_refund_recoveries';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'event_payout_recoveries' AND column_name = 'seller_notified_at';
