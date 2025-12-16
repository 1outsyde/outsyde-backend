import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import {
  customerSignupSchema,
  vendorSignupSchema,
  photographerSignupSchema,
  loginSchema,
  insertReviewSchema,
} from "@shared/schema";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  authMiddleware,
  optionalAuthMiddleware,
  type AuthenticatedRequest,
} from "./auth";
import { stripeService } from "./stripe/stripeService";
import { getStripePublishableKey } from "./stripe/stripeClient";

// ✅ CORRECT IMPORT (default export)
import { photographersRouter } from "./Photographers/photographers.routes";

// Legacy password functions for backward compatibility with existing users
function legacyHashPassword(password: string): string {
  return Buffer.from(password).toString("base64");
}

function legacyVerifyPassword(password: string, hash: string): boolean {
  return legacyHashPassword(password) === hash;
}

// Check if password is legacy (base64) or new (bcrypt)
function isLegacyHash(hash: string): boolean {
  return !hash.startsWith("$2");
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // ==================== AUTH ROUTES ====================

  // Customer signup
  app.post("/api/auth/customer/signup", async (req, res) => {
    try {
      const data = customerSignupSchema.parse(req.body);

      const existing = await storage.getUserByEmail(data.email);
      if (existing) {
        return res.status(400).json({ error: "Email already registered" });
      }

      const hashedPassword = await hashPassword(data.password);
      const user = await storage.createUser({
        email: data.email,
        password: hashedPassword,
        name: data.name,
        phone: data.phone,
        isVendor: false,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
        ageRange: data.ageRange,
        gender: data.gender,
        ethnicity: data.ethnicity,
        shoppingFrequency: data.shoppingFrequency,
        selectedIndustries: data.selectedIndustries,
        industryNiches: data.industryNiches,
        industryValues: data.industryValues,
      });

      if (req.session) {
        req.session.userId = user.id;
        req.session.isVendor = false;
      }

      const { password: _, ...safeUser } = user;
      res.json({ user: safeUser });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Invalid data", details: error.errors });
      }
      console.error("Customer signup error:", error);
      res.status(500).json({ error: "Signup failed" });
    }
  });

  // Vendor signup
  app.post("/api/auth/vendor/signup", async (req, res) => {
    try {
      const data = vendorSignupSchema.parse(req.body);

      const existing = await storage.getUserByEmail(data.email);
      if (existing) {
        return res.status(400).json({ error: "Email already registered" });
      }

      const hashedPassword = await hashPassword(data.password);
      const user = await storage.createUser({
        email: data.email,
        password: hashedPassword,
        name: data.name,
        phone: data.phone,
        isVendor: true,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
      });

      const business = await storage.createBusiness({
        ownerId: user.id,
        name: data.businessName,
        category: data.businessCategory,
        description: data.businessDescription,
        hasProducts: data.offerType === "products" || data.offerType === "both",
        hasServices: data.offerType === "services" || data.offerType === "both",
        isStartup: data.isStartup,
        yearsInBusiness: data.yearsInBusiness,
        employeeCount: data.employeeCount,
        businessType: data.businessType,
        hasPhysicalLocation: data.hasPhysicalLocation,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
        websiteUrl: data.websiteUrl,
        socialMedia: data.socialMedia,
        subscriptionActive: true,
      });

      if (req.session) {
        req.session.userId = user.id;
        req.session.isVendor = true;
        req.session.businessId = business.id;
      }

      const { password: _, ...safeUser } = user;
      res.json({ user: safeUser, business });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Invalid data", details: error.errors });
      }
      console.error("Vendor signup error:", error);
      res.status(500).json({ error: "Signup failed" });
    }
  });

  // Photographer signup
  app.post("/api/auth/photographer/signup", async (req, res) => {
    try {
      const data = photographerSignupSchema.parse(req.body);
      const skipStripe = req.body.skipStripe === true;

      const existing = await storage.getUserByEmail(data.email);
      if (existing) {
        return res.status(400).json({ error: "Email already registered" });
      }

      const hashedPassword = await hashPassword(data.password);
      const user = await storage.createUser({
        email: data.email,
        password: hashedPassword,
        name: data.name,
        phone: data.phone,
        isVendor: false,
        isPhotographer: true,
        city: data.city,
        state: data.state,
      });

      const photographer = await storage.createPhotographer({
        userId: user.id,
        displayName: data.displayName,
        bio: data.bio,
        city: data.city,
        state: data.state,
        hourlyRate: data.hourlyRate,
        portfolioUrl: data.portfolioUrl,
        specialties: data.specialties,
      });

      if (req.session) {
        req.session.userId = user.id;
        req.session.isVendor = false;
        req.session.isPhotographer = true;
        req.session.photographerId = photographer.id;
      }

      const { password: _, ...safeUser } = user;

      // If not skipping Stripe, create Connect account and onboarding link
      if (!skipStripe) {
        try {
          // Use request host with fallback to REPLIT_DOMAINS
          // Force HTTPS for Stripe Connect (required for production)
          const host = req.get('host') || process.env.REPLIT_DOMAINS?.split(',')[0];
          const forwardedProto = req.get('x-forwarded-proto');
          const protocol = forwardedProto || (host?.includes('replit') ? 'https' : req.protocol) || 'https';
          const baseUrl = host ? `${protocol}://${host}` : '';
          
          // Create Stripe Connect Express account
          const account = await stripeService.createConnectAccount(
            data.email,
            photographer.id,
            data.displayName
          );

          // Update photographer with Stripe account ID
          await storage.updatePhotographer(photographer.id, {
            stripeAccountId: account.id,
          });

          // Create onboarding link
          const accountLink = await stripeService.createConnectOnboardingLink(
            account.id,
            `${baseUrl}/photographer/onboarding?refresh=true`,
            `${baseUrl}/photographer/dashboard?stripe=success`
          );

          return res.json({ 
            user: safeUser, 
            photographer: { ...photographer, stripeAccountId: account.id },
            stripeOnboardingUrl: accountLink.url
          });
        } catch (stripeError) {
          console.error("Stripe Connect setup error:", stripeError);
          // Account created but Stripe failed - return success without Stripe URL
          return res.json({ 
            user: safeUser, 
            photographer,
            stripeError: "Failed to setup Stripe. You can complete this later from your dashboard."
          });
        }
      }

      res.json({ user: safeUser, photographer });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Invalid data", details: error.errors });
      }
      console.error("Photographer signup error:", error);
      res.status(500).json({ error: "Signup failed" });
    }
  });

  // Login (supports both legacy base64 and new bcrypt passwords)
  app.post("/api/auth/login", async (req, res) => {
    try {
      const data = loginSchema.parse(req.body);

      const user = await storage.getUserByEmail(data.email);
      if (!user) {
        return res
          .status(401)
          .json({ error: "Invalid email or password" });
      }

      let isValidPassword = false;
      if (isLegacyHash(user.password)) {
        isValidPassword = legacyVerifyPassword(data.password, user.password);
      } else {
        isValidPassword = await verifyPassword(data.password, user.password);
      }

      if (!isValidPassword) {
        return res
          .status(401)
          .json({ error: "Invalid email or password" });
      }

      if (req.session) {
        req.session.userId = user.id;
        req.session.isVendor = user.isVendor;
        req.session.isPhotographer = user.isPhotographer || false;

        if (user.isVendor) {
          const business = await storage.getBusinessByOwnerId(user.id);
          if (business) {
            req.session.businessId = business.id;
          }
        }

        if (user.isPhotographer) {
          const photographer = await storage.getPhotographerByUserId(user.id);
          if (photographer) {
            req.session.photographerId = photographer.id;
          }
        }
      }

      const { password: _, ...safeUser } = user;

      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(user.id);
        return res.json({ user: safeUser, business });
      }

      if (user.isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(user.id);
        return res.json({ user: safeUser, photographer });
      }

      res.json({ user: safeUser });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data" });
      }
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Logout
  app.post("/api/auth/logout", (req, res) => {
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          return res.status(500).json({ error: "Logout failed" });
        }
        res.json({ success: true });
      });
    } else {
      res.json({ success: true });
    }
  });

  // Get current authenticated user (supports both session and OAuth)
  app.get("/api/auth/user", async (req, res) => {
    try {
      // Check for OAuth user first (from Replit Auth)
      const oauthUser = req.user as any;
      if (oauthUser?.claims?.sub) {
        const user = await storage.getUser(oauthUser.claims.sub);
        if (user) {
          const { password: _, ...safeUser } = user;
          // Check if user has a photographer record (in case isPhotographer wasn't set properly)
          if (!safeUser.isPhotographer) {
            const photographer = await storage.getPhotographerByUserId(user.id);
            if (photographer) {
              (safeUser as any).isPhotographer = true;
            }
          }
          return res.json(safeUser);
        }
      }

      // Fall back to session-based auth
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const { password: _, ...safeUser } = user;
      // Check if user has a photographer record (in case isPhotographer wasn't set properly)
      if (!safeUser.isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(userId);
        if (photographer) {
          (safeUser as any).isPhotographer = true;
        }
      }
      res.json(safeUser);
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "Failed to get user" });
    }
  });

  // Get access token for WebSocket authentication (for session users)
  app.get("/api/v1/auth/token", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      let businessId: string | undefined;
      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(userId);
        businessId = business?.id;
      }

      const accessToken = generateAccessToken({
        userId,
        isVendor: user.isVendor,
        businessId,
      });

      res.json({ accessToken });
    } catch (error) {
      console.error("Token generation error:", error);
      res.status(500).json({ error: "Failed to generate token" });
    }
  });

  // ==================== USER PREFERENCES ====================

  app.patch("/api/users/preferences", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { selectedIndustries, industryNiches } = req.body;

      const user = await storage.updateUser(userId, {
        selectedIndustries: selectedIndustries || [],
        industryNiches: industryNiches || {},
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { password: _, ...safeUser } = user;
      res.json({ user: safeUser });
    } catch (error) {
      console.error("Update preferences error:", error);
      res
        .status(500)
        .json({ error: "Failed to update preferences" });
    }
  });

  // ==================== BUSINESS ROUTES ====================

  app.use("/api/photographers", photographersRouter);

  // ==================== PHOTOGRAPHER BOOKING ROUTES ====================

  // Create photographer booking (customer facing)
  app.post("/api/bookings/photographer", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const bookingSchema = z.object({
        photographerId: z.string().min(1, "Photographer ID is required"),
        serviceId: z.string().optional(),
        shootType: z.string().min(1, "Shoot type is required"),
        bookingDateTime: z.string().min(1, "Booking date/time is required"),
        locationDetails: z.string().min(1, "Location is required"),
        specialRequests: z.string().optional(),
        totalPriceCents: z.number().default(0),
      });

      const data = bookingSchema.parse(req.body);

      // Parse datetime into date and time components
      const dateTime = new Date(data.bookingDateTime);
      const date = dateTime.toISOString().split("T")[0];
      const startTime = `${dateTime.getHours().toString().padStart(2, "0")}:${dateTime.getMinutes().toString().padStart(2, "0")}`;
      
      // Estimate end time (default 2 hour session)
      const endDateTime = new Date(dateTime.getTime() + 2 * 60 * 60 * 1000);
      const endTime = `${endDateTime.getHours().toString().padStart(2, "0")}:${endDateTime.getMinutes().toString().padStart(2, "0")}`;

      // Calculate fees (4% Outsyde platform fee)
      const platformFee = Math.round(data.totalPriceCents * 0.04);
      const vendorNet = data.totalPriceCents - platformFee;

      const booking = await storage.createShootBooking({
        photographerId: data.photographerId,
        clientId: userId,
        serviceId: data.serviceId || null,
        shootType: data.shootType,
        date,
        startTime,
        endTime,
        durationHours: 2,
        locationDetails: data.locationDetails,
        specialRequests: data.specialRequests || null,
        totalPrice: data.totalPriceCents,
        platformFee,
        vendorNet,
        status: "pending",
      });

      res.status(201).json({ booking });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create photographer booking error:", error);
      res.status(500).json({ error: "Failed to create booking" });
    }
  });

  // ==================== STRIPE ROUTES ====================

  // Get subscription tiers
  app.get("/api/subscription-tiers", async (req, res) => {
    try {
      const tiers = await stripeService.getSubscriptionTiers();
      res.json({ tiers });
    } catch (error) {
      console.error("Get subscription tiers error:", error);
      res.status(500).json({ error: "Failed to get subscription tiers" });
    }
  });

  // Setup Stripe products for subscription tiers (admin endpoint)
  app.post("/api/stripe/setup-products", async (req, res) => {
    try {
      await stripeService.setupSubscriptionProducts();
      await stripeService.setupAlaCarteProducts();
      res.json({ success: true, message: "Stripe products setup complete" });
    } catch (error) {
      console.error("Setup Stripe products error:", error);
      res.status(500).json({ error: "Failed to setup Stripe products" });
    }
  });

  // Create tier subscription checkout
  app.post("/api/stripe/checkout/tier-subscription", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can subscribe" });
    }

    try {
      const checkoutSchema = z.object({
        tierId: z.string().min(1, "Tier ID is required"),
      });
      const { tierId } = checkoutSchema.parse(req.body);

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const customer = await stripeService.createCustomer(user.email!, userId, user.name!);

      const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
      const session = await stripeService.createTierSubscriptionCheckout(
        customer.id,
        tierId,
        `${baseUrl}/vendor/dashboard?subscription=success`,
        `${baseUrl}/vendor/dashboard?subscription=cancelled`,
        userId,
        business.id
      );

      res.json({ url: session.url });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create tier subscription checkout error:", error);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  // Get Stripe publishable key for frontend
  app.get("/api/stripe/config", async (req, res) => {
    try {
      const publishableKey = await getStripePublishableKey();
      res.json({ publishableKey });
    } catch (error) {
      console.error("Get Stripe config error:", error);
      res.status(500).json({ error: "Failed to get Stripe configuration" });
    }
  });

  // Get products from Stripe
  app.get("/api/stripe/products", async (req, res) => {
    try {
      const products = await stripeService.getProductsWithPrices();
      res.json({ products });
    } catch (error) {
      console.error("Get products error:", error);
      res.status(500).json({ error: "Failed to get products" });
    }
  });

  // Create checkout session for vendor subscription
  // SECURITY: Uses authenticated session to derive user/business - no client-supplied IDs
  app.post("/api/stripe/checkout/subscription", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Must be a vendor to subscribe
    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can subscribe" });
    }

    try {
      // Validate request body with Zod
      const checkoutSchema = z.object({
        priceId: z.string().min(1, "Price ID is required"),
      });
      const { priceId } = checkoutSchema.parse(req.body);

      // Derive user from authenticated session - never from client input
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Create Stripe customer using authenticated user's info
      const customer = await stripeService.createCustomer(user.email, userId, user.name);

      // Derive business from authenticated user - never from client input
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
      const session = await stripeService.createVendorSubscriptionCheckout(
        customer.id,
        priceId,
        `${baseUrl}/vendor/dashboard?subscription=success`,
        `${baseUrl}/vendor/dashboard?subscription=cancelled`,
        business.id
      );

      res.json({ url: session.url });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create subscription checkout error:", error);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  // ==================== VENDOR SUBSCRIPTION & BENEFITS ROUTES ====================

  // Get vendor's subscription details
  app.get("/api/vendor/subscription", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can access this" });
    }

    try {
      const subscription = await storage.getVendorSubscription(userId);
      if (!subscription) {
        return res.json({ subscription: null });
      }

      res.json({ subscription });
    } catch (error) {
      console.error("Get vendor subscription error:", error);
      res.status(500).json({ error: "Failed to get subscription" });
    }
  });

  // Get vendor's benefit allowances
  app.get("/api/vendor/benefits", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can access this" });
    }

    try {
      const allowances = await storage.getVendorBenefitAllowances(userId);
      res.json({ allowances });
    } catch (error) {
      console.error("Get vendor benefits error:", error);
      res.status(500).json({ error: "Failed to get benefits" });
    }
  });

  // Use a benefit (creates fulfillment task)
  app.post("/api/vendor/benefits/:id/use", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can use benefits" });
    }

    try {
      const { id } = req.params;
      const { notes } = req.body;

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const result = await storage.useBenefit(id, userId, business.id, notes);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({ 
        success: true, 
        allowance: result.allowance, 
        task: result.task 
      });
    } catch (error) {
      console.error("Use benefit error:", error);
      res.status(500).json({ error: "Failed to use benefit" });
    }
  });

  // ==================== À LA CARTE ROUTES ====================

  // Get all à la carte services
  app.get("/api/ala-carte/services", async (req, res) => {
    try {
      const services = await storage.getAlaCarteServices();
      res.json({ services });
    } catch (error) {
      console.error("Get à la carte services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  });

  // Get pricing for a specific service (includes tier discounts)
  app.get("/api/ala-carte/services/:id/pricing", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { id } = req.params;
      const pricing = await storage.getAlaCarteServicePricing(id, userId);
      
      if (!pricing) {
        return res.status(404).json({ error: "Service not found" });
      }

      res.json(pricing);
    } catch (error) {
      console.error("Get service pricing error:", error);
      res.status(500).json({ error: "Failed to get pricing" });
    }
  });

  // Create checkout for à la carte purchase
  app.post("/api/ala-carte/checkout", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can purchase services" });
    }

    try {
      const checkoutSchema = z.object({
        serviceId: z.string().min(1, "Service ID is required"),
        notes: z.string().optional(),
      });
      const { serviceId, notes } = checkoutSchema.parse(req.body);

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const pricing = await storage.getAlaCarteServicePricing(serviceId, userId);
      if (!pricing) {
        return res.status(404).json({ error: "Service not found" });
      }

      // Platform fee is 4% Outsyde fee of the final price
      const platformFeeInCents = Math.round(pricing.finalPriceCents * 0.04);

      // Create the purchase record first
      const purchase = await storage.createAlaCartePurchase({
        vendorId: userId,
        businessId: business.id,
        serviceId,
        tierIdAtPurchase: pricing.tier?.id || null,
        basePriceInCents: pricing.basePriceCents,
        discountPercent: pricing.discountPercent,
        finalPriceInCents: pricing.finalPriceCents,
        platformFeeInCents,
      });

      // Reuse existing Stripe customer ID if available, otherwise create new
      const vendorSubscription = await storage.getVendorSubscription(userId);
      let customerId: string;
      if (vendorSubscription?.stripeCustomerId) {
        customerId = vendorSubscription.stripeCustomerId;
      } else {
        const customer = await stripeService.createCustomer(user.email!, userId, user.name!);
        customerId = customer.id;
      }

      const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
      
      const session = await stripeService.createAlaCarteCheckout(
        customerId,
        pricing.service,
        pricing.finalPriceCents,
        platformFeeInCents,
        `${baseUrl}/vendor/dashboard?purchase=success&purchaseId=${purchase.id}`,
        `${baseUrl}/vendor/dashboard?purchase=cancelled`,
        purchase.id,
        userId,
        business.id,
        notes
      );

      // Update purchase with checkout session ID
      await storage.updateAlaCartePurchase(purchase.id, {
        stripeCheckoutSessionId: session.id,
      });

      res.json({ url: session.url, purchaseId: purchase.id });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create à la carte checkout error:", error);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  // Get vendor's à la carte purchases
  app.get("/api/vendor/ala-carte-purchases", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can access this" });
    }

    try {
      const purchases = await storage.getVendorAlaCartePurchases(userId);
      res.json({ purchases });
    } catch (error) {
      console.error("Get vendor purchases error:", error);
      res.status(500).json({ error: "Failed to get purchases" });
    }
  });

  // ==================== VERIFIED REVIEW ROUTES ====================

  // Get reviews for a target (photographer, business, service_business)
  app.get("/api/reviews/:targetType/:targetId", async (req, res) => {
    try {
      const { targetType, targetId } = req.params;
      
      if (!['photographer', 'business', 'service_business'].includes(targetType)) {
        return res.status(400).json({ error: "Invalid target type" });
      }

      const reviews = await storage.getReviewsByTarget(targetType, targetId);
      
      // Enrich reviews with reviewer names
      const enrichedReviews = await Promise.all(
        reviews.map(async (review) => {
          const reviewer = await storage.getUser(review.reviewerId);
          return {
            ...review,
            reviewerName: reviewer?.name || "Anonymous",
          };
        })
      );

      res.json({ reviews: enrichedReviews });
    } catch (error) {
      console.error("Get reviews error:", error);
      res.status(500).json({ error: "Failed to get reviews" });
    }
  });

  // Get bookings that can be reviewed by the current user
  app.get("/api/reviews/reviewable", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const reviewable = await storage.getReviewableBookings(userId);
      res.json(reviewable);
    } catch (error) {
      console.error("Get reviewable bookings error:", error);
      res.status(500).json({ error: "Failed to get reviewable bookings" });
    }
  });

  // Create a verified review (ONLY if customer has completed booking/order)
  app.post("/api/reviews", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const data = insertReviewSchema.parse({
        ...req.body,
        reviewerId: userId,
      });

      // CRITICAL: Verify the customer has a completed booking/order
      const verification = await storage.verifyCustomerCanReview(
        userId,
        data.targetType,
        data.targetId,
        data.bookingType,
        data.bookingId
      );

      if (!verification.canReview) {
        return res.status(403).json({ 
          error: "Cannot leave review", 
          reason: verification.reason 
        });
      }

      // Create the review
      const review = await storage.createReview(data);

      // Update the target's rating
      await storage.updateTargetRating(data.targetType, data.targetId);

      res.json({ review });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create review error:", error);
      res.status(500).json({ error: "Failed to create review" });
    }
  });

  // Check if user can review a specific booking
  app.get("/api/reviews/can-review/:bookingType/:bookingId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { bookingType, bookingId } = req.params;
      
      // First check if already reviewed
      const alreadyReviewed = await storage.hasReviewedBooking(bookingType, bookingId);
      
      res.json({ 
        canReview: !alreadyReviewed,
        alreadyReviewed,
      });
    } catch (error) {
      console.error("Check can review error:", error);
      res.status(500).json({ error: "Failed to check review status" });
    }
  });

  // ==================== CITIES ROUTES ====================

  app.get("/api/cities", async (req, res) => {
    try {
      const cities = await storage.getCities();
      res.json({ cities });
    } catch (error) {
      console.error("Get cities error:", error);
      res.status(500).json({ error: "Failed to get cities" });
    }
  });

  // ==================== BUSINESSES ROUTES ====================

  app.get("/api/businesses", async (req, res) => {
    try {
      const { city, category, search } = req.query;
      const businesses = await storage.getBusinesses({
        city: city as string | undefined,
        category: category as string | undefined,
        search: search as string | undefined,
      });
      res.json({ businesses });
    } catch (error) {
      console.error("Get businesses error:", error);
      res.status(500).json({ error: "Failed to get businesses" });
    }
  });

  app.get("/api/businesses/:id", async (req, res) => {
    try {
      const business = await storage.getBusiness(req.params.id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }
      res.json({ business });
    } catch (error) {
      console.error("Get business error:", error);
      res.status(500).json({ error: "Failed to get business" });
    }
  });

  // Get products for a specific business (public - for customer storefront view)
  app.get("/api/businesses/:id/products", async (req, res) => {
    try {
      const business = await storage.getBusiness(req.params.id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }
      const products = await storage.getVendorProducts(req.params.id);
      // Only return active products for public view
      const activeProducts = products.filter(p => p.isActive);
      res.json({ products: activeProducts });
    } catch (error) {
      console.error("Get business products error:", error);
      res.status(500).json({ error: "Failed to get products" });
    }
  });

  // Get services for a specific business (public - for customer storefront view)
  app.get("/api/businesses/:id/services", async (req, res) => {
    try {
      const business = await storage.getBusiness(req.params.id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }
      const services = await storage.getVendorServicesByBusiness(req.params.id);
      // Only return active services for public view
      const activeServices = services.filter(s => s.isActive);
      res.json({ services: activeServices });
    } catch (error) {
      console.error("Get business services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  });

  // ==================== VENDOR STOREFRONT ROUTES ====================

  // Get current vendor's business
  app.get("/api/vendor/my-business", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found for this account" });
      }
      res.json({ business });
    } catch (error) {
      console.error("Get vendor business error:", error);
      res.status(500).json({ error: "Failed to get business" });
    }
  });

  // Update vendor's business profile
  app.patch("/api/vendor/my-business", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found for this account" });
      }

      const updated = await storage.updateBusiness(business.id, req.body);
      res.json({ business: updated });
    } catch (error) {
      console.error("Update vendor business error:", error);
      res.status(500).json({ error: "Failed to update business" });
    }
  });

  // Get vendor's order/booking records
  app.get("/api/vendor/customers", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const records = await storage.getBusinessOrderRecords(business.id);
      res.json({ records });
    } catch (error) {
      console.error("Get vendor order records error:", error);
      res.status(500).json({ error: "Failed to get order records" });
    }
  });

  // Get vendor's products
  app.get("/api/vendor/products", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const products = await storage.getVendorProducts(business.id);
      res.json({ products });
    } catch (error) {
      console.error("Get vendor products error:", error);
      res.status(500).json({ error: "Failed to get products" });
    }
  });

  // Create vendor product
  app.post("/api/vendor/products", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const productSchema = z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        price: z.number().min(0),
        compareAtPrice: z.number().nullable().optional(),
        imageUrl: z.string().nullable().optional(),
        images: z.array(z.string()).optional(),
        category: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        inventory: z.number().optional(),
        trackInventory: z.boolean().optional(),
        isActive: z.boolean().optional(),
        isFeatured: z.boolean().optional(),
      });

      const validated = productSchema.parse(req.body);
      const product = await storage.createVendorProduct({
        businessId: business.id,
        ...validated,
      });

      if (!business.hasProducts) {
        await storage.updateBusiness(business.id, { hasProducts: true });
      }

      res.json({ product });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create vendor product error:", error);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  // Update vendor product
  app.patch("/api/vendor/products/:id", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const product = await storage.getVendorProduct(req.params.id);
      if (!product || product.businessId !== business.id) {
        return res.status(404).json({ error: "Product not found" });
      }

      const updateSchema = z.object({
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        price: z.number().min(0).optional(),
        compareAtPrice: z.number().nullable().optional(),
        imageUrl: z.string().nullable().optional(),
        images: z.array(z.string()).optional(),
        category: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        inventory: z.number().optional(),
        trackInventory: z.boolean().optional(),
        isActive: z.boolean().optional(),
        isFeatured: z.boolean().optional(),
      });

      const validated = updateSchema.parse(req.body);
      const updated = await storage.updateVendorProduct(req.params.id, validated);
      res.json({ product: updated });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update vendor product error:", error);
      res.status(500).json({ error: "Failed to update product" });
    }
  });

  // Delete vendor product
  app.delete("/api/vendor/products/:id", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const product = await storage.getVendorProduct(req.params.id);
      if (!product || product.businessId !== business.id) {
        return res.status(404).json({ error: "Product not found" });
      }

      await storage.deleteVendorProduct(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete vendor product error:", error);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });

  // Get vendor's services
  app.get("/api/vendor/services", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const services = await storage.getVendorServicesByBusiness(business.id);
      res.json({ services });
    } catch (error) {
      console.error("Get vendor services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  });

  // Create vendor service
  app.post("/api/vendor/services", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const serviceSchema = z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        price: z.number().min(0),
        durationMinutes: z.number().min(5),
        category: z.string().nullable().optional(),
        isActive: z.boolean().optional(),
        isFeatured: z.boolean().optional(),
      });

      const validated = serviceSchema.parse(req.body);
      const service = await storage.createVendorService({
        businessId: business.id,
        ...validated,
      });

      if (!business.hasServices) {
        await storage.updateBusiness(business.id, { hasServices: true });
      }

      res.json({ service });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create vendor service error:", error);
      res.status(500).json({ error: "Failed to create service" });
    }
  });

  // Update vendor service
  app.patch("/api/vendor/services/:id", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const service = await storage.getVendorService(req.params.id);
      if (!service || service.businessId !== business.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      const updateSchema = z.object({
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        price: z.number().min(0).optional(),
        durationMinutes: z.number().min(5).optional(),
        category: z.string().nullable().optional(),
        isActive: z.boolean().optional(),
        isFeatured: z.boolean().optional(),
      });

      const validated = updateSchema.parse(req.body);
      const updated = await storage.updateVendorService(req.params.id, validated);
      res.json({ service: updated });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update vendor service error:", error);
      res.status(500).json({ error: "Failed to update service" });
    }
  });

  // Delete vendor service
  app.delete("/api/vendor/services/:id", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const service = await storage.getVendorService(req.params.id);
      if (!service || service.businessId !== business.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      await storage.deleteVendorService(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete vendor service error:", error);
      res.status(500).json({ error: "Failed to delete service" });
    }
  });

  // ==================== CHAT ROUTES ====================

  // Get user's conversations
  app.get("/api/conversations", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const conversations = await storage.getUserConversations(userId);
      res.json({ conversations });
    } catch (error) {
      console.error("Get conversations error:", error);
      res.status(500).json({ error: "Failed to get conversations" });
    }
  });

  // Get or create conversation with another user
  app.post("/api/conversations", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const createConvoSchema = z.object({
        participantId: z.string().min(1, "Participant ID is required"),
      });
      const { participantId } = createConvoSchema.parse(req.body);

      if (participantId === userId) {
        return res.status(400).json({ error: "Cannot create conversation with yourself" });
      }

      const otherUser = await storage.getUser(participantId);
      if (!otherUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const conversation = await storage.getOrCreateConversation(userId, participantId);
      res.json({ conversation, otherParticipant: { id: otherUser.id, name: otherUser.name } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create conversation error:", error);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  // Get messages in a conversation
  app.get("/api/conversations/:id/messages", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const conversation = await storage.getConversation(req.params.id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      if (conversation.participant1Id !== userId && conversation.participant2Id !== userId) {
        return res.status(403).json({ error: "Not a participant in this conversation" });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const before = req.query.before as string | undefined;

      const messages = await storage.getConversationMessages(req.params.id, limit, before);
      
      // Mark messages as read
      await storage.markMessagesAsRead(req.params.id, userId);

      res.json({ messages });
    } catch (error) {
      console.error("Get messages error:", error);
      res.status(500).json({ error: "Failed to get messages" });
    }
  });

  // Send a message (REST fallback - WebSocket preferred)
  app.post("/api/conversations/:id/messages", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const conversation = await storage.getConversation(req.params.id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      if (conversation.participant1Id !== userId && conversation.participant2Id !== userId) {
        return res.status(403).json({ error: "Not a participant in this conversation" });
      }

      const messageSchema = z.object({
        content: z.string().min(1, "Message content is required"),
      });
      const { content } = messageSchema.parse(req.body);

      const message = await storage.createMessage({
        conversationId: req.params.id,
        senderId: userId,
        content,
      });

      res.json({ message });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Send message error:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // Get unread message count
  app.get("/api/messages/unread-count", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const count = await storage.getUnreadCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Get unread count error:", error);
      res.status(500).json({ error: "Failed to get unread count" });
    }
  });

  // ==================== OUTSYDE POINTS (LOYALTY) ROUTES ====================
  // $1 = 100 points | 100 points = $1 discount
  // Points can be redeemed at ANY Outsyde business

  // Get user's points balance and summary
  app.get("/api/points/balance", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const balance = await storage.getUserPointsBalance(userId);
      const dollarValue = balance / 100; // 100 points = $1
      
      res.json({ 
        balance, 
        dollarValue,
        formattedBalance: balance.toLocaleString(),
        formattedDollarValue: `$${dollarValue.toFixed(2)}`,
      });
    } catch (error) {
      console.error("Get points balance error:", error);
      res.status(500).json({ error: "Failed to get points balance" });
    }
  });

  // Get user's points transaction history
  app.get("/api/points/history", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const transactions = await storage.getPointTransactions(userId, limit);
      
      res.json({ transactions });
    } catch (error) {
      console.error("Get points history error:", error);
      res.status(500).json({ error: "Failed to get points history" });
    }
  });

  // Calculate points value (for checkout preview)
  app.post("/api/points/calculate", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const pointsSchema = z.object({
        points: z.number().int().positive(),
      });
      const { points } = pointsSchema.parse(req.body);
      
      const balance = await storage.getUserPointsBalance(userId);
      const availablePoints = Math.min(points, balance);
      const discountCents = storage.calculatePointsValue(availablePoints);
      
      res.json({
        requestedPoints: points,
        availablePoints,
        discountCents,
        formattedDiscount: `$${(discountCents / 100).toFixed(2)}`,
        remainingBalance: balance - availablePoints,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Calculate points error:", error);
      res.status(500).json({ error: "Failed to calculate points" });
    }
  });

  // Redeem points for discount
  app.post("/api/points/redeem", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const redeemSchema = z.object({
        points: z.number().int().positive(),
        businessId: z.string().optional(),
        businessName: z.string().optional(),
        referenceType: z.string().optional(),
        referenceId: z.string().optional(),
      });
      const data = redeemSchema.parse(req.body);

      const result = await storage.redeemPoints({
        userId,
        points: data.points,
        businessId: data.businessId,
        businessName: data.businessName,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
      });

      if ('error' in result) {
        return res.status(400).json({ success: false, error: result.error });
      }

      const newBalance = await storage.getUserPointsBalance(userId);

      res.json({
        success: true,
        transaction: result.transaction,
        discountCents: result.discountCents,
        formattedDiscount: `$${(result.discountCents / 100).toFixed(2)}`,
        newBalance,
        formattedNewBalance: newBalance.toLocaleString(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Redeem points error:", error);
      res.status(500).json({ error: "Failed to redeem points" });
    }
  });

  // =========================
  // REFERRAL SYSTEM
  // =========================

  // Get user's referral code (generates one if not exists)
  app.get("/api/referral/code", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const code = await storage.generateReferralCode(userId);
      const user = await storage.getUser(userId);
      
      res.json({
        referralCode: code,
        referralLink: `${req.protocol}://${req.get('host')}/signup?ref=${code}`,
        bonusForReferrer: 500,
        bonusForNewUser: 200,
        referredBy: user?.referredBy || null,
      });
    } catch (error) {
      console.error("Get referral code error:", error);
      res.status(500).json({ error: "Failed to get referral code" });
    }
  });

  // Apply a referral code (for new users)
  app.post("/api/referral/apply", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const schema = z.object({
        referralCode: z.string().min(1).max(20),
      });
      const { referralCode } = schema.parse(req.body);

      const result = await storage.processReferral(userId, referralCode);

      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }

      const newBalance = await storage.getUserPointsBalance(userId);

      res.json({
        success: true,
        message: "Referral applied successfully! You've earned 200 bonus points.",
        pointsEarned: 200,
        newBalance,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid referral code format" });
      }
      console.error("Apply referral error:", error);
      res.status(500).json({ error: "Failed to apply referral code" });
    }
  });

  // Earn points (typically called after successful payment - internal use)
  // In production, this would be triggered by Stripe webhooks
  app.post("/api/points/earn", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const earnSchema = z.object({
        dollarAmountCents: z.number().int().positive(),
        businessId: z.string().optional(),
        businessName: z.string().optional(),
        referenceType: z.string().optional(),
        referenceId: z.string().optional(),
      });
      const data = earnSchema.parse(req.body);

      const transaction = await storage.earnPoints({
        userId,
        dollarAmountCents: data.dollarAmountCents,
        businessId: data.businessId,
        businessName: data.businessName,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
      });

      const newBalance = await storage.getUserPointsBalance(userId);

      res.json({
        success: true,
        transaction,
        pointsEarned: transaction.points,
        newBalance,
        formattedNewBalance: newBalance.toLocaleString(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Earn points error:", error);
      res.status(500).json({ error: "Failed to earn points" });
    }
  });

  // ==================== PUSH NOTIFICATIONS ====================
  
  const { 
    getVapidPublicKey, 
    isPushConfigured, 
    sendCartReminderNotifications 
  } = await import('./pushService');

  app.get("/api/push/vapid-key", (req, res) => {
    const key = getVapidPublicKey();
    res.json({ 
      publicKey: key,
      configured: isPushConfigured()
    });
  });

  app.post("/api/push/subscribe", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const schema = z.object({
        endpoint: z.string().url(),
        keys: z.object({
          p256dh: z.string(),
          auth: z.string(),
        }),
      });
      const data = schema.parse(req.body);

      const subscription = await storage.savePushSubscription({
        userId,
        endpoint: data.endpoint,
        p256dh: data.keys.p256dh,
        auth: data.keys.auth,
        userAgent: req.headers['user-agent'] || null,
      });

      res.json({ success: true, subscription });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid subscription data" });
      }
      console.error("Subscribe error:", error);
      res.status(500).json({ error: "Failed to save subscription" });
    }
  });

  app.delete("/api/push/unsubscribe", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { endpoint } = req.body;
      if (!endpoint) {
        return res.status(400).json({ error: "Endpoint required" });
      }

      await storage.deletePushSubscription(userId, endpoint);
      res.json({ success: true });
    } catch (error) {
      console.error("Unsubscribe error:", error);
      res.status(500).json({ error: "Failed to unsubscribe" });
    }
  });

  app.post("/api/push/send-cart-reminders", async (req, res) => {
    try {
      const sentCount = await sendCartReminderNotifications();
      res.json({ success: true, sentCount });
    } catch (error) {
      console.error("Cart reminder error:", error);
      res.status(500).json({ error: "Failed to send reminders" });
    }
  });

  // ==================== CART MANAGEMENT ====================

  app.get("/api/cart", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const items = await storage.getCartItems(userId);
      const totalCents = items.reduce((sum, item) => sum + item.priceInCents * item.quantity, 0);
      res.json({ 
        items,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        totalCents,
        totalFormatted: `$${(totalCents / 100).toFixed(2)}`
      });
    } catch (error) {
      console.error("Get cart error:", error);
      res.status(500).json({ error: "Failed to get cart" });
    }
  });

  app.post("/api/cart/add", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const schema = z.object({
        productId: z.string(),
        productName: z.string(),
        productImage: z.string().optional(),
        priceInCents: z.number().int().positive(),
        quantity: z.number().int().positive().default(1),
        businessId: z.string().optional(),
        businessName: z.string().optional(),
      });
      const data = schema.parse(req.body);

      const item = await storage.addCartItem({
        userId,
        ...data,
      });

      const items = await storage.getCartItems(userId);
      res.json({ 
        success: true, 
        item,
        itemCount: items.reduce((sum, i) => sum + i.quantity, 0)
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid cart item data" });
      }
      console.error("Add to cart error:", error);
      res.status(500).json({ error: "Failed to add item to cart" });
    }
  });

  app.patch("/api/cart/:id", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { quantity } = req.body;
      if (typeof quantity !== 'number') {
        return res.status(400).json({ error: "Quantity required" });
      }

      const item = await storage.updateCartItemQuantity(req.params.id, quantity);
      const items = await storage.getCartItems(userId);
      
      res.json({ 
        success: true, 
        item,
        itemCount: items.reduce((sum, i) => sum + i.quantity, 0)
      });
    } catch (error) {
      console.error("Update cart error:", error);
      res.status(500).json({ error: "Failed to update cart item" });
    }
  });

  app.delete("/api/cart/:id", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      await storage.removeCartItem(req.params.id);
      const items = await storage.getCartItems(userId);
      
      res.json({ 
        success: true,
        itemCount: items.reduce((sum, i) => sum + i.quantity, 0)
      });
    } catch (error) {
      console.error("Remove from cart error:", error);
      res.status(500).json({ error: "Failed to remove item from cart" });
    }
  });

  app.delete("/api/cart", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      await storage.clearCart(userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Clear cart error:", error);
      res.status(500).json({ error: "Failed to clear cart" });
    }
  });

  // ==================== ADMIN FULFILLMENT ROUTES ====================

  // Middleware to check if user is admin
  const requireAdmin = async (req: any, res: any, next: any) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(userId);
    if (!user?.isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    req.adminUser = user;
    next();
  };

  // Get all fulfillment tasks with optional filters
  app.get("/api/admin/fulfillment-tasks", requireAdmin, async (req, res) => {
    try {
      const { status, taskType, limit, offset } = req.query;
      
      const result = await storage.getAllFulfillmentTasks({
        status: status as string | undefined,
        taskType: taskType as string | undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
      });

      res.json(result);
    } catch (error) {
      console.error("Get fulfillment tasks error:", error);
      res.status(500).json({ error: "Failed to get fulfillment tasks" });
    }
  });

  // Get single fulfillment task with details
  app.get("/api/admin/fulfillment-tasks/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await storage.getFulfillmentTaskWithDetails(id);

      if (!result) {
        return res.status(404).json({ error: "Task not found" });
      }

      res.json(result);
    } catch (error) {
      console.error("Get fulfillment task error:", error);
      res.status(500).json({ error: "Failed to get task" });
    }
  });

  // Update fulfillment task
  app.patch("/api/admin/fulfillment-tasks/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updateSchema = z.object({
        status: z.enum(['pending', 'scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
        scheduledDate: z.string().datetime().optional().nullable(),
        adminNotes: z.string().optional().nullable(),
        isPriority: z.boolean().optional(),
        assignedAdminId: z.string().optional().nullable(),
      });

      const updates = updateSchema.parse(req.body);
      
      // Convert string date to Date object
      const updateData: any = { ...updates };
      if (updates.scheduledDate) {
        updateData.scheduledDate = new Date(updates.scheduledDate);
      }
      if (updates.status === 'completed') {
        updateData.completedDate = new Date();
      }

      const task = await storage.updateFulfillmentTask(id, updateData);

      if (!task) {
        return res.status(404).json({ error: "Task not found" });
      }

      res.json({ task });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update fulfillment task error:", error);
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  // Get fulfillment task stats for dashboard
  app.get("/api/admin/fulfillment-stats", requireAdmin, async (req, res) => {
    try {
      const pending = await storage.getAllFulfillmentTasks({ status: 'pending' });
      const scheduled = await storage.getAllFulfillmentTasks({ status: 'scheduled' });
      const inProgress = await storage.getAllFulfillmentTasks({ status: 'in_progress' });
      const completed = await storage.getAllFulfillmentTasks({ status: 'completed' });

      res.json({
        pending: pending.total,
        scheduled: scheduled.total,
        inProgress: inProgress.total,
        completed: completed.total,
        total: pending.total + scheduled.total + inProgress.total + completed.total,
      });
    } catch (error) {
      console.error("Get fulfillment stats error:", error);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  // ==================== REFUND REQUEST ROUTES ====================

  // Create a refund request (vendors, photographers, or customers)
  app.post("/api/refund-requests", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const schema = z.object({
        targetType: z.enum(['order', 'appointment', 'shoot_booking']),
        targetId: z.string(),
        reason: z.string().min(1),
        amount: z.number().int().positive(),
      });

      const data = schema.parse(req.body);
      const user = await storage.getUser(userId);
      
      // Determine requester type
      let requesterType = 'customer';
      if (user?.isVendor) requesterType = 'vendor';
      if (user?.isPhotographer) requesterType = 'photographer';

      const request = await storage.createRefundRequest({
        requesterId: userId,
        requesterType,
        targetType: data.targetType,
        targetId: data.targetId,
        reason: data.reason,
        amount: data.amount,
      });

      res.json({ success: true, request });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create refund request error:", error);
      res.status(500).json({ error: "Failed to create refund request" });
    }
  });

  // Get user's refund requests
  app.get("/api/refund-requests", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const requests = await storage.getRefundRequestsByRequester(userId);
      res.json({ requests });
    } catch (error) {
      console.error("Get refund requests error:", error);
      res.status(500).json({ error: "Failed to get refund requests" });
    }
  });

  // Admin: Get all pending refund requests
  app.get("/api/admin/refund-requests", requireAdmin, async (req, res) => {
    try {
      const requests = await storage.getAllPendingRefundRequests();
      res.json({ requests });
    } catch (error) {
      console.error("Get pending refund requests error:", error);
      res.status(500).json({ error: "Failed to get refund requests" });
    }
  });

  // Admin: Update refund request status
  app.patch("/api/admin/refund-requests/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const schema = z.object({
        status: z.enum(['approved', 'rejected', 'pending']),
        adminNotes: z.string().optional(),
      });

      const data = schema.parse(req.body);
      const adminUser = (req as any).adminUser;

      const updates: any = {
        status: data.status,
        adminNotes: data.adminNotes,
      };

      if (data.status !== 'pending') {
        updates.resolvedAt = new Date();
        updates.resolvedBy = adminUser.id;
      }

      const request = await storage.updateRefundRequest(id, updates);

      if (!request) {
        return res.status(404).json({ error: "Refund request not found" });
      }

      res.json({ success: true, request });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update refund request error:", error);
      res.status(500).json({ error: "Failed to update refund request" });
    }
  });

  // ==================== FEED POSTS ROUTES ====================

  // Get feed posts (public)
  app.get("/api/feed", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const posts = await storage.getFeedPosts(limit, offset);
      
      // Enrich posts with author, tagged entities, and product/service info
      const enrichedPosts = await Promise.all(posts.map(async (post) => {
        const author = await storage.getUser(post.authorId);
        let taggedBusiness = null;
        let taggedPhotographer = null;
        let product = null;
        let service = null;
        
        if (post.taggedBusinessId) {
          taggedBusiness = await storage.getBusiness(post.taggedBusinessId);
        }
        if (post.taggedPhotographerId) {
          taggedPhotographer = await storage.getPhotographer(post.taggedPhotographerId);
        }
        if (post.productId) {
          product = await storage.getVendorProduct(post.productId);
        }
        if (post.serviceId) {
          service = await storage.getVendorService(post.serviceId);
        }
        
        return {
          ...post,
          author: author ? { id: author.id, name: author.name, profileImageUrl: author.profileImageUrl } : null,
          taggedBusiness: taggedBusiness ? { id: taggedBusiness.id, name: taggedBusiness.name, logoImage: taggedBusiness.logoImage } : null,
          taggedPhotographer: taggedPhotographer ? { id: taggedPhotographer.id, displayName: taggedPhotographer.displayName } : null,
          product: product ? {
            id: product.id,
            name: product.name,
            description: product.description,
            price: product.price,
            imageUrl: product.imageUrl,
            businessId: product.businessId,
          } : null,
          service: service ? {
            id: service.id,
            name: service.name,
            description: service.description,
            price: service.price,
            durationMinutes: service.durationMinutes,
            businessId: service.businessId,
          } : null,
        };
      }));
      
      res.json({ posts: enrichedPosts });
    } catch (error) {
      console.error("Get feed error:", error);
      res.status(500).json({ error: "Failed to get feed" });
    }
  });

  // Create a new post
  app.post("/api/feed", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const schema = z.object({
        content: z.string().max(2000).optional().default(""),
        imageUrl: z.string().optional(),
        taggedBusinessId: z.string().optional(),
        taggedPhotographerId: z.string().optional(),
        postType: z.enum(['text', 'product', 'service']).optional(),
        productId: z.string().optional(),
        serviceId: z.string().optional(),
      }).refine(data => {
        // For text posts, content is required
        if (!data.postType || data.postType === 'text') {
          return data.content && data.content.length > 0;
        }
        // For product/service posts, content is optional
        return true;
      }, { message: "Content is required for text posts" });

      const data = schema.parse(req.body);
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Determine author type
      let authorType = 'customer';
      if (user.isVendor) authorType = 'vendor';
      if (user.isPhotographer) authorType = 'photographer';

      // Validate product/service posts - only vendors can create them
      if (data.postType === 'product' || data.postType === 'service') {
        if (authorType !== 'vendor') {
          return res.status(403).json({ 
            error: "Only vendors can create product or service posts" 
          });
        }
        
        // Verify the product/service belongs to the vendor
        if (data.postType === 'product' && data.productId) {
          const product = await storage.getVendorProduct(data.productId);
          if (!product) {
            return res.status(404).json({ error: "Product not found" });
          }
          const business = await storage.getBusinessByOwner(userId);
          if (!business || product.businessId !== business.id) {
            return res.status(403).json({ error: "You can only share your own products" });
          }
        }
        
        if (data.postType === 'service' && data.serviceId) {
          const service = await storage.getVendorService(data.serviceId);
          if (!service) {
            return res.status(404).json({ error: "Service not found" });
          }
          const business = await storage.getBusinessByOwner(userId);
          if (!business || service.businessId !== business.id) {
            return res.status(403).json({ error: "You can only share your own services" });
          }
        }
      }

      // If customer, they must tag a business or photographer they've used
      if (authorType === 'customer') {
        if (!data.taggedBusinessId && !data.taggedPhotographerId) {
          return res.status(400).json({ 
            error: "Customers must tag a business or photographer they've purchased from or used services of" 
          });
        }

        // Verify customer can tag the business or photographer
        if (data.taggedBusinessId) {
          const canTag = await storage.canCustomerTagBusiness(userId, data.taggedBusinessId);
          if (!canTag) {
            return res.status(403).json({ 
              error: "You can only tag businesses you've purchased from or used services of" 
            });
          }
        }

        if (data.taggedPhotographerId) {
          const canTag = await storage.canCustomerTagPhotographer(userId, data.taggedPhotographerId);
          if (!canTag) {
            return res.status(403).json({ 
              error: "You can only tag photographers you've had sessions with" 
            });
          }
        }
      }

      const post = await storage.createFeedPost({
        authorId: userId,
        authorType,
        postType: data.postType || 'text',
        content: data.content,
        imageUrl: data.imageUrl,
        taggedBusinessId: data.taggedBusinessId,
        taggedPhotographerId: data.taggedPhotographerId,
        productId: data.productId,
        serviceId: data.serviceId,
      });

      res.json({ success: true, post });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create post error:", error);
      res.status(500).json({ error: "Failed to create post" });
    }
  });

  // Like a post
  app.post("/api/feed/:postId/like", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { postId } = req.params;
      const liked = await storage.likePost(postId, userId);
      res.json({ success: true, liked });
    } catch (error) {
      console.error("Like post error:", error);
      res.status(500).json({ error: "Failed to like post" });
    }
  });

  // Unlike a post
  app.delete("/api/feed/:postId/like", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { postId } = req.params;
      const unliked = await storage.unlikePost(postId, userId);
      res.json({ success: true, unliked });
    } catch (error) {
      console.error("Unlike post error:", error);
      res.status(500).json({ error: "Failed to unlike post" });
    }
  });

  // Add a comment to a post
  app.post("/api/feed/:postId/comments", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { postId } = req.params;
      const schema = z.object({
        content: z.string().min(1).max(500),
      });

      const data = schema.parse(req.body);
      const comment = await storage.addPostComment({
        postId,
        userId,
        content: data.content,
      });

      res.json({ success: true, comment });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Add comment error:", error);
      res.status(500).json({ error: "Failed to add comment" });
    }
  });

  // Get comments for a post
  app.get("/api/feed/:postId/comments", async (req, res) => {
    try {
      const { postId } = req.params;
      const comments = await storage.getPostComments(postId);
      
      // Enrich with user info
      const enrichedComments = await Promise.all(comments.map(async (comment) => {
        const user = await storage.getUser(comment.userId);
        return {
          ...comment,
          user: user ? { id: user.id, name: user.name, profileImageUrl: user.profileImageUrl } : null,
        };
      }));
      
      res.json({ comments: enrichedComments });
    } catch (error) {
      console.error("Get comments error:", error);
      res.status(500).json({ error: "Failed to get comments" });
    }
  });

  // Get taggable businesses for customer
  app.get("/api/feed/taggable-businesses", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      // Get businesses the user has ordered from or had appointments with
      const reviewable = await storage.getReviewableBookings(userId);
      
      // Extract unique businesses from orders and appointments
      const businessIds = new Set<string>();
      for (const order of reviewable.orders) {
        if (order.businessId) businessIds.add(order.businessId);
      }
      for (const apt of reviewable.appointments) {
        if (apt.businessId) businessIds.add(apt.businessId);
      }
      
      const businesses = await Promise.all(
        Array.from(businessIds).map(id => storage.getBusiness(id))
      );
      
      res.json({ 
        businesses: businesses.filter(Boolean).map(b => ({
          id: b!.id,
          name: b!.name,
          logoImage: b!.logoImage,
        }))
      });
    } catch (error) {
      console.error("Get taggable businesses error:", error);
      res.status(500).json({ error: "Failed to get taggable businesses" });
    }
  });

  // Get taggable photographers for customer
  app.get("/api/feed/taggable-photographers", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      // Get photographers the user has had sessions with
      const reviewable = await storage.getReviewableBookings(userId);
      
      const photographerIds = new Set<string>();
      for (const booking of reviewable.shootBookings) {
        if (booking.photographerId) photographerIds.add(booking.photographerId);
      }
      
      const photographers = await Promise.all(
        Array.from(photographerIds).map(id => storage.getPhotographer(id))
      );
      
      res.json({ 
        photographers: photographers.filter(Boolean).map(p => ({
          id: p!.id,
          displayName: p!.displayName,
        }))
      });
    } catch (error) {
      console.error("Get taggable photographers error:", error);
      res.status(500).json({ error: "Failed to get taggable photographers" });
    }
  });

  // Delete a post (author only)
  app.delete("/api/feed/:postId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { postId } = req.params;
      const post = await storage.getFeedPost(postId);
      
      if (!post) {
        return res.status(404).json({ error: "Post not found" });
      }
      
      if (post.authorId !== userId) {
        return res.status(403).json({ error: "You can only delete your own posts" });
      }
      
      await storage.deleteFeedPost(postId);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete post error:", error);
      res.status(500).json({ error: "Failed to delete post" });
    }
  });

  return httpServer;
}
