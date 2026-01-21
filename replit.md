# Outsyde - Social Marketplace Platform

## Overview
Outsyde is a social marketplace platform designed to connect customers with local small businesses. It offers customizable vendor storefronts, service booking capabilities, real-time chat, loyalty rewards, and a social media-style discovery feed with location-based browsing. The platform's core purpose is to empower small businesses with essential tools for expanding their reach and optimizing operations, while providing customers with a seamless experience for discovering and engaging with local services and products.

## User Preferences
- Golden yellow color scheme for branding
- Modern, social media-inspired UI
- Inter/DM Sans/Poppins font family

## System Architecture
The Outsyde platform operates as a monorepo, utilizing a React frontend, an Express (TypeScript) backend, and a PostgreSQL database managed with Drizzle ORM.

**Key Architectural Decisions & Implementations:**
-   **Authentication:** Session-based for web, JWT-based for mobile (1hr access, 7-day refresh), and OAuth via Replit Auth. Passwords are secured using bcrypt.
-   **Database:** PostgreSQL with Drizzle ORM.
-   **Real-time Communication:** Implemented using WebSockets for features like chat.
-   **UI/UX:** Adheres to a modern, social media-inspired design, incorporating a golden yellow color scheme and specified fonts.
-   **Transaction Fees:** A tiered fee structure applies: 10% for photographers per booking and 4% for businesses per transaction, in addition to subscription fees.
-   **Core Features:** Includes multi-step onboarding, verified reviews, a loyalty point system ("Outsyde Points"), and a referral program.
-   **Cart & Checkout:** Supports database-backed cart management for authenticated users, `localStorage` for guests, and multi-vendor checkout allowing purchases from various vendors in one session.
-   **Notifications:** Utilizes Web Push for cart abandonment and server-side in-app notifications for various events. Admins receive email notifications for new vendor applications.
-   **Refund System:** Provides a mechanism for users to request refunds, triggering point reversals and review revocations upon approval.
-   **Availability Calendars:** Dedicated systems for businesses and photographers to manage availability, prevent double-booking, and ensure atomic slot reservations.
-   **Admin & Vendor Dashboards:** Comprehensive dashboards for administrators to manage platform aspects, and for vendors/photographers to manage their profiles, services, and bookings.
-   **Multi-Staff System:** Businesses can manage team members with individual availability calendars and direct payouts via Stripe Connect.
-   **Monetization Intent:** Captures user interest in selling products, offering services, or promoting as an influencer, with a system-controlled `canMonetize` status requiring approval.
-   **Stripe Connect Marketplace:** Implements Stripe's destination charges model for payment processing, facilitating platform fee collection and direct payouts to vendors and photographers. Vendors must complete Stripe Express onboarding.
-   **Subscription Enforcement:** Server-side logic enforces vendor subscriptions, blocking operations and hiding storefronts for inactive subscriptions, with a grace period. Products require active subscriptions and admin approval to go live.
-   **Shipment Tracking:** A comprehensive fulfillment system with carrier integration provides shipment tracking visible to customers.
-   **Booking State Machine:** Backend-driven booking flow with states: DRAFT (10-min TTL) → PENDING_PAYMENT → CONFIRMED → COMPLETED/CANCELED. Zero double-booking guarantee via DB-level EXCLUDE constraints using GiST indexes with int4range for time overlap detection on (staff_member_id, appointment_date, time_range) and (photographer_id, date, time_range) for active states only. Draft cleanup runs every 60s. Audit trail via booking_audit_log table.
-   **State Machines & Audit Logging:** Server-side state machines enforce valid status transitions for orders and bookings, complemented by comprehensive audit logging for financial actions.
-   **Messaging Features:** Includes user blocking, message reporting, and basic abuse prevention measures.
-   **Mobile Backend Integration:** The backend serves as an API for FlutterFlow and Expo mobile apps, supporting JWT authentication and two Google OAuth flows:
    - **ID Token Flow** (`POST /api/auth/mobile/google`): Verifies Google ID tokens directly, returns JWT tokens
    - **Authorization Code Flow** (`GET /api/auth/mobile/google/callback`): Server-side OAuth for Expo apps with CSRF protection via `state` parameter, creates session, redirects to `outsyde://auth/success` or `outsyde://auth/error`
        - Mobile app calls `POST /api/auth/mobile/google/preflight` first to get server-generated state and OAuth URL
        - Preflight returns: `{ state, authUrl, expiresIn }` - state is stored server-side for validation
        - On callback, server validates state exists in store (one-time use, 10min TTL)
        - Requires `GOOGLE_OAUTH_REDIRECT_URI` env var to match registered redirect URI in Google Console
        - Environment variables: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`
-   **User Location & Personalized Search:** The backend is the source of truth for user location, enabling personalized search results based on user preferences (industries, niches, values).
-   **Data Privacy:** Strict measures are in place for sensitive data like DOB and ethnicity, ensuring limited visibility and aggregation for analytics only. Demo data is filtered for non-admin users.
-   **Business Visibility Filtering:** Server-side `isBusinessVisibleToPublic()` helper enforces visibility on all public business endpoints (/api/vendors, /api/search, /api/businesses, /api/businesses/:id, /api/businesses/:id/products, /api/businesses/:id/services). Criteria: approvalStatus === "approved", excludes demo data (ownerId contains "demo"), stripeOnboardingComplete required only if hasProducts/hasServices, and active subscription.

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