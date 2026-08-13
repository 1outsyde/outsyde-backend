-- Migration 026: add ratings, rating_prompt_dismissals tables and rating columns
-- Standalone ratings table (separate from text reviews) allows quick star ratings
-- after a verified purchase. ratingCount/ratingAverage on product/service tables
-- are denormalized aggregates kept in sync by the application on each write.

CREATE TABLE IF NOT EXISTS ratings (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL,
  target_type   TEXT         NOT NULL, -- 'business' | 'photographer' | 'product' | 'service'
  target_id     UUID         NOT NULL,
  rating        INTEGER      NOT NULL,  -- 1-50 (stored as rating * 10, e.g. 4.5 = 45)
  purchase_id   UUID,                   -- orderId or appointmentId that verified this rating
  purchase_type TEXT,                   -- 'order' | 'appointment' | 'shoot_booking'
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  CONSTRAINT ratings_user_target_unique UNIQUE (user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS ratings_target_idx
  ON ratings (target_type, target_id);

CREATE INDEX IF NOT EXISTS ratings_user_idx
  ON ratings (user_id);

CREATE TABLE IF NOT EXISTS rating_prompt_dismissals (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL,
  purchase_id   UUID         NOT NULL,
  purchase_type TEXT         NOT NULL,
  dismissed_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  CONSTRAINT rating_prompt_dismissals_user_purchase_unique UNIQUE (user_id, purchase_id, purchase_type)
);

ALTER TABLE vendor_products
  ADD COLUMN IF NOT EXISTS rating_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_average INTEGER NOT NULL DEFAULT 0;

ALTER TABLE vendor_services
  ADD COLUMN IF NOT EXISTS rating_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_average INTEGER NOT NULL DEFAULT 0;

ALTER TABLE photographer_services
  ADD COLUMN IF NOT EXISTS rating_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_average INTEGER NOT NULL DEFAULT 0;
