-- 105: record that the customer agreed before paying (booking redesign step 3, Legend 2026-11-06).
-- Saved on the booking when the app sends `agreement` to
-- POST /api/booking/:holdId/create-payment-intent: when they agreed, which
-- Outsyde Terms version ("2026-11"), and a copy of the vendor's own terms at
-- that moment (null when the vendor has none). The cancellation policy is
-- already copied on appointments (cancellation_policy_* columns).
-- Nullable: old app builds and vendor sites don't send it. Safe to run twice.
-- Run in Neon BEFORE the code is deployed (full-row selects need the columns).

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS customer_agreed_at timestamp,
  ADD COLUMN IF NOT EXISTS customer_agreed_terms_version text,
  ADD COLUMN IF NOT EXISTS customer_agreed_vendor_terms text;

ALTER TABLE shoot_bookings
  ADD COLUMN IF NOT EXISTS customer_agreed_at timestamp,
  ADD COLUMN IF NOT EXISTS customer_agreed_terms_version text,
  ADD COLUMN IF NOT EXISTS customer_agreed_vendor_terms text;
