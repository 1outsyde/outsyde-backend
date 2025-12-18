# Outsyde - Social Marketplace Platform

## Overview
Outsyde is a social marketplace platform connecting customers with local small businesses. It features customizable vendor storefronts, service booking, real-time chat, and a loyalty rewards program. The platform also includes a social media-style discovery feed with location-based browsing. Its purpose is to empower small businesses with tools for wider reach and efficient operations, while offering customers a streamlined way to discover and engage with local services and products.

## User Preferences
- Golden yellow color scheme for branding
- Modern, social media-inspired UI
- Inter/DM Sans/Poppins font family

## User Profile Fields
- **Username:** Optional unique identifier displayed publicly in comments instead of real name
- **Date of Birth:** Replaces age range for customer profiles (date input, not age range select)
- **Privacy:** Real names only shown during booking/purchasing transactions; usernames used for social interactions

## System Architecture
The Outsyde platform uses a React frontend, an Express (TypeScript) backend, and a PostgreSQL database with Drizzle ORM, organized in a monorepo (`client/`, `server/`, `shared/`).

**Key Architectural Decisions & Implementations:**
-   **Authentication:**
    -   Web applications: Session-based with `express-session` and PostgreSQL.
    -   Mobile applications: JWT-based (1hr access, 7-day refresh tokens).
    -   OAuth: Via Replit Auth (Google, GitHub, Apple, email/password).
    -   Password Hashing: `bcrypt` (10 rounds).
-   **Database:** PostgreSQL with Drizzle ORM for type-safe interactions.
-   **Real-time Communication:** WebSockets for chat.
-   **UI/UX:** Modern, social media-inspired design with a consistent golden yellow color scheme and Inter, DM Sans, Poppins fonts.
-   **Transaction Fees:** 10% for photographers per booking; 4% for businesses per transaction plus subscription.
-   **Core Features:**
    -   **Onboarding:** Multi-step signup for customers and vendors (including business details, location, online presence, and subscription acknowledgment).
    -   **Verified Reviews:** Only customers with completed bookings/orders can leave reviews.
    -   **Outsyde Points:** Loyalty program for customers (earn and redeem points); photographers do not participate.
    -   **Referral System:** Users earn points for referrals; new users get bonus points.
    -   **Cart Management:** Database-backed for authenticated users, `localStorage` for guests.
    -   **Push Notifications:** Web Push for cart abandonment reminders.
    -   **In-App Notifications:** Server-side notification system with triggers for booking confirmed, payment succeeded/failed, subscription activated/canceled, add-on charged, refund issued, new order received, and photographer assigned events. API endpoints: GET /api/notifications, GET /api/notifications/unread-count, PATCH /api/notifications/:id/read, POST /api/notifications/mark-all-read.
    -   **Refund System:** Allows vendors, photographers, and customers to request refunds via dashboards, notifying admin.
    -   **Business Availability Calendar:** Manages date-specific time slots for businesses, including CRUD operations via API and a UI component for viewing/managing availability. Slot types: 'available', 'blocked', 'booked'. Booked slots are protected from deletion/modification.
    -   **Photographer Availability Calendar:** Similar to business availability with dedicated API endpoints: GET /api/photographers/me/availability, POST /api/photographers/me/availability, PATCH /api/photographers/me/availability/:slotId, DELETE /api/photographers/me/availability/:slotId. Slot types: 'available', 'blocked', 'booked' with server-side protection for booked slots.
    -   **Double-Booking Prevention:** Both photographer and business booking flows check slot availability before creating bookings. Returns 409 Conflict with user-friendly message when slot unavailable. Availability checks query both availability tables (for manual blocks) AND existing bookings (for legacy data). Slots are atomically reserved when bookings are created.
    -   **Billing Address Management:** Billing address support for all user types (customer, photographer, business) with dedicated API endpoints and a reusable form component.
    -   **Direct Image Upload:** Utilizes Replit App Storage for cloud-based image hosting, integrated into various user flows (e.g., post creation, storefront customization).
    -   **Admin Dashboard:** Provides administrative capabilities for managing users, businesses, photographers, payments, and messages, with role-based access.
    -   **Storefront Customization:** Photographers and businesses can customize brand colors (presets or custom hex) for their storefronts.
    -   **Photographer Dashboard:** Includes profile management (display name, bio, rates, specialties), service creation (hourly or package pricing), and booking management.
    -   **Collaboration Feature:** "Collaborate" button on business pages allows photographers to initiate direct communication.
    -   **Role-Aware Navigation:** Navigation components adapt based on user role (customer, vendor, photographer).
    -   **Create Post Page:** Dedicated page for all user types to create feed posts.
    -   **Shipment Tracking:** Comprehensive shipment fulfillment system with carrier integration. Vendors can mark orders as shipped via carrier dropdown (FedEx, UPS, USPS, DHL, Amazon, OnTrac, LaserShip, Other) and tracking number input. Customers see carrier logo, tracking number, and "Track Package" button linking to carrier's tracking site. Order status auto-updates to 'shipped' when shipment created. API endpoints: POST /api/orders/:orderId/shipments, GET /api/orders/:orderId/shipments, PATCH /api/shipments/:shipmentId, GET /api/vendor/shipments, GET /api/my-orders.
    -   **Order/Booking State Machines:** Server-side enforcement of valid status transitions. Order states: pending → paid → shipped → delivered (refunded/cancelled are terminal). Booking states: pending → confirmed → in_progress → completed (cancelled/refunded are terminal). Uses `updateOrderWithValidation()` and `updateBookingWithValidation()` methods.
    -   **Audit Logging:** Complete audit trail for financial actions via `audit_logs` table. Captures actorId, actorType, action, targetType, targetId, beforeState, afterState, metadata, IP address, and user agent. Automatically logs order/booking status changes.
    -   **Refund Cascading Effects:** When refunds are approved: points are automatically reversed via `reversePointsForRefund()`, verified reviews are revoked via `revokeVerifiedReviewsForRefund()`, and target ratings are recalculated.
    -   **Message Abuse Prevention:** Chat messages validated with 2000 character limit, max 5 links per message, and duplicate message detection. General API rate limiting (100 req/min authenticated, 20 req/min unauthenticated) provides baseline protection.
    -   **Subscription Tier Changes:** Complete upgrade/downgrade flow for business subscriptions. Features include:
        - Tier change detection in webhook handler (compares Stripe price to current tier)
        - Automatic benefit migration when tier changes (expires old allowances, creates new ones)
        - API endpoints: POST /api/vendor/subscription/change-tier (execute change with proration), POST /api/vendor/subscription/preview-change (preview proration costs)
        - Notifications for tier changes with upgrade/downgrade context
        - Validation: only active subscriptions can be changed, same-tier changes rejected
    -   **Referral Program (Deferred Rewards):** Secure referral system with backend validation:
        - Referrer reward: 500 points ($5) - ONLY awarded after referred user's first paid transaction
        - Referred user: 250 points ($2.50) welcome bonus - awarded immediately on code application
        - Self-referral prevention: Users cannot use their own referral code
        - One-to-many abuse prevention: Maximum 50 successful referrals per user
        - Duplicate referral prevention: Users can only use one referral code
        - API endpoints: GET /api/referral/code (get code + stats), POST /api/referral/apply (apply code), GET /api/referral/stats (view referral stats)
        - Referral completion triggered by Stripe checkout.session.completed webhook
        - Points conversion: 100 points = $1
    -   **Subscription Enforcement (Server-Side):** Comprehensive enforcement of vendor subscriptions:
        - **Vendor Operations Blocked:** All product/service/availability CRUD endpoints require active subscription
        - **Storefront Hidden:** Public business listings, individual business pages, and feed posts filtered to exclude inactive vendors
        - **Transactions Blocked:** Cart additions blocked for products from inactive businesses
        - **Grace Period:** 3-day grace period for `past_due` subscriptions, measured from `updatedAt` timestamp (when status changed)
        - **Status Handling:** `active`, `trialing` = allowed; `canceled` = allowed until period end; `past_due` = allowed during grace period
        - **Read-Only Access:** Vendors can still view their data even with inactive subscription
        - Uses `isVendorSubscriptionActive()` and `isBusinessSubscriptionActive()` storage methods

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