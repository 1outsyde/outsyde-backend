-- Migration 028: add stripe_onboarding_last_event_at to photographers
-- Guards against out-of-order Stripe webhook events overwriting
-- stripe_onboarding_complete after it was already set to true.
-- Mirrors the same column on staff_members (schema.ts line ~547).

ALTER TABLE "photographers" ADD COLUMN IF NOT EXISTS "stripe_onboarding_last_event_at" timestamp;
