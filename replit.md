# Outsyde - Social Marketplace Platform

## Overview
Outsyde is a social marketplace platform designed to connect customers with local small businesses. It offers a comprehensive suite of features including customizable vendor storefronts, service booking capabilities, real-time chat for direct communication, and a loyalty rewards program. The platform also incorporates a social media-style discovery feed with location-based browsing to enhance user engagement and business visibility. The project aims to empower small businesses by providing them with robust tools to reach a wider audience and manage their operations efficiently, while offering customers a streamlined way to discover and engage with local services and products.

## User Preferences
- Golden yellow color scheme for branding
- Modern, social media-inspired UI
- Inter/DM Sans/Poppins font family

## System Architecture
The Outsyde platform is built with a clear separation of concerns, utilizing a React frontend, an Express (TypeScript) backend, and a PostgreSQL database with Drizzle ORM.

**Key Architectural Decisions & Implementations:**
-   **Dual Authentication System:**
    -   Web applications use session-based authentication with `express-session` and PostgreSQL for session storage.
    -   Mobile applications utilize JWT-based authentication with access (1hr) and refresh (7 days) tokens. Refresh tokens are securely stored and rotated.
    -   OAuth integration is provided via Replit Auth, supporting Google, GitHub, Apple, and email/password.
    -   All passwords are securely hashed with `bcrypt` (10 rounds).
-   **Database:** PostgreSQL is used as the primary data store, with Drizzle ORM for type-safe database interactions.
-   **Real-time Communication:** WebSocket technology is employed for real-time chat functionality between customers and businesses.
-   **Monorepo Structure:** The project is organized into `client/` (React frontend), `server/` (Express backend), and `shared/` (common schemas and types).
-   **UI/UX Decisions:**
    -   The UI adopts a modern, social media-inspired design aesthetic.
    -   A consistent golden yellow color scheme is used for branding.
    -   Typefaces include Inter, DM Sans, and Poppins for a contemporary look.
-   **Key Features:**
    -   **Customer & Vendor Onboarding:** Multi-step signup processes for both customer and vendor types, capturing demographic, preference, and business-specific information. Vendors acknowledge a monthly subscription.
    -   **Verified Reviews:** A system ensuring only customers with completed bookings or orders can leave reviews.
    -   **Outsyde Points:** A loyalty rewards program where customers earn points for purchases and can redeem them for discounts.
    -   **Referral System:** Users can earn points by referring new users, and new users receive bonus points upon joining via a referral.
    -   **Cart Management:** Database-backed shopping cart for authenticated users, with `localStorage` fallback for guests.
    -   **Push Notifications:** Web Push Notifications for cart abandonment reminders, managed via a service worker and VAPID keys.
    -   **Refund Request System:** Vendors, photographers, and customers can request refunds via dashboards. Refund requests are stored in the database and admin is notified for processing.

## Recent Changes (Dec 16, 2025)
- Added refund request button and dialog to vendor dashboard (vendor-dashboard.tsx)
  - Shows customer first name, last name, email, and total amount
  - Includes reason textarea with validation (required field)
  - Submit button disabled when reason empty or mutation pending
  - Toast notifications for success/error feedback
- Added refund request button and dialog to photographer dashboard (photographer-dashboard.tsx)
  - Shows booking records with client details and refund request capability
  - Same validation UX as vendor dashboard
- Fixed Stripe initialization error by adding stub methods for setupSubscriptionProducts and setupAlaCarteProducts
- Photographer bookings endpoint returns proper `bookings` format for frontend consumption

## External Dependencies
-   **PostgreSQL:** Primary database for all application data.
-   **Stripe Connect:** Integrated for marketplace payments, handling vendor payouts and customer transactions. (`stripe-replit-sync` is used for schema management).
-   **Replit Auth:** Used for OAuth authentication, supporting Google, GitHub, Apple, and email/password login.
-   **Bcrypt:** For secure password hashing.
-   **Express.js:** Web application framework for the backend.
-   **React:** Frontend library for building user interfaces.
-   **Vite:** Frontend build tool.
-   **Drizzle ORM:** TypeScript ORM for interacting with PostgreSQL.
-   **TanStack Query:** Used on the frontend for data fetching, caching, and state management.
-   **WebSockets:** For real-time chat functionality.