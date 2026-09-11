-- Add registration source column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT;
