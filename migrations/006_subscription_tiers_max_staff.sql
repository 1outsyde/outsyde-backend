-- Migration 006: subscription_tiers — add max_staff seat-limit column (B5 multi-staff feature)
--
-- max_staff (integer, nullable):
--   NULL  = uncapped / no seat limit (used for Pro tier)
--   n > 0 = maximum number of ACTIVE staff members allowed on this tier
--
-- Pending/unaccepted invites do NOT count toward this limit; only staff_members
-- rows with status = 'active' are counted at invite time.
--
-- The column is nullable (not a sentinel integer) so that the read-side check is
-- unambiguous: NULL means "no limit" everywhere this value is consumed.

ALTER TABLE subscription_tiers
  ADD COLUMN IF NOT EXISTS max_staff INTEGER;

-- Populate existing tiers with locked seat-limit values.
-- Tiers are matched by their canonical `name` values (not display_name or id)
-- so this is safe even if UUIDs differ across environments.
UPDATE subscription_tiers SET max_staff = 3  WHERE name = 'starter';
UPDATE subscription_tiers SET max_staff = 8  WHERE name = 'growth';
UPDATE subscription_tiers SET max_staff = NULL WHERE name = 'pro';  -- NULL = uncapped
