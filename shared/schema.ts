import {
  pgTable, text, varchar, boolean, integer, jsonb, timestamp, index, doublePrecision, unique
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

/**
 * Hours of Operation Day Schema - Aligned with Frontend Format
 * 
 * Frontend sends:
 * - Closed day: { open: false }
 * - Open day: { open: true, start: "09:00", end: "17:00" }
 * 
 * This schema accepts the frontend format and normalizes internally.
 * Also supports legacy format for backward compatibility:
 * - Legacy: { open: "09:00", close: "17:00", closed?: boolean }
 */

// Closed day schema
const closedDaySchema = z.object({
  open: z.literal(false),
});

// Open day schema (frontend format with start/end)
const openDaySchema = z.object({
  open: z.literal(true),
  start: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
  end: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
});

// Legacy format support (open/close as time strings)
const legacyDaySchema = z.object({
  open: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
  close: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
  closed: z.boolean().optional(),
});

// Combined schema supporting both formats
const hoursOfOperationDaySchema = z.union([
  closedDaySchema,
  openDaySchema,
  legacyDaySchema,
]);

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
   OAUTH STATES (Mobile Auth CSRF Protection)
===================================================== */
export const oauthStates = pgTable(
  "oauth_states",
  {
    state: varchar("state", { length: 36 }).primaryKey(),
    deviceId: text("device_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("IDX_oauth_states_expires").on(t.expiresAt)]
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
   BOOKING STATE MACHINE
===================================================== */
// Valid booking states: DRAFT -> PENDING_PAYMENT -> PENDING_PROVIDER (if !autoAccept) -> CONFIRMED -> COMPLETED/CANCELED
export const BOOKING_STATES = {
  DRAFT: 'draft',              // Slot locked, awaiting payment initiation (10-min TTL)
  PENDING_PAYMENT: 'pending_payment', // Payment initiated, awaiting confirmation
  PENDING_PROVIDER: 'pending_provider', // Payment authorized, awaiting provider accept/decline (24h TTL, only if autoAccept=false)
  CONFIRMED: 'confirmed',      // Payment captured, booking active
  COMPLETED: 'completed',      // Service delivered
  CANCELED: 'canceled',        // Booking canceled (by user, vendor, or system)
  EXPIRED: 'expired',          // Draft TTL or pending_provider TTL expired
  NO_SHOW: 'no_show',          // Client didn't show up
  DECLINED: 'declined',        // Provider declined the booking (auth voided)
} as const;

export type BookingState = typeof BOOKING_STATES[keyof typeof BOOKING_STATES];

// Valid state transitions
export const BOOKING_TRANSITIONS: Record<BookingState, BookingState[]> = {
  draft: ['pending_payment', 'canceled', 'expired'],
  pending_payment: ['confirmed', 'pending_provider', 'canceled', 'expired'],
  pending_provider: ['confirmed', 'declined', 'expired', 'canceled'], // Provider accepts -> confirmed, declines -> declined, timeout -> expired
  confirmed: ['completed', 'canceled', 'no_show'],
  completed: [], // Terminal state
  canceled: [],  // Terminal state
  expired: [],   // Terminal state
  no_show: [],   // Terminal state
  declined: [],  // Terminal state
};

// Booking cancellation reasons
export const CANCELLATION_REASONS = {
  CLIENT_REQUEST: 'client_request',
  VENDOR_REQUEST: 'vendor_request',
  PAYMENT_FAILED: 'payment_failed',
  SYSTEM_TIMEOUT: 'system_timeout',
  DOUBLE_BOOKING: 'double_booking',
} as const;

export type CancellationReason = typeof CANCELLATION_REASONS[keyof typeof CANCELLATION_REASONS];

/* =====================================================
   USERS
===================================================== */
export const users = pgTable("users", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").unique(),
  password: text("password"),
  name: text("name"),
  bio: text("bio"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  phone: text("phone"),
  profileImageUrl: text("profile_image_url"),
  coverMediaUrl: text("cover_media_url"),
  coverMediaType: text("cover_media_type"), // 'image' or 'video'

  isVendor: boolean("is_vendor").default(false).notNull(),
  isPhotographer: boolean("is_photographer").default(false).notNull(),
  isInfluencer: boolean("is_influencer").default(false).notNull(),
  isAdmin: boolean("is_admin").default(false).notNull(),
  isOAuthUser: boolean("is_oauth_user").default(false),

  // Google OAuth sub (unique identifier from Google)
  // Note: Uniqueness enforced via partial index (see db migration) to allow NULL for legacy users
  googleSub: text("google_sub"),
  appleId: text("apple_id").unique(),

  // Monetization intent (user-controlled via API)
  wantsToSellProducts: boolean("wants_to_sell_products").default(false).notNull(),
  wantsToOfferServices: boolean("wants_to_offer_services").default(false).notNull(),
  wantsToPromoteAsInfluencer: boolean("wants_to_promote_as_influencer").default(false).notNull(),

  // Monetization permission (system-controlled, requires approval)
  canMonetize: boolean("can_monetize").default(false).notNull(),

  // Home address
  address: text("address"), // street address (legacy field name)
  aptUnit: text("apt_unit"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),
  country: text("country").default("United States"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),

  // Billing address
  billingAddress: jsonb("billing_address").$type<BillingAddress>(), // legacy JSONB field
  billingSameAsHome: boolean("billing_same_as_home").default(true),
  billingStreet: text("billing_street"),
  billingAptUnit: text("billing_apt_unit"),
  billingCity: text("billing_city"),
  billingState: text("billing_state"),
  billingZip: text("billing_zip"),
  billingCountry: text("billing_country").default("United States"),

  username: text("username").notNull().unique(),
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

  // Push notifications for mobile
  expoPushToken: text("expo_push_token"),
  pushTokenType: text("push_token_type"), // 'expo' | 'apns' | 'fcm'

  // Identity change tracking (rate limiting)
  usernameLastChangedAt: timestamp("username_last_changed_at"),
  displayNameLastChangedAt: timestamp("display_name_last_changed_at"),

  // Password reset
  resetTokenHash: text("reset_token_hash"),
  resetTokenExpiresAt: timestamp("reset_token_expires_at"),
  resetCodeHash: text("reset_code_hash"),
  resetCodeExpiresAt: timestamp("reset_code_expires_at"),
  resetCodeAttempts: integer("reset_code_attempts").default(0),

  // Account status
  isActive: boolean("is_active").default(true).notNull(),

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
  country: text("country").default("United States"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),

  websiteUrl: text("website_url"),
  socialMedia: text("social_media"),

  coverImage: text("cover_image"),
  coverMediaType: text("cover_media_type"), // 'image' or 'video'
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
  isMultiStaff: boolean("is_multi_staff").notNull().default(false),

  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false),
  stripeOnboardingUrl: text("stripe_onboarding_url"),

  billingAddress: jsonb("billing_address").$type<BillingAddress>(),

  // Approval workflow: pending (new applications), approved, rejected
  approvalStatus: text("approval_status").default("pending").notNull(),
  approvalNotes: text("approval_notes"),
  approvedAt: timestamp("approved_at"),
  approvedBy: varchar("approved_by", { length: 36 }),

  // Demo/seed data flag - hidden from non-admin users in search
  isDemo: boolean("is_demo").default(false).notNull(),

  // Booking settings
  autoAcceptBookings: boolean("auto_accept_bookings").default(true).notNull(),
  defaultServiceLocationType: text("default_service_location_type").default("business"),

  // Storefront display toggles
  showResponseTime: boolean("show_response_time").default(true),
  showEmail: boolean("show_email").default(true),
  showPhone: boolean("show_phone").default(true),
  showWebsite: boolean("show_website").default(true),
  showStoreHours: boolean("show_store_hours").default(true),
  showAddress: boolean("show_address").default(true),

  // Vendor-defined booking terms shown as a required checkbox to customers
  // at the Review step. null = vendor has not set any terms (checkbox hidden).
  vendorTermsAndConditions: text("vendor_terms_and_conditions"),

  responseTimeValue: integer("response_time_value").default(2),
  responseTimeUnit: text("response_time_unit").default("hours"),

  // Cancellation policy defaults (used as "apply to all services" template)
  fullRefundWindow: text("full_refund_window").default("never"), // '1_week'|'48_hours'|'24_hours'|'1_hour'|'never'
  hasPartialRefund: boolean("has_partial_refund").default(false),
  partialRefundWindow: text("partial_refund_window"), // nullable, same 5 values as fullRefundWindow
  partialRefundPercentage: integer("partial_refund_percentage"), // nullable, 0-100
  hasCancellationFee: boolean("has_cancellation_fee").default(false),
  cancellationFeeType: text("cancellation_fee_type"), // nullable, 'flat'|'percentage'
  cancellationFeeAmount: integer("cancellation_fee_amount"), // nullable, cents if flat / whole percent if percentage

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  idxBusinessOwner: index("idx_businesses_owner").on(table.ownerId),
  idxBusinessCity: index("idx_businesses_city").on(table.city),
  idxBusinessState: index("idx_businesses_state").on(table.state),
  idxBusinessApproval: index("idx_businesses_approval").on(table.approvalStatus),
  idxBusinessLocation: index("idx_businesses_location").on(table.latitude, table.longitude),
}));

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

  // Cancellation policy
  fullRefundWindow: text("full_refund_window").default("never"), // '1_week'|'48_hours'|'24_hours'|'1_hour'|'never'
  hasPartialRefund: boolean("has_partial_refund").default(false),
  partialRefundWindow: text("partial_refund_window"), // nullable, same 5 values as fullRefundWindow
  partialRefundPercentage: integer("partial_refund_percentage"), // nullable, 0-100
  hasCancellationFee: boolean("has_cancellation_fee").default(false),
  cancellationFeeType: text("cancellation_fee_type"), // nullable, 'flat'|'percentage'
  cancellationFeeAmount: integer("cancellation_fee_amount"), // nullable, cents if flat / whole percent if percentage

  // Service location type: 'business' | 'alternate' | 'customer'
  serviceLocationType: text("service_location_type").default("business"),
  alternateAddress: text("alternate_address"),
  alternateCity: text("alternate_city"),
  alternateState: text("alternate_state"),
  alternateZipCode: text("alternate_zip_code"),
  virtualLink: text("virtual_link"),

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
  
  // Status: 'active' | 'inactive' | 'pending' (invited but not accepted) | 'archived' (offboarded — soft-delete, row is kept)
  status: text("status").default("active").notNull(),
  
  // Rating/reviews for this staff member
  rating: integer("rating").default(0),
  reviewCount: integer("review_count").default(0),
  
  // Stripe Connect for direct payouts
  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false),
  stripeOnboardingUrl: text("stripe_onboarding_url"),
  stripeOnboardingLastEventAt: timestamp("stripe_onboarding_last_event_at"),
  
  // Staff hours (can be different from business hours)
  hoursOfOperation: jsonb("hours_of_operation").$type<HoursOfOperation>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),

  // Stamped by resolveRequestingStaffMember() whenever a staff self-service
  // request actually resolves to this business — the real "used this business"
  // signal for disambiguating a person staffing 2+ businesses. Not the same as
  // createdAt (invite-acceptance time) or stripeOnboardingLastEventAt (webhook-only).
  lastActiveAt: timestamp("last_active_at"),
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

  // Recipient contact — email is required; phone reserved for future SMS
  email: text("email").notNull(),
  phone: text("phone"),
  inviteCode: text("invite_code").unique().notNull(),

  // Pre-filled staff info
  displayName: text("display_name"),
  role: text("role").default("staff"),

  // Status: 'pending' | 'accepted' | 'revoked' | 'expired'
  status: text("status").default("pending").notNull(),

  invitedByUserId: varchar("invited_by_user_id", { length: 36 }).references(() => users.id),
  acceptedByUserId: varchar("accepted_by_user_id", { length: 36 }).references(() => users.id),

  sentAt: timestamp("sent_at"),
  expiresAt: timestamp("expires_at").notNull().default(sql`NOW() + INTERVAL '7 days'`),
  acceptedAt: timestamp("accepted_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   STAFF SERVICES (Staff-Owned Bookable Services)
===================================================== */
export const staffServices = pgTable("staff_services", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  staffMemberId: varchar("staff_member_id", { length: 36 }).notNull().references(() => staffMembers.id),
  // Denormalized for hot-path queries — derivable via staffMemberId → staff_members.businessId
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),

  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),

  // Flat-rate fixed-duration pricing (no hourly/package model — staff services are appointments)
  priceCents: integer("price_cents").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),

  isActive: boolean("is_active").default(true),

  // Publishing status: 'draft' (default) | 'live' | 'archived'
  status: text("status").default("draft").notNull(),

  // Connected account Stripe IDs — staff have their own Connect accounts
  stripeConnectedProductId: text("stripe_connected_product_id"),
  stripeConnectedPriceId: text("stripe_connected_price_id"),

  // Service location type: 'business' | 'alternate' | 'customer' | 'virtual'
  serviceLocationType: text("service_location_type").default("business"),
  alternateAddress: text("alternate_address"),
  alternateCity: text("alternate_city"),
  alternateState: text("alternate_state"),
  alternateZipCode: text("alternate_zip_code"),
  virtualLink: text("virtual_link"),

  // Cancellation policy
  fullRefundWindow: text("full_refund_window").default("never"), // '1_week'|'48_hours'|'24_hours'|'1_hour'|'never'
  hasPartialRefund: boolean("has_partial_refund").default(false),
  partialRefundWindow: text("partial_refund_window"), // nullable, same 5 values as fullRefundWindow
  partialRefundPercentage: integer("partial_refund_percentage"), // nullable, 0-100
  hasCancellationFee: boolean("has_cancellation_fee").default(false),
  cancellationFeeType: text("cancellation_fee_type"), // nullable, 'flat'|'percentage'
  cancellationFeeAmount: integer("cancellation_fee_amount"), // nullable, cents if flat / whole percent if percentage

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
  coverMediaType: text("cover_media_type"), // 'image' or 'video'
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

  // Travel/availability settings
  travelBufferMinutes: integer("travel_buffer_minutes").default(30), // Buffer between shoots for travel
  serviceRadiusMiles: integer("service_radius_miles").default(25), // Max travel distance
  serviceLocations: jsonb("service_locations").$type<Array<{
    name: string;
    address?: string;
    city?: string;
    state?: string;
    latitude?: number;
    longitude?: number;
    isStudio?: boolean;
  }>>(),

  // Expanded photographer profile fields
  shootLocation: text("shoot_location").array(), // ['on-location', 'studio', 'both']
  studioName: text("studio_name"),
  studioAddress: text("studio_address"),
  usesSharedStudio: boolean("uses_shared_studio").default(false),
  travelRadius: text("travel_radius"), // 'city_only' | '25_miles' | '50_miles' | '100_miles' | 'anywhere'
  pricingType: text("pricing_type"), // 'hourly' | 'per_session' | 'per_project' | 'packages' | 'contact'
  startingPrice: integer("starting_price"), // in cents
  minimumBooking: text("minimum_booking"), // '30min' | '1hour' | '2hours' | 'half_day' | 'full_day'
  additionalServices: text("additional_services").array(),
  experienceLevel: text("experience_level"), // 'starting' | '1-2years' | '3-5years' | '5-10years' | '10plus'
  equipmentLevel: text("equipment_level"), // 'professional_studio' | 'professional_natural' | 'building'
  deliveryTime: text("delivery_time"), // 'same_day' | '24-48hours' | '3-5days' | '1-2weeks' | 'varies'

  // Demo/seed data flag
  isDemo: boolean("is_demo").default(false).notNull(),

  // Booking settings
  autoAcceptBookings: boolean("auto_accept_bookings").default(true).notNull(),

  // Booking defaults (mirror businesses)
  defaultServiceLocationType: text("default_service_location_type").default("business"),
  vendorTermsAndConditions: text("vendor_terms_and_conditions"),

  // Visibility control
  visibilityStatus: text("visibility_status").default("public").notNull(),
  adminNotes: text("admin_notes"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* =====================================================
   PHOTOGRAPHER BLACKOUT DATES (Days photographer is unavailable)
===================================================== */
export const photographerBlackoutDates = pgTable("photographer_blackout_dates", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  photographerId: varchar("photographer_id", { length: 36 }).notNull().references(() => photographers.id),
  date: text("date").notNull(), // Format: YYYY-MM-DD
  reason: text("reason"), // Optional reason (vacation, personal, etc.)
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

  // Service location type: 'business' | 'alternate' | 'customer' | 'virtual'
  serviceLocationType: text("service_location_type").default("business"),
  alternateAddress: text("alternate_address"),
  alternateCity: text("alternate_city"),
  alternateState: text("alternate_state"),
  alternateZipCode: text("alternate_zip_code"),
  virtualLink: text("virtual_link"),

  // Cancellation policy
  fullRefundWindow: text("full_refund_window").default("never"), // '1_week'|'48_hours'|'24_hours'|'1_hour'|'never'
  hasPartialRefund: boolean("has_partial_refund").default(false),
  partialRefundWindow: text("partial_refund_window"), // nullable, same 5 values as fullRefundWindow
  partialRefundPercentage: integer("partial_refund_percentage"), // nullable, 0-100
  hasCancellationFee: boolean("has_cancellation_fee").default(false),
  cancellationFeeType: text("cancellation_fee_type"), // nullable, 'flat'|'percentage'
  cancellationFeeAmount: integer("cancellation_fee_amount"), // nullable, cents if flat / whole percent if percentage

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
  
  // Payment method used: "checkout_session" (legacy/redirect) or "payment_intent" (in-app PaymentSheet)
  paymentMethod: text("payment_method").default("checkout_session"), // "checkout_session" | "payment_intent"
  
  // Capture method for PaymentIntent: "automatic" (immediate capture) or "manual" (auth only, capture later)
  captureMethod: text("capture_method"), // "automatic" | "manual"
  
  // Refund tracking
  stripeRefundId: text("stripe_refund_id"),
  refundedAt: timestamp("refunded_at"),
  refundAmount: integer("refund_amount"), // Amount refunded in cents
  
  // State machine status: draft, pending_payment, pending_provider, confirmed, completed, canceled, expired, no_show, declined
  status: text("status").default("draft").notNull(),
  
  // Draft lock TTL - when this expires, draft becomes invalid
  draftExpiresAt: timestamp("draft_expires_at"),
  
  // Pending provider TTL - 24h window for provider to accept/decline (only used when autoAccept=false)
  pendingProviderExpiresAt: timestamp("pending_provider_expires_at"),
  
  // Cancellation tracking
  canceledAt: timestamp("canceled_at"),
  canceledBy: varchar("canceled_by", { length: 36 }), // userId who canceled
  cancellationReason: text("cancellation_reason"),
  
  // Decline tracking (when provider declines)
  declinedAt: timestamp("declined_at"),
  declinedBy: varchar("declined_by", { length: 36 }),
  declineReason: text("decline_reason"),
  
  // Audit trail for state changes
  stateChangedAt: timestamp("state_changed_at"),
  stateChangedBy: varchar("state_changed_by", { length: 36 }), // 'system', 'stripe', or userId
  previousState: text("previous_state"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Prevent double bookings: unique constraint on photographer + date + time
  uniquePhotographerSlot: unique("unique_photographer_slot").on(
    table.photographerId, 
    table.date, 
    table.startTime
  ),
  // Index for draft expiry cleanup job
  shootDraftExpiryIdx: index("idx_shoot_bookings_draft_expiry").on(table.status, table.draftExpiresAt),
  // Index for availability queries
  shootAvailabilityIdx: index("idx_shoot_bookings_availability").on(table.photographerId, table.date, table.status),
  // Index for pending provider expiry cleanup
  shootPendingProviderIdx: index("idx_shoot_bookings_pending_provider").on(table.status, table.pendingProviderExpiresAt),
}));

/* =====================================================
   APPOINTMENTS (Service Bookings) - State Machine
===================================================== */
export const appointments = pgTable("appointments", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  businessId: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  clientId: varchar("client_id", { length: 36 }).notNull().references(() => users.id),
  // Null when booking is for a staff-owned service (staffServiceId is set instead)
  serviceId: varchar("service_id", { length: 36 }).references(() => vendorServices.id),
  // Null when booking is for a business-owned service (serviceId is set instead)
  staffServiceId: varchar("staff_service_id", { length: 36 }).references(() => staffServices.id),

  // Optional staff member assignment - if set, staff gets direct payout
  staffMemberId: varchar("staff_member_id", { length: 36 }).references(() => staffMembers.id),

  // Traceability back to the bookingHolds row this appointment was created from
  // (unified availability engine / hold-based booking flow). Null for rows
  // created outside that flow (e.g. the dev-test endpoint).
  holdId: varchar("hold_id", { length: 36 }),

  appointmentDate: text("appointment_date").notNull(),
  appointmentTime: text("appointment_time").notNull(),
  // End time for slot blocking (calculated from service duration)
  appointmentEndTime: text("appointment_end_time"),
  // Duration in minutes (from service)
  durationMinutes: integer("duration_minutes"),

  totalPrice: integer("total_price").notNull(),
  platformFee: integer("platform_fee").default(0),
  vendorNet: integer("vendor_net").default(0),
  
  // Staff payout tracking (when staffMemberId is set)
  staffPayout: integer("staff_payout").default(0), // Amount going to staff Stripe account

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  
  // Payment method used: "checkout_session" (legacy/redirect) or "payment_intent" (in-app PaymentSheet)
  paymentMethod: text("payment_method").default("checkout_session"), // "checkout_session" | "payment_intent"
  
  // Capture method for PaymentIntent: "automatic" (immediate capture) or "manual" (auth only, capture later)
  captureMethod: text("capture_method"), // "automatic" | "manual"
  
  // Refund tracking
  stripeRefundId: text("stripe_refund_id"),
  refundedAt: timestamp("refunded_at"),
  refundAmount: integer("refund_amount"), // Amount refunded in cents
  
  // State machine status: draft, pending_payment, pending_provider, confirmed, completed, canceled, expired, no_show, declined
  status: text("status").default("draft").notNull(),
  
  // Draft lock TTL - when this expires, draft becomes invalid
  draftExpiresAt: timestamp("draft_expires_at"),
  
  // Pending provider TTL - 24h window for provider to accept/decline (only used when autoAccept=false)
  pendingProviderExpiresAt: timestamp("pending_provider_expires_at"),
  
  // Cancellation tracking
  canceledAt: timestamp("canceled_at"),
  canceledBy: varchar("canceled_by", { length: 36 }), // userId who canceled
  cancellationReason: text("cancellation_reason"),
  
  // Decline tracking (when provider declines)
  declinedAt: timestamp("declined_at"),
  declinedBy: varchar("declined_by", { length: 36 }),
  declineReason: text("decline_reason"),
  
  // Audit trail for state changes
  stateChangedAt: timestamp("state_changed_at"),
  stateChangedBy: varchar("state_changed_by", { length: 36 }), // 'system', 'stripe', or userId
  previousState: text("previous_state"),

  // Customer-provided service address (populated when serviceLocationType === 'customer')
  customerServiceAddress: text("customer_service_address"),
  customerServiceCity: text("customer_service_city"),
  customerServiceState: text("customer_service_state"),
  customerServiceZipCode: text("customer_service_zip_code"),

  // Service snapshot — captured at booking-creation time so historical records remain
  // correct even if the service is later edited, archived, or deleted. Nullable because
  // existing rows pre-date this column; all new bookings populate these at write time.
  serviceName: text("service_name"),
  servicePriceCents: integer("service_price_cents"),
  serviceDurationMinutes: integer("service_duration_minutes"),
  // Cancellation policy snapshot (same field names/values as vendor_services / staff_services)
  serviceFullRefundWindow: text("service_full_refund_window"),
  serviceHasPartialRefund: boolean("service_has_partial_refund"),
  servicePartialRefundWindow: text("service_partial_refund_window"),
  servicePartialRefundPercentage: integer("service_partial_refund_percentage"),
  serviceHasCancellationFee: boolean("service_has_cancellation_fee"),
  serviceCancellationFeeType: text("service_cancellation_fee_type"),
  serviceCancellationFeeAmount: integer("service_cancellation_fee_amount"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Prevent double bookings: unique constraint on staff + date + time for active bookings
  // Only one confirmed/pending_payment booking allowed per slot
  uniqueStaffSlot: unique("unique_staff_slot").on(
    table.staffMemberId, 
    table.appointmentDate, 
    table.appointmentTime
  ).nullsNotDistinct(),
  // Index for draft expiry cleanup job
  draftExpiryIdx: index("idx_appointments_draft_expiry").on(table.status, table.draftExpiresAt),
  // Index for availability queries
  availabilityIdx: index("idx_appointments_availability").on(table.staffMemberId, table.appointmentDate, table.status),
  // Index for pending provider expiry cleanup
  pendingProviderIdx: index("idx_appointments_pending_provider").on(table.status, table.pendingProviderExpiresAt),
  // Index for idempotency lookups by originating hold
  holdIdIdx: index("idx_appointments_hold_id").on(table.holdId),
}));

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
  totalAmount: integer("total_amount").notNull(), // subtotal (product prices × qty)
  platformFee: integer("platform_fee").default(0), // 8% product fee (Outsyde revenue)
  vendorNet: integer("vendor_net").default(0), // subtotal - platformFee - influencerCommission

  // v2 fee breakdown (all in cents)
  consumerServiceFee: integer("consumer_service_fee").default(0), // 3% charged to customer (Outsyde revenue)
  influencerCommission: integer("influencer_commission").default(0), // 15% to influencer (NOT Outsyde revenue)
  grossChargeAmount: integer("gross_charge_amount").default(0), // subtotal + consumerServiceFee + tax
  outsydeGrossRevenue: integer("outsyde_gross_revenue").default(0), // consumerServiceFee + platformFee
  stripeFeeAmount: integer("stripe_fee_amount").default(0), // estimated/actual Stripe processing fee
  taxAmount: integer("tax_amount").default(0),

  // Influencer attribution
  attributedInfluencerId: varchar("attributed_influencer_id", { length: 36 }),
  influencerCodeUsed: text("influencer_code_used"),
  influencerTransferStatus: text("influencer_transfer_status"), // pending | approved | transfer_queued | transfer_sent | paid | reversed
  commissionStatus: text("commission_status"), // pending | approved | transfer_queued | transfer_sent | paid | reversed

  feeModelVersion: text("fee_model_version").default("v2"),

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  status: text("status").default("pending"),

  shippingAddress: text("shipping_address"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  idxOrderCustomer: index("idx_orders_customer").on(table.customerId, table.createdAt),
  idxOrderBusiness: index("idx_orders_business").on(table.businessId, table.status),
  idxOrderStatus: index("idx_orders_status").on(table.status, table.createdAt),
  idxOrderInfluencer: index("idx_orders_influencer").on(table.attributedInfluencerId),
}));

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

  type: text("type").notNull(), // 'earn' | 'redeem' | 'reversal'
  points: integer("points").notNull(),
  dollarAmountCents: integer("dollar_amount_cents").notNull(),

  businessId: varchar("business_id", { length: 36 }),
  businessName: text("business_name"),

  referenceType: text("reference_type"), // 'booking' | 'order' | 'referral' | 'shoot_booking' | 'appointment'
  referenceId: varchar("reference_id", { length: 36 }),

  balanceAfter: integer("balance_after").notNull(),
  description: text("description"),
  
  // Per-transaction cap tracking (5,000 max points per transaction)
  capped: boolean("capped").default(false).notNull(),

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
   BOOKING AUDIT LOG (State Machine History)
===================================================== */
export const bookingAuditLog = pgTable("booking_audit_log", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  // Reference to the booking (appointment or shoot_booking)
  bookingType: text("booking_type").notNull(), // 'appointment' | 'shoot_booking'
  bookingId: varchar("booking_id", { length: 36 }).notNull(),
  
  // State transition
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  
  // Actor: who triggered this transition
  triggeredBy: varchar("triggered_by", { length: 36 }), // userId, 'system', or 'stripe'
  triggerSource: text("trigger_source").notNull(), // 'api', 'webhook', 'cron', 'admin'
  
  // Additional context
  metadata: jsonb("metadata").$type<{
    reason?: string;
    stripePaymentIntentId?: string;
    stripeEventId?: string;
    clientIp?: string;
    userAgent?: string;
  }>(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  bookingIdx: index("idx_booking_audit_booking").on(table.bookingType, table.bookingId),
  triggeredByIdx: index("idx_booking_audit_triggered_by").on(table.triggeredBy),
}));

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
}, (table) => ({
  idxCartUser: index("idx_cart_items_user").on(table.userId),
}));

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

  // Max active staff members allowed on this tier. NULL = uncapped (no limit).
  maxStaff: integer("max_staff"),

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
   AVAILABILITY SLOTS (Businesses + Photographers) - Legacy
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
   WEEKLY AVAILABILITY (Recurring Weekly Slots)
   Works for BOTH photographers and businesses
===================================================== */
export const weeklyAvailability = pgTable("weekly_availability", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  // Provider discriminator: "business" or "photographer"
  providerType: text("provider_type").notNull(), // "business" | "photographer"
  providerId: varchar("provider_id", { length: 36 }).notNull(),

  // For businesses, optionally link to a specific staff member
  staffMemberId: varchar("staff_member_id", { length: 36 }),

  // Day of week: 0 = Sunday, 6 = Saturday
  dayOfWeek: integer("day_of_week").notNull(),

  // Time range for this day (24hr format: "09:00", "17:00")
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),

  // Whether this slot is active
  isActive: boolean("is_active").default(true).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Index for fast lookups by provider
  providerIdx: index("idx_weekly_availability_provider").on(table.providerType, table.providerId),
  // Index for staff-specific availability
  staffIdx: index("idx_weekly_availability_staff").on(table.staffMemberId),
}));

/* =====================================================
   PROVIDER BLOCKS (Timestamp-based Blocked Periods)
   Unified blocking system for both provider types
===================================================== */
export const providerBlocks = pgTable("provider_blocks", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  // Provider discriminator: "business" or "photographer"
  providerType: text("provider_type").notNull(), // "business" | "photographer"
  providerId: varchar("provider_id", { length: 36 }).notNull(),

  // For businesses, optionally link to a specific staff member
  staffMemberId: varchar("staff_member_id", { length: 36 }),

  // Full timestamp range for the block (supports multi-day and partial-day blocks)
  startAt: timestamp("start_at").notNull(),
  endAt: timestamp("end_at").notNull(),

  // Block type for UI/display purposes
  blockType: text("block_type").default("custom").notNull(), // "full_day" | "partial" | "multi_day" | "vacation" | "custom"

  // Optional metadata
  reason: text("reason"), // "Vacation", "Personal", "Holiday", etc.
  title: text("title"), // Display title for the block

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Index for fast lookups by provider and date range
  providerDateIdx: index("idx_provider_blocks_provider_dates").on(table.providerType, table.providerId, table.startAt, table.endAt),
  // Index for staff-specific blocks
  staffBlockIdx: index("idx_provider_blocks_staff").on(table.staffMemberId),
}));

/* =====================================================
   BOOKING HOLDS (Temporary Reservation Lock)
   Auto-expiring holds that block availability for other users
===================================================== */
export const bookingHolds = pgTable("booking_holds", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  // Provider discriminator: "business" or "photographer"
  providerType: text("provider_type").notNull(), // "business" | "photographer"
  providerId: varchar("provider_id", { length: 36 }).notNull(),

  // For businesses, optionally link to a specific staff member
  staffMemberId: varchar("staff_member_id", { length: 36 }),

  // User holding this slot
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),

  // Service being held
  serviceId: varchar("service_id", { length: 36 }).notNull(),
  serviceName: text("service_name").notNull(),
  servicePriceCents: integer("service_price_cents").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),

  // Time slot being held (full timestamps for precision)
  holdDate: text("hold_date").notNull(), // YYYY-MM-DD
  startTime: text("start_time").notNull(), // HH:MM (24hr)
  endTime: text("end_time").notNull(), // HH:MM (24hr)
  startAt: timestamp("start_at").notNull(), // Full timestamp for overlap checks
  endAt: timestamp("end_at").notNull(), // Full timestamp for overlap checks

  // Hold lifecycle
  status: text("status").default("active").notNull(), // "active" | "converted" | "expired" | "released"
  expiresAt: timestamp("expires_at").notNull(),

  // If converted to a booking, store the reference
  convertedToBookingId: varchar("converted_to_booking_id", { length: 36 }),
  convertedToBookingType: text("converted_to_booking_type"), // "appointment" | "shoot_booking"

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Index for finding active holds by provider
  providerActiveIdx: index("idx_booking_holds_provider_active").on(table.providerType, table.providerId, table.status),
  // Index for finding holds by user
  userIdx: index("idx_booking_holds_user").on(table.userId, table.status),
  // Index for expiry cleanup job
  expiryIdx: index("idx_booking_holds_expiry").on(table.status, table.expiresAt),
  // Index for overlap checks
  overlapIdx: index("idx_booking_holds_overlap").on(table.providerType, table.providerId, table.startAt, table.endAt, table.status),
}));

export const insertBookingHoldSchema = createInsertSchema(bookingHolds).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  convertedToBookingId: true,
  convertedToBookingType: true,
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
   ADMIN ISSUES
===================================================== */
export const adminIssues = pgTable("admin_issues", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  area: text("area").notNull(),
  severity: text("severity").default("medium").notNull(), // 'low' | 'medium' | 'high'
  status: text("status").default("open").notNull(), // 'open' | 'resolved'
  createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
});

export const insertAdminIssueSchema = createInsertSchema(adminIssues).omit({
  id: true, createdAt: true, resolvedAt: true, status: true
});
export type AdminIssue = typeof adminIssues.$inferSelect;
export type InsertAdminIssue = z.infer<typeof insertAdminIssueSchema>;

/* =====================================================
   FEED POSTS
===================================================== */
export const feedPosts = pgTable("feed_posts", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  authorId: varchar("author_id", { length: 36 }).notNull().references(() => users.id),
  authorType: text("author_type").notNull(), // 'customer', 'vendor', 'photographer'

  postType: text("post_type").default("text").notNull(), // 'text', 'product', 'service'
  postIntent: text("post_intent").default("social").notNull(), // 'social', 'review', 'promotion'
  displayLayout: text("display_layout"), // 'pro' | 'pulse' - optional, null if not specified (legacy)
  feedSurface: text("feed_surface"), // 'pulse' | 'pro' - SOURCE OF TRUTH for which feed post belongs to

  content: text("content").notNull(),
  imageUrl: text("image_url"), // Legacy field, use mediaUrl for new posts

  mediaUrl: text("media_url"),
  mediaType: text("media_type"), // 'image' | 'video'
  thumbnailUrl: text("thumbnail_url"), // Video poster image
  mediaWidth: integer("media_width"),
  mediaHeight: integer("media_height"),
  aspectRatio: doublePrecision("aspect_ratio"),

  taggedBusinessId: varchar("tagged_business_id", { length: 36 }).references(() => businesses.id),
  taggedPhotographerId: varchar("tagged_photographer_id", { length: 36 }).references(() => photographers.id),

  productId: varchar("product_id", { length: 36 }).references(() => vendorProducts.id),
  serviceId: varchar("service_id", { length: 36 }).references(() => vendorServices.id),
  photographerServiceId: varchar("photographer_service_id", { length: 36 }).references(() => photographerServices.id),

  likesCount: integer("likes_count").default(0),
  commentsCount: integer("comments_count").default(0),

  isActive: boolean("is_active").default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  idxFeedActive: index("idx_feed_posts_active").on(table.isActive, table.createdAt),
  idxFeedSurface: index("idx_feed_posts_surface").on(table.feedSurface, table.isActive, table.createdAt),
  idxFeedAuthor: index("idx_feed_posts_author").on(table.authorId, table.createdAt),
  idxFeedMediaType: index("idx_feed_posts_media_type").on(table.mediaType, table.feedSurface, table.isActive),
}));

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

/* =====================================================
   PULSE FEED SYSTEM (TikTok-style Discovery)
===================================================== */

// Pulse engagements - tracks user interactions with posts for ranking
export const pulseEngagements = pgTable("pulse_engagements", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
  postId: varchar("post_id", { length: 36 }).notNull().references(() => feedPosts.id),

  // Primary signals (highest weight)
  watchTimeMs: integer("watch_time_ms").default(0).notNull(), // Total time spent watching
  completionRate: doublePrecision("completion_rate").default(0), // 0.0 - 1.0 (percentage watched)
  rewatchCount: integer("rewatch_count").default(0).notNull(), // Number of times user rewatched

  // Secondary signals
  shared: boolean("shared").default(false).notNull(),
  saved: boolean("saved").default(false).notNull(),

  // Tracking
  impressionAt: timestamp("impression_at").defaultNow().notNull(),
  lastInteractionAt: timestamp("last_interaction_at").defaultNow().notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Post distribution - tracks cold start and tier escalation
export const postDistribution = pgTable("post_distribution", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  postId: varchar("post_id", { length: 36 }).notNull().references(() => feedPosts.id).unique(),

  // Current distribution tier (1-4)
  currentTier: integer("current_tier").default(1).notNull(),

  // Impression counts per tier
  impressionsTier1: integer("impressions_tier1").default(0).notNull(), // ~1k target
  impressionsTier2: integer("impressions_tier2").default(0).notNull(), // ~10k target
  impressionsTier3: integer("impressions_tier3").default(0).notNull(), // ~50k target
  impressionsTier4: integer("impressions_tier4").default(0).notNull(), // unlimited

  // Performance metrics (aggregated)
  avgWatchTimeMs: integer("avg_watch_time_ms").default(0),
  avgCompletionRate: doublePrecision("avg_completion_rate").default(0),
  totalRewatches: integer("total_rewatches").default(0),
  totalShares: integer("total_shares").default(0),
  totalSaves: integer("total_saves").default(0),

  // Tier advancement tracking
  tierAdvancedAt: timestamp("tier_advanced_at"),
  coldStartEndsAt: timestamp("cold_start_ends_at"), // 30-90 min after first impression
  
  // Status
  isActive: boolean("is_active").default(true).notNull(), // false if post failed to advance

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// User interests - behavior-based clustering for feed personalization
export const userInterests = pgTable("user_interests", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id).unique(),

  // Interest vector - JSON object mapping category/tag to weight (0.0 - 1.0)
  // Example: { "photography": 0.8, "food": 0.6, "music": 0.4 }
  interestVector: jsonb("interest_vector").default({}).notNull(),

  // Engagement history for time decay
  // Stores recent interactions: [{ postId, category, action, weight, timestamp }]
  recentEngagements: jsonb("recent_engagements").default([]).notNull(),

  // Statistics
  totalWatched: integer("total_watched").default(0).notNull(),
  totalSkipped: integer("total_skipped").default(0).notNull(),
  totalShared: integer("total_shared").default(0).notNull(),
  totalSaved: integer("total_saved").default(0).notNull(),

  lastUpdated: timestamp("last_updated").defaultNow().notNull(),
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

export const insertPhotographerBlackoutDateSchema = createInsertSchema(photographerBlackoutDates).omit({
  id: true,
  createdAt: true,
});

export const updatePhotographerAvailabilitySettingsSchema = z.object({
  hoursOfOperation: z.record(hoursOfOperationDaySchema).optional(),
  travelBufferMinutes: z.number().min(0).max(180).optional(),
  serviceRadiusMiles: z.number().min(1).max(200).optional(),
  serviceLocations: z.array(z.object({
    name: z.string(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    isStudio: z.boolean().optional(),
  })).optional(),
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

// Weekly Availability schemas
export const insertWeeklyAvailabilitySchema = createInsertSchema(weeklyAvailability).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateWeeklyAvailabilitySchema = z.object({
  dayOfWeek: z.number().min(0).max(6).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  isActive: z.boolean().optional(),
});

// Provider Blocks schemas
export const insertProviderBlockSchema = createInsertSchema(providerBlocks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateProviderBlockSchema = z.object({
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  blockType: z.enum(["full_day", "partial", "multi_day", "vacation", "custom"]).optional(),
  reason: z.string().optional(),
  title: z.string().optional(),
});

export const insertStaffInviteSchema = createInsertSchema(staffInvites).omit({
  id: true,
  createdAt: true,
  acceptedAt: true,
  sentAt: true,
  inviteCode: true,
});

export const insertStaffServiceSchema = createInsertSchema(staffServices).omit({
  id: true,
  createdAt: true,
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
  hoursOfOperation: z.record(z.string(), hoursOfOperationDaySchema).optional(),
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
  hoursOfOperation: z.record(z.string(), hoursOfOperationDaySchema).optional(),
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

// Pulse feed system schemas
export const insertPulseEngagementSchema = createInsertSchema(pulseEngagements).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPostDistributionSchema = createInsertSchema(postDistribution).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertUserInterestsSchema = createInsertSchema(userInterests).omit({
  id: true,
  createdAt: true,
});

export const insertShipmentSchema = createInsertSchema(shipments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertBookingAuditLogSchema = createInsertSchema(bookingAuditLog).omit({
  id: true,
  createdAt: true,
});

// Booking draft creation schema (for appointments)
export const createAppointmentDraftSchema = z.object({
  businessId: z.string().min(1),
  serviceId: z.string().min(1),
  staffMemberId: z.string().optional(),
  appointmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  appointmentTime: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM"),
});

// Booking draft creation schema (for photographer shoots)
export const createShootDraftSchema = z.object({
  photographerId: z.string().min(1),
  serviceId: z.string().optional(),
  shootType: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM"),
  durationHours: z.number().min(1).max(12),
  locationType: z.string().optional(),
  locationDetails: z.string().optional(),
  specialRequests: z.string().optional(),
});

/* =====================================================
   SIGNUP SCHEMAS
===================================================== */
export const customerSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores").optional(),
  phone: z.string().optional(),
  // Home address
  address: z.string().optional(), // street address
  aptUnit: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  country: z.string().optional(),
  // Billing address
  billingSameAsHome: z.boolean().default(true),
  billingStreet: z.string().optional(),
  billingAptUnit: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingZip: z.string().optional(),
  billingCountry: z.string().optional(),
  // Profile
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
  // Optional: auto-accept a staff invite at signup time
  inviteCode: z.string().optional(),
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
  isMultiStaff: z.boolean().optional(),
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
  logoImage: z.string().optional(), // business profile photo / logo URL
  username: z.string().optional(),
  billingAddress: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingZipCode: z.string().optional(),
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

export type InsertPhotographerBlackoutDate = z.infer<typeof insertPhotographerBlackoutDateSchema>;
export type PhotographerBlackoutDate = typeof photographerBlackoutDates.$inferSelect;

export type UpdatePhotographerAvailabilitySettings = z.infer<typeof updatePhotographerAvailabilitySettingsSchema>;

export type InsertStaffMember = z.infer<typeof insertStaffMemberSchema>;
export type StaffMember = typeof staffMembers.$inferSelect;
export type UpdateStaffMember = z.infer<typeof updateStaffMemberSchema>;

export type InsertStaffAvailability = z.infer<typeof insertStaffAvailabilitySchema>;
export type StaffAvailability = typeof staffAvailability.$inferSelect;

export type InsertWeeklyAvailability = z.infer<typeof insertWeeklyAvailabilitySchema>;
export type WeeklyAvailability = typeof weeklyAvailability.$inferSelect;
export type UpdateWeeklyAvailability = z.infer<typeof updateWeeklyAvailabilitySchema>;

export type InsertProviderBlock = z.infer<typeof insertProviderBlockSchema>;
export type ProviderBlock = typeof providerBlocks.$inferSelect;
export type UpdateProviderBlock = z.infer<typeof updateProviderBlockSchema>;

export type InsertBookingHold = z.infer<typeof insertBookingHoldSchema>;
export type BookingHold = typeof bookingHolds.$inferSelect;

export type InsertStaffInvite = z.infer<typeof insertStaffInviteSchema>;
export type StaffInvite = typeof staffInvites.$inferSelect;

export type InsertCity = z.infer<typeof insertCitySchema>;
export type City = typeof cities.$inferSelect;

export type RefreshToken = typeof refreshTokens.$inferSelect;

export type Photographer = typeof photographers.$inferSelect;

export type StaffService = typeof staffServices.$inferSelect;
export type InsertStaffService = typeof staffServices.$inferInsert;

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

export type BookingAuditLog = typeof bookingAuditLog.$inferSelect;
export type InsertBookingAuditLog = z.infer<typeof insertBookingAuditLogSchema>;

export type CreateAppointmentDraft = z.infer<typeof createAppointmentDraftSchema>;
export type CreateShootDraft = z.infer<typeof createShootDraftSchema>;

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

// Pulse feed system types
export type PulseEngagement = typeof pulseEngagements.$inferSelect;
export type InsertPulseEngagement = z.infer<typeof insertPulseEngagementSchema>;

export type PostDistribution = typeof postDistribution.$inferSelect;
export type InsertPostDistribution = z.infer<typeof insertPostDistributionSchema>;

export type UserInterests = typeof userInterests.$inferSelect;
export type InsertUserInterests = z.infer<typeof insertUserInterestsSchema>;

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
   INFLUENCER TRACKING — LINK CLICKS & ATTRIBUTION EVENTS
===================================================== */
export const influencerTrackingEvents = pgTable("influencer_tracking_events", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  influencerId: varchar("influencer_id", { length: 36 }).notNull().references(() => influencerProfiles.id),
  campaignId: varchar("campaign_id", { length: 36 }),

  eventType: text("event_type").notNull(), // 'link_click' | 'app_download' | 'signup' | 'first_purchase' | 'repeat_purchase'

  // Attribution context
  attributedUserId: varchar("attributed_user_id", { length: 36 }), // user who performed the action
  orderId: varchar("order_id", { length: 36 }),
  orderTotalCents: integer("order_total_cents"),

  // Source tracking
  utmSource: text("utm_source"), // instagram, tiktok, twitter, youtube
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  refCode: text("ref_code"), // the influencer's unique referral code used

  // Device / platform
  deviceType: text("device_type"), // mobile, desktop, tablet
  platform: text("platform"), // ios, android, web
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),

  // Points awarded for this event
  pointsAwarded: integer("points_awarded").default(0),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInfluencerTrackingEventSchema = createInsertSchema(influencerTrackingEvents).omit({ id: true, createdAt: true });
export type InfluencerTrackingEvent = typeof influencerTrackingEvents.$inferSelect;
export type InsertInfluencerTrackingEvent = z.infer<typeof insertInfluencerTrackingEventSchema>;

/* =====================================================
   INFLUENCER TRACKING — ATTRIBUTION WINDOW (first-click, 30-day)
===================================================== */
export const influencerAttributions = pgTable("influencer_attributions", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
  influencerId: varchar("influencer_id", { length: 36 }).notNull().references(() => influencerProfiles.id),
  refCode: text("ref_code").notNull(),

  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),

  firstClickAt: timestamp("first_click_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(), // 30-day attribution window

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInfluencerAttributionSchema = createInsertSchema(influencerAttributions).omit({ id: true, createdAt: true });
export type InfluencerAttribution = typeof influencerAttributions.$inferSelect;
export type InsertInfluencerAttribution = z.infer<typeof insertInfluencerAttributionSchema>;

/* =====================================================
   INFLUENCER TIERS — Configurable tier + commission table
===================================================== */
export const influencerTiers = pgTable("influencer_tiers", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  name: text("name").notNull().unique(), // bronze, silver, gold, elite
  displayName: text("display_name").notNull(),

  minConversionRate: doublePrecision("min_conversion_rate").notNull(), // e.g. 0.0 for bronze
  maxConversionRate: doublePrecision("max_conversion_rate"), // null = unlimited (elite)

  commissionBps: integer("commission_bps").notNull(), // basis points, e.g. 500 = 5%
  pointMultiplier: doublePrecision("point_multiplier").default(1.0), // tier-based point boost

  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInfluencerTierSchema = createInsertSchema(influencerTiers).omit({ id: true, createdAt: true });
export type InfluencerTier = typeof influencerTiers.$inferSelect;
export type InsertInfluencerTier = z.infer<typeof insertInfluencerTierSchema>;

/* =====================================================
   INFLUENCER STATS — Per-influencer aggregate + tier assignment
===================================================== */
export const influencerStats = pgTable("influencer_stats", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  influencerId: varchar("influencer_id", { length: 36 }).notNull().unique().references(() => influencerProfiles.id),

  totalClicks: integer("total_clicks").default(0).notNull(),
  totalDownloads: integer("total_downloads").default(0).notNull(),
  totalSignups: integer("total_signups").default(0).notNull(),
  totalFirstPurchases: integer("total_first_purchases").default(0).notNull(),
  totalRepeatPurchases: integer("total_repeat_purchases").default(0).notNull(),
  totalPurchases: integer("total_purchases").default(0).notNull(),
  totalRevenueCents: integer("total_revenue_cents").default(0).notNull(),

  // Conversion metrics
  conversionRate: doublePrecision("conversion_rate").default(0).notNull(), // (purchases / clicks) * 100
  rollingAvgConversionRate: doublePrecision("rolling_avg_conversion_rate").default(0).notNull(),
  rollingWindowPostCount: integer("rolling_window_post_count").default(0).notNull(), // posts in current window
  rollingWindowStartDate: timestamp("rolling_window_start_date"),

  // Points & commission
  totalPoints: integer("total_points").default(0).notNull(),
  totalCommissionEarnedCents: integer("total_commission_earned_cents").default(0).notNull(),
  pendingCommissionCents: integer("pending_commission_cents").default(0).notNull(),

  // Current tier
  tierId: varchar("tier_id", { length: 36 }).references(() => influencerTiers.id),
  tierChangedAt: timestamp("tier_changed_at"),
  previousTierId: varchar("previous_tier_id", { length: 36 }),
  tierChangeFlag: boolean("tier_change_flag").default(false), // flag for admin review

  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInfluencerStatsSchema = createInsertSchema(influencerStats).omit({ id: true, updatedAt: true });
export type InfluencerStats = typeof influencerStats.$inferSelect;
export type InsertInfluencerStats = z.infer<typeof insertInfluencerStatsSchema>;

/* =====================================================
   INFLUENCER POINT CONFIG — Configurable point values per event
===================================================== */
export const influencerPointConfig = pgTable("influencer_point_config", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  eventType: text("event_type").notNull().unique(), // app_download, signup, first_purchase, repeat_purchase
  pointsAwarded: integer("points_awarded").notNull(),
  description: text("description"),

  isActive: boolean("is_active").default(true),

  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type InfluencerPointConfig = typeof influencerPointConfig.$inferSelect;

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
  
  // User ID for profile navigation (for businesses and photographers)
  userId: varchar("user_id", { length: 36 }),
  
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
  
  // Demo/seed data flag - hidden from non-admin users in search
  isDemo: boolean("is_demo").default(false).notNull(),
  
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

/* =====================================================
   PHASE 3 — FEED ENGAGEMENT TRACKING
===================================================== */
export const feedEngagementEvents = pgTable("feed_engagement_events", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
  postId: varchar("post_id", { length: 36 }).notNull().references(() => feedPosts.id),
  eventType: text("event_type").notNull(), // 'audio_unmute' | 'audio_mute' | 'cta_click' | 'share' | 'view'
  metadata: jsonb("metadata").$type<Record<string, string>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  idxEngagementPost: index("idx_feed_engagement_post").on(table.postId, table.eventType),
  idxEngagementUser: index("idx_feed_engagement_user").on(table.userId, table.postId),
}));

export const userSavedPosts = pgTable("user_saved_posts", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
  postId: varchar("post_id", { length: 36 }).notNull().references(() => feedPosts.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  idxSavedUnique: unique("idx_user_saved_posts_unique").on(table.userId, table.postId),
}));

/* =====================================================
   PHASE 3 — SPONSORED POSTS
===================================================== */
export const sponsoredPosts = pgTable("sponsored_posts", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => users.id),
  postId: varchar("post_id", { length: 36 }).notNull().references(() => feedPosts.id),
  budgetCents: integer("budget_cents").notNull(),
  spentCents: integer("spent_cents").default(0).notNull(),
  cpm: integer("cpm").notNull(), // cost per 1000 impressions in cents
  impressions: integer("impressions").default(0).notNull(),
  clicks: integer("clicks").default(0).notNull(),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  status: text("status").default("active").notNull(), // 'active' | 'paused' | 'ended'
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  idxSponsoredStatus: index("idx_sponsored_status").on(table.status, table.startDate, table.endDate),
}));

/* =====================================================
   PHASE 3 — VENDOR ONBOARDING EMAIL SEQUENCE
===================================================== */
export const vendorEmailSequence = pgTable("vendor_email_sequence", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  vendorId: varchar("vendor_id", { length: 36 }).notNull().references(() => users.id),
  sequenceStep: integer("sequence_step").default(0).notNull(),
  lastSentAt: timestamp("last_sent_at"),
  completed: boolean("completed").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   PHASE 3 — CONTENT MODERATION QUEUE
===================================================== */
export const moderationQueue = pgTable("moderation_queue", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  reporterId: varchar("reporter_id", { length: 36 }).notNull().references(() => users.id),
  targetId: varchar("target_id", { length: 36 }).notNull(),
  targetType: text("target_type").notNull(), // 'post' | 'user'
  reason: text("reason").notNull(),
  status: text("status").default("pending").notNull(), // 'pending' | 'reviewed' | 'actioned'
  adminAction: text("admin_action"), // 'remove' | 'warn' | 'ban' | 'dismiss'
  adminNotes: text("admin_notes"),
  reviewedBy: varchar("reviewed_by", { length: 36 }),
  reviewedAt: timestamp("reviewed_at"),
  flagCount: integer("flag_count").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  idxModerationStatus: index("idx_moderation_status").on(table.status, table.flagCount),
}));
