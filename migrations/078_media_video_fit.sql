-- Migration 078: Fill / Fit choice for videos, and room for it on stories and highlights (2026-10-28).
--
-- Upload flows now copy TikTok: when someone posts a Pulse video or a video story, they choose
-- Fill (zoom to the full 9:16 screen) or Fit (show the whole video over a blurred copy).
-- Mux cannot crop playback, so the app saves the choice and applies it when the video plays.
--
--   video_fit  'fill' | 'fit' | NULL. NULL = automatic (vertical video fills, wide video fits).
--              Photos always store NULL.
--
-- feed_posts        Pulse videos (and any video post)
-- stories           video stories
-- story_highlights  copied from the story when it is highlighted
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: three nullable columns, existing rows stay NULL (automatic).

ALTER TABLE feed_posts       ADD COLUMN IF NOT EXISTS video_fit TEXT;
ALTER TABLE stories          ADD COLUMN IF NOT EXISTS video_fit TEXT;
ALTER TABLE story_highlights ADD COLUMN IF NOT EXISTS video_fit TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feed_posts_video_fit_check') THEN
    ALTER TABLE feed_posts ADD CONSTRAINT feed_posts_video_fit_check CHECK (video_fit IS NULL OR video_fit IN ('fill', 'fit'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stories_video_fit_check') THEN
    ALTER TABLE stories ADD CONSTRAINT stories_video_fit_check CHECK (video_fit IS NULL OR video_fit IN ('fill', 'fit'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'story_highlights_video_fit_check') THEN
    ALTER TABLE story_highlights ADD CONSTRAINT story_highlights_video_fit_check CHECK (video_fit IS NULL OR video_fit IN ('fill', 'fit'));
  END IF;
END $$;
