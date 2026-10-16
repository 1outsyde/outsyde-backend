-- Migration 043: email history + admin broadcasts
-- email_sends: one row per send started from the admin Emails page (a broadcast, a broadcast
--   test, or a batch of account setup emails), or by the hourly setup job.
-- email_log: one row per email to one person. Powers History "by send" and "by person".
--   Stores no email address, name or rendered subject (account deletion blanks the users row
--   instead of deleting it, so nothing personal may live here). The subject of a broadcast
--   lives once on email_sends.
-- broadcast_optouts: people who unsubscribed from announcements. Separate from
--   account_setup_optouts. Booking, receipt and setup emails are unaffected.
-- Run manually in the Neon SQL editor BEFORE merging. Safe to re-run.
-- No statement may contain a semicolon inside it: scripts/migrate.ts splits on semicolons.

CREATE TABLE IF NOT EXISTS email_sends (
  id               varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL,
  created_by       varchar REFERENCES users(id) ON DELETE SET NULL,
  audience         text,
  subject          text,
  html             text,
  status           text NOT NULL DEFAULT 'sending',
  recipient_count  integer NOT NULL DEFAULT 0,
  sent_count       integer NOT NULL DEFAULT 0,
  failed_count     integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);

CREATE INDEX IF NOT EXISTS email_sends_created_idx ON email_sends (created_at DESC);

CREATE TABLE IF NOT EXISTS email_log (
  id          varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id     varchar(36) REFERENCES email_sends(id) ON DELETE CASCADE,
  user_id     varchar REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  label       text,
  status      text NOT NULL DEFAULT 'pending',
  error       text,
  resend_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS email_log_send_user_uq
  ON email_log (send_id, user_id) WHERE send_id IS NOT NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_log_user_created_idx ON email_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS email_log_created_idx ON email_log (created_at DESC);

CREATE TABLE IF NOT EXISTS broadcast_optouts (
  user_id     varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
