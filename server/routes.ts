import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import {
  customerSignupSchema,
  vendorSignupSchema,
  photographerSignupSchema,
  loginSchema,
  insertReviewSchema,
  billingAddressSchema,
  subscriptionTiers,
  calculateAgeRange,
  type User,
} from "@shared/schema";

// Helper to sanitize user data for non-admin responses (removes sensitive fields)
// DOB: replaced with age range for privacy
// Ethnicity/race: never exposed at individual level, only aggregated
function sanitizeUserForResponse(user: User, options: { includeOwnData?: boolean } = {}) {
  const { 
    dateOfBirth, 
    password, 
    ethnicity,
    householdSize,
    incomeRange,
    education,
    occupation,
    ...safeUser 
  } = user;
  
  // Users can see their own DOB but not ethnicity (that's for aggregation only)
  if (options.includeOwnData) {
    return {
      ...safeUser,
      dateOfBirth,
      ageRange: calculateAgeRange(dateOfBirth),
    };
  }
  
  return {
    ...safeUser,
    ageRange: calculateAgeRange(dateOfBirth),
  };
}
import { eq } from "drizzle-orm";
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
import { getStripePublishableKey, getUncachableStripeClient } from "./stripe/stripeClient";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { ObjectPermission } from "./objectAcl";
import { NotificationTriggers } from "./notificationService";

// ✅ CORRECT IMPORT (default export)
import { photographersRouter } from "./Photographers/photographers.routes";

// Legacy password functions for backward compatibility with existing users
function legacyHashPassword(password: string): string {
  return Buffer.from(password).toString("base64");
}

// Helper to check if vendor has active subscription (for mutation endpoints)
async function requireActiveVendorSubscription(userId: string): Promise<{ allowed: boolean; error?: string }> {
  const result = await storage.isVendorSubscriptionActive(userId);
  if (!result.active) {
    return { 
      allowed: false, 
      error: result.reason || 'Your subscription is not active. Please reactivate to continue managing your business.' 
    };
  }
  return { allowed: true };
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
        username: data.username,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
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

      // User sees their own data on signup (includes DOB, excludes ethnicity)
      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });
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

      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });
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

      // User sees their own data on login (includes DOB, excludes ethnicity)
      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });

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
  // Returns user's own data including DOB, but excludes ethnicity (aggregation only)
  app.get("/api/auth/user", async (req, res) => {
    try {
      // Check for OAuth user first (from Replit Auth)
      const oauthUser = req.user as any;
      if (oauthUser?.claims?.sub) {
        const user = await storage.getUser(oauthUser.claims.sub);
        if (user) {
          // Use sanitizeUserForResponse with includeOwnData for user's own profile
          const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });
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

      // Use sanitizeUserForResponse with includeOwnData for user's own profile
      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });
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

  // ==================== NOTIFICATIONS ====================

  app.get("/api/notifications", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { limit, unreadOnly } = req.query;
      const options = {
        limit: limit ? parseInt(limit as string, 10) : 50,
        unreadOnly: unreadOnly === 'true',
      };
      const notifications = await storage.getUserNotifications(userId, options);
      const unreadCount = await storage.getUnreadNotificationCount(userId);
      res.json({ notifications, unreadCount });
    } catch (error) {
      console.error("Get notifications error:", error);
      res.status(500).json({ error: "Failed to get notifications" });
    }
  });

  app.get("/api/notifications/unread-count", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const count = await storage.getUnreadNotificationCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Get unread count error:", error);
      res.status(500).json({ error: "Failed to get unread count" });
    }
  });

  app.patch("/api/notifications/:id/read", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { id } = req.params;
      const notification = await storage.markNotificationRead(id, userId);
      if (!notification) {
        return res.status(404).json({ error: "Notification not found" });
      }
      res.json({ notification });
    } catch (error) {
      console.error("Mark notification read error:", error);
      res.status(500).json({ error: "Failed to mark notification as read" });
    }
  });

  app.post("/api/notifications/mark-all-read", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      await storage.markAllNotificationsRead(userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Mark all notifications read error:", error);
      res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
  });

  // ==================== BILLING ADDRESS ENDPOINTS ====================

  // Update user billing address
  app.patch("/api/profile/billing-address", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const billingAddress = billingAddressSchema.parse(req.body);
      const user = await storage.updateUser(userId, { billingAddress });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ billingAddress: user.billingAddress });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid billing address", details: error.errors });
      }
      console.error("Update billing address error:", error);
      res.status(500).json({ error: "Failed to update billing address" });
    }
  });

  // Update photographer billing address
  app.patch("/api/photographers/me/billing-address", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer not found" });
      }

      const billingAddress = billingAddressSchema.parse(req.body);
      const updated = await storage.updatePhotographer(photographer.id, { billingAddress });
      if (!updated) {
        return res.status(404).json({ error: "Failed to update photographer" });
      }
      res.json({ billingAddress: updated.billingAddress });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid billing address", details: error.errors });
      }
      console.error("Update photographer billing address error:", error);
      res.status(500).json({ error: "Failed to update billing address" });
    }
  });

  // Update business billing address
  app.patch("/api/businesses/me/billing-address", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const billingAddress = billingAddressSchema.parse(req.body);
      const updated = await storage.updateBusiness(business.id, { billingAddress });
      if (!updated) {
        return res.status(404).json({ error: "Failed to update business" });
      }
      res.json({ billingAddress: updated.billingAddress });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid billing address", details: error.errors });
      }
      console.error("Update business billing address error:", error);
      res.status(500).json({ error: "Failed to update billing address" });
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

      // Check photographer availability before booking
      const isAvailable = await storage.checkPhotographerSlotAvailable(
        data.photographerId,
        date,
        startTime,
        endTime
      );

      if (!isAvailable) {
        return res.status(409).json({ 
          error: "Time slot unavailable",
          message: "This photographer is not available during the selected time. Please choose a different time slot."
        });
      }

      // Calculate fees (10% Outsyde platform fee for photographers)
      const platformFee = Math.round(data.totalPriceCents * 0.10);
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

      // Reserve the photographer's time slot to prevent double bookings
      await storage.reservePhotographerSlot(
        data.photographerId,
        date,
        startTime,
        endTime,
        booking.id
      );

      const photographer = await storage.getPhotographer(data.photographerId);
      const photographerName = photographer?.displayName || 'Photographer';
      
      NotificationTriggers.bookingConfirmed({
        customerId: userId,
        photographerId: data.photographerId,
        bookingId: booking.id,
        photographerName,
        shootType: data.shootType,
        date,
        time: startTime,
      }).catch(err => console.error('Notification error:', err));

      res.status(201).json({ booking });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create photographer booking error:", error);
      res.status(500).json({ error: "Failed to create booking" });
    }
  });

  // ==================== BUSINESS APPOINTMENT ROUTES ====================

  // Create business appointment (customer facing)
  app.post("/api/appointments", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const appointmentSchema = z.object({
        businessId: z.string().min(1, "Business ID is required"),
        serviceId: z.string().min(1, "Service ID is required"),
        appointmentDate: z.string().min(1, "Date is required"),
        appointmentTime: z.string().min(1, "Time is required"),
        totalPriceCents: z.number().default(0),
      });

      const data = appointmentSchema.parse(req.body);

      // Get service to determine duration
      const service = await storage.getVendorService(data.serviceId);
      const serviceDurationMinutes = service?.durationMinutes || 60;

      // Calculate end time based on service duration
      const [hours, minutes] = data.appointmentTime.split(':').map(Number);
      const totalMinutes = hours * 60 + minutes + serviceDurationMinutes;
      const endHours = Math.floor(totalMinutes / 60) % 24;
      const endMinutes = totalMinutes % 60;
      const endTime = `${endHours.toString().padStart(2, '0')}:${endMinutes.toString().padStart(2, '0')}`;

      // Check business availability before booking
      const isAvailable = await storage.checkBusinessSlotAvailable(
        data.businessId,
        data.appointmentDate,
        data.appointmentTime,
        endTime
      );

      if (!isAvailable) {
        return res.status(409).json({ 
          error: "Time slot unavailable",
          message: "This business is not available during the selected time. Please choose a different time slot."
        });
      }

      // Calculate fees (4% Outsyde platform fee for businesses)
      const platformFee = Math.round(data.totalPriceCents * 0.04);
      const vendorNet = data.totalPriceCents - platformFee;

      const appointment = await storage.createAppointment({
        businessId: data.businessId,
        clientId: userId,
        serviceId: data.serviceId,
        appointmentDate: data.appointmentDate,
        appointmentTime: data.appointmentTime,
        totalPrice: data.totalPriceCents,
        platformFee,
        vendorNet,
        status: "pending",
      });

      // Reserve the business time slot to prevent double bookings
      await storage.reserveBusinessSlot(
        data.businessId,
        data.appointmentDate,
        data.appointmentTime,
        endTime,
        appointment.id
      );

      res.status(201).json({ appointment });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create appointment error:", error);
      res.status(500).json({ error: "Failed to create appointment" });
    }
  });

  // Get customer's appointments
  app.get("/api/my-appointments", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const appointments = await storage.getAppointmentsByClient(userId);
      res.json({ appointments });
    } catch (error) {
      console.error("Get appointments error:", error);
      res.status(500).json({ error: "Failed to get appointments" });
    }
  });

  // ==================== OBJECT STORAGE ROUTES ====================

  // Serve uploaded objects (public visibility)
  app.get("/objects/:objectPath(*)", async (req, res) => {
    const objectStorageService = new ObjectStorageService();
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      const userId = req.session?.userId;
      const canAccess = await objectStorageService.canAccessObjectEntity({
        objectFile,
        userId: userId,
        requestedPermission: ObjectPermission.READ,
      });
      if (!canAccess) {
        return res.sendStatus(401);
      }
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error("Error checking object access:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.sendStatus(404);
      }
      return res.sendStatus(500);
    }
  });

  // Get presigned upload URL
  app.post("/api/objects/upload", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      res.json({ uploadURL });
    } catch (error) {
      console.error("Error getting upload URL:", error);
      res.status(500).json({ error: "Failed to get upload URL" });
    }
  });

  // Finalize upload and set ACL policy
  app.post("/api/objects/finalize", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.body.uploadURL) {
      return res.status(400).json({ error: "uploadURL is required" });
    }

    try {
      const objectStorageService = new ObjectStorageService();
      const objectPath = await objectStorageService.trySetObjectEntityAclPolicy(
        req.body.uploadURL,
        {
          owner: userId,
          visibility: "public",
        }
      );
      res.json({ objectPath });
    } catch (error) {
      console.error("Error finalizing upload:", error);
      res.status(500).json({ error: "Failed to finalize upload" });
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

  // Change subscription tier (upgrade or downgrade)
  app.post("/api/vendor/subscription/change-tier", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can change subscription tier" });
    }

    try {
      const changeSchema = z.object({
        newTierId: z.string().min(1, "New tier ID is required"),
        prorationBehavior: z.enum(['create_prorations', 'none', 'always_invoice']).default('create_prorations'),
      });
      const { newTierId, prorationBehavior } = changeSchema.parse(req.body);

      // Get current subscription
      const subscription = await storage.getVendorSubscription(userId);
      if (!subscription) {
        return res.status(404).json({ error: "No active subscription found" });
      }

      if (!subscription.stripeSubscriptionId) {
        return res.status(400).json({ error: "No Stripe subscription linked" });
      }

      if (subscription.status !== 'active') {
        return res.status(400).json({ error: "Cannot change tier: subscription is not active" });
      }

      if (subscription.tierId === newTierId) {
        return res.status(400).json({ error: "Already on this tier" });
      }

      // Get the new tier
      const [newTier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, newTierId));
      if (!newTier || !newTier.stripePriceId) {
        return res.status(404).json({ error: "Tier not found or not configured for Stripe" });
      }

      // Get current tier for comparison
      const [currentTier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, subscription.tierId));
      const isUpgrade = (newTier.priceInCents || 0) > (currentTier?.priceInCents || 0);

      // Update the Stripe subscription with the new price
      const stripe = await getUncachableStripeClient();
      const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      const itemId = stripeSub.items.data[0]?.id;

      if (!itemId) {
        return res.status(400).json({ error: "No subscription items found" });
      }

      // Update the subscription - Stripe will handle proration
      const updatedStripeSub = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        items: [{
          id: itemId,
          price: newTier.stripePriceId,
        }],
        proration_behavior: prorationBehavior,
      });

      // The tier change will be detected and processed by the webhook handler
      // when Stripe sends the customer.subscription.updated event

      res.json({ 
        success: true, 
        message: isUpgrade ? 'Your subscription has been upgraded!' : 'Your subscription has been downgraded.',
        subscription: {
          previousTier: currentTier?.displayName || currentTier?.name,
          newTier: newTier.displayName || newTier.name,
          isUpgrade,
          effectiveImmediately: true,
        }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Change subscription tier error:", error);
      res.status(500).json({ error: "Failed to change subscription tier" });
    }
  });

  // Preview tier change proration
  app.post("/api/vendor/subscription/preview-change", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can preview subscription changes" });
    }

    try {
      const previewSchema = z.object({
        newTierId: z.string().min(1, "New tier ID is required"),
      });
      const { newTierId } = previewSchema.parse(req.body);

      // Get current subscription
      const subscription = await storage.getVendorSubscription(userId);
      if (!subscription || !subscription.stripeSubscriptionId) {
        return res.status(404).json({ error: "No active subscription found" });
      }

      if (subscription.status !== 'active') {
        return res.status(400).json({ error: "Cannot preview tier change: subscription is not active" });
      }

      // Get tier details
      const [newTier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, newTierId));
      const [currentTier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, subscription.tierId));
      
      if (!newTier || !newTier.stripePriceId) {
        return res.status(404).json({ error: "Tier not found" });
      }

      const isUpgrade = (newTier.priceInCents || 0) > (currentTier?.priceInCents || 0);

      // Get proration preview from Stripe
      const stripe = await getUncachableStripeClient();
      const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      const itemId = stripeSub.items.data[0]?.id;

      if (!itemId) {
        return res.status(400).json({ error: "No subscription items found" });
      }

      const invoice = await stripe.invoices.createPreview({
        customer: subscription.stripeCustomerId!,
        subscription: subscription.stripeSubscriptionId,
        subscription_details: {
          items: [{
            id: itemId,
            price: newTier.stripePriceId,
          }],
          proration_behavior: 'create_prorations',
        },
      });

      res.json({
        currentTier: {
          id: currentTier?.id,
          name: currentTier?.displayName || currentTier?.name,
          priceInCents: currentTier?.priceInCents || 0,
        },
        newTier: {
          id: newTier.id,
          name: newTier.displayName || newTier.name,
          priceInCents: newTier.priceInCents,
        },
        isUpgrade,
        proration: {
          amountDueCents: invoice.amount_due,
          creditAppliedCents: Math.abs(invoice.lines.data
            .filter(line => line.amount < 0)
            .reduce((sum, line) => sum + line.amount, 0)),
          immediateChargeCents: invoice.amount_due > 0 ? invoice.amount_due : 0,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Preview tier change error:", error);
      res.status(500).json({ error: "Failed to preview tier change" });
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

  // ==================== UNIFIED SEARCH ====================

  app.get("/api/search", async (req, res) => {
    try {
      const { city, category, search } = req.query;
      const results = await storage.searchAll({
        city: city as string | undefined,
        category: category as string | undefined,
        search: search as string | undefined,
      });
      res.json(results);
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: "Failed to search" });
    }
  });

  // ==================== PROFILE COMMENTS ====================

  // Get comments for a business or photographer profile
  app.get("/api/profile-comments/:targetType/:targetId", async (req, res) => {
    try {
      const { targetType, targetId } = req.params;
      if (targetType !== "business" && targetType !== "photographer") {
        return res.status(400).json({ error: "Invalid target type" });
      }
      const comments = await storage.getProfileComments(targetType, targetId);
      res.json({ comments });
    } catch (error) {
      console.error("Get profile comments error:", error);
      res.status(500).json({ error: "Failed to get comments" });
    }
  });

  // Add a comment to a business or photographer profile (authenticated users only)
  app.post("/api/profile-comments", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { targetType, targetId, content } = req.body;
      
      if (!targetType || !targetId || !content) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      
      if (targetType !== "business" && targetType !== "photographer") {
        return res.status(400).json({ error: "Invalid target type" });
      }

      if (content.trim().length === 0) {
        return res.status(400).json({ error: "Comment cannot be empty" });
      }

      const comment = await storage.createProfileComment({
        targetType,
        targetId,
        userId,
        content: content.trim()
      });

      // Get author info
      const user = await storage.getUser(userId);

      res.status(201).json({ 
        comment: {
          ...comment,
          authorName: user?.name || null,
          authorUsername: user?.username || null,
          authorImage: user?.profileImageUrl || null
        }
      });
    } catch (error) {
      console.error("Create profile comment error:", error);
      res.status(500).json({ error: "Failed to create comment" });
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
      
      // Filter out businesses without active subscriptions
      const activeBusinesses = [];
      for (const business of businesses) {
        const subStatus = await storage.isBusinessSubscriptionActive(business.id);
        if (subStatus.active) {
          activeBusinesses.push(business);
        }
      }
      
      res.json({ businesses: activeBusinesses });
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
      
      // Check if business has active subscription
      const subStatus = await storage.isBusinessSubscriptionActive(business.id);
      if (!subStatus.active) {
        return res.status(404).json({ error: "This business is currently unavailable" });
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
      
      // Check if business has active subscription
      const subStatus = await storage.isBusinessSubscriptionActive(business.id);
      if (!subStatus.active) {
        return res.status(404).json({ error: "This business is currently unavailable" });
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
      
      // Check if business has active subscription
      const subStatus = await storage.isBusinessSubscriptionActive(business.id);
      if (!subStatus.active) {
        return res.status(404).json({ error: "This business is currently unavailable" });
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

  // ==================== BUSINESS AVAILABILITY CALENDAR ROUTES ====================

  // Get business availability (for the current vendor)
  app.get("/api/vendor/availability", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const { startDate, endDate } = req.query;
      const availability = await storage.getBusinessAvailability(
        business.id,
        startDate as string | undefined,
        endDate as string | undefined
      );
      res.json({ availability });
    } catch (error) {
      console.error("Get vendor availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  });

  // Get public business availability (for customers booking)
  app.get("/api/businesses/:businessId/availability", async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const availability = await storage.getBusinessAvailability(
        req.params.businessId,
        startDate as string | undefined,
        endDate as string | undefined
      );
      res.json({ availability });
    } catch (error) {
      console.error("Get business availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  });

  // Create availability slot
  app.post("/api/vendor/availability", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const slotSchema = z.object({
        date: z.string().min(1),
        startTime: z.string().min(1),
        endTime: z.string().min(1),
        slotType: z.enum(["available", "blocked", "special"]).optional(),
        title: z.string().optional(),
        notes: z.string().optional(),
        isRecurring: z.boolean().optional(),
        recurringDayOfWeek: z.number().min(0).max(6).optional(),
      });

      const validated = slotSchema.parse(req.body);
      const slot = await storage.createBusinessAvailability({
        businessId: business.id,
        ...validated,
      });

      res.status(201).json({ slot });
    } catch (error) {
      console.error("Create availability slot error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create availability slot" });
    }
  });

  // Update availability slot
  app.patch("/api/vendor/availability/:slotId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      // Verify the slot belongs to this business
      const existingSlot = await storage.getBusinessAvailabilitySlot(req.params.slotId);
      if (!existingSlot || existingSlot.businessId !== business.id) {
        return res.status(404).json({ error: "Slot not found" });
      }

      const updateSchema = z.object({
        date: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        slotType: z.enum(["available", "blocked", "special"]).optional(),
        title: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        isRecurring: z.boolean().optional(),
        recurringDayOfWeek: z.number().min(0).max(6).nullable().optional(),
      });

      const validated = updateSchema.parse(req.body);
      const updated = await storage.updateBusinessAvailability(req.params.slotId, validated);

      res.json({ slot: updated });
    } catch (error) {
      console.error("Update availability slot error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to update availability slot" });
    }
  });

  // Delete availability slot
  app.delete("/api/vendor/availability/:slotId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      // Verify the slot belongs to this business
      const existingSlot = await storage.getBusinessAvailabilitySlot(req.params.slotId);
      if (!existingSlot || existingSlot.businessId !== business.id) {
        return res.status(404).json({ error: "Slot not found" });
      }

      await storage.deleteBusinessAvailability(req.params.slotId);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete availability slot error:", error);
      res.status(500).json({ error: "Failed to delete availability slot" });
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
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

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
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

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
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

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
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

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
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

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
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

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
      // Sanitize user data to remove sensitive fields like DOB
      const sanitizedConversations = conversations.map(convo => ({
        ...convo,
        otherParticipant: sanitizeUserForResponse(convo.otherParticipant),
      }));
      res.json({ conversations: sanitizedConversations });
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
  // Note: General API rate limiting (100 req/min authenticated) applies
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

      // Check if either user has blocked the other
      const otherUserId = conversation.participant1Id === userId 
        ? conversation.participant2Id 
        : conversation.participant1Id;
      const isBlocked = await storage.isUserBlockedEitherWay(userId, otherUserId);
      if (isBlocked) {
        return res.status(403).json({ 
          error: "Cannot send message",
          message: "You cannot send messages in this conversation."
        });
      }

      const messageSchema = z.object({
        content: z.string()
          .min(1, "Message content is required")
          .max(2000, "Message cannot exceed 2000 characters"),
      });
      const { content } = messageSchema.parse(req.body);

      // Basic content abuse detection
      const urlPattern = /(https?:\/\/[^\s]+)/gi;
      const urlCount = (content.match(urlPattern) || []).length;
      if (urlCount > 5) {
        return res.status(400).json({ 
          error: "Message contains too many links",
          message: "Messages cannot contain more than 5 links."
        });
      }

      // Detect repeated message spam (same content sent rapidly)
      const recentMessages = await storage.getConversationMessages(req.params.id, 5);
      const duplicateCount = recentMessages.filter(
        m => m.senderId === userId && m.content === content
      ).length;
      if (duplicateCount >= 2) {
        return res.status(400).json({ 
          error: "Duplicate message detected",
          message: "Please avoid sending the same message repeatedly."
        });
      }

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

  // ==================== USER BLOCKING ROUTES ====================

  // Block a user
  app.post("/api/users/:userId/block", async (req, res) => {
    const blockerId = req.session?.userId;
    if (!blockerId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const blockedId = req.params.userId;
    if (blockerId === blockedId) {
      return res.status(400).json({ error: "You cannot block yourself" });
    }

    try {
      const { reason } = req.body || {};
      const block = await storage.blockUser(blockerId, blockedId, reason);
      res.json({ success: true, block });
    } catch (error) {
      console.error("Block user error:", error);
      res.status(500).json({ error: "Failed to block user" });
    }
  });

  // Unblock a user
  app.delete("/api/users/:userId/block", async (req, res) => {
    const blockerId = req.session?.userId;
    if (!blockerId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const success = await storage.unblockUser(blockerId, req.params.userId);
      res.json({ success });
    } catch (error) {
      console.error("Unblock user error:", error);
      res.status(500).json({ error: "Failed to unblock user" });
    }
  });

  // Get list of blocked users
  app.get("/api/users/blocked", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const blockedUsers = await storage.getBlockedUsers(userId);
      res.json({ blockedUsers });
    } catch (error) {
      console.error("Get blocked users error:", error);
      res.status(500).json({ error: "Failed to get blocked users" });
    }
  });

  // Check if a user is blocked
  app.get("/api/users/:userId/blocked", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const isBlocked = await storage.isUserBlocked(userId, req.params.userId);
      res.json({ isBlocked });
    } catch (error) {
      console.error("Check blocked status error:", error);
      res.status(500).json({ error: "Failed to check blocked status" });
    }
  });

  // ==================== MESSAGE REPORTING ROUTES ====================

  // Report a message
  app.post("/api/messages/:messageId/report", async (req, res) => {
    const reporterId = req.session?.userId;
    if (!reporterId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const reportSchema = z.object({
        reason: z.string().min(1, "Reason is required").max(500, "Reason too long"),
        conversationId: z.string(),
        reportedUserId: z.string(),
      });
      const { reason, conversationId, reportedUserId } = reportSchema.parse(req.body);

      if (reporterId === reportedUserId) {
        return res.status(400).json({ error: "You cannot report your own messages" });
      }

      const report = await storage.createMessageReport({
        reporterId,
        messageId: req.params.messageId,
        conversationId,
        reportedUserId,
        reason,
      });

      res.json({ success: true, report });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Report message error:", error);
      res.status(500).json({ error: "Failed to report message" });
    }
  });

  // Get user's submitted reports
  app.get("/api/messages/my-reports", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const reports = await storage.getMessageReports({ reporterId: userId });
      res.json({ reports });
    } catch (error) {
      console.error("Get my reports error:", error);
      res.status(500).json({ error: "Failed to get reports" });
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
      const stats = await storage.getReferralStats(userId);
      
      res.json({
        referralCode: code,
        referralLink: `${req.protocol}://${req.get('host')}/signup?ref=${code}`,
        bonusForReferrer: 500, // $5 worth, awarded after referred user's first transaction
        bonusForNewUser: 250, // $2.50 welcome bonus, awarded immediately
        referredBy: user?.referredBy || null,
        stats: {
          totalReferrals: stats.totalReferrals,
          completedReferrals: stats.completedReferrals,
          pendingReferrals: stats.pendingReferrals,
          totalPointsEarned: stats.totalPointsEarned,
        },
        note: "Your referral bonus (500 points) is awarded after your friend completes their first purchase.",
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
        message: "Referral applied! You've earned 250 welcome bonus points. Your friend will earn 500 points when you complete your first purchase.",
        pointsEarned: 250,
        newBalance,
        referrerBonusPending: true,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid referral code format" });
      }
      console.error("Apply referral error:", error);
      res.status(500).json({ error: "Failed to apply referral code" });
    }
  });

  // Get referral stats for the current user
  app.get("/api/referral/stats", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const stats = await storage.getReferralStats(userId);
      const pendingReferral = await storage.getPendingReferral(userId);
      
      res.json({
        asReferrer: stats,
        asReferred: pendingReferral ? {
          status: pendingReferral.status,
          referrerBonusPending: pendingReferral.status === 'pending',
          completedAt: pendingReferral.referrerBonusPaidAt,
        } : null,
      });
    } catch (error) {
      console.error("Get referral stats error:", error);
      res.status(500).json({ error: "Failed to get referral stats" });
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

      // Block adding items from businesses with inactive subscriptions
      if (data.businessId) {
        const subStatus = await storage.isBusinessSubscriptionActive(data.businessId);
        if (!subStatus.active) {
          return res.status(403).json({ error: "This business is currently unavailable for purchases" });
        }
      }

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

  // Email-locked admin access - only these emails can have admin privileges
  // This list is hardcoded server-side and cannot be modified by client-side logic
  const ALLOWED_ADMIN_EMAILS = [
    'info@goutsyde.com',
    'jamesmeyers2304@gmail.com',
  ].map(e => e.toLowerCase());

  // Helper to check if an email is allowed to be admin
  const isAllowedAdminEmail = (email: string | null | undefined): boolean => {
    if (!email) return false;
    return ALLOWED_ADMIN_EMAILS.includes(email.toLowerCase());
  };

  // Middleware to check if user is admin (email-locked, server-enforced)
  const requireAdmin = async (req: any, res: any, next: any) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(userId);
    
    // Check both isAdmin flag AND email is in allowed list
    if (!user?.isAdmin || !isAllowedAdminEmail(user.email)) {
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

      if (data.status === 'approved') {
        // Update order/booking status to refunded with state machine validation
        if (request.targetType === 'order' && request.targetId) {
          const orderResult = await storage.updateOrderWithValidation(
            request.targetId,
            { status: 'refunded' },
            adminUser.id
          );
          if (!orderResult.success) {
            console.warn('Failed to update order status to refunded:', orderResult.error);
          }
        } else if (request.targetType === 'shoot_booking' && request.targetId) {
          const bookingResult = await storage.updateBookingWithValidation(
            request.targetId,
            { status: 'refunded' },
            adminUser.id
          );
          if (!bookingResult.success) {
            console.warn('Failed to update booking status to refunded:', bookingResult.error);
          }
          // Release photographer availability slot
          await storage.releasePhotographerSlot(request.targetId);
        } else if (request.targetType === 'appointment' && request.targetId) {
          // Release business availability slot
          await storage.releaseBusinessSlot(request.targetId);
        }

        // Reverse loyalty points earned from this transaction
        const pointReversal = await storage.reversePointsForRefund(
          request.requesterId,
          request.targetType || 'refund',
          request.targetId || id
        );
        if (pointReversal.reversed) {
          console.log(`Reversed ${pointReversal.pointsReversed} points for user ${request.requesterId}`);
        }

        // Revoke reviews associated with the refunded booking/order
        if (request.targetType && request.targetId) {
          const revokedCount = await storage.revokeReviewsForRefund(
            request.targetType,
            request.targetId
          );
          if (revokedCount > 0) {
            console.log(`Revoked ${revokedCount} reviews for refunded ${request.targetType}: ${request.targetId}`);
          }
        }

        // Create audit log for refund approval
        await storage.createAuditLog({
          actorId: adminUser.id,
          actorType: 'admin',
          action: 'refund_approved',
          targetType: 'refund_request',
          targetId: id,
          metadata: {
            amount: request.amount,
            targetType: request.targetType,
            targetId: request.targetId,
            pointsReversed: pointReversal.pointsReversed,
            adminNotes: data.adminNotes
          }
        });

        NotificationTriggers.refundIssued({
          userId: request.requesterId,
          amount: request.amount,
          referenceType: request.targetType || 'refund_request',
          referenceId: request.targetId || id,
          reason: data.adminNotes || undefined,
        }).catch(err => console.error('Notification error:', err));
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

  // ==================== ADMIN DASHBOARD ROUTES ====================

  // Admin: Get dashboard overview stats
  app.get("/api/admin/stats", requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      const businesses = await storage.getAllBusinesses();
      const photographers = await storage.getAllPhotographers();
      const orders = await storage.getAllOrders();
      const bookings = await storage.getAllShootBookings();
      const refundRequests = await storage.getAllPendingRefundRequests();

      const totalRevenue = orders.reduce((sum, order) => sum + (order.totalCents || 0), 0);
      const totalBookingRevenue = bookings.reduce((sum, booking) => sum + (booking.totalPriceCents || 0), 0);

      res.json({
        stats: {
          totalUsers: users.length,
          totalBusinesses: businesses.length,
          totalPhotographers: photographers.length,
          totalOrders: orders.length,
          totalBookings: bookings.length,
          pendingRefunds: refundRequests.length,
          totalRevenue: (totalRevenue + totalBookingRevenue) / 100,
          regularCustomers: users.filter(u => !u.isVendor && !u.isPhotographer).length,
        }
      });
    } catch (error) {
      console.error("Get admin stats error:", error);
      res.status(500).json({ error: "Failed to get admin stats" });
    }
  });

  // Admin: Get all users
  app.get("/api/admin/users", requireAdmin, async (req, res) => {
    try {
      const { type, search, limit = "50", offset = "0" } = req.query;
      let users = await storage.getAllUsers();

      // Filter by type
      if (type === "customers") {
        users = users.filter(u => !u.isVendor && !u.isPhotographer);
      } else if (type === "vendors") {
        users = users.filter(u => u.isVendor);
      } else if (type === "photographers") {
        users = users.filter(u => u.isPhotographer);
      }

      // Search filter
      if (search) {
        const searchLower = (search as string).toLowerCase();
        users = users.filter(u => 
          u.email?.toLowerCase().includes(searchLower) ||
          u.name?.toLowerCase().includes(searchLower) ||
          u.firstName?.toLowerCase().includes(searchLower) ||
          u.lastName?.toLowerCase().includes(searchLower)
        );
      }

      // Pagination
      const start = parseInt(offset as string);
      const end = start + parseInt(limit as string);
      const paginatedUsers = users.slice(start, end);

      // Remove sensitive data
      const safeUsers = paginatedUsers.map(u => ({
        id: u.id,
        email: u.email,
        name: u.name,
        firstName: u.firstName,
        lastName: u.lastName,
        city: u.city,
        state: u.state,
        isVendor: u.isVendor,
        isPhotographer: u.isPhotographer,
        isAdmin: u.isAdmin,
        createdAt: u.createdAt,
        loyaltyPoints: u.loyaltyPoints,
      }));

      res.json({ users: safeUsers, total: users.length });
    } catch (error) {
      console.error("Get admin users error:", error);
      res.status(500).json({ error: "Failed to get users" });
    }
  });

  // Admin: Get single user details
  app.get("/api/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const user = await storage.getUser(id);

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get related data
      let business = null;
      let photographer = null;
      let orders: any[] = [];
      let bookings: any[] = [];

      if (user.isVendor) {
        business = await storage.getBusinessByOwnerId(id);
        if (business) {
          orders = await storage.getVendorOrders(business.id);
        }
      }

      if (user.isPhotographer) {
        photographer = await storage.getPhotographerByUserId(id);
        if (photographer) {
          bookings = await storage.getPhotographerBookings(photographer.id);
        }
      }

      // Get customer orders if regular user
      if (!user.isVendor && !user.isPhotographer) {
        orders = await storage.getUserOrders(id);
        bookings = await storage.getUserBookings(id);
      }

      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          city: user.city,
          state: user.state,
          isVendor: user.isVendor,
          isPhotographer: user.isPhotographer,
          isAdmin: user.isAdmin,
          createdAt: user.createdAt,
          loyaltyPoints: user.loyaltyPoints,
        },
        business,
        photographer,
        orders,
        bookings,
      });
    } catch (error) {
      console.error("Get admin user details error:", error);
      res.status(500).json({ error: "Failed to get user details" });
    }
  });

  // Admin: Update user
  app.patch("/api/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const schema = z.object({
        name: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        isAdmin: z.boolean().optional(),
        loyaltyPoints: z.number().optional(),
      });

      const data = schema.parse(req.body);

      // Get target user first for all email-lock checks
      const targetUser = await storage.getUser(id);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }

      // SECURITY: Email-locked admin access enforcement
      // 1. Cannot change email TO an allowed admin email (prevents hijacking)
      if (data.email && data.email.toLowerCase() !== targetUser.email?.toLowerCase()) {
        if (isAllowedAdminEmail(data.email)) {
          return res.status(403).json({ 
            error: "Cannot use this email",
            message: "This email address is reserved for admin accounts."
          });
        }
      }

      // 2. Cannot set isAdmin=true on users whose email is not in ALLOWED_ADMIN_EMAILS
      if (data.isAdmin === true && !isAllowedAdminEmail(targetUser.email)) {
        return res.status(403).json({ 
          error: "Cannot grant admin access",
          message: "This email is not authorized for admin privileges."
        });
      }

      // 3. Auto-revoke admin if changing email away from allowed admin email
      if (data.email && isAllowedAdminEmail(targetUser.email) && !isAllowedAdminEmail(data.email)) {
        data.isAdmin = false; // Auto-revoke admin privileges
      }

      const user = await storage.updateUser(id, data);

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ success: true, user });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update admin user error:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  // Admin: Get all businesses
  app.get("/api/admin/businesses", requireAdmin, async (req, res) => {
    try {
      const { search, category, limit = "50", offset = "0" } = req.query;
      let businesses = await storage.getAllBusinesses();

      // Category filter
      if (category) {
        businesses = businesses.filter(b => b.category === category);
      }

      // Search filter
      if (search) {
        const searchLower = (search as string).toLowerCase();
        businesses = businesses.filter(b =>
          b.name.toLowerCase().includes(searchLower) ||
          b.description?.toLowerCase().includes(searchLower)
        );
      }

      // Pagination
      const start = parseInt(offset as string);
      const end = start + parseInt(limit as string);
      const paginatedBusinesses = businesses.slice(start, end);

      // Get owner info for each business
      const enrichedBusinesses = await Promise.all(paginatedBusinesses.map(async (b) => {
        const owner = await storage.getUser(b.ownerId);
        return {
          ...b,
          ownerEmail: owner?.email,
          ownerName: owner?.name || `${owner?.firstName || ''} ${owner?.lastName || ''}`.trim(),
        };
      }));

      res.json({ businesses: enrichedBusinesses, total: businesses.length });
    } catch (error) {
      console.error("Get admin businesses error:", error);
      res.status(500).json({ error: "Failed to get businesses" });
    }
  });

  // Admin: Update business
  app.patch("/api/admin/businesses/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const schema = z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        contactEmail: z.string().email().optional(),
        contactPhone: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
      });

      const data = schema.parse(req.body);
      const business = await storage.updateBusiness(id, data);

      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      res.json({ success: true, business });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update admin business error:", error);
      res.status(500).json({ error: "Failed to update business" });
    }
  });

  // Admin: Get all photographers
  app.get("/api/admin/photographers", requireAdmin, async (req, res) => {
    try {
      const { search, limit = "50", offset = "0" } = req.query;
      let photographers = await storage.getAllPhotographers();

      // Search filter
      if (search) {
        const searchLower = (search as string).toLowerCase();
        photographers = photographers.filter(p =>
          p.displayName?.toLowerCase().includes(searchLower) ||
          p.bio?.toLowerCase().includes(searchLower)
        );
      }

      // Pagination
      const start = parseInt(offset as string);
      const end = start + parseInt(limit as string);
      const paginatedPhotographers = photographers.slice(start, end);

      // Get user info for each photographer
      const enrichedPhotographers = await Promise.all(paginatedPhotographers.map(async (p) => {
        const user = await storage.getUser(p.userId);
        return {
          ...p,
          userEmail: user?.email,
          userName: user?.name || `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
        };
      }));

      res.json({ photographers: enrichedPhotographers, total: photographers.length });
    } catch (error) {
      console.error("Get admin photographers error:", error);
      res.status(500).json({ error: "Failed to get photographers" });
    }
  });

  // Admin: Update photographer
  app.patch("/api/admin/photographers/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const schema = z.object({
        displayName: z.string().optional(),
        bio: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        hourlyRate: z.number().optional(),
        specialties: z.array(z.string()).optional(),
      });

      const data = schema.parse(req.body);
      const photographer = await storage.updatePhotographer(id, data);

      if (!photographer) {
        return res.status(404).json({ error: "Photographer not found" });
      }

      res.json({ success: true, photographer });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update admin photographer error:", error);
      res.status(500).json({ error: "Failed to update photographer" });
    }
  });

  // Admin: Get all orders/transactions
  app.get("/api/admin/orders", requireAdmin, async (req, res) => {
    try {
      const { status, limit = "50", offset = "0" } = req.query;
      let orders = await storage.getAllOrders();

      // Status filter
      if (status) {
        orders = orders.filter(o => o.status === status);
      }

      // Sort by date descending
      orders.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

      // Pagination
      const start = parseInt(offset as string);
      const end = start + parseInt(limit as string);
      const paginatedOrders = orders.slice(start, end);

      // Enrich with customer and business info
      const enrichedOrders = await Promise.all(paginatedOrders.map(async (order) => {
        const customer = await storage.getUser(order.userId);
        const business = await storage.getBusiness(order.businessId);
        return {
          ...order,
          customerEmail: customer?.email,
          customerName: customer?.name || `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim(),
          businessName: business?.name,
        };
      }));

      res.json({ orders: enrichedOrders, total: orders.length });
    } catch (error) {
      console.error("Get admin orders error:", error);
      res.status(500).json({ error: "Failed to get orders" });
    }
  });

  // Admin: Get all photographer bookings
  app.get("/api/admin/bookings", requireAdmin, async (req, res) => {
    try {
      const { status, limit = "50", offset = "0" } = req.query;
      let bookings = await storage.getAllShootBookings();

      // Status filter
      if (status) {
        bookings = bookings.filter(b => b.status === status);
      }

      // Sort by date descending
      bookings.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

      // Pagination
      const start = parseInt(offset as string);
      const end = start + parseInt(limit as string);
      const paginatedBookings = bookings.slice(start, end);

      // Enrich with customer and photographer info
      const enrichedBookings = await Promise.all(paginatedBookings.map(async (booking) => {
        const customer = await storage.getUser(booking.customerId);
        const photographer = await storage.getPhotographer(booking.photographerId);
        return {
          ...booking,
          customerEmail: customer?.email,
          customerName: customer?.name || `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim(),
          photographerName: photographer?.displayName,
        };
      }));

      res.json({ bookings: enrichedBookings, total: bookings.length });
    } catch (error) {
      console.error("Get admin bookings error:", error);
      res.status(500).json({ error: "Failed to get bookings" });
    }
  });

  // Admin: Get all conversations/messages
  app.get("/api/admin/conversations", requireAdmin, async (req, res) => {
    try {
      const { limit = "50", offset = "0" } = req.query;
      const conversations = await storage.getAllConversations();

      // Pagination
      const start = parseInt(offset as string);
      const end = start + parseInt(limit as string);
      const paginatedConversations = conversations.slice(start, end);

      // Enrich with participant info
      const enrichedConversations = await Promise.all(paginatedConversations.map(async (conv) => {
        const participants = await Promise.all(conv.participants.map(async (pId: string) => {
          const user = await storage.getUser(pId);
          return {
            id: pId,
            email: user?.email,
            name: user?.name || `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
          };
        }));

        const messages = await storage.getMessages(conv.id);
        const lastMessage = messages[messages.length - 1];

        return {
          ...conv,
          participants,
          messageCount: messages.length,
          lastMessageAt: lastMessage?.createdAt,
          lastMessagePreview: lastMessage?.content?.substring(0, 100),
        };
      }));

      res.json({ conversations: enrichedConversations, total: conversations.length });
    } catch (error) {
      console.error("Get admin conversations error:", error);
      res.status(500).json({ error: "Failed to get conversations" });
    }
  });

  // Admin: Get messages in a conversation
  app.get("/api/admin/conversations/:id/messages", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const messages = await storage.getMessages(id);

      // Enrich with sender info
      const enrichedMessages = await Promise.all(messages.map(async (msg) => {
        const sender = await storage.getUser(msg.senderId);
        return {
          ...msg,
          senderEmail: sender?.email,
          senderName: sender?.name || `${sender?.firstName || ''} ${sender?.lastName || ''}`.trim(),
        };
      }));

      res.json({ messages: enrichedMessages });
    } catch (error) {
      console.error("Get admin conversation messages error:", error);
      res.status(500).json({ error: "Failed to get messages" });
    }
  });

  // ==================== ADMIN MESSAGE REPORTS ====================

  // Admin: Get all message reports
  app.get("/api/admin/message-reports", requireAdmin, async (req, res) => {
    try {
      const { status } = req.query;
      const reports = await storage.getMessageReports({ 
        status: status as string | undefined 
      });

      // Enrich with user info
      const enrichedReports = await Promise.all(reports.map(async (report) => {
        const [reporter, reported] = await Promise.all([
          storage.getUser(report.reporterId),
          storage.getUser(report.reportedUserId),
        ]);
        return {
          ...report,
          reporterEmail: reporter?.email,
          reporterName: reporter?.name || `${reporter?.firstName || ''} ${reporter?.lastName || ''}`.trim(),
          reportedUserEmail: reported?.email,
          reportedUserName: reported?.name || `${reported?.firstName || ''} ${reported?.lastName || ''}`.trim(),
        };
      }));

      res.json({ reports: enrichedReports, total: reports.length });
    } catch (error) {
      console.error("Get admin message reports error:", error);
      res.status(500).json({ error: "Failed to get message reports" });
    }
  });

  // Admin: Update a message report (resolve or dismiss)
  app.patch("/api/admin/message-reports/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updateSchema = z.object({
        status: z.enum(["pending", "resolved", "dismissed"]),
        adminNotes: z.string().max(1000).optional(),
      });
      const data = updateSchema.parse(req.body);

      const report = await storage.updateMessageReport(id, {
        status: data.status,
        adminNotes: data.adminNotes,
        resolvedAt: data.status !== "pending" ? new Date() : undefined,
        resolvedByAdminId: data.status !== "pending" ? req.session?.userId : undefined,
      });

      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }

      res.json({ success: true, report });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update message report error:", error);
      res.status(500).json({ error: "Failed to update message report" });
    }
  });

  // Admin: Get single message report details
  app.get("/api/admin/message-reports/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const report = await storage.getMessageReport(id);

      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }

      // Get related data
      const [reporter, reported, message] = await Promise.all([
        storage.getUser(report.reporterId),
        storage.getUser(report.reportedUserId),
        storage.getMessage(report.messageId),
      ]);

      res.json({
        report: {
          ...report,
          reporterEmail: reporter?.email,
          reporterName: reporter?.name || `${reporter?.firstName || ''} ${reporter?.lastName || ''}`.trim(),
          reportedUserEmail: reported?.email,
          reportedUserName: reported?.name || `${reported?.firstName || ''} ${reported?.lastName || ''}`.trim(),
          messageContent: message?.content,
          messageSentAt: message?.createdAt,
        },
      });
    } catch (error) {
      console.error("Get message report error:", error);
      res.status(500).json({ error: "Failed to get message report" });
    }
  });

  // ==================== ADMIN AUDIT LOGS ====================

  // Admin: Get audit logs with filtering
  app.get("/api/admin/audit-logs", requireAdmin, async (req, res) => {
    try {
      const { action, targetType, targetId, actorId, limit = "50", offset = "0" } = req.query;
      
      const logs = await storage.getAuditLogsFiltered({
        action: action as string | undefined,
        targetType: targetType as string | undefined,
        targetId: targetId as string | undefined,
        actorId: actorId as string | undefined,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      });

      res.json({ logs, filters: { action, targetType, targetId, actorId } });
    } catch (error) {
      console.error("Get audit logs error:", error);
      res.status(500).json({ error: "Failed to get audit logs" });
    }
  });

  // Admin: Get audit logs for a specific target
  app.get("/api/admin/audit-logs/:targetType/:targetId", requireAdmin, async (req, res) => {
    try {
      const { targetType, targetId } = req.params;
      const logs = await storage.getAuditLogs(targetType, targetId);
      res.json({ logs });
    } catch (error) {
      console.error("Get target audit logs error:", error);
      res.status(500).json({ error: "Failed to get audit logs" });
    }
  });

  // ==================== FEED POSTS ROUTES ====================

  // Get feed posts (public)
  app.get("/api/feed", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const posts = await storage.getFeedPosts(limit, offset);
      
      // Filter out posts from vendors with inactive subscriptions
      const activePosts = [];
      for (const post of posts) {
        if (post.authorType === 'vendor' && post.authorId) {
          const subStatus = await storage.isVendorSubscriptionActive(post.authorId);
          if (!subStatus.active) {
            continue; // Skip posts from inactive vendors
          }
        }
        activePosts.push(post);
      }
      
      // Enrich posts with author, tagged entities, and product/service info
      const enrichedPosts = await Promise.all(activePosts.map(async (post) => {
        const author = await storage.getUser(post.authorId);
        let taggedBusiness = null;
        let taggedPhotographer = null;
        let product = null;
        let service = null;
        let authorBusinessId: string | null = null;
        let authorPhotographerId: string | null = null;
        
        // Get the author's storefront ID based on their type
        if (post.authorType === 'vendor' && post.authorId) {
          const business = await storage.getBusinessByOwnerId(post.authorId);
          if (business) {
            authorBusinessId = business.id;
          }
        } else if (post.authorType === 'photographer' && post.authorId) {
          const photographer = await storage.getPhotographerByUserId(post.authorId);
          if (photographer) {
            authorPhotographerId = photographer.id;
          }
        }
        
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
          author: author ? { 
            id: author.id, 
            name: author.name, 
            profileImageUrl: author.profileImageUrl,
            businessId: authorBusinessId,
            photographerId: authorPhotographerId,
          } : null,
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
          user: user ? { 
            id: user.id, 
            name: user.name, 
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            profileImageUrl: user.profileImageUrl 
          } : null,
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

  // =====================================================
  // SHIPMENT TRACKING ROUTES
  // =====================================================

  // Vendor: Create shipment for an order
  app.post("/api/orders/:orderId/shipments", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can create shipments" });
    }

    try {
      // Check subscription status
      const subCheck = await requireActiveVendorSubscription(userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.error });
      }

      const { orderId } = req.params;
      const shipmentSchema = z.object({
        carrier: z.string().min(1, "Carrier is required"),
        trackingNumber: z.string().min(1, "Tracking number is required"),
        estimatedDelivery: z.string().optional(),
        notes: z.string().optional(),
      });

      const data = shipmentSchema.parse(req.body);

      // Get the business for this vendor
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // Get the order and verify it belongs to this business
      const orders = await storage.getVendorOrders(business.id);
      const order = orders.find(o => o.id === orderId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      // Create the shipment
      const shipment = await storage.createShipment({
        orderId,
        businessId: business.id,
        carrier: data.carrier,
        trackingNumber: data.trackingNumber,
        status: 'shipped',
        estimatedDelivery: data.estimatedDelivery ? new Date(data.estimatedDelivery) : null,
        notes: data.notes || null,
      });

      // Update order status to shipped
      await storage.updateOrder(orderId, { status: 'shipped' });

      // Create notification for customer
      NotificationTriggers.orderShipped({
        customerId: order.customerId,
        orderId,
        carrier: data.carrier,
        trackingNumber: data.trackingNumber,
      }).catch(err => console.error('Notification error:', err));

      res.status(201).json({ shipment });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create shipment error:", error);
      res.status(500).json({ error: "Failed to create shipment" });
    }
  });

  // Get shipments for an order (accessible by vendor owner or customer)
  app.get("/api/orders/:orderId/shipments", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { orderId } = req.params;
      
      // Check authorization - must be either the customer or the vendor
      let authorized = false;
      
      // Check if user is the customer
      const customerOrders = await storage.getUserOrders(userId);
      if (customerOrders.some(o => o.id === orderId)) {
        authorized = true;
      }
      
      // Check if user is the vendor
      if (!authorized && req.session?.isVendor) {
        const business = await storage.getBusinessByOwnerId(userId);
        if (business) {
          const vendorOrders = await storage.getVendorOrders(business.id);
          if (vendorOrders.some(o => o.id === orderId)) {
            authorized = true;
          }
        }
      }
      
      if (!authorized) {
        return res.status(403).json({ error: "Not authorized to view this order's shipments" });
      }
      
      const shipments = await storage.getShipmentsByOrder(orderId);
      res.json({ shipments });
    } catch (error) {
      console.error("Get order shipments error:", error);
      res.status(500).json({ error: "Failed to get shipments" });
    }
  });

  // Vendor: Update shipment status
  app.patch("/api/shipments/:shipmentId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can update shipments" });
    }

    try {
      const { shipmentId } = req.params;
      const updateSchema = z.object({
        status: z.enum(['pending', 'shipped', 'in_transit', 'delivered', 'exception']).optional(),
        trackingNumber: z.string().optional(),
        estimatedDelivery: z.string().optional().nullable(),
        deliveredAt: z.string().optional().nullable(),
        notes: z.string().optional().nullable(),
      });

      const data = updateSchema.parse(req.body);

      // Get business for this vendor
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // Get the shipment and verify it belongs to this business
      const shipment = await storage.getShipment(shipmentId);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      
      if (shipment.businessId !== business.id) {
        return res.status(403).json({ error: "Not authorized to update this shipment" });
      }

      // Build updates
      const updates: any = {};
      if (data.status) updates.status = data.status;
      if (data.trackingNumber) updates.trackingNumber = data.trackingNumber;
      if (data.estimatedDelivery !== undefined) {
        updates.estimatedDelivery = data.estimatedDelivery ? new Date(data.estimatedDelivery) : null;
      }
      if (data.deliveredAt !== undefined) {
        updates.deliveredAt = data.deliveredAt ? new Date(data.deliveredAt) : null;
      }
      if (data.notes !== undefined) updates.notes = data.notes;

      // If marking as delivered, set deliveredAt if not provided
      if (data.status === 'delivered' && !data.deliveredAt) {
        updates.deliveredAt = new Date();
      }

      const updatedShipment = await storage.updateShipment(shipmentId, updates);

      // If status changed to delivered, update order status
      if (data.status === 'delivered') {
        await storage.updateOrder(shipment.orderId, { status: 'delivered' });
      }

      res.json({ shipment: updatedShipment });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update shipment error:", error);
      res.status(500).json({ error: "Failed to update shipment" });
    }
  });

  // Vendor: Get all shipments for their business
  app.get("/api/vendor/shipments", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!req.session?.isVendor) {
      return res.status(403).json({ error: "Only vendors can access this endpoint" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const shipments = await storage.getShipmentsByBusiness(business.id);
      res.json({ shipments });
    } catch (error) {
      console.error("Get vendor shipments error:", error);
      res.status(500).json({ error: "Failed to get shipments" });
    }
  });

  // Customer: Get their orders with shipment info
  app.get("/api/my-orders", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const orders = await storage.getUserOrders(userId);
      
      // Enrich orders with business names and shipment info
      const enrichedOrders = await Promise.all(
        orders.map(async (order) => {
          const business = await storage.getBusinessById(order.businessId);
          const shipments = await storage.getShipmentsByOrder(order.id);
          
          return {
            id: order.id,
            businessId: order.businessId,
            businessName: business?.name || "Unknown Business",
            items: order.items,
            total: order.total,
            status: order.status,
            createdAt: order.createdAt,
            shipment: shipments.length > 0 ? shipments[0] : null,
          };
        })
      );
      
      // Sort by most recent first
      enrichedOrders.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      
      res.json({ orders: enrichedOrders });
    } catch (error) {
      console.error("Get customer orders error:", error);
      res.status(500).json({ error: "Failed to get orders" });
    }
  });

  return httpServer;
}
