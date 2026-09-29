-- Migration 036: one subscription row per business.
-- Required by the complimentary-tier admin upsert (ON CONFLICT (business_id)).
-- Pre-check (read-only) before running: no business_id appears twice.
--   SELECT business_id, count(*) FROM vendor_subscriptions GROUP BY 1 HAVING count(*) > 1;
-- Hand-run in the Neon SQL editor. Never db:migrate / drizzle-kit push against production.
-- No statement may contain a semicolon inside a string: scripts/migrate.ts splits on it.

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_subscriptions_business ON vendor_subscriptions(business_id);
