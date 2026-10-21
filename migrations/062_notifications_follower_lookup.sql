-- Migration 062: index for the "notify once per follower" check (POST /api/follows).
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only (no rows are changed).
--
--   notifications had only its primary key, so the check
--     WHERE user_id = $1 AND type = 'new_follower' AND triggered_by_user_id = $2
--   scanned the whole table on every new follow. The code works without the index; it is speed only.

CREATE INDEX IF NOT EXISTS idx_notifications_user_type_actor
  ON notifications (user_id, type, triggered_by_user_id);
