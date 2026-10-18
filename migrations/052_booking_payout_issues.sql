-- Migration 052: booking payouts that still need to be sent (retry + alert)
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: one new table, no existing rows touched.
--
-- A booking's business / staff / photographer payout is a transfer from Outsyde's Stripe
-- balance. When Stripe refuses it (most often: not enough available balance), a row is written
-- here; an hourly job retries it, and Legend gets an email while anything is still unpaid.
--   recipient_key   'business' | 'staff' | 'photographer' (the base payout) or
--                   '<recipient>_rewards' (the part Outsyde adds when a points code made the
--                   customer's charge smaller than the payout)
--   status          'open' (still to pay) | 'paid' | 'dropped' (booking was cancelled or refunded
--                   before it could be paid, so it is not paid)

CREATE TABLE IF NOT EXISTS booking_payout_issues (
  id                    VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_type        TEXT        NOT NULL CHECK (reference_type IN ('appointment', 'shoot_booking')),
  reference_id          VARCHAR(36) NOT NULL,
  recipient_key         TEXT        NOT NULL,
  is_base               BOOLEAN     NOT NULL,
  connected_account_id  TEXT        NOT NULL,
  amount_cents          INTEGER     NOT NULL CHECK (amount_cents > 0),
  status                TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'dropped')),
  attempts              INTEGER     NOT NULL DEFAULT 0,
  last_error            TEXT,
  last_attempt_at       TIMESTAMPTZ,
  alerted_at            TIMESTAMPTZ,
  topup_id              TEXT,
  topup_requested_at    TIMESTAMPTZ,
  transfer_id           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_payout_issue
  ON booking_payout_issues (reference_type, reference_id, recipient_key);

CREATE INDEX IF NOT EXISTS idx_booking_payout_issues_open
  ON booking_payout_issues (created_at) WHERE status = 'open';

-- Verify (read-only): expect the table with 0 rows.
-- SELECT count(*) FROM booking_payout_issues;
