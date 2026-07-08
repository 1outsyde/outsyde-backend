-- Migration 007: staff_members — add last_active_at for multi-business staff disambiguation
-- Stamped by resolveRequestingStaffMember() whenever a staff self-service request
-- actually resolves to this business, so a user staffing 2+ businesses can be
-- auto-defaulted to whichever one they genuinely used most recently (not just
-- whichever invite they accepted most recently — createdAt does not mean that).

ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
