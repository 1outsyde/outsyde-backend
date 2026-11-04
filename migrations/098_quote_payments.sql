-- 098: Quotes step 3, paying a quote (Legend 2026-11-04, all 12 recommended) + R39.
-- Additive only. Run in Neon BEFORE the code deploys (full row selects on appointments, booking_holds,
-- provider_blocks and quotes need the new columns).

-- A paid quote becomes a normal appointment. The booking remembers its quote.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS quote_id varchar(36) REFERENCES quotes(id) ON DELETE SET NULL;
-- The quote version this booking pays for (a resumed payment always uses it, never the quote's current version).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS quote_version integer;
-- At most one live payment or booking per quote. An abandoned (expired) or canceled attempt frees it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_quote_live ON appointments (quote_id)
  WHERE quote_id IS NOT NULL AND status IN ('pending_payment', 'pending_provider', 'confirmed', 'completed', 'no_show');

-- The quote remembers its booking. paying_until locks edits, withdraw, decline and expiry while a payment runs.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS appointment_id varchar(36) REFERENCES appointments(id) ON DELETE SET NULL;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS paying_until timestamptz;
-- Set once when the "paid" card is posted, so two confirmations at the same moment post one card.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS paid_notice_at timestamptz;

-- The time hold taken for a quote payment (no service hold: request only services can't be held).
ALTER TABLE booking_holds ADD COLUMN IF NOT EXISTS quote_id varchar(36) REFERENCES quotes(id) ON DELETE SET NULL;

-- Extra days of a multi day quote job are time off blocks tied to the booking, removed if it ends.
ALTER TABLE provider_blocks ADD COLUMN IF NOT EXISTS appointment_id varchar(36) REFERENCES appointments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_provider_blocks_appointment ON provider_blocks (appointment_id) WHERE appointment_id IS NOT NULL;

-- R39: one cancellation fee charge per booking, claimed before every try and looked up at Stripe first.
CREATE TABLE IF NOT EXISTS cancellation_fee_charges (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_type text NOT NULL CHECK (reference_type IN ('appointment', 'shoot_booking')),
  reference_id varchar(36) NOT NULL,
  customer_id text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'charging', 'charged', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  claim_tag text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_type, reference_id)
);
