-- Audit: find all rows across all tables that still reference Cloudinary (dead links)
-- Run with: psql $DATABASE_URL -f scripts/audit-cloudinary-urls.sql

-- Users
SELECT 'users' AS table_name, id, 'profile_image_url' AS column_name, profile_image_url AS url
FROM users
WHERE profile_image_url LIKE '%res.cloudinary.com%'
UNION ALL
-- Photographer profiles
SELECT 'photographer_profiles', id, 'cover_image', cover_image
FROM photographer_profiles
WHERE cover_image LIKE '%res.cloudinary.com%'
UNION ALL
SELECT 'photographer_profiles', id, 'logo_image', logo_image
FROM photographer_profiles
WHERE logo_image LIKE '%res.cloudinary.com%'
UNION ALL
-- Business profiles
SELECT 'businesses', id, 'cover_image', cover_image
FROM businesses
WHERE cover_image LIKE '%res.cloudinary.com%'
UNION ALL
SELECT 'businesses', id, 'logo_image', logo_image
FROM businesses
WHERE logo_image LIKE '%res.cloudinary.com%'
UNION ALL
-- Posts (image_url)
SELECT 'posts', id, 'image_url', image_url
FROM posts
WHERE image_url LIKE '%res.cloudinary.com%'
ORDER BY table_name, id;

-- Clear the stale Cloudinary avatar for the known affected photographer user
-- userId: 0d4ce8b5-3fc8-4613-a6e8-7b9b9c98cdd2
-- Uncomment and run after confirming the audit above:
--
-- UPDATE users
-- SET profile_image_url = NULL
-- WHERE id = '0d4ce8b5-3fc8-4613-a6e8-7b9b9c98cdd2'
--   AND profile_image_url LIKE '%res.cloudinary.com%';
