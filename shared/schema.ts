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

  stripeAccountId: text("stripe_account_id").notNull(),

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

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").default("pending"), // pending, paid, shipped, delivered, cancelled

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
