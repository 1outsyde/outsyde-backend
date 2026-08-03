-- Migration 025: add story_highlights table
-- Stores permanent user-saved copies of story media (highlights survive story expiry).
-- Media fields are denormalized at save time so highlights remain intact after
-- the source story expires or is deleted.

CREATE TABLE IF NOT EXISTS story_highlights (
  id            VARCHAR(36)  PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       VARCHAR(36)  NOT NULL REFERENCES users(id),
  story_id      VARCHAR(36)  NOT NULL REFERENCES stories(id),
  media_url     TEXT         NOT NULL,
  media_type    TEXT         NOT NULL,
  thumbnail_url TEXT,
  mux_asset_id  TEXT,
  caption       TEXT,
  saved_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  CONSTRAINT story_highlights_unique UNIQUE (user_id, story_id)
);

CREATE INDEX IF NOT EXISTS idx_story_highlights_user
  ON story_highlights (user_id, saved_at DESC);
