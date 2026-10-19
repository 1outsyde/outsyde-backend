-- Migration 061: one like per user per post.
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only (no rows are changed).
--
--   post_likes had only its primary key, so two like requests arriving at once (fast double tap, retry)
--   could both pass the "already liked?" check and insert two rows, counting the like twice.
--   storage.likePost now does INSERT ... ON CONFLICT (user_id, post_id) DO NOTHING, which needs this
--   constraint to exist. If duplicate rows ever exist, this fails loudly instead of deleting anything:
--   check with
--     SELECT post_id, user_id, count(*) FROM post_likes GROUP BY 1, 2 HAVING count(*) > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'post_likes_user_post_unique'
      AND conrelid = 'post_likes'::regclass
  ) THEN
    ALTER TABLE post_likes
      ADD CONSTRAINT post_likes_user_post_unique UNIQUE (user_id, post_id);
  END IF;
END $$;
