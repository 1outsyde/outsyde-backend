-- p4-team step 7: asking a team member to stay longer. Decided by Legend 2026-10-29 (decision 12, canvas 55 to 57)
-- and 2026-10-30 (calls 41 to 48):
--   - The host only asks Admissions, Security, Entertainment, Media or Other (never Promoters or co-hosts), from the
--     event start until the person's current end, one open request per person at a time, 30 minutes to 6 hours.
--   - Extra pay: Fixed amount (up to $1,000), No extra pay, To be discussed, or for hourly members At their hourly
--     rate (never a Fixed amount on top of hourly pay for the same time).
--   - A request stays open until the later of their current end and 30 minutes after it was sent (Legend 11:35 PM).
--   - To be discussed: the host enters the amount until the payout is worked out; otherwise $0.
--
-- event_team_extensions: one row per request. `from_end_at` is their end when asked, `new_end_at` = from_end_at +
-- extra_minutes. Accepted rows add to their pay (teamPay.ts eventPay) and their end time on their screen. Nothing
-- else reads or changes event_team_schedules.
--
-- Safe to run twice. New table only. Rollback: DROP TABLE IF EXISTS event_team_extensions;

CREATE TABLE IF NOT EXISTS event_team_extensions (
  id                    VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              VARCHAR(36) NOT NULL REFERENCES events(id),
  member_user_id        VARCHAR(36) NOT NULL REFERENCES users(id),
  role                  TEXT        NOT NULL,
  requested_by_user_id  VARCHAR(36) NOT NULL REFERENCES users(id),
  extra_minutes         INTEGER     NOT NULL,
  from_end_at           TIMESTAMPTZ NOT NULL,
  new_end_at            TIMESTAMPTZ NOT NULL,
  pay_kind              TEXT        NOT NULL,
  fixed_cents           INTEGER,
  final_cents           INTEGER,
  status                TEXT        NOT NULL DEFAULT 'open',
  expires_at            TIMESTAMPTZ NOT NULL,
  answered_at           TIMESTAMPTZ,
  amount_set_at         TIMESTAMPTZ,
  host_notified_at      TIMESTAMPTZ,
  tbd_morning_reminded_at TIMESTAMPTZ,
  tbd_eve_reminded_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_team_extensions_role_valid CHECK (role IN ('door', 'security', 'entertainment', 'media', 'other')),
  CONSTRAINT event_team_extensions_minutes_valid CHECK (extra_minutes BETWEEN 30 AND 360),
  CONSTRAINT event_team_extensions_end_matches CHECK (new_end_at = from_end_at + make_interval(mins => extra_minutes)),
  CONSTRAINT event_team_extensions_pay_valid CHECK (pay_kind IN ('fixed', 'none', 'tbd', 'hourly')),
  CONSTRAINT event_team_extensions_fixed_matches CHECK ((pay_kind = 'fixed') = (fixed_cents IS NOT NULL)),
  CONSTRAINT event_team_extensions_fixed_range CHECK (fixed_cents IS NULL OR fixed_cents BETWEEN 1 AND 100000),
  CONSTRAINT event_team_extensions_final_only_tbd CHECK (final_cents IS NULL OR (pay_kind = 'tbd' AND status = 'accepted')),
  CONSTRAINT event_team_extensions_final_range CHECK (final_cents IS NULL OR final_cents BETWEEN 0 AND 100000),
  CONSTRAINT event_team_extensions_status_valid CHECK (status IN ('open', 'accepted', 'declined', 'expired')),
  CONSTRAINT event_team_extensions_answered CHECK ((status = 'open') = (answered_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_team_extensions_open ON event_team_extensions (event_id, member_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_event_team_extensions_event ON event_team_extensions (event_id, member_user_id, status);
CREATE INDEX IF NOT EXISTS idx_event_team_extensions_open_expiry ON event_team_extensions (expires_at) WHERE status = 'open';

-- Verify (read-only):
-- SELECT count(*) FROM information_schema.columns WHERE table_name = 'event_team_extensions';  -- 20
-- SELECT conname FROM pg_constraint WHERE conrelid = 'event_team_extensions'::regclass AND contype = 'c' ORDER BY conname;  -- 11
-- SELECT indexname FROM pg_indexes WHERE tablename = 'event_team_extensions';  -- 4 with the primary key
