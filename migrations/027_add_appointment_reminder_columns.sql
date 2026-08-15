-- Migration 027: add reminder email tracking columns to appointments
-- reminder_24h_sent and reminder_2h_sent track whether automated reminder
-- emails have been dispatched so the job never sends duplicates.

ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "reminder_24h_sent" boolean NOT NULL DEFAULT false;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "reminder_2h_sent" boolean NOT NULL DEFAULT false;
