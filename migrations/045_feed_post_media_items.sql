-- Migration 045: feed_posts.media_items
-- Multi-photo posts: an ordered list of up to 10 photos for one post.
-- Each item: { "url": text, "type": "image", "width"?: int, "height"?: int, "aspectRatio"?: number }.
-- media_url / image_url keep holding photo 1, so every existing reader and old app build keeps working.
-- Default '[]' means "single media, use media_url" (every existing row).
-- Run manually in the Neon SQL editor BEFORE merging (full-row selects read every column). Safe to re-run.
-- No statement may contain a semicolon inside it: scripts/migrate.ts splits on semicolons.

ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS media_items jsonb NOT NULL DEFAULT '[]'::jsonb;
