-- p4-team step 5: host messages to the event team. Decided by Legend 2026-10-30 (decision 10, calls 27, 30 to 33):
--   - The host or a co-host sends to the whole team, all of one role, or one person.
--   - Personal messages only for now: each person gets it in their own Messages thread with the sender (a normal
--     `messages` row), plus one push and one Activity item. "Make it a group chat" is a later step (with the screens).
--   - Whole team = everyone who accepted (co-hosts too), never pending, declined, taken off, or blocked either way.
--   - From publishing until 3 days after the event; text only, up to 1,000 characters.
--
-- 1. event_team_messages: one row per send (who, to whom, the text, how many got it).
-- 2. event_team_message_recipients: one row per person who got it, with the Messages thread and message it became.
--    Their event screen lists "From the host" from here.
--
-- Safe to run twice. New tables only: today's code never reads or writes them.
--
-- Rollback (nothing else depends on these):
--   DROP TABLE IF EXISTS event_team_message_recipients;
--   DROP TABLE IF EXISTS event_team_messages;

CREATE TABLE IF NOT EXISTS event_team_messages (
  id                 VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           VARCHAR(36) NOT NULL REFERENCES events(id),
  sender_user_id     VARCHAR(36) NOT NULL REFERENCES users(id),
  audience           TEXT        NOT NULL,
  role               TEXT,
  recipient_user_id  VARCHAR(36) REFERENCES users(id),
  content            TEXT        NOT NULL,
  recipient_count    INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_team_messages_audience_valid CHECK (audience IN ('team', 'role', 'person')),
  CONSTRAINT event_team_messages_role_matches CHECK ((audience = 'role') = (role IS NOT NULL)),
  CONSTRAINT event_team_messages_person_matches CHECK ((audience = 'person') = (recipient_user_id IS NOT NULL)),
  CONSTRAINT event_team_messages_role_valid CHECK (role IS NULL OR role IN ('door', 'security', 'host', 'entertainment', 'media', 'cohost', 'other')),
  CONSTRAINT event_team_messages_content_len CHECK (char_length(content) BETWEEN 1 AND 1000),
  CONSTRAINT event_team_messages_count_valid CHECK (recipient_count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_event_team_messages_event ON event_team_messages (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_team_message_recipients (
  team_message_id   VARCHAR(36) NOT NULL REFERENCES event_team_messages(id),
  member_user_id    VARCHAR(36) NOT NULL REFERENCES users(id),
  conversation_id   VARCHAR(36) REFERENCES conversations(id),
  message_id        VARCHAR(36) REFERENCES messages(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_message_id, member_user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_team_message_recipients_member ON event_team_message_recipients (member_user_id, created_at DESC);

-- Verify (read-only):
-- SELECT count(*) FROM information_schema.columns WHERE table_name = 'event_team_messages';            -- 9
-- SELECT count(*) FROM information_schema.columns WHERE table_name = 'event_team_message_recipients';  -- 5
-- SELECT conname FROM pg_constraint WHERE conrelid = 'event_team_messages'::regclass ORDER BY conname;
-- SELECT indexname FROM pg_indexes WHERE tablename IN ('event_team_messages', 'event_team_message_recipients');
