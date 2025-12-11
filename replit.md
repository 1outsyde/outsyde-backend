# Outsyde - Social Marketplace Platform

## Overview
Outsyde is a social marketplace platform connecting customers with local small businesses. It features customizable vendor storefronts, service booking, real-time chat, loyalty rewards, and a social media-style discovery feed with location-based browsing.

## Current State
The MVP includes:
- Dual authentication system (session-based for web, JWT for mobile apps)
- Customer signup with demographics and optional industry/niche preferences
- Vendor signup with business details, startup status, and $40/month subscription acknowledgment
- Search page with major city discovery boxes for travelers
- PostgreSQL database with Drizzle ORM for data persistence
- Secure password hashing with bcrypt
- Mobile API documentation for native app developers
- **Stripe Connect** integration for marketplace payments (stripe-replit-sync)
- **Verified Reviews** - only customers with completed bookings/orders can leave reviews
- **Real-time Chat** - WebSocket-based messaging between customers and businesses
- **Outsyde Points** - Loyalty rewards system ($1 = 100 points, redeemable at any business)

## Project Architecture

### Backend (Express + TypeScript)
- `server/index.ts` - Express server with session middleware and database seeding
- `server/routes.ts` - API routes for auth, businesses, cities, user preferences, reviews, Stripe, chat
- `server/auth.ts` - JWT token generation/verification for mobile apps
- `server/storage.ts` - DatabaseStorage class with PostgreSQL via Drizzle ORM
- `server/db.ts` - Drizzle database client configuration
- `server/websocket.ts` - WebSocket server for real-time chat messaging
- `server/stripe/` - Stripe Connect integration (stripeClient.ts, stripeService.ts, webhookHandlers.ts)
- `server/Photographers/` - Photographer business routes and types

### Frontend (React + Vite)
- `client/src/pages/` - Page components (home, search, auth, profile, messages)
- `client/src/components/` - Reusable UI components
- `client/src/lib/queryClient.ts` - TanStack Query configuration

### Shared
- `shared/schema.ts` - Drizzle schemas and Zod validation for users, businesses, cities

### Documentation
- `docs/MOBILE_API.md` - Complete mobile API reference with examples for iOS, Android, React Native

## API Endpoints

### Web Authentication (Session-based)
- `POST /api/auth/customer/signup` - Customer registration
- `POST /api/auth/vendor/signup` - Vendor registration
- `POST /api/auth/login` - User login (email/password)
- `POST /api/auth/logout` - User logout
- `GET /api/auth/me` - Get current user

### OAuth Authentication (Replit Auth / Google)
- `GET /api/login` - Initiates OAuth flow (redirects to Replit Auth)
- `GET /api/callback` - OAuth callback handler
- `GET /api/logout` - Logs out OAuth user
- `GET /api/auth/user` - Get current OAuth user info

### Mobile Authentication (JWT-based) - /api/v1/
- `POST /api/v1/auth/customer/signup` - Customer registration (returns tokens)
- `POST /api/v1/auth/vendor/signup` - Vendor registration (returns tokens)
- `POST /api/v1/auth/login` - Login (returns accessToken + refreshToken)
- `POST /api/v1/auth/refresh` - Refresh expired access token
- `GET /api/v1/auth/me` - Get current user (requires Bearer token)

### Businesses
- `GET /api/businesses` - List businesses with optional city/category/search filters
- `GET /api/businesses/:id` - Get single business
- `PATCH /api/businesses/:id` - Update business (vendor only)

### Cities
- `GET /api/cities` - List all major cities for discovery
- `GET /api/cities/:id` - Get single city

### User Preferences
- `PATCH /api/users/preferences` - Update industry/niche preferences

### Stripe Payments
- `GET /api/stripe/config` - Get Stripe publishable key
- `GET /api/stripe/products` - Get products with prices
- `POST /api/stripe/checkout/subscription` - Create vendor subscription checkout

### Verified Reviews
- `GET /api/reviews/:targetType/:targetId` - Get reviews for a business/photographer
- `GET /api/reviews/reviewable` - Get bookings the current user can review
- `POST /api/reviews` - Create a verified review (requires completed booking/order)
- `GET /api/reviews/can-review/:bookingType/:bookingId` - Check if booking can be reviewed

### Real-time Chat
- `GET /api/conversations` - Get user's conversations
- `POST /api/conversations` - Create or find conversation with another user
- `GET /api/conversations/:id/messages` - Get messages in a conversation
- `POST /api/conversations/:id/messages` - Send a message (REST fallback)
- `GET /api/messages/unread-count` - Get unread message count
- WebSocket endpoint: `/ws` - Real-time messaging with JWT auth

### Outsyde Points (Loyalty System)
- `GET /api/points/balance` - Get user's points balance and dollar value
- `GET /api/points/history` - Get user's points transaction history
- `POST /api/points/calculate` - Preview points redemption value
- `POST /api/points/redeem` - Redeem points for discount
- `POST /api/points/earn` - Earn points (called after completed payment)

## Key Features

### Dual Authentication System
- **Web (Session-based)**: Uses express-session with PostgreSQL-backed sessions (connect-pg-simple)
- **Mobile (JWT-based)**: Uses accessToken (1hr) + refreshToken (7 days)
- **Google OAuth**: Via Replit Auth (OpenID Connect) - supports Google, GitHub, Apple, and email/password
- Passwords securely hashed with bcrypt (10 rounds)
- OAuth users have nullable password field, identified by isOAuthUser flag
- Sessions stored securely in PostgreSQL database

### Customer Signup (6 steps)
1. Account info (name, email, password)
2. Location (address, city, state, zip)
3. Demographics (age, gender, ethnicity)
4. Industry interests (optional - 8 industries to choose from)
5. Preferences & Values (optional - specific preferences AND value priorities per industry)
6. Completion

Note: The preferences step now includes both niche types (e.g., Italian, BBQ, Mexican for food) AND value priorities (e.g., taste, presentation, service, hospitality). This helps match customers with businesses that align with what matters most to them.

**Value options per industry:**
- Food: taste, presentation, service, hospitality, ambiance, value, speed, authenticity
- Clothing: quality, style, sustainability, price, variety, fit, customer_service
- Beauty: expertise, hygiene, trendy, relaxation, personalization, products, punctuality
- Fitness: expertise, equipment, atmosphere, community, cleanliness, results
- Home: craftsmanship, design, timeliness, communication, value, professionalism
- Health: knowledge, availability, communication, empathy, holistic, reliability
- Pet: gentleness, expertise, facility, communication, flexibility, transparency
- Auto: transparency, expertise, timeliness, warranty, convenience, fair_pricing

### Vendor Signup (6 steps)
1. Account info
2. Business info (name, category, description)
3. Business details (startup status, years in business, employees, structure)
4. Location (physical store vs online-only)
5. Online presence (website, social media)
6. Subscription confirmation ($40/month) - stored as subscriptionAcknowledged

### Search Page
- Major city discovery boxes (NYC, Atlanta, Miami, LA, Chicago, Houston, Dallas, DC)
- Category filtering
- Search functionality
- Business cards with ratings and descriptions

## Database Schema

### Users
- id (UUID), email, password (bcrypt hash), name, phone
- isVendor flag
- Location fields (address, city, state, zipCode)
- Demographics (ageRange, gender, ethnicity, etc.)
- Preferences (selectedIndustries[], industryNiches{})

### Businesses
- id (UUID), ownerId (FK to users), name, category, description
- Business details (isStartup, yearsInBusiness, numberOfEmployees, businessStructure)
- Location fields (hasPhysicalLocation, address, city, state, zipCode)
- Online presence (websiteUrl, socialMedia{})
- Stats (rating, reviewCount)
- subscriptionActive, subscriptionAcknowledged flags

### Cities
- id, name, state
- businessCount, imageUrl, trending

### Conversations
- id (UUID), participant1Id (FK to users), participant2Id (FK to users)
- lastMessageAt, lastMessagePreview, createdAt

### Messages
- id (UUID), conversationId (FK to conversations), senderId (FK to users)
- content, isRead, readAt, createdAt

### Reviews (verified)
- id (UUID), reviewerId (FK to users), targetType (photographer/business/service_business)
- targetId (FK to target), bookingType (shoot_booking/appointment/order)
- bookingId (FK to specific booking/order), rating (1-5), comment
- createdAt timestamp for ordering

### Point Transactions (loyalty system)
- id (UUID), userId (FK to users), type (earn/redeem)
- points (amount earned or redeemed)
- dollarAmountCents (transaction amount or discount applied)
- businessId, businessName (optional business reference)
- referenceType, referenceId (optional order/booking reference)
- balanceAfter (user's balance after transaction)
- description, createdAt

### Users (loyalty fields)
- loyaltyPoints (integer, default 0) - current points balance

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Session encryption key
- `JWT_SECRET` - JWT signing key (defaults to SESSION_SECRET)

## Recent Changes
- Implemented JWT authentication for mobile apps (/api/v1/ endpoints)
- Connected to PostgreSQL database with Drizzle ORM
- Added bcrypt password hashing (replaced insecure base64)
- Fixed vendor signup to persist subscriptionAcknowledged
- Added token refresh endpoint for mobile sessions with secure token rotation
- Refresh tokens stored in database with hashing, single-use rotation
- All login/signup endpoints revoke existing tokens before issuing new ones
- Periodic cleanup of expired refresh tokens (hourly)
- Created comprehensive mobile API documentation
- Database auto-seeds with demo data on startup
- **Stripe Connect** integrated with stripe-replit-sync managing schema automatically
- **Verified Reviews** implemented - only customers with completed bookings can review
- Reviews table added with booking verification fields
- Stripe routes for checkout and subscription management
- **Real-time Chat** implemented with WebSocket server
- Chat database tables (conversations, messages) with read tracking
- REST API endpoints for chat history and conversation management
- WebSocket integrated with JWT authentication for mobile apps
- Frontend chat UI with conversation list and message interface
- **Chat location updated** - Chat now ONLY available in vendor detail pages via Chat tab
  - BusinessCard shows Book/Shop CTAs based on hasServices/hasProducts (no Chat button)
  - VendorStorefront has embedded Chat tab with full messaging interface
  - VendorChat component handles auth checking and conversation creation
- **Outsyde Points** loyalty rewards system implemented
  - Database: pointTransactions table, users.loyaltyPoints field
  - Conversion: $1 spent = 100 points earned, 100 points = $1 discount
  - Storage methods: earnPoints, redeemPoints, getUserPointsBalance, getPointTransactions
  - API endpoints for balance, history, calculate, redeem, and earn
  - Frontend: LoyaltyPointsCard component, PointsHistory component
  - Profile page updated with "My Points" section showing balance and transaction history
  - Stripe webhook integration: Points automatically awarded on checkout completion
- **Referral System** implemented
  - Users can earn 500 points ($5 value) for each friend they refer
  - New users get 200 bonus points ($2 value) when joining via referral
  - Each user gets a unique 8-character referral code
  - Database: users.referralCode, users.referredBy fields
  - API endpoints: GET /api/referral/code, POST /api/referral/apply
  - Frontend: ReferralCard component in profile "My Points" section
- **Push Notifications** for cart abandonment reminders
  - Service worker (`public/sw.js`) handles push events
  - VAPID keys for secure browser push notifications
  - Database: pushSubscriptions table for subscription storage
  - API endpoints: POST /api/push/subscribe, DELETE /api/push/unsubscribe
  - Frontend: PushNotificationSettings component in profile page
  - Automated scheduler sends reminders every 30 minutes for abandoned carts (24+ hours)
- **Database-backed Shopping Cart**
  - Database: cartItems table for authenticated users
  - Falls back to localStorage for guest users
  - API endpoints: GET /api/cart, POST /api/cart/add, PATCH /api/cart/:id, DELETE /api/cart/:id
  - Frontend: useCart hook manages cart state with persistence

## User Preferences
- Golden yellow color scheme for branding
- Modern, social media-inspired UI
- Inter/DM Sans/Poppins font family
