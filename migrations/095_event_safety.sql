-- Migration 095: event safety (Events Phase 5, p5-safety, Legend's calls T1 to T11, 2026-11-01)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: one new column with no default rewrite, one new partial unique index, one new table.
--
--   moderation_queue.details          the reporter's note (event reports: "something else" note, up to 500 characters).
--                                     Full-row selects of moderation_queue (phase3Routes.ts) need it to exist first.
--   uq_moderation_reporter_target     one report per person per event and per post (server/events/eventModeration.ts
--                                     inserts with ON CONFLICT on it). Partial: user reports keep the old flag behavior.
--   event_host_trust                  personal hosts the admin marked trusted: first event limits don't apply to them.
--                                     A row = trusted; switching it off deletes the row (audit_logs keeps the history).
--
-- Rollback (only together with reverting the PR; the backend reads these):
--   DROP TABLE IF EXISTS event_host_trust;
--   DROP INDEX IF EXISTS uq_moderation_reporter_target;
--   ALTER TABLE moderation_queue DROP COLUMN IF EXISTS details;

ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS details TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_moderation_reporter_target
  ON moderation_queue (target_type, target_id, reporter_id)
  WHERE target_type IN ('event', 'post');

CREATE TABLE IF NOT EXISTS event_host_trust (
  user_id     VARCHAR(36) PRIMARY KEY REFERENCES users(id),
  trusted_by  VARCHAR(36),
  trusted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT
);
