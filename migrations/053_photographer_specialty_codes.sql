-- Migration 053: photographer specialties on the shared list (approved by Legend 2026-10-18)
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: two new columns, no existing rows touched.
--
--   specialty_codes  codes from shared/photographerTaxonomy.ts (e.g. "photo.weddings"); used for
--                    future customer matching. Codes never change. photographers.specialties keeps
--                    the readable names and is rewritten from these codes when they are saved.
--   specialty_other  the photographer's own words when "Other" is picked (max 500, checked in code)

ALTER TABLE photographers ADD COLUMN IF NOT EXISTS specialty_codes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS specialty_other text;
