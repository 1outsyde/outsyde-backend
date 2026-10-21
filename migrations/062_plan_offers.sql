-- Migration 062: hidden plan offers (Plan Offers board 1.3)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: one new table, nothing existing changes.
--
-- An admin offers a hidden plan (Grandfathered, or the Free plan with an end date or permanent) to one
-- business. The offer is saved here; the owner sees it in the app and on goutsyde.com until it is accepted
-- or withdrawn. At most ONE pending offer per business (partial unique index).
--
--   plan              'grandfathered' | 'free'
--   tier_id           the tier the offer gives (resolved server side when the offer is made)
--   free_expires_at   Free plan end; NULL = permanent. Always NULL for grandfathered.
--   status            'pending' -> 'accepted' | 'withdrawn'
--   checkout_session_id  the open Stripe Checkout for this offer, expired when the offer is withdrawn
--   notified_at       when the owner was emailed / pushed about the offer

CREATE TABLE IF NOT EXISTS plan_offers (
  id                  VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         VARCHAR(36) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  owner_id            VARCHAR(36) NOT NULL,
  plan                TEXT        NOT NULL CHECK (plan IN ('grandfathered', 'free')),
  tier_id             VARCHAR(36) NOT NULL REFERENCES subscription_tiers(id),
  free_expires_at     TIMESTAMP,
  status              TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'withdrawn')),
  created_by          VARCHAR(36) NOT NULL,
  created_at          TIMESTAMP   NOT NULL DEFAULT now(),
  accepted_at         TIMESTAMP,
  withdrawn_at        TIMESTAMP,
  withdrawn_by        VARCHAR(36),
  checkout_session_id TEXT,
  notified_at         TIMESTAMP,
  CHECK (plan = 'free' OR free_expires_at IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_offers_one_pending ON plan_offers (business_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_plan_offers_business ON plan_offers (business_id, created_at DESC);

-- Verify (read-only): expect the table with 0 rows and both indexes.
-- SELECT count(*) FROM plan_offers;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'plan_offers';
