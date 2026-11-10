-- Migration 111: extra people who get every estimate request email for a business (Royal Elite step 4, 2026-11-10).
--
-- businesses.request_notify_emails: up to 5 lowercase email addresses, cleaned by server/estimates/requestRecipients.ts.
--   POST /api/estimate-requests emails each one, in addition to the owner's login email and ADMIN_NOTIFICATION_EMAIL.
--   Set by the owner (or an Outsyde admin) via GET/PUT /api/vendor/request-recipients. Private: never in
--   toPublicBusinessDTO; only the owner (my-business) and admin routes return whole business rows.
--   First use: Royal Elite Moving adds Jeremiah, who handles their calls (Legend 2026-11-10).
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: one new column with a default, no existing data changes.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS request_notify_emails text[] NOT NULL DEFAULT '{}'::text[];
