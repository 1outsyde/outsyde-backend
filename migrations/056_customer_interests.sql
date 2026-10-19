-- Migration 056: customer interests on the shared business list (2026-10-18)
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: two nullable columns, no default, no backfill.
--
--   users.interest_other      the customer's own words when they pick Other (max 500, cut in code)
--   users.interests_original  the interest answers exactly as first sent, kept whenever older
--                             words (app codes, goutsyde.com names) were mapped to shared codes

ALTER TABLE users ADD COLUMN IF NOT EXISTS interest_other text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests_original jsonb;
