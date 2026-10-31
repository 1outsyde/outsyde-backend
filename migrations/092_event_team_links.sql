-- p4-team step 9-0: invite someone who isn't on Outsyde yet (Legend 2026-10-31, calls 66 to 71 and 67b).
--   - The host (or a co-host) makes a one person link for a role, This event or All my events. For This event the
--     link can carry the pay the host set, shown on the link page and saved as theirs when they accept.
--   - Sent by email (67b): the email holds that person's own link. No account is ever matched by email, because
--     accounts don't verify their email. Phone = the host texts the link from their own phone (no text provider).
--   - The first signed in person who accepts takes the spot (a normal accepted team row), then the link stops
--     working. It ends when the event ends (This event) or 7 days after it was made (All my events). The host can
--     cancel it while it's open.
--
-- event_team_links: one row per link. Nothing reads it until the step 9-0 backend ships: team pay, payouts, reminders,
-- messages, stay longer, the scanner and team size read event_door_team / event_door_members only.
--
-- Safe to run twice. New table only. Rollback: DROP TABLE IF EXISTS event_team_links;

CREATE TABLE IF NOT EXISTS event_team_links (
  id                    VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  TEXT        NOT NULL,
  host_user_id          VARCHAR(36) NOT NULL REFERENCES users(id),
  event_id              VARCHAR(36) NOT NULL REFERENCES events(id),
  scope                 TEXT        NOT NULL,
  role                  TEXT        NOT NULL,
  role_label            TEXT,
  cohost_level          TEXT,
  pay_type              TEXT,
  fixed_cents           INTEGER,
  hourly_cents          INTEGER,
  commission_bps        INTEGER,
  sent_to_email         TEXT,
  email_sent_at         TIMESTAMPTZ,
  created_by_user_id    VARCHAR(36) NOT NULL REFERENCES users(id),
  status                TEXT        NOT NULL DEFAULT 'open',
  expires_at            TIMESTAMPTZ NOT NULL,
  accepted_at           TIMESTAMPTZ,
  accepted_by_user_id   VARCHAR(36) REFERENCES users(id),
  accepted_invite_id    VARCHAR(36),
  cancelled_at          TIMESTAMPTZ,
  cancelled_by_user_id  VARCHAR(36) REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_team_links_code_valid CHECK (code ~ '^[A-Z2-9]{12}$'),
  CONSTRAINT event_team_links_scope_valid CHECK (scope IN ('standing', 'event')),
  CONSTRAINT event_team_links_role_valid CHECK (role IN ('door', 'security', 'host', 'entertainment', 'media', 'cohost', 'other')),
  CONSTRAINT event_team_links_role_label_valid CHECK ((role = 'other') = (role_label IS NOT NULL) AND (role_label IS NULL OR char_length(role_label) BETWEEN 1 AND 40)),
  CONSTRAINT event_team_links_cohost_level_valid CHECK (cohost_level IS NULL OR (role = 'cohost' AND cohost_level IN ('team', 'edit'))),
  CONSTRAINT event_team_links_pay_type_valid CHECK (pay_type IS NULL OR pay_type IN ('none', 'fixed', 'hourly')),
  CONSTRAINT event_team_links_pay_event_only CHECK (pay_type IS NULL OR (scope = 'event' AND role <> 'cohost')),
  CONSTRAINT event_team_links_fixed_matches CHECK ((pay_type IS NOT DISTINCT FROM 'fixed') = (fixed_cents IS NOT NULL)),
  CONSTRAINT event_team_links_hourly_matches CHECK ((pay_type IS NOT DISTINCT FROM 'hourly') = (hourly_cents IS NOT NULL)),
  CONSTRAINT event_team_links_fixed_range CHECK (fixed_cents IS NULL OR fixed_cents BETWEEN 1 AND 1000000),
  CONSTRAINT event_team_links_hourly_range CHECK (hourly_cents IS NULL OR hourly_cents BETWEEN 1 AND 100000),
  CONSTRAINT event_team_links_commission_valid CHECK (commission_bps IS NULL OR (pay_type IS NOT NULL AND role IN ('host', 'entertainment') AND commission_bps BETWEEN 100 AND 5000)),
  CONSTRAINT event_team_links_email_valid CHECK (sent_to_email IS NULL OR (char_length(sent_to_email) BETWEEN 3 AND 254 AND sent_to_email = lower(sent_to_email))),
  CONSTRAINT event_team_links_status_valid CHECK (status IN ('open', 'accepted', 'cancelled')),
  CONSTRAINT event_team_links_accepted_matches CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)),
  CONSTRAINT event_team_links_cancelled_matches CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_team_links_code ON event_team_links (code);
CREATE INDEX IF NOT EXISTS idx_event_team_links_event_open ON event_team_links (event_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_event_team_links_host_open ON event_team_links (host_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_event_team_links_email_day ON event_team_links (host_user_id, email_sent_at) WHERE email_sent_at IS NOT NULL;

-- Verify (read-only):
-- SELECT count(*) FROM information_schema.columns WHERE table_name = 'event_team_links';  -- 24
-- SELECT count(*) FROM pg_constraint WHERE conrelid = 'event_team_links'::regclass AND contype = 'c';  -- 16
-- SELECT count(*) FROM pg_indexes WHERE tablename = 'event_team_links';  -- 5 with the primary key
-- SELECT count(*) FROM event_team_links;  -- 0
