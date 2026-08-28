-- Migration 028: create waitlist_signups table
-- Captures email signups from vendor coming-soon pages (XO Beauty & Lashes,
-- Braids With Love, etc.). These are NOT users — no password, no profile.
-- The unique constraint prevents duplicate signups for the same vendor.

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  vendor      TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (email, vendor)
);
