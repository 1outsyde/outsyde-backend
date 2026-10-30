-- Migration 084: co-host level (p4-team step 2b, 2026-10-29).
--
-- The host picks what each co-host can do (Legend, 2026-10-29):
--   team   sees everything for the event (sales summary with earnings and deductions, orders, guest list, team),
--          scans, undoes a check in, invites and removes team members for that event, sets their times
--   edit   all of team, plus edits event details (not the refund policy) and ticket types
-- Never a co-host: publish, cancel, refunds, payouts, the standing team, other co-hosts.
-- cohost_level is only for role 'cohost'. NULL on a co-host row reads as 'team' (rows made by step 2 code).
--
-- Run in Neon by Claude BEFORE the step 2b PR merges (new code reads cohost_level on every team route).
-- Old code never reads or writes it. Idempotent. Additive: no row changes (0 co-host rows on 2026-10-29).
-- Never via drizzle-kit push.
--
-- Rollback (only while no new code is live):
--   ALTER TABLE event_door_team    DROP CONSTRAINT IF EXISTS event_door_team_cohost_level_check,    DROP COLUMN IF EXISTS cohost_level;
--   ALTER TABLE event_door_members DROP CONSTRAINT IF EXISTS event_door_members_cohost_level_check, DROP COLUMN IF EXISTS cohost_level;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_door_team', 'event_door_members'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS cohost_level TEXT', t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(t) AND conname = t || '_cohost_level_check') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (cohost_level IS NULL OR (role = %L AND cohost_level IN (%L, %L)))',
        t, t || '_cohost_level_check', 'cohost', 'team', 'edit');
    END IF;
  END LOOP;
END $$;
