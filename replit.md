# Outsyde - Social Marketplace Platform

## Overview
Outsyde is a social marketplace platform connecting customers with local small businesses. It features customizable vendor storefronts, service booking, real-time chat, and a loyalty rewards program. The platform also includes a social media-style discovery feed with location-based browsing. Its purpose is to empower small businesses with tools for wider reach and efficient operations, while offering customers a streamlined way to discover and engage with local services and products.

## User Preferences
- Golden yellow color scheme for branding
- Modern, social media-inspired UI
- Inter/DM Sans/Poppins font family

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
    -   **Refund System:** Allows vendors, photographers, and customers to request refunds via dashboards, notifying admin.
    -   **Business Availability Calendar:** Manages date-specific time slots for businesses, including CRUD operations via API and a UI component for viewing/managing availability.
    -   **Billing Address Management:** Billing address support for all user types (customer, photographer, business) with dedicated API endpoints and a reusable form component.
    -   **Direct Image Upload:** Utilizes Replit App Storage for cloud-based image hosting, integrated into various user flows (e.g., post creation, storefront customization).
    -   **Admin Dashboard:** Provides administrative capabilities for managing users, businesses, photographers, payments, and messages, with role-based access.
    -   **Storefront Customization:** Photographers and businesses can customize brand colors (presets or custom hex) for their storefronts.
    -   **Photographer Dashboard:** Includes profile management (display name, bio, rates, specialties), service creation (hourly or package pricing), and booking management.
    -   **Collaboration Feature:** "Collaborate" button on business pages allows photographers to initiate direct communication.
    -   **Role-Aware Navigation:** Navigation components adapt based on user role (customer, vendor, photographer).
    -   **Create Post Page:** Dedicated page for all user types to create feed posts.

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