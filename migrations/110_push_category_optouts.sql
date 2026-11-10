-- Migration 110: per-category push switches (Activity step 3a, 2026-11-10).
--
-- push_category_optouts: one row per person per category they turned OFF in the app's Notification settings.
--   No row = on (everyone starts with every category on). Categories: bookings, messages, orders, events.
--   Read by sendExpoPush (server/push/pushCategories.ts pushAllowedFor) before every push except announcements
--   (those keep using push_news_optouts). Money, account and admin pushes are never muted (not in a category).
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: new table, nothing on users.

CREATE TABLE IF NOT EXISTS push_category_optouts (
  user_id     varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN ('bookings', 'messages', 'orders', 'events')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);
