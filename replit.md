# Outsyde - Social Marketplace Platform

## Overview
Outsyde is a social marketplace platform connecting customers with local small businesses. It features customizable vendor storefronts, service booking, real-time chat, loyalty rewards, and a social media-style discovery feed with location-based browsing. Its purpose is to empower small businesses with tools for wider reach and efficient operations, while offering customers a streamlined way to discover and engage with local services and products.

## User Preferences
- Golden yellow color scheme for branding
- Modern, social media-inspired UI
- Inter/DM Sans/Poppins font family

## System Architecture
The Outsyde platform uses a React frontend, an Express (TypeScript) backend, and a PostgreSQL database with Drizzle ORM, organized in a monorepo (`client/`, `server/`, `shared/`).

**Key Architectural Decisions & Implementations:**
-   **Authentication:** Session-based for web, JWT-based for mobile (1hr access, 7-day refresh), OAuth via Replit Auth. Passwords hashed with `bcrypt` (10 rounds).
-   **Database:** PostgreSQL with Drizzle ORM.
-   **Real-time Communication:** WebSockets for chat.
-   **UI/UX:** Modern, social media-inspired design with a golden yellow color scheme and specified fonts.
-   **Transaction Fees:** 10% for photographers per booking; 4% for businesses per transaction plus subscription.
-   **Core Features:**
    -   **Onboarding:** Multi-step signup for customers and vendors.
    -   **Verified Reviews:** Only customers with completed bookings/orders can leave reviews, locked after 30 days.
    -   **Outsyde Points:** Loyalty program for customers.
    -   **Referral System:** Users earn points for referrals, referred users get bonus points. Referral rewards are deferred and anti-abuse mechanisms are in place.
    -   **Cart Management:** Database-backed for authenticated users, `localStorage` for guests.
    -   **Multi-Vendor Checkout:** Supports purchasing from multiple vendors in a single cart session. Creates an `orderGroup` linking separate orders per vendor, with sequential Stripe checkout sessions. Frontend handles URL-based redirect flow for checkout continuation.
    -   **Notifications:** Web Push for cart abandonment, server-side in-app notifications for various events.
    -   **Refund System:** Allows users to request refunds, notifying admin. Refund approvals trigger point reversal, review revocation, and rating recalculation.
    -   **Availability Calendars:** Dedicated availability management for businesses and photographers, with CRUD operations and UI components. Protected against double-booking and ensures atomic reservation of slots. Slots are released upon cancellation/refund.
    -   **Billing Address Management:** Support for all user types.
    -   **Direct Image Upload:** Utilizes Replit App Storage.
    -   **Admin Dashboard:** For managing users, businesses, photographers, payments, and messages with role-based access.
    -   **Storefront Customization:** Businesses and photographers can customize brand colors.
    -   **Photographer Dashboard:** Profile, service, and booking management.
    -   **Collaboration Feature:** Direct communication initiation between businesses and photographers.
    -   **Business Hours Management:** Reusable hours editor with day-by-day selection and live status display.
    -   **Role-Aware Navigation:** Adapts based on user role.
    -   **Create Post Page:** Dedicated page for all user types to create feed posts.
    -   **Shipment Tracking:** Comprehensive fulfillment system with carrier integration for vendors, visible to customers. When shipments are delivered, influencer referral commissions are credited atomically using a conditional UPDATE with WHERE `credited_at IS NULL` guard to prevent double-crediting from concurrent requests.
    -   **State Machines:** Server-side enforcement of valid status transitions for orders and bookings.
    -   **Audit Logging:** Comprehensive audit trail for financial actions, including order/booking status changes, subscription changes, and refund approvals.
    -   **Message Abuse Prevention:** Chat messages validated (character limit, link limit, duplicate detection). Note: API rate limiting for chat endpoints is deferred for post-launch implementation once usage patterns are established.
    -   **User Blocking System:** Bidirectional blocking to prevent messaging.
    -   **Message Reporting System:** Users can report inappropriate messages for admin review.
    -   **Subscription Tier Changes:** Full upgrade/downgrade flow for business subscriptions, including proration, benefit migration, and notifications.
    -   **Subscription Enforcement (Server-Side):** Comprehensive enforcement of vendor subscriptions, blocking operations, hiding storefronts, and preventing transactions for inactive subscriptions, with a 3-day grace period for `past_due` statuses. Data remains readable for inactive vendors.
    -   **Stripe Express Onboarding:** Vendors and photographers must complete Stripe Express onboarding before accepting payments. Onboarding status tracked via `stripeAccountId` and `stripeOnboardingComplete` fields on Business/Photographer models. Unified API endpoints (`/api/vendor/stripe-onboarding/status` and `/api/vendor/stripe-onboarding/create-link`) handle both account types based on session. "Go Live" functionality blocked until onboarding complete. `account.updated` webhook updates completion status.
    -   **Publishing Enforcement:** Vendors can create draft products/services without subscription, but publishing to "live" status requires both active Stripe subscription AND completed Stripe Connect onboarding.
    -   **Checkout Verification:** At checkout, system verifies vendor Stripe account status via Stripe API (`chargesEnabled` and `payoutsEnabled`) before processing payment.
    -   **Multi-Staff System:** Businesses (barbershops, salons, spas) can manage team members with individual availability calendars. Staff members have their own Stripe Connect accounts for direct payouts. Each staff member receives 100% of booking revenue minus 4% platform fee (same as business rate). Shop arrangements for rent/commission splits are handled outside Outsyde. Staff Dashboard (`/staff-dashboard`) allows staff to view their bookings, earnings, and manage availability. Vendor Dashboard Team tab provides staff CRUD, invite management, and Stripe onboarding tracking. Booking flow includes staff selection when staff are available.
    -   **User Monetization Intent:** Captures user interest in selling products, offering services, or promoting as influencer. Fields: `wantsToSellProducts`, `wantsToOfferServices`, `wantsToPromoteAsInfluencer` (user-controlled) and `canMonetize` (system-controlled, requires approval). Endpoint: `POST /api/user/monetization-intent` updates intent fields only, never touches roles or canMonetize.
-   **Mobile Backend (FlutterFlow):**
    -   Backend serves as API for FlutterFlow mobile app
    -   Authentication: JWT tokens (1hr access, 7-day refresh) via `/api/auth/mobile/login` and `/api/auth/mobile/refresh`
    -   Monetization intent endpoint accepts userId from JWT token or request body (for FlutterFlow integration where auth is handled client-side)
-   **Data Privacy:**
    -   **DOB:** Collected for eligibility, full DOB visible to user/admin only; vendors see age ranges. `sanitizeUserForResponse()` removes DOB from non-admin API responses.
    -   **Race/Ethnicity:** Optional, never exposed individually; only for aggregated analytics (future). `sanitizeUserForResponse()` removes ethnicity from all responses.
    -   **Authorization:** Vendor/Business/Photographer IDs derived from authenticated session; cross-vendor access impossible. Ownership verified for all operations.
    -   **Demographic Aggregation (Future):** Minimum sample size and rounding for privacy, "Unknown" bucket handled.

## External Dependencies
-   **PostgreSQL:** Primary database.
-   **Stripe Connect:** For marketplace payments and payouts.
-   **Replit Auth:** For OAuth authentication (Google, GitHub, Apple) and email/password.
-   **Bcrypt:** For password hashing.
-   **Express.js:** Backend web framework.
-   **React:** Frontend library.
-   **Vite:** Frontend build tool.
-   **Drizzle ORM:** TypeScript ORM for PostgreSQL.
-   **TanStack Query:** Frontend data fetching and state management.
-   **WebSockets:** For real-time communication.