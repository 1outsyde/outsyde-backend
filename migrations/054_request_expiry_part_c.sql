-- Migration 054: manual-accept request expiry (Part C, approved by Legend 2026-10-18)
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: four nullable columns, no existing rows touched.
--
--   appointments.provider_reminder_sent_at    when the "request expiring" reminder went to the business (sent once)
--   shoot_bookings.provider_reminder_sent_at  same, for the photographer
--   businesses.time_zone                      IANA zone from the owner's phone or browser; null = America/New_York
--   photographers.time_zone                   same, for photographers

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS provider_reminder_sent_at timestamptz;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS provider_reminder_sent_at timestamptz;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS time_zone text;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS time_zone text;
