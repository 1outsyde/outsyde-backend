-- 103: Quotes step 5a, note emails (Legend 2026-11-05, step 5 call 3). Additive only: one new table.
-- One row per quote chat and person: when they were last emailed about unread notes, and the newest note that email
-- covered. At most one email every 10 minutes per chat and person. Run in Neon BEFORE the code deploys.
-- No statement contains a semicolon inside it.

CREATE TABLE IF NOT EXISTS quote_chat_emails (
  conversation_id varchar(36) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  recipient_id varchar(36) NOT NULL,
  last_sent_at timestamptz,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, recipient_id)
);
