import { 
  pgTable, text, varchar, boolean, integer, jsonb, timestamp, index 
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";


// =========================================
// SESSION STORAGE TABLE (Required for secure auth)
// =========================================
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);


// =========================================
// USERS TABLE (Clients + Photographers + Businesses)
// =========================================
export const users = pgTable("users", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").unique(),
  password: text("password"), // Optional for OAuth users
  name: text("name"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  profileImageUrl: text("profile_image_url"),
  phone: text("phone"),
  isVendor: boolean("is_vendor").default(false).notNull(),
  isPhotographer: boolean("is_photographer").default(false).notNull(),
  isAdmin: boolean("is_admin").default(false).notNull(),
  
  // OAuth flags
  isOAuthUser: boolean("is_oauth_user").default(false),

  // Location fields
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),

  // Demographics
  ageRange: text("age_range"),
  gender: text("gender"),
  ethnicity: text("ethnicity"),
  nationality: text("nationality"),
  householdSize: text("household_size"),
  incomeRange: text("income_range"),
  education: text("education"),
  occupation: text("occupation"),
  shoppingFrequency: text("shopping_frequency"),

  // Preferences
  selectedIndustries: jsonb("selected_industries").$type<string[]>().default([]),
  industryNiches: jsonb("industry_niches").$type<Record<string, string[]>>().default({}),
  industryValues: jsonb("industry_values").$type<Record<string, string[]>>().default({}),

  // Outsyde Points (loyalty program)
  // $1 = 100 points, redeemable at any Outsyde business
  loyaltyPoints: integer("loyalty_points").default(0).notNull(),

  // Referral system
  referralCode: text("referral_code").unique(),
  referredBy: varchar("referred_by", { length: 36 }).references(() => users.id),
});


// =========================================
// EXISTING BUSINESSES TABLE (Marketplace Vendors)
// =========================================
export const businesses = pgTable("businesses", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  ownerId: varchar("owner_id", { length: 36 }).notNull().references(() => users.id),

  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description"),

  // Business details
  isStartup: boolean("is_startup").default(false),
  yearsInBusiness: text("years_in_business"),
  employeeCount: text("employee_count"),
  businessType: text("business_type"),

  // Location
  hasPhysicalLocation: boolean("has_physical_location").default(true),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),

  // Online presence
  websiteUrl: text("website_url"),
  socialMedia: text("social_media"),

  // Media
  coverImage: text("cover_image"),
  logoImage: text("logo_image"),

  // Ratings
  rating: integer("rating").default(0),
  reviewCount: integer("review_count").default(0),

  // Subscription
  subscriptionActive: boolean("subscription_active").default(false),

  // Storefront customization
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

  // Feature flags
  hasProducts: boolean("has_products").default(false),
  hasServices: boolean("has_services").default(false),
});


// =========================================
// VENDOR PRODUCTS TABLE (For marketplace vendors)
// =========================================
export const vendorProducts = pgTable("vendor_products", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  businessId: varchar("business_id", { length: 36 })
    .notNull()
    .references(() => businesses.id),

  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(), // in cents
  compareAtPrice: integer("compare_at_price"), // original price for sales
  
  imageUrl: text("image_url"),
  images: jsonb("images").$type<string[]>().default([]),
  
  category: text("category"),
  tags: text("tags").array(),
  
  inventory: integer("inventory").default(0),
  trackInventory: boolean("track_inventory").default(true),
  
  isActive: boolean("is_active").default(true),
  isFeatured: boolean("is_featured").default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =========================================
// VENDOR SERVICES TABLE (For service-based vendors)
// =========================================
export const vendorServices = pgTable("vendor_services", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  businessId: varchar("business_id", { length: 36 })
    .notNull()
    .references(() => businesses.id),

  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(), // in cents
  durationMinutes: integer("duration_minutes").notNull(),
  
  category: text("category"),
  
  isActive: boolean("is_active").default(true),
  isFeatured: boolean("is_featured").default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =========================================
// CITIES TABLE
// =========================================
export const cities = pgTable("cities", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  businessCount: integer("business_count").default(0),
  imageUrl: text("image_url"),
  trending: boolean("trending").default(false),
});


// =========================================
// REFRESH TOKENS TABLE
// =========================================
export const refreshTokens = pgTable("refresh_tokens", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
});


// =====================================================
// NEW: PHOTOGRAPHERS TABLE (Shoot-based service providers)
// =====================================================
export const photographers = pgTable("photographers", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  userId: varchar("user_id", { length: 36 })
    .notNull()
    .references(() => users.id),

  displayName: text("display_name").notNull(),
  bio: text("bio"),
  city: text("city"),
  state: text("state"),
  portfolioUrl: text("portfolio_url"),

  hourlyRate: integer("hourly_rate").notNull(),

  rating: integer("rating").default(0),
  reviewCount: integer("review_count").default(0),

  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false),
  specialties: text("specialties").array(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =====================================================
// NEW: SERVICE BUSINESSES (Barbers, Nail Techs, MUAs, etc.)
// =====================================================
export const serviceBusinesses = pgTable("service_businesses", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  ownerId: varchar("owner_id", { length: 36 })
    .notNull()
    .references(() => users.id),

  businessName: text("business_name").notNull(),
  category: text("category").notNull(), // nails, lashes, barber, etc.
  description: text("description"),

  address: text("address"),
  city: text("city"),
  state: text("state"),

  stripeAccountId: text("stripe_account_id").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =====================================================
// NEW: SERVICES TABLE (What service businesses offer)
// =====================================================
export const services = pgTable("services", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  businessId: varchar("business_id", { length: 36 })
    .notNull()
    .references(() => serviceBusinesses.id),

  title: text("title").notNull(),
  description: text("description"),
  price: integer("price").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =====================================================
// NEW: SHOOT BOOKINGS (PHOTOGRAPHERS ONLY)
// =====================================================
export const shootBookings = pgTable("shoot_bookings", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  photographerId: varchar("photographer_id", { length: 36 })
    .notNull()
    .references(() => photographers.id),

  clientId: varchar("client_id", { length: 36 })
    .notNull()
    .references(() => users.id),

  shootType: text("shoot_type").notNull(),

  date: text("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  durationHours: integer("duration_hours").notNull(),

  locationType: text("location_type"),  // studio / lifestyle
  locationDetails: text("location_details"),

  totalPrice: integer("total_price").notNull(),
  platformFee: integer("platform_fee").default(0),
  vendorNet: integer("vendor_net").default(0),

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").default("pending"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =====================================================
// NEW: APPOINTMENT BOOKINGS (BUSINESSES ONLY)
// =====================================================
export const appointments = pgTable("appointments", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  businessId: varchar("business_id", { length: 36 })
    .notNull()
    .references(() => serviceBusinesses.id),

  clientId: varchar("client_id", { length: 36 })
    .notNull()
    .references(() => users.id),

  serviceId: varchar("service_id", { length: 36 })
    .notNull()
    .references(() => services.id),

  appointmentDate: text("appointment_date").notNull(),
  appointmentTime: text("appointment_time").notNull(),

  totalPrice: integer("total_price").notNull(),
  platformFee: integer("platform_fee").default(0),
  vendorNet: integer("vendor_net").default(0),

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").default("pending"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =====================================================
// NEW: ORDERS (FOR PRODUCT BUSINESSES)
// =====================================================
export const orders = pgTable("orders", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  businessId: varchar("business_id", { length: 36 })
    .notNull()
    .references(() => businesses.id),

  customerId: varchar("customer_id", { length: 36 })
    .notNull()
    .references(() => users.id),

  items: jsonb("items").$type<{ productId: string; name: string; quantity: number; price: number }[]>().notNull(),
  totalAmount: integer("total_amount").notNull(),
  platformFee: integer("platform_fee").default(0),
  vendorNet: integer("vendor_net").default(0),

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").default("pending"), // pending, paid, shipped, delivered, cancelled, refunded, partially_refunded

  shippingAddress: text("shipping_address"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =====================================================
// NEW: VERIFIED REVIEWS (Only for customers with completed bookings/orders)
// =====================================================
export const reviews = pgTable("reviews", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  // Who is being reviewed
  targetType: text("target_type").notNull(), // 'photographer', 'service_business', 'business'
  targetId: varchar("target_id", { length: 36 }).notNull(),

  // Who is reviewing (must have completed booking/order)
  reviewerId: varchar("reviewer_id", { length: 36 })
    .notNull()
    .references(() => users.id),

  // What booking/order this review is for (verification)
  bookingType: text("booking_type").notNull(), // 'shoot_booking', 'appointment', 'order'
  bookingId: varchar("booking_id", { length: 36 }).notNull(),

  // Review content
  rating: integer("rating").notNull(), // 1-5 stars
  title: text("title"),
  comment: text("comment"),

  // Status
  isVerified: boolean("is_verified").default(true).notNull(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =========================================
// SCHEMAS FOR INSERTION (Zod)
// =========================================
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
});

export const insertBusinessSchema = createInsertSchema(businesses).omit({
  id: true,
  rating: true,
  reviewCount: true,
});

export const insertVendorProductSchema = createInsertSchema(vendorProducts).omit({
  id: true,
  createdAt: true,
});

export const insertVendorServiceSchema = createInsertSchema(vendorServices).omit({
  id: true,
  createdAt: true,
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

// Signup schemas
export const customerSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  ageRange: z.string().optional(),
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

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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


// =========================================
// OUTSYDE POINTS (Loyalty System)
// =========================================
// Points conversion: $1 = 100 points
// Example: $5 purchase = 500 points, $10 = 1000 points
// Redemption: Points can be used at any Outsyde business

export const pointTransactions = pgTable("point_transactions", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  userId: varchar("user_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  
  // Transaction type: 'earn' or 'redeem'
  type: text("type").notNull(), // 'earn' | 'redeem'
  
  // Amount of points (positive for earn, positive for redeem - we track direction via type)
  points: integer("points").notNull(),
  
  // Dollar amount associated (in cents for precision)
  // For earn: the purchase amount that generated these points
  // For redeem: the discount value applied
  dollarAmountCents: integer("dollar_amount_cents").notNull(),
  
  // Where the transaction occurred
  businessId: varchar("business_id", { length: 36 }),
  businessName: text("business_name"),
  
  // Reference to the order/booking that triggered this transaction
  referenceType: text("reference_type"), // 'order' | 'appointment' | 'shoot_booking'
  referenceId: varchar("reference_id", { length: 36 }),
  
  // Balance after this transaction
  balanceAfter: integer("balance_after").notNull(),
  
  // Description for display
  description: text("description"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPointTransactionSchema = createInsertSchema(pointTransactions).omit({
  id: true,
  createdAt: true,
});

export type PointTransaction = typeof pointTransactions.$inferSelect;
export type InsertPointTransaction = z.infer<typeof insertPointTransactionSchema>;

// =========================================
// CONVERSATIONS TABLE (Real-time Chat)
// =========================================
export const conversations = pgTable("conversations", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  participant1Id: varchar("participant1_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  participant2Id: varchar("participant2_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  
  lastMessageAt: timestamp("last_message_at").defaultNow(),
  lastMessagePreview: text("last_message_preview"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// =========================================
// MESSAGES TABLE (Real-time Chat)
// =========================================
export const messages = pgTable("messages", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  conversationId: varchar("conversation_id", { length: 36 })
    .notNull()
    .references(() => conversations.id),
  senderId: varchar("sender_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  
  content: text("content").notNull(),
  
  isRead: boolean("is_read").default(false).notNull(),
  readAt: timestamp("read_at"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
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

// =========================================
// TYPES
// =========================================
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// UpsertUser type for OAuth user creation/update
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

export type InsertCity = z.infer<typeof insertCitySchema>;
export type City = typeof cities.$inferSelect;

export type InsertRefreshToken = z.infer<typeof insertRefreshTokenSchema>;
export type RefreshToken = typeof refreshTokens.$inferSelect;

// New types
export type Photographer = typeof photographers.$inferSelect;
export type ServiceBusiness = typeof serviceBusinesses.$inferSelect;
export type Service = typeof services.$inferSelect;
export type ShootBooking = typeof shootBookings.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Review = typeof reviews.$inferSelect;

// Review insert schema with validation
export const insertReviewSchema = createInsertSchema(reviews).omit({
  id: true,
  createdAt: true,
  isVerified: true,
}).extend({
  rating: z.number().min(1).max(5),
});

export type InsertReview = z.infer<typeof insertReviewSchema>;

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;


// =========================================
// PUSH SUBSCRIPTIONS TABLE (Browser Push Notifications)
// =========================================
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  userId: varchar("user_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  
  // Web Push subscription data
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(), // Public key
  auth: text("auth").notNull(), // Auth secret
  
  // Device info
  userAgent: text("user_agent"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;


// =========================================
// CART ITEMS TABLE (Persistent Shopping Cart)
// =========================================
export const cartItems = pgTable("cart_items", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  userId: varchar("user_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  
  // Product info
  productId: varchar("product_id", { length: 36 }).notNull(),
  productName: text("product_name").notNull(),
  productImage: text("product_image"),
  priceInCents: integer("price_in_cents").notNull(),
  quantity: integer("quantity").notNull().default(1),
  
  // Vendor info
  businessId: varchar("business_id", { length: 36 }),
  businessName: text("business_name"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCartItemSchema = createInsertSchema(cartItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type CartItem = typeof cartItems.$inferSelect;
export type InsertCartItem = z.infer<typeof insertCartItemSchema>;


// =========================================
// VENDOR SUBSCRIPTION TIERS
// =========================================
// Access: $20/mo - Basic storefront, no included shoots
// Growth: $40/mo - 1 shoot/quarter, priority discovery, discounts
// Pro: $89/mo - 1 shoot/month + 1 influencer promo/quarter + featured

export const subscriptionTiers = pgTable("subscription_tiers", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  name: text("name").notNull(), // 'access', 'growth', 'pro'
  displayName: text("display_name").notNull(), // 'Access', 'Growth', 'Pro'
  description: text("description"),
  
  // Pricing (in cents)
  priceInCents: integer("price_in_cents").notNull(), // 2000, 4000, 8900
  
  // Platform fee in basis points (200 = 2%)
  platformFeeBps: integer("platform_fee_bps").default(200).notNull(),
  
  // Stripe product/price IDs
  stripeProductId: text("stripe_product_id"),
  stripePriceId: text("stripe_price_id"),
  
  // Features flags
  hasPriorityDiscovery: boolean("has_priority_discovery").default(false).notNull(),
  hasFeaturedPlacement: boolean("has_featured_placement").default(false).notNull(),
  hasInfluencerAccess: boolean("has_influencer_access").default(false).notNull(),
  hasCreativeSupport: boolean("has_creative_support").default(false).notNull(),
  
  // À la carte discount percentage (0, 10, 15 for Access, Growth, Pro)
  alaCarteDiscountPercent: integer("ala_carte_discount_percent").default(0).notNull(),
  
  // Sort order for display
  sortOrder: integer("sort_order").default(0).notNull(),
  
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =========================================
// TIER BENEFITS (What's included per tier)
// =========================================
export const tierBenefits = pgTable("tier_benefits", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  tierId: varchar("tier_id", { length: 36 })
    .notNull()
    .references(() => subscriptionTiers.id),
  
  // Benefit type
  benefitType: text("benefit_type").notNull(), // 'product_shoot', 'lifestyle_shoot', 'influencer_promo'
  displayName: text("display_name").notNull(),
  description: text("description"),
  
  // How many included per cycle
  includedQuantity: integer("included_quantity").notNull().default(1),
  
  // Cycle type: 'monthly' or 'quarterly'
  cycleType: text("cycle_type").notNull(), // 'monthly' | 'quarterly'
  
  // Can unused benefits roll over?
  allowRollover: boolean("allow_rollover").default(false).notNull(),
  
  // Does this require admin fulfillment?
  requiresAdminFulfillment: boolean("requires_admin_fulfillment").default(true).notNull(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =========================================
// À LA CARTE SERVICES (Purchasable by all tiers)
// =========================================
export const alaCarteServices = pgTable("ala_carte_services", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  name: text("name").notNull(), // 'product_shoot', 'lifestyle_shoot', 'influencer_promo'
  displayName: text("display_name").notNull(),
  description: text("description"),
  
  // Base price in cents (Access tier pays this)
  basePriceInCents: integer("base_price_in_cents").notNull(),
  
  // Stripe product/price IDs (base price)
  stripeProductId: text("stripe_product_id"),
  stripePriceId: text("stripe_price_id"),
  
  // Requires admin fulfillment
  requiresAdminFulfillment: boolean("requires_admin_fulfillment").default(true).notNull(),
  
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =========================================
// VENDOR SUBSCRIPTIONS (Active subscriptions)
// =========================================
export const vendorSubscriptions = pgTable("vendor_subscriptions", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  // Link to vendor/business
  vendorId: varchar("vendor_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  businessId: varchar("business_id", { length: 36 })
    .references(() => businesses.id),
  
  // Current tier
  tierId: varchar("tier_id", { length: 36 })
    .notNull()
    .references(() => subscriptionTiers.id),
  
  // Stripe subscription data
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  
  // Subscription status
  status: text("status").default("pending").notNull(), // 'pending', 'active', 'past_due', 'canceled', 'paused'
  
  // Billing cycle dates
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  
  // Quarterly tracking (for quarterly benefits)
  currentQuarterStart: timestamp("current_quarter_start"),
  currentQuarterEnd: timestamp("current_quarter_end"),
  
  cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});


// =========================================
// BENEFIT ALLOWANCES (Per-vendor benefit counters)
// =========================================
export const benefitAllowances = pgTable("benefit_allowances", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  subscriptionId: varchar("subscription_id", { length: 36 })
    .notNull()
    .references(() => vendorSubscriptions.id),
  
  benefitId: varchar("benefit_id", { length: 36 })
    .notNull()
    .references(() => tierBenefits.id),
  
  // Cycle this allowance is for
  cycleType: text("cycle_type").notNull(), // 'monthly' | 'quarterly'
  cycleStart: timestamp("cycle_start").notNull(),
  cycleEnd: timestamp("cycle_end").notNull(),
  
  // Quantities
  totalQuantity: integer("total_quantity").notNull(), // What they get this cycle
  usedQuantity: integer("used_quantity").default(0).notNull(),
  remainingQuantity: integer("remaining_quantity").notNull(),
  
  // Expired tracking
  isExpired: boolean("is_expired").default(false).notNull(),
  expiredAt: timestamp("expired_at"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =========================================
// BENEFIT USAGE (Consumption records)
// =========================================
export const benefitUsage = pgTable("benefit_usage", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  allowanceId: varchar("allowance_id", { length: 36 })
    .notNull()
    .references(() => benefitAllowances.id),
  
  // What was used
  benefitType: text("benefit_type").notNull(),
  quantityUsed: integer("quantity_used").default(1).notNull(),
  
  // Fulfillment tracking
  fulfillmentTaskId: varchar("fulfillment_task_id", { length: 36 }),
  
  // Notes
  notes: text("notes"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =========================================
// FULFILLMENT TASKS (Admin workflow)
// =========================================
export const fulfillmentTasks = pgTable("fulfillment_tasks", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  // Who requested
  vendorId: varchar("vendor_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  businessId: varchar("business_id", { length: 36 })
    .references(() => businesses.id),
  
  // What type of task
  taskType: text("task_type").notNull(), // 'product_shoot', 'lifestyle_shoot', 'influencer_promo'
  
  // Source: benefit allowance or à la carte purchase
  sourceType: text("source_type").notNull(), // 'benefit' | 'ala_carte'
  sourceId: varchar("source_id", { length: 36 }), // allowanceId or purchaseId
  
  // Status
  status: text("status").default("pending").notNull(), // 'pending', 'scheduled', 'in_progress', 'completed', 'cancelled'
  
  // Assignment
  assignedAdminId: varchar("assigned_admin_id", { length: 36 }),
  
  // Scheduling
  scheduledDate: timestamp("scheduled_date"),
  completedDate: timestamp("completed_date"),
  
  // Priority
  isPriority: boolean("is_priority").default(false).notNull(),
  
  // Notes
  vendorNotes: text("vendor_notes"),
  adminNotes: text("admin_notes"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});


// =========================================
// À LA CARTE PURCHASES
// =========================================
export const alaCartePurchases = pgTable("ala_carte_purchases", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  
  vendorId: varchar("vendor_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  businessId: varchar("business_id", { length: 36 })
    .references(() => businesses.id),
  
  serviceId: varchar("service_id", { length: 36 })
    .notNull()
    .references(() => alaCarteServices.id),
  
  // What tier they were on at time of purchase (for discount)
  tierIdAtPurchase: varchar("tier_id_at_purchase", { length: 36 }),
  
  // Pricing
  basePriceInCents: integer("base_price_in_cents").notNull(),
  discountPercent: integer("discount_percent").default(0).notNull(),
  finalPriceInCents: integer("final_price_in_cents").notNull(),
  
  // Platform fee
  platformFeeInCents: integer("platform_fee_in_cents").notNull(),
  
  // Stripe
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  
  // Status
  paymentStatus: text("payment_status").default("pending").notNull(), // 'pending', 'paid', 'failed', 'refunded'
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// =========================================
// SUBSCRIPTION SCHEMAS & TYPES
// =========================================
export const insertSubscriptionTierSchema = createInsertSchema(subscriptionTiers).omit({
  id: true,
  createdAt: true,
});

export const insertTierBenefitSchema = createInsertSchema(tierBenefits).omit({
  id: true,
  createdAt: true,
});

export const insertAlaCarteServiceSchema = createInsertSchema(alaCarteServices).omit({
  id: true,
  createdAt: true,
});

export const insertVendorSubscriptionSchema = createInsertSchema(vendorSubscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertBenefitAllowanceSchema = createInsertSchema(benefitAllowances).omit({
  id: true,
  createdAt: true,
});

export const insertBenefitUsageSchema = createInsertSchema(benefitUsage).omit({
  id: true,
  createdAt: true,
});

export const insertFulfillmentTaskSchema = createInsertSchema(fulfillmentTasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertAlaCartePurchaseSchema = createInsertSchema(alaCartePurchases).omit({
  id: true,
  createdAt: true,
});

// Types
export type SubscriptionTier = typeof subscriptionTiers.$inferSelect;
export type InsertSubscriptionTier = z.infer<typeof insertSubscriptionTierSchema>;

export type TierBenefit = typeof tierBenefits.$inferSelect;
export type InsertTierBenefit = z.infer<typeof insertTierBenefitSchema>;

export type AlaCarteService = typeof alaCarteServices.$inferSelect;
export type InsertAlaCarteService = z.infer<typeof insertAlaCarteServiceSchema>;

export type VendorSubscription = typeof vendorSubscriptions.$inferSelect;
export type InsertVendorSubscription = z.infer<typeof insertVendorSubscriptionSchema>;

export type BenefitAllowance = typeof benefitAllowances.$inferSelect;
export type InsertBenefitAllowance = z.infer<typeof insertBenefitAllowanceSchema>;

export type BenefitUsage = typeof benefitUsage.$inferSelect;
export type InsertBenefitUsage = z.infer<typeof insertBenefitUsageSchema>;

export type FulfillmentTask = typeof fulfillmentTasks.$inferSelect;
export type InsertFulfillmentTask = z.infer<typeof insertFulfillmentTaskSchema>;

export type AlaCartePurchase = typeof alaCartePurchases.$inferSelect;
export type InsertAlaCartePurchase = z.infer<typeof insertAlaCartePurchaseSchema>;
