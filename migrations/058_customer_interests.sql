-- Migration 058 (opened as 056, renumbered because 056 is events): customer interests on the shared business list (2026-10-18)
-- ALREADY RUN in Neon 2026-10-18 by Claude (Legend: "ok 056"), verified by SELECT. Re-running is a no-op.
-- Idempotent: safe to re-run. Additive only: two nullable columns, no default, no backfill.
--
--   users.interest_other      the customer's own words when they pick Other (max 500, cut in code)
--   users.interests_original  the interest answers exactly as first sent, kept whenever older
--                             words (app codes, goutsyde.com names) were mapped to shared codes

ALTER TABLE users ADD COLUMN IF NOT EXISTS interest_other text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests_original jsonb;
