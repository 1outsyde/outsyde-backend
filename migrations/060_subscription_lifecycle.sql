-- Migration 060: subscription lifecycle (step 1.0b: late payments, 7 day grace, pause/unpause, notices)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only.
--
--   vendor_subscriptions.past_due_since  when the current run of failed payments began. The 7 day grace is
--       counted from here (not updated_at, which every write resets). NULL when the plan is paid up.
--       vendor_subscriptions is read in full (select *) by the backend, so this column must exist first.
--   subscription_paused_items  products and services the SYSTEM paused for a lapsed plan. Unpause brings back
--       only these, never an item the vendor paused by hand. One row per item.
--   subscription_notices  one row per email/notice actually sent (late, reminder, paused, restored, ...),
--       keyed so a webhook retry or the hourly job can never send the same notice twice.

ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMP;

CREATE TABLE IF NOT EXISTS subscription_paused_items (
  item_type   TEXT        NOT NULL CHECK (item_type IN ('product', 'service')),
  item_id     VARCHAR(36) NOT NULL,
  business_id VARCHAR(36) NOT NULL,
  paused_at   TIMESTAMP   NOT NULL DEFAULT now(),
  PRIMARY KEY (item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_subscription_paused_items_business ON subscription_paused_items (business_id);

CREATE TABLE IF NOT EXISTS subscription_notices (
  id                      VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_subscription_id  VARCHAR(36) NOT NULL,
  kind                    TEXT        NOT NULL,
  ref                     TEXT        NOT NULL,
  created_at              TIMESTAMP   NOT NULL DEFAULT now(),
  UNIQUE (vendor_subscription_id, kind, ref)
);

-- Verify (read-only): expect past_due_since, and both tables with 0 rows.
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'vendor_subscriptions' AND column_name = 'past_due_since';
-- SELECT (SELECT count(*) FROM subscription_paused_items) AS paused, (SELECT count(*) FROM subscription_notices) AS notices;
