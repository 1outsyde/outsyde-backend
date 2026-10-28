-- Migration 077: saved businesses, photographers and products on the account (Manage Business step 6, 2026-10-28).
--
-- Until now the app kept these "Favorites" only on the phone (AsyncStorage), so they were lost on a new
-- phone or a reinstall, and the app had two places (Favorites and Saved). Saved posts already live in
-- user_saved_posts. This table holds everything else a person saves, so the app shows one Saved place.
--
--   target_type  'business' (businesses.id) | 'photographer' (photographers.id) | 'product' (vendor_products.id)
--   target_id    the id of that row. No foreign key (it points at three tables): GET /api/users/me/favorites
--                skips targets that no longer exist or are hidden, and the account deletion purge removes a
--                user's own rows.
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: one new table, nothing else changes.

CREATE TABLE IF NOT EXISTS user_favorites (
  id          VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     VARCHAR(36) NOT NULL REFERENCES users(id),
  target_type TEXT        NOT NULL,
  target_id   VARCHAR(36) NOT NULL,
  created_at  TIMESTAMP   NOT NULL DEFAULT now(),
  CONSTRAINT user_favorites_target_type_check CHECK (target_type IN ('business', 'photographer', 'product')),
  CONSTRAINT idx_user_favorites_unique UNIQUE (user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user_created ON user_favorites (user_id, created_at DESC);
