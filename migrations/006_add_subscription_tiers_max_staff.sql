-- Add subscription_tiers.max_staff for per-tier seat limit (multi-staff feature, B5)
-- NULL = uncapped (no limit). Actual per-tier values are populated by the
-- subscriptionSeeder (server/subscriptionSeeder.ts), which runs on every app boot,
-- rather than hardcoded here — keeps a single source of truth for tier data.

ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS max_staff INTEGER;
