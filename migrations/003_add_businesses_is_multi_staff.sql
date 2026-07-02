-- Add businesses.is_multi_staff flag for independent-booking multi-staff service businesses
-- Applied: 2026-06-29

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_multi_staff BOOLEAN NOT NULL DEFAULT false;
