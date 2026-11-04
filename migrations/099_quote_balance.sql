-- 099: Quotes step 4a, balance hold and Job complete (Legend 2026-11-04, final).
-- Additive only: one new table. No column is added to appointments or quotes, so no full row read changes.
-- Run in Neon BEFORE the code deploys (the new jobs and routes read this table).

-- One row per paid service quote booking. Holds the job's completion and, for deposit quotes, the balance:
-- balance + its service fee held (manual capture, off session, saved card) 24 h before the start, captured at
-- Job complete. A quote paid in full has a row too (balance 0, status 'none') so it auto completes like the rest.
CREATE TABLE IF NOT EXISTS quote_jobs (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id varchar(36) NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  quote_id varchar(36) NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  business_id varchar(36) NOT NULL,
  client_id varchar(36) NOT NULL,
  starts_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  auto_complete_at timestamptz NOT NULL,
  completed_at timestamptz,
  completed_by text,                       -- user id, or 'system' for the automatic run
  completed_via text CHECK (completed_via IS NULL OR completed_via IN ('owner', 'staff', 'auto')),

  -- Money (fees.ts quoteBalanceSplit): hold = balance + service fee; the vendor gets balance less 2%.
  balance_cents integer NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  service_fee_cents integer NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
  platform_fee_cents integer NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  vendor_net_cents integer NOT NULL DEFAULT 0 CHECK (vendor_net_cents >= 0),
  hold_cents integer NOT NULL DEFAULT 0 CHECK (hold_cents = balance_cents + service_fee_cents),

  balance_status text NOT NULL DEFAULT 'none' CHECK (balance_status IN
    ('none', 'scheduled', 'holding', 'held', 'hold_failed', 'capturing', 'captured', 'releasing', 'released')),
  hold_at timestamptz,
  retry_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  claim_tag text,
  stripe_customer_id text,
  payment_method_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  held_at timestamptz,
  captured_cents integer CHECK (captured_cents IS NULL OR (captured_cents >= 0 AND captured_cents <= hold_cents)),
  captured_at timestamptz,
  released_at timestamptz,
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  stripe_refund_id text,
  held_notice_at timestamptz,              -- "balance held" card posted once
  failed_notice_at timestamptz,            -- "update your card" card posted once
  -- The vendor's share of the captured balance: held by Outsyde in 4a, paid in 4b after Confirm or the 6 h window.
  payout_status text NOT NULL DEFAULT 'none' CHECK (payout_status IN ('none', 'held', 'paid', 'paused', 'canceled')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_jobs_balance_none CHECK ((balance_cents = 0) = (balance_status = 'none'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_jobs_balance_pi ON quote_jobs (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quote_jobs_hold_due ON quote_jobs (balance_status, hold_at);
CREATE INDEX IF NOT EXISTS idx_quote_jobs_auto_complete ON quote_jobs (auto_complete_at) WHERE completed_at IS NULL;

-- Refunds of a quote booking after Job complete reach both payments (balance first, then the deposit). The split is
-- planned once and saved here, so a retry after a failed part finishes the same plan and never refunds more.
CREATE TABLE IF NOT EXISTS quote_refunds (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  op_key text NOT NULL UNIQUE,
  appointment_id varchar(36) NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  balance_pi text,
  deposit_pi text,
  balance_cents integer NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  deposit_cents integer NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  balance_refund_id text,
  deposit_refund_id text,
  balance_refunded_cents integer,
  deposit_refunded_cents integer,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quote_refunds_open ON quote_refunds (appointment_id) WHERE done_at IS NULL;
