-- Migration 070: customers choose whether their city is public (city search + location privacy)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: one new column with a default. No existing column changes, no rows rewritten
-- beyond the default fill.
--
--   users.location_public   false (default) = the person's city/state never leaves the backend for anyone else:
--                           not in /api/search results, not in city search, not on GET /api/users/:id.
--                           true = their city shows on their profile and they can be found by city search.
--                           Every existing account starts hidden (Legend, 2026-10-23: privacy first).
--
-- Rollback (old code never reads it; dropping it makes the new code fail to select users until reverted):
--   ALTER TABLE users DROP COLUMN IF EXISTS location_public;

ALTER TABLE users ADD COLUMN IF NOT EXISTS location_public BOOLEAN NOT NULL DEFAULT false;
