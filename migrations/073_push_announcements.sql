-- Migration 073: admin push announcements (2026-10-24).
--
-- Legend can write a push on goutsyde.com/admin/emails?tab=push and send it to picked people, vendors,
-- photographers, consumers or everyone, with a chosen app screen to open on tap.
--
-- push_sends: one row per send (kind 'announcement' or 'test'). Only one announcement may be 'sending' at a time
--   (push_sends_one_active_uq). client_key makes a retried POST return the same send.
-- push_log: one row per recipient account per send. Holds no push token and no message text, only token_hash
--   (sha256 hex of the token at send time) so a dead token found later in the Expo receipt is cleared only when
--   the account still has that same token.
--   pending -> sending -> sent | failed | skipped, or unknown when the server restarted mid send.
-- push_news_optouts: people who turned off "Outsyde news and offers". Booking and message pushes ignore it.
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: new tables, nothing on users.

CREATE TABLE IF NOT EXISTS push_sends (
  id               varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL,
  created_by       varchar REFERENCES users(id) ON DELETE SET NULL,
  audience         text NOT NULL,
  title            text NOT NULL,
  body             text NOT NULL,
  screen           text,
  url              text,
  client_key       text,
  status           text NOT NULL DEFAULT 'sending',
  recipient_count  integer NOT NULL DEFAULT 0,
  sent_count       integer NOT NULL DEFAULT 0,
  failed_count     integer NOT NULL DEFAULT 0,
  receipts_checked_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX IF NOT EXISTS push_sends_created_idx ON push_sends (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS push_sends_client_key_uq ON push_sends (client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS push_sends_one_active_uq ON push_sends ((true)) WHERE status = 'sending' AND kind = 'announcement';

CREATE TABLE IF NOT EXISTS push_log (
  id          varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id     varchar(36) NOT NULL REFERENCES push_sends(id) ON DELETE CASCADE,
  user_id     varchar REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending',
  token_hash  text,
  ticket_id   text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS push_log_send_user_uq ON push_log (send_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS push_log_user_created_idx ON push_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS push_log_ticket_idx ON push_log (ticket_id) WHERE ticket_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS push_news_optouts (
  user_id     varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Added while the tables were still empty (same build, before merge):
ALTER TABLE push_log ADD COLUMN IF NOT EXISTS token_hash text;
