-- Migration 042: account setup reminders
-- account_setup_reminders: one row per reminder sent (email and/or push), so the hourly job never
--   double-sends and knows which reminder (1-4) comes next.
-- account_setup_optouts: people who clicked "Stop these reminders".
-- Both cascade with the user, so account deletion needs no change.
-- Run manually in the Neon SQL editor BEFORE merging. Safe to re-run.
-- No statement may contain a semicolon inside it: scripts/migrate.ts splits on semicolons.

CREATE TABLE IF NOT EXISTS account_setup_reminders (
  id               varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template         text NOT NULL,
  reminder_number  integer NOT NULL,
  channels         text[] NOT NULL DEFAULT '{}',
  steps            text[] NOT NULL DEFAULT '{}',
  sent_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_setup_reminders_user_num_uq
  ON account_setup_reminders (user_id, reminder_number);

CREATE INDEX IF NOT EXISTS account_setup_reminders_user_sent_idx
  ON account_setup_reminders (user_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS account_setup_optouts (
  user_id     varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
