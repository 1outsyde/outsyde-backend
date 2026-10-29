-- Migration 079: profile color for every user (color wheel build, 2026-10-28).
--
-- Consumers had no color column, so their profile was always gold. Businesses and photographers keep
-- their own brand_colors column. This column holds the person's own profile color in the same shape:
--   { "type": "solid",  "id": "<one of the 16 preset ids>" }   a preset swatch
--   { "type": "custom", "hex": "#RRGGBB" }                       a color wheel pick
--   NULL                                                          not chosen yet, shows gold (unchanged)
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: one nullable column, no default, no existing row changes.

ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_color JSONB;
