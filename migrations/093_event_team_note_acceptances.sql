-- Migration 093: Event Team note acceptances (p4-team step 9d, Legend's calls 25 and 79 to 83)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: one new table (its UNIQUE constraint is its only index). No existing column changes.
--
--   event_team_note_acceptances   one row per (user, note version). A team member with pay is paid through Outsyde
--                                 only if they accepted the current version by payout day (server/events/teamNote.ts,
--                                 teamSend.ts memberReadySql). Rows are never updated or deleted: they are the record
--                                 of consent, the same way host_agreement_acceptances (069) is for hosts.
--
-- Rollback (nothing else depends on this table; the backend would then fail its readiness check until the PR is reverted too):
--   DROP TABLE IF EXISTS event_team_note_acceptances;

CREATE TABLE IF NOT EXISTS event_team_note_acceptances (
  id           VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      VARCHAR(36) NOT NULL REFERENCES users(id),
  version      TEXT NOT NULL,
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent   TEXT,
  CONSTRAINT uq_event_team_note_acceptances_user_version UNIQUE (user_id, version),
  CONSTRAINT event_team_note_acceptances_version_not_blank CHECK (length(btrim(version)) > 0)
);
