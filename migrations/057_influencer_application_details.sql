-- Migration 057: every influencer application answer (2026-10-18)
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only. influencer_applications has 0 rows today.
--
--   *_followers          followers on each platform (the total stays in follower_count)
--   content_categories   what they post about: shared business industry codes, '[]' = none
--   content_other        their own words when they pick Other (max 500, checked in code)

ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS instagram_followers integer;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS tiktok_followers integer;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS youtube_followers integer;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS twitter_followers integer;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS content_categories jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE influencer_applications ADD COLUMN IF NOT EXISTS content_other text;
