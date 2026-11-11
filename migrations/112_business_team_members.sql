-- Migration 112: people who help run a business's own site dashboard (Royal Elite team access, Legend 2026-11-11).
--
-- business_team_members: one row per person per business.
--   role 'requests': Estimate requests (read + status + notes) and read only views. First use: Jeremiah, who
--   handles Royal Elite's calls. 'manager' is reserved for later (Legend: he will become a manager); the
--   backend accepts only 'requests' until manager access is built.
--   Not the same as staff_members (bookable workers with their own app dashboard and payouts).
--   Added and removed by the business owner (or an Outsyde admin) via /api/vendor/team.
--   Read by resolveVendorBusiness(req, res, { team }) on the routes that opt in, and listed in /api/auth/me as `team`.
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: a new table, no existing data changes.

CREATE TABLE IF NOT EXISTS business_team_members (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id varchar(36) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id varchar(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'requests',
  added_by varchar(36),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT business_team_members_role_check CHECK (role IN ('requests', 'manager'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_business_team_member ON business_team_members (business_id, user_id);
CREATE INDEX IF NOT EXISTS idx_business_team_members_user ON business_team_members (user_id);
