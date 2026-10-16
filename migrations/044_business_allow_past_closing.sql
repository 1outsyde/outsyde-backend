-- Migration 044: businesses.allow_past_closing
-- Per-business toggle: when true, a business-level booking (no staff member) may END after
-- the day's last open window closes, as long as it STARTS during open hours and ends by 23:59.
-- Default false keeps today's behaviour for every business.
-- Run manually in the Neon SQL editor BEFORE merging. Safe to re-run.
-- No statement may contain a semicolon inside it: scripts/migrate.ts splits on semicolons.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS allow_past_closing boolean NOT NULL DEFAULT false;
