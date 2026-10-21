-- Migration 064: bank_payouts (PR 5b daily bank payout)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: one new table, nothing existing changes.
--
-- One Stripe payout per New York day, from the platform balance to Outsyde's bank. This table is the
-- one-row-per-day record and the claim: payout_date is UNIQUE, so only one run can claim a given day.
-- A day where Stripe is not on manual payouts writes no row at all.
--
--   status            'pending' -> 'sent' -> 'paid' | 'failed', or 'review' | 'skipped'
--     pending   claimed, being sent
--     sent      Stripe accepted the create
--     paid      Stripe reports it arrived
--     failed    failed or canceled at Stripe
--     review    needs a look after 5 failed tries
--     skipped   no payout that day, skip_reason says why
--   skip_reason       why a skipped day sent nothing
--   available_cents   Stripe available balance when the day was worked out
--   held_cents        amount kept back for money still owed out; held_breakdown has the parts (jsonb)
--   buffer_cents      cushion left in the balance (default 10000 = $100.00)
--   amount_cents      the amount actually paid out
--   stripe_payout_id  Stripe payout id once created; stripe_status is Stripe's last reported status
--   attempts          tries so far; next_attempt_at is when the next retry is due
--   last_error        last failure message
--   alerted_at        when the team was alerted about this day
--   sent_at / paid_at / failed_at   when each of those happened

CREATE TABLE IF NOT EXISTS bank_payouts (
  id               VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_date      DATE        NOT NULL UNIQUE,
  status           TEXT        NOT NULL CHECK (status IN ('pending', 'sent', 'paid', 'failed', 'review', 'skipped')),
  skip_reason      TEXT,
  available_cents  INTEGER,
  held_cents       INTEGER,
  held_breakdown   JSONB,
  buffer_cents     INTEGER     NOT NULL DEFAULT 10000,
  amount_cents     INTEGER,
  stripe_payout_id TEXT,
  stripe_status    TEXT,
  attempts         INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  last_error       TEXT,
  alerted_at       TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  failed_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_payouts_open ON bank_payouts (status) WHERE status IN ('pending', 'sent');

-- Verify (read-only): expect the table with 0 rows and the index.
-- SELECT count(*) FROM bank_payouts;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'bank_payouts';
