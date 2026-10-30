-- p4-team step 4a: Event team pay (what the host sets). No money moves in 4a; 4b pays it.
--
-- One row per event, person and role. Decided by Legend 2026-10-29 / 2026-10-30:
--   - pay is the host's choice for every role: no base pay, fixed, or hourly (rate x the shift the host set,
--     exact hours: 4.5 h x $50 = $225), plus commission for Promoters (role 'host') and Entertainment (DJs,
--     performers, MCs) on ticket price sold through their own link
--   - limits: fixed up to $10,000 per role, hourly up to $1,000 an hour, commission 1% to 50%
--   - only the host sets pay; it can change until the event ends
-- Standing team members get their pay per event here too (event_id is always set).
--
-- Safe to run twice. New table only: today's code never reads or writes it.

CREATE TABLE IF NOT EXISTS event_team_pay (
  id                  VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            VARCHAR(36) NOT NULL REFERENCES events(id),
  member_user_id      VARCHAR(36) NOT NULL REFERENCES users(id),
  role                TEXT        NOT NULL CHECK (role IN ('door', 'security', 'host', 'entertainment', 'media', 'cohost', 'other')),
  pay_type            TEXT        NOT NULL CHECK (pay_type IN ('none', 'fixed', 'hourly')),
  fixed_cents         INTEGER,
  hourly_cents        INTEGER,
  commission_bps      INTEGER,
  updated_by_user_id  VARCHAR(36) NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_team_pay_fixed_matches  CHECK ((pay_type = 'fixed')  = (fixed_cents IS NOT NULL)),
  CONSTRAINT event_team_pay_hourly_matches CHECK ((pay_type = 'hourly') = (hourly_cents IS NOT NULL)),
  CONSTRAINT event_team_pay_fixed_range    CHECK (fixed_cents IS NULL OR fixed_cents BETWEEN 1 AND 1000000),
  CONSTRAINT event_team_pay_hourly_range   CHECK (hourly_cents IS NULL OR hourly_cents BETWEEN 1 AND 100000),
  CONSTRAINT event_team_pay_commission_range CHECK (commission_bps IS NULL OR commission_bps BETWEEN 100 AND 5000),
  CONSTRAINT event_team_pay_commission_roles CHECK (commission_bps IS NULL OR role IN ('host', 'entertainment'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_team_pay ON event_team_pay (event_id, member_user_id, role);

-- Verify (read-only): expect 11 columns, 6 checks besides the role and pay_type ones, the unique index, 0 rows.
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'event_team_pay' ORDER BY ordinal_position;
-- SELECT conname FROM pg_constraint WHERE conrelid = 'event_team_pay'::regclass ORDER BY conname;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'event_team_pay';
