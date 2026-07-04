-- Migration 004: staff_invites — add phone, sent_at; strengthen NOT NULL on email, invite_code, expires_at
-- Part of Resend integration (B3a)

-- Add new nullable columns first (safe, no constraint risks)
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;

-- Backfill any legacy rows that might have NULL in soon-to-be NOT NULL columns
UPDATE staff_invites SET email = 'unknown@unknown.invalid' WHERE email IS NULL;
UPDATE staff_invites SET invite_code = gen_random_uuid()::text WHERE invite_code IS NULL;
UPDATE staff_invites SET expires_at = NOW() + INTERVAL '7 days' WHERE expires_at IS NULL;

-- Strengthen constraints
ALTER TABLE staff_invites ALTER COLUMN email SET NOT NULL;
ALTER TABLE staff_invites ALTER COLUMN invite_code SET NOT NULL;
ALTER TABLE staff_invites ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE staff_invites ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '7 days';
