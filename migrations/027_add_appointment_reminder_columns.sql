-- Migration 027: Add appointment reminder tracking columns
-- Tracks when 24h and 2h reminders were sent to avoid duplicate sends

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS reminder_2h_sent_at TIMESTAMP;
