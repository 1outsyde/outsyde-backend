-- 102: Quotes step 4b-2b, extras (Legend 2026-11-05, B1 to B4, E2 to E7). Additive only: two new tables and four
-- nullable or defaulted columns on quote_refunds (a table only the quote code reads).
-- Run in Neon BEFORE the code deploys. No statement contains a semicolon inside it.

-- One row per extra the vendor sends. Only the customer's Approve adds it to the booking.
CREATE TABLE IF NOT EXISTS quote_extras (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id varchar(36) NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  quote_id varchar(36) NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  business_id varchar(36) NOT NULL,
  customer_id varchar(36) NOT NULL,
  proposed_by varchar(36) NOT NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 200),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 100 AND 1000000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approving', 'approved', 'declined', 'withdrawn', 'lapsed', 'canceled')),
  approve_intent_id text,                  -- the PaymentIntent or SetupIntent an Approve is waiting on
  message_id varchar(36),
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quote_extras_appointment ON quote_extras (appointment_id);

-- One extras payment per booking: one hold for all approved extras (replaced at each approval), one charge at Job
-- complete, the vendor's share paid after the 6 hour window as its own transfer (group appointment_extras_<id>).
CREATE TABLE IF NOT EXISTS quote_extras_payments (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id varchar(36) NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  quote_id varchar(36) NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  business_id varchar(36) NOT NULL,
  client_id varchar(36) NOT NULL,
  approved_cents integer NOT NULL DEFAULT 0 CHECK (approved_cents >= 0),
  fee_cents integer NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  platform_fee_cents integer NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  vendor_net_cents integer NOT NULL DEFAULT 0 CHECK (vendor_net_cents >= 0),
  hold_cents integer NOT NULL DEFAULT 0 CHECK (hold_cents = approved_cents + fee_cents),
  status text NOT NULL DEFAULT 'none' CHECK (status IN ('none', 'scheduled', 'holding', 'held', 'hold_failed', 'capturing', 'captured', 'unpaid', 'releasing', 'released')),
  approve_claim_tag text,
  approve_claimed_at timestamptz,
  hold_at timestamptz,
  retry_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  claim_tag text,
  stripe_customer_id text,
  payment_method_id text,
  stripe_payment_intent_id text,
  release_pi text,                         -- a replaced hold still to let go
  stripe_charge_id text,
  held_cents integer,
  held_at timestamptz,
  captured_cents integer CHECK (captured_cents IS NULL OR captured_cents >= 0),
  captured_at timestamptz,
  released_at timestamptz,
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  failed_notice_at timestamptz,
  reminder_at timestamptz,
  payout_status text NOT NULL DEFAULT 'none' CHECK (payout_status IN ('none', 'held', 'paid', 'paused', 'canceled')),
  payout_claim_tag text,
  payout_claimed_at timestamptz,
  payout_attempts integer NOT NULL DEFAULT 0,
  payout_next_at timestamptz,
  payout_error text,
  payout_alerted_at timestamptz,
  payout_cents integer CHECK (payout_cents IS NULL OR payout_cents >= 0),
  payout_recipient text CHECK (payout_recipient IS NULL OR payout_recipient IN ('business', 'staff')),
  payout_transfer_id text,
  paid_out_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_extras_payments_pi ON quote_extras_payments (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quote_extras_payments_due ON quote_extras_payments (status, hold_at);

-- Refunds of a completed quote booking now come from the extras first (B6), then the balance, then the deposit.
ALTER TABLE quote_refunds ADD COLUMN IF NOT EXISTS extras_pi text;
ALTER TABLE quote_refunds ADD COLUMN IF NOT EXISTS extras_cents integer NOT NULL DEFAULT 0 CHECK (extras_cents >= 0);
ALTER TABLE quote_refunds ADD COLUMN IF NOT EXISTS extras_refund_id text;
ALTER TABLE quote_refunds ADD COLUMN IF NOT EXISTS extras_refunded_cents integer;
