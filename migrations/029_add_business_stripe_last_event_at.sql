-- Migration 029: add stripe_onboarding_last_event_at to businesses
-- Guards against out-of-order Stripe account.updated webhook events overwriting
-- stripe_onboarding_complete after it was already set to true.
-- Mirrors the same column on photographers (028) and staff_members (005).

ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "stripe_onboarding_last_event_at" timestamp;
