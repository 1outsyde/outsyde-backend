-- Migration 024: add stories and story_views tables
-- stories: ephemeral 24-hour media posts (image or video), expires_at set at
--   insert time by application code (created_at + interval '24 hours').
-- story_views: tracks which users have viewed a given story (for view counts
--   and the viewer list); unique constraint prevents duplicate view records.

CREATE TABLE IF NOT EXISTS stories (
  id            VARCHAR(36)  PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  author_id     VARCHAR(36)  NOT NULL REFERENCES users(id),
  media_url     TEXT         NOT NULL,
  media_type    TEXT         NOT NULL,
  thumbnail_url TEXT,
  mux_asset_id  TEXT,
  caption       TEXT,
  created_at    TIMESTAMP    NOT NULL DEFAULT now(),
  expires_at    TIMESTAMP    NOT NULL,
  is_active     BOOLEAN      NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_stories_author_active_expires
  ON stories (author_id, is_active, expires_at);

CREATE INDEX IF NOT EXISTS idx_stories_expires_at
  ON stories (expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  id         VARCHAR(36)  PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  story_id   VARCHAR(36)  NOT NULL REFERENCES stories(id),
  viewer_id  VARCHAR(36)  NOT NULL REFERENCES users(id),
  viewed_at  TIMESTAMP    NOT NULL DEFAULT now(),
  CONSTRAINT story_views_unique UNIQUE (story_id, viewer_id)
);
