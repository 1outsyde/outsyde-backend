-- Migration 094: refunds and disputes made in the Stripe dashboard (Events Phase 5, p5-stripe-sync, Legend's calls S1 to S8, 2026-11-01)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: two new tables and one new column with default 0. The event_payouts amount check
-- is replaced by the same check minus the new column (every existing row has 0 there, so every row still passes).
--
--   stripe_dashboard_refunds   one row per Stripe refund Outsyde did not make itself (server/stripe/stripeSync.ts). The row
--                              is written in the same statement that applies the refund to the sale, so it is applied once.
--   stripe_disputes            one row per Stripe dispute: sale it belongs to, amount, Stripe's fee, evidence due date,
--                              status and outcome; for event tickets the host share held from the payout (S4) and the
--                              transfer that released it when won; settled_at once a lost dispute's recovery is recorded.
--   event_payouts.dispute_held_cents   host share held back from the payout for open disputes (S4 option A).
--
-- Rollback (only together with reverting the PR; the backend reads these tables):
--   ALTER TABLE event_payouts DROP CONSTRAINT IF EXISTS event_payouts_amount_matches;
--   ALTER TABLE event_payouts ADD CONSTRAINT event_payouts_amount_matches CHECK (amount_cents = gross_cents - deducted_cents - team_cents);
--     (fails if any row has dispute_held_cents > 0: release or settle those first)
--   ALTER TABLE event_payouts DROP COLUMN IF EXISTS dispute_held_cents;
--   DROP TABLE IF EXISTS stripe_disputes; DROP TABLE IF EXISTS stripe_dashboard_refunds;

CREATE TABLE IF NOT EXISTS stripe_dashboard_refunds (
  id                  VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id           TEXT NOT NULL,
  charge_id           TEXT,
  payment_intent_id   TEXT,
  amount_cents        INTEGER NOT NULL,
  full_refund         BOOLEAN NOT NULL DEFAULT false,
  kind                TEXT NOT NULL,
  reference_id        VARCHAR(36),
  refund_created_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stripe_dashboard_refunds_refund UNIQUE (refund_id),
  CONSTRAINT stripe_dashboard_refunds_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT stripe_dashboard_refunds_kind_valid CHECK (kind IN ('appointment', 'shoot_booking', 'ticket_order', 'order', 'unknown'))
);
CREATE INDEX IF NOT EXISTS idx_stripe_dashboard_refunds_pi ON stripe_dashboard_refunds (payment_intent_id);

CREATE TABLE IF NOT EXISTS stripe_disputes (
  id                   VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id           TEXT NOT NULL,
  charge_id            TEXT,
  payment_intent_id    TEXT,
  kind                 TEXT NOT NULL,
  reference_id         VARCHAR(36),
  amount_cents         INTEGER NOT NULL,
  fee_cents            INTEGER NOT NULL DEFAULT 0,
  reason               TEXT,
  status               TEXT NOT NULL,
  outcome              TEXT,
  evidence_due_by      TIMESTAMPTZ,
  opened_at            TIMESTAMPTZ,
  closed_at            TIMESTAMPTZ,
  held_cents           INTEGER NOT NULL DEFAULT 0,
  held_payout_id       VARCHAR(36) REFERENCES event_payouts(id),
  release_transfer_id  TEXT,
  release_attempts     INTEGER NOT NULL DEFAULT 0,
  release_next_at      TIMESTAMPTZ,
  last_error           TEXT,
  settled_at           TIMESTAMPTZ,
  opened_alerted_at    TIMESTAMPTZ,
  closed_alerted_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stripe_disputes_dispute UNIQUE (dispute_id),
  CONSTRAINT stripe_disputes_kind_valid CHECK (kind IN ('appointment', 'shoot_booking', 'ticket_order', 'order', 'unknown')),
  CONSTRAINT stripe_disputes_outcome_valid CHECK (outcome IS NULL OR outcome IN ('won', 'lost')),
  CONSTRAINT stripe_disputes_amounts_valid CHECK (amount_cents >= 0 AND fee_cents >= 0 AND held_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_open_tickets ON stripe_disputes (reference_id) WHERE kind = 'ticket_order' AND held_payout_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_unsettled ON stripe_disputes (closed_at) WHERE outcome IS NOT NULL AND settled_at IS NULL;

ALTER TABLE event_payouts ADD COLUMN IF NOT EXISTS dispute_held_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_payouts DROP CONSTRAINT IF EXISTS event_payouts_dispute_held_valid;
ALTER TABLE event_payouts ADD CONSTRAINT event_payouts_dispute_held_valid CHECK (dispute_held_cents >= 0);
ALTER TABLE event_payouts DROP CONSTRAINT IF EXISTS event_payouts_amount_matches;
ALTER TABLE event_payouts ADD CONSTRAINT event_payouts_amount_matches CHECK (amount_cents = gross_cents - deducted_cents - team_cents - dispute_held_cents);
