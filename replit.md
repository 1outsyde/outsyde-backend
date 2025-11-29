# Outsyde - Social Marketplace Platform

## Overview
Outsyde is a social marketplace platform connecting customers with local small businesses. It features customizable vendor storefronts, service booking, real-time chat, loyalty rewards, and a social media-style discovery feed with location-based browsing.

## Current State
The MVP includes:
- Customer and vendor authentication with comprehensive signup flows
- Customer signup with demographics and optional industry/niche preferences for personalized recommendations
- Vendor signup with business details, startup status, and $40/month subscription acknowledgment
- Search page with major city discovery boxes for travelers
- Backend APIs for users, businesses, and cities

## Project Architecture

### Backend (Express + TypeScript)
- `server/index.ts` - Express server with session middleware
- `server/routes.ts` - API routes for auth, businesses, cities, and user preferences
- `server/storage.ts` - In-memory storage with seeded cities and sample businesses

### Frontend (React + Vite)
- `client/src/pages/` - Page components (home, search, auth, profile, messages)
- `client/src/components/` - Reusable UI components
- `client/src/lib/queryClient.ts` - TanStack Query configuration

### Shared
- `shared/schema.ts` - Drizzle schemas and Zod validation for users, businesses, cities

## API Endpoints

### Authentication
- `POST /api/auth/customer/signup` - Customer registration with demographics and preferences
- `POST /api/auth/vendor/signup` - Vendor registration with business info and subscription
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `GET /api/auth/me` - Get current user

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
6. Subscription confirmation ($40/month)

### Search Page
- Major city discovery boxes (NYC, Atlanta, Miami, LA, Chicago, Houston, Dallas, DC)
- Category filtering
- Search functionality
- Business cards with ratings and descriptions

## Database Schema

### Users
- id, email, password, name, phone
- isVendor flag
- Location fields (address, city, state, zipCode)
- Demographics (ageRange, gender, ethnicity, etc.)
- Preferences (selectedIndustries, industryNiches)

### Businesses
- id, ownerId, name, category, description
- Business details (isStartup, yearsInBusiness, etc.)
- Location fields
- Online presence (websiteUrl, socialMedia)
- Stats (rating, reviewCount)
- subscriptionActive flag

### Cities
- id, name, state
- businessCount, imageUrl, trending

## Recent Changes
- Added comprehensive customer signup with industry preferences
- Added vendor signup with startup status and subscription flow
- Added major city discovery on search page
- Connected frontend forms to backend APIs
- Added session-based authentication

## User Preferences
- Purple/violet color scheme for branding
- Modern, social media-inspired UI
- Inter/DM Sans/Poppins font family
