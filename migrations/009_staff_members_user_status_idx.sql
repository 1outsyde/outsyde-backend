-- Migration 009: staff_members — add index to support the active-staff
-- exclusion subquery used by the consumer block of unifiedSearchWithScope
-- (avoids a full table scan of staff_members on every consumer search).

CREATE INDEX IF NOT EXISTS staff_members_user_status_idx
ON staff_members (user_id, status, stripe_onboarding_complete);
