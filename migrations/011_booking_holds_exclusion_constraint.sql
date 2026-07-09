CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE booking_holds
ADD CONSTRAINT no_overlapping_active_holds
EXCLUDE USING gist (
  provider_type WITH =,
  provider_id WITH =,
  COALESCE(staff_member_id, '') WITH =,
  tsrange(start_at, end_at) WITH &&
)
WHERE (status = 'active');
