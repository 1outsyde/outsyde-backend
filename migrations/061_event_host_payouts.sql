-- Migration 061: event host payouts (Events & Ticketing, Phase 2, PR 5a).
--
-- Why: after an event ends, the money from paid tickets is sent to the host. This adds the tables the
-- payout job needs: one payout row per event, a per-user Stripe account for hosts who have no business
-- account, and a recovery row for a ticket refunded after its payout was already sent.
--
-- Decisions (Legend, 2026-10-19):
--   one payout per event (UNIQUE event_id), so the job can claim it and run twice safely
--   a payout is 'pending' until sent, 'held' when it cannot be sent yet, 'review' when a person must look,
--   'paid' when Stripe took the transfer. There is no 'sending' status: the claim UPDATE plays that role.
--   amount_cents is always gross_cents minus deducted_cents (enforced by a CHECK)
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: three new tables and one nullable column on tickets.

CREATE TABLE IF NOT EXISTS user_payout_accounts (
  user_id             VARCHAR(36) PRIMARY KEY REFERENCES users(id),
  stripe_account_id   TEXT NOT NULL UNIQUE,
  onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  last_event_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_payouts (
  id                   VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             VARCHAR(36) NOT NULL REFERENCES events(id),
  destination_type     TEXT,
  connected_account_id TEXT,
  gross_cents          INTEGER NOT NULL,
  deducted_cents       INTEGER NOT NULL DEFAULT 0,
  amount_cents         INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  hold_reason          TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TIMESTAMPTZ,
  last_error           TEXT,
  alerted_at           TIMESTAMPTZ,
  transfer_id          TEXT,
  paid_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_payouts_event_unique UNIQUE (event_id),
  CONSTRAINT event_payouts_destination_valid
    CHECK (destination_type IS NULL OR destination_type IN ('user', 'business', 'photographer')),
  CONSTRAINT event_payouts_gross_positive CHECK (gross_cents > 0),
  CONSTRAINT event_payouts_deducted_valid CHECK (deducted_cents >= 0),
  CONSTRAINT event_payouts_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT event_payouts_amount_matches CHECK (amount_cents = gross_cents - deducted_cents),
  CONSTRAINT event_payouts_status_valid CHECK (status IN ('pending', 'paid', 'held', 'review'))
);

CREATE INDEX IF NOT EXISTS idx_event_payouts_due
  ON event_payouts (next_attempt_at)
  WHERE status IN ('pending', 'held');

CREATE TABLE IF NOT EXISTS event_payout_recoveries (
  id                       VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id                VARCHAR(36) NOT NULL REFERENCES tickets(id),
  payout_id                VARCHAR(36) NOT NULL REFERENCES event_payouts(id),
  connected_account_id     TEXT NOT NULL,
  amount_cents             INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending',
  reversal_id              TEXT,
  recovered_from_payout_id VARCHAR(36) REFERENCES event_payouts(id),
  attempts                 INTEGER NOT NULL DEFAULT 0,
  next_attempt_at          TIMESTAMPTZ,
  last_error               TEXT,
  alerted_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_payout_recoveries_ticket_unique UNIQUE (ticket_id),
  CONSTRAINT event_payout_recoveries_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT event_payout_recoveries_status_valid CHECK (status IN ('pending', 'reversed', 'owed', 'recovered'))
);

CREATE INDEX IF NOT EXISTS idx_event_payout_recoveries_owed
  ON event_payout_recoveries (connected_account_id)
  WHERE status = 'owed';

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS payout_id VARCHAR(36);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tickets_payout_id_fkey' AND conrelid = 'tickets'::regclass
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_payout_id_fkey FOREIGN KEY (payout_id) REFERENCES event_payouts(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tickets_payout ON tickets (payout_id);

-- Verify (read-only): expect 3 tables and the tickets.payout_id column.
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('user_payout_accounts', 'event_payouts', 'event_payout_recoveries');
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'tickets' AND column_name = 'payout_id';
