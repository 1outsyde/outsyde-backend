-- Migration 080: profile color for staff (color wheel for every account type, 2026-10-29).
--
-- Staff profiles used the business's brand color with no choice of their own. One color per staff_members
-- row (a person who staffs two businesses can pick a color for each). Same shape as users.profile_color:
--   { "type": "solid",  "id": "<one of the 16 preset ids>" }   a preset swatch
--   { "type": "custom", "hex": "#RRGGBB" }                       a color wheel pick
--   NULL                                                          not chosen, the staff profile shows the business color (unchanged)
-- Rules in shared/profileColor.ts.
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: one nullable column, no default, no existing row changes.

ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS profile_color JSONB;
