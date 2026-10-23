-- Migration 069: Event Host Agreement acceptances (who accepted which version, and when)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: one new table and one index. No existing column changes.
--
--   host_agreement_acceptances   one row per (user, agreement version). Publishing an event needs a row for the
--                                current version (server/events/hostAgreement.ts). Rows are never updated or deleted:
--                                they are the record of consent (Agreement sections 1 and 9.5).
--
-- Rollback (nothing else depends on this table; publishing would then fail until the PR is reverted too):
--   DROP TABLE IF EXISTS host_agreement_acceptances;

CREATE TABLE IF NOT EXISTS host_agreement_acceptances (
  id           VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      VARCHAR(36) NOT NULL REFERENCES users(id),
  version      TEXT NOT NULL,
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent   TEXT,
  CONSTRAINT uq_host_agreement_acceptances_user_version UNIQUE (user_id, version),
  CONSTRAINT host_agreement_acceptances_version_not_blank CHECK (length(btrim(version)) > 0)
);
