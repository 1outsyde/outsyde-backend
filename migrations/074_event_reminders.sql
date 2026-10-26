-- Migration 074: event reminder pushes (2026-10-26).
--
-- Guests get a push the day before (24 hours before the start) and 2 hours before; the host gets one the day
-- before. server/events/eventReminders.ts claims each reminder with UPDATE ... WHERE <column> IS NULL RETURNING,
-- so two job runs at once send each person one push per kind.
--   tickets.reminder_day_before_at  stamped when the holder's day before push is claimed
--   tickets.reminder_soon_at        stamped when the holder's 2 hour push is claimed
--   events.host_reminder_at         stamped when the host's day before push is claimed
-- No client reads these columns (every event and ticket response maps fields explicitly).
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: three nullable columns, no defaults, no backfill.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reminder_day_before_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reminder_soon_at       TIMESTAMPTZ;
ALTER TABLE events  ADD COLUMN IF NOT EXISTS host_reminder_at       TIMESTAMPTZ;
