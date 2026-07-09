-- Migration 010: staff_members — uniqueness backstop for re-invite reactivation (G7)
-- Prevents any code path from ever inserting a second staff_members row for the
-- same person (business_id + email, or business_id + user_id) at the same
-- business, regardless of status ('active' | 'inactive' | 'pending' | 'archived').
-- Partial indexes so multiple legitimate rows with a NULL email/user_id (e.g.
-- owner-added staff with no linked account yet) never conflict with each other.
--
-- Safety: if duplicate rows already exist, CREATE UNIQUE INDEX below will fail
-- rather than silently corrupt state. Run these first and resolve any conflicts
-- manually (merge/deactivate extras) before applying this migration:
--   SELECT business_id, email, COUNT(*), array_agg(id) FROM staff_members
--     WHERE email IS NOT NULL GROUP BY business_id, email HAVING COUNT(*) > 1;
--   SELECT business_id, user_id, COUNT(*), array_agg(id) FROM staff_members
--     WHERE user_id IS NOT NULL GROUP BY business_id, user_id HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS staff_members_business_email_uidx
  ON staff_members (business_id, email)
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS staff_members_business_user_uidx
  ON staff_members (business_id, user_id)
  WHERE user_id IS NOT NULL;
