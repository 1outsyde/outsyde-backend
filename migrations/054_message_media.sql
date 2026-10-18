-- Migration 054: photos in direct messages + indexes for chat paging and inbox lookups (2026-10-18)
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: one new column with a default, three indexes.
--
--   messages.media_items  up to 10 photo URLs (R2, folder "messages"), oldest first. '[]' = text only.
--                         messages.content stays NOT NULL; a photo only message stores ''.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_items jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversations_participant1_idx ON conversations (participant1_id);
CREATE INDEX IF NOT EXISTS conversations_participant2_idx ON conversations (participant2_id);
