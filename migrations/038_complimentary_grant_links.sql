-- Migration 038: complimentary (free-plan) claim links.
-- Only a sha256 of the token is stored; the raw token is shown once and never persisted.
-- Hand-run in the Neon SQL editor, then record it in _schema_migrations. Never db:migrate /
-- drizzle-kit push against production.
-- No statement may contain a semicolon inside a string: scripts/migrate.ts splits on it.

CREATE TABLE IF NOT EXISTS complimentary_grant_links (
  id              VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      TEXT        NOT NULL,
  business_id     VARCHAR(36) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_expires_at TIMESTAMP,
  link_expires_at TIMESTAMP   NOT NULL,
  created_by      VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP   NOT NULL DEFAULT now(),
  redeemed_at     TIMESTAMP,
  redeemed_by     VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  revoked_at      TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_complimentary_grant_links_token_hash
  ON complimentary_grant_links (token_hash);

CREATE INDEX IF NOT EXISTS idx_complimentary_grant_links_business
  ON complimentary_grant_links (business_id, created_at DESC);
