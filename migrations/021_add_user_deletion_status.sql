-- Migration 021: add deletion status fields to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deletion_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamp,
  ADD COLUMN IF NOT EXISTS scheduled_deletion_at timestamp;

CREATE INDEX IF NOT EXISTS idx_users_pending_deletion
  ON users (scheduled_deletion_at)
  WHERE deletion_status = 'pending_deletion';
