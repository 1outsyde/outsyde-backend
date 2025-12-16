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
-   **Transaction Fees:** Photographers pay 10% Outsyde fee per booking. Businesses pay 4% per transaction plus their monthly subscription.
-   **Key Features:**
    -   **Customer & Vendor Onboarding:** Multi-step signup processes for both customer and vendor types, capturing demographic, preference, and business-specific information. Vendors acknowledge a monthly subscription.
    -   **Verified Reviews:** A system ensuring only customers with completed bookings or orders can leave reviews.
    -   **Outsyde Points:** A loyalty rewards program where customers earn points for purchases and can redeem them for discounts. Note: Photographers do NOT earn or see loyalty points since they earn income from clients instead.
    -   **Referral System:** Users can earn points by referring new users, and new users receive bonus points upon joining via a referral.
    -   **Cart Management:** Database-backed shopping cart for authenticated users, with `localStorage` fallback for guests.
    -   **Push Notifications:** Web Push Notifications for cart abandonment reminders, managed via a service worker and VAPID keys.
    -   **Refund Request System:** Vendors, photographers, and customers can request refunds via dashboards. Refund requests are stored in the database and admin is notified for processing.

## Recent Changes (Dec 16, 2025)
- **Storefront Brand Color Customization**
  - Both photographers and businesses can customize their storefront brand colors
  - Color presets available: Golden Yellow, Rose Pink, Ocean Blue, Forest Green, Royal Purple, Sunset Orange, Teal, Slate Gray
  - Custom color picker and hex input for any color
  - Brand colors stored in `brandColors` JSONB column with `primary` property
  - Photographer dashboard has "Storefront" tab with cover image, logo image, and brand color selection
  - Business StorefrontEditor has "Branding" tab with same customization options
  - VendorStorefront component applies brand colors to Follow/Collaborate buttons and tab active borders
  - Preview section shows how brand color will appear on buttons and text
- **Photographer Dashboard Profile Tab**
  - Added "Profile" tab to photographer dashboard alongside Bookings and Services tabs
  - Photographers can edit: displayName, bio, city, state, portfolioUrl, hourlyRate, and specialties
  - PATCH /api/photographers/me endpoint for saving profile updates
  - HourlyRate properly converted between dollars (UI) and cents (database)
  - Specialties selection via clickable badges (Portraits, Weddings, Events, etc.)
- **Fixed isPhotographer Flag Detection**
  - /api/auth/user endpoint now checks photographers table if isPhotographer isn't set on user
  - Ensures photographers are correctly identified even after database migrations
  - Session properly stores photographerId for authenticated photographers
- **Photographer Dual Pricing Model**
  - Services now support two pricing models: "hourly" (e.g., $150/hr) and "package" (e.g., $600 for 3 hours)
  - Schema updated with `pricingModel`, `hourlyRateCents`, `packageHours` columns in `photographer_services` table
  - Create/edit service dialog lets photographers choose pricing model and enter appropriate values
  - Service display shows pricing correctly: "$X/hr" for hourly or "$Y for Xhr(s)" for packages
  - API endpoints updated to persist and return all pricing fields
- **Role-Aware Navigation for Photographers**
  - BottomNav component shows different tabs based on user role (customer, vendor, photographer)
  - Photographers see: Dashboard, Post, Home, Search, Messages tabs
  - "Post" tab leads to a dedicated create-post page where photographers can share updates
- **Collaboration Feature**
  - "Collaborate" button appears on business pages when viewed by a photographer
  - Clicking opens messages with the business to discuss collaborations
  - Photographers and businesses can both post to the main feed
- **Points/Loyalty System Hidden for Photographers**
  - Photographers don't earn/see loyalty points (they earn income from clients instead)
  - Profile page hides "My Points" menu and LoyaltyPointsCard for photographers
  - Cart drawer shows 0 points balance for photographers
- **Create Post Page**
  - New dedicated page at `/create-post` for creating feed posts
  - Supports all user types: customers, vendors, photographers
  - Role-aware UI descriptions and placeholder text
- **Photographer Custom Services System**
  - Added `photographer_services` table to support custom services with flexible pricing (fixed price or "contact for pricing")
  - Enhanced `shoot_bookings` table with `serviceId`, `locationDetails`, and `specialRequests` columns
  - Photographer dashboard now has tabs for "Bookings" and "My Services"
  - Bookings display shows customer name, email, service type, location, and special requests
  - Photographers can create, edit, and delete custom services (e.g., wedding photography, studio shoots, music video cinematography)
  - Each service can have: name, description, category, price (or contact for pricing), and estimated duration
  - New `PhotographerBookingDialog` component for customers to book photography sessions
  - Customer booking flow: Select Service → Choose Date/Time → Enter Location & Special Requests
  - API endpoint `POST /api/bookings/photographer` for creating bookings with all new fields
  - `GET /api/photographers/:id/services` returns public services for a photographer
- **Fixed subscription tier selection bug in vendor signup**
  - Changed `updateField` function to use functional state update pattern: `setFormData(prev => ({ ...prev, [field]: value }))`
  - Changed tier card onClick to update both selectedTierId and acceptedSubscription in a single setFormData call
  - This fixes React state batching issue where successive state updates using stale closure would overwrite each other
- **Fixed signup functionality for all user types (customer, vendor, photographer)**
  - Added "What You Offer" step to vendor signup (step 3) allowing businesses to choose: products, services, or both
  - The offerType selection maps to hasProducts/hasServices boolean fields in the business record
  - Fixed createBusiness storage function to include hasProducts and hasServices fields
  - Fixed photographers table by adding missing `specialties` column
  - Fixed photographers table by dropping NOT NULL constraint on `stripe_account_id` (nullable during signup, filled during Stripe onboarding)
  - Vendor signup now has 7 steps: Account → Business Info → What You Offer → Business Details → Location → Online Presence → Subscription
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