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

## Project Architecture

### Backend (Express + TypeScript)
- `server/index.ts` - Express server with session middleware and database seeding
- `server/routes.ts` - API routes for auth, businesses, cities, user preferences
- `server/auth.ts` - JWT token generation/verification for mobile apps
- `server/storage.ts` - DatabaseStorage class with PostgreSQL via Drizzle ORM
- `server/db.ts` - Drizzle database client configuration

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
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `GET /api/auth/me` - Get current user

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

## Key Features

### Dual Authentication System
- **Web (Session-based)**: Uses express-session with httpOnly cookies
- **Mobile (JWT-based)**: Uses accessToken (1hr) + refreshToken (7 days)
- Passwords securely hashed with bcrypt (10 rounds)

### Customer Signup (7 steps)
1. Account info (name, email, password)
2. Location (address, city, state, zip)
3. Demographics (age, gender, ethnicity, nationality)
4. Lifestyle (household size, income, education, occupation)
5. Industry interests (optional - 8 industries to choose from)
6. Niche preferences (optional - specific preferences per industry)
7. Completion

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

## User Preferences
- Purple/violet color scheme for branding
- Modern, social media-inspired UI
- Inter/DM Sans/Poppins font family
