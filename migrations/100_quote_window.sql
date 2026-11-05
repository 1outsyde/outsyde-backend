-- 100: Quotes step 4b-1, the 6 hour Confirm or Report window, review outcomes, the vendor's balance payout and
-- points (Legend 2026-11-05, calls B5 to B14). Additive only: new nullable columns on quote_jobs (read only by the
-- quote code) and one new table. Nothing on appointments, quotes or refund_requests changes.
-- No statement contains a semicolon inside it (scripts/migrate.ts splits on them).
-- Run in Neon BEFORE the code deploys (the quote job and the new routes read these columns).

ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS window_ends_at timestamptz;          -- Job complete + 6 h
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;            -- the customer tapped Confirm
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS reported_at timestamptz;             -- the customer reported a problem
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS complete_notice_at timestamptz;      -- "job complete, confirm or report" card posted once
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS confirmed_notice_at timestamptz;     -- "customer confirmed" card to the vendor once
-- The vendor's balance share, paid as its own transfer (group appointment_balance_<appointment id>).
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS payout_claim_tag text;
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS payout_claimed_at timestamptz;
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS payout_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS payout_next_at timestamptz;
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS payout_error text;
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS payout_alerted_at timestamptz;
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS payout_cents integer CHECK (payout_cents IS NULL OR payout_cents >= 0);
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS payout_recipient text CHECK (payout_recipient IS NULL OR payout_recipient IN ('business', 'staff'));
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS payout_transfer_id text;
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS paid_out_at timestamptz;
-- Points follow the money: settled once the booking's money is final, settled again after any later refund.
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS points_settled_at timestamptz;
ALTER TABLE quote_jobs ADD COLUMN IF NOT EXISTS points_refund_seen_cents integer;

CREATE INDEX IF NOT EXISTS idx_quote_jobs_window ON quote_jobs (window_ends_at) WHERE payout_status = 'held';
CREATE INDEX IF NOT EXISTS idx_quote_jobs_points_open ON quote_jobs (appointment_id) WHERE points_settled_at IS NULL;

-- A customer's report on a completed quote booking. One per booking. Reviewed by Outsyde on the admin Refunds page
-- through its refund_requests row (target appointment); the decision is final (B13).
CREATE TABLE IF NOT EXISTS quote_reports (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id varchar(36) NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  quote_id varchar(36) NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  refund_request_id varchar(36) NOT NULL UNIQUE REFERENCES refund_requests(id) ON DELETE CASCADE,
  customer_id varchar(36) NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000),
  photos jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(photos) = 'array' AND jsonb_array_length(photos) <= 5),
  held_cents integer NOT NULL DEFAULT 0 CHECK (held_cents >= 0),         -- refundable money when reported
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'deciding', 'decided')),
  decide_tag text,
  -- The decision being carried out (saved before any refund): a retry after a crash or a failed refund finishes
  -- exactly this one and records what was refunded (review I2).
  pending_outcome text CHECK (pending_outcome IS NULL OR pending_outcome IN ('pay_full', 'partial_refund', 'full_refund')),
  pending_refund_cents integer CHECK (pending_refund_cents IS NULL OR pending_refund_cents >= 0),
  outcome text CHECK (outcome IS NULL OR outcome IN ('pay_full', 'partial_refund', 'full_refund')),
  refund_cents integer CHECK (refund_cents IS NULL OR refund_cents >= 0),
  decided_by varchar(36),
  decided_at timestamptz,
  admin_notes text,
  vendor_notice_at timestamptz,
  reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_reports_decided CHECK ((status = 'decided') = (outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_quote_reports_open ON quote_reports (created_at) WHERE status <> 'decided';

-- Jobs marked complete under 4a (before this ran) get their window from their Job complete time (review I3).
-- Neon had none on 2026-11-05; this keeps any made before the deploy from staying held forever.
UPDATE quote_jobs SET window_ends_at = completed_at + interval '6 hours' WHERE completed_at IS NOT NULL AND window_ends_at IS NULL;
