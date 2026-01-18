import {
  pgTable, text, varchar, boolean, integer, jsonb, timestamp, index, doublePrecision, unique
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

/* =====================================================
   SESSIONS (Auth)
===================================================== */
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (t) => [index("IDX_session_expire").on(t.expire)]
);

/* =====================================================
   BILLING ADDRESS TYPE
===================================================== */
export interface BillingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/* =====================================================
   BUSINESS HOURS TYPES
===================================================== */
export interface DayHours {
  open: string;
  close: string;
  closed?: boolean;
}

export interface HoursOfOperation {
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
}

/* =====================================================
   USERS
===================================================== */
export const users = pgTable("users", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").unique(),
  password: text("password"),
  name: text("name"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  phone: text("phone"),
  profileImageUrl: text("profile_image_url"),

  isVendor: boolean("is_vendor").default(false).notNull(),
  isPhotographer: boolean("is_photographer").default(false).notNull(),
  isInfluencer: boolean("is_influencer").default(false).notNull(),
  isAdmin: boolean("is_admin").default(false).notNull(),
  isOAuthUser: boolean("is_oauth_user").default(false),

  // Google OAuth sub (unique identifier from Google)
  googleSub: text("google_sub").unique(),

  // Monetization intent (user-controlled via API)
  wantsToSellProducts: boolean("wants_to_sell_products").default(false).notNull(),
  wantsToOfferServices: boolean("wants_to_offer_services").default(false).notNull(),
  wantsToPromoteAsInfluencer: boolean("wants_to_promote_as_influencer").default(false).notNull(),

  // Monetization permission (system-controlled, requires approval)
  canMonetize: boolean("can_monetize").default(false).notNull(),

  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),

  billingAddress: jsonb("billing_address").$type<BillingAddress>(),

  username: text("username").unique(),
  dateOfBirth: timestamp("date_of_birth"),
  gender: text("gender"),
  ethnicity: text("ethnicity"),
  nationality: text("nationality"),
  householdSize: text("household_size"),
  incomeRange: text("income_range"),
  education: text("education"),
  occupation: text("occupation"),
  shoppingFrequency: text("shopping_frequency"),

  selectedIndustries: jsonb("selected_industries").$type<string[]>().default([]),
  industryNiches: jsonb("industry_niches").$type<Record<string, string[]>>().default({}),
  industryValues: jsonb("industry_values").$type<Record<string, string[]>>().default({}),

  loyaltyPoints: integer("loyalty_points").default(0).notNull(),

  referralCode: text("referral_code").unique(),
  referredBy: varchar("referred_by", { length: 36 }),

  // Stripe customer ID for checkout (not connected account - that's on business/photographer)
  stripeCustomerId: text("stripe_customer_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   CITIES
===================================================== */
export const cities = pgTable("cities", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  businessCount: integer("business_count").default(0),
  imageUrl: text("image_url"),
  trending: boolean("trending").default(false),
});

/* =====================================================
   REFRESH TOKENS
===================================================== */
export const refreshTokens = pgTable("refresh_tokens", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
});

/* =====================================================
   BUSINESSES
===================================================== */
export const businesses = pgTable("businesses", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  ownerId: varchar("owner_id", { length: 36 }).notNull().references(() => users.id),

  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description"),

  isStartup: boolean("is_startup").default(false),
  yearsInBusiness: text("years_in_business"),
  employeeCount: text("employee_count"),
  businessType: text("business_type"),

  hasPhysicalLocation: boolean("has_physical_location").default(true),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),

  websiteUrl: text("website_url"),
  socialMedia: text("social_media"),

  coverImage: text("cover_image"),
  logoImage: text("logo_image"),

  rating: integer("rating").default(0),
  reviewCount: integer("review_count").default(0),

  subscriptionActive: boolean("subscription_active").default(false),

  tagline: text("tagline"),
  hoursOfOperation: jsonb("hours_of_operation").$type<{
    monday?: { open: string; close: string; closed?: boolean };
    tuesday?: { open: string; close: string; closed?: boolean };
    wednesday?: { open: string; close: string; closed?: boolean };
    thursday?: { open: string; close: string; closed?: boolean };
    friday?: { open: string; close: string; closed?: boolean };
    saturday?: { open: string; close: string; closed?: boolean };
    sunday?: { open: string; close: string; closed?: boolean };
  }>(),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  brandColors: jsonb("brand_colors").$type<{ primary?: string; secondary?: string }>(),
  knownFor: jsonb("known_for").$type<string[]>().default([]),

  hasProducts: boolean("has_products").default(false),
  hasServices: boolean("has_services").default(false),

  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false),
  stripeOnboardingUrl: text("stripe_onboarding_url"),

  billingAddress: jsonb("billing_address").$type<BillingAddress>(),

  // Approval workflow: pending (new applications), approved, rejected
  approvalStatus: text("approval_status").default("pending").notNull(),
  approvalNotes: text("approval_notes"),
  approvedAt: timestamp("approved_at"),
  approvedBy: varchar("approved_by", { length: 36 }),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   VENDOR PRODUCTS
===================================================== */
export const vendorProducts = pgTable("vendor_products", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),

  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(),
  compareAtPrice: integer("compare_at_price"),

  imageUrl: text("image_url"),
  images: jsonb("images").$type<string[]>().default([]),

  category: text("category"),
  tags: text("tags").array(),

  inventory: integer("inventory").default(0),
  trackInventory: boolean("track_inventory").default(true),

  isActive: boolean("is_active").default(true),
  isFeatured: boolean("is_featured").default(false),

  // Publishing status: draft (default) | live | archived
  status: text("status").default("draft").notNull(),
  // Stripe catalog IDs - populated when item goes live
  stripeProductId: text("stripe_product_id"),
  stripePriceId: text("stripe_price_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   VENDOR SERVICES
===================================================== */
export const vendorServices = pgTable("vendor_services", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),

  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),

  category: text("category"),

  isActive: boolean("is_active").default(true),
  isFeatured: boolean("is_featured").default(false),

  // Publishing status: draft (default) | live | archived
  status: text("status").default("draft").notNull(),
  // Stripe catalog IDs - populated when item goes live
  stripeProductId: text("stripe_product_id"),
  stripePriceId: text("stripe_price_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   BUSINESS AVAILABILITY (Date-specific time slots)
===================================================== */
export const businessAvailability = pgTable("business_availability", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),

  date: text("date").notNull(), // Format: YYYY-MM-DD
  startTime: text("start_time").notNull(), // Format: HH:MM (24hr)
  endTime: text("end_time").notNull(), // Format: HH:MM (24hr)

  slotType: text("slot_type").default("available"), // 'available' | 'blocked' | 'booked' | 'special'
  title: text("title"), // Optional title for the slot (e.g., "Holiday Hours", "Closed for Vacation")
  notes: text("notes"), // Optional notes

  // Booking reference - when a slot is booked, this links to the appointment
  appointmentId: varchar("appointment_id", { length: 36 }),

  isRecurring: boolean("is_recurring").default(false),
  recurringDayOfWeek: integer("recurring_day_of_week"), // 0 = Sunday, 6 = Saturday (only if isRecurring)

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   STAFF MEMBERS (Team Members for Businesses)
===================================================== */
export const staffMembers = pgTable("staff_members", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  userId: varchar("user_id", { length: 36 }).references(() => users.id), // Optional - linked if staff has their own account
  
  // Staff profile info (can be set by owner even without linked user)
  displayName: text("display_name").notNull(),
  bio: text("bio"),
  profileImageUrl: text("profile_image_url"),
  phone: text("phone"),
  email: text("email"),
  
  // Services this staff member can perform (references vendorServices ids)
  serviceIds: jsonb("service_ids").$type<string[]>().default([]),
  
  // Specialties/skills (e.g., "Fades", "Color", "Braids")
  specialties: text("specialties").array(),
  
  // Staff role: 'staff' (regular) | 'manager' (can see team stats) | 'owner' (full access)
  role: text("role").default("staff").notNull(),
  
  // Status: 'active' | 'inactive' | 'pending' (invited but not accepted)
  status: text("status").default("active").notNull(),
  
  // Rating/reviews for this staff member
  rating: integer("rating").default(0),
  reviewCount: integer("review_count").default(0),
  
  // Stripe Connect for direct payouts
  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false),
  stripeOnboardingUrl: text("stripe_onboarding_url"),
  
  // Staff hours (can be different from business hours)
  hoursOfOperation: jsonb("hours_of_operation").$type<HoursOfOperation>(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   STAFF AVAILABILITY (Per-Staff Time Slots)
===================================================== */
export const staffAvailability = pgTable("staff_availability", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  staffMemberId: varchar("staff_member_id", { length: 36 }).notNull().references(() => staffMembers.id),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  
  date: text("date").notNull(), // Format: YYYY-MM-DD
  startTime: text("start_time").notNull(), // Format: HH:MM (24hr)
  endTime: text("end_time").notNull(), // Format: HH:MM (24hr)
  
  slotType: text("slot_type").default("available"), // 'available' | 'blocked' | 'booked' | 'break'
  title: text("title"), // Optional title
  notes: text("notes"), // Optional notes
  
  // Booking reference - when a slot is booked, this links to the appointment
  appointmentId: varchar("appointment_id", { length: 36 }),
  
  isRecurring: boolean("is_recurring").default(false),
  recurringDayOfWeek: integer("recurring_day_of_week"), // 0 = Sunday, 6 = Saturday
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   STAFF INVITES (Invitation System)
===================================================== */
export const staffInvites = pgTable("staff_invites", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  
  // Either email-based invite or invite code
  email: text("email"),
  inviteCode: text("invite_code").unique(),
  
  // Pre-filled staff info
  displayName: text("display_name"),
  role: text("role").default("staff"),
  
  // Status: 'pending' | 'accepted' | 'expired' | 'cancelled'
  status: text("status").default("pending").notNull(),
  
  invitedByUserId: varchar("invited_by_user_id", { length: 36 }).references(() => users.id),
  acceptedByUserId: varchar("accepted_by_user_id", { length: 36 }).references(() => users.id),
  
  expiresAt: timestamp("expires_at"),
  acceptedAt: timestamp("accepted_at"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   PHOTOGRAPHERS
===================================================== */
export const photographers = pgTable("photographers", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),

  displayName: text("display_name").notNull(),
  bio: text("bio"),
  city: text("city"),
  state: text("state"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  portfolioUrl: text("portfolio_url"),

  hourlyRate: integer("hourly_rate").notNull(),

  rating: integer("rating").default(0),
  reviewCount: integer("review_count").default(0),

  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false),
  stripeOnboardingUrl: text("stripe_onboarding_url"),
  specialties: text("specialties").array(),

  // Storefront customization
  coverImage: text("cover_image"),
  logoImage: text("logo_image"),
  brandColors: jsonb("brand_colors").$type<{ primary?: string; secondary?: string }>(),

  hoursOfOperation: jsonb("hours_of_operation").$type<{
    monday?: { open: string; close: string; closed?: boolean };
    tuesday?: { open: string; close: string; closed?: boolean };
    wednesday?: { open: string; close: string; closed?: boolean };
    thursday?: { open: string; close: string; closed?: boolean };
    friday?: { open: string; close: string; closed?: boolean };
    saturday?: { open: string; close: string; closed?: boolean };
    sunday?: { open: string; close: string; closed?: boolean };
  }>(),

  billingAddress: jsonb("billing_address").$type<BillingAddress>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   PHOTOGRAPHER AVAILABILITY (Date-specific time slots)
===================================================== */
export const photographerAvailability = pgTable("photographer_availability", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  photographerId: varchar("photographer_id", { length: 36 }).notNull().references(() => photographers.id),

  date: text("date").notNull(), // Format: YYYY-MM-DD
  startTime: text("start_time").notNull(), // Format: HH:MM (24hr)
  endTime: text("end_time").notNull(), // Format: HH:MM (24hr)

  slotType: text("slot_type").default("available"), // 'available' | 'blocked' | 'booked'
  title: text("title"), // Optional title for the slot
  notes: text("notes"), // Optional notes

  // Booking reference - when a slot is booked, this links to the shoot booking
  shootBookingId: varchar("shoot_booking_id", { length: 36 }),

  isRecurring: boolean("is_recurring").default(false),
  recurringDayOfWeek: integer("recurring_day_of_week"), // 0 = Sunday, 6 = Saturday

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   PHOTOGRAPHER SERVICES
===================================================== */
export const photographerServices = pgTable("photographer_services", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  photographerId: varchar("photographer_id", { length: 36 }).notNull().references(() => photographers.id),

  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),

  // Pricing model: 'hourly' = charge by hour, 'package' = flat rate for set hours
  pricingModel: text("pricing_model").default("package"), // 'hourly' | 'package'
  
  // For hourly pricing - rate per hour in cents
  hourlyRateCents: integer("hourly_rate_cents"),
  
  // For package pricing - total price for included hours in cents
  priceCents: integer("price_cents"),
  packageHours: integer("package_hours"), // How many hours included in package (e.g., "3hr car photography")
  
  isContactForPricing: boolean("is_contact_for_pricing").default(false),
  estimatedDurationMinutes: integer("estimated_duration_minutes"),

  isActive: boolean("is_active").default(true),

  // Publishing status: draft (default) | live | archived
  status: text("status").default("draft").notNull(),
  // Stripe catalog IDs - populated when item goes live (legacy: platform-owned)
  stripeProductId: text("stripe_product_id"),
  stripePriceId: text("stripe_price_id"),
  // Connected account Stripe IDs - for marketplace model (creator-owned)
  stripeConnectedProductId: text("stripe_connected_product_id"),
  stripeConnectedPriceId: text("stripe_connected_price_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   SHOOT BOOKINGS (Photographers)
===================================================== */
export const shootBookings = pgTable("shoot_bookings", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  photographerId: varchar("photographer_id", { length: 36 }).notNull().references(() => photographers.id),
  clientId: varchar("client_id", { length: 36 }).notNull().references(() => users.id),
  serviceId: varchar("service_id", { length: 36 }).references(() => photographerServices.id),

  shootType: text("shoot_type").notNull(),
  date: text("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  durationHours: integer("duration_hours").notNull(),

  locationType: text("location_type"),
  locationDetails: text("location_details"),
  specialRequests: text("special_requests"),

  totalPrice: integer("total_price").notNull(),
  platformFee: integer("platform_fee").default(0),
  vendorNet: integer("vendor_net").default(0),

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  status: text("status").default("pending"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   APPOINTMENTS (Service Bookings)
===================================================== */
export const appointments = pgTable("appointments", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  clientId: varchar("client_id", { length: 36 }).notNull().references(() => users.id),
  serviceId: varchar("service_id", { length: 36 }).notNull().references(() => vendorServices.id),
  
  // Optional staff member assignment - if set, staff gets direct payout
  staffMemberId: varchar("staff_member_id", { length: 36 }).references(() => staffMembers.id),

  appointmentDate: text("appointment_date").notNull(),
  appointmentTime: text("appointment_time").notNull(),

  totalPrice: integer("total_price").notNull(),
  platformFee: integer("platform_fee").default(0),
  vendorNet: integer("vendor_net").default(0),
  
  // Staff payout tracking (when staffMemberId is set)
  staffPayout: integer("staff_payout").default(0), // Amount going to staff Stripe account

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").default("pending"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   ORDER GROUPS (Multi-Vendor Cart Purchases)
===================================================== */
export const orderGroups = pgTable("order_groups", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  customerId: varchar("customer_id", { length: 36 }).notNull().references(() => users.id),
  
  totalVendors: integer("total_vendors").notNull(),
  completedVendors: integer("completed_vendors").default(0),
  
  status: text("status").default("pending"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   ORDERS (Product Purchases)
===================================================== */
export const orders = pgTable("orders", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  customerId: varchar("customer_id", { length: 36 }).notNull().references(() => users.id),
  
  orderGroupId: varchar("order_group_id", { length: 36 }).references(() => orderGroups.id),

  items: jsonb("items").$type<{ productId: string; name: string; quantity: number; price: number }[]>().notNull(),
  totalAmount: integer("total_amount").notNull(),
  platformFee: integer("platform_fee").default(0),
  vendorNet: integer("vendor_net").default(0),

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  status: text("status").default("pending"),

  shippingAddress: text("shipping_address"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   REVIEWS
===================================================== */
export const reviews = pgTable("reviews", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  targetType: text("target_type").notNull(),
  targetId: varchar("target_id", { length: 36 }).notNull(),

  reviewerId: varchar("reviewer_id", { length: 36 }).notNull().references(() => users.id),

  bookingType: text("booking_type").notNull(),
  bookingId: varchar("booking_id", { length: 36 }).notNull(),

  rating: integer("rating").notNull(),
  title: text("title"),
  comment: text("comment"),

  isVerified: boolean("is_verified").default(true).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   POINT TRANSACTIONS (Loyalty System)
===================================================== */
export const pointTransactions = pgTable("point_transactions", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),

  type: text("type").notNull(),
  points: integer("points").notNull(),
  dollarAmountCents: integer("dollar_amount_cents").notNull(),

  businessId: varchar("business_id", { length: 36 }),
  businessName: text("business_name"),

  referenceType: text("reference_type"),
  referenceId: varchar("reference_id", { length: 36 }),

  balanceAfter: integer("balance_after").notNull(),
  description: text("description"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   REFERRALS (Deferred Reward System)
===================================================== */
export const referrals = pgTable("referrals", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  referrerId: varchar("referrer_id", { length: 36 }).notNull().references(() => users.id),
  referredUserId: varchar("referred_user_id", { length: 36 }).notNull().references(() => users.id),

  status: text("status").notNull().default("pending"),

  referrerBonusPoints: integer("referrer_bonus_points").notNull().default(500),
  referredBonusPoints: integer("referred_bonus_points").notNull().default(250),

  referrerBonusPaidAt: timestamp("referrer_bonus_paid_at"),
  referredBonusPaidAt: timestamp("referred_bonus_paid_at"),

  firstTransactionId: varchar("first_transaction_id", { length: 36 }),
  firstTransactionType: text("first_transaction_type"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   CONVERSATIONS (Real-time Chat)
===================================================== */
export const conversations = pgTable("conversations", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  participant1Id: varchar("participant1_id", { length: 36 }).notNull().references(() => users.id),
  participant2Id: varchar("participant2_id", { length: 36 }).notNull().references(() => users.id),

  lastMessageAt: timestamp("last_message_at").defaultNow(),
  lastMessagePreview: text("last_message_preview"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   MESSAGES (Real-time Chat)
===================================================== */
export const messages = pgTable("messages", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  conversationId: varchar("conversation_id", { length: 36 }).notNull().references(() => conversations.id),
  senderId: varchar("sender_id", { length: 36 }).notNull().references(() => users.id),

  content: text("content").notNull(),

  isRead: boolean("is_read").default(false).notNull(),
  readAt: timestamp("read_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   PUSH SUBSCRIPTIONS
===================================================== */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),

  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   NOTIFICATIONS (In-app notifications)
===================================================== */
export const notifications = pgTable("notifications", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),

  type: text("type").notNull(), // booking_confirmed, payment_succeeded, payment_failed, subscription_activated, subscription_canceled, addon_charged, refund_issued, new_order, photographer_assigned
  title: text("title").notNull(),
  message: text("message").notNull(),

  referenceType: text("reference_type"), // order, booking, subscription, refund, etc.
  referenceId: varchar("reference_id", { length: 36 }),

  isRead: boolean("is_read").default(false).notNull(),
  readAt: timestamp("read_at"),

  metadata: jsonb("metadata").$type<Record<string, any>>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   FOLLOWS (Private follow relationships)
===================================================== */
export const follows = pgTable("follows", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  followerUserId: varchar("follower_user_id", { length: 36 }).notNull().references(() => users.id),
  targetUserId: varchar("target_user_id", { length: 36 }).notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_follows_follower").on(table.followerUserId),
  index("idx_follows_target").on(table.targetUserId),
  unique("follows_unique").on(table.followerUserId, table.targetUserId),
]);

/* =====================================================
   CART ITEMS
===================================================== */
export const cartItems = pgTable("cart_items", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),

  productId: varchar("product_id", { length: 36 }).notNull().references(() => vendorProducts.id),
  productName: text("product_name").notNull(),
  productImage: text("product_image"),
  priceInCents: integer("price_in_cents").notNull(),
  quantity: integer("quantity").notNull().default(1),

  businessId: varchar("business_id", { length: 36 }).references(() => businesses.id),
  businessName: text("business_name"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   SUBSCRIPTION TIERS
===================================================== */
export const subscriptionTiers = pgTable("subscription_tiers", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),

  priceInCents: integer("price_in_cents").notNull(),
  platformFeeBps: integer("platform_fee_bps").notNull(),

  features: jsonb("features").$type<string[]>().default([]),
  
  alaCarteDiscountPercent: integer("ala_carte_discount_percent").default(0).notNull(),

  stripeProductId: text("stripe_product_id"),
  stripePriceId: text("stripe_price_id"),

  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   TIER BENEFITS
===================================================== */
export const tierBenefits = pgTable("tier_benefits", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  tierId: varchar("tier_id", { length: 36 }).notNull().references(() => subscriptionTiers.id),

  benefitType: text("benefit_type").notNull(),
  benefitName: text("benefit_name").notNull(),
  description: text("description"),

  monthlyAllowance: integer("monthly_allowance"),
  isUnlimited: boolean("is_unlimited").default(false),

  cycleType: text("cycle_type").default("monthly"),
  includedQuantity: integer("included_quantity").default(0),
  
  requiresAdminFulfillment: boolean("requires_admin_fulfillment").default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   VENDOR SUBSCRIPTIONS
===================================================== */
export const vendorSubscriptions = pgTable("vendor_subscriptions", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => users.id),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  tierId: varchar("tier_id", { length: 36 }).notNull().references(() => subscriptionTiers.id),

  stripeSubscriptionId: text("stripe_subscription_id"),
  stripeCustomerId: text("stripe_customer_id"),

  status: text("status").default("active"),

  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  currentQuarterStart: timestamp("current_quarter_start"),
  currentQuarterEnd: timestamp("current_quarter_end"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   BENEFIT ALLOWANCES
===================================================== */
export const benefitAllowances = pgTable("benefit_allowances", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  subscriptionId: varchar("subscription_id", { length: 36 }).notNull().references(() => vendorSubscriptions.id),
  benefitId: varchar("benefit_id", { length: 36 }).notNull().references(() => tierBenefits.id),

  monthlyAllowance: integer("monthly_allowance").notNull(),
  usedThisMonth: integer("used_this_month").default(0),
  isUnlimited: boolean("is_unlimited").default(false),

  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),

  cycleStart: timestamp("cycle_start"),
  cycleEnd: timestamp("cycle_end"),
  isExpired: boolean("is_expired").default(false),
  expiredAt: timestamp("expired_at"),
  usedQuantity: integer("used_quantity").default(0),
  remainingQuantity: integer("remaining_quantity").default(0),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   BENEFIT USAGE
===================================================== */
export const benefitUsage = pgTable("benefit_usage", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  allowanceId: varchar("allowance_id", { length: 36 }).notNull().references(() => benefitAllowances.id),
  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => users.id),
  
  benefitType: text("benefit_type"),
  quantityUsed: integer("quantity_used").default(1),

  usedAt: timestamp("used_at").defaultNow(),
  notes: text("notes"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   FULFILLMENT TASKS
===================================================== */
export const fulfillmentTasks = pgTable("fulfillment_tasks", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => users.id),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),

  taskType: text("task_type").notNull(),
  taskName: text("task_name").notNull(),
  description: text("description"),
  
  sourceType: text("source_type"),
  sourceId: varchar("source_id", { length: 36 }),
  vendorNotes: text("vendor_notes"),

  status: text("status").default("pending"),
  priority: integer("priority").default(0),
  isPriority: boolean("is_priority").default(false),

  dueDate: timestamp("due_date"),
  completedAt: timestamp("completed_at"),

  metadata: jsonb("metadata").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   A LA CARTE SERVICES
===================================================== */
export const alaCarteServices = pgTable("ala_carte_services", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),

  basePriceInCents: integer("base_price_in_cents").notNull(),

  stripeProductId: text("stripe_product_id"),
  stripePriceId: text("stripe_price_id"),

  isActive: boolean("is_active").default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   A LA CARTE PURCHASES
===================================================== */
export const alaCartePurchases = pgTable("ala_carte_purchases", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => users.id),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  serviceId: varchar("service_id", { length: 36 }).notNull().references(() => alaCarteServices.id),

  priceInCents: integer("price_in_cents").notNull(),
  platformFeeInCents: integer("platform_fee_in_cents").notNull(),

  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),

  status: text("status").default("pending"),
  notes: text("notes"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   AVAILABILITY SLOTS (Businesses + Photographers)
===================================================== */
export const availabilitySlots = pgTable("availability_slots", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  providerType: text("provider_type").notNull(),
  providerId: varchar("provider_id", { length: 36 }).notNull(),

  dayOfWeek: integer("day_of_week").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),

  isRecurring: boolean("is_recurring").default(true),
  specificDate: text("specific_date"),

  isAvailable: boolean("is_available").default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   SCHEDULING (Unconfirmed Bookings)
===================================================== */
export const scheduling = pgTable("scheduling", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  providerType: text("provider_type").notNull(),
  providerId: varchar("provider_id", { length: 36 }).notNull(),
  clientId: varchar("client_id", { length: 36 }).notNull().references(() => users.id),

  serviceId: varchar("service_id", { length: 36 }),
  serviceName: text("service_name"),
  servicePrice: integer("service_price"),

  scheduledDate: text("scheduled_date").notNull(),
  scheduledTime: text("scheduled_time").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),

  notes: text("notes"),

  status: text("status").default("pending"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   REFUND REQUESTS
===================================================== */
export const refundRequests = pgTable("refund_requests", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  requesterId: varchar("requester_id", { length: 36 }).notNull().references(() => users.id),
  requesterType: text("requester_type").notNull(),

  targetType: text("target_type").notNull(),
  targetId: varchar("target_id", { length: 36 }).notNull(),

  reason: text("reason").notNull(),
  amount: integer("amount").notNull(),

  status: text("status").default("pending"),
  adminNotes: text("admin_notes"),
  adminNotifiedAt: timestamp("admin_notified_at"),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: varchar("resolved_by", { length: 36 }),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   FEED POSTS
===================================================== */
export const feedPosts = pgTable("feed_posts", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  authorId: varchar("author_id", { length: 36 }).notNull().references(() => users.id),
  authorType: text("author_type").notNull(), // 'customer', 'vendor', 'photographer'

  postType: text("post_type").default("text").notNull(), // 'text', 'product', 'service'

  content: text("content").notNull(),
  imageUrl: text("image_url"),

  taggedBusinessId: varchar("tagged_business_id", { length: 36 }).references(() => businesses.id),
  taggedPhotographerId: varchar("tagged_photographer_id", { length: 36 }).references(() => photographers.id),

  productId: varchar("product_id", { length: 36 }).references(() => vendorProducts.id),
  serviceId: varchar("service_id", { length: 36 }).references(() => vendorServices.id),

  likesCount: integer("likes_count").default(0),
  commentsCount: integer("comments_count").default(0),

  isActive: boolean("is_active").default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const postLikes = pgTable("post_likes", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  postId: varchar("post_id", { length: 36 }).notNull().references(() => feedPosts.id),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const postComments = pgTable("post_comments", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  postId: varchar("post_id", { length: 36 }).notNull().references(() => feedPosts.id),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),

  content: text("content").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Profile comments for businesses and photographers
export const profileComments = pgTable("profile_comments", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  targetType: text("target_type").notNull(), // "business" or "photographer"
  targetId: varchar("target_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),

  content: text("content").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Shipments for order fulfillment tracking
export const shipments = pgTable("shipments", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  orderId: varchar("order_id", { length: 36 }).notNull().references(() => orders.id),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),

  carrier: text("carrier").notNull(), // 'fedex', 'ups', 'usps', 'dhl', 'other'
  trackingNumber: text("tracking_number").notNull(),
  status: text("status").default("shipped"), // 'pending', 'shipped', 'in_transit', 'delivered', 'exception'

  shippedAt: timestamp("shipped_at").defaultNow().notNull(),
  deliveredAt: timestamp("delivered_at"),
  estimatedDelivery: timestamp("estimated_delivery"),

  notes: text("notes"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   INSERT SCHEMAS (Zod)
===================================================== */

export const billingAddressSchema = z.object({
  line1: z.string().min(1, "Address line 1 is required"),
  line2: z.string().optional(),
  city: z.string().min(1, "City is required"),
  state: z.string().min(1, "State is required"),
  postalCode: z.string().min(1, "Postal code is required"),
  country: z.string().min(1, "Country is required"),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertBusinessSchema = createInsertSchema(businesses).omit({
  id: true,
  rating: true,
  reviewCount: true,
  createdAt: true,
});

export const insertVendorProductSchema = createInsertSchema(vendorProducts).omit({
  id: true,
  createdAt: true,
});

export const insertVendorServiceSchema = createInsertSchema(vendorServices).omit({
  id: true,
  createdAt: true,
});

export const insertBusinessAvailabilitySchema = createInsertSchema(businessAvailability).omit({
  id: true,
  createdAt: true,
});

export const insertPhotographerAvailabilitySchema = createInsertSchema(photographerAvailability).omit({
  id: true,
  createdAt: true,
});

export const insertStaffMemberSchema = createInsertSchema(staffMembers).omit({
  id: true,
  rating: true,
  reviewCount: true,
  createdAt: true,
});

export const insertStaffAvailabilitySchema = createInsertSchema(staffAvailability).omit({
  id: true,
  createdAt: true,
});

export const insertStaffInviteSchema = createInsertSchema(staffInvites).omit({
  id: true,
  createdAt: true,
  acceptedAt: true,
});

export const updateStaffMemberSchema = z.object({
  displayName: z.string().min(1).optional(),
  bio: z.string().optional(),
  profileImageUrl: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().nullable(),
  serviceIds: z.array(z.string()).optional(),
  specialties: z.array(z.string()).optional(),
  role: z.enum(['staff', 'manager', 'owner']).optional(),
  status: z.enum(['active', 'inactive', 'pending']).optional(),
  hoursOfOperation: z.record(z.string(), z.object({
    open: z.string(),
    close: z.string(),
    closed: z.boolean().optional(),
  })).optional(),
});

export const updateBusinessProfileSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  tagline: z.string().optional(),
  category: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  websiteUrl: z.string().optional(),
  socialMedia: z.string().optional(),
  coverImage: z.string().optional(),
  logoImage: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
  hoursOfOperation: z.record(z.string(), z.object({
    open: z.string(),
    close: z.string(),
    closed: z.boolean().optional(),
  })).optional(),
  brandColors: z.object({
    primary: z.string().optional(),
    secondary: z.string().optional(),
  }).optional(),
  hasProducts: z.boolean().optional(),
  hasServices: z.boolean().optional(),
});

export const insertCitySchema = createInsertSchema(cities);

export const insertRefreshTokenSchema = createInsertSchema(refreshTokens).omit({
  id: true,
  createdAt: true,
});

export const insertReviewSchema = createInsertSchema(reviews).omit({
  id: true,
  createdAt: true,
  isVerified: true,
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
  lastMessageAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
  isRead: true,
  readAt: true,
});

export const insertPointTransactionSchema = createInsertSchema(pointTransactions).omit({
  id: true,
  createdAt: true,
});

export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({
  id: true,
  createdAt: true,
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
  isRead: true,
  readAt: true,
});

export const insertFollowSchema = createInsertSchema(follows).omit({
  id: true,
  createdAt: true,
});

export const insertCartItemSchema = createInsertSchema(cartItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertAvailabilitySlotSchema = createInsertSchema(availabilitySlots).omit({
  id: true,
  createdAt: true,
});

export const insertSchedulingSchema = createInsertSchema(scheduling).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertRefundRequestSchema = createInsertSchema(refundRequests).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  adminNotifiedAt: true,
  resolvedAt: true,
  resolvedBy: true,
});

export const insertFeedPostSchema = createInsertSchema(feedPosts).omit({
  id: true,
  likesCount: true,
  commentsCount: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPostLikeSchema = createInsertSchema(postLikes).omit({
  id: true,
  createdAt: true,
});

export const insertPostCommentSchema = createInsertSchema(postComments).omit({
  id: true,
  createdAt: true,
});

export const insertProfileCommentSchema = createInsertSchema(profileComments).omit({
  id: true,
  createdAt: true,
});

export const insertShipmentSchema = createInsertSchema(shipments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

/* =====================================================
   SIGNUP SCHEMAS
===================================================== */
export const customerSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores").optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  dateOfBirth: z.string().optional(),
  gender: z.string().optional(),
  ethnicity: z.string().optional(),
  nationality: z.string().optional(),
  householdSize: z.string().optional(),
  incomeRange: z.string().optional(),
  education: z.string().optional(),
  occupation: z.string().optional(),
  shoppingFrequency: z.string().optional(),
  selectedIndustries: z.array(z.string()).default([]),
  industryNiches: z.record(z.string(), z.array(z.string())).default({}),
  industryValues: z.record(z.string(), z.array(z.string())).default({}),
});

export const vendorSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  phone: z.string().optional(),
  businessName: z.string().min(1),
  businessCategory: z.string().min(1),
  businessDescription: z.string().optional(),
  offerType: z.enum(["products", "services", "both"]),
  isStartup: z.boolean().optional(),
  yearsInBusiness: z.string().optional(),
  employeeCount: z.string().optional(),
  businessType: z.string().optional(),
  hasPhysicalLocation: z.boolean().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  websiteUrl: z.string().optional(),
  socialMedia: z.string().optional(),
  acceptedSubscription: z.boolean().refine((val) => val === true, {
    message: "You must accept the subscription terms",
  }),
});

export const photographerSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  phone: z.string().optional(),
  displayName: z.string().min(1),
  bio: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  hourlyRate: z.number().min(1),
  portfolioUrl: z.string().min(1),
  specialties: z.array(z.string()).default([]),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/* =====================================================
   TYPES
===================================================== */
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type UpsertUser = {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profileImageUrl?: string | null;
};

export type InsertBusiness = z.infer<typeof insertBusinessSchema>;
export type Business = typeof businesses.$inferSelect;
export type UpdateBusinessProfile = z.infer<typeof updateBusinessProfileSchema>;

export type InsertVendorProduct = z.infer<typeof insertVendorProductSchema>;
export type VendorProduct = typeof vendorProducts.$inferSelect;

export type InsertVendorService = z.infer<typeof insertVendorServiceSchema>;
export type VendorService = typeof vendorServices.$inferSelect;

export type InsertBusinessAvailability = z.infer<typeof insertBusinessAvailabilitySchema>;
export type BusinessAvailability = typeof businessAvailability.$inferSelect;

export type InsertPhotographerAvailability = z.infer<typeof insertPhotographerAvailabilitySchema>;
export type PhotographerAvailability = typeof photographerAvailability.$inferSelect;

export type InsertStaffMember = z.infer<typeof insertStaffMemberSchema>;
export type StaffMember = typeof staffMembers.$inferSelect;
export type UpdateStaffMember = z.infer<typeof updateStaffMemberSchema>;

export type InsertStaffAvailability = z.infer<typeof insertStaffAvailabilitySchema>;
export type StaffAvailability = typeof staffAvailability.$inferSelect;

export type InsertStaffInvite = z.infer<typeof insertStaffInviteSchema>;
export type StaffInvite = typeof staffInvites.$inferSelect;

export type InsertCity = z.infer<typeof insertCitySchema>;
export type City = typeof cities.$inferSelect;

export type RefreshToken = typeof refreshTokens.$inferSelect;

export type Photographer = typeof photographers.$inferSelect;

export type PhotographerService = typeof photographerServices.$inferSelect;
export type InsertPhotographerService = typeof photographerServices.$inferInsert;

export type ShootBooking = typeof shootBookings.$inferSelect;

export type Appointment = typeof appointments.$inferSelect;
export type InsertAppointment = typeof appointments.$inferInsert;

export type Order = typeof orders.$inferSelect;
export type InsertOrder = typeof orders.$inferInsert;

export type OrderGroup = typeof orderGroups.$inferSelect;
export type InsertOrderGroup = typeof orderGroups.$inferInsert;

export type InsertReview = z.infer<typeof insertReviewSchema>;
export type Review = typeof reviews.$inferSelect;

export type PointTransaction = typeof pointTransactions.$inferSelect;
export type InsertPointTransaction = z.infer<typeof insertPointTransactionSchema>;

export type Referral = typeof referrals.$inferSelect;

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;

export type Follow = typeof follows.$inferSelect;
export type InsertFollow = z.infer<typeof insertFollowSchema>;

export type CartItem = typeof cartItems.$inferSelect;
export type InsertCartItem = z.infer<typeof insertCartItemSchema>;

export type SubscriptionTier = typeof subscriptionTiers.$inferSelect;

export type TierBenefit = typeof tierBenefits.$inferSelect;

export type VendorSubscription = typeof vendorSubscriptions.$inferSelect;

export type BenefitAllowance = typeof benefitAllowances.$inferSelect;

export type FulfillmentTask = typeof fulfillmentTasks.$inferSelect;

export type AlaCarteService = typeof alaCarteServices.$inferSelect;

export type AlaCartePurchase = typeof alaCartePurchases.$inferSelect;

export type AvailabilitySlot = typeof availabilitySlots.$inferSelect;
export type InsertAvailabilitySlot = z.infer<typeof insertAvailabilitySlotSchema>;

export type Scheduling = typeof scheduling.$inferSelect;
export type InsertScheduling = z.infer<typeof insertSchedulingSchema>;

export type RefundRequest = typeof refundRequests.$inferSelect;
export type InsertRefundRequest = z.infer<typeof insertRefundRequestSchema>;

export type FeedPost = typeof feedPosts.$inferSelect;
export type InsertFeedPost = z.infer<typeof insertFeedPostSchema>;

export type PostLike = typeof postLikes.$inferSelect;
export type InsertPostLike = z.infer<typeof insertPostLikeSchema>;

export type PostComment = typeof postComments.$inferSelect;
export type InsertPostComment = z.infer<typeof insertPostCommentSchema>;

export type ProfileComment = typeof profileComments.$inferSelect;
export type InsertProfileComment = z.infer<typeof insertProfileCommentSchema>;

export type Shipment = typeof shipments.$inferSelect;
export type InsertShipment = z.infer<typeof insertShipmentSchema>;

/* =====================================================
   AUDIT LOGS (Financial Actions)
===================================================== */
export const auditLogs = pgTable("audit_logs", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  actorId: varchar("actor_id", { length: 36 }),
  actorType: text("actor_type").notNull(),
  
  action: text("action").notNull(),
  
  targetType: text("target_type").notNull(),
  targetId: varchar("target_id", { length: 36 }).notNull(),
  
  beforeState: jsonb("before_state").$type<Record<string, any>>(),
  afterState: jsonb("after_state").$type<Record<string, any>>(),
  
  metadata: jsonb("metadata").$type<Record<string, any>>(),
  
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({ id: true, createdAt: true }).extend({
  beforeState: z.record(z.any()).optional().nullable(),
  afterState: z.record(z.any()).optional().nullable(),
  metadata: z.record(z.any()).optional().nullable(),
});
export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;

/* =====================================================
   USER BLOCKS - Block/Mute Users
===================================================== */
export const userBlocks = pgTable("user_blocks", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  blockerId: varchar("blocker_id", { length: 36 }).notNull(),
  blockedId: varchar("blocked_id", { length: 36 }).notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserBlockSchema = createInsertSchema(userBlocks).omit({ id: true, createdAt: true });
export type UserBlock = typeof userBlocks.$inferSelect;
export type InsertUserBlock = z.infer<typeof insertUserBlockSchema>;

/* =====================================================
   MESSAGE REPORTS - Report Abusive Messages
===================================================== */
export const messageReports = pgTable("message_reports", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  reporterId: varchar("reporter_id", { length: 36 }).notNull(),
  messageId: varchar("message_id", { length: 36 }).notNull(),
  conversationId: varchar("conversation_id", { length: 36 }).notNull(),
  reportedUserId: varchar("reported_user_id", { length: 36 }).notNull(),
  reason: text("reason").notNull(),
  status: text("status").default("pending"),
  adminNotes: text("admin_notes"),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: varchar("resolved_by", { length: 36 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertMessageReportSchema = createInsertSchema(messageReports).omit({ id: true, createdAt: true, resolvedAt: true, resolvedBy: true, status: true, adminNotes: true });
export type MessageReport = typeof messageReports.$inferSelect;
export type InsertMessageReport = z.infer<typeof insertMessageReportSchema>;

/* =====================================================
   INFLUENCER PROFILES
===================================================== */
export const influencerProfiles = pgTable("influencer_profiles", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().unique().references(() => users.id),
  
  displayName: text("display_name"),
  bio: text("bio"),
  promoCode: text("promo_code").unique(),
  
  instagramUrl: text("instagram_url"),
  tiktokUrl: text("tiktok_url"),
  youtubeUrl: text("youtube_url"),
  twitterUrl: text("twitter_url"),
  
  followerCount: integer("follower_count").default(0),
  
  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false),
  stripeOnboardingUrl: text("stripe_onboarding_url"),
  
  totalEarnings: integer("total_earnings").default(0),
  pendingEarnings: integer("pending_earnings").default(0),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInfluencerProfileSchema = createInsertSchema(influencerProfiles).omit({ id: true, createdAt: true, updatedAt: true, totalEarnings: true, pendingEarnings: true });
export type InfluencerProfile = typeof influencerProfiles.$inferSelect;
export type InsertInfluencerProfile = z.infer<typeof insertInfluencerProfileSchema>;

/* =====================================================
   INFLUENCER APPLICATIONS - User Requests to Become Influencer
===================================================== */
export const influencerApplications = pgTable("influencer_applications", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
  
  instagramUrl: text("instagram_url"),
  tiktokUrl: text("tiktok_url"),
  youtubeUrl: text("youtube_url"),
  twitterUrl: text("twitter_url"),
  
  followerCount: integer("follower_count"),
  contentNiche: text("content_niche"),
  whyInfluencer: text("why_influencer"),
  
  status: text("status").default("pending").notNull(),
  adminNotes: text("admin_notes"),
  reviewedBy: varchar("reviewed_by", { length: 36 }),
  reviewedAt: timestamp("reviewed_at"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInfluencerApplicationSchema = createInsertSchema(influencerApplications).omit({ id: true, createdAt: true, status: true, adminNotes: true, reviewedBy: true, reviewedAt: true });
export type InfluencerApplication = typeof influencerApplications.$inferSelect;
export type InsertInfluencerApplication = z.infer<typeof insertInfluencerApplicationSchema>;

/* =====================================================
   INFLUENCER CAMPAIGNS - Vendor/Admin Created Campaigns
===================================================== */
export const influencerCampaigns = pgTable("influencer_campaigns", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  name: text("name").notNull(),
  description: text("description"),
  
  createdByVendorId: varchar("created_by_vendor_id", { length: 36 }),
  createdByAdminId: varchar("created_by_admin_id", { length: 36 }),
  
  payoutType: text("payout_type").notNull(),
  flatAmountCents: integer("flat_amount_cents").default(0),
  commissionBps: integer("commission_bps").default(0),
  
  targetProductIds: jsonb("target_product_ids").$type<string[]>().default([]),
  targetServiceIds: jsonb("target_service_ids").$type<string[]>().default([]),
  
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  
  status: text("status").default("draft").notNull(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInfluencerCampaignSchema = createInsertSchema(influencerCampaigns).omit({ id: true, createdAt: true, updatedAt: true });
export type InfluencerCampaign = typeof influencerCampaigns.$inferSelect;
export type InsertInfluencerCampaign = z.infer<typeof insertInfluencerCampaignSchema>;

/* =====================================================
   INFLUENCER CAMPAIGN ASSIGNMENTS - Link Influencers to Campaigns
===================================================== */
export const influencerCampaignAssignments = pgTable("influencer_campaign_assignments", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  campaignId: varchar("campaign_id", { length: 36 }).notNull().references(() => influencerCampaigns.id),
  influencerId: varchar("influencer_id", { length: 36 }).notNull().references(() => influencerProfiles.id),
  
  negotiatedFlatAmountCents: integer("negotiated_flat_amount_cents"),
  negotiatedCommissionBps: integer("negotiated_commission_bps"),
  
  goals: text("goals"),
  status: text("status").default("assigned").notNull(),
  
  completedAt: timestamp("completed_at"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInfluencerCampaignAssignmentSchema = createInsertSchema(influencerCampaignAssignments).omit({ id: true, createdAt: true, completedAt: true });
export type InfluencerCampaignAssignment = typeof influencerCampaignAssignments.$inferSelect;
export type InsertInfluencerCampaignAssignment = z.infer<typeof insertInfluencerCampaignAssignmentSchema>;

/* =====================================================
   INFLUENCER REFERRAL EVENTS - Track Sales from Influencer Promos
===================================================== */
export const influencerReferralEvents = pgTable("influencer_referral_events", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  influencerId: varchar("influencer_id", { length: 36 }).notNull().references(() => influencerProfiles.id),
  campaignId: varchar("campaign_id", { length: 36 }),
  
  orderId: varchar("order_id", { length: 36 }),
  orderGroupId: varchar("order_group_id", { length: 36 }),
  bookingId: varchar("booking_id", { length: 36 }),
  
  orderTotalCents: integer("order_total_cents").default(0),
  commissionBps: integer("commission_bps").default(0),
  commissionEarnedCents: integer("commission_earned_cents").default(0),
  
  promoCodeUsed: text("promo_code_used"),
  
  creditedAt: timestamp("credited_at"),
  ledgerEntryId: varchar("ledger_entry_id", { length: 36 }),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInfluencerReferralEventSchema = createInsertSchema(influencerReferralEvents).omit({ id: true, createdAt: true });
export type InfluencerReferralEvent = typeof influencerReferralEvents.$inferSelect;
export type InsertInfluencerReferralEvent = z.infer<typeof insertInfluencerReferralEventSchema>;

/* =====================================================
   INFLUENCER EARNING LEDGER - Central Ledger for All Earnings
===================================================== */
export const influencerEarningLedger = pgTable("influencer_earning_ledger", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  influencerId: varchar("influencer_id", { length: 36 }).notNull().references(() => influencerProfiles.id),
  
  sourceType: text("source_type").notNull(),
  sourceRefId: varchar("source_ref_id", { length: 36 }),
  
  amountCents: integer("amount_cents").notNull(),
  description: text("description"),
  
  status: text("status").default("pending").notNull(),
  
  stripeTransferId: text("stripe_transfer_id"),
  payoutId: varchar("payout_id", { length: 36 }),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  paidAt: timestamp("paid_at"),
});

export const insertInfluencerEarningLedgerSchema = createInsertSchema(influencerEarningLedger).omit({ id: true, createdAt: true, paidAt: true, stripeTransferId: true, payoutId: true });
export type InfluencerEarningLedger = typeof influencerEarningLedger.$inferSelect;
export type InsertInfluencerEarningLedger = z.infer<typeof insertInfluencerEarningLedgerSchema>;

/* =====================================================
   INFLUENCER PAYOUTS - Track Actual Stripe Transfers
===================================================== */
export const influencerPayouts = pgTable("influencer_payouts", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  influencerId: varchar("influencer_id", { length: 36 }).notNull().references(() => influencerProfiles.id),
  
  amountCents: integer("amount_cents").notNull(),
  ledgerIds: jsonb("ledger_ids").$type<string[]>().default([]),
  
  stripeTransferId: text("stripe_transfer_id"),
  status: text("status").default("pending").notNull(),
  
  initiatedAt: timestamp("initiated_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  failedAt: timestamp("failed_at"),
  failureReason: text("failure_reason"),
});

export const insertInfluencerPayoutSchema = createInsertSchema(influencerPayouts).omit({ id: true, initiatedAt: true, completedAt: true, failedAt: true, failureReason: true });
export type InfluencerPayout = typeof influencerPayouts.$inferSelect;
export type InsertInfluencerPayout = z.infer<typeof insertInfluencerPayoutSchema>;

/* =====================================================
   ORDER STATE MACHINE - Valid Transitions
===================================================== */
export const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  'pending': ['paid', 'cancelled'],
  'paid': ['shipped', 'refunded', 'cancelled'],
  'shipped': ['delivered', 'refunded'],
  'delivered': ['refunded'],
  'refunded': [],
  'cancelled': [],
};

export const BOOKING_STATUS_TRANSITIONS: Record<string, string[]> = {
  'pending': ['confirmed', 'cancelled'],
  'confirmed': ['in_progress', 'cancelled', 'refunded'],
  'in_progress': ['completed', 'cancelled', 'refunded'],
  'completed': ['refunded'],
  'cancelled': [],
  'refunded': [],
};

export function isValidOrderTransition(currentStatus: string, newStatus: string): boolean {
  const validTransitions = ORDER_STATUS_TRANSITIONS[currentStatus] || [];
  return validTransitions.includes(newStatus);
}

export function isValidBookingTransition(currentStatus: string, newStatus: string): boolean {
  const validTransitions = BOOKING_STATUS_TRANSITIONS[currentStatus] || [];
  return validTransitions.includes(newStatus);
}

/* =====================================================
   UNIFIED SEARCH INDEX
===================================================== */
export const searchIndex = pgTable("search_index", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  entityType: text("entity_type").notNull(), // 'product' | 'service' | 'business' | 'photographer' | 'photographer_service'
  entityId: varchar("entity_id", { length: 36 }).notNull(),
  
  // Parent reference for products/services
  parentType: text("parent_type"), // 'business' | 'photographer'
  parentId: varchar("parent_id", { length: 36 }),
  
  // Searchable text fields
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  tags: text("tags").array(),
  knownFor: jsonb("known_for").$type<string[]>().default([]),
  
  // Location data (from parent business/photographer)
  city: text("city"),
  state: text("state"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  
  // Rating data
  rating: integer("rating").default(0),
  reviewCount: integer("review_count").default(0),
  
  // Pricing (in cents)
  priceCents: integer("price_cents"),
  
  // Image for display
  imageUrl: text("image_url"),
  
  // Active status
  isActive: boolean("is_active").default(true),
  
  // Subscription boost for businesses
  hasActiveSubscription: boolean("has_active_subscription").default(false),
  
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSearchIndexSchema = createInsertSchema(searchIndex).omit({ id: true, updatedAt: true });
export type SearchIndexEntry = typeof searchIndex.$inferSelect;
export type InsertSearchIndexEntry = z.infer<typeof insertSearchIndexSchema>;

/* =====================================================
   AGE RANGE UTILITY - DOB Privacy
===================================================== */
export type AgeRange = '18-24' | '25-34' | '35-44' | '45-54' | '55-64' | '65+' | null;

export function calculateAgeRange(dateOfBirth: Date | string | null | undefined): AgeRange {
  if (!dateOfBirth) return null;
  
  const dob = typeof dateOfBirth === 'string' ? new Date(dateOfBirth) : dateOfBirth;
  if (isNaN(dob.getTime())) return null;
  
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  
  if (age < 18) return null;
  if (age <= 24) return '18-24';
  if (age <= 34) return '25-34';
  if (age <= 44) return '35-44';
  if (age <= 54) return '45-54';
  if (age <= 64) return '55-64';
  return '65+';
}

export interface VendorSafeUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  profileImageUrl: string | null;
  ageRange: AgeRange;
  gender: string | null;
}

export function toVendorSafeUser(user: User): VendorSafeUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    profileImageUrl: user.profileImageUrl,
    ageRange: calculateAgeRange(user.dateOfBirth),
    gender: user.gender,
  };
}
