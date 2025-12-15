import {
  pgTable, text, varchar, boolean, integer, jsonb, timestamp, index
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
   USERS (Clients, Vendors, Photographers, Admins)
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
  isAdmin: boolean("is_admin").default(false).notNull(),

  loyaltyPoints: integer("loyalty_points").default(0).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   BUSINESSES (LEGAL SELLERS)
===================================================== */
export const businesses = pgTable("businesses", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  ownerId: varchar("owner_id", { length: 36 }).notNull().references(() => users.id),

  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description"),

  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),

  websiteUrl: text("website_url"),
  socialMedia: text("social_media"),

  hasProducts: boolean("has_products").default(false),
  hasServices: boolean("has_services").default(false),

  /* 🔑 STRIPE CONNECT (KEY ADDITION) */
  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   BUSINESS SERVICES (WHAT CAN BE BOOKED)
===================================================== */
export const vendorServices = pgTable("vendor_services", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  businessId: varchar("business_id", { length: 36 })
    .notNull()
    .references(() => businesses.id),

  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(), // cents
  durationMinutes: integer("duration_minutes").notNull(),

  isActive: boolean("is_active").default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   APPOINTMENTS (CONFIRMED SERVICE BOOKINGS)
===================================================== */
export const appointments = pgTable("appointments", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  businessId: varchar("business_id", { length: 36 })
    .notNull()
    .references(() => businesses.id),

  serviceId: varchar("service_id", { length: 36 })
    .notNull()
    .references(() => vendorServices.id),

  clientId: varchar("client_id", { length: 36 })
    .notNull()
    .references(() => users.id),

  appointmentDate: text("appointment_date").notNull(),
  appointmentTime: text("appointment_time").notNull(),

  totalPrice: integer("total_price").notNull(),
  platformFee: integer("platform_fee").default(0),
  vendorNet: integer("vendor_net").default(0),

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").default("pending"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   PRODUCTS (BUSINESS INVENTORY)
===================================================== */
export const vendorProducts = pgTable("vendor_products", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  businessId: varchar("business_id", { length: 36 })
    .notNull()
    .references(() => businesses.id),

  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(), // cents
  inventory: integer("inventory").default(0),

  isActive: boolean("is_active").default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   ORDERS (CONFIRMED PRODUCT PURCHASES)
===================================================== */
export const orders = pgTable("orders", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  businessId: varchar("business_id", { length: 36 })
    .notNull()
    .references(() => businesses.id),

  customerId: varchar("customer_id", { length: 36 })
    .notNull()
    .references(() => users.id),

  items: jsonb("items").$type<{
    productId: string;
    name: string;
    quantity: number;
    price: number;
  }[]>().notNull(),

  totalAmount: integer("total_amount").notNull(),
  platformFee: integer("platform_fee").default(0),
  vendorNet: integer("vendor_net").default(0),

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").default("pending"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   PHOTOGRAPHERS (SEPARATE PROVIDERS)
===================================================== */
export const photographers = pgTable("photographers", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),

  userId: varchar("user_id", { length: 36 })
    .notNull()
    .references(() => users.id),

  displayName: text("display_name").notNull(),
  bio: text("bio"),
  hourlyRate: integer("hourly_rate").notNull(),

  /* 🔑 STRIPE CONNECT */
  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =====================================================
   SHOOT BOOKINGS (PHOTOGRAPHER BOOKINGS)
===================================================== */
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

  totalPrice: integer("total_price").notNull(),
  platformFee: integer("platform_fee").default(0),
  photographerNet: integer("photographer_net").default(0),

  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").default("pending"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});
