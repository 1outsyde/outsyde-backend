-- p4-team step 6: reminders for everyone at the event. Decided by Legend 2026-10-29 (decision 11, canvas screen 58)
-- and 2026-10-30 (calls 34 to 40): 7 days before, the day before, 2 hours before, and "Doors just opened" at the
-- start, for ticket holders, the host and co-hosts, and every team role (their own time: shift, call time, load in).
--
-- 1. tickets.reminder_week_at, reminder_start_at: the ticket holder's 7 day and doors open pushes (074 has the
--    day before and 2 hour ones).
-- 2. events.host_reminder_week_at, host_reminder_soon_at, host_reminder_start_at: the host's (074 has the day before).
-- 3. event_team_reminders: one row per team member per kind once it is claimed. Cleared when the event start moves
--    or the host changes that person's times, so the next ones follow the new time.
--
-- Safe to run twice. Additive only: nullable columns and a new table. Old code never reads them.
--
-- Rollback (nothing else depends on these):
--   DROP TABLE IF EXISTS event_team_reminders;
--   ALTER TABLE tickets DROP COLUMN IF EXISTS reminder_week_at, DROP COLUMN IF EXISTS reminder_start_at;
--   ALTER TABLE events DROP COLUMN IF EXISTS host_reminder_week_at, DROP COLUMN IF EXISTS host_reminder_soon_at,
--     DROP COLUMN IF EXISTS host_reminder_start_at;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reminder_week_at  TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reminder_start_at TIMESTAMPTZ;
ALTER TABLE events  ADD COLUMN IF NOT EXISTS host_reminder_week_at  TIMESTAMPTZ;
ALTER TABLE events  ADD COLUMN IF NOT EXISTS host_reminder_soon_at  TIMESTAMPTZ;
ALTER TABLE events  ADD COLUMN IF NOT EXISTS host_reminder_start_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS event_team_reminders (
  event_id        VARCHAR(36) NOT NULL REFERENCES events(id),
  member_user_id  VARCHAR(36) NOT NULL REFERENCES users(id),
  kind            TEXT        NOT NULL,
  role            TEXT        NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, member_user_id, kind),
  CONSTRAINT event_team_reminders_kind_valid CHECK (kind IN ('week', 'day_before', 'soon', 'start')),
  CONSTRAINT event_team_reminders_role_valid CHECK (role IN ('door', 'security', 'host', 'entertainment', 'media', 'cohost', 'other'))
);

-- Verify (read-only):
-- SELECT table_name, column_name FROM information_schema.columns WHERE (table_name = 'tickets' AND column_name IN ('reminder_week_at', 'reminder_start_at'))
--   OR (table_name = 'events' AND column_name LIKE 'host_reminder_%') ORDER BY 1, 2;   -- 2 + 4
-- SELECT count(*) FROM information_schema.columns WHERE table_name = 'event_team_reminders';  -- 5
