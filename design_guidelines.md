# Outsyde Design Guidelines

## Design Approach
**Reference-Based Approach** drawing from Instagram (social feed), Airbnb (local discovery), and Etsy (small business marketplace). The design prioritizes visual discovery, engagement, and seamless transitions between social browsing and commerce.

## Typography System
- **Primary Font**: Inter or DM Sans (Google Fonts) - clean, modern sans-serif
- **Accent Font**: Poppins for headlines and brand elements - friendly, approachable
- **Hierarchy**:
  - Hero Headlines: text-5xl md:text-6xl font-bold
  - Section Headers: text-3xl md:text-4xl font-semibold
  - Card Titles: text-xl font-semibold
  - Body Text: text-base (16px)
  - Captions/Metadata: text-sm

## Layout System
**Spacing Primitives**: Use Tailwind units of 2, 4, 6, 8, 12, 16, 20, 24
- Tight spacing: p-2, gap-2 (UI elements, tags)
- Standard spacing: p-4, gap-4 (card internals, form fields)
- Section padding: py-12 md:py-16 lg:py-20
- Container max-width: max-w-7xl

## Core Pages & Layouts

### Homepage - Social Feed
**Layout**: Single-column feed (max-w-2xl mx-auto) with infinite scroll
- Hero Section (60vh): Location-aware welcome with blurred background image showing local community, centered overlay with "Discover Local Businesses Near You" and location input
- Feed Container: Cards with 4:3 aspect ratio images, business name, category tags, preview text, engagement metrics (likes, comments)
- Sticky Navigation: Top bar with logo, search, messages, profile icons
- Floating Action: Bottom-right "+" button for businesses to create posts

### Vendor Storefront Pages
**Layout**: Full-width customizable with sections
- Hero: Custom banner image (16:9) with business logo overlay (bottom-left), business name, category, location
- Navigation Tabs: About | Products | Services | Book | Reviews (sticky below hero)
- Content Area: Multi-column grid for products (grid-cols-2 lg:grid-cols-3) with image cards
- Sidebar (lg): Quick actions - Message Business, Share, Follow
- Booking Section: Integrated calendar component with time slots

### Customer Dashboard
**Layout**: Two-column (sidebar + main content)
- Left Sidebar (w-64): Profile, Loyalty Points (prominent display), My Bookings, Orders, Messages, Settings
- Main Content: Activity feed or selected section content
- Points Display: Card showing current points, tier progress bar, next reward milestone

### Vendor Dashboard
**Layout**: Grid-based responsive layout
- Top Stats Bar: Revenue, Active Bookings, Messages, Products/Services (grid-cols-4)
- Main Grid (grid-cols-1 lg:grid-cols-3 gap-6):
  - Recent Orders (col-span-2)
  - Quick Actions
  - Analytics Chart
  - Customer Messages

## Component Library

### Navigation
- **Top Bar**: h-16, flex items-center justify-between, backdrop-blur-sm, sticky top-0
- **Mobile Menu**: Slide-in drawer from left, full-height overlay

### Cards - Business/Product
- **Structure**: Rounded-xl, overflow-hidden, shadow-sm hover:shadow-md transition
- **Image**: aspect-[4/3] object-cover
- **Content**: p-4 with gap-2 stack
- **Actions**: Absolute top-right heart icon, bottom quick-view button

### Feed Posts
- **Container**: rounded-2xl, p-6, mb-6, shadow-sm
- **Header**: Business avatar (w-12 h-12), name, timestamp, follow button
- **Image/Media**: rounded-xl, max-h-96, object-cover
- **Engagement Bar**: flex justify-between, pt-4, border-t
- **Comments**: Collapsible section, max 3 visible initially

### Booking Calendar
- **Layout**: Grid-based month view
- **Time Slots**: Pill-shaped buttons (rounded-full px-4 py-2)
- **Selected State**: Prominent visual distinction
- **Confirmation Panel**: Sticky bottom bar on mobile, sidebar on desktop

### Chat Interface
- **Layout**: Full-height split (conversations list | active chat)
- **Messages**: Bubble style with sender-right recipient-left alignment
- **Input**: Sticky bottom bar with text input, emoji, attachment icons
- **Online Status**: Green dot indicator on avatars

### Loyalty Points Display
- **Card**: Gradient background, rounded-2xl, p-6
- **Points**: Extra large number (text-6xl font-bold)
- **Progress**: Circular or linear progress indicator
- **Rewards Preview**: Carousel of available redemptions

### Forms
- **Input Fields**: h-12, rounded-lg, px-4, border focus:ring-2 transition
- **Demographic Fields** (Signup): Step-by-step multi-screen flow
  - Screen 1: Basic (Name, Email, Password)
  - Screen 2: Location (Address, Radius preference)
  - Screen 3: Demographics (Optional but encouraged)
  - Screen 4: Interests (Business categories)
- **Labels**: text-sm font-medium, mb-2
- **Buttons**: h-12, rounded-lg, px-8, font-semibold

### Search & Filters
- **Search Bar**: Prominent, rounded-full, h-14, with icon-left design
- **Filter Chips**: Horizontal scroll, rounded-full pills, gap-2
- **Advanced Filters**: Modal or slide-over panel with sections

## Interaction Patterns
- **Animations**: Minimal - fade-in on scroll, smooth transitions (duration-200)
- **Hover States**: Subtle scale (hover:scale-105) for cards, shadow increase
- **Loading States**: Skeleton screens matching content structure
- **Empty States**: Illustrative with clear CTAs

## Images Strategy
**Critical Image Placements**:
1. **Homepage Hero**: Vibrant community/local business collage, warm and inviting
2. **Business Cards**: Product/service photos, professional quality
3. **Vendor Banners**: Custom uploaded by businesses, 16:9 ratio
4. **Feed Posts**: Mixed media from businesses - products, behind-scenes, promotions
5. **Avatars**: Circular, consistent sizing (w-10 h-10 for small, w-16 h-16 for large)

**Image Treatment**: Rounded corners throughout (rounded-lg for cards, rounded-xl for hero sections), subtle overlay on hero images with blurred button backgrounds for text/CTA readability.

## Responsive Strategy
- **Mobile-First**: Stack all multi-column layouts to single column
- **Breakpoints**: 
  - Base: Single column, bottom navigation
  - md (768px): Two columns where appropriate
  - lg (1024px): Full layouts with sidebars
- **Touch Targets**: Minimum h-12 for all interactive elements

## Key Design Principles
1. **Discovery-Focused**: Visual-first, minimal friction to explore
2. **Business Empowerment**: Storefronts feel authentic and customizable
3. **Trust & Community**: Warm, approachable, celebrating local businesses
4. **Seamless Commerce**: Integrated shopping without leaving the experience