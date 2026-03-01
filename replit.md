# Outsyde - Social Marketplace Platform

## Overview
Outsyde is a social marketplace platform connecting customers with local small businesses. It features customizable vendor storefronts, service booking, real-time chat, loyalty rewards, and a social media-style discovery feed with location-based browsing. The platform's goal is to empower small businesses with tools for growth and operational efficiency, while offering customers a seamless experience for local product and service discovery.

## User Preferences
- Golden yellow color scheme for branding
- Modern, social media-inspired UI
- Inter/DM Sans/Poppins font family

## System Architecture
Outsyde is built as a monorepo, using a React frontend, an Express (TypeScript) backend, and a PostgreSQL database managed with Drizzle ORM.

**Core Architectural Decisions & Implementations:**
-   **Authentication:** Session-based for web, JWT-based for mobile (1hr access, 7-day refresh), and OAuth via Replit Auth. Passwords are secured using bcrypt.
-   **Database:** PostgreSQL with Drizzle ORM.
-   **Real-time Communication:** WebSockets for features like chat.
-   **Monetization:** Universal 12% platform booking fee on all marketplace transactions, plus subscription fees.
-   **Outsyde Points System (Loyalty):** Profit-based rewards with earning, redemption tiers, guardrails, and referral bonuses.
-   **Core Features:** Multi-step onboarding, verified reviews, and a referral program.
-   **Cart & Checkout:** Supports database-backed carts for authenticated users, `localStorage` for guests, and multi-vendor checkout.
-   **Notifications:** Web Push for cart abandonment, server-side in-app notifications, and email notifications for admins on new vendor applications.
-   **Refund System:** Allows user-initiated refunds, triggering point reversals and review revocations.
-   **Availability Calendars & Blocking:** Dedicated systems for businesses and photographers to manage schedules, prevent double-booking, and set time-off.
-   **Dashboards:** Admin, Vendor, and Photographer dashboards for platform management, profiles, services, and bookings.
-   **Multi-Staff System:** Businesses can manage team members with individual availability and Stripe Connect payouts.
-   **Monetization Intent:** Tracks user interest in selling products/services or influencing, with `canMonetize` status requiring approval.
-   **Stripe Connect Marketplace:** Uses Stripe's destination charges for payment processing, platform fee collection, and direct vendor/photographer payouts, requiring Stripe Express onboarding.
-   **Subscription Enforcement:** Server-side logic enforces vendor subscriptions, impacting storefront visibility and product/service availability, with a grace period.
-   **Shipment Tracking:** Comprehensive fulfillment system with carrier integration.
-   **Booking State Machine:** Backend-driven booking flow with provider approval support (DRAFT, PENDING_PAYMENT, PENDING_PROVIDER, CONFIRMED, COMPLETED/CANCELED/DECLINED states), ensuring zero double-booking with DB-level constraints and audit logging.
-   **Mobile Backend Integration:** API support for FlutterFlow and Expo mobile apps, including JWT and two Google OAuth flows (ID Token & Authorization Code), with CSRF protection for Expo.
-   **User Location & Personalized Search:** Backend as source of truth for user location, enabling personalized search.
-   **Identity Change Limits:** Server-side rate limiting for username (30 days) and display name (7 days) changes.
-   **Data Privacy:** Strict measures for sensitive data, limited visibility, and aggregation for analytics.
-   **Business Visibility Filtering:** Server-side logic for public business endpoints based on approval, demo data, Stripe onboarding, and active subscriptions.
-   **Photographer Visibility Control:** Lightweight moderation system (not approval gate). Photographers auto-qualify once Stripe Connect onboarding completes. Admin can set visibilityStatus (public/hidden/flagged) to control search/profile visibility without blocking onboarding. Fields: visibilityStatus, adminNotes.
-   **Post Commerce Support:** Feed posts can include validated commerce links (products, services, photographer services).
-   **Post Intent System:** Role-based authorization for post types: "social", "review", and "promotion".
-   **Post Display Layout:** Optional `displayLayout` field ("pro" | "pulse") on posts for frontend display hints. Stored as-is without inference or mapping to postIntent. Returns `null` for posts without this field (backward compatible).
-   **Feed Author Object:** Canonical author object included with every feed post for frontend identity.
-   **Follow System:** Functionality for users to follow/unfollow and retrieve follower/following lists.
-   **Profile Featured Content:** `GET /api/users/:userId/posts` endpoint supports optional featured content grouping:
    - Query params: `limit`, `offset` for pagination; `includeFeaturedContent=true` to include grouped posts; `featuredLimit` (default 5) for max items per category
    - When `includeFeaturedContent=true`, response includes `featuredContent: { proPosts: Post[], pulsePosts: Post[] }`
    - proPosts = posts with postIntent "promotion" (professional/business content)
    - pulsePosts = posts with postIntent "social" (casual community content)
    - Reviews (postIntent "review") are excluded from featured grouping
    - Backward compatible: featuredContent is optional, older clients can ignore it
-   **Storefront Video Banners:** Support for video banners on vendor/photographer storefronts with specific media attributes and fallback to images.
-   **Unified Search Engine:** `GET /api/search` and `GET /api/unified-search` provide cross-entity search with scopes (consumers, photographers, businesses, products, services), personalization based on user preferences and follows, and normalized results.
-   **Consumer Discovery (Jan 2026):** Unified search supports "consumer" entity type for discovering regular users. Queries users table directly (isVendor=false, isPhotographer=false), supports city/text filtering, hides demo users for non-admins, and maintains proper pagination/total count semantics. Frontend /search page includes Consumers tab with User icon, "Discovering in [City]" context banner, and consumer-specific empty state messaging.
-   **Stripe PaymentIntent Integration:** Complete booking payment flow with Stripe for creation, capture (automatic/manual), idempotency, fee handling, webhook event processing, and refund management.
-   **Dynamic Availability & Booking Hold System:** Real-time slot generation from weekly availability windows minus confirmed bookings minus active holds. Features:
    - Slots generated dynamically on-demand (never stored in database)
    - Temporary booking holds with auto-expiration (default 10 minutes)
    - Hold lifecycle: active → expired/released/converted
    - Error codes: OUTSIDE_HOURS, TIME_NOT_COMPATIBLE, SLOT_UNAVAILABLE, HOLD_EXPIRED, HOLD_NOT_FOUND, SERVICE_NOT_FOUND, INVALID_DATE
    - Endpoints: GET /availability/calendar, GET /availability/slots, POST /booking/validate, POST /booking/hold, POST /booking/confirm, DELETE /booking/hold/:holdId, GET /booking/holds
    - All money handled in cents (servicePriceCents)
-   **Availability Data Model & Bidirectional Sync (Verified Feb 2026):**
    - **Source of Truth:** `weekly_availability` table is the authoritative source for availability, slot generation, and booking logic
    - **Bidirectional Sync (CONFIRMED WORKING):**
      - Dashboard saves → `weekly_availability` table → auto-syncs to `hoursOfOperation` JSON via `syncWeeklyAvailabilityToHoursOfOperation()`
      - Mobile API saves → `hoursOfOperation` JSON → auto-syncs to `weekly_availability` table via `syncHoursOfOperationToWeeklyAvailability()`
      - Both directions call the appropriate sync function after successful writes
    - **Sync Functions (server/availabilityService.ts):**
      - `syncWeeklyAvailabilityToHoursOfOperation(providerType, providerId)` - Reads weekly_availability rows and updates photographer/business JSON field
      - `syncHoursOfOperationToWeeklyAvailability(providerType, providerId, hoursOfOperation)` - Parses JSON and upserts weekly_availability rows
    - **Dashboard Integration:** Dashboard writes directly to `weekly_availability` via `PUT /api/photographers/me/weekly-availability` and `PUT /api/businesses/me/weekly-availability`
    - **Day Mapping:** dayOfWeek integers (0=Sunday...6=Saturday) map to hoursOfOperation keys (sunday, monday, etc.)
    - **Hours Format (Aligned Jan 2026):** Backend accepts both frontend and legacy formats:
      - **Frontend format:** `{ open: true, start: "09:00", end: "17:00" }` or `{ open: false }` for closed days
      - **Legacy format:** `{ open: "09:00", close: "17:00", closed?: boolean }`
      - Internal `normalizeHoursEntry()` function converts both to canonical format for storage
    - **Booking Slot Generation (CONFIRMED WORKING Feb 2026):**
      - `generateAvailabilitySlots()` generates 15-minute increment slots from weekly availability windows
      - Slot generation: windowStart to windowEnd, checks serviceDuration fits, excludes blocks/bookings/holds
      - Example: 9am-5pm window with 60min service = 29 available slots per day
      - `getWeeklyAvailabilityForDay()` reads from weekly_availability table with fallback to hoursOfOperation JSON
      - `timeToMinutes()` converts "HH:MM" to minutes since midnight for slot math
-   **Pulse Feed System (TikTok 2020-style Discovery):**
    - **Philosophy:** Pure discovery/culture feed. Rank individual posts, NOT creators. Followers don't influence ranking. All user roles treated equally.
    - **Separate from Pro Feed:** Pulse is entertainment + discovery. Pro is business + intent. Completely separate pipelines.
    - **Source of Truth (Jan 2026):** `feedSurface` column is the ONLY authority for which feed a post belongs to:
      - `feedSurface = 'pulse'` → Post appears in Pulse feed
      - `feedSurface = 'pro'` → Post appears in Pro feed
      - No inference from postIntent, displayLayout, or mediaType. Frontend explicitly sends feedSurface when creating posts.
    - **Content Eligibility:** Short-form vertical videos with `feedSurface = 'pulse'` and `mediaType = 'video'`.
    - **Ranking Signals (TikTok weights):**
      - Primary: avg_watch_time (30%), completion_rate (25%), rewatch_rate (20%)
      - Secondary: share_rate (12%), save_rate (8%), comment_rate (4%), like_rate (1%)
    - **Cold Start Distribution:** Every new Pulse post enters cold-start pool (~300-1000 impressions, 60 min window), distributed to non-followers based on interest similarity.
    - **Tier Escalation System:**
      - Tier 1: ~1k impressions (15% score threshold to advance)
      - Tier 2: ~10k impressions (25% threshold)
      - Tier 3: ~50k impressions (35% threshold)
      - Tier 4: Unlimited viral distribution
      - Posts that fail at any tier stop distribution (no account penalty)
    - **User Interest Graph:** Behavior-based clustering (watch fully, skip, rewatch, share). Interest signals decay over time. Matches posts to users based on micro-interests, not social graph.
    - **API Endpoints:**
      - `GET /api/pulse/feed` - Returns ranked Pulse posts with personalization
      - `POST /api/pulse/engagement` - Records watch time, completion, rewatches, shares, saves
      - `GET /api/pulse/distribution/:postId` - Post distribution stats (debugging)
      - `GET /api/pulse/interests` - User interest vector (debugging)
    - **Frontend:** Full-screen vertical scroll, one post at a time, autoplay video with audio, tap to pause/play, loop on completion, infinite scroll.
    - **Database Tables:** `pulse_engagements`, `post_distribution`, `user_interests`

## External Dependencies
-   **PostgreSQL:** Primary database.
-   **Stripe Connect:** For marketplace payments, onboarding, and payouts.
-   **Replit Auth:** For OAuth authentication.
-   **Bcrypt:** For password hashing.
-   **Express.js:** Backend web framework.
-   **React:** Frontend library.
-   **Vite:** Frontend build tool.
-   **Drizzle ORM:** TypeScript ORM for PostgreSQL.
-   **TanStack Query:** Frontend data fetching and state management.
-   **WebSockets:** For real-time communication.