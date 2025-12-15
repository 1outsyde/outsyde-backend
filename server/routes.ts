import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import {
  customerSignupSchema,
  vendorSignupSchema,
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

        if (user.isVendor) {
          const business = await storage.getBusinessByOwnerId(user.id);
          if (business) {
            req.session.businessId = business.id;
          }
        }
      }

      const { password: _, ...safeUser } = user;

      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(user.id);
        return res.json({ user: safeUser, business });
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

      // Platform fee is 2% of the final price
      const platformFeeInCents = Math.round(pricing.finalPriceCents * 0.02);

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

  return httpServer;
}
