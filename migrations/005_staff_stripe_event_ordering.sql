-- Migration 005: staff_members — add stripe_onboarding_last_event_at for webhook ordering guard
-- Prevents stale/out-of-order account.updated events from overwriting stripe_onboarding_complete.

ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS stripe_onboarding_last_event_at TIMESTAMP;
