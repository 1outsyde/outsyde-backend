-- Migration 051: photographer slot rule counts ACTIVE bookings only (Part B, abandoned checkouts)
-- Run manually in the Neon SQL editor BEFORE merging this PR. Never via drizzle-kit push.
-- Every statement is idempotent: safe to re-run. No rows are changed.
--
-- Before: constraint unique_photographer_slot UNIQUE (photographer_id, date, start_time) on
--         shoot_bookings, with no status filter. An expired, canceled or declined shoot blocked
--         that photographer's start time forever (a new booking failed with a 500).
-- After:  the same uniqueness, but only for bookings that are still live. Two active bookings
--         for the same photographer, date and start time are still impossible.
--
-- Order matters: create the new index first, then drop the old constraint, so there is never a
-- moment with no protection. No DO blocks (scripts/migrate.ts splits statements on ';').

CREATE UNIQUE INDEX IF NOT EXISTS uq_photographer_active_slot
  ON shoot_bookings (photographer_id, date, start_time)
  WHERE status NOT IN ('canceled', 'cancelled', 'expired', 'declined', 'refunded');

ALTER TABLE shoot_bookings DROP CONSTRAINT IF EXISTS unique_photographer_slot;

-- Verify (read-only). Expect one row, uq_photographer_active_slot with the WHERE clause above,
-- and no unique_photographer_slot:
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'shoot_bookings'
--  AND indexname IN ('uq_photographer_active_slot', 'unique_photographer_slot');
