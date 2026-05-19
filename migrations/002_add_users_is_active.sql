-- Add is_active column to users table for admin moderation
-- Applied: 2026-05-19

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
