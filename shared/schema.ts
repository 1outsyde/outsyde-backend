import { pgTable, text, varchar, boolean, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

// Users table - both customers and vendors
export const users = pgTable("users", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  isVendor: boolean("is_vendor").default(false).notNull(),
  
  // Location fields
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),
  
  // Demographics (customers only)
  ageRange: text("age_range"),
  gender: text("gender"),
  ethnicity: text("ethnicity"),
  nationality: text("nationality"),
  householdSize: text("household_size"),
  incomeRange: text("income_range"),
  education: text("education"),
  occupation: text("occupation"),
  shoppingFrequency: text("shopping_frequency"),
  
  // Industry preferences (stored as JSON array)
  selectedIndustries: jsonb("selected_industries").$type<string[]>().default([]),
  industryNiches: jsonb("industry_niches").$type<Record<string, string[]>>().default({}),
});

// Businesses table (for vendors)
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
  
  // Business images
  coverImage: text("cover_image"),
  logoImage: text("logo_image"),
  
  // Stats
  rating: integer("rating").default(0),
  reviewCount: integer("review_count").default(0),
  
  // Subscription status
  subscriptionActive: boolean("subscription_active").default(false),
});

// Cities table for discovery feature
export const cities = pgTable("cities", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  businessCount: integer("business_count").default(0),
  imageUrl: text("image_url"),
  trending: boolean("trending").default(false),
});

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
});

export const insertBusinessSchema = createInsertSchema(businesses).omit({
  id: true,
  rating: true,
  reviewCount: true,
});

export const insertCitySchema = createInsertSchema(cities);

// Customer signup schema (without password confirmation logic, just data)
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
});

// Vendor signup schema
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

// Login schema
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertBusiness = z.infer<typeof insertBusinessSchema>;
export type Business = typeof businesses.$inferSelect;
export type InsertCity = z.infer<typeof insertCitySchema>;
export type City = typeof cities.$inferSelect;
export type CustomerSignup = z.infer<typeof customerSignupSchema>;
export type VendorSignup = z.infer<typeof vendorSignupSchema>;
export type LoginData = z.infer<typeof loginSchema>;
