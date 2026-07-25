import type { Express } from "express";
import type { Server } from "http";
import { randomUUID } from "crypto";
import multer from "multer";
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
  vendorSubscriptions,
  calculateAgeRange,
  consumerAddresses,
  insertConsumerAddressSchema,
  type User,
  type StaffMember,
  type StaffInvite,
  type SubscriptionTier,
} from "@shared/schema";
import { sendStaffInviteEmail, sendStaffPayoutSetupEmail, sendStaffAcceptedOwnerEmail } from "./services/resendService";

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
import { eq, desc, sql, gte, lte, or, isNull, gt } from "drizzle-orm";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  authMiddleware,
  hybridAuthMiddleware,
  optionalAuthMiddleware,
  getUserIdFromRequest,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_MS,
  type AuthenticatedRequest,
  type TokenPayload,
} from "./auth";
import rateLimit from "express-rate-limit";
import { stripeService } from "./stripe/stripeService";
import { getStripePublishableKey, getUncachableStripeClient } from "./stripe/stripeClient";
import { authorizeAndProvisionGoLive, GoLiveError } from "./services/goLiveGate";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { ObjectPermission } from "./objectAcl";
import { NotificationTriggers } from "./notificationService";
import { 
  getStaffAvailabilitySlots, 
  getPhotographerAvailabilitySlots, 
  getBusinessAvailability,
  isSlotAvailable,
  getAvailabilityCalendar,
  generateAvailabilitySlots,
  validateBookingSlot,
  createBookingHold,
  confirmBookingHold,
  releaseBookingHold,
  getBookingHold,
  getUserActiveHolds,
  calculateEndTime,
  AvailabilityError,
  AVAILABILITY_ERRORS,
  syncHoursOfOperationToWeeklyAvailability,
  syncWeeklyAvailabilityToHoursOfOperation
} from "./availabilityService";
import {
  transitionAppointmentState,
  transitionShootBookingState
} from "./bookingStateMachine";
import { calculateProductFee, calculateBookingFee, calculateConsumerServiceFee, calculateBookingFees } from "./fees";
import {
  trackLinkClick,
  recordAttribution,
  trackAttributedSignup,
  trackAttributedPurchase,
  getInfluencerLeaderboard,
  getInfluencerDashboardData,
  getInfluencerStatsById,
  clearTierChangeFlag,
  generateReferralLink,
  generateDeepLink,
  seedInfluencerTiersAndConfig,
} from "./influencerTrackingService";
import {
  appointments,
  orders,
  shootBookings,
  influencerEarningLedger,
  photographerAvailability,
  photographerBlackoutDates,
  updatePhotographerAvailabilitySettingsSchema,
  BOOKING_STATES,
  feedPosts,
  businesses,
  photographers,
} from "@shared/schema";
import { and, ilike, ne, asc } from "drizzle-orm";

// ✅ CORRECT IMPORT (default export)
import { photographersRouter } from "./Photographers/photographers.routes";
import { toPublicBusinessDTO } from "./serializers/business";

// =========================
// PAYMENTS CONFIGURATION
// =========================
// Set to false to disable Stripe payments during development (e.g., for Expo Go without native SDK)
// Set to true to enable real Stripe payment processing
// This flag only affects PaymentIntent creation - booking flows still work normally
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED !== 'false'; // Default: true unless explicitly set to 'false'

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

// Resolves the subscription tier for a business, or null if there's no
// subscription / tier row. Shared by getStaffSeatWarning and GET /api/vendor/staff/seat-status.
async function getSubscriptionTierForBusiness(businessId: string): Promise<SubscriptionTier | null> {
  const subscription = await storage.getVendorSubscriptionByBusinessId(businessId);
  if (!subscription) {
    return null;
  }
  const [tier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, subscription.tierId));
  return tier ?? null;
}

// Soft seat-limit check for staff invites — never blocks, only returns a warning
// to surface as an upsell nudge. `maxStaff` is NULL on the business's tier when
// the tier is uncapped, in which case no warning is ever produced.
// usedSeats = active staff + non-expired pending invites (both claim a seat).
async function getStaffSeatWarning(businessId: string): Promise<string | null> {
  const tier = await getSubscriptionTierForBusiness(businessId);
  if (!tier || tier.maxStaff == null) {
    return null;
  }

  const activeCount = await storage.getActiveStaffCount(businessId);
  const allInvites = await storage.getStaffInvitesByBusiness(businessId);
  const pendingCount = allInvites.filter(
    (inv: StaffInvite) => inv.status === "pending" && !isInviteExpired(inv)
  ).length;
  const usedSeats = activeCount + pendingCount;

  if (usedSeats < tier.maxStaff) {
    return null;
  }

  // Point to the nearest higher tier that actually removes the cap, so the
  // message is never wrong even if there are multiple capped tiers above this one.
  const [uncappedTier] = await db.select().from(subscriptionTiers)
    .where(and(isNull(subscriptionTiers.maxStaff), gt(subscriptionTiers.sortOrder, tier.sortOrder ?? 0)))
    .orderBy(subscriptionTiers.sortOrder)
    .limit(1);

  const base = `You're at ${usedSeats} of ${tier.maxStaff} seats on ${tier.displayName}`;
  return uncappedTier ? `${base} — ${uncappedTier.displayName} removes the cap` : base;
}

function legacyVerifyPassword(password: string, hash: string): boolean {
  return legacyHashPassword(password) === hash;
}

// Check if password is legacy (base64) or new (bcrypt)
function isLegacyHash(hash: string): boolean {
  return !hash.startsWith("$2");
}

function detectDeviceFromRequest(req: any): string {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (/tablet|ipad/.test(ua)) return 'tablet';
  if (/mobile|iphone|android/.test(ua)) return 'mobile';
  return 'desktop';
}

// A "pending" invite whose expiresAt has passed is effectively dead even
// though its stored status hasn't been flipped yet (that only happens lazily,
// wherever the invite is next read/acted on — see isInviteExpired call sites).
function isInviteExpired(invite: Pick<StaffInvite, "status" | "expiresAt">): boolean {
  return invite.status === "pending" && !!invite.expiresAt && new Date(invite.expiresAt) < new Date();
}

// ---------------------------------------------------------------------------
// Shared invite-accept logic — used by both POST /api/staff/accept-invite
// (explicit accept by already-registered user) and customer signup
// (auto-accept when inviteCode is supplied at signup time).
//
// The caller decides how to handle the result. The signup path must never
// block on a non-success result — it logs and continues.
// ---------------------------------------------------------------------------
type AcceptInviteResult =
  | { success: true; staff: StaffMember }
  | { success: false; statusCode: number; error: string };

async function acceptStaffInvite(
  inviteCode: string,
  user: User,
): Promise<AcceptInviteResult> {
  const invite = await storage.getStaffInviteByCode(inviteCode);
  if (!invite) {
    return { success: false, statusCode: 404, error: "Invalid invite code" };
  }

  // Transition expired pending invites to status="expired" on first encounter
  if (isInviteExpired(invite)) {
    await storage.updateStaffInvite(invite.id, { status: "expired" });
    return { success: false, statusCode: 400, error: "This invite has expired" };
  }

  if (invite.status !== "pending") {
    return { success: false, statusCode: 400, error: "This invite is no longer valid" };
  }

  if (user.email !== invite.email) {
    return { success: false, statusCode: 403, error: "This invite was sent to a different email address" };
  }

  const displayName =
    user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.name || user.email || "Staff Member";

  // Find-or-reactivate: a staff_members row may already exist for this person
  // at this business in any status (e.g. "archived" from a prior offboarding —
  // G6). Reactivate it instead of inserting a second row, both to preserve
  // history (rating, stripe account, etc.) and because a fresh insert would
  // now violate the business_id+email / business_id+user_id uniqueness
  // constraint (G7).
  const existingStaff = await storage.findStaffMemberForReactivation(
    invite.businessId,
    user.id,
    user.email,
  );

  const staff = existingStaff
    ? await storage.updateStaffMember(existingStaff.id, {
        userId: user.id,
        displayName,
        email: user.email,
        role: invite.role || "staff",
        status: "active",
      })
    : await storage.createStaffMember({
        businessId: invite.businessId,
        userId: user.id,
        displayName,
        email: user.email,
        role: invite.role || "staff",
        status: "active",
      });

  if (!staff) {
    return { success: false, statusCode: 500, error: "Failed to reactivate staff member" };
  }

  await storage.updateStaffInvite(invite.id, {
    status: "accepted",
    acceptedAt: new Date(),
    acceptedByUserId: user.id,
  });

  // Non-blocking: notify the business owner that this staff member accepted.
  // Failures here must never prevent the invite acceptance from succeeding.
  try {
    const owner = await storage.getUserByBusinessOwnerId(invite.businessId);
    const business = await storage.getBusiness(invite.businessId);
    if (owner) {
      await NotificationTriggers.staffInviteAccepted({
        ownerId: owner.id,
        staffId: staff.id,
        staffName: staff.displayName,
        businessName: business?.name || "Your Business",
      });
      if (owner.email) {
        const { sent, error: ownerEmailError } = await sendStaffAcceptedOwnerEmail({
          toEmail: owner.email,
          staffName: staff.displayName,
          businessName: business?.name || "Your Business",
        });
        if (!sent) {
          console.warn(`[acceptStaffInvite] Owner accept email not sent for staff ${staff.id}: ${ownerEmailError}`);
        }
      }
    } else {
      console.warn(`[acceptStaffInvite] No owner found for business ${invite.businessId} — skipping owner notification`);
    }
  } catch (ownerNotifyErr) {
    console.error(
      `[acceptStaffInvite] Non-critical: owner notification failed for staff ${staff.id}:`,
      ownerNotifyErr,
    );
  }

  // Non-blocking: create Stripe Connect account and send payout setup email.
  // Failures here are logged but must never prevent the invite acceptance from succeeding.
  try {
    const appBaseUrl = process.env.APP_BASE_URL || "https://goutsyde.com";
    const connectAccount = await stripeService.createStaffConnectAccount(
      user.email,
      staff.id,
      invite.businessId,
      staff.displayName,
    );
    const accountLink = await stripeService.createConnectOnboardingLink(
      connectAccount.id,
      `${appBaseUrl}/api/vendor/staff/connect/refresh?staffId=${staff.id}`,
      `${appBaseUrl}/api/vendor/staff/connect/return?staffId=${staff.id}`,
    );
    await storage.updateStaffMember(staff.id, {
      stripeAccountId: connectAccount.id,
      stripeOnboardingUrl: accountLink.url,
    });

    const business = await storage.getBusiness(invite.businessId);
    const { sent, error: emailError } = await sendStaffPayoutSetupEmail({
      toEmail: user.email,
      staffFirstName: user.firstName || user.name || "",
      businessName: business?.name || "Your Business",
      onboardingUrl: accountLink.url,
    });
    if (!sent) {
      console.warn(`[acceptStaffInvite] Payout setup email not sent for staff ${staff.id}: ${emailError}`);
    } else {
      console.log(`[acceptStaffInvite] Payout setup email sent to ${user.email} for staff ${staff.id}`);
    }
  } catch (connectErr) {
    console.error(
      `[acceptStaffInvite] Non-critical: Connect account/email setup failed for staff ${staff.id}:`,
      connectErr,
    );
  }

  console.log(
    `[acceptStaffInvite] Success: staff ${staff.id} created for business ${invite.businessId}, user ${user.id}`,
  );
  return { success: true, staff };
}

// ---------------------------------------------------------------------------
// Resolves the staff_members row for the requesting user on the staff
// self-service endpoints (/api/staff/*). A single userId can legitimately map
// to staff rows at multiple businesses (one invite accepted per business), so
// this never silently guesses — a caller with >1 staff membership must pass
// ?businessId= (query for GET/DELETE, body for POST) to disambiguate.
//
// The 409's `businesses` array is sorted most-recently-active-first
// (lastActiveAt, falling back to createdAt for rows never yet resolved) so a
// caller that wants to auto-default can safely take businesses[0] — that's a
// frontend UX decision, not something this helper makes silently.
// ---------------------------------------------------------------------------
type ResolvedStaffMember =
  | { staff: StaffMember }
  | { status: number; body: Record<string, unknown> };

function sortStaffMembershipsByRecency(staffMemberships: StaffMember[]): StaffMember[] {
  return [...staffMemberships].sort((a, b) => {
    const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : new Date(a.createdAt).getTime();
    const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : new Date(b.createdAt).getTime();
    return bTime - aTime;
  });
}

async function resolveRequestingStaffMember(req: any, userId: string): Promise<ResolvedStaffMember> {
  const businessId: string | undefined =
    (req.query && (req.query.businessId as string)) ||
    (req.body && req.body.businessId) ||
    undefined;

  if (businessId) {
    const staff = await storage.getStaffMemberByUserIdAndBusiness(userId, businessId);
    if (!staff) {
      return { status: 404, body: { error: "No staff profile found for that business" } };
    }
    await storage.touchStaffMemberLastActive(staff.id);
    return { staff };
  }

  const staffMemberships = await storage.getStaffMembersByUserId(userId);
  if (staffMemberships.length === 0) {
    return { status: 404, body: { error: "No staff profile found" } };
  }
  if (staffMemberships.length > 1) {
    const sorted = sortStaffMembershipsByRecency(staffMemberships);
    return {
      status: 409,
      body: {
        error: "Staff member linked to multiple businesses — specify businessId",
        businesses: sorted.map((s) => ({
          businessId: s.businessId,
          staffId: s.id,
          displayName: s.displayName,
        })),
      },
    };
  }
  await storage.touchStaffMemberLastActive(staffMemberships[0].id);
  return { staff: staffMemberships[0] };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  console.log("[ROUTES] registerRoutes called — registering all routes");

  // ============================================================
  // AUTH DEBUG MIDDLEWARE - Logs authenticated requests for debugging
  // ============================================================
  app.use("/api", (req, res, next) => {
    // Skip logging for public endpoints
    const publicPaths = ["/api/health", "/api/vendors", "/api/businesses", "/api/feed", "/api/search"];
    const isPublicPath = publicPaths.some(p => req.path.startsWith(p.replace("/api", "")));
    
    // Get authenticated user info from session or OAuth
    const sessionUserId = req.session?.userId;
    const oauthUser = req.user as any;
    const oauthUserId = oauthUser?.claims?.sub;
    const authenticatedUserId = sessionUserId || oauthUserId || null;
    
    // Get role from session
    const sessionRole = req.session?.role || req.session?.userRole;
    const isVendor = req.session?.isVendor;
    const isPhotographer = req.session?.isPhotographer;
    
    // Only log authenticated requests or auth-related endpoints
    if (authenticatedUserId || req.path.includes("/auth")) {
      console.log(`[AUTH_DEBUG] ${req.method} ${req.path} | userId: ${authenticatedUserId || 'none'} | role: ${sessionRole || 'none'} | isVendor: ${isVendor} | isPhotographer: ${isPhotographer}`);
    }
    
    next();
  });

  // Helper function to check if a business is visible to public users
  // Filters out: pending approval, demo data, incomplete Stripe onboarding (if monetization enabled), inactive subscriptions
  const isBusinessVisibleToPublic = async (business: any): Promise<boolean> => {
    // Must be approved
    if (business.approvalStatus !== "approved") {
      return false;
    }
    
    // Filter out demo data (ownerId contains "demo")
    if (business.ownerId && typeof business.ownerId === "string" && business.ownerId.toLowerCase().includes("demo")) {
      return false;
    }
    
    // Must have completed Stripe onboarding only if business has monetization features enabled
    // (hasProducts or hasServices indicates they need payment processing)
    const needsStripe = business.hasProducts || business.hasServices;
    if (needsStripe && !business.stripeOnboardingComplete) {
      return false;
    }
    
    // Must have active subscription
    const subStatus = await storage.isBusinessSubscriptionActive(business.id);
    if (!subStatus.active) {
      return false;
    }
    
    return true;
  };

  // Health check endpoint for Render and other hosting platforms
  app.get("/health", (req, res) => {
    res.json({ 
      status: "ok", 
      service: "vendor-booker", 
      environment: process.env.NODE_ENV || "development" 
    });
  });

  // Public vendors list endpoint for mobile app
  app.get("/api/vendors", async (req, res) => {
    try {
      const businesses = await storage.getBusinesses({});
      
      // Server-side filtering: only return approved, non-demo, Stripe-complete, subscription-active businesses
      const visibleBusinesses = [];
      for (const business of businesses) {
        if (await isBusinessVisibleToPublic(business)) {
          visibleBusinesses.push(business);
        }
      }
      
      const businessDTOs = await Promise.all(
        visibleBusinesses.map(async (business) => {
          const [followerCount, followingCount] = await Promise.all([
            storage.getFollowerCount(business.ownerId),
            storage.getFollowingCount(business.ownerId),
          ]);
          return toPublicBusinessDTO(business, { followerCount, followingCount });
        })
      );

      res.json(businessDTOs);
    } catch (error) {
      console.error("Get vendors error:", error);
      res.status(500).json({ error: "Failed to get vendors" });
    }
  });

  // Unified search endpoint for mobile app - searches across users, businesses, products, services
  // Supports scope-based filtering and personalization
  app.get("/api/search", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const {
        q,
        scope = 'all',
        viewerUserId,
        city,
        personalized,
        limit = '50',
        offset = '0',
      } = req.query;

      const validScopes = ['all', 'consumers', 'photographers', 'businesses', 'products', 'services', 'staff'];
      const searchScope = validScopes.includes(scope as string) ? scope as string : 'all';

      const effectiveViewerUserId =
        (viewerUserId as string) || authReq.user?.userId || authReq.session?.userId || null;

      const enablePersonalization =
        personalized === 'true' && !!effectiveViewerUserId;

      let isAdmin = false;
      if (effectiveViewerUserId) {
        const user = await storage.getUser(effectiveViewerUserId);
        isAdmin = user?.isAdmin || false;
      }

      const results = await storage.unifiedSearchWithScope({
        q: (q as string) || '',
        scope: searchScope,
        viewerUserId: effectiveViewerUserId,
        city: (city as string) || null,
        personalized: enablePersonalization,
        limit: Math.min(100, parseInt(limit as string) || 50),
        offset: parseInt(offset as string) || 0,
        isAdmin,
      });

      res.json(results);
    } catch (error) {
      console.error("Unified search error:", error);
      res.status(500).json({ error: "Failed to search" });
    }
  });

  // Middleware to check if user can monetize (centralized guard for all payment/checkout/payout endpoints)
  const requireMonetization = async (req: any, res: any, next: any) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    if (!user.canMonetize) {
      return res.status(403).json({ 
        error: "Monetization not enabled", 
        message: "Your account is not approved for monetization. Please contact support to enable selling, services, or payouts." 
      });
    }

    req.monetizationUser = user;
    next();
  };

  // ==================== AUTH ROUTES ====================

  const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests, please try again later" },
  });

  const strictAuthRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many attempts, please try again later" },
  });

  // Username availability check (public, rate-limited)
  const usernameCheckLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { success: false, message: "Too many requests" } });

  app.get("/api/users/check-username/:username", usernameCheckLimiter, async (req, res) => {
    try {
      const { validateUsername: valUn } = await import('./usernameUtils');
      const validation = valUn(req.params.username);
      if (!validation.valid) {
        return res.json({ available: false, reason: validation.reason });
      }

      const existing = await storage.getUserByUsername(validation.cleaned!);
      res.json({ available: !existing });
    } catch (error) {
      console.error("Check username error:", error);
      res.status(500).json({ available: false, reason: "Server error" });
    }
  });

  // Customer signup
  app.post("/api/auth/customer/signup", authRateLimiter, async (req, res) => {
    try {
      const data = customerSignupSchema.parse(req.body);

      // Validate username (mandatory)
      const { validateUsername: valUn } = await import('./usernameUtils');
      const unValidation = valUn(data.username);
      if (!unValidation.valid) {
        return res.status(400).json({ success: false, message: unValidation.reason });
      }
      const existingUsername = await storage.getUserByUsername(unValidation.cleaned!);
      if (existingUsername) {
        return res.status(409).json({ success: false, message: "Username is already taken" });
      }

      const existing = await storage.getUserByEmail(data.email);
      if (existing) {
        return res.status(400).json({ error: "Email already registered" });
      }

      // Auto-sync billing address from home if billingSameAsHome
      const effectiveBillingStreet = data.billingSameAsHome ? data.address : data.billingStreet;
      const effectiveBillingCity = data.billingSameAsHome ? data.city : data.billingCity;
      const effectiveBillingState = data.billingSameAsHome ? data.state : data.billingState;
      const effectiveBillingZip = data.billingSameAsHome ? data.zipCode : data.billingZip;
      const effectiveBillingCountry = data.billingSameAsHome ? (data.country ?? 'United States') : (data.billingCountry ?? 'United States');

      const hashedPassword = await hashPassword(data.password);
      const user = await storage.createUser({
        email: data.email,
        password: hashedPassword,
        name: data.name,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        isVendor: false,
        address: data.address,
        aptUnit: data.aptUnit,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
        country: data.country ?? 'United States',
        billingSameAsHome: data.billingSameAsHome,
        billingStreet: effectiveBillingStreet,
        billingAptUnit: data.billingAptUnit,
        billingCity: effectiveBillingCity,
        billingState: effectiveBillingState,
        billingZip: effectiveBillingZip,
        billingCountry: effectiveBillingCountry,
        username: unValidation.cleaned!,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        gender: data.gender,
        ethnicity: data.ethnicity,
        shoppingFrequency: data.shoppingFrequency,
        selectedIndustries: data.selectedIndustries,
        industryNiches: data.industryNiches,
        industryValues: data.industryValues,
      });

      // Auto-accept a staff invite if one was supplied — never blocks signup on failure
      if (data.inviteCode) {
        try {
          const inviteResult = await acceptStaffInvite(data.inviteCode, user);
          if (!inviteResult.success) {
            console.warn(`[signup] invite auto-accept skipped for code ${data.inviteCode}: ${inviteResult.error}`);
          }
        } catch (inviteErr) {
          console.warn(`[signup] invite auto-accept unexpected error for code ${data.inviteCode}:`, inviteErr);
        }
      }

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
      res.status(500).json({
        code: "SERVER_ERROR",
        message: error instanceof Error ? error.message : "Signup failed",
        detail: error instanceof Error && process.env.NODE_ENV !== "production" ? error.stack : undefined,
      });
    }
  });

  // Vendor signup
  app.post("/api/auth/vendor/signup", authRateLimiter, async (req, res) => {
    try {
      const data = vendorSignupSchema.parse(req.body);

      // Validate username (mandatory)
      const { validateUsername: valUnV } = await import('./usernameUtils');
      const unV = valUnV(req.body.username);
      if (!unV.valid) {
        return res.status(400).json({ success: false, message: unV.reason || 'Username is required' });
      }
      const existingUn = await storage.getUserByUsername(unV.cleaned!);
      if (existingUn) {
        return res.status(409).json({ success: false, message: "Username is already taken" });
      }

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
        username: unV.cleaned!,
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
        isMultiStaff: (data.offerType === "services" || data.offerType === "both")
          ? (data.isMultiStaff ?? false)
          : false,
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
        logoImage: data.logoImage,
        subscriptionActive: false,
        approvalStatus: "pending",
      });

      if (data.billingAddress || data.billingCity || data.billingState || data.billingZipCode) {
        await storage.updateBusiness(business.id, {
          billingAddress: {
            line1: data.billingAddress || '',
            city: data.billingCity || '',
            state: data.billingState || '',
            postalCode: data.billingZipCode || '',
            country: 'United States',
          },
        });
      }

      // Auto-geocode business address to lat/lng (async, non-blocking)
      if (data.city && data.state) {
        const { geocodeAddress } = await import('./geocoding');
        geocodeAddress({ streetAddress: data.address, city: data.city, state: data.state, zipCode: data.zipCode })
          .then(coords => {
            if (coords) {
              storage.updateBusiness(business.id, { latitude: coords.latitude, longitude: coords.longitude });
            }
          })
          .catch(err => console.error('[Geocode] Business geocode failed:', err));
      }

      // Send in-app notification to all admins
      await NotificationTriggers.newVendorApplication({
        businessId: business.id,
        businessName: business.name,
        businessCategory: business.category,
        ownerName: data.name,
        ownerEmail: data.email,
        city: data.city,
        state: data.state,
      });

      if (req.session) {
        req.session.userId = user.id;
        req.session.isVendor = true;
        req.session.businessId = business.id;
      }

      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });
      res.json({ 
        user: safeUser, 
        business,
        message: "Your application has been submitted and is pending approval. You will be notified once reviewed."
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Invalid data", details: error.errors });
      }
      console.error("Vendor signup error:", error);
      res.status(500).json({
        code: "SERVER_ERROR",
        message: error instanceof Error ? error.message : "Signup failed",
        detail: error instanceof Error && process.env.NODE_ENV !== "production" ? error.stack : undefined,
      });
    }
  });

  // Photographer signup
  app.post("/api/auth/photographer/signup", authRateLimiter, async (req, res) => {
    try {
      const data = photographerSignupSchema.parse(req.body);
      const skipStripe = req.body.skipStripe === true;

      // Validate username (mandatory)
      const { validateUsername: valUnP } = await import('./usernameUtils');
      const unP = valUnP(req.body.username);
      if (!unP.valid) {
        return res.status(400).json({ success: false, message: unP.reason || 'Username is required' });
      }
      const existingUnP = await storage.getUserByUsername(unP.cleaned!);
      if (existingUnP) {
        return res.status(409).json({ success: false, message: "Username is already taken" });
      }

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
        username: unP.cleaned!,
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
        // Expanded profile fields (all optional)
        shootLocation: req.body.shootLocation,
        studioName: req.body.studioName,
        studioAddress: req.body.studioAddress,
        usesSharedStudio: req.body.usesSharedStudio,
        travelRadius: req.body.travelRadius,
        pricingType: req.body.pricingType,
        startingPrice: req.body.startingPrice ? Math.round(parseFloat(req.body.startingPrice) * 100) : null,
        minimumBooking: req.body.minimumBooking,
        additionalServices: req.body.additionalServices,
        experienceLevel: req.body.experienceLevel,
        equipmentLevel: req.body.equipmentLevel,
        deliveryTime: req.body.deliveryTime,
      });

      // Auto-geocode photographer location (async, non-blocking)
      if (data.city && data.state) {
        const { geocodeAddress } = await import('./geocoding');
        geocodeAddress({ city: data.city, state: data.state })
          .then(coords => {
            if (coords) storage.updatePhotographer(photographer.id, { latitude: coords.latitude, longitude: coords.longitude });
          })
          .catch(() => {});
      }

      // Send in-app notification to all admins
      await NotificationTriggers.newPhotographerApplication({
        photographerId: photographer.id,
        displayName: data.displayName,
        ownerName: data.name,
        ownerEmail: data.email,
        city: data.city,
        state: data.state,
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

          // Create onboarding link with HTTPS redirect URLs (Stripe rejects deep links)
          const onboardingBaseUrl = process.env.API_BASE_URL || 'https://outsyde-backend.onrender.com';
          const accountLink = await stripeService.createConnectOnboardingLink(
            account.id,
            `${onboardingBaseUrl}/api/stripe/connect-refresh?account=${account.id}&type=photographer`,
            `${onboardingBaseUrl}/api/stripe/connect-return?account=${account.id}&type=photographer`
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
      res.status(500).json({
        code: "SERVER_ERROR",
        message: error instanceof Error ? error.message : "Signup failed",
        detail: error instanceof Error && process.env.NODE_ENV !== "production" ? error.stack : undefined,
      });
    }
  });

  // Login — supports email, username, or generic identifier + password
  app.post("/api/auth/login", strictAuthRateLimiter, async (req, res) => {
    try {
      const { email, username, identifier, password } = req.body;

      if (!password || typeof password !== 'string') {
        return res.status(400).json({ success: false, message: "Password is required" });
      }

      // Resolve user by email, username, or auto-detected identifier
      let user = null;
      if (email) {
        user = await storage.getUserByEmail(email);
      } else if (username) {
        const { validateUsername: valUn } = await import('./usernameUtils');
        const v = valUn(username);
        if (v.valid && v.cleaned) user = await storage.getUserByUsername(v.cleaned);
      } else if (identifier) {
        const isEmail = identifier.includes('@') && identifier.includes('.');
        if (isEmail) {
          user = await storage.getUserByEmail(identifier);
        } else {
          const { validateUsername: valUn } = await import('./usernameUtils');
          const v = valUn(identifier);
          if (v.valid && v.cleaned) user = await storage.getUserByUsername(v.cleaned);
        }
      } else {
        return res.status(400).json({ success: false, message: "Email, username, or identifier is required" });
      }

      if (!user) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }

      // Check if user has a password (might be Google/Apple-only)
      if (!user.password) {
        if (user.isOAuthUser || user.googleSub) {
          return res.status(401).json({ success: false, message: "This account uses Google sign-in. Please continue with Google." });
        }
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }

      let isValidPassword = false;
      if (isLegacyHash(user.password)) {
        isValidPassword = legacyVerifyPassword(password, user.password);
      } else {
        isValidPassword = await verifyPassword(password, user.password);
      }

      if (!isValidPassword) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
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

  // Complete Google/Apple OAuth signup — create user record with chosen username
  app.post("/api/auth/oauth/complete-signup", authRateLimiter, async (req, res) => {
    try {
      const {
        googleSub, email, username, name, firstName, lastName, profileImageUrl,
        address, aptUnit, city, state, zipCode, country,
        billingSameAsHome = true, billingStreet, billingAptUnit, billingCity, billingState, billingZip, billingCountry,
      } = req.body;

      if (!googleSub || !email) {
        return res.status(400).json({ success: false, message: "googleSub and email are required" });
      }

      // Validate username
      const { validateUsername: valUn } = await import('./usernameUtils');
      const unVal = valUn(username);
      if (!unVal.valid) {
        return res.status(400).json({ success: false, message: unVal.reason });
      }

      // Check username availability
      const existingUn = await storage.getUserByUsername(unVal.cleaned!);
      if (existingUn) {
        return res.status(409).json({ success: false, message: "Username is already taken" });
      }

      // Check email not already registered
      const existingEmail = await storage.getUserByEmail(email);
      if (existingEmail) {
        return res.status(409).json({ success: false, message: "Email already registered" });
      }

      // Check googleSub not already linked
      const existingGoogle = await storage.getUserByGoogleSub(googleSub);
      if (existingGoogle) {
        return res.status(409).json({ success: false, message: "Google account already linked" });
      }

      // Admin check
      const ALLOWED_ADMIN_EMAILS = ['info@goutsyde.com', 'jamesmeyers2304@gmail.com'].map(e => e.toLowerCase());
      const isAdminEmail = ALLOWED_ADMIN_EMAILS.includes(email.toLowerCase());

      // Auto-sync billing from home if same
      const effBillingStreet = billingSameAsHome ? address : billingStreet;
      const effBillingCity = billingSameAsHome ? city : billingCity;
      const effBillingState = billingSameAsHome ? state : billingState;
      const effBillingZip = billingSameAsHome ? zipCode : billingZip;
      const effBillingCountry = billingSameAsHome ? (country ?? 'United States') : (billingCountry ?? 'United States');

      const user = await storage.createUser({
        email,
        username: unVal.cleaned!,
        name: name || email.split('@')[0],
        firstName: firstName || null,
        lastName: lastName || null,
        profileImageUrl: profileImageUrl || null,
        address: address || null,
        aptUnit: aptUnit || null,
        city: city || null,
        state: state || null,
        zipCode: zipCode || null,
        country: country ?? 'United States',
        billingSameAsHome: billingSameAsHome ?? true,
        billingStreet: effBillingStreet || null,
        billingAptUnit: billingAptUnit || null,
        billingCity: effBillingCity || null,
        billingState: effBillingState || null,
        billingZip: effBillingZip || null,
        billingCountry: effBillingCountry,
        isOAuthUser: true,
        isAdmin: isAdminEmail,
      });

      await storage.updateUser(user.id, { googleSub });
      const fullUser = await storage.getUser(user.id);
      if (!fullUser) {
        return res.status(500).json({ success: false, message: "Failed to create user" });
      }

      // Issue tokens
      const tokenPayload: TokenPayload = {
        userId: fullUser.id,
        isVendor: fullUser.isVendor || false,
        isPhotographer: fullUser.isPhotographer || false,
        isAdmin: fullUser.isAdmin || false,
      };

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      await storage.storeRefreshToken(fullUser.id, refreshToken, new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS));

      if (req.session) {
        req.session.userId = fullUser.id;
        req.session.isVendor = fullUser.isVendor;
      }

      const safeUser = sanitizeUserForResponse(fullUser, { includeOwnData: true });

      res.json({
        success: true,
        user: safeUser,
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
        isNewUser: false,
        requiresUsername: false,
      });
    } catch (error) {
      console.error("OAuth complete signup error:", error);
      res.status(500).json({ success: false, message: "Failed to complete signup" });
    }
  });

  // Apple Sign-In — verify identity token and resolve user
  app.post("/api/auth/oauth/apple", authRateLimiter, async (req, res) => {
    try {
      const { identityToken, fullName, email } = req.body;

      if (!identityToken) {
        return res.status(400).json({ success: false, message: "identityToken is required" });
      }

      const { verifyAppleIdentityToken } = await import('./appleAuth');
      let applePayload;
      try {
        applePayload = await verifyAppleIdentityToken(identityToken);
      } catch (verifyErr) {
        console.error("Apple token verification failed:", verifyErr);
        return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid Apple identity token' } });
      }

      const appleId = applePayload.sub;
      const appleEmail = applePayload.email || email;

      // Check if user exists by Apple ID
      let user = await storage.getUserByAppleId(appleId);

      if (!user && appleEmail) {
        // Check if user exists by email (may have been created via another method)
        user = await storage.getUserByEmail(appleEmail);
        if (user) {
          // Link Apple ID to existing account
          await storage.updateUser(user.id, { appleId });
          user = await storage.getUser(user.id);
        }
      }

      if (!user) {
        // New user — return profile for username selection (do NOT create record)
        return res.json({
          success: true,
          isNewUser: true,
          requiresUsername: true,
          appleProfile: {
            appleId,
            email: appleEmail || null,
            fullName: fullName || null,
          },
        });
      }

      // Existing user — issue tokens
      const tokenPayload: TokenPayload = {
        userId: user.id,
        isVendor: user.isVendor || false,
        isPhotographer: user.isPhotographer || false,
        isAdmin: user.isAdmin || false,
      };
      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(user.id);
        if (business) tokenPayload.businessId = business.id;
      }
      if (user.isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(user.id);
        if (photographer) tokenPayload.photographerId = photographer.id;
      }

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      await storage.storeRefreshToken(user.id, refreshToken, new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS));

      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });
      res.json({ success: true, user: safeUser, accessToken, refreshToken, expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS, isNewUser: false });
    } catch (error) {
      console.error("Apple auth error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Apple authentication failed' } });
    }
  });

  // Apple Sign-In complete signup — create user with chosen username
  app.post("/api/auth/oauth/apple/complete-signup", authRateLimiter, async (req, res) => {
    try {
      const { appleId, email, username, fullName, firstName, lastName } = req.body;

      if (!appleId) {
        return res.status(400).json({ success: false, message: "appleId is required" });
      }

      // Validate username
      const { validateUsername: valUn } = await import('./usernameUtils');
      const unVal = valUn(username);
      if (!unVal.valid) return res.status(400).json({ success: false, message: unVal.reason });

      const existingUn = await storage.getUserByUsername(unVal.cleaned!);
      if (existingUn) return res.status(409).json({ success: false, message: "Username is already taken" });

      if (email) {
        const existingEmail = await storage.getUserByEmail(email);
        if (existingEmail) return res.status(409).json({ success: false, message: "Email already registered" });
      }

      const existingApple = await storage.getUserByAppleId(appleId);
      if (existingApple) return res.status(409).json({ success: false, message: "Apple account already linked" });

      const derivedName = fullName
        || (firstName && lastName ? `${firstName} ${lastName}` : null)
        || email?.split('@')[0]
        || 'User';

      const user = await storage.createUser({
        email: email || null,
        username: unVal.cleaned!,
        name: derivedName,
        firstName: firstName || null,
        lastName: lastName || null,
        isOAuthUser: true,
        appleId,
      });

      const fullUser = await storage.getUser(user.id);
      if (!fullUser) return res.status(500).json({ success: false, message: "Failed to create user" });

      const tokenPayload: TokenPayload = {
        userId: fullUser.id,
        isVendor: false,
        isPhotographer: false,
        isAdmin: fullUser.isAdmin || false,
      };

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      await storage.storeRefreshToken(fullUser.id, refreshToken, new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS));

      const safeUser = sanitizeUserForResponse(fullUser, { includeOwnData: true });
      res.json({ success: true, user: safeUser, accessToken, refreshToken, expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS, isNewUser: false });
    } catch (error) {
      console.error("Apple complete signup error:", error);
      res.status(500).json({ success: false, message: "Failed to complete Apple signup" });
    }
  });

  // Complete onboarding — persist user type selection
  app.post("/api/auth/onboarding/complete", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    try {
      const { userType, selectedIndustries, industryNiches, industryValues } = req.body;

      if (!userType || !['shopper', 'vendor', 'photographer', 'consumer'].includes(userType)) {
        return res.status(400).json({ success: false, message: "Valid userType is required (shopper, vendor, photographer, consumer)" });
      }

      const updates: Record<string, any> = {};

      if (userType === 'vendor') {
        updates.isVendor = true;
        updates.wantsToSellProducts = true;
      } else if (userType === 'photographer') {
        updates.isPhotographer = true;
      } else {
        // shopper / consumer
        updates.isVendor = false;
        updates.isPhotographer = false;
      }

      if (selectedIndustries) updates.selectedIndustries = selectedIndustries;
      if (industryNiches) updates.industryNiches = industryNiches;
      if (industryValues) updates.industryValues = industryValues;

      await storage.updateUser(userId, updates);
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      // Update session
      if (req.session) {
        req.session.isVendor = user.isVendor;
        req.session.isPhotographer = user.isPhotographer;
      }

      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });
      res.json({ success: true, user: safeUser });
    } catch (error) {
      console.error("Onboarding complete error:", error);
      res.status(500).json({ success: false, message: "Failed to complete onboarding" });
    }
  });

  // PATCH alias for onboarding (matches frontend expectation)
  app.patch("/api/users/onboarding", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    try {
      const { userType, preferences, selectedIndustries, industryNiches, industryValues } = req.body;

      const updates: Record<string, any> = {};

      if (userType) {
        if (userType === 'vendor' || userType === 'seller') {
          updates.isVendor = true;
          updates.wantsToSellProducts = true;
        } else if (userType === 'photographer') {
          updates.isPhotographer = true;
        } else {
          updates.isVendor = false;
          updates.isPhotographer = false;
        }
      }

      if (selectedIndustries || preferences?.selectedIndustries) updates.selectedIndustries = selectedIndustries || preferences?.selectedIndustries;
      if (industryNiches || preferences?.industryNiches) updates.industryNiches = industryNiches || preferences?.industryNiches;
      if (industryValues || preferences?.industryValues) updates.industryValues = industryValues || preferences?.industryValues;

      await storage.updateUser(userId, updates);
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      if (req.session) {
        req.session.isVendor = user.isVendor;
        req.session.isPhotographer = user.isPhotographer;
      }

      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });
      res.json({ success: true, message: "Onboarding complete", data: safeUser });
    } catch (error) {
      console.error("Onboarding error:", error);
      res.status(500).json({ success: false, message: "Failed to complete onboarding" });
    }
  });

  // ==================== MOBILE AUTH (JWT) ====================

  // Mobile Google OAuth - Verify Google ID token and return JWT tokens
  // Used by Expo app via expo-auth-session
  app.post("/api/auth/mobile/google", authRateLimiter, async (req, res) => {
    try {
      const { idToken, clientId } = req.body;

      if (!idToken || typeof idToken !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: { code: "INVALID_REQUEST", message: "idToken is required" }
        });
      }

      // Import Google Auth library
      const { OAuth2Client } = await import('google-auth-library');
      const client = new OAuth2Client();

      // Use server-configured Client ID for verification, with request clientId as fallback
      const expectedAudience = process.env.GOOGLE_OAUTH_CLIENT_ID || clientId;

      // Verify the Google ID token
      let payload;
      try {
        const ticket = await client.verifyIdToken({
          idToken,
          audience: expectedAudience || undefined, // Verify token was issued for our app
        });
        payload = ticket.getPayload();
      } catch (verifyError) {
        console.error("Google token verification failed:", verifyError);
        return res.status(401).json({
          success: false,
          error: { code: "INVALID_TOKEN", message: "Invalid or expired Google token" }
        });
      }

      if (!payload) {
        return res.status(401).json({
          success: false,
          error: { code: "INVALID_TOKEN", message: "Could not extract payload from token" }
        });
      }

      const { sub: googleSub, email, name, picture, given_name, family_name } = payload;

      if (!googleSub || !email) {
        return res.status(401).json({
          success: false,
          error: { code: "INVALID_TOKEN", message: "Token missing required claims (sub, email)" }
        });
      }

      // Try to find existing user by googleSub first, then by email
      let user = await storage.getUserByGoogleSub(googleSub);
      
      if (!user) {
        // Check if user exists by email (may have been created via email/password)
        user = await storage.getUserByEmail(email);
        
        if (user) {
          // Link Google account to existing user
          await storage.updateUser(user.id, { 
            googleSub,
            isOAuthUser: true,
            // Update profile picture if not already set
            profileImageUrl: user.profileImageUrl || picture || null,
          });
          user = await storage.getUser(user.id);
        }
      }

      // Check if email is in admin list for auto-granting admin role
      const ALLOWED_ADMIN_EMAILS = [
        'info@goutsyde.com',
        'jamesmeyers2304@gmail.com',
      ].map(e => e.toLowerCase());
      const isAdminEmail = ALLOWED_ADMIN_EMAILS.includes(email.toLowerCase());

      if (!user) {
        // New Google user — do NOT create a record yet.
        // Return their Google profile so the frontend can route them
        // through username selection before account creation.
        return res.json({
          success: true,
          isNewUser: true,
          requiresUsername: true,
          googleProfile: {
            googleSub,
            email,
            name: name || `${given_name || ''} ${family_name || ''}`.trim() || null,
            firstName: given_name || null,
            lastName: family_name || null,
            profileImageUrl: picture || null,
          },
        });
      }

      // Existing user — update admin status if needed
      if (isAdminEmail && !user.isAdmin) {
        await storage.updateUser(user.id, { isAdmin: true });
        user = await storage.getUser(user.id);
      }

      if (!user) {
        return res.status(500).json({
          success: false,
          error: { code: "CREATE_FAILED", message: "Failed to retrieve user" }
        });
      }

      const tokenPayload: TokenPayload = {
        userId: user.id,
        isVendor: user.isVendor || false,
        isPhotographer: user.isPhotographer || false,
        isAdmin: user.isAdmin || false,
      };

      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(user.id);
        if (business) tokenPayload.businessId = business.id;
      }
      if (user.isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(user.id);
        if (photographer) tokenPayload.photographerId = photographer.id;
      }

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);

      await storage.storeRefreshToken(user.id, refreshToken, new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS));

      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });

      res.json({
        success: true,
        user: safeUser,
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
        isNewUser: false,
        requiresUsername: false,
      });

    } catch (error) {
      console.error("Mobile Google auth error:", error);
      res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: "Authentication failed" }
      });
    }
  });

  // OAuth state TTL: 10 minutes
  const OAUTH_STATE_TTL = 10 * 60 * 1000; // 10 minutes

  // Cleanup expired states periodically (from database)
  setInterval(async () => {
    try {
      await storage.cleanupExpiredOAuthStates();
    } catch (error) {
      console.error("Failed to cleanup expired OAuth states:", error);
    }
  }, 60 * 1000); // Run every minute

  // Mobile Google OAuth Preflight - Generate and store OAuth state
  // Called before initiating Google OAuth from the mobile app
  app.post("/api/auth/mobile/google/preflight", authRateLimiter, async (req, res) => {
    try {
      const { deviceId, redirectUri: clientRedirectUri } = req.body;
      
      // Generate a random state token
      const state = randomUUID();
      const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL);
      
      // Store the state in database
      await storage.createOAuthState(state, expiresAt, deviceId);
      
      // Get OAuth configuration — redirect URI must match exactly what's registered in Google Cloud Console
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
      const redirectUri = clientRedirectUri
        || process.env.GOOGLE_OAUTH_REDIRECT_URI
        || `${req.protocol}://${req.get('host')}/api/auth/mobile/google/callback`;

      if (!clientId) {
        return res.status(500).json({
          success: false,
          message: "OAuth client ID not configured"
        });
      }

      res.json({
        success: true,
        state,
        redirectUri,
        authUrl: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile&state=${encodeURIComponent(state)}&access_type=offline&prompt=consent`,
        expiresIn: OAUTH_STATE_TTL / 1000,
      });

    } catch (error) {
      console.error("OAuth preflight error:", error);
      res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: "Failed to generate OAuth state" }
      });
    }
  });

  // Mobile Google OAuth Callback - Server-side OAuth code exchange for Expo apps
  // This handles the OAuth redirect from Google and redirects to the app via deep link
  app.get("/api/auth/mobile/google/callback", async (req, res) => {
    const successRedirect = "outsyde://auth/success";
    const errorRedirect = "outsyde://auth/error";

    try {
      const { code, state, error: oauthError } = req.query;

      // Handle OAuth errors from Google
      if (oauthError) {
        console.error("Google OAuth error:", oauthError);
        return res.redirect(`${errorRedirect}?error=${encodeURIComponent(String(oauthError))}`);
      }

      // Validate code parameter - redirect to error deep link instead of 400
      if (!code || typeof code !== 'string') {
        return res.redirect(`${errorRedirect}?error=missing_code`);
      }

      // Validate state parameter for CSRF protection
      // State must have been generated by the preflight endpoint and stored server-side
      if (!state || typeof state !== 'string') {
        console.error("Missing OAuth state parameter - potential CSRF");
        return res.redirect(`${errorRedirect}?error=missing_state`);
      }

      // Verify state exists in database and hasn't expired (returns null if not found or expired)
      const stateRecord = await storage.validateAndConsumeOAuthState(state);
      if (!stateRecord) {
        console.error("Invalid OAuth state - not found in store or expired");
        return res.redirect(`${errorRedirect}?error=invalid_state`);
      }
      // State is consumed (deleted) by validateAndConsumeOAuthState to prevent replay attacks

      // Get environment variables
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      // Use environment variable for redirect URI, fallback to auto-detect from request
      const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI ||
        `${req.protocol}://${req.get('host')}/api/auth/mobile/google/callback`;

      if (!clientId || !clientSecret) {
        console.error("Missing Google OAuth configuration");
        return res.redirect(`${errorRedirect}?error=server_configuration`);
      }

      // Exchange authorization code for tokens
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.text();
        console.error("Token exchange failed:", errorData);
        return res.redirect(`${errorRedirect}?error=token_exchange_failed`);
      }

      const tokens = await tokenResponse.json() as { 
        access_token: string; 
        id_token?: string;
        refresh_token?: string;
      };

      // Get user info from Google
      const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });

      if (!userInfoResponse.ok) {
        console.error("Failed to fetch user info");
        return res.redirect(`${errorRedirect}?error=userinfo_failed`);
      }

      const googleUser = await userInfoResponse.json() as {
        id: string;
        email: string;
        name?: string;
        given_name?: string;
        family_name?: string;
        picture?: string;
      };

      const { id: googleSub, email, name, given_name, family_name, picture } = googleUser;

      if (!googleSub || !email) {
        console.error("Missing user info from Google");
        return res.redirect(`${errorRedirect}?error=missing_user_info`);
      }

      // Try to find existing user by googleSub first, then by email
      let user = await storage.getUserByGoogleSub(googleSub);
      
      if (!user) {
        // Check if user exists by email (may have been created via email/password)
        user = await storage.getUserByEmail(email);
        
        if (user) {
          // Link Google account to existing user
          await storage.updateUser(user.id, { 
            googleSub,
            isOAuthUser: true,
            profileImageUrl: user.profileImageUrl || picture || null,
          });
          user = await storage.getUser(user.id);
        }
      }

      // Check if email is in admin list for auto-granting admin role
      const ALLOWED_ADMIN_EMAILS = [
        'info@goutsyde.com',
        'jamesmeyers2304@gmail.com',
      ].map(e => e.toLowerCase());
      const isAdminEmail = ALLOWED_ADMIN_EMAILS.includes(email.toLowerCase());

      if (!user) {
        // New Google user — redirect to app with isNewUser flag.
        // No user record created until they choose a username.
        const newUserParams = new URLSearchParams({
          isNewUser: 'true',
          requiresUsername: 'true',
          email,
          googleSub,
          name: name || '',
          firstName: given_name || '',
          lastName: family_name || '',
          profileImageUrl: picture || '',
        });
        return res.redirect(`${successRedirect}?${newUserParams.toString()}`);
      }

      if (isAdminEmail && !user.isAdmin) {
        await storage.updateUser(user.id, { isAdmin: true });
        user = await storage.getUser(user.id);
      }

      if (!user) {
        console.error("Failed to retrieve user");
        return res.redirect(`${errorRedirect}?error=user_retrieval_failed`);
      }

      // Create complete session for the user (matching web login flow)
      req.session.userId = user.id;
      req.session.isVendor = user.isVendor;
      req.session.isPhotographer = user.isPhotographer;
      // Note: isStaff and isAdmin are accessed via user lookup from userId

      // Get business/photographer IDs if applicable
      let businessId: string | undefined;
      let photographerId: string | undefined;
      
      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(user.id);
        if (business) {
          req.session.businessId = business.id;
          businessId = business.id;
        }
      }
      if (user.isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(user.id);
        if (photographer) {
          req.session.photographerId = photographer.id;
          photographerId = photographer.id;
        }
      }

      // Generate JWT tokens for mobile app with full role information
      const tokenPayload: TokenPayload = {
        userId: user.id,
        isVendor: user.isVendor || false,
        isPhotographer: user.isPhotographer || false,
        isAdmin: user.isAdmin || false,
        businessId,
        photographerId,
      };

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);

      // Store refresh token in database (30-day expiry)
      await storage.storeRefreshToken(user.id, refreshToken, new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS));

      // Build success redirect URL with tokens and user data
      const redirectParams = new URLSearchParams({
        accessToken,
        refreshToken,
        userId: user.id,
        email: user.email || '',
      });
      
      // Include user profile data
      if (user.firstName) {
        redirectParams.append('firstName', user.firstName);
      }
      if (user.lastName) {
        redirectParams.append('lastName', user.lastName);
      }
      if (user.name) {
        redirectParams.append('name', user.name);
      }
      if (user.profileImageUrl) {
        redirectParams.append('profileImageUrl', user.profileImageUrl);
      }
      
      // Include role flags
      if (user.isVendor) {
        redirectParams.append('isVendor', 'true');
      }
      if (user.isPhotographer) {
        redirectParams.append('isPhotographer', 'true');
      }
      if (user.isAdmin) {
        redirectParams.append('isAdmin', 'true');
      }
      
      // Include optional IDs if present
      if (businessId) {
        redirectParams.append('businessId', businessId);
      }
      if (photographerId) {
        redirectParams.append('photographerId', photographerId);
      }

      res.redirect(`${successRedirect}?${redirectParams.toString()}`);

    } catch (error) {
      console.error("Mobile Google OAuth callback error:", error);
      res.redirect(`${errorRedirect}?error=server_error`);
    }
  });

  // Mobile token refresh endpoint
  app.post("/api/auth/mobile/refresh", authRateLimiter, async (req, res) => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken || typeof refreshToken !== 'string') {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_REQUEST", message: "refreshToken is required" }
        });
      }

      // Verify refresh token JWT
      const payload = verifyRefreshToken(refreshToken);
      if (!payload) {
        return res.status(401).json({
          success: false,
          error: { code: "TOKEN_INVALID", message: "Invalid or expired refresh token" }
        });
      }

      // Validate against database
      const tokenRecord = await storage.validateRefreshToken(refreshToken);
      if (!tokenRecord) {
        return res.status(401).json({
          success: false,
          error: { code: "TOKEN_REVOKED", message: "Refresh token has been revoked" }
        });
      }

      // Get user
      const user = await storage.getUser(payload.userId);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: { code: "USER_NOT_FOUND", message: "User not found" }
        });
      }

      // Generate new tokens with full role information
      const tokenPayload: TokenPayload = {
        userId: user.id,
        isVendor: user.isVendor || false,
        isPhotographer: user.isPhotographer || false,
        isAdmin: user.isAdmin || false,
      };

      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(user.id);
        if (business) {
          tokenPayload.businessId = business.id;
        }
      }

      if (user.isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(user.id);
        if (photographer) {
          tokenPayload.photographerId = photographer.id;
        }
      }

      const newAccessToken = generateAccessToken(tokenPayload);
      const newRefreshToken = generateRefreshToken(tokenPayload);

      // Revoke old refresh token and store new one
      await storage.revokeRefreshToken(tokenRecord.tokenId);
      await storage.storeRefreshToken(user.id, newRefreshToken, new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS));

      res.json({
        success: true,
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
      });

    } catch (error) {
      console.error("Token refresh error:", error);
      res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: "Token refresh failed" }
      });
    }
  });

  // Alias for /api/auth/mobile/refresh — used by frontend/mobile clients
  // Uses the same refresh token rotation logic
  app.post("/api/auth/refresh", authRateLimiter, async (req, res) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken || typeof refreshToken !== 'string') {
        return res.status(400).json({ success: false, message: "refreshToken is required" });
      }
      const payload = verifyRefreshToken(refreshToken);
      if (!payload) {
        return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
      }
      const tokenRecord = await storage.validateRefreshToken(refreshToken);
      if (!tokenRecord) {
        return res.status(401).json({ success: false, message: "Refresh token has been revoked" });
      }
      const user = await storage.getUser(payload.userId);
      if (!user) {
        return res.status(401).json({ success: false, message: "User not found" });
      }
      const tokenPayload: TokenPayload = {
        userId: user.id,
        isVendor: user.isVendor || false,
        isPhotographer: user.isPhotographer || false,
        isAdmin: user.isAdmin || false,
      };
      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(user.id);
        if (business) tokenPayload.businessId = business.id;
      }
      if (user.isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(user.id);
        if (photographer) tokenPayload.photographerId = photographer.id;
      }
      const newAccessToken = generateAccessToken(tokenPayload);
      const newRefreshToken = generateRefreshToken(tokenPayload);
      await storage.revokeRefreshToken(tokenRecord.tokenId);
      await storage.storeRefreshToken(user.id, newRefreshToken, new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS));
      res.json({ success: true, accessToken: newAccessToken, refreshToken: newRefreshToken, expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS });
    } catch (error) {
      console.error("Token refresh error:", error);
      res.status(500).json({ success: false, message: "Token refresh failed" });
    }
  });

  // Mobile login — supports email, username, or identifier + password, returns JWT
  app.post("/api/auth/mobile/login", strictAuthRateLimiter, async (req, res) => {
    try {
      const { email, username, identifier, password } = req.body;

      if (!password || typeof password !== 'string') {
        return res.status(400).json({ success: false, error: { code: "INVALID_INPUT", message: "Password is required" } });
      }

      // Resolve user by email, username, or auto-detected identifier
      let user = null;
      if (email) {
        user = await storage.getUserByEmail(email);
      } else if (username) {
        const { validateUsername: valUn } = await import('./usernameUtils');
        const v = valUn(username);
        if (v.valid && v.cleaned) user = await storage.getUserByUsername(v.cleaned);
      } else if (identifier) {
        const isEmail = identifier.includes('@') && identifier.includes('.');
        if (isEmail) {
          user = await storage.getUserByEmail(identifier);
        } else {
          const { validateUsername: valUn } = await import('./usernameUtils');
          const v = valUn(identifier);
          if (v.valid && v.cleaned) user = await storage.getUserByUsername(v.cleaned);
        }
      } else {
        return res.status(400).json({ success: false, error: { code: "INVALID_INPUT", message: "Email, username, or identifier is required" } });
      }

      if (!user) {
        return res.status(401).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
      }

      if (!user.password) {
        if (user.appleId) {
          return res.status(401).json({ success: false, error: { code: "OAUTH_ONLY", message: "This account uses Apple sign-in. Please continue with Apple." } });
        }
        if (user.isOAuthUser || user.googleSub) {
          return res.status(401).json({ success: false, error: { code: "OAUTH_ONLY", message: "This account uses Google sign-in. Please continue with Google." } });
        }
        return res.status(401).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
      }

      let isValidPassword = false;
      if (isLegacyHash(user.password)) {
        isValidPassword = legacyVerifyPassword(password, user.password);
      } else {
        isValidPassword = await verifyPassword(password, user.password);
      }

      if (!isValidPassword) {
        return res.status(401).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
      }

      // Generate JWT tokens with full role information
      const tokenPayload: TokenPayload = {
        userId: user.id,
        isVendor: user.isVendor || false,
        isPhotographer: user.isPhotographer || false,
        isAdmin: user.isAdmin || false,
      };

      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(user.id);
        if (business) {
          tokenPayload.businessId = business.id;
        }
      }

      if (user.isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(user.id);
        if (photographer) {
          tokenPayload.photographerId = photographer.id;
        }
      }

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);

      // Store refresh token
      await storage.storeRefreshToken(user.id, refreshToken, new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS));

      // ============================================================
      // CRITICAL: Establish session for ALL user types (consumers, photographers, vendors)
      // This ensures subsequent requests are authenticated via session cookie
      // ============================================================
      if (req.session) {
        req.session.userId = user.id;
        req.session.role = user.isAdmin ? "admin" : user.isVendor ? "vendor" : user.isPhotographer ? "photographer" : "consumer";
        req.session.isPhotographer = user.isPhotographer || false;
        req.session.isVendor = user.isVendor || false;
        
        // Also store entity IDs if available from token payload
        if (tokenPayload.businessId) {
          req.session.businessId = tokenPayload.businessId;
        }
        if (tokenPayload.photographerId) {
          req.session.photographerId = tokenPayload.photographerId;
        }
      }

      // TEMP DEBUG: Log session state after login
      console.log("LOGIN SESSION SET:", {
        userId: req.session?.userId,
        role: req.session?.role,
        isPhotographer: req.session?.isPhotographer,
        isVendor: req.session?.isVendor,
        businessId: req.session?.businessId,
        photographerId: req.session?.photographerId,
        sessionID: req.sessionID,
      });

      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });

      res.json({
        success: true,
        user: safeUser,
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
      });

    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_REQUEST", message: "Invalid request data" }
        });
      }
      console.error("Mobile login error:", error);
      res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: "Login failed" }
      });
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
          
          // Always check for business record and update session flags
          // This ensures session is rehydrated even if user.isVendor is true but session was lost
          const business = await storage.getBusinessByOwnerId(user.id);
          if (business) {
            (safeUser as any).isVendor = true;
            if (req.session) {
              req.session.isVendor = true;
              req.session.businessId = business.id;
            }
          }
          
          // Always check for photographer record and update session flags
          const photographer = await storage.getPhotographerByUserId(user.id);
          if (photographer) {
            (safeUser as any).isPhotographer = true;
            if (req.session) {
              req.session.isPhotographer = true;
              req.session.photographerId = photographer.id;
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
      
      // Always check for business record and update session flags
      // This ensures session is rehydrated even if user.isVendor is true but session was lost
      const business = await storage.getBusinessByOwnerId(userId);
      if (business) {
        (safeUser as any).isVendor = true;
        if (req.session) {
          req.session.isVendor = true;
          req.session.businessId = business.id;
        }
      }
      
      // Always check for photographer record and update session flags
      const photographer = await storage.getPhotographerByUserId(userId);
      if (photographer) {
        (safeUser as any).isPhotographer = true;
        if (req.session) {
          req.session.isPhotographer = true;
          req.session.photographerId = photographer.id;
        }
      }
      
      res.json(safeUser);
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "Failed to get user" });
    }
  });

  // ============================================================
  // GET /api/auth/me - Single source of truth for authenticated session
  // Mobile apps and frontends should use this to verify session state
  // ============================================================
  app.get("/api/auth/me", async (req, res) => {
    try {
      // Get authenticated user ID from JWT, session, or OAuth
      const oauthUser = req.user as any;
      const oauthUserId = oauthUser?.claims?.sub;
      // getUserIdFromRequest checks JWT (Authorization: Bearer) first, then session
      const authenticatedUserId = oauthUserId || getUserIdFromRequest(req);

      if (!authenticatedUserId) {
        return res.status(401).json({ 
          authenticated: false,
          error: "Not authenticated",
          code: "NOT_AUTHENTICATED"
        });
      }

      const user = await storage.getUser(authenticatedUserId);
      if (!user) {
        // Session references non-existent user - clear session
        if (req.session) {
          req.session.destroy((err) => {
            if (err) console.error("Session destroy error:", err);
          });
        }
        return res.status(401).json({ 
          authenticated: false,
          error: "Session invalid - user not found",
          code: "USER_NOT_FOUND"
        });
      }

      // Build session state object - this is the authoritative source
      const sessionState = {
        authenticated: true,
        userId: user.id,
        username: user.username,
        displayName: user.name,
        bio: user.bio ?? null,
        email: user.email,
        profilePhotoUrl: user.profileImageUrl,
        isVendor: false as boolean,
        isPhotographer: false as boolean,
        businessId: null as string | null,
        photographerId: null as string | null,
      };

      // Check for business ownership
      const business = await storage.getBusinessByOwnerId(user.id);
      if (business) {
        sessionState.isVendor = true;
        sessionState.businessId = business.id;
        // Update session to keep in sync
        if (req.session) {
          req.session.isVendor = true;
          req.session.businessId = business.id;
        }
      }

      // Check for photographer profile
      const photographer = await storage.getPhotographerByUserId(user.id);
      if (photographer) {
        sessionState.isPhotographer = true;
        sessionState.photographerId = photographer.id;
        // Update session to keep in sync
        if (req.session) {
          req.session.isPhotographer = true;
          req.session.photographerId = photographer.id;
        }
      }

      console.log(`[AUTH_ME] Session verified for userId: ${user.id} | isVendor: ${sessionState.isVendor} | isPhotographer: ${sessionState.isPhotographer}`);
      res.json(sessionState);
    } catch (error) {
      console.error("Get /api/auth/me error:", error);
      res.status(500).json({ 
        authenticated: false,
        error: "Failed to verify session",
        code: "SERVER_ERROR"
      });
    }
  });

  // ==================== PASSWORD RESET (CODE-BASED FLOW) ====================

  // Send 6-digit verification code via email
  app.post("/api/auth/forgot-password/send-code", strictAuthRateLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ success: false, message: "Email is required" });
      }

      // Always return success to prevent email enumeration
      const user = await storage.getUserByEmail(email.toLowerCase().trim());
      if (!user) {
        return res.json({ success: true, message: "If an account exists with that email, a reset code has been sent." });
      }

      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const { createHash } = await import('crypto');
      const codeHash = createHash('sha256').update(code).digest('hex');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Store hashed code with expiry, reset attempts
      await storage.updateUser(user.id, {
        resetCodeHash: codeHash,
        resetCodeExpiresAt: expiresAt,
        resetCodeAttempts: 0,
      });

      // Send code via Resend
      try {
        const { Resend } = await import('resend');
        const resendApiKey = process.env.RESEND_API_KEY;
        if (resendApiKey) {
          const resend = new Resend(resendApiKey);
          await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'noreply@info.goutsyde.com',
            to: email,
            subject: 'Outsyde — Password Reset Code',
            html: `
              <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #f59e0b;">Outsyde</h2>
                <p>Your password reset code is:</p>
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 20px; background: #f5f5f5; border-radius: 8px; margin: 16px 0;">${code}</div>
                <p style="color: #666;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
                <p style="color: #999; font-size: 12px;">— Outsyde Team</p>
              </div>
            `,
          });
          console.log(`[Auth] Reset code sent to ${email}`);
        } else {
          console.log(`[Auth] RESEND_API_KEY not set. Reset code for ${email}: ${code}`);
        }
      } catch (emailErr) {
        console.error("Failed to send reset code email:", emailErr);
      }

      res.json({ success: true, message: "If an account exists with that email, a reset code has been sent." });
    } catch (error) {
      console.error("Send reset code error:", error);
      res.status(500).json({ success: false, message: "Failed to send reset code" });
    }
  });

  // Verify 6-digit code and issue one-time reset token
  app.post("/api/auth/forgot-password/verify-code", strictAuthRateLimiter, async (req, res) => {
    try {
      const { email, code } = req.body;
      if (!email || !code) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Email and code are required' } });
      }

      const user = await storage.getUserByEmail(email.toLowerCase().trim());
      if (!user || !user.resetCodeHash || !user.resetCodeExpiresAt) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_CODE', message: 'Invalid or expired code. Please request a new one.' } });
      }

      // Check attempts (max 5)
      if ((user.resetCodeAttempts ?? 0) >= 5) {
        // Invalidate the code
        await storage.updateUser(user.id, { resetCodeHash: null, resetCodeExpiresAt: null, resetCodeAttempts: 0 });
        return res.status(400).json({ success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed attempts. Please request a new code.' } });
      }

      // Check expiry
      const expiresAt = new Date(user.resetCodeExpiresAt);
      if (expiresAt < new Date()) {
        await storage.updateUser(user.id, { resetCodeHash: null, resetCodeExpiresAt: null, resetCodeAttempts: 0 });
        return res.status(400).json({ success: false, error: { code: 'INVALID_CODE', message: 'Invalid or expired code. Please request a new one.' } });
      }

      // Verify code hash
      const { createHash, randomBytes } = await import('crypto');
      const submittedHash = createHash('sha256').update(code.toString().trim()).digest('hex');

      if (submittedHash !== user.resetCodeHash) {
        // Increment attempts
        await storage.updateUser(user.id, { resetCodeAttempts: (user.resetCodeAttempts ?? 0) + 1 });
        return res.status(400).json({ success: false, error: { code: 'INVALID_CODE', message: 'Invalid or expired code. Please request a new one.' } });
      }

      // Code is valid — generate a one-time reset token (15-minute expiry)
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const tokenExpiry = new Date(Date.now() + 15 * 60 * 1000);

      // Mark code as used, store reset token
      await storage.updateUser(user.id, {
        resetCodeHash: null,
        resetCodeExpiresAt: null,
        resetCodeAttempts: 0,
        resetTokenHash: tokenHash,
        resetTokenExpiresAt: tokenExpiry,
      });

      res.json({ success: true, resetToken: rawToken });
    } catch (error) {
      console.error("Verify reset code error:", error);
      res.status(500).json({ success: false, message: "Failed to verify code" });
    }
  });

  // ==================== PASSWORD RESET (DEEP LINK FLOW — LEGACY) ====================

  app.post("/api/auth/forgot-password", strictAuthRateLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ success: false, message: "Email is required" });
      }

      const user = await storage.getUserByEmail(email.toLowerCase().trim());

      // Always return success to prevent email enumeration
      if (!user) {
        return res.json({ success: true, message: "If an account with that email exists, a reset link has been sent" });
      }

      // Generate reset token
      const { randomBytes, createHash } = await import('crypto');
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await storage.updateUser(user.id, {
        resetTokenHash: tokenHash,
        resetTokenExpiresAt: expiresAt,
      });

      // Build reset deep link for mobile app
      const resetLink = `outsyde://reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`;
      const webResetLink = `${req.protocol}://${req.get('host')}/reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`;

      // Send email via Resend if configured
      try {
        const { Resend } = await import('resend');
        const resendApiKey = process.env.RESEND_API_KEY;
        if (resendApiKey) {
          const resend = new Resend(resendApiKey);
          await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'noreply@outsyde.com',
            to: email,
            subject: 'Reset your Outsyde password',
            html: `
              <h2>Password Reset</h2>
              <p>You requested a password reset for your Outsyde account.</p>
              <p><a href="${webResetLink}" style="background: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Reset Password</a></p>
              <p>Or open this link on your phone: <a href="${resetLink}">${resetLink}</a></p>
              <p>This link expires in 1 hour.</p>
              <p>If you didn't request this, ignore this email.</p>
            `,
          });
          console.log(`[Auth] Password reset email sent to ${email}`);
        } else {
          console.log(`[Auth] RESEND_API_KEY not configured. Reset token for ${email}: ${rawToken}`);
        }
      } catch (emailError) {
        console.error("Failed to send reset email:", emailError);
      }

      res.json({ success: true, message: "If an account with that email exists, a reset link has been sent" });
    } catch (error) {
      console.error("Forgot password error:", error);
      res.status(500).json({ success: false, message: "Failed to process password reset request" });
    }
  });

  app.post("/api/auth/reset-password", strictAuthRateLimiter, async (req, res) => {
    try {
      const { token, resetToken, email, newPassword } = req.body;
      const resolvedToken = resetToken || token;

      if (!resolvedToken || !email || !newPassword) {
        return res.status(400).json({ success: false, message: "Token, email, and newPassword are required" });
      }

      if (typeof newPassword !== 'string' || newPassword.length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      }

      const user = await storage.getUserByEmail(email.toLowerCase().trim());
      if (!user) {
        return res.status(400).json({ success: false, message: "Invalid or expired reset token" });
      }

      // Verify token hash
      const { createHash } = await import('crypto');
      const tokenHash = createHash('sha256').update(resolvedToken).digest('hex');

      if (!user.resetTokenHash || user.resetTokenHash !== tokenHash) {
        return res.status(400).json({ success: false, message: "Invalid or expired reset token" });
      }

      // Check expiry
      const expiresAt = user.resetTokenExpiresAt ? new Date(user.resetTokenExpiresAt) : null;
      if (!expiresAt || expiresAt < new Date()) {
        return res.status(400).json({ success: false, message: "Invalid or expired reset token" });
      }

      // Hash new password and clear reset token
      const hashedPassword = await hashPassword(newPassword);
      await storage.updateUser(user.id, {
        password: hashedPassword,
        resetTokenHash: null,
        resetTokenExpiresAt: null,
      });

      // Revoke all existing refresh tokens for security
      await storage.revokeAllUserRefreshTokens(user.id);

      console.log(`[Auth] Password reset completed for ${email}`);
      res.json({ success: true, message: "Password has been reset successfully" });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({ success: false, message: "Failed to reset password" });
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

  // ==================== USER IDENTITY (with rate limiting) ====================
  
  // Rate limits for identity changes (similar to major platforms)
  const USERNAME_CHANGE_COOLDOWN_DAYS = 14;
  
  // Helper to check if enough time has passed since last change
  const canChangeIdentityField = (lastChangedAt: Date | null, cooldownDays: number): { allowed: boolean; daysRemaining: number } => {
    if (!lastChangedAt) {
      return { allowed: true, daysRemaining: 0 };
    }
    const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
    const timeSinceChange = Date.now() - lastChangedAt.getTime();
    const allowed = timeSinceChange >= cooldownMs;
    const daysRemaining = allowed ? 0 : Math.ceil((cooldownMs - timeSinceChange) / (24 * 60 * 60 * 1000));
    return { allowed, daysRemaining };
  };

  // Update user identity fields (username, displayName) with rate limiting
  app.patch("/api/users/identity", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const schema = z.object({
        username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores").optional(),
        displayName: z.string().min(1).max(50).optional(),
        name: z.string().min(1).max(100).optional(), // Alias for displayName
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ 
          error: parsed.error.errors[0]?.message || "Invalid data" 
        });
      }

      const { username, displayName, name } = parsed.data;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const updates: Record<string, any> = {};
      const errors: string[] = [];

      // Username change with 30-day cooldown
      if (username !== undefined && username !== user.username) {
        const { allowed, daysRemaining } = canChangeIdentityField(user.usernameLastChangedAt, USERNAME_CHANGE_COOLDOWN_DAYS);
        
        if (!allowed) {
          errors.push(`Username can only be changed once every ${USERNAME_CHANGE_COOLDOWN_DAYS} days. ${daysRemaining} days remaining.`);
        } else {
          // Check username uniqueness
          const existingUser = await storage.getUserByUsername(username);
          if (existingUser && existingUser.id !== userId) {
            errors.push("This username is already taken");
          } else {
            updates.username = username;
            updates.usernameLastChangedAt = new Date();
          }
        }
      }

      // DisplayName/Name changes are allowed without cooldown
      const newDisplayName = displayName || name;
      const currentDisplayName = user.name || user.firstName;
      if (newDisplayName !== undefined && newDisplayName !== currentDisplayName) {
        updates.name = newDisplayName;
        updates.displayNameLastChangedAt = new Date();
      }

      // If there are rate limit errors, return them
      if (errors.length > 0) {
        return res.status(429).json({ 
          error: "Rate limit exceeded",
          message: errors.join(" "),
          details: errors
        });
      }

      // If no updates needed
      if (Object.keys(updates).length === 0) {
        return res.json({ 
          success: true, 
          message: "No changes made",
          user: { 
            id: user.id, 
            username: user.username, 
            displayName: user.name || user.firstName,
            usernameLastChangedAt: user.usernameLastChangedAt,
            displayNameLastChangedAt: user.displayNameLastChangedAt,
          }
        });
      }

      // Apply updates
      const updatedUser = await storage.updateUser(userId, updates);
      
      res.json({ 
        success: true, 
        user: {
          id: updatedUser!.id,
          username: updatedUser!.username,
          displayName: updatedUser!.name || updatedUser!.firstName,
          usernameLastChangedAt: updatedUser!.usernameLastChangedAt,
          displayNameLastChangedAt: updatedUser!.displayNameLastChangedAt,
        }
      });
    } catch (error) {
      console.error("Update user identity error:", error);
      res.status(500).json({ error: "Failed to update identity" });
    }
  });

  // Get identity change status (advisory for frontend)
  app.get("/api/users/identity/status", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const usernameStatus = canChangeIdentityField(user.usernameLastChangedAt, USERNAME_CHANGE_COOLDOWN_DAYS);

      res.json({
        username: {
          current: user.username,
          canChange: usernameStatus.allowed,
          daysRemaining: usernameStatus.daysRemaining,
          cooldownDays: USERNAME_CHANGE_COOLDOWN_DAYS,
          lastChangedAt: user.usernameLastChangedAt,
        },
        displayName: {
          current: user.name || user.firstName,
          canChange: true,
          daysRemaining: 0,
          cooldownDays: 0,
          lastChangedAt: user.displayNameLastChangedAt,
        }
      });
    } catch (error) {
      console.error("Get identity status error:", error);
      res.status(500).json({ error: "Failed to get identity status" });
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

  // ==================== USER PROFILE UPDATE ====================

  // Update user profile (for consumers/influencers - profileImageUrl, coverMediaUrl, coverMediaType)
  app.patch("/api/users/me", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const updateSchema = z.object({
        profileImageUrl: z.string().url().optional().nullable(),
        coverMediaUrl: z.string().url().optional().nullable(),
        coverMediaType: z.enum(['image', 'video']).optional().nullable(),
        bio: z.string().optional().nullable(),
      });

      const validated = updateSchema.safeParse(req.body);
      if (!validated.success) {
        return res.status(400).json({ 
          error: "Invalid data", 
          details: validated.error.errors 
        });
      }

      // Validate that coverMediaType is provided when coverMediaUrl is set
      if (validated.data.coverMediaUrl && !validated.data.coverMediaType) {
        return res.status(400).json({ 
          error: "coverMediaType is required when setting coverMediaUrl" 
        });
      }

      const updateData: Record<string, any> = {};
      if (validated.data.profileImageUrl !== undefined) {
        updateData.profileImageUrl = validated.data.profileImageUrl;
      }
      if (validated.data.coverMediaUrl !== undefined) {
        updateData.coverMediaUrl = validated.data.coverMediaUrl;
      }
      if (validated.data.coverMediaType !== undefined) {
        updateData.coverMediaType = validated.data.coverMediaType;
      }
      if (validated.data.bio !== undefined) {
        updateData.bio = validated.data.bio;
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      const user = await storage.updateUser(userId, updateData);

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const safeUser = sanitizeUserForResponse(user, { includeOwnData: true });
      res.json({ 
        success: true,
        user: safeUser,
        message: "Profile updated successfully"
      });
    } catch (error) {
      console.error("Update user profile error:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // ==================== USER MONETIZATION INTENT ====================

  // Schema for monetization intent (user-controlled fields only)
  const monetizationIntentSchema = z.object({
    userId: z.string().optional(), // Optional: used if not authenticated via JWT
    wantsToSellProducts: z.boolean().optional(),
    wantsToOfferServices: z.boolean().optional(),
    wantsToPromoteAsInfluencer: z.boolean().optional(),
  });

  // Use optional auth middleware - allows both authenticated and body userId
  app.post("/api/user/monetization-intent", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      // Validate input
      const parsed = monetizationIntentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ 
          success: false, 
          error: parsed.error.errors[0]?.message || "Invalid input" 
        });
      }

      const { wantsToSellProducts, wantsToOfferServices, wantsToPromoteAsInfluencer } = parsed.data;

      // Priority: JWT userId > body userId
      // For mobile apps with JWT auth, userId comes from token
      // For initial development/testing, body userId is accepted as fallback
      const userId = authReq.user?.userId || parsed.data.userId;
      
      if (!userId) {
        return res.status(400).json({ 
          success: false, 
          error: "userId is required (via auth token or request body)" 
        });
      }

      // Check if user exists
      const existingUser = await storage.getUser(userId);
      if (!existingUser) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      // Build update object with only provided fields (never touch roles or canMonetize)
      const updates: Record<string, boolean> = {};
      if (wantsToSellProducts !== undefined) {
        updates.wantsToSellProducts = wantsToSellProducts;
      }
      if (wantsToOfferServices !== undefined) {
        updates.wantsToOfferServices = wantsToOfferServices;
      }
      if (wantsToPromoteAsInfluencer !== undefined) {
        updates.wantsToPromoteAsInfluencer = wantsToPromoteAsInfluencer;
      }

      // Update user's monetization intent
      await storage.updateUser(userId, updates);

      res.json({ success: true });
    } catch (error) {
      console.error("Update monetization intent error:", error);
      res.status(500).json({ success: false, error: "Failed to update monetization intent" });
    }
  });

  // ==================== USER LOCATION ====================

  // Schema for location update with validation
  const locationUpdateSchema = z.object({
    userId: z.string().optional(), // Optional: used if not authenticated via JWT
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    city: z.string().min(1).max(100).optional(),
    state: z.string().min(1).max(100).optional(),
  });

  // Update user location (POST)
  app.post("/api/user/location", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const parsed = locationUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ 
          success: false, 
          error: parsed.error.errors[0]?.message || "Invalid location data",
          details: parsed.error.errors,
        });
      }

      const { latitude, longitude, city, state } = parsed.data;

      // Priority: JWT userId > session userId > body userId
      const userId = authReq.user?.userId || req.session?.userId || parsed.data.userId;
      
      if (!userId) {
        return res.status(400).json({ 
          success: false, 
          error: "userId is required (via auth token, session, or request body)" 
        });
      }

      // Check if user exists
      const existingUser = await storage.getUser(userId);
      if (!existingUser) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      // Build update object
      const updates: { latitude: number; longitude: number; city?: string; state?: string } = {
        latitude,
        longitude,
      };
      if (city !== undefined) updates.city = city;
      if (state !== undefined) updates.state = state;

      // Update user's location
      await storage.updateUser(userId, updates);

      res.json({ 
        success: true,
        location: {
          latitude,
          longitude,
          city: city || existingUser.city,
          state: state || existingUser.state,
        }
      });
    } catch (error) {
      console.error("Update user location error:", error);
      res.status(500).json({ success: false, error: "Failed to update location" });
    }
  });

  // Get user location (GET)
  app.get("/api/user/location", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      // Priority: JWT userId > session userId > query userId
      const userId = authReq.user?.userId || req.session?.userId || (req.query.userId as string);
      
      if (!userId) {
        return res.status(400).json({ 
          success: false, 
          error: "userId is required (via auth token, session, or query param)" 
        });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      res.json({ 
        success: true,
        location: {
          latitude: user.latitude || null,
          longitude: user.longitude || null,
          city: user.city || null,
          state: user.state || null,
        }
      });
    } catch (error) {
      console.error("Get user location error:", error);
      res.status(500).json({ success: false, error: "Failed to get location" });
    }
  });

  // ==================== FOLLOWS (Private) ====================

  // Follow a user - requires authentication (JWT or session only, no body/query spoofing)
  app.post("/api/follows", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      // SECURITY: Only accept userId from verified auth context (JWT or session)
      const followerUserId = authReq.user?.userId || req.session?.userId;
      if (!followerUserId) {
        return res.status(401).json({ success: false, error: "Authentication required" });
      }

      const { targetUserId } = req.body;
      if (!targetUserId || typeof targetUserId !== 'string') {
        return res.status(400).json({ success: false, error: "targetUserId is required" });
      }

      // Resolve the actual user to follow: targetUserId may be a user id directly,
      // a business id (resolves to businesses.ownerId), or a photographer record id
      // (resolves to photographers.userId).
      let resolvedTargetUserId = targetUserId;
      const targetUser = await storage.getUser(targetUserId);
      if (!targetUser) {
        const targetBusiness = await storage.getBusiness(targetUserId);
        if (targetBusiness) {
          resolvedTargetUserId = targetBusiness.ownerId;
        } else {
          const targetPhotographer = await storage.getPhotographer(targetUserId);
          if (targetPhotographer) {
            resolvedTargetUserId = targetPhotographer.userId;
          }
        }
      }

      // Verify the resolved target user exists
      const resolvedTargetUser = targetUser || await storage.getUser(resolvedTargetUserId);
      if (!resolvedTargetUser) {
        return res.status(404).json({ success: false, error: "Target user not found" });
      }

      // Prevent self-follow
      if (followerUserId === resolvedTargetUserId) {
        return res.status(400).json({ success: false, error: "Cannot follow yourself" });
      }

      // Check if already following
      const existingFollow = await storage.getFollow(followerUserId, resolvedTargetUserId);
      if (existingFollow) {
        return res.status(409).json({ success: false, error: "Already following this user" });
      }

      // Create follow relationship
      const follow = await storage.createFollow({ followerUserId, targetUserId: resolvedTargetUserId });

      // Get follower info for notification
      const followerUser = await storage.getUser(followerUserId);
      const followerName = followerUser?.name || followerUser?.firstName || "Someone";

      // Send notification to target user
      await NotificationTriggers.newFollower({
        targetUserId: resolvedTargetUserId,
        followerUserId,
        followerName,
      });

      res.status(201).json({ success: true, follow });
    } catch (error) {
      console.error("Follow user error:", error);
      res.status(500).json({ success: false, error: "Failed to follow user" });
    }
  });

  // Resolve a /api/follows target param to the actual user id to operate against:
  // a raw user id is returned as-is; a business id resolves to its owner's user id.
  // Mirrors the resolution already applied in POST /api/follows.
  async function resolveFollowTargetUserId(targetUserId: string): Promise<string | undefined> {
    const targetUser = await storage.getUser(targetUserId);
    if (targetUser) {
      return targetUserId;
    }
    const targetBusiness = await storage.getBusiness(targetUserId);
    if (targetBusiness) {
      return targetBusiness.ownerId;
    }
    const targetPhotographer = await storage.getPhotographer(targetUserId);
    if (targetPhotographer) {
      return targetPhotographer.userId;
    }
    return undefined;
  }

  // Unfollow a user - requires authentication (JWT or session only)
  app.delete("/api/follows/:targetUserId", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      // SECURITY: Only accept userId from verified auth context (JWT or session)
      const followerUserId = authReq.user?.userId || req.session?.userId;
      if (!followerUserId) {
        return res.status(401).json({ success: false, error: "Authentication required" });
      }

      const { targetUserId } = req.params;
      if (!targetUserId) {
        return res.status(400).json({ success: false, error: "targetUserId is required" });
      }

      const resolvedTargetUserId = await resolveFollowTargetUserId(targetUserId) || targetUserId;

      // Check if follow exists
      const existingFollow = await storage.getFollow(followerUserId, resolvedTargetUserId);
      if (!existingFollow) {
        return res.status(404).json({ success: false, error: "Not following this user" });
      }

      // Delete follow relationship
      await storage.deleteFollow(followerUserId, resolvedTargetUserId);

      res.json({ success: true, message: "Unfollowed successfully" });
    } catch (error) {
      console.error("Unfollow user error:", error);
      res.status(500).json({ success: false, error: "Failed to unfollow user" });
    }
  });

  // Check if following a user - requires authentication (JWT or session only)
  app.get("/api/follows/check/:targetUserId", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      // SECURITY: Only accept userId from verified auth context (JWT or session)
      const followerUserId = authReq.user?.userId || req.session?.userId;
      if (!followerUserId) {
        return res.status(401).json({ success: false, error: "Authentication required" });
      }

      const { targetUserId } = req.params;
      if (!targetUserId) {
        return res.status(400).json({ success: false, error: "targetUserId is required" });
      }

      const resolvedTargetUserId = await resolveFollowTargetUserId(targetUserId);
      if (!resolvedTargetUserId) {
        return res.json({ success: true, isFollowing: false });
      }

      const follow = await storage.getFollow(followerUserId, resolvedTargetUserId);
      res.json({ success: true, isFollowing: !!follow });
    } catch (error) {
      console.error("Check follow error:", error);
      res.status(500).json({ success: false, error: "Failed to check follow status" });
    }
  });

  // Get current user's following list
  app.get("/api/users/me/following", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) {
        return res.status(401).json({ success: false, error: "Authentication required" });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const followingUsers = await storage.getUserFollowing(userId, limit, offset);
      const totalCount = await storage.getFollowingCount(userId);

      // Return canonical user objects (safe public data only)
      const following = followingUsers.map(user => ({
        userId: user.id,
        username: user.username || null,
        displayName: user.name || user.firstName || 'Anonymous',
        profilePhotoUrl: user.profileImageUrl || null,
      }));

      res.json({ 
        success: true, 
        following, 
        total: totalCount,
        limit,
        offset 
      });
    } catch (error) {
      console.error("Get following error:", error);
      res.status(500).json({ success: false, error: "Failed to get following list" });
    }
  });

  // Get current user's followers list
  app.get("/api/users/me/followers", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) {
        return res.status(401).json({ success: false, error: "Authentication required" });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const followerUsers = await storage.getUserFollowers(userId, limit, offset);
      const totalCount = await storage.getFollowerCount(userId);

      // Return canonical user objects (safe public data only)
      const followers = followerUsers.map(user => ({
        userId: user.id,
        username: user.username || null,
        displayName: user.name || user.firstName || 'Anonymous',
        profilePhotoUrl: user.profileImageUrl || null,
      }));

      res.json({ 
        success: true, 
        followers, 
        total: totalCount,
        limit,
        offset 
      });
    } catch (error) {
      console.error("Get followers error:", error);
      res.status(500).json({ success: false, error: "Failed to get followers list" });
    }
  });

  // Get any user's following list (public profile)
  app.get("/api/users/:userId/following", async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Verify user exists
      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const followingUsers = await storage.getUserFollowing(userId, limit, offset);
      const totalCount = await storage.getFollowingCount(userId);

      // Return canonical user objects (safe public data only)
      const following = followingUsers.map(user => ({
        userId: user.id,
        username: user.username || null,
        displayName: user.name || user.firstName || 'Anonymous',
        profilePhotoUrl: user.profileImageUrl || null,
      }));

      res.json({ 
        success: true, 
        following, 
        total: totalCount,
        limit,
        offset 
      });
    } catch (error) {
      console.error("Get user following error:", error);
      res.status(500).json({ success: false, error: "Failed to get following list" });
    }
  });

  // Get any user's followers list (public profile)
  app.get("/api/users/:userId/followers", async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Verify user exists
      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const followerUsers = await storage.getUserFollowers(userId, limit, offset);
      const totalCount = await storage.getFollowerCount(userId);

      // Return canonical user objects (safe public data only)
      const followers = followerUsers.map(user => ({
        userId: user.id,
        username: user.username || null,
        displayName: user.name || user.firstName || 'Anonymous',
        profilePhotoUrl: user.profileImageUrl || null,
      }));

      res.json({ 
        success: true, 
        followers, 
        total: totalCount,
        limit,
        offset 
      });
    } catch (error) {
      console.error("Get user followers error:", error);
      res.status(500).json({ success: false, error: "Failed to get followers list" });
    }
  });

  // Get user's posts with optional featured content grouping
  // Query params: 
  //   - limit (default 50), offset (default 0): pagination for all posts
  //   - includeFeaturedContent (optional): when 'true', includes featuredContent object with proPosts and pulsePosts
  //   - featuredLimit (default 5): max items per featured category
  app.get("/api/users/:userId/posts", async (req, res) => {
    try {
      const { userId } = req.params;
      
      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const includeFeaturedContent = req.query.includeFeaturedContent === 'true';
      const featuredLimit = parseInt(req.query.featuredLimit as string) || 5;

      // Helper to enrich a single post with author and metadata
      const enrichPost = async (post: any) => {
        const author = await storage.getUser(post.authorId);
        if (!author) return null;

        let authorRole: 'consumer' | 'photographer' | 'vendor' = 'consumer';
        let authorBusinessId: string | null = null;
        let authorPhotographerId: string | null = null;

        if (post.authorType === 'vendor') {
          const business = await storage.getBusinessByOwnerId(post.authorId);
          if (business) {
            authorBusinessId = business.id;
            authorRole = 'vendor';
          }
        } else if (post.authorType === 'photographer') {
          const photographer = await storage.getPhotographerByUserId(post.authorId);
          if (photographer) {
            authorPhotographerId = photographer.id;
            authorRole = 'photographer';
          }
        }

        const mediaObj = (post.mediaUrl || post.imageUrl) ? {
          mediaUrl: post.mediaUrl || post.imageUrl,
          mediaType: post.mediaType || 'image',
          width: post.mediaWidth || null,
          height: post.mediaHeight || null,
          aspectRatio: post.aspectRatio || null,
        } : null;

        return {
          id: post.id,
          mediaUrl: post.mediaUrl || post.imageUrl || null,
          mediaType: post.mediaType || 'image',
          postIntent: post.postIntent,
          likeCount: post.likesCount || 0,
          duration: null,
          createdAt: post.createdAt,
          content: post.content,
          author: {
            userId: author.id,
            username: author.username || null,
            displayName: author.name || author.firstName || 'Anonymous',
            profilePhotoUrl: author.profileImageUrl || null,
            role: authorRole,
          },
          media: mediaObj,
        };
      };

      // Get all posts for the user (with pagination)
      const allPosts = await storage.getUserFeedPosts(userId);
      const paginatedPosts = allPosts.slice(offset, offset + limit);
      
      const enrichedPosts = [];
      for (const post of paginatedPosts) {
        const enriched = await enrichPost(post);
        if (enriched) enrichedPosts.push(enriched);
      }

      // Build response
      const response: any = {
        success: true,
        posts: enrichedPosts,
        total: allPosts.length,
        limit,
        offset,
      };

      // Optionally add featured content grouping
      if (includeFeaturedContent) {
        const [proPosts, pulsePosts] = await Promise.all([
          storage.getUserFeedPostsByIntent(userId, 'promotion', featuredLimit),
          storage.getUserFeedPostsByIntent(userId, 'social', featuredLimit),
        ]);

        const enrichedProPosts = [];
        for (const post of proPosts) {
          const enriched = await enrichPost(post);
          if (enriched) enrichedProPosts.push(enriched);
        }

        const enrichedPulsePosts = [];
        for (const post of pulsePosts) {
          const enriched = await enrichPost(post);
          if (enriched) enrichedPulsePosts.push(enriched);
        }

        response.featuredContent = {
          proPosts: enrichedProPosts,
          pulsePosts: enrichedPulsePosts,
        };
      }

      res.json(response);
    } catch (error) {
      console.error("Get user posts error:", error);
      res.status(500).json({ success: false, error: "Failed to get user posts" });
    }
  });

  // Get all posts for a profile (vendor, photographer, or consumer) — used by profile Posts tab.
  // Works for both authenticated and unauthenticated viewers.
  app.get("/api/profiles/:userId/posts", optionalAuthMiddleware, async (req, res) => {
    try {
      const { userId } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 60, 200);

      const posts = await db
        .select({
          id: feedPosts.id,
          userId: feedPosts.authorId,
          mediaUrl: feedPosts.mediaUrl,
          imageUrl: feedPosts.imageUrl,
          thumbnailUrl: feedPosts.thumbnailUrl,
          caption: feedPosts.content,
          mediaType: feedPosts.mediaType,
          displayLayout: feedPosts.displayLayout,
          feedSurface: feedPosts.feedSurface,
          createdAt: feedPosts.createdAt,
          aspectRatio: feedPosts.aspectRatio,
          likesCount: feedPosts.likesCount,
          commentsCount: feedPosts.commentsCount,
          productId: feedPosts.productId,
          serviceId: feedPosts.serviceId,
          photographerServiceId: feedPosts.photographerServiceId,
        })
        .from(feedPosts)
        .where(
          and(
            eq(feedPosts.authorId, userId),
            eq(feedPosts.isActive, true)
          )
        )
        .orderBy(desc(feedPosts.createdAt))
        .limit(limit);

      res.json({ posts });
    } catch (error) {
      console.error("Get profile posts error:", error);
      res.status(500).json({ error: "Failed to get profile posts" });
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

  // ==================== PHOTOGRAPHER AVAILABILITY ROUTES ====================

  // Get photographer's availability settings (weekly hours, travel settings, blackout dates)
  app.get("/api/photographers/me/availability", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      // Get blackout dates
      const blackoutDates = await db.select()
        .from(photographerBlackoutDates)
        .where(eq(photographerBlackoutDates.photographerId, photographer.id))
        .orderBy(photographerBlackoutDates.date);

      // Get date-specific availability slots
      const availabilitySlots = await db.select()
        .from(photographerAvailability)
        .where(eq(photographerAvailability.photographerId, photographer.id));

      res.json({
        hoursOfOperation: photographer.hoursOfOperation || {},
        travelBufferMinutes: photographer.travelBufferMinutes || 30,
        serviceRadiusMiles: photographer.serviceRadiusMiles || 25,
        serviceLocations: photographer.serviceLocations || [],
        blackoutDates: blackoutDates.map(d => ({ id: d.id, date: d.date, reason: d.reason })),
        availabilitySlots,
      });
    } catch (error) {
      console.error("Get photographer availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  });

  // Update photographer's availability settings (weekly hours, travel settings)
  app.put("/api/photographers/me/availability", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const data = updatePhotographerAvailabilitySettingsSchema.parse(req.body);

      const updated = await storage.updatePhotographer(photographer.id, {
        hoursOfOperation: data.hoursOfOperation,
        travelBufferMinutes: data.travelBufferMinutes,
        serviceRadiusMiles: data.serviceRadiusMiles,
        serviceLocations: data.serviceLocations,
      });

      if (!updated) {
        return res.status(500).json({ error: "Failed to update availability settings" });
      }

      // Sync hoursOfOperation to weeklyAvailability table as safety net
      // Supports both frontend format { open: true, start, end } and legacy format
      if (data.hoursOfOperation) {
        await syncHoursOfOperationToWeeklyAvailability(
          'photographer',
          photographer.id,
          data.hoursOfOperation as Record<string, any>
        );
      }

      res.json({
        hoursOfOperation: updated.hoursOfOperation,
        travelBufferMinutes: updated.travelBufferMinutes,
        serviceRadiusMiles: updated.serviceRadiusMiles,
        serviceLocations: updated.serviceLocations,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update photographer availability error:", error);
      res.status(500).json({ error: "Failed to update availability" });
    }
  });

  // Add blackout date
  app.post("/api/photographers/me/availability/blackout-dates", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const blackoutSchema = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
        reason: z.string().optional(),
      });

      const data = blackoutSchema.parse(req.body);

      const [blackoutDate] = await db.insert(photographerBlackoutDates).values({
        photographerId: photographer.id,
        date: data.date,
        reason: data.reason || null,
      }).returning();

      res.status(201).json(blackoutDate);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Add blackout date error:", error);
      res.status(500).json({ error: "Failed to add blackout date" });
    }
  });

  // Delete blackout date
  app.delete("/api/photographers/me/availability/blackout-dates/:dateId", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const { dateId } = req.params;

      // Verify ownership
      const [existing] = await db.select()
        .from(photographerBlackoutDates)
        .where(and(
          eq(photographerBlackoutDates.id, dateId),
          eq(photographerBlackoutDates.photographerId, photographer.id)
        ));

      if (!existing) {
        return res.status(404).json({ error: "Blackout date not found" });
      }

      await db.delete(photographerBlackoutDates)
        .where(eq(photographerBlackoutDates.id, dateId));

      res.json({ success: true });
    } catch (error) {
      console.error("Delete blackout date error:", error);
      res.status(500).json({ error: "Failed to delete blackout date" });
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

  // Create draft booking to hold a time slot (10-min TTL)
  app.post("/api/bookings/photographer/draft", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const draftSchema = z.object({
        photographerId: z.string().min(1, "Photographer ID is required"),
        serviceId: z.string().min(1, "Service ID is required"),
        date: z.string().min(1, "Date is required"), // YYYY-MM-DD
        startTime: z.string().min(1, "Start time is required"), // HH:MM
      });

      const data = draftSchema.parse(req.body);

      // Get user
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get photographer
      const photographer = await storage.getPhotographer(data.photographerId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer not found" });
      }

      // Check Stripe setup
      if (!photographer.stripeAccountId || !photographer.stripeOnboardingComplete) {
        return res.status(400).json({ 
          error: "Photographer not accepting bookings",
          message: "This photographer has not completed their payment setup."
        });
      }

      // Get service to determine duration and price
      const service = await storage.getPhotographerService(data.serviceId);
      if (!service) {
        return res.status(404).json({ error: "Service not found" });
      }
      if (service.photographerId !== data.photographerId) {
        return res.status(400).json({ error: "Service does not belong to this photographer" });
      }
      
      // Validate service is active, live, and has valid pricing
      if (!service.isActive) {
        return res.status(400).json({ error: "Service is not available for booking" });
      }
      if (service.status !== 'live') {
        return res.status(400).json({ error: "Service is not published for booking" });
      }
      const priceCents = service.priceCents || 0;
      if (priceCents < 100) {
        return res.status(400).json({ error: "Service does not have valid pricing set" });
      }

      // Validate date format (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(data.date)) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
      }
      const bookingDate = new Date(data.date);
      if (isNaN(bookingDate.getTime())) {
        return res.status(400).json({ error: "Invalid date value" });
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (bookingDate < today) {
        return res.status(400).json({ error: "Cannot book dates in the past" });
      }

      // Calculate end time based on the actual booking date
      const durationMinutes = service.estimatedDurationMinutes || 60;
      const durationHours = Math.ceil(durationMinutes / 60);
      
      // Parse start time and compute end time properly
      const [startHour, startMin] = data.startTime.split(':').map(Number);
      if (isNaN(startHour) || isNaN(startMin) || startHour < 0 || startHour > 23 || startMin < 0 || startMin > 59) {
        return res.status(400).json({ error: "Invalid start time format. Use HH:MM" });
      }
      
      // Compute end time in total minutes
      const startTotalMinutes = startHour * 60 + startMin;
      const endTotalMinutes = startTotalMinutes + durationMinutes;
      
      // Validate doesn't cross midnight (reject overnight bookings for simplicity)
      if (endTotalMinutes >= 24 * 60) {
        return res.status(400).json({ 
          error: "Invalid booking duration",
          message: "Booking cannot extend past midnight. Please choose an earlier time slot."
        });
      }
      
      const endHour = Math.floor(endTotalMinutes / 60);
      const endMin = endTotalMinutes % 60;
      const endTime = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;

      // Check photographer availability
      const isAvailable = await storage.checkPhotographerSlotAvailable(
        data.photographerId,
        data.date,
        data.startTime,
        endTime
      );

      if (!isAvailable) {
        return res.status(409).json({ 
          code: "SLOT_UNAVAILABLE",
          message: "This time slot is no longer available. Please choose a different time."
        });
      }

      // Calculate pricing (10% Outsyde booking fee)
      const platformFee = calculateBookingFee(priceCents);
      const vendorNet = priceCents - platformFee;

      // Set draft expiry (10 minutes from now)
      const draftExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

      // Create draft booking with expiry included in initial insert
      const booking = await storage.createShootBooking({
        photographerId: data.photographerId,
        clientId: userId,
        serviceId: data.serviceId,
        shootType: service.name,
        date: data.date,
        startTime: data.startTime,
        endTime,
        durationHours,
        totalPrice: priceCents,
        platformFee,
        vendorNet,
        status: "draft",
        draftExpiresAt,
      });

      // Reserve the photographer's time slot
      let slotReserved = false;
      try {
        await storage.reservePhotographerSlot(
          data.photographerId,
          data.date,
          data.startTime,
          endTime,
          booking.id
        );
        slotReserved = true;
      } catch (slotError) {
        // If slot reservation fails, clean up the draft booking
        console.error("Failed to reserve slot, cleaning up draft:", slotError);
        await storage.updateShootBooking(booking.id, { status: "expired" });
        return res.status(409).json({ 
          error: "Time slot unavailable",
          message: "Failed to reserve time slot. Please try again."
        });
      }

      // If we reach here, both booking and slot are created successfully
      res.json({
        success: true,
        draftId: booking.id,
        expiresAt: draftExpiresAt.toISOString(),
        slot: {
          date: data.date,
          startTime: data.startTime,
          endTime,
          durationMinutes,
        },
        service: {
          id: service.id,
          name: service.name,
          priceCents,
          description: service.description,
        },
        pricing: {
          totalCents: priceCents,
          platformFeeCents: platformFee,
          vendorNetCents: vendorNet,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create photographer draft booking error:", error);
      res.status(500).json({ error: "Failed to create draft booking" });
    }
  });

  // Create photographer booking with Stripe checkout (customer facing)
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
        totalPriceCents: z.number().min(100, "Price must be at least $1.00"),
      });

      const data = bookingSchema.parse(req.body);

      // Get user for Stripe customer ID
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check if photographer has completed Stripe onboarding before allowing booking
      const photographer = await storage.getPhotographer(data.photographerId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer not found" });
      }
      
      if (!photographer.stripeAccountId || !photographer.stripeOnboardingComplete) {
        return res.status(400).json({ 
          error: "Photographer not accepting bookings",
          message: "This photographer has not completed their payment setup and cannot accept bookings at this time."
        });
      }

      // Get service details for display name
      let serviceName = data.shootType;
      let serviceDescription: string | undefined;
      if (data.serviceId) {
        const service = await storage.getPhotographerService(data.serviceId);
        if (service) {
          serviceName = service.name;
          serviceDescription = service.description || undefined;
        }
      }

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

      // Calculate fees (10% Outsyde booking fee)
      const platformFee = calculateBookingFee(data.totalPriceCents);
      const vendorNet = data.totalPriceCents - platformFee;

      // Create booking with "awaiting_payment" status
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
        status: "awaiting_payment",
      });

      // Reserve the photographer's time slot to prevent double bookings
      await storage.reservePhotographerSlot(
        data.photographerId,
        date,
        startTime,
        endTime,
        booking.id
      );

      // Create Stripe checkout session with destination charges
      const baseUrl = process.env.API_BASE_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000'}`;
      const photographerName = photographer.displayName || 'Photographer';
      
      const session = await stripeService.createPhotographerBookingCheckout({
        customerId: user.stripeCustomerId || '',
        connectedAccountId: photographer.stripeAccountId,
        amountInCents: data.totalPriceCents,
        platformFeeInCents: platformFee,
        serviceName: `${serviceName} - ${photographerName}`,
        serviceDescription: serviceDescription || `Photography session on ${date} at ${startTime}`,
        successUrl: `${baseUrl}/booking-success?bookingId=${booking.id}&type=photographer`,
        cancelUrl: `${baseUrl}/photographer/${photographer.id}?cancelled=true`,
        metadata: {
          type: 'shoot_booking',
          shootBookingId: booking.id,
          photographerId: photographer.id,
          clientId: userId,
          serviceId: data.serviceId || '',
        },
      });

      // Update booking with checkout session ID
      await storage.updateShootBooking(booking.id, {
        stripeCheckoutSessionId: session.id,
      });

      res.status(201).json({ 
        booking,
        checkoutUrl: session.url,
        message: "Booking created - please complete payment"
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create photographer booking error:", error);
      res.status(500).json({ error: "Failed to create booking" });
    }
  });

  // Confirm photographer booking payment (called from success page)
  app.post("/api/bookings/photographer/:bookingId/confirm-payment", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { bookingId } = req.params;
      const booking = await storage.getShootBooking(bookingId);

      if (!booking) {
        return res.status(404).json({ code: "BOOKING_NOT_FOUND", message: "Booking not found" });
      }

      if (booking.clientId !== userId) {
        return res.status(403).json({ code: "UNAUTHORIZED", message: "Not authorized to access this booking" });
      }

      // Read-only status endpoint. Booking confirmation is handled exclusively
      // by the Stripe webhook (payment_intent.succeeded → handlePaymentIntentSucceeded).
      // Old app versions may still call this after PaymentSheet succeeds — they
      // receive the current booking status and no error, regardless of whether
      // the webhook has fired yet. No booking state is mutated here.
      //
      // If the booking was created via the old checkout-session flow
      // (stripeCheckoutSessionId set), report the session payment status for
      // informational purposes only — still no state mutation.
      let sessionPaymentStatus: string | null = null;
      if (booking.stripeCheckoutSessionId) {
        try {
          const session = await stripeService.getCheckoutSession(booking.stripeCheckoutSessionId);
          sessionPaymentStatus = session.payment_status;
        } catch (sessionErr) {
          console.warn(`[confirm-payment] Could not retrieve checkout session ${booking.stripeCheckoutSessionId}:`, sessionErr);
        }
      }

      return res.json({
        booking,
        status: booking.status,
        ...(sessionPaymentStatus !== null ? { sessionPaymentStatus } : {}),
      });
    } catch (error) {
      console.error("Confirm photographer booking error:", error);
      res.status(500).json({ code: "INTERNAL_ERROR", message: "Failed to retrieve booking" });
    }
  });

  // Get photographer booking details (for success page)
  app.get("/api/bookings/photographer/:bookingId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { bookingId } = req.params;
      const booking = await storage.getShootBooking(bookingId);

      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Allow client to view their own booking, or photographer to view their bookings
      const photographer = await storage.getPhotographerByUserId(userId);
      const isClient = booking.clientId === userId;
      const isPhotographer = photographer && photographer.id === booking.photographerId;

      if (!isClient && !isPhotographer) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Get service and photographer details
      let service = null;
      if (booking.serviceId) {
        service = await storage.getPhotographerService(booking.serviceId);
      }
      const photographerDetails = await storage.getPhotographer(booking.photographerId);

      res.json({ 
        booking,
        service,
        photographer: photographerDetails ? {
          id: photographerDetails.id,
          displayName: photographerDetails.displayName,
          profileImageUrl: photographerDetails.logoImage,
        } : null,
      });
    } catch (error) {
      console.error("Get photographer booking error:", error);
      res.status(500).json({ error: "Failed to get booking" });
    }
  });

  // ==================== AVAILABILITY & BOOKING STATE MACHINE ROUTES ====================

  // Get available slots for a staff member
  app.get("/api/availability/staff/:staffMemberId", async (req, res) => {
    try {
      const { staffMemberId } = req.params;
      const { startDate, endDate, serviceId } = req.query;

      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required" });
      }

      const availability = await getStaffAvailabilitySlots(
        staffMemberId,
        startDate as string,
        endDate as string,
        serviceId ? parseInt(serviceId as string, 10) : undefined
      );

      res.json({ availability });
    } catch (error) {
      console.error("Get staff availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  });

  // Get available slots for a photographer
  app.get("/api/availability/photographer/:photographerId", async (req, res) => {
    try {
      const { photographerId } = req.params;
      const { startDate, endDate, durationHours, serviceId } = req.query;

      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required" });
      }

      // Never expose availability for a photographer who hasn't finished Stripe onboarding
      // (same rule as the staff availability endpoint, GET /api/businesses/:businessId/staff/:staffId/availability).
      const photographer = await storage.getPhotographer(photographerId);
      if (!photographer || !photographer.stripeOnboardingComplete) {
        return res.status(404).json({ error: "Photographer is not available" });
      }

      // If serviceId is provided, get duration from the service
      let effectiveDurationHours: number | undefined;
      let serviceInfo = null;
      
      if (serviceId) {
        const service = await storage.getPhotographerService(serviceId as string);
        if (!service) {
          return res.status(404).json({ error: "Service not found" });
        }
        if (service.photographerId !== photographerId) {
          return res.status(400).json({ error: "Service does not belong to this photographer" });
        }
        effectiveDurationHours = service.estimatedDurationMinutes ? Math.ceil(service.estimatedDurationMinutes / 60) : undefined;
        serviceInfo = {
          id: service.id,
          name: service.name,
          durationMinutes: service.estimatedDurationMinutes,
          basePrice: service.priceCents,
        };
      } else if (durationHours) {
        effectiveDurationHours = parseInt(durationHours as string, 10);
      }

      const availability = await getPhotographerAvailabilitySlots(
        photographerId,
        startDate as string,
        endDate as string,
        effectiveDurationHours
      );

      res.json({ availability, serviceInfo });
    } catch (error) {
      console.error("Get photographer availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  });

  // Get all staff availability for a business
  app.get("/api/availability/business/:businessId", async (req, res) => {
    try {
      const { businessId } = req.params;
      const { startDate, endDate, serviceId } = req.query;

      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required" });
      }

      const staffAvailability = await getBusinessAvailability(
        businessId,
        startDate as string,
        endDate as string,
        serviceId as string | undefined
      );

      res.json({ staffAvailability });
    } catch (error) {
      console.error("Get business availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  });

  // Check if a specific slot is available
  app.get("/api/availability/check", async (req, res) => {
    try {
      const { type, providerId, date, startTime, endTime } = req.query;

      if (!type || !providerId || !date || !startTime || !endTime) {
        return res.status(400).json({ 
          error: "type, providerId, date, startTime, and endTime are required" 
        });
      }

      if (type !== 'staff' && type !== 'photographer') {
        return res.status(400).json({ error: "type must be 'staff' or 'photographer'" });
      }

      const result = await isSlotAvailable(
        type as 'staff' | 'photographer',
        providerId as string,
        date as string,
        startTime as string,
        endTime as string
      );

      res.json(result);
    } catch (error) {
      console.error("Check slot availability error:", error);
      res.status(500).json({ error: "Failed to check availability" });
    }
  });

  // =========================
  // DYNAMIC AVAILABILITY SYSTEM (New - Slot Generation)
  // Endpoints for calendar, slots, validate, hold, confirm
  // =========================

  // GET /api/availability/calendar - Available days for a month
  app.get("/api/availability/calendar", async (req, res) => {
    try {
      const { providerType, providerId, year, month, staffMemberId, serviceDurationMinutes } = req.query;

      // DEBUG: Log incoming request
      console.log("[AVAILABILITY_DEBUG] GET /api/availability/calendar");
      console.log("[AVAILABILITY_DEBUG] providerType:", providerType);
      console.log("[AVAILABILITY_DEBUG] providerId:", providerId);
      console.log("[AVAILABILITY_DEBUG] year:", year, "month:", month);

      if (!providerType || !providerId || !year || !month) {
        return res.status(400).json({ 
          error: "providerType, providerId, year, and month are required" 
        });
      }

      if (providerType !== 'business' && providerType !== 'photographer') {
        return res.status(400).json({ error: "providerType must be 'business' or 'photographer'" });
      }

      const calendar = await getAvailabilityCalendar(
        providerType as 'business' | 'photographer',
        providerId as string,
        parseInt(year as string, 10),
        parseInt(month as string, 10),
        staffMemberId as string | undefined,
        serviceDurationMinutes ? parseInt(serviceDurationMinutes as string, 10) : undefined
      );

      // DEBUG: Log result
      const availableDays = calendar.filter(d => (d.totalSlots ?? 0) > 0).length;
      console.log("[AVAILABILITY_DEBUG] Calendar result: total days =", calendar.length, "available days =", availableDays);

      res.json({ days: calendar });
    } catch (error) {
      console.error("Get availability calendar error:", error);
      res.status(500).json({ error: "Failed to get availability calendar" });
    }
  });

  // GET /api/availability/slots - Generated time slots for a specific date
  app.get("/api/availability/slots", async (req, res) => {
    try {
      const { providerType, providerId, date, serviceDurationMinutes, staffMemberId } = req.query;

      if (!providerType || !providerId || !date || !serviceDurationMinutes) {
        return res.status(400).json({ 
          error: "providerType, providerId, date, and serviceDurationMinutes are required" 
        });
      }

      if (providerType !== 'business' && providerType !== 'photographer') {
        return res.status(400).json({ error: "providerType must be 'business' or 'photographer'" });
      }

      const slots = await generateAvailabilitySlots(
        providerType as 'business' | 'photographer',
        providerId as string,
        date as string,
        parseInt(serviceDurationMinutes as string, 10),
        staffMemberId as string | undefined
      );

      res.json({ 
        date,
        slots,
        totalAvailable: slots.filter(s => s.available).length 
      });
    } catch (error) {
      console.error("Generate availability slots error:", error);
      res.status(500).json({ error: "Failed to generate availability slots" });
    }
  });

  // POST /api/booking/validate - Validates service + time compatibility
  app.post("/api/booking/validate", async (req, res) => {
    try {
      const { providerType, providerId, serviceId, date, startTime, staffMemberId } = req.body;

      if (!providerType || !providerId || !serviceId || !date || !startTime) {
        return res.status(400).json({ 
          error: "providerType, providerId, serviceId, date, and startTime are required" 
        });
      }

      if (providerType !== 'business' && providerType !== 'photographer') {
        return res.status(400).json({ error: "providerType must be 'business' or 'photographer'" });
      }

      const result = await validateBookingSlot(
        providerType as 'business' | 'photographer',
        providerId as string,
        serviceId as string,
        date as string,
        startTime as string,
        staffMemberId as string | undefined
      );

      if (!result.valid) {
        return res.status(400).json({
          valid: false,
          errorCode: result.errorCode,
          error: result.errorMessage
        });
      }

      res.json({
        valid: true,
        serviceName: result.serviceName,
        servicePriceCents: result.servicePriceCents,
        serviceDurationMinutes: result.serviceDurationMinutes,
        endTime: calculateEndTime(startTime, result.serviceDurationMinutes!)
      });
    } catch (error) {
      if (error instanceof AvailabilityError) {
        return res.status(400).json({
          valid: false,
          errorCode: error.code,
          error: error.message
        });
      }
      console.error("Validate booking slot error:", error);
      res.status(500).json({ error: "Failed to validate booking slot" });
    }
  });

  // POST /api/booking/hold - Creates a temporary hold
  app.post("/api/booking/hold", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { providerType, providerId, serviceId, date, startTime, staffMemberId, holdDurationMinutes } = req.body;

      if (!providerType || !providerId || !serviceId || !date || !startTime) {
        return res.status(400).json({ 
          error: "providerType, providerId, serviceId, date, and startTime are required" 
        });
      }

      if (providerType !== 'business' && providerType !== 'photographer') {
        return res.status(400).json({ error: "providerType must be 'business' or 'photographer'" });
      }

      const result = await createBookingHold({
        providerType: providerType as 'business' | 'photographer',
        providerId: providerId as string,
        staffMemberId: staffMemberId as string | undefined,
        userId,
        serviceId: serviceId as string,
        date: date as string,
        startTime: startTime as string,
        holdDurationMinutes: holdDurationMinutes ? parseInt(holdDurationMinutes, 10) : undefined
      });

      // Calculate fee preview for frontend display
      const { calculateBookingFees } = await import('./fees');
      const feePreview = calculateBookingFees(result.servicePriceCents);

      res.json({
        success: true,
        holdId: result.holdId,
        expiresAt: result.expiresAt.toISOString(),
        serviceName: result.serviceName,
        servicePriceCents: result.servicePriceCents,
        durationMinutes: result.durationMinutes,
        startTime: result.startTime,
        endTime: result.endTime,
        // Fee breakdown for frontend rendering (all in cents)
        feeBreakdown: {
          subtotalAmount: feePreview.subtotalCents,
          consumerServiceFeeAmount: feePreview.consumerServiceFeeCents,
          bookingFeeAmount: feePreview.platformFeeCents,
          vendorNetAmount: feePreview.vendorNetCents,
          grossChargeAmount: feePreview.customerTotalBeforeTaxCents,
          taxAmount: 0,
          outsydeGrossRevenueAmount: feePreview.outsydeGrossRevenueCents,
          feeModelVersion: feePreview.feeModelVersion,
        },
      });
    } catch (error) {
      if (error instanceof AvailabilityError) {
        return res.status(400).json({
          success: false,
          errorCode: error.code,
          error: error.message
        });
      }
      console.error("Create booking hold error:", error);
      res.status(500).json({ error: "Failed to create booking hold" });
    }
  });

  // POST /api/booking/confirm - Converts hold to confirmed booking
  app.post("/api/booking/confirm", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { holdId } = req.body;

      if (!holdId) {
        return res.status(400).json({ error: "holdId is required" });
      }

      // Validate the hold
      const { hold } = await confirmBookingHold(holdId, userId);

      // Return hold details for the frontend to create the actual booking
      // The actual booking creation should use existing appointment/shoot booking endpoints
      res.json({
        success: true,
        hold: {
          id: hold.id,
          providerType: hold.providerType,
          providerId: hold.providerId,
          staffMemberId: hold.staffMemberId,
          serviceId: hold.serviceId,
          serviceName: hold.serviceName,
          servicePriceCents: hold.servicePriceCents,
          durationMinutes: hold.durationMinutes,
          date: hold.holdDate,
          startTime: hold.startTime,
          endTime: hold.endTime,
          expiresAt: hold.expiresAt.toISOString()
        },
        message: "Hold validated. Proceed to payment."
      });
    } catch (error) {
      if (error instanceof AvailabilityError) {
        return res.status(400).json({
          success: false,
          errorCode: error.code,
          error: error.message
        });
      }
      console.error("Confirm booking hold error:", error);
      res.status(500).json({ error: "Failed to confirm booking hold" });
    }
  });

  // POST /api/booking/:holdId/create-payment-intent - Convert a confirmed hold
  // into a real booking record and create a platform-balance PaymentIntent for it.
  // Supports both business/staff holds (creates an `appointments` row) and
  // photographer holds (creates a `shootBookings` row). Both paths call the same
  // calculateBookingFees() and stripeService.createPlatformPaymentIntent().
  app.post("/api/booking/:holdId/create-payment-intent", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { holdId } = req.params;

      // Validates: hold exists, belongs to this user, is active, not expired.
      const { hold } = await confirmBookingHold(holdId, userId);

      if (hold.providerType !== 'business' && hold.providerType !== 'photographer') {
        return res.status(400).json({ error: "Unsupported provider type" });
      }

      // ==========================================
      // PHOTOGRAPHER BRANCH
      // ==========================================
      if (hold.providerType === 'photographer') {
        // Idempotency: check whether a shootBooking already exists for this
        // photographer/date/time/client combination. shootBookings has no holdId
        // column; the unique constraint on (photographerId, date, startTime)
        // ensures at most one booking per slot, and only one hold can be active
        // per slot at a time, making this lookup unambiguous.
        const [existingShoot] = await db.select()
          .from(shootBookings)
          .where(
            and(
              eq(shootBookings.photographerId, hold.providerId),
              eq(shootBookings.date, hold.holdDate),
              eq(shootBookings.startTime, hold.startTime),
              eq(shootBookings.clientId, hold.userId)
            )
          );
        if (existingShoot) {
          if (existingShoot.stripePaymentIntentId) {
            try {
              const existingPI = await stripeService.getPaymentIntent(existingShoot.stripePaymentIntentId);
              if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existingPI.status)) {
                return res.json({
                  clientSecret: existingPI.client_secret,
                  paymentIntentId: existingPI.id,
                  shootBookingId: existingShoot.id,
                  captureMethod: existingPI.capture_method,
                });
              }
            } catch (piError) {
              console.log(`[Booking] Existing PaymentIntent ${existingShoot.stripePaymentIntentId} for hold ${holdId} not found or invalid`);
            }
          }
          return res.status(409).json({ error: "A payment attempt for this hold already exists." });
        }

        const photographer = await storage.getPhotographer(hold.providerId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        if (!photographer.stripeAccountId || !photographer.stripeOnboardingComplete) {
          return res.status(400).json({ error: "Photographer has not completed Stripe onboarding" });
        }

        // Same calculateBookingFees() as the business branch — one fee model,
        // one place to update when rates change.
        const photographerFees = calculateBookingFees(hold.servicePriceCents);

        // Respect autoAcceptBookings: shoot_booking is already handled by the
        // payment_intent.amount_capturable_updated webhook branch, so manual
        // capture is safe here (unlike the 'appointment' type on the business
        // branch, which forces 'automatic' because that webhook path does not
        // recognise 'appointment' type).
        const captureMethod = photographer.autoAcceptBookings === false ? 'manual' : 'automatic';

        // hold.serviceName was resolved and stored at hold-creation time (via
        // resolveServiceForHold in availabilityService.ts). Use it directly for
        // shootType rather than doing a redundant service lookup.
        const durationHours = Math.ceil(hold.durationMinutes / 60);

        const shootBooking = await storage.createShootBooking({
          photographerId: hold.providerId,
          clientId: hold.userId,
          serviceId: hold.serviceId ?? null,
          shootType: hold.serviceName,
          date: hold.holdDate,
          startTime: hold.startTime,
          endTime: hold.endTime,
          durationHours,
          totalPrice: hold.servicePriceCents,
          platformFee: photographerFees.platformFeeCents,
          vendorNet: photographerFees.vendorNetCents,
          status: BOOKING_STATES.PENDING_PAYMENT,
          draftExpiresAt: null,
        });

        // Permanently block the photographer's calendar slot. This mirrors the
        // same step in POST /api/bookings/photographer/draft. The hold already
        // prevents concurrent holds via its exclusion constraint, but
        // reservePhotographerSlot marks the slot as 'booked' in the
        // photographerAvailability table so the availability calendar reflects
        // it immediately.
        try {
          await storage.reservePhotographerSlot(
            hold.providerId,
            hold.holdDate,
            hold.startTime,
            hold.endTime,
            shootBooking.id
          );
        } catch (slotErr) {
          // Clean up the orphaned shootBooking so it doesn't block the slot
          // in the shootBookings unique-constraint without a corresponding
          // availability entry.
          await storage.updateShootBooking(shootBooking.id, { status: BOOKING_STATES.EXPIRED });
          console.error('[Booking] Failed to reserve photographer slot; marked shootBooking expired:', slotErr);
          return res.status(409).json({ error: "Failed to reserve time slot. Please try again." });
        }

        // Get or create Stripe customer (platform customer, NOT Connect).
        const photographerUser = await storage.getUser(userId);
        if (!photographerUser) {
          return res.status(404).json({ error: "User not found" });
        }
        let photographerStripeCustomerId = photographerUser.stripeCustomerId;
        if (!photographerStripeCustomerId) {
          const customer = await stripeService.createCustomer(
            photographerUser.email!,
            userId,
            photographerUser.name || photographerUser.email!
          );
          photographerStripeCustomerId = customer.id;
          await storage.updateUser(userId, { stripeCustomerId: customer.id });
        }

        // PaymentIntent on platform balance — no transfer_data. After
        // payment_intent.succeeded fires, the webhook's shoot_booking branch
        // (webhookHandlers.ts) transfers vendorPayoutCents to the photographer's
        // connected account. holdId is passed in metadata so the webhook can
        // call markHoldAsConverted once payment succeeds (mirrors how the
        // 'appointment' branch handles hold conversion).
        const photographerPI = await stripeService.createPlatformPaymentIntent({
          amountCents: photographerFees.customerTotalBeforeTaxCents,
          customerId: photographerStripeCustomerId,
          captureMethod,
          metadata: {
            type: 'shoot_booking',
            bookingId: shootBooking.id,
            clientId: userId,
            holdId: hold.id,
            providerId: hold.providerId,
            serviceId: hold.serviceId || '',
            vendorPayoutCents: String(photographerFees.vendorNetCents),
            platformFeeCents: String(photographerFees.platformFeeCents),
          },
          description: `Photography booking with ${photographer.displayName || 'photographer'}`,
          saveForFutureUse: true,
        });

        await db.update(shootBookings).set({
          stripePaymentIntentId: photographerPI.id,
          paymentMethod: 'payment_intent',
          captureMethod,
          updatedAt: new Date(),
        }).where(eq(shootBookings.id, shootBooking.id));

        console.log(`[Booking] Created shoot_booking PaymentIntent ${photographerPI.id} from hold ${holdId} (shootBooking ${shootBooking.id}, charged: ${photographerFees.customerTotalBeforeTaxCents}¢, vendor: ${photographerFees.vendorNetCents}¢)`);

        return res.json({
          clientSecret: photographerPI.client_secret,
          paymentIntentId: photographerPI.id,
          shootBookingId: shootBooking.id,
          captureMethod,
          feeBreakdown: {
            subtotalAmount: photographerFees.subtotalCents,
            consumerServiceFeeAmount: photographerFees.consumerServiceFeeCents,
            bookingFeeAmount: photographerFees.platformFeeCents,
            vendorNetAmount: photographerFees.vendorNetCents,
            grossChargeAmount: photographerFees.customerTotalBeforeTaxCents,
            feeModelVersion: photographerFees.feeModelVersion,
          },
        });
      }

      // ==========================================
      // BUSINESS / STAFF BRANCH (unchanged)
      // ==========================================

      // Idempotency: if an appointment was already created for this hold
      // (e.g. a retried request), reuse it instead of creating a duplicate
      // appointment + PaymentIntent. Mirrors the existing reuse pattern in
      // /api/bookings/appointments/:appointmentId/create-payment-intent.
      const [existing] = await db.select().from(appointments).where(eq(appointments.holdId, holdId));
      if (existing) {
        if (existing.stripePaymentIntentId) {
          try {
            const existingPI = await stripeService.getPaymentIntent(existing.stripePaymentIntentId);
            if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existingPI.status)) {
              return res.json({
                clientSecret: existingPI.client_secret,
                paymentIntentId: existingPI.id,
                appointmentId: existing.id,
                captureMethod: existingPI.capture_method,
              });
            }
          } catch (piError) {
            console.log(`[Booking] Existing PaymentIntent ${existing.stripePaymentIntentId} for hold ${holdId} not found or invalid`);
          }
        }
        return res.status(409).json({ error: "A payment attempt for this hold already exists." });
      }

      const business = await storage.getBusiness(hold.providerId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }
      if (!business.stripeAccountId) {
        return res.status(400).json({ error: "Business has not completed Stripe onboarding" });
      }

      let staffMember: Awaited<ReturnType<typeof storage.getStaffMember>> | undefined;
      if (hold.staffMemberId) {
        staffMember = await storage.getStaffMember(hold.staffMemberId);
        if (!staffMember?.stripeAccountId) {
          return res.status(400).json({ error: "Staff member has not completed Stripe onboarding" });
        }
      }

      // fees.ts subtotal/consumer-fee breakdown, matching the preview already
      // shown to the customer at /api/booking/hold. appointments.totalPrice
      // stores the subtotal (matches existing convention elsewhere in this
      // file); the actual Stripe charge is subtotal + consumer service fee.
      const feeBreakdown = calculateBookingFees(hold.servicePriceCents);

      // NOTE: captureMethod is forced to 'automatic' here, regardless of
      // business.autoAcceptBookings. The manual-capture -> pending_provider
      // path (handlePaymentIntentCapturableUpdated in webhookHandlers.ts)
      // only recognizes type 'appointment_booking'/'shoot_booking', not the
      // 'appointment' type this route uses -- wiring that up is out of scope
      // for this build. Forcing 'automatic' avoids a real deadlock (a manual
      // authorization that never surfaces to the provider to accept, and
      // therefore never gets captured). Revisit once that handler is extended.
      const captureMethod: 'automatic' = 'automatic';

      // Fetch service for location-type check and cancellation-policy snapshot.
      // For staff bookings hold.serviceId is a staff_services.id; for vendor
      // bookings it is a vendor_services.id.
      type ServiceForSnapshot = {
        serviceLocationType: string | null;
        fullRefundWindow: string | null;
        hasPartialRefund: boolean | null;
        partialRefundWindow: string | null;
        partialRefundPercentage: number | null;
        hasCancellationFee: boolean | null;
        cancellationFeeType: string | null;
        cancellationFeeAmount: number | null;
      };
      let serviceForSnapshot: ServiceForSnapshot | undefined;
      if (hold.staffMemberId && hold.serviceId) {
        const staffService = await storage.getStaffService(hold.serviceId);
        if (staffService) serviceForSnapshot = staffService as ServiceForSnapshot;
      } else if (hold.serviceId) {
        const vendorService = await storage.getVendorService(hold.serviceId);
        if (vendorService) serviceForSnapshot = vendorService as ServiceForSnapshot;
      }

      const isCustomerLocation = serviceForSnapshot?.serviceLocationType === 'customer';
      const customerAddress = isCustomerLocation ? {
        customerServiceAddress: req.body.customerServiceAddress ?? null,
        customerServiceCity: req.body.customerServiceCity ?? null,
        customerServiceState: req.body.customerServiceState ?? null,
        customerServiceZipCode: req.body.customerServiceZipCode ?? null,
      } : {};

      const appointment = await storage.createAppointment({
        businessId: hold.providerId,
        clientId: hold.userId,
        // For staff bookings staffServiceId is set and serviceId is left null.
        serviceId: hold.staffMemberId ? null : (hold.serviceId ?? undefined),
        staffServiceId: hold.staffMemberId ? (hold.serviceId ?? undefined) : undefined,
        staffMemberId: hold.staffMemberId || undefined,
        holdId: hold.id,
        appointmentDate: hold.holdDate,
        appointmentTime: hold.startTime,
        appointmentEndTime: hold.endTime,
        durationMinutes: hold.durationMinutes,
        totalPrice: hold.servicePriceCents,
        platformFee: feeBreakdown.platformFeeCents,
        vendorNet: feeBreakdown.vendorNetCents,
        status: BOOKING_STATES.PENDING_PAYMENT,
        paymentMethod: 'payment_intent',
        captureMethod,
        ...customerAddress,
        // Service snapshot — preserved even if service is later edited or archived
        serviceName: hold.serviceName,
        servicePriceCents: hold.servicePriceCents,
        serviceDurationMinutes: hold.durationMinutes,
        serviceFullRefundWindow: serviceForSnapshot?.fullRefundWindow ?? null,
        serviceHasPartialRefund: serviceForSnapshot?.hasPartialRefund ?? null,
        servicePartialRefundWindow: serviceForSnapshot?.partialRefundWindow ?? null,
        servicePartialRefundPercentage: serviceForSnapshot?.partialRefundPercentage ?? null,
        serviceHasCancellationFee: serviceForSnapshot?.hasCancellationFee ?? null,
        serviceCancellationFeeType: serviceForSnapshot?.cancellationFeeType ?? null,
        serviceCancellationFeeAmount: serviceForSnapshot?.cancellationFeeAmount ?? null,
      });

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get or create Stripe customer (platform customer, NOT Connect)
      let stripeCustomerId = user.stripeCustomerId;
      if (!stripeCustomerId) {
        const customer = await stripeService.createCustomer(user.email!, userId, user.name || user.email!);
        stripeCustomerId = customer.id;
        await storage.updateUser(userId, { stripeCustomerId: customer.id });
      }

      const paymentIntent = await stripeService.createPlatformPaymentIntent({
        amountCents: feeBreakdown.customerTotalBeforeTaxCents,
        customerId: stripeCustomerId,
        captureMethod,
        metadata: {
          type: 'appointment',
          appointmentId: appointment.id,
          holdId: hold.id,
          businessId: hold.providerId,
          staffMemberId: hold.staffMemberId || '',
        },
        description: `Appointment booking at ${business.name}`,
        saveForFutureUse: true,
      });

      await db.update(appointments).set({
        stripePaymentIntentId: paymentIntent.id,
        updatedAt: new Date(),
      }).where(eq(appointments.id, appointment.id));

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        appointmentId: appointment.id,
        captureMethod,
        feeBreakdown: {
          subtotalAmount: feeBreakdown.subtotalCents,
          consumerServiceFeeAmount: feeBreakdown.consumerServiceFeeCents,
          bookingFeeAmount: feeBreakdown.platformFeeCents,
          vendorNetAmount: feeBreakdown.vendorNetCents,
          grossChargeAmount: feeBreakdown.customerTotalBeforeTaxCents,
          feeModelVersion: feeBreakdown.feeModelVersion,
        },
      });
    } catch (error) {
      if (error instanceof AvailabilityError) {
        return res.status(400).json({ errorCode: error.code, error: error.message });
      }
      console.error("Create appointment PaymentIntent from hold error:", error);
      res.status(500).json({ error: "Failed to create payment intent" });
    }
  });

  // DELETE /api/booking/hold/:holdId - Release a hold
  app.delete("/api/booking/hold/:holdId", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { holdId } = req.params;

      // Verify the hold belongs to the user
      const hold = await getBookingHold(holdId);
      if (!hold) {
        return res.status(404).json({ error: "Hold not found" });
      }
      if (hold.userId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      await releaseBookingHold(holdId);

      res.json({ success: true, message: "Hold released" });
    } catch (error) {
      console.error("Release booking hold error:", error);
      res.status(500).json({ error: "Failed to release booking hold" });
    }
  });

  // GET /api/booking/holds - Get user's active holds
  app.get("/api/booking/holds", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const holds = await getUserActiveHolds(userId);

      res.json({ 
        holds: holds.map(h => ({
          id: h.id,
          providerType: h.providerType,
          providerId: h.providerId,
          serviceName: h.serviceName,
          servicePriceCents: h.servicePriceCents,
          date: h.holdDate,
          startTime: h.startTime,
          endTime: h.endTime,
          expiresAt: h.expiresAt.toISOString()
        }))
      });
    } catch (error) {
      console.error("Get user holds error:", error);
      res.status(500).json({ error: "Failed to get holds" });
    }
  });

  // =========================
  // WEEKLY AVAILABILITY (Recurring patterns)
  // =========================

  // Get weekly availability for a business
  app.get("/api/businesses/me/weekly-availability", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const { staffMemberId } = req.query;
      const availability = await storage.getWeeklyAvailability(
        'business',
        business.id,
        staffMemberId as string | undefined
      );

      res.json({ availability, autoAcceptBookings: business.autoAcceptBookings });
    } catch (error) {
      console.error("Get business weekly availability error:", error);
      res.status(500).json({ error: "Failed to get weekly availability" });
    }
  });

  // Set weekly availability for a business
  app.put("/api/businesses/me/weekly-availability", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const { slots, staffMemberId, autoAcceptBookings } = req.body;

      if (!Array.isArray(slots)) {
        return res.status(400).json({ error: "slots must be an array" });
      }

      const updated = await storage.setWeeklyAvailability(
        'business',
        business.id,
        slots,
        staffMemberId
      );

      // CRITICAL: Sync weekly_availability -> hoursOfOperation so legacy read paths work
      // Only sync if not staff-specific (staff has separate availability)
      if (!staffMemberId) {
        await syncWeeklyAvailabilityToHoursOfOperation('business', business.id);
        console.log("[AVAILABILITY_DEBUG] Synced business to hoursOfOperation");
      }

      if (typeof autoAcceptBookings === 'boolean') {
        await storage.updateBusiness(business.id, { autoAcceptBookings });
      }

      res.json({ availability: updated });
    } catch (error) {
      console.error("Set business weekly availability error:", error);
      res.status(500).json({ error: "Failed to set weekly availability" });
    }
  });

  // Get weekly availability for a photographer
  app.get("/api/photographers/me/weekly-availability", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const availability = await storage.getWeeklyAvailability(
        'photographer',
        photographer.id
      );

      res.json({ availability, autoAcceptBookings: photographer.autoAcceptBookings });
    } catch (error) {
      console.error("Get photographer weekly availability error:", error);
      res.status(500).json({ error: "Failed to get weekly availability" });
    }
  });

  // Set weekly availability for a photographer
  app.put("/api/photographers/me/weekly-availability", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const { slots, autoAcceptBookings } = req.body;

      // DEBUG: Log incoming data
      console.log("[AVAILABILITY_DEBUG] PUT /api/photographers/me/weekly-availability");
      console.log("[AVAILABILITY_DEBUG] userId:", userId);
      console.log("[AVAILABILITY_DEBUG] photographer.id:", photographer.id);
      console.log("[AVAILABILITY_DEBUG] photographer.userId:", photographer.userId);
      console.log("[AVAILABILITY_DEBUG] slots received:", JSON.stringify(slots, null, 2));
      console.log("[AVAILABILITY_DEBUG] slots count:", Array.isArray(slots) ? slots.length : "not an array");

      if (!Array.isArray(slots)) {
        return res.status(400).json({ error: "slots must be an array" });
      }

      const updated = await storage.setWeeklyAvailability(
        'photographer',
        photographer.id,
        slots
      );

      console.log("[AVAILABILITY_DEBUG] Saved with providerType=photographer, providerId=", photographer.id);
      console.log("[AVAILABILITY_DEBUG] Rows saved:", updated.length);

      // CRITICAL: Sync weekly_availability -> hoursOfOperation so legacy read paths work
      // This ensures profile banner, booking calendar, and availability tab all see the data
      await syncWeeklyAvailabilityToHoursOfOperation('photographer', photographer.id);
      console.log("[AVAILABILITY_DEBUG] Synced to hoursOfOperation");

      if (typeof autoAcceptBookings === 'boolean') {
        await storage.updatePhotographer(photographer.id, { autoAcceptBookings });
      }

      res.json({ availability: updated });
    } catch (error) {
      console.error("Set photographer weekly availability error:", error);
      res.status(500).json({ error: "Failed to set weekly availability" });
    }
  });

  // =========================
  // PROVIDER BLOCKS (Time-off, vacations, etc.)
  // =========================

  // Get blocks for a business
  app.get("/api/businesses/me/blocks", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const { startDate, endDate, staffMemberId } = req.query;
      
      const start = startDate ? new Date(startDate as string) : new Date();
      const end = endDate ? new Date(endDate as string) : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days ahead

      const blocks = await storage.getProviderBlocks(
        'business',
        business.id,
        start,
        end,
        staffMemberId as string | undefined
      );

      res.json({ blocks });
    } catch (error) {
      console.error("Get business blocks error:", error);
      res.status(500).json({ error: "Failed to get blocks" });
    }
  });

  // Create a block for a business
  app.post("/api/businesses/me/blocks", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const { startAt, endAt, blockType, reason, title, staffMemberId } = req.body;

      if (!startAt || !endAt) {
        return res.status(400).json({ error: "startAt and endAt are required" });
      }

      const block = await storage.createProviderBlock({
        providerType: 'business',
        providerId: business.id,
        staffMemberId: staffMemberId || null,
        startAt: new Date(startAt),
        endAt: new Date(endAt),
        blockType: blockType || 'custom',
        reason,
        title,
      });

      res.status(201).json({ block });
    } catch (error) {
      console.error("Create business block error:", error);
      res.status(500).json({ error: "Failed to create block" });
    }
  });

  // Update a block for a business
  app.patch("/api/businesses/me/blocks/:blockId", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const { blockId } = req.params;
      const { startAt, endAt, blockType, reason, title } = req.body;

      const updates: Record<string, any> = {};
      if (startAt) updates.startAt = new Date(startAt);
      if (endAt) updates.endAt = new Date(endAt);
      if (blockType) updates.blockType = blockType;
      if (reason !== undefined) updates.reason = reason;
      if (title !== undefined) updates.title = title;

      const block = await storage.updateProviderBlock(blockId, updates);
      if (!block) {
        return res.status(404).json({ error: "Block not found" });
      }

      res.json({ block });
    } catch (error) {
      console.error("Update business block error:", error);
      res.status(500).json({ error: "Failed to update block" });
    }
  });

  // Delete a block for a business
  app.delete("/api/businesses/me/blocks/:blockId", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const { blockId } = req.params;
      await storage.deleteProviderBlock(blockId);

      res.json({ success: true });
    } catch (error) {
      console.error("Delete business block error:", error);
      res.status(500).json({ error: "Failed to delete block" });
    }
  });

  // Get blocks for a photographer
  app.get("/api/photographers/me/blocks", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const { startDate, endDate } = req.query;
      
      const start = startDate ? new Date(startDate as string) : new Date();
      const end = endDate ? new Date(endDate as string) : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

      const blocks = await storage.getProviderBlocks(
        'photographer',
        photographer.id,
        start,
        end
      );

      res.json({ blocks });
    } catch (error) {
      console.error("Get photographer blocks error:", error);
      res.status(500).json({ error: "Failed to get blocks" });
    }
  });

  // Create a block for a photographer
  app.post("/api/photographers/me/blocks", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const { startAt, endAt, blockType, reason, title } = req.body;

      if (!startAt || !endAt) {
        return res.status(400).json({ error: "startAt and endAt are required" });
      }

      const block = await storage.createProviderBlock({
        providerType: 'photographer',
        providerId: photographer.id,
        startAt: new Date(startAt),
        endAt: new Date(endAt),
        blockType: blockType || 'custom',
        reason,
        title,
      });

      res.status(201).json({ block });
    } catch (error) {
      console.error("Create photographer block error:", error);
      res.status(500).json({ error: "Failed to create block" });
    }
  });

  // Update a block for a photographer
  app.patch("/api/photographers/me/blocks/:blockId", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const { blockId } = req.params;
      const { startAt, endAt, blockType, reason, title } = req.body;

      const updates: Record<string, any> = {};
      if (startAt) updates.startAt = new Date(startAt);
      if (endAt) updates.endAt = new Date(endAt);
      if (blockType) updates.blockType = blockType;
      if (reason !== undefined) updates.reason = reason;
      if (title !== undefined) updates.title = title;

      const block = await storage.updateProviderBlock(blockId, updates);
      if (!block) {
        return res.status(404).json({ error: "Block not found" });
      }

      res.json({ block });
    } catch (error) {
      console.error("Update photographer block error:", error);
      res.status(500).json({ error: "Failed to update block" });
    }
  });

  // Delete a block for a photographer
  app.delete("/api/photographers/me/blocks/:blockId", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const { blockId } = req.params;
      await storage.deleteProviderBlock(blockId);

      res.json({ success: true });
    } catch (error) {
      console.error("Delete photographer block error:", error);
      res.status(500).json({ error: "Failed to delete block" });
    }
  });

  // =========================
  // PHOTOGRAPHER SERVICES CRUD
  // =========================

  // GET /api/photographers/me/services - List photographer's services (all statuses for owner dashboard)
  app.get("/api/photographers/me/services", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      // Return all services for owner (draft, live, archived)
      const services = await storage.getAllPhotographerServices(photographer.id);
      res.json({ services });
    } catch (error) {
      console.error("Get photographer services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  });

  // POST /api/photographers/me/services - Create photographer service (draft)
  app.post("/api/photographers/me/services", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const serviceSchema = z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        pricingModel: z.enum(['hourly', 'package']).optional(),
        hourlyRateCents: z.number().min(700, "Price must be at least $7.00").nullable().optional(),
        priceCents: z.number().min(700, "Price must be at least $7.00").nullable().optional(),
        packageHours: z.number().min(1).nullable().optional(),
        isContactForPricing: z.boolean().optional(),
        estimatedDurationMinutes: z.number().min(1).nullable().optional(),
        isActive: z.boolean().optional(),
      });

      const validated = serviceSchema.parse(req.body);
      
      // Create service in draft status
      const service = await storage.createPhotographerService({
        photographerId: photographer.id,
        name: validated.name,
        description: validated.description || null,
        category: validated.category || null,
        pricingModel: validated.pricingModel || 'package',
        hourlyRateCents: validated.hourlyRateCents || null,
        priceCents: validated.priceCents || null,
        packageHours: validated.packageHours || null,
        isContactForPricing: validated.isContactForPricing || false,
        estimatedDurationMinutes: validated.estimatedDurationMinutes || null,
        isActive: validated.isActive !== false,
        status: 'draft',
      });

      res.json({ service });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create photographer service error:", error);
      res.status(500).json({ error: "Failed to create service" });
    }
  });

  // PATCH /api/photographers/me/services/:id - Update photographer service
  app.patch("/api/photographers/me/services/:id", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const service = await storage.getPhotographerService(req.params.id);
      if (!service || service.photographerId !== photographer.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      const updateSchema = z.object({
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        pricingModel: z.enum(['hourly', 'package']).optional(),
        hourlyRateCents: z.number().min(700, "Price must be at least $7.00").nullable().optional(),
        priceCents: z.number().min(700, "Price must be at least $7.00").nullable().optional(),
        packageHours: z.number().min(1).nullable().optional(),
        isContactForPricing: z.boolean().optional(),
        estimatedDurationMinutes: z.number().min(1).nullable().optional(),
        isActive: z.boolean().optional(),
      });

      const validated = updateSchema.parse(req.body);
      
      // Handle price changes for live services with Stripe Connected account
      if (service.status === 'live' && service.stripeConnectedProductId && photographer.stripeAccountId) {
        // Update Stripe Product metadata if name/description changed
        if (validated.name || validated.description) {
          await stripeService.updateStripeProduct(service.stripeConnectedProductId, {
            name: validated.name || service.name,
            description: validated.description !== undefined ? (validated.description || undefined) : (service.description || undefined),
          }, photographer.stripeAccountId);
        }
        
        // If price changed and service is live, create new Stripe Price and deactivate old one
        const newPrice = validated.priceCents ?? validated.hourlyRateCents;
        const oldPrice = service.priceCents ?? service.hourlyRateCents;
        
        if (newPrice != null && newPrice !== oldPrice && service.stripeConnectedPriceId) {
          // Create new price on connected account
          const newStripePrice = await stripeService.createStripePrice({
            productId: service.stripeConnectedProductId!,
            unitAmountCents: newPrice,
            metadata: {
              photographerServiceId: service.id,
              photographerId: photographer.id,
              pricingModel: validated.pricingModel || service.pricingModel || 'package',
            },
            connectedAccountId: photographer.stripeAccountId,
          });
          
          // Deactivate old price - note: would need to add connectedAccountId support to deactivateStripePrice
          // For now, we just update the reference
          
          // Update with new price ID
          Object.assign(validated, { stripeConnectedPriceId: newStripePrice.id });
        }
      }

      const updatedService = await storage.updatePhotographerService(service.id, validated);
      res.json({ service: updatedService });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update photographer service error:", error);
      res.status(500).json({ error: "Failed to update service" });
    }
  });

  // POST /api/photographers/me/services/:id/go-live - Link service to Stripe Connect and publish
  app.post("/api/photographers/me/services/:id/go-live", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      // Self-healing sync: Check Stripe API for onboarding status if local says incomplete
      let isOnboardingComplete = photographer.stripeOnboardingComplete || false;
      if (!isOnboardingComplete && photographer.stripeAccountId) {
        isOnboardingComplete = await stripeService.syncOnboardingStatus({
          entityType: 'photographer',
          entityId: photographer.id,
          stripeAccountId: photographer.stripeAccountId,
          currentOnboardingComplete: false,
          updateFn: (id, data) => storage.updatePhotographer(id, data),
        });
      }

      // Check Stripe onboarding is complete before allowing Go Live
      if (!photographer.stripeAccountId || !isOnboardingComplete) {
        return res.status(403).json({ 
          error: "Payments not enabled",
          message: "You must complete Stripe payment setup before publishing services. Please complete your payment onboarding first.",
          requiresOnboarding: true,
        });
      }

      const service = await storage.getPhotographerService(req.params.id);
      if (!service || service.photographerId !== photographer.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      // Already live? Just return the service
      if (service.status === 'live' && service.stripeConnectedProductId && service.stripeConnectedPriceId) {
        return res.json({ service, message: "Service is already live" });
      }

      // Determine price to use
      const priceInCents = service.priceCents ?? service.hourlyRateCents ?? 0;
      
      if (priceInCents <= 0 && !service.isContactForPricing) {
        return res.status(400).json({ 
          error: "Price required",
          message: "Service must have a price set or be marked as 'Contact for Pricing' before going live.",
        });
      }

      // Create Stripe Product on Connected Account
      const stripeProduct = await stripeService.createStripeProduct({
        name: service.name,
        description: service.description || undefined,
        metadata: {
          type: 'photographer_service',
          itemId: service.id,
          photographerId: photographer.id,
        },
        connectedAccountId: photographer.stripeAccountId,
      });

      // Create Stripe Price on Connected Account (only if not contact-for-pricing)
      let stripePriceId: string | null = null;
      if (!service.isContactForPricing && priceInCents > 0) {
        const stripePrice = await stripeService.createStripePrice({
          productId: stripeProduct.id,
          unitAmountCents: priceInCents,
          metadata: {
            photographerServiceId: service.id,
            photographerId: photographer.id,
            pricingModel: service.pricingModel || 'package',
          },
          connectedAccountId: photographer.stripeAccountId,
        });
        stripePriceId = stripePrice.id;
      }

      // Update service with Stripe IDs and set status to live
      const updatedService = await storage.updatePhotographerService(service.id, {
        stripeConnectedProductId: stripeProduct.id,
        stripeConnectedPriceId: stripePriceId,
        status: 'live',
      });

      res.json({ 
        service: updatedService,
        message: "Service is now live and available for booking",
      });
    } catch (error) {
      console.error("Go live photographer service error:", error);
      res.status(500).json({ error: "Failed to publish service" });
    }
  });

  // POST /api/photographers/me/services/:id/archive - Archive service
  app.post("/api/photographers/me/services/:id/archive", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const service = await storage.getPhotographerService(req.params.id);
      if (!service || service.photographerId !== photographer.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      // If service has Stripe products on connected account, archive them
      if (service.stripeConnectedProductId && photographer.stripeAccountId) {
        try {
          await stripeService.updateStripeProduct(
            service.stripeConnectedProductId, 
            { active: false },
            photographer.stripeAccountId
          );
        } catch (stripeError) {
          console.error("Failed to archive Stripe product:", stripeError);
          // Continue with local archive even if Stripe fails
        }
      }

      // Only update status to archived, keep isActive true so it shows in owner dashboard
      const updatedService = await storage.updatePhotographerService(service.id, {
        status: 'archived',
      });

      res.json({ 
        service: updatedService,
        message: "Service has been archived",
      });
    } catch (error) {
      console.error("Archive photographer service error:", error);
      res.status(500).json({ error: "Failed to archive service" });
    }
  });

  // DELETE /api/photographers/me/services/:id - Delete (soft-delete) service
  app.delete("/api/photographers/me/services/:id", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const photographer = await storage.getPhotographerByUserId(userId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer profile not found" });
      }

      const service = await storage.getPhotographerService(req.params.id);
      if (!service || service.photographerId !== photographer.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      // Soft delete by marking inactive
      await storage.deletePhotographerService(service.id);

      res.json({ success: true, message: "Service deleted" });
    } catch (error) {
      console.error("Delete photographer service error:", error);
      res.status(500).json({ error: "Failed to delete service" });
    }
  });

  // =========================
  // PROVIDER ACCEPT/DECLINE BOOKINGS
  // =========================

  // Accept an appointment (for providers with manual acceptance)
  app.post("/api/bookings/appointments/:appointmentId/accept", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { appointmentId } = req.params;
      const appointment = await storage.getAppointment(appointmentId);
      
      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      // Check if user is the business owner
      const business = await storage.getBusiness(appointment.businessId);
      if (!business || business.ownerId !== userId) {
        return res.status(403).json({ error: "Not authorized to accept this booking" });
      }

      if (appointment.status !== BOOKING_STATES.PENDING_PROVIDER) {
        return res.status(400).json({ 
          error: "Booking is not pending provider approval",
          currentStatus: appointment.status 
        });
      }

      // Capture the PaymentIntent if using manual capture
      if (appointment.captureMethod === 'manual' && appointment.stripePaymentIntentId) {
        try {
          console.log(`[Booking] Capturing PaymentIntent ${appointment.stripePaymentIntentId} for appointment ${appointmentId}`);
          await stripeService.capturePaymentIntent(appointment.stripePaymentIntentId);
          console.log(`[Booking] PaymentIntent captured successfully`);
        } catch (stripeError: any) {
          console.error(`[Booking] Failed to capture PaymentIntent:`, stripeError);
          return res.status(400).json({ 
            error: "Failed to capture payment", 
            details: stripeError.message 
          });
        }
      }

      const result = await transitionAppointmentState(appointmentId, BOOKING_STATES.CONFIRMED, {
        triggeredBy: userId,
        triggerSource: 'api',
        metadata: { action: 'provider_accept' }
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      const updatedAppointment = await storage.getAppointment(appointmentId);
      res.json({ success: true, appointment: updatedAppointment });
    } catch (error) {
      console.error("Accept appointment error:", error);
      res.status(500).json({ error: "Failed to accept booking" });
    }
  });

  // Decline an appointment (for providers with manual acceptance)
  app.post("/api/bookings/appointments/:appointmentId/decline", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { appointmentId } = req.params;
      const { reason } = req.body;
      const appointment = await storage.getAppointment(appointmentId);
      
      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      // Check if user is the business owner
      const business = await storage.getBusiness(appointment.businessId);
      if (!business || business.ownerId !== userId) {
        return res.status(403).json({ error: "Not authorized to decline this booking" });
      }

      if (appointment.status !== BOOKING_STATES.PENDING_PROVIDER) {
        return res.status(400).json({ 
          error: "Booking is not pending provider approval",
          currentStatus: appointment.status 
        });
      }

      // Cancel/void the PaymentIntent if using manual capture
      if (appointment.captureMethod === 'manual' && appointment.stripePaymentIntentId) {
        try {
          console.log(`[Booking] Canceling PaymentIntent ${appointment.stripePaymentIntentId} for declined appointment ${appointmentId}`);
          await stripeService.cancelPaymentIntent(appointment.stripePaymentIntentId, 'requested_by_customer');
          console.log(`[Booking] PaymentIntent canceled successfully`);
        } catch (stripeError: any) {
          console.error(`[Booking] Failed to cancel PaymentIntent:`, stripeError);
          // Continue with decline even if Stripe cancel fails - log for manual resolution
        }
      }

      const result = await transitionAppointmentState(appointmentId, BOOKING_STATES.DECLINED, {
        triggeredBy: userId,
        triggerSource: 'api',
        metadata: { action: 'provider_decline', reason }
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      const updatedAppointment = await storage.getAppointment(appointmentId);
      res.json({ success: true, appointment: updatedAppointment });
    } catch (error) {
      console.error("Decline appointment error:", error);
      res.status(500).json({ error: "Failed to decline booking" });
    }
  });

  // Accept a photographer shoot booking
  app.post("/api/bookings/photographer/:bookingId/accept", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { bookingId } = req.params;
      const booking = await storage.getShootBooking(bookingId);
      
      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Check if user is the photographer owner
      const photographer = await storage.getPhotographer(booking.photographerId);
      if (!photographer || photographer.userId !== userId) {
        return res.status(403).json({ error: "Not authorized to accept this booking" });
      }

      if (booking.status !== BOOKING_STATES.PENDING_PROVIDER) {
        return res.status(400).json({ 
          error: "Booking is not pending provider approval",
          currentStatus: booking.status 
        });
      }

      // Capture the PaymentIntent if using manual capture
      if (booking.captureMethod === 'manual' && booking.stripePaymentIntentId) {
        try {
          console.log(`[Booking] Capturing PaymentIntent ${booking.stripePaymentIntentId} for shoot booking ${bookingId}`);
          await stripeService.capturePaymentIntent(booking.stripePaymentIntentId);
          console.log(`[Booking] PaymentIntent captured successfully`);
        } catch (stripeError: any) {
          console.error(`[Booking] Failed to capture PaymentIntent:`, stripeError);
          return res.status(400).json({ 
            error: "Failed to capture payment", 
            details: stripeError.message 
          });
        }
      }

      const result = await transitionShootBookingState(bookingId, BOOKING_STATES.CONFIRMED, {
        triggeredBy: userId,
        triggerSource: 'api',
        metadata: { action: 'provider_accept' }
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      const updatedBooking = await storage.getShootBooking(bookingId);
      res.json({ success: true, booking: updatedBooking });
    } catch (error) {
      console.error("Accept photographer booking error:", error);
      res.status(500).json({ error: "Failed to accept booking" });
    }
  });

  // Decline a photographer shoot booking
  app.post("/api/bookings/photographer/:bookingId/decline", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { bookingId } = req.params;
      const { reason } = req.body;
      const booking = await storage.getShootBooking(bookingId);
      
      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Check if user is the photographer owner
      const photographer = await storage.getPhotographer(booking.photographerId);
      if (!photographer || photographer.userId !== userId) {
        return res.status(403).json({ error: "Not authorized to decline this booking" });
      }

      if (booking.status !== BOOKING_STATES.PENDING_PROVIDER) {
        return res.status(400).json({ 
          error: "Booking is not pending provider approval",
          currentStatus: booking.status 
        });
      }

      // Cancel/void the PaymentIntent if using manual capture
      if (booking.captureMethod === 'manual' && booking.stripePaymentIntentId) {
        try {
          console.log(`[Booking] Canceling PaymentIntent ${booking.stripePaymentIntentId} for declined shoot booking ${bookingId}`);
          await stripeService.cancelPaymentIntent(booking.stripePaymentIntentId, 'requested_by_customer');
          console.log(`[Booking] PaymentIntent canceled successfully`);
        } catch (stripeError: any) {
          console.error(`[Booking] Failed to cancel PaymentIntent:`, stripeError);
          // Continue with decline even if Stripe cancel fails
        }
      }

      const result = await transitionShootBookingState(bookingId, BOOKING_STATES.DECLINED, {
        triggeredBy: userId,
        triggerSource: 'api',
        metadata: { action: 'provider_decline', reason }
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      const updatedBooking = await storage.getShootBooking(bookingId);
      res.json({ success: true, booking: updatedBooking });
    } catch (error) {
      console.error("Decline photographer booking error:", error);
      res.status(500).json({ error: "Failed to decline booking" });
    }
  });

  // =========================
  // PAYMENT INTENT CREATION FOR BOOKINGS
  // =========================

  /**
   * Create PaymentIntent for an appointment booking
   * For mobile apps using PaymentSheet (instead of Checkout Sessions)
   * 
   * Request: { appointmentId: string }
   * Response: { clientSecret: string, paymentIntentId: string, captureMethod: string }
   */
  app.post("/api/bookings/appointments/:appointmentId/create-payment-intent", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { appointmentId } = req.params;
      const appointment = await storage.getAppointment(appointmentId);
      
      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      // Only the client who created the booking can pay for it
      if (appointment.clientId !== userId) {
        return res.status(403).json({ error: "Not authorized to pay for this booking" });
      }

      // Must be in draft or pending_payment state
      if (appointment.status !== BOOKING_STATES.DRAFT && appointment.status !== BOOKING_STATES.PENDING_PAYMENT) {
        return res.status(400).json({ 
          error: "Booking is not in a payable state",
          currentStatus: appointment.status 
        });
      }

      // ========================================
      // PAYMENTS PAUSED MODE (for Expo Go dev)
      // ========================================
      // When payments are disabled, skip Stripe calls but do NOT modify booking state.
      // Booking remains in current state (DRAFT/PENDING_PAYMENT) - frontend handles navigation.
      if (!PAYMENTS_ENABLED) {
        console.log(`[Booking] PAYMENTS_ENABLED=false - Skipping Stripe for appointment ${appointmentId}`);
        console.log(`[Booking] Booking ${appointmentId} remains in status: ${appointment.status}`);
        
        return res.json({
          paymentStatus: "paused",
          mode: "development",
          message: "Payments temporarily disabled for UI development"
        });
      }

      // Idempotency: If PaymentIntent already exists and is valid, return it
      if (appointment.stripePaymentIntentId) {
        try {
          const existingPI = await stripeService.getPaymentIntent(appointment.stripePaymentIntentId);
          // If the existing PaymentIntent is usable (requires_payment_method, requires_confirmation, requires_action)
          if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existingPI.status)) {
            console.log(`[Booking] Reusing existing PaymentIntent ${existingPI.id} for appointment ${appointmentId}`);
            return res.json({
              clientSecret: existingPI.client_secret,
              paymentIntentId: existingPI.id,
              captureMethod: existingPI.capture_method,
              amount: existingPI.amount,
              currency: existingPI.currency,
            });
          }
          // If canceled or failed, we'll create a new one
        } catch (piError) {
          console.log(`[Booking] Existing PaymentIntent ${appointment.stripePaymentIntentId} not found or invalid, creating new one`);
        }
      }

      // Get business to check autoAcceptBookings and get Stripe account
      const business = await storage.getBusiness(appointment.businessId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      if (!business.stripeAccountId) {
        return res.status(400).json({ error: "Business has not completed Stripe onboarding" });
      }

      // Determine capture method based on autoAcceptBookings
      const captureMethod = business.autoAcceptBookings === false ? 'manual' : 'automatic';
      
      // Calculate booking fees: 2% vendor fee + 8% consumer upcharge
      const basePriceCents = appointment.totalPrice;
      const vendorPayoutCents = Math.round(basePriceCents * (1 - 0.02));
      const consumerUpchargeCents = Math.round(basePriceCents * 0.08);
      const totalChargedToConsumerCents = basePriceCents + consumerUpchargeCents;
      const platformFeeCents = totalChargedToConsumerCents - vendorPayoutCents;
      const outsydePointsEarned = Math.round((consumerUpchargeCents / 100) * 100);

      // Get or create Stripe customer for the user
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Ensure Stripe Customer exists for card vaulting
      const stripeCustomerId = await stripeService.getOrCreateStripeCustomer({
        userId,
        email: user.email,
        name: user.name || undefined,
        existingStripeCustomerId: user.stripeCustomerId,
      });
      if (!user.stripeCustomerId || user.stripeCustomerId !== stripeCustomerId) {
        await storage.updateUser(userId, { stripeCustomerId });
      }

      // Create PaymentIntent with explicit vendor payout via transfer_data.amount
      const paymentIntent = await stripeService.createBookingPaymentIntent({
        totalChargedCents: totalChargedToConsumerCents,
        vendorPayoutCents,
        customerId: stripeCustomerId,
        connectedAccountId: business.stripeAccountId,
        captureMethod,
        saveForFutureUse: true,
        metadata: {
          type: 'appointment_booking',
          bookingId: appointmentId,
          clientId: userId,
          providerId: appointment.businessId,
          serviceId: appointment.serviceId,
          basePriceCents: String(basePriceCents),
          vendorPayoutCents: String(vendorPayoutCents),
          consumerUpchargeCents: String(consumerUpchargeCents),
          platformFeeCents: String(platformFeeCents),
          outsydePointsEarned: String(outsydePointsEarned),
        },
        description: `Appointment booking at ${business.name}`,
      });

      // Update appointment with payment details
      await db.update(appointments).set({
        stripePaymentIntentId: paymentIntent.id,
        paymentMethod: 'payment_intent',
        captureMethod,
        platformFee: platformFeeCents,
        vendorNet: vendorPayoutCents,
        status: BOOKING_STATES.PENDING_PAYMENT,
        updatedAt: new Date()
      }).where(eq(appointments.id, appointmentId));

      console.log(`[Booking] Created PaymentIntent ${paymentIntent.id} for appointment ${appointmentId} (captureMethod: ${captureMethod}, charged: ${totalChargedToConsumerCents}¢, vendor: ${vendorPayoutCents}¢, platform: ${platformFeeCents}¢)`);

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        feeBreakdown: {
          basePriceCents,
          consumerUpchargeCents,
          vendorPayoutCents,
          platformFeeCents,
          totalChargedToConsumerCents,
          outsydePointsEarned,
        },
      });
    } catch (error: any) {
      console.error("Create appointment PaymentIntent error:", error);
      res.status(500).json({ error: "Failed to create payment intent", details: error.message });
    }
  });

  /**
   * Create PaymentIntent for a photographer shoot booking
   * For mobile apps using PaymentSheet (instead of Checkout Sessions)
   * 
   * Request: { bookingId: string }
   * Response: { clientSecret: string, paymentIntentId: string, captureMethod: string }
   */
  app.post("/api/bookings/photographer/:bookingId/create-payment-intent", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { bookingId } = req.params;
      const booking = await storage.getShootBooking(bookingId);
      
      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Only the client who created the booking can pay for it
      if (booking.clientId !== userId) {
        return res.status(403).json({ error: "Not authorized to pay for this booking" });
      }

      // Must be in draft or pending_payment state
      if (booking.status !== BOOKING_STATES.DRAFT && booking.status !== BOOKING_STATES.PENDING_PAYMENT) {
        return res.status(400).json({ 
          error: "Booking is not in a payable state",
          currentStatus: booking.status 
        });
      }

      // ========================================
      // PAYMENTS PAUSED MODE (for Expo Go dev)
      // ========================================
      // When payments are disabled, skip Stripe calls but do NOT modify booking state.
      // Booking remains in current state (DRAFT/PENDING_PAYMENT) - frontend handles navigation.
      if (!PAYMENTS_ENABLED) {
        console.log(`[Booking] PAYMENTS_ENABLED=false - Skipping Stripe for shoot booking ${bookingId}`);
        console.log(`[Booking] Booking ${bookingId} remains in status: ${booking.status}`);
        
        return res.json({
          paymentStatus: "paused",
          mode: "development",
          message: "Payments temporarily disabled for UI development"
        });
      }

      // Idempotency: If PaymentIntent already exists and is valid, return it
      if (booking.stripePaymentIntentId) {
        try {
          const existingPI = await stripeService.getPaymentIntent(booking.stripePaymentIntentId);
          if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existingPI.status)) {
            console.log(`[Booking] Reusing existing PaymentIntent ${existingPI.id} for shoot booking ${bookingId}`);
            return res.json({
              clientSecret: existingPI.client_secret,
              paymentIntentId: existingPI.id,
              captureMethod: existingPI.capture_method,
              amount: existingPI.amount,
              currency: existingPI.currency,
            });
          }
        } catch (piError) {
          console.log(`[Booking] Existing PaymentIntent ${booking.stripePaymentIntentId} not found or invalid, creating new one`);
        }
      }

      // Get photographer to check autoAcceptBookings and get Stripe account
      const photographer = await storage.getPhotographer(booking.photographerId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer not found" });
      }

      if (!photographer.stripeAccountId) {
        return res.status(400).json({ error: "Photographer has not completed Stripe onboarding" });
      }

      // Determine capture method based on autoAcceptBookings
      const captureMethod = photographer.autoAcceptBookings === false ? 'manual' : 'automatic';
      
      // Calculate booking fees: 2% vendor fee + 8% consumer upcharge
      const basePriceCents = booking.totalPrice;
      const vendorPayoutCents = Math.round(basePriceCents * (1 - 0.02));
      const consumerUpchargeCents = Math.round(basePriceCents * 0.08);
      const totalChargedToConsumerCents = basePriceCents + consumerUpchargeCents;
      const platformFeeCents = totalChargedToConsumerCents - vendorPayoutCents;
      const outsydePointsEarned = Math.round((consumerUpchargeCents / 100) * 100);

      // Get user for Stripe customer
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Ensure Stripe Customer exists for card vaulting
      const stripeCustomerId = await stripeService.getOrCreateStripeCustomer({
        userId,
        email: user.email,
        name: user.name || undefined,
        existingStripeCustomerId: user.stripeCustomerId,
      });
      if (!user.stripeCustomerId || user.stripeCustomerId !== stripeCustomerId) {
        await storage.updateUser(userId, { stripeCustomerId });
      }

      // Create PaymentIntent on platform balance — no transfer_data, matching the
      // business/staff booking pattern (createPlatformPaymentIntent). After
      // payment_intent.succeeded fires, the webhook handler transfers
      // vendorPayoutCents to the photographer's connected account via
      // stripeService.transferShootBookingPayout(). vendorPayoutCents is stored
      // in PI metadata so the webhook uses the exact figure computed here.
      //
      // NOTE: fee rates here (7% vendor deduction / 5% consumer upcharge) differ
      // from the business/staff schedule in fees.ts (12% booking fee / 3% consumer
      // fee). Centralising all fee schedules into fees.ts is tracked separately —
      // do not change these rates here.
      const paymentIntent = await stripeService.createPlatformPaymentIntent({
        amountCents: totalChargedToConsumerCents,
        customerId: stripeCustomerId,
        captureMethod,
        saveForFutureUse: true,
        metadata: {
          type: 'shoot_booking',
          bookingId: bookingId,
          clientId: userId,
          providerId: booking.photographerId,
          serviceId: booking.serviceId || '',
          basePriceCents: String(basePriceCents),
          vendorPayoutCents: String(vendorPayoutCents),
          consumerUpchargeCents: String(consumerUpchargeCents),
          platformFeeCents: String(platformFeeCents),
          outsydePointsEarned: String(outsydePointsEarned),
        },
        description: `Photography shoot booking with ${photographer.displayName}`,
      });

      // Update booking with payment details
      await db.update(shootBookings).set({
        stripePaymentIntentId: paymentIntent.id,
        paymentMethod: 'payment_intent',
        captureMethod,
        platformFee: platformFeeCents,
        vendorNet: vendorPayoutCents,
        status: BOOKING_STATES.PENDING_PAYMENT,
        updatedAt: new Date()
      }).where(eq(shootBookings.id, bookingId));

      console.log(`[Booking] Created PaymentIntent ${paymentIntent.id} for shoot booking ${bookingId} (captureMethod: ${captureMethod}, charged: ${totalChargedToConsumerCents}¢, vendor: ${vendorPayoutCents}¢, platform: ${platformFeeCents}¢)`);

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        feeBreakdown: {
          basePriceCents,
          consumerUpchargeCents,
          vendorPayoutCents,
          platformFeeCents,
          totalChargedToConsumerCents,
          outsydePointsEarned,
        },
      });
    } catch (error: any) {
      console.error("Create shoot booking PaymentIntent error:", error);
      res.status(500).json({ error: "Failed to create payment intent", details: error.message });
    }
  });

  // =========================
  // PRODUCT CART PAYMENT INTENT
  // =========================

  app.post("/api/cart/payment-intent", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Not authenticated' } });
    }

    try {
      const { items, shippingAddress } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Items array is required and must not be empty' } });
      }

      // Collect unique vendor IDs (keyed on vendorId, not client-supplied Stripe account)
      const vendorIds = new Set(items.map((i: { vendorId: string }) => i.vendorId));

      // Validate item fields
      for (const item of items) {
        if (!item.priceCents || typeof item.priceCents !== 'number' || item.priceCents <= 0 || !Number.isInteger(item.priceCents)) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'All items must have a positive integer priceCents' } });
        }
        if (!item.quantity || typeof item.quantity !== 'number' || item.quantity <= 0) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'All items must have a positive quantity' } });
        }
      }

      if (vendorIds.size === 1) {
        // ── SINGLE-VENDOR PATH (unchanged) ──────────────────────────────────

        const businessId = items[0].vendorId || '';
        if (!businessId) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'vendorId is required' } });
        }

        // Look up the vendor's Stripe Connect account server-side — the client never
        // needs to supply this, and we must not trust a client-supplied value.
        const business = await storage.getBusiness(businessId);
        if (!business) {
          return res.status(404).json({ success: false, error: { code: 'BUSINESS_NOT_FOUND', message: 'Business not found' } });
        }
        if (!business.stripeAccountId) {
          return res.status(400).json({ success: false, error: { code: 'STRIPE_NOT_ONBOARDED', message: 'Business has not completed Stripe onboarding' } });
        }

        // Calculate product fees using the canonical fee engine (same as POST /api/cart/checkout)
        const basePriceCents = items.reduce((sum: number, i: { priceCents: number; quantity: number }) => sum + (i.priceCents * i.quantity), 0);
        const { getActiveAttribution } = await import('./influencerTrackingService');
        const attribution = await getActiveAttribution(userId);
        const isInfluencerAttributed = !!attribution;
        const { calculateProductFees } = await import('./fees');
        const feeBreakdown = calculateProductFees(basePriceCents, { influencerAttributed: isInfluencerAttributed });

        const totalChargedToConsumerCents = feeBreakdown.customerTotalBeforeTaxCents;
        // Points = 1 per cent of consumer service fee (100 points per dollar of fee)
        const outsydePointsEarned = feeBreakdown.consumerServiceFeeCents;

        // Create the order row BEFORE touching Stripe so a record always exists
        const order = await storage.createOrder({
          customerId: userId,
          businessId,
          totalAmount: basePriceCents,
          platformFee: feeBreakdown.platformFeeCents,
          vendorNet: feeBreakdown.vendorNetCents,
          consumerServiceFee: feeBreakdown.consumerServiceFeeCents,
          influencerCommission: feeBreakdown.influencerCommissionCents,
          grossChargeAmount: feeBreakdown.customerTotalBeforeTaxCents,
          outsydeGrossRevenue: feeBreakdown.outsydeGrossRevenueCents,
          attributedInfluencerId: attribution?.influencerId || null,
          influencerCodeUsed: attribution?.refCode || null,
          commissionStatus: isInfluencerAttributed ? 'pending' : null,
          influencerTransferStatus: isInfluencerAttributed ? 'pending' : null,
          feeModelVersion: feeBreakdown.feeModelVersion,
          status: 'pending',
          shippingAddress: shippingAddress ? JSON.stringify(shippingAddress) : null,
          items: items.map((i: { productId: string; name: string; quantity: number; priceCents: number }) => ({
            productId: i.productId,
            name: i.name,
            quantity: i.quantity,
            price: i.priceCents,
          })),
        });

        // Ensure Stripe Customer exists for card vaulting
        const cartUser = await storage.getUser(userId);
        if (!cartUser) {
          return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
        }
        const stripeCustomerId = await stripeService.getOrCreateStripeCustomer({
          userId,
          email: cartUser.email,
          name: cartUser.name || undefined,
          existingStripeCustomerId: cartUser.stripeCustomerId,
        });
        if (!cartUser.stripeCustomerId || cartUser.stripeCustomerId !== stripeCustomerId) {
          await storage.updateUser(userId, { stripeCustomerId });
        }

        const paymentIntent = await stripeService.createBookingPaymentIntent({
          totalChargedCents: totalChargedToConsumerCents,
          vendorPayoutCents: feeBreakdown.vendorNetCents,
          customerId: stripeCustomerId,
          connectedAccountId: business.stripeAccountId,
          captureMethod: 'automatic',
          saveForFutureUse: true,
          metadata: {
            type: 'product_purchase',
            orderId: order.id,
            userId,
            businessId,
            basePriceCents: String(basePriceCents),
            consumerUpchargeCents: String(feeBreakdown.consumerServiceFeeCents),
            vendorPayoutCents: String(feeBreakdown.vendorNetCents),
            platformFeeCents: String(feeBreakdown.platformFeeCents),
            outsydePointsEarned: String(outsydePointsEarned),
            itemCount: String(items.length),
            itemSummary: items.map((i: { name: string; quantity: number }) => `${i.name} x${i.quantity}`).join(', ').substring(0, 490),
          },
          description: 'Product purchase via Outsyde',
        });

        // Record the Stripe PaymentIntent ID against the order row
        await storage.updateOrder(order.id, { stripePaymentIntentId: paymentIntent.id });

        console.log(`[Cart] Created PaymentIntent ${paymentIntent.id} for product purchase, order ${order.id} (charged: ${totalChargedToConsumerCents}¢, vendor: ${feeBreakdown.vendorNetCents}¢, platform: ${feeBreakdown.platformFeeCents}¢)`);

        res.json({
          success: true,
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
          orderId: order.id,
          feeBreakdown: {
            basePriceCents,
            consumerUpchargeCents: feeBreakdown.consumerServiceFeeCents,
            vendorPayoutCents: feeBreakdown.vendorNetCents,
            platformFeeCents: feeBreakdown.platformFeeCents,
            totalChargedToConsumerCents,
            outsydePointsEarned,
          },
        });

      } else {
        // ── MULTI-VENDOR PATH ───────────────────────────────────────────────
        // One charge to the consumer covering all vendors; the webhook fires
        // individual transfers to each vendor's connected account after success.

        const { getActiveAttribution } = await import('./influencerTrackingService');
        const attribution = await getActiveAttribution(userId);
        const isInfluencerAttributed = !!attribution;
        const { calculateProductFees } = await import('./fees');

        // Create the order group row first so every per-vendor order can reference it
        const orderGroup = await storage.createOrderGroup({
          customerId: userId,
          totalVendors: vendorIds.size,
          completedVendors: 0,
          status: 'pending',
        });

        const vendorOrders: Array<{ orderId: string; businessId: string; vendorNetCents: number }> = [];
        let fullConsumerTotalCents = 0;

        for (const vendorId of vendorIds) {
          const vendorItems = items.filter((i: { vendorId: string }) => i.vendorId === vendorId);
          const vendorBaseCents = vendorItems.reduce((sum: number, i: { priceCents: number; quantity: number }) => sum + (i.priceCents * i.quantity), 0);
          const feeBreakdown = calculateProductFees(vendorBaseCents, { influencerAttributed: isInfluencerAttributed });

          const order = await storage.createOrder({
            customerId: userId,
            businessId: vendorId,
            orderGroupId: orderGroup.id,
            totalAmount: vendorBaseCents,
            platformFee: feeBreakdown.platformFeeCents,
            vendorNet: feeBreakdown.vendorNetCents,
            consumerServiceFee: feeBreakdown.consumerServiceFeeCents,
            influencerCommission: feeBreakdown.influencerCommissionCents,
            grossChargeAmount: feeBreakdown.customerTotalBeforeTaxCents,
            outsydeGrossRevenue: feeBreakdown.outsydeGrossRevenueCents,
            attributedInfluencerId: attribution?.influencerId || null,
            influencerCodeUsed: attribution?.refCode || null,
            commissionStatus: isInfluencerAttributed ? 'pending' : null,
            influencerTransferStatus: isInfluencerAttributed ? 'pending' : null,
            feeModelVersion: feeBreakdown.feeModelVersion,
            status: 'pending',
            shippingAddress: shippingAddress ? JSON.stringify(shippingAddress) : null,
            items: vendorItems.map((i: { productId: string; name: string; quantity: number; priceCents: number }) => ({
              productId: i.productId,
              name: i.name,
              quantity: i.quantity,
              price: i.priceCents,
            })),
          });

          vendorOrders.push({ orderId: order.id, businessId: vendorId, vendorNetCents: feeBreakdown.vendorNetCents });
          fullConsumerTotalCents += feeBreakdown.customerTotalBeforeTaxCents;
        }

        // Ensure Stripe Customer exists for card vaulting
        const cartUser = await storage.getUser(userId);
        if (!cartUser) {
          return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
        }
        const stripeCustomerId = await stripeService.getOrCreateStripeCustomer({
          userId,
          email: cartUser.email,
          name: cartUser.name || undefined,
          existingStripeCustomerId: cartUser.stripeCustomerId,
        });
        if (!cartUser.stripeCustomerId || cartUser.stripeCustomerId !== stripeCustomerId) {
          await storage.updateUser(userId, { stripeCustomerId });
        }

        const paymentIntent = await stripeService.createPlatformPaymentIntent({
          amountCents: fullConsumerTotalCents,
          customerId: stripeCustomerId,
          captureMethod: 'automatic',
          saveForFutureUse: true,
          metadata: {
            type: 'multi_vendor_product_purchase',
            orderGroupId: orderGroup.id,
            userId,
            vendorOrders: JSON.stringify(vendorOrders).slice(0, 490),
          },
          description: 'Multi-vendor product purchase via Outsyde',
        });

        console.log(`[Cart] Created multi-vendor PaymentIntent ${paymentIntent.id} for order group ${orderGroup.id} (${vendorIds.size} vendors, charged: ${fullConsumerTotalCents}¢)`);

        res.json({
          success: true,
          clientSecret: paymentIntent.client_secret,
          orderGroupId: orderGroup.id,
          feeBreakdown: {
            totalChargedToConsumerCents: fullConsumerTotalCents,
          },
        });
      }
    } catch (error: unknown) {
      console.error("Create cart PaymentIntent error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to create payment intent' } });
    }
  });

  // =========================
  // BOOKING REFUNDS
  // =========================

  /**
   * Refund an appointment booking
   * Can be initiated by provider (business owner) or admin
   * 
   * Request: { reason?: string, amount?: number (partial refund in cents) }
   * Response: { success: boolean, refundId: string, amount: number }
   */
  app.post("/api/bookings/appointments/:appointmentId/refund", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { appointmentId } = req.params;
      const { reason, amount } = req.body;
      const appointment = await storage.getAppointment(appointmentId);
      
      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      // Check if user is the business owner or admin
      const business = await storage.getBusiness(appointment.businessId);
      const user = await storage.getUser(userId);
      if (!business || (business.ownerId !== userId && !user?.isAdmin)) {
        return res.status(403).json({ error: "Not authorized to refund this booking" });
      }

      // Handle non-refundable states by canceling PaymentIntent if applicable
      if (appointment.status !== BOOKING_STATES.CONFIRMED && appointment.status !== BOOKING_STATES.COMPLETED) {
        // For pending_payment or pending_provider with PaymentIntent, cancel the authorization
        if ((appointment.status === BOOKING_STATES.PENDING_PAYMENT || appointment.status === BOOKING_STATES.PENDING_PROVIDER) 
            && appointment.stripePaymentIntentId) {
          try {
            await stripeService.cancelPaymentIntent(appointment.stripePaymentIntentId, 'requested_by_customer');
            await transitionAppointmentState(appointmentId, BOOKING_STATES.CANCELED, {
              triggeredBy: userId,
              triggerSource: 'api',
              metadata: { action: 'provider_cancel', reason }
            });
            return res.json({ success: true, message: "Payment authorization voided, booking canceled" });
          } catch (stripeError: any) {
            console.error(`[Booking] Failed to cancel PaymentIntent for appointment ${appointmentId}:`, stripeError);
            // Continue with state transition even if Stripe cancel fails
            await transitionAppointmentState(appointmentId, BOOKING_STATES.CANCELED, {
              triggeredBy: userId,
              triggerSource: 'api',
              metadata: { action: 'provider_cancel', reason, stripeError: stripeError.message }
            });
            return res.json({ success: true, message: "Booking canceled (payment may need manual resolution)" });
          }
        }
        
        // For draft state, just cancel
        if (appointment.status === BOOKING_STATES.DRAFT) {
          await transitionAppointmentState(appointmentId, BOOKING_STATES.CANCELED, {
            triggeredBy: userId,
            triggerSource: 'api',
            metadata: { action: 'provider_cancel', reason }
          });
          return res.json({ success: true, message: "Draft booking canceled" });
        }
        
        return res.status(400).json({ 
          error: "Booking cannot be refunded in current state",
          currentStatus: appointment.status 
        });
      }

      if (!appointment.stripePaymentIntentId) {
        return res.status(400).json({ error: "No payment found for this booking" });
      }

      // Create refund
      const refundAmount = amount || appointment.totalPrice; // Full refund if no amount specified
      const refund = await stripeService.createBookingRefund({
        paymentIntentId: appointment.stripePaymentIntentId,
        amountCents: refundAmount,
        reason: 'requested_by_customer',
        metadata: {
          appointmentId,
          initiatedBy: userId,
          reason: reason || 'Provider initiated refund',
        }
      });

      // Use state machine for consistent audit logging
      await transitionAppointmentState(appointmentId, BOOKING_STATES.CANCELED, {
        triggeredBy: userId,
        triggerSource: 'api',
        metadata: { 
          action: 'refund',
          refundId: refund.id,
          refundAmount,
          reason: reason || 'Refunded by provider'
        }
      });

      // Update appointment with refund details (additional fields not in state machine)
      await db.update(appointments).set({
        stripeRefundId: refund.id,
        refundedAt: new Date(),
        refundAmount: refundAmount,
        canceledBy: userId,
        cancellationReason: reason || 'Refunded by provider'
      }).where(eq(appointments.id, appointmentId));

      // Reverse points if applicable
      try {
        await storage.reversePointsForRefund(appointment.clientId, 'appointment', appointmentId);
      } catch (pointsError) {
        console.error("Failed to reverse points:", pointsError);
      }

      console.log(`[Booking] Refunded appointment ${appointmentId}: ${refundAmount} cents (refund ID: ${refund.id})`);

      res.json({ 
        success: true, 
        refundId: refund.id,
        amount: refundAmount,
        status: refund.status
      });
    } catch (error: any) {
      console.error("Refund appointment error:", error);
      res.status(500).json({ error: "Failed to process refund", details: error.message });
    }
  });

  // Cancel a confirmed appointment as a no-show WITHOUT issuing a refund
  app.post("/api/bookings/appointments/:appointmentId/cancel-no-refund", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { appointmentId } = req.params;
      const { reason } = req.body;
      const appointment = await storage.getAppointment(appointmentId);

      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      // Check if user is the business owner
      const business = await storage.getBusiness(appointment.businessId);
      if (!business || business.ownerId !== userId) {
        return res.status(403).json({ error: "Not authorized to cancel this booking" });
      }

      if (appointment.status !== BOOKING_STATES.CONFIRMED) {
        return res.status(400).json({
          error: "Booking must be in confirmed state to cancel as no-show",
          currentStatus: appointment.status,
        });
      }

      const result = await transitionAppointmentState(appointmentId, BOOKING_STATES.NO_SHOW, {
        triggeredBy: userId,
        triggerSource: 'api',
        metadata: { action: 'provider_cancel_no_refund', reason },
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      await db.update(appointments).set({
        canceledBy: userId,
        cancellationReason: reason || 'No-show, not refunded',
      }).where(eq(appointments.id, appointmentId));

      const updatedAppointment = await storage.getAppointment(appointmentId);
      res.json({ success: true, appointment: updatedAppointment });
    } catch (error) {
      console.error("Cancel no-refund appointment error:", error);
      res.status(500).json({ error: "Failed to cancel booking" });
    }
  });

  // ─── Shared helper: compute refund tier + cancellation fee from a service's policy ──────────────
  // Used by both the business appointment cancel route and the shoot booking cancel route.
  // Returns the refund tier (full/partial/none), refund amount in cents, and fee amount in cents.
  function computeCancellationRefund(
    svc: {
      fullRefundWindow?: string | null;
      hasPartialRefund?: boolean | null;
      partialRefundWindow?: string | null;
      partialRefundPercentage?: number | null;
      hasCancellationFee?: boolean | null;
      cancellationFeeType?: string | null;
      cancellationFeeAmount?: number | null;
    } | null | undefined,
    bookingDateTime: Date,
    totalPriceCents: number,
    vendorNetCents?: number | null,
  ): { refundTier: 'full' | 'partial' | 'none'; refundAmountCents: number; feeAmountCents: number } {
    const WINDOW_HOURS: Record<string, number> = {
      '1_week':   168,
      '48_hours': 48,
      '24_hours': 24,
      '1_hour':   1,
      'never':    Infinity,
    };

    const hoursUntil = (bookingDateTime.getTime() - Date.now()) / (1000 * 60 * 60);

    let refundTier: 'full' | 'partial' | 'none' = 'none';
    let refundAmountCents = 0;

    const fullWindow = WINDOW_HOURS[svc?.fullRefundWindow ?? 'never'] ?? Infinity;
    if (svc?.fullRefundWindow && svc.fullRefundWindow !== 'never' && hoursUntil >= fullWindow) {
      refundTier = 'full';
      refundAmountCents = totalPriceCents;
    } else if (svc?.hasPartialRefund && svc.partialRefundWindow && svc.partialRefundWindow !== 'never') {
      const partialWindow = WINDOW_HOURS[svc.partialRefundWindow] ?? Infinity;
      if (hoursUntil >= partialWindow) {
        refundTier = 'partial';
        refundAmountCents = Math.round(totalPriceCents * ((svc.partialRefundPercentage ?? 0) / 100));
      }
    }

    let feeAmountCents = 0;
    if (refundTier !== 'full' && svc?.hasCancellationFee && svc.cancellationFeeAmount != null) {
      if (svc.cancellationFeeType === 'flat') {
        feeAmountCents = svc.cancellationFeeAmount;
      } else if (svc.cancellationFeeType === 'percentage') {
        feeAmountCents = Math.round(
          (vendorNetCents ?? totalPriceCents) * (svc.cancellationFeeAmount / 100)
        );
      }
    }

    return { refundTier, refundAmountCents, feeAmountCents };
  }

  // ── Cancellation preview: pure read, no side effects ──────────────────────────
  // Returns what WOULD happen if the consumer cancels right now, without
  // touching any booking state, Stripe, or availability slots.

  app.get("/api/bookings/appointments/:appointmentId/cancel-preview", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { appointmentId } = req.params;
      const appointment = await storage.getAppointment(appointmentId);

      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      if (appointment.clientId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      if (appointment.status !== BOOKING_STATES.CONFIRMED) {
        return res.json({
          cancellable: false,
          reason: "Booking must be confirmed to cancel",
          currentStatus: appointment.status,
        });
      }

      const service = appointment.serviceId
        ? await storage.getVendorService(appointment.serviceId)
        : null;

      const { refundTier, refundAmountCents, feeAmountCents } = computeCancellationRefund(
        service,
        new Date(`${appointment.appointmentDate}T${appointment.appointmentTime}`),
        appointment.totalPrice,
        appointment.vendorNet,
      );

      const fees = calculateBookingFees(appointment.totalPrice);

      return res.json({
        cancellable: true,
        refundTier,
        refundAmountCents,
        feeAmountCents,
        // feeWouldBeCharged indicates a fee applies; actual collection method
        // (automatic vs manual) is determined at cancel time by payment method availability.
        feeWouldBeCharged: feeAmountCents > 0,
        feeNeedsManualCollection: false,
        subtotalCents: fees.subtotalCents,
        grossChargeAmountCents: fees.customerTotalBeforeTaxCents,
      });
    } catch (error: any) {
      console.error("Appointment cancel preview error:", error);
      res.status(500).json({ error: "Failed to compute cancellation preview", details: error.message });
    }
  });

  app.get("/api/bookings/shoot/:bookingId/cancel-preview", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { bookingId } = req.params;
      const booking = await storage.getShootBooking(bookingId);

      if (!booking) {
        return res.status(404).json({ error: "Shoot booking not found" });
      }

      if (booking.clientId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const cancellableStatuses = [BOOKING_STATES.CONFIRMED, BOOKING_STATES.PENDING_PROVIDER];
      if (!(cancellableStatuses as string[]).includes(booking.status)) {
        return res.json({
          cancellable: false,
          reason: "Booking must be confirmed or pending provider acceptance to cancel",
          currentStatus: booking.status,
        });
      }

      const service = booking.serviceId
        ? await storage.getPhotographerService(booking.serviceId)
        : null;

      const { refundTier, refundAmountCents, feeAmountCents } = computeCancellationRefund(
        service,
        new Date(`${booking.date}T${booking.startTime}`),
        booking.totalPrice,
        booking.vendorNet,
      );

      const fees = calculateBookingFees(booking.totalPrice);

      return res.json({
        cancellable: true,
        refundTier,
        refundAmountCents,
        feeAmountCents,
        feeWouldBeCharged: feeAmountCents > 0,
        feeNeedsManualCollection: false,
        subtotalCents: fees.subtotalCents,
        grossChargeAmountCents: fees.customerTotalBeforeTaxCents,
      });
    } catch (error: any) {
      console.error("Shoot booking cancel preview error:", error);
      res.status(500).json({ error: "Failed to compute cancellation preview", details: error.message });
    }
  });

  // Consumer-initiated cancel: applies service cancellation policy (refund + optional fee)
  app.post("/api/bookings/appointments/:appointmentId/cancel", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { appointmentId } = req.params;
      const appointment = await storage.getAppointment(appointmentId);

      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      // Only the booking client may use this route
      if (appointment.clientId !== userId) {
        return res.status(403).json({ error: "Not authorized to cancel this booking" });
      }

      if (appointment.status !== BOOKING_STATES.CONFIRMED) {
        return res.status(400).json({
          error: "Booking must be confirmed to cancel",
          currentStatus: appointment.status,
        });
      }

      // ── Fetch service policy ──────────────────────────────────────────────
      const service = appointment.serviceId
        ? await storage.getVendorService(appointment.serviceId)
        : null;

      // ── Compute refund tier + cancellation fee ────────────────────────────
      const { refundTier, refundAmountCents, feeAmountCents } = computeCancellationRefund(
        service,
        new Date(`${appointment.appointmentDate}T${appointment.appointmentTime}`),
        appointment.totalPrice,
        appointment.vendorNet,
      );

      // ── Issue refund (best-effort) ────────────────────────────────────────
      let refundSucceeded = false;
      if (refundAmountCents > 0 && appointment.stripePaymentIntentId) {
        try {
          const refund = await stripeService.createBookingRefund({
            paymentIntentId: appointment.stripePaymentIntentId,
            amountCents: refundAmountCents,
            reason: 'requested_by_customer',
            metadata: {
              appointmentId,
              initiatedBy: userId,
              refundTier,
              reason: 'Consumer-initiated cancellation',
            },
          });
          await db.update(appointments).set({
            stripeRefundId: refund.id,
            refundedAt: new Date(),
            refundAmount: refundAmountCents,
          }).where(eq(appointments.id, appointmentId));
          refundSucceeded = true;
        } catch (refundError: any) {
          console.error(`[Cancel] Refund failed for appointment ${appointmentId}:`, refundError);
        }
      }

      // ── Charge cancellation fee (best-effort) ────────────────────────────
      let feeCharged = false;
      let feeNeedsManualCollection = false;
      if (feeAmountCents > 0 && appointment.stripePaymentIntentId) {
        try {
          const user = await storage.getUser(userId);
          const paymentMethodId = await stripeService.getPaymentMethodIdFromIntent(
            appointment.stripePaymentIntentId,
          );
          if (user?.stripeCustomerId && paymentMethodId) {
            await stripeService.chargeSavedPaymentMethod({
              customerId: user.stripeCustomerId,
              paymentMethodId,
              amountCents: feeAmountCents,
              metadata: {
                appointmentId,
                initiatedBy: userId,
                type: 'cancellation_fee',
              },
              description: `Cancellation fee for appointment ${appointmentId}`,
            });
            feeCharged = true;
          } else {
            feeNeedsManualCollection = true;
          }
        } catch (feeError: any) {
          console.error(`[Cancel] Fee charge failed for appointment ${appointmentId}:`, feeError);
          feeNeedsManualCollection = true;
        }
      }

      // ── Always transition to CANCELED ─────────────────────────────────────
      await transitionAppointmentState(appointmentId, BOOKING_STATES.CANCELED, {
        triggeredBy: userId,
        triggerSource: 'api',
        metadata: {
          action: 'consumer_cancel',
          refundTier,
          refundAmountCents: String(refundAmountCents),
          refundSucceeded: String(refundSucceeded),
          feeAmountCents: String(feeAmountCents),
          feeCharged: String(feeCharged),
          feeNeedsManualCollection: String(feeNeedsManualCollection),
        },
      });

      await db.update(appointments).set({
        canceledAt: new Date(),
        canceledBy: userId,
        cancellationReason: 'Consumer-initiated cancellation',
      }).where(eq(appointments.id, appointmentId));

      res.json({
        success: true,
        refundTier,
        refundAmountCents,
        feeAmountCents,
        feeCharged,
        feeNeedsManualCollection,
      });
    } catch (error: any) {
      console.error("Consumer cancel appointment error:", error);
      res.status(500).json({ error: "Failed to cancel appointment", details: error.message });
    }
  });

  // Consumer-initiated cancel for photographer shoot bookings.
  // Mirrors the business appointment cancel route: applies the photographer service's
  // cancellation policy to determine refund tier, issues a best-effort refund,
  // charges a best-effort fee, and releases the photographer's availability slot.
  app.post("/api/bookings/shoot/:bookingId/cancel", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { bookingId } = req.params;
      const booking = await storage.getShootBooking(bookingId);

      if (!booking) {
        return res.status(404).json({ error: "Shoot booking not found" });
      }

      // Only the consumer who made the booking may use this route
      if (booking.clientId !== userId) {
        return res.status(403).json({ error: "Not authorized to cancel this booking" });
      }

      // Allow cancellation from CONFIRMED or PENDING_PROVIDER.
      // Both states have captured payment (payment was collected at the
      // PENDING_PAYMENT→webhook transition before the provider accepts).
      const cancellableStatuses = [BOOKING_STATES.CONFIRMED, BOOKING_STATES.PENDING_PROVIDER];
      if (!(cancellableStatuses as string[]).includes(booking.status)) {
        return res.status(400).json({
          error: "Booking must be confirmed or pending provider acceptance to cancel",
          currentStatus: booking.status,
        });
      }

      // ── Fetch service policy ──────────────────────────────────────────────
      const service = booking.serviceId
        ? await storage.getPhotographerService(booking.serviceId)
        : null;

      // ── Compute refund tier + cancellation fee ────────────────────────────
      const { refundTier, refundAmountCents, feeAmountCents } = computeCancellationRefund(
        service,
        new Date(`${booking.date}T${booking.startTime}`),
        booking.totalPrice,
        booking.vendorNet,
      );

      // ── Issue refund (best-effort) ────────────────────────────────────────
      let refundSucceeded = false;
      if (refundAmountCents > 0 && booking.stripePaymentIntentId) {
        try {
          const refund = await stripeService.createBookingRefund({
            paymentIntentId: booking.stripePaymentIntentId,
            amountCents: refundAmountCents,
            reason: 'requested_by_customer',
            metadata: {
              shootBookingId: bookingId,
              initiatedBy: userId,
              refundTier,
              reason: 'Consumer-initiated cancellation',
            },
          });
          await db.update(shootBookings).set({
            stripeRefundId: refund.id,
            refundedAt: new Date(),
            refundAmount: refundAmountCents,
          }).where(eq(shootBookings.id, bookingId));
          refundSucceeded = true;
        } catch (refundError: any) {
          console.error(`[Cancel] Refund failed for shoot booking ${bookingId}:`, refundError);
        }
      }

      // ── Charge cancellation fee (best-effort) ────────────────────────────
      let feeCharged = false;
      let feeNeedsManualCollection = false;
      if (feeAmountCents > 0 && booking.stripePaymentIntentId) {
        try {
          const user = await storage.getUser(userId);
          const paymentMethodId = await stripeService.getPaymentMethodIdFromIntent(
            booking.stripePaymentIntentId,
          );
          if (user?.stripeCustomerId && paymentMethodId) {
            await stripeService.chargeSavedPaymentMethod({
              customerId: user.stripeCustomerId,
              paymentMethodId,
              amountCents: feeAmountCents,
              metadata: {
                shootBookingId: bookingId,
                initiatedBy: userId,
                type: 'cancellation_fee',
              },
              description: `Cancellation fee for shoot booking ${bookingId}`,
            });
            feeCharged = true;
          } else {
            feeNeedsManualCollection = true;
          }
        } catch (feeError: any) {
          console.error(`[Cancel] Fee charge failed for shoot booking ${bookingId}:`, feeError);
          feeNeedsManualCollection = true;
        }
      }

      // ── Transition to CANCELED via state machine ──────────────────────────
      await transitionShootBookingState(bookingId, BOOKING_STATES.CANCELED, {
        triggeredBy: userId,
        triggerSource: 'api',
        metadata: {
          action: 'consumer_cancel',
          refundTier,
          refundAmountCents: String(refundAmountCents),
          refundSucceeded: String(refundSucceeded),
          feeAmountCents: String(feeAmountCents),
          feeCharged: String(feeCharged),
          feeNeedsManualCollection: String(feeNeedsManualCollection),
        },
      });

      await db.update(shootBookings).set({
        canceledAt: new Date(),
        canceledBy: userId,
        cancellationReason: 'Consumer-initiated cancellation',
      }).where(eq(shootBookings.id, bookingId));

      // ── Release photographer availability slot ────────────────────────────
      try {
        await storage.releasePhotographerSlot(bookingId);
      } catch (slotErr) {
        console.error(`[Cancel] Failed to release photographer slot for booking ${bookingId}:`, slotErr);
      }

      res.json({
        success: true,
        refundTier,
        refundAmountCents,
        feeAmountCents,
        feeCharged,
        feeNeedsManualCollection,
      });
    } catch (error: any) {
      console.error("Consumer cancel shoot booking error:", error);
      res.status(500).json({ error: "Failed to cancel shoot booking", details: error.message });
    }
  });

  /**
   * Refund a photographer shoot booking
   * Can be initiated by provider (photographer) or admin
   */
  app.post("/api/bookings/photographer/:bookingId/refund", async (req, res) => {
    const userId = req.session?.userId || getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { bookingId } = req.params;
      const { reason, amount } = req.body;
      const booking = await storage.getShootBooking(bookingId);
      
      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Check if user is the photographer or admin
      const photographer = await storage.getPhotographer(booking.photographerId);
      const user = await storage.getUser(userId);
      if (!photographer || (photographer.userId !== userId && !user?.isAdmin)) {
        return res.status(403).json({ error: "Not authorized to refund this booking" });
      }

      // Handle non-refundable states by canceling PaymentIntent if applicable
      if (booking.status !== BOOKING_STATES.CONFIRMED && booking.status !== BOOKING_STATES.COMPLETED) {
        // For pending_payment or pending_provider with PaymentIntent, cancel the authorization
        if ((booking.status === BOOKING_STATES.PENDING_PAYMENT || booking.status === BOOKING_STATES.PENDING_PROVIDER) 
            && booking.stripePaymentIntentId) {
          try {
            await stripeService.cancelPaymentIntent(booking.stripePaymentIntentId, 'requested_by_customer');
            await transitionShootBookingState(bookingId, BOOKING_STATES.CANCELED, {
              triggeredBy: userId,
              triggerSource: 'api',
              metadata: { action: 'provider_cancel', reason }
            });
            return res.json({ success: true, message: "Payment authorization voided, booking canceled" });
          } catch (stripeError: any) {
            console.error(`[Booking] Failed to cancel PaymentIntent for shoot booking ${bookingId}:`, stripeError);
            await transitionShootBookingState(bookingId, BOOKING_STATES.CANCELED, {
              triggeredBy: userId,
              triggerSource: 'api',
              metadata: { action: 'provider_cancel', reason, stripeError: stripeError.message }
            });
            return res.json({ success: true, message: "Booking canceled (payment may need manual resolution)" });
          }
        }
        
        // For draft state, just cancel
        if (booking.status === BOOKING_STATES.DRAFT) {
          await transitionShootBookingState(bookingId, BOOKING_STATES.CANCELED, {
            triggeredBy: userId,
            triggerSource: 'api',
            metadata: { action: 'provider_cancel', reason }
          });
          return res.json({ success: true, message: "Draft booking canceled" });
        }
        
        return res.status(400).json({ 
          error: "Booking cannot be refunded in current state",
          currentStatus: booking.status 
        });
      }

      if (!booking.stripePaymentIntentId) {
        return res.status(400).json({ error: "No payment found for this booking" });
      }

      // Create refund
      const refundAmount = amount || booking.totalPrice;
      const refund = await stripeService.createBookingRefund({
        paymentIntentId: booking.stripePaymentIntentId,
        amountCents: refundAmount,
        reason: 'requested_by_customer',
        metadata: {
          shootBookingId: bookingId,
          initiatedBy: userId,
          reason: reason || 'Provider initiated refund',
        }
      });

      // Use state machine for consistent audit logging
      await transitionShootBookingState(bookingId, BOOKING_STATES.CANCELED, {
        triggeredBy: userId,
        triggerSource: 'api',
        metadata: { 
          action: 'refund',
          refundId: refund.id,
          refundAmount,
          reason: reason || 'Refunded by provider'
        }
      });

      // Update booking with refund details (additional fields not in state machine)
      await db.update(shootBookings).set({
        stripeRefundId: refund.id,
        refundedAt: new Date(),
        refundAmount: refundAmount,
        canceledBy: userId,
        cancellationReason: reason || 'Refunded by provider'
      }).where(eq(shootBookings.id, bookingId));

      // Reverse points if applicable
      try {
        await storage.reversePointsForRefund(booking.clientId, 'shoot_booking', bookingId);
      } catch (pointsError) {
        console.error("Failed to reverse points:", pointsError);
      }

      console.log(`[Booking] Refunded shoot booking ${bookingId}: ${refundAmount} cents (refund ID: ${refund.id})`);

      res.json({ 
        success: true, 
        refundId: refund.id,
        amount: refundAmount,
        status: refund.status
      });
    } catch (error: any) {
      console.error("Refund shoot booking error:", error);
      res.status(500).json({ error: "Failed to process refund", details: error.message });
    }
  });

  // ==================== BUSINESS APPOINTMENT ROUTES ====================

  // Get customer's appointments
  app.get("/api/my-appointments", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const appointments = await storage.getAppointmentsByClientWithDetails(userId);
      res.json({ appointments });
    } catch (error) {
      console.error("Get appointments error:", error);
      res.status(500).json({ error: "Failed to get appointments" });
    }
  });

  // Get consumer's own photographer (shoot) bookings
  app.get("/api/my-shoot-bookings", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const bookings = await db
        .select()
        .from(shootBookings)
        .where(
          and(
            eq(shootBookings.clientId, userId),
            ne(shootBookings.status, BOOKING_STATES.DRAFT)
          )
        )
        .orderBy(asc(shootBookings.date), asc(shootBookings.startTime));

      // Map shoot_bookings DB status values to the Session.status union the frontend expects.
      // Precedent: getAppointmentsByClientWithDetails returns all non-draft statuses without
      // server-side filtering; we do the same here and let the frontend split upcoming vs past.
      const statusMap: Record<string, "upcoming" | "completed" | "cancelled"> = {
        [BOOKING_STATES.PENDING_PAYMENT]: "upcoming",
        [BOOKING_STATES.PENDING_PROVIDER]: "upcoming",
        [BOOKING_STATES.CONFIRMED]: "upcoming",
        [BOOKING_STATES.COMPLETED]: "completed",
        [BOOKING_STATES.CANCELED]: "cancelled",
        [BOOKING_STATES.DECLINED]: "cancelled",
        [BOOKING_STATES.EXPIRED]: "cancelled",
        [BOOKING_STATES.NO_SHOW]: "completed",
      };

      const sessions = await Promise.all(bookings.map(async (booking) => {
        const [photographer, service] = await Promise.all([
          storage.getPhotographer(booking.photographerId),
          booking.serviceId ? storage.getPhotographerService(booking.serviceId) : Promise.resolve(null),
        ]);
        return {
          id: booking.id,
          photographerId: booking.photographerId,
          photographerName: photographer?.displayName ?? "Photographer",
          photographerAvatar: photographer?.logoImage ?? "",
          date: booking.date,
          time: booking.startTime,
          endTime: booking.endTime,
          location: booking.locationDetails ?? booking.locationType ?? "",
          sessionType: booking.shootType,
          status: statusMap[booking.status] ?? "upcoming",
          price: (booking.totalPrice ?? 0) / 100,
          // Service details
          serviceName: service?.name ?? null,
          serviceDurationMinutes: service?.estimatedDurationMinutes ?? null,
          // Cancellation policy fields (from photographerServices)
          serviceFullRefundWindow: service?.fullRefundWindow ?? "never",
          serviceHasPartialRefund: service?.hasPartialRefund ?? false,
          servicePartialRefundWindow: service?.partialRefundWindow ?? null,
          servicePartialRefundPercentage: service?.partialRefundPercentage ?? null,
          serviceHasCancellationFee: service?.hasCancellationFee ?? false,
          serviceCancellationFeeType: service?.cancellationFeeType ?? null,
          serviceCancellationFeeAmount: service?.cancellationFeeAmount ?? null,
        };
      }));

      res.json({ sessions });
    } catch (error) {
      console.error("Get my shoot bookings error:", error);
      res.status(500).json({ error: "Failed to get shoot bookings" });
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

  // Platform subscription checkout — businesses pay Outsyde directly (no Connect, no splits).
  // No canMonetize check — this IS the monetization setup step.
  // No isVendor session check — business ownership is the only requirement.
  app.post("/api/stripe/checkout/tier-subscription", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Not authenticated' } });
    }

    try {
      const { tierId } = z.object({ tierId: z.string().min(1) }).parse(req.body);

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      }

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No business found for this account' } });
      }

      // Get or create Stripe customer (platform customer, NOT Connect)
      let stripeCustomerId = user.stripeCustomerId;
      if (!stripeCustomerId) {
        const customer = await stripeService.createCustomer(user.email!, userId, user.name || user.email!);
        stripeCustomerId = customer.id;
        await storage.updateUser(userId, { stripeCustomerId: customer.id });
      }

      // Check if business already has an active subscription — use update instead of create
      const existingSub = await storage.getVendorSubscription(userId);
      if (existingSub?.stripeSubscriptionId && (existingSub.status === 'active' || existingSub.status === 'trialing')) {
        const stripe = await getUncachableStripeClient();
        const stripeSub = await stripe.subscriptions.retrieve(existingSub.stripeSubscriptionId);
        const itemId = stripeSub.items.data[0]?.id;

        if (!itemId) {
          return res.status(400).json({ success: false, error: { code: 'NO_ITEMS', message: 'Existing subscription has no items' } });
        }

        const [newTier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, tierId));
        if (!newTier?.stripePriceId) {
          return res.status(404).json({ success: false, error: { code: 'TIER_NOT_FOUND', message: 'Tier not found or not configured' } });
        }

        if (existingSub.tierId === tierId) {
          return res.status(400).json({ success: false, error: { code: 'SAME_TIER', message: 'Already on this tier' } });
        }

        await stripe.subscriptions.update(existingSub.stripeSubscriptionId, {
          items: [{ id: itemId, price: newTier.stripePriceId }],
          proration_behavior: 'none',
        });

        return res.json({
          success: true,
          message: 'Subscription tier updated',
          tierChanged: true,
          newTier: newTier.displayName || newTier.name,
        });
      }

      // No existing subscription — create a new one
      const useNative = req.body.native === true ||
        req.headers['x-platform'] === 'mobile' ||
        req.headers['x-client-type'] === 'mobile';

      if (useNative) {
        const result = await stripeService.createTierSubscriptionNative(
          stripeCustomerId,
          tierId,
          userId,
          business.id
        );

        res.json({
          success: true,
          clientSecret: result.clientSecret,
          subscriptionId: result.subscriptionId,
          ephemeralKey: result.ephemeralKey,
          customerId: stripeCustomerId,
        });
      } else {
        const baseUrl = process.env.API_BASE_URL || process.env.FRONTEND_URL || 'https://outsyde-backend.onrender.com';
        const session = await stripeService.createTierSubscriptionCheckout(
          stripeCustomerId,
          tierId,
          `${baseUrl}/vendor/dashboard?subscription=success`,
          `${baseUrl}/vendor/dashboard?subscription=cancelled`,
          userId,
          business.id
        );

        res.json({ success: true, url: session.url });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'tierId is required' } });
      }
      console.error("Create tier subscription checkout error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to create checkout session' } });
    }
  });

  // Change subscription tier (upgrade or downgrade)
  app.post("/api/vendor/subscription/change-tier", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(userId);
    if (!user?.isVendor) {
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

  // Sync subscription status from Stripe (recovery for webhook failures)
  app.get("/api/vendor/subscription/sync", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const stripe = await getUncachableStripeClient();

      const subscription = await storage.getVendorSubscription(userId);
      if (!subscription?.stripeSubscriptionId) {
        return res.json({ synced: false, reason: "No subscription record found" });
      }

      const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      const liveStatus = stripeSub.status;
      const currentPriceId = stripeSub.items.data[0]?.price?.id;

      let tierId = subscription.tierId;
      if (currentPriceId) {
        const [matchingTier] = await db
          .select()
          .from(subscriptionTiers)
          .where(eq(subscriptionTiers.stripePriceId, currentPriceId));
        if (matchingTier) tierId = matchingTier.id;
      }

      await db
        .update(vendorSubscriptions)
        .set({
          status: liveStatus,
          tierId,
          updatedAt: new Date(),
        })
        .where(eq(vendorSubscriptions.vendorId, userId));

      const business = await storage.getBusinessByOwnerId(userId);
      if (business) {
        await storage.updateBusiness(business.id, {
          subscriptionActive: liveStatus === 'active' || liveStatus === 'trialing',
        });
      }

      console.log(`[Subscription Sync] userId=${userId} DB was: ${subscription.status} → Stripe live: ${liveStatus}`);

      return res.json({
        synced: true,
        previousStatus: subscription.status,
        currentStatus: liveStatus,
        tierId,
      });
    } catch (error) {
      console.error("[Subscription Sync] Error:", error);
      return res.status(500).json({ synced: false, error: "Failed to sync subscription" });
    }
  });

  // ==================== STRIPE EXPRESS ONBOARDING ====================

  // Get vendor's Stripe onboarding status (supports vendors, photographers, and influencers)
  app.get("/api/vendor/stripe-onboarding/status", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(userId);
    const isInfluencer = user?.isInfluencer;

    if (!req.session?.isVendor && !req.session?.isPhotographer && !isInfluencer) {
      return res.status(403).json({ error: "Only vendors, photographers, or influencers can access this" });
    }

    try {
      const baseUrl = process.env.API_BASE_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000'}`;
      
      if (req.session?.isVendor) {
        const business = await storage.getBusinessByOwnerId(userId);
        if (!business) {
          return res.status(404).json({ error: "Business not found" });
        }

        // If already has account, get fresh status from Stripe and sync to DB
        if (business.stripeAccountId) {
          const status = await stripeService.getConnectAccountStatus(business.stripeAccountId);
          const isComplete = status.chargesEnabled && status.payoutsEnabled;
          
          // Self-healing: sync to database if Stripe says complete but local says not
          if (isComplete && !business.stripeOnboardingComplete) {
            console.log(`[Stripe] Self-healing: business ${business.id} onboarding is complete in Stripe, updating local database`);
            await storage.updateBusiness(business.id, { stripeOnboardingComplete: true });
          }
          
          return res.json({
            accountType: 'business',
            hasStripeAccount: true,
            stripeAccountId: business.stripeAccountId,
            onboardingComplete: isComplete,
            chargesEnabled: status.chargesEnabled,
            payoutsEnabled: status.payoutsEnabled,
            detailsSubmitted: status.detailsSubmitted,
            requirements: status.requirements,
            onboardingUrl: business.stripeOnboardingUrl,
          });
        }

        return res.json({
          accountType: 'business',
          hasStripeAccount: false,
          onboardingComplete: false,
        });
      }

      if (req.session?.isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer profile not found" });
        }

        // If already has account, get fresh status from Stripe and sync to DB
        if (photographer.stripeAccountId) {
          const status = await stripeService.getConnectAccountStatus(photographer.stripeAccountId);
          const isComplete = status.chargesEnabled && status.payoutsEnabled;
          
          // Self-healing: sync to database if Stripe says complete but local says not
          if (isComplete && !photographer.stripeOnboardingComplete) {
            console.log(`[Stripe] Self-healing: photographer ${photographer.id} onboarding is complete in Stripe, updating local database`);
            await storage.updatePhotographer(photographer.id, { stripeOnboardingComplete: true });
          }
          
          return res.json({
            accountType: 'photographer',
            hasStripeAccount: true,
            stripeAccountId: photographer.stripeAccountId,
            onboardingComplete: isComplete,
            chargesEnabled: status.chargesEnabled,
            payoutsEnabled: status.payoutsEnabled,
            detailsSubmitted: status.detailsSubmitted,
            requirements: status.requirements,
            onboardingUrl: photographer.stripeOnboardingUrl,
          });
        }

        return res.json({
          accountType: 'photographer',
          hasStripeAccount: false,
          onboardingComplete: false,
        });
      }

      // Handle influencer onboarding status
      if (isInfluencer) {
        const influencerProfile = await storage.getInfluencerProfileByUserId(userId);
        if (!influencerProfile) {
          return res.status(404).json({ error: "Influencer profile not found" });
        }

        if (influencerProfile.stripeAccountId) {
          const status = await stripeService.getConnectAccountStatus(influencerProfile.stripeAccountId);
          return res.json({
            accountType: 'influencer',
            hasStripeAccount: true,
            stripeAccountId: influencerProfile.stripeAccountId,
            onboardingComplete: status.payoutsEnabled,
            chargesEnabled: status.chargesEnabled,
            payoutsEnabled: status.payoutsEnabled,
            detailsSubmitted: status.detailsSubmitted,
            requirements: status.requirements,
            onboardingUrl: influencerProfile.stripeOnboardingUrl,
          });
        }

        return res.json({
          accountType: 'influencer',
          hasStripeAccount: false,
          onboardingComplete: false,
        });
      }
    } catch (error) {
      console.error("Get Stripe onboarding status error:", error);
      res.status(500).json({ error: "Failed to get onboarding status" });
    }
  });

  // Confirm Stripe Connect onboarding completion (belt-and-suspenders alongside webhook)
  app.post("/api/stripe/connect/complete", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    try {
      const { accountId } = req.body;
      if (!accountId) {
        return res.status(400).json({ success: false, message: "accountId is required" });
      }

      // Verify the account belongs to this user
      const business = await storage.getBusinessByOwnerId(userId);
      const photographer = await storage.getPhotographerByUserId(userId);

      const ownsAccount =
        (business?.stripeAccountId === accountId) ||
        (photographer?.stripeAccountId === accountId);

      if (!ownsAccount) {
        return res.status(403).json({ success: false, message: "Account does not belong to this user" });
      }

      // Check Stripe account status — charges_enabled is sufficient for onboarding
      const status = await stripeService.getConnectAccountStatus(accountId);
      const isComplete = status.chargesEnabled === true;

      if (isComplete) {
        if (business && business.stripeAccountId === accountId) {
          await storage.updateBusiness(business.id, { stripeOnboardingComplete: true });
          console.log(`[Stripe] Business ${business.id} onboarding confirmed complete via /connect/complete`);
        }
        if (photographer && photographer.stripeAccountId === accountId) {
          await storage.updatePhotographer(photographer.id, { stripeOnboardingComplete: true });
          console.log(`[Stripe] Photographer ${photographer.id} onboarding confirmed complete via /connect/complete`);
        }
      }

      res.json({
        success: true,
        complete: isComplete,
        chargesEnabled: status.chargesEnabled,
        payoutsEnabled: status.payoutsEnabled,
      });
    } catch (error) {
      console.error("Stripe Connect complete error:", error);
      res.status(500).json({ success: false, message: "Failed to check onboarding status" });
    }
  });

  // Create or refresh Stripe Express onboarding link (supports vendors, photographers, and influencers)
  app.post("/api/vendor/stripe-onboarding/create-link", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(userId);
    const isInfluencer = user?.isInfluencer;
    const isVendor = user?.isVendor || req.session?.isVendor;
    const isPhotographer = user?.isPhotographer || req.session?.isPhotographer;

    if (!isVendor && !isPhotographer && !isInfluencer) {
      return res.status(403).json({ error: "Only vendors, photographers, or influencers can access this" });
    }

    try {
      if (!user?.email) {
        return res.status(400).json({ error: "User email required for Stripe onboarding" });
      }

      const baseUrl = process.env.API_BASE_URL || 'https://outsyde-backend.onrender.com';
      
      if (isVendor) {
        const business = await storage.getBusinessByOwnerId(userId);
        if (!business) {
          return res.status(404).json({ error: "Business not found" });
        }

        let stripeAccountId = business.stripeAccountId;

        // Create Express account if doesn't exist
        if (!stripeAccountId) {
          const account = await stripeService.createBusinessConnectAccount(
            user.email,
            business.id,
            business.name,
            business.category
          );
          stripeAccountId = account.id;
          
          await storage.updateBusiness(business.id, {
            stripeAccountId: account.id,
          });
        }

        // Generate onboarding link with HTTPS redirect URLs (Stripe rejects deep links)
        const onboardingLink = await stripeService.createConnectOnboardingLink(
          stripeAccountId,
          `${baseUrl}/api/stripe/connect-refresh?account=${stripeAccountId}&type=vendor`,
          `${baseUrl}/api/stripe/connect-return?account=${stripeAccountId}&type=vendor`
        );

        // Store the URL for reference
        await storage.updateBusiness(business.id, {
          stripeOnboardingUrl: onboardingLink.url,
        });

        return res.json({
          url: onboardingLink.url,
          stripeAccountId,
        });
      }

      if (isPhotographer) {
        const photographer = await storage.getPhotographerByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer profile not found" });
        }

        let stripeAccountId = photographer.stripeAccountId;

        // Create Express account if doesn't exist
        if (!stripeAccountId) {
          const account = await stripeService.createPhotographerConnectAccount(
            user.email,
            photographer.id,
            photographer.displayName
          );
          stripeAccountId = account.id;
          
          await storage.updatePhotographer(photographer.id, {
            stripeAccountId: account.id,
          });
        }

        // Generate onboarding link with HTTPS redirect URLs (Stripe rejects deep links)
        const onboardingLink = await stripeService.createConnectOnboardingLink(
          stripeAccountId,
          `${baseUrl}/api/stripe/connect-refresh?account=${stripeAccountId}&type=photographer`,
          `${baseUrl}/api/stripe/connect-return?account=${stripeAccountId}&type=photographer`
        );

        // Store the URL for reference
        await storage.updatePhotographer(photographer.id, {
          stripeOnboardingUrl: onboardingLink.url,
        });

        return res.json({
          url: onboardingLink.url,
          stripeAccountId,
        });
      }

      // Handle influencer onboarding
      if (isInfluencer) {
        const influencerProfile = await storage.getInfluencerProfileByUserId(userId);
        if (!influencerProfile) {
          return res.status(404).json({ error: "Influencer profile not found" });
        }

        let stripeAccountId = influencerProfile.stripeAccountId;

        // Create Express account if doesn't exist
        if (!stripeAccountId) {
          const account = await stripeService.createInfluencerConnectAccount(
            user.email,
            influencerProfile.id,
            influencerProfile.displayName || user.firstName || 'Influencer'
          );
          stripeAccountId = account.id;
          
          await storage.updateInfluencerProfile(influencerProfile.id, {
            stripeAccountId: account.id,
          });
        }

        // Generate onboarding link with HTTPS redirect URLs (Stripe rejects deep links)
        const onboardingLink = await stripeService.createConnectOnboardingLink(
          stripeAccountId,
          `${baseUrl}/api/stripe/connect-refresh?account=${stripeAccountId}&type=influencer`,
          `${baseUrl}/api/stripe/connect-return?account=${stripeAccountId}&type=influencer`
        );

        // Store the URL for reference
        await storage.updateInfluencerProfile(influencerProfile.id, {
          stripeOnboardingUrl: onboardingLink.url,
        });

        return res.json({
          url: onboardingLink.url,
          stripeAccountId,
        });
      }
    } catch (error) {
      console.error("[Stripe Connect] create-link error:", error);
      res.status(500).json({ error: "Failed to create onboarding link" });
    }
  });

  // Get Stripe Express Dashboard login link for vendor payout management
  app.get("/api/vendor/stripe-dashboard-link", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business?.stripeAccountId || !business?.stripeOnboardingComplete) {
        return res.status(403).json({ error: "Stripe onboarding not complete", requiresOnboarding: true });
      }
      const stripe = await getUncachableStripeClient();
      const loginLink = await stripe.accounts.loginLinks.create(business.stripeAccountId);
      return res.json({ url: loginLink.url });
    } catch (error) {
      console.error("[Stripe] Vendor dashboard link error:", error);
      return res.status(500).json({ error: "Failed to generate payout link" });
    }
  });

  // Stripe Connect return — called when user completes or exits onboarding
  app.get("/api/stripe/connect-return", async (req, res) => {
    const { account, type, staffId } = req.query;
    if (account) {
      try {
        const stripe = await getUncachableStripeClient();
        const stripeAccount = await stripe.accounts.retrieve(account as string);
        if (stripeAccount.details_submitted) {
          if (type === 'vendor') {
            const business = await storage.getBusinessByStripeAccountId(account as string);
            if (business) {
              await storage.updateBusiness(business.id, { stripeOnboardingComplete: true });
            }
          } else if (type === 'photographer') {
            const photographer = await storage.getPhotographerByStripeAccountId(account as string);
            if (photographer) {
              await storage.updatePhotographer(photographer.id, { stripeOnboardingComplete: true });
            }
          } else if (type === 'staff') {
            const staffMember = await storage.getStaffMemberByStripeAccountId(account as string);
            if (staffMember) {
              await storage.updateStaffMember(staffMember.id, { stripeOnboardingComplete: true });
            }
          }
        }
      } catch (e) {
        console.error("[Stripe Connect] Failed to retrieve account on return:", e);
      }
    }
    let deepLink = `outsyde://stripe-return?status=complete&type=${type || 'vendor'}`;
    if (type === 'staff' && staffId) {
      deepLink += `&staffId=${staffId}`;
    }
    res.redirect(deepLink);
  });

  // Stripe Connect refresh — called when onboarding link expires
  app.get("/api/stripe/connect-refresh", async (req, res) => {
    const { type, staffId } = req.query;
    let deepLink = `outsyde://stripe-return?status=refresh&type=${type || 'vendor'}`;
    if (type === 'staff' && staffId) {
      deepLink += `&staffId=${staffId}`;
    }
    res.redirect(deepLink);
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

  // ==================== STRIPE BILLING PORTAL ====================

  app.post("/api/stripe/billing-portal", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const stripe = await getUncachableStripeClient();

      const user = await storage.getUser(userId);
      if (!user?.stripeCustomerId) {
        return res.status(404).json({
          error: "No billing account found",
          message: "No subscription billing account is associated with this account.",
        });
      }

      const baseUrl = process.env.API_BASE_URL || 'https://outsyde-backend.onrender.com';
      const returnUrl = `${baseUrl}/api/stripe/portal-return`;

      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: returnUrl,
      });

      return res.json({ portalUrl: session.url });
    } catch (error: any) {
      console.error("[Billing Portal] Error:", error);
      if (error?.raw?.code === 'billing_portal_no_configuration') {
        return res.status(503).json({
          error: "Billing portal not configured",
          message: "The billing portal needs to be enabled in Stripe Dashboard → Settings → Billing → Customer Portal.",
        });
      }
      return res.status(500).json({ error: "Failed to create billing portal session" });
    }
  });

  app.get("/api/stripe/portal-return", (_req, res) => {
    res.redirect("outsyde://stripe-return?status=portal-return");
  });

  // ==================== VENDOR SUBSCRIPTION & BENEFITS ROUTES ====================

  // Get vendor's subscription details (with tier info)
  app.get("/api/vendor/subscription", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.json({ subscription: null });
      }

      const result = await db
        .select({
          id: vendorSubscriptions.id,
          vendorId: vendorSubscriptions.vendorId,
          businessId: vendorSubscriptions.businessId,
          status: vendorSubscriptions.status,
          tierId: vendorSubscriptions.tierId,
          stripeSubscriptionId: vendorSubscriptions.stripeSubscriptionId,
          stripeCustomerId: vendorSubscriptions.stripeCustomerId,
          currentPeriodStart: vendorSubscriptions.currentPeriodStart,
          currentPeriodEnd: vendorSubscriptions.currentPeriodEnd,
          createdAt: vendorSubscriptions.createdAt,
          tierName: subscriptionTiers.name,
          tierDisplayName: subscriptionTiers.displayName,
          priceInCents: subscriptionTiers.priceInCents,
        })
        .from(vendorSubscriptions)
        .leftJoin(subscriptionTiers, eq(vendorSubscriptions.tierId, subscriptionTiers.id))
        .where(eq(vendorSubscriptions.businessId, business.id))
        .limit(1);

      if (!result.length) {
        return res.json({ subscription: null });
      }

      res.json({ subscription: result[0] });
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
  app.post("/api/ala-carte/checkout", requireMonetization, async (req, res) => {
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

      // Platform fee (10% Outsyde booking fee for service purchases)
      const platformFeeInCents = calculateBookingFee(pricing.finalPriceCents);

      // Create the purchase record first
      const purchase = await storage.createAlaCartePurchase({
        vendorId: userId,
        businessId: business.id,
        serviceId,
        tierIdAtPurchase: pricing.tier?.id ?? null,
        basePriceInCents: pricing.basePriceCents,
        discountPercent: pricing.discountPercent,
        finalPriceInCents: pricing.finalPriceCents,
        platformFeeInCents,
      });

      // TODO: Implement à la carte checkout session creation in stripeService
      // For now, return the purchase record without a Stripe checkout URL
      // This will be completed when the Stripe integration for à la carte is ready
      console.log(`Created ala carte purchase ${purchase.id} for service ${serviceId}`);

      res.json({ 
        purchaseId: purchase.id,
        message: "À la carte checkout is being set up. Please contact support for manual processing.",
        pricing: {
          basePriceCents: pricing.basePriceCents,
          discountPercent: pricing.discountPercent,
          finalPriceCents: pricing.finalPriceCents,
          platformFeeInCents,
        }
      });
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

  // Unified search across products, services, businesses, photographers
  // Supports personalization based on user's onboarding preferences (selectedIndustries, industryNiches)
  app.get("/api/unified-search", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const { 
        q, 
        city, 
        category, 
        types, 
        lat, 
        lng,
        limit,
        offset,
        personalized // If "true", boost results matching user's preferences
      } = req.query;

      const entityTypes = types ? (types as string).split(',') : undefined;

      // Use provided lat/lng from query params
      let userLatitude = lat ? parseFloat(lat as string) : undefined;
      let userLongitude = lng ? parseFloat(lng as string) : undefined;

      // User preferences for personalized search
      let userPreferences: {
        selectedIndustries?: string[];
        industryNiches?: Record<string, string[]>;
        industryValues?: Record<string, string[]>;
      } | undefined;

      // If lat/lng not provided OR personalization enabled, fetch user data
      const userId = authReq.user?.userId || req.session?.userId;
      if (userId) {
        const user = await storage.getUser(userId);
        if (user) {
          // Use stored location as fallback if not provided
          if (userLatitude === undefined || userLongitude === undefined) {
            if (user.latitude && user.longitude) {
              userLatitude = user.latitude;
              userLongitude = user.longitude;
            }
          }

          // Get user preferences for personalized ranking
          // Default to personalized=true for authenticated users unless explicitly disabled
          const enablePersonalization = personalized !== 'false';
          if (enablePersonalization) {
            userPreferences = {
              selectedIndustries: user.selectedIndustries || [],
              industryNiches: user.industryNiches || {},
              industryValues: user.industryValues || {},
            };
          }
        }
      }

      // Check if user is admin (admins can see demo data)
      // Note: user may already be fetched above, but we only need the isAdmin flag here
      let isAdmin = false;
      if (userId) {
        const userForAdmin = await storage.getUser(userId);
        isAdmin = userForAdmin?.isAdmin || false;
      }

      const results = await storage.unifiedSearch({
        query: q as string | undefined,
        city: city as string | undefined,
        category: category as string | undefined,
        entityTypes,
        userLatitude,
        userLongitude,
        userPreferences,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
        isAdmin,
      });

      res.json(results);
    } catch (error) {
      console.error("Unified search error:", error);
      res.status(500).json({ error: "Failed to search" });
    }
  });

  // Admin: Rebuild search index
  app.post("/api/admin/rebuild-search-index", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(userId);
    if (!user?.isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      await storage.rebuildSearchIndex();
      res.json({ success: true, message: "Search index rebuilt successfully" });
    } catch (error) {
      console.error("Rebuild search index error:", error);
      res.status(500).json({ error: "Failed to rebuild search index" });
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
      
      // Server-side filtering: only return approved, non-demo, Stripe-complete, subscription-active businesses
      const visibleBusinesses = [];
      for (const business of businesses) {
        if (await isBusinessVisibleToPublic(business)) {
          visibleBusinesses.push(business);
        }
      }
      
      const businessDTOs = await Promise.all(
        visibleBusinesses.map(async (business) => {
          const [followerCount, followingCount] = await Promise.all([
            storage.getFollowerCount(business.ownerId),
            storage.getFollowingCount(business.ownerId),
          ]);
          return toPublicBusinessDTO(business, { followerCount, followingCount });
        })
      );

      res.json({ businesses: businessDTOs });
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
      
      // Server-side filtering: check visibility for public access
      if (!(await isBusinessVisibleToPublic(business))) {
        return res.status(404).json({ error: "This business is currently unavailable" });
      }

      // Social counts — derived from the follows table, keyed on the owner's users.id
      const [followerCount, followingCount] = await Promise.all([
        storage.getFollowerCount(business.ownerId),
        storage.getFollowingCount(business.ownerId),
      ]);

      res.json({ business: toPublicBusinessDTO(business, { followerCount, followingCount }) });
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
      
      // Server-side filtering: check visibility for public access
      if (!(await isBusinessVisibleToPublic(business))) {
        return res.status(404).json({ error: "This business is currently unavailable" });
      }
      
      const products = await storage.getVendorProducts(req.params.id);
      // Only return active AND live products for public view
      const liveProducts = products.filter(p => p.isActive && p.status === 'live');
      res.json({ products: liveProducts });
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
      
      // Server-side filtering: check visibility for public access
      if (!(await isBusinessVisibleToPublic(business))) {
        return res.status(404).json({ error: "This business is currently unavailable" });
      }
      
      const services = await storage.getVendorServicesByBusiness(req.params.id);
      // Only return active AND live services for public view
      const liveServices = services.filter(s => s.isActive && s.status === 'live');
      res.json({ services: liveServices });
    } catch (error) {
      console.error("Get business services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  });

  // ==================== VENDOR STOREFRONT ROUTES ====================

  // Get current vendor's business
  app.get("/api/vendor/my-business", hybridAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found for this account" });
      }

      // Social counts — derived from the follows table; userId here is already the owner
      const [followerCount, followingCount] = await Promise.all([
        storage.getFollowerCount(userId),
        storage.getFollowingCount(userId),
      ]);

      res.json({ business: { ...business, followerCount, followingCount } });
    } catch (error) {
      console.error("Get vendor business error:", error);
      res.status(500).json({ error: "Failed to get business" });
    }
  });

  // Update vendor's business profile
  app.patch("/api/vendor/my-business", hybridAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found for this account" });
      }

      const { coverImage, coverMediaType, ...otherFields } = req.body;
      const updates: Record<string, any> = { ...otherFields };

      // Validate city/state (max 100 chars)
      if (updates.city !== undefined && updates.city !== null) {
        if (typeof updates.city !== 'string' || updates.city.length === 0 || updates.city.length > 100) {
          return res.status(400).json({ error: "city must be a non-empty string (max 100 chars)" });
        }
      }
      if (updates.state !== undefined && updates.state !== null) {
        if (typeof updates.state !== 'string' || updates.state.length === 0 || updates.state.length > 100) {
          return res.status(400).json({ error: "state must be a non-empty string (max 100 chars)" });
        }
      }

      // Validate contactPhone (digits, spaces, dashes, parens, +)
      if (updates.contactPhone !== undefined && updates.contactPhone !== null && updates.contactPhone !== '') {
        if (!/^[0-9\s\-\(\)\+\.]+$/.test(updates.contactPhone)) {
          return res.status(400).json({ error: "contactPhone must contain only digits, spaces, dashes, parentheses, or +" });
        }
      }

      // Validate contactEmail
      if (updates.contactEmail !== undefined && updates.contactEmail !== null && updates.contactEmail !== '') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.contactEmail)) {
          return res.status(400).json({ error: "contactEmail must be a valid email address" });
        }
      }

      // Validate websiteUrl
      if (updates.websiteUrl !== undefined && updates.websiteUrl !== null && updates.websiteUrl !== '') {
        try {
          new URL(updates.websiteUrl);
        } catch {
          return res.status(400).json({ error: "websiteUrl must be a valid URL" });
        }
      }

      // Validate storefront display toggles
      const booleanToggles = ['showResponseTime', 'showEmail', 'showPhone', 'showWebsite', 'showStoreHours', 'showAddress'] as const;
      for (const field of booleanToggles) {
        if (updates[field] !== undefined && typeof updates[field] !== 'boolean') {
          return res.status(400).json({ error: `${field} must be a boolean` });
        }
      }
      if (updates.responseTimeValue !== undefined) {
        if (typeof updates.responseTimeValue !== 'number' || updates.responseTimeValue < 1) {
          return res.status(400).json({ error: "responseTimeValue must be a positive number" });
        }
      }
      if (updates.responseTimeUnit !== undefined) {
        if (!['minutes', 'hours', 'business_days'].includes(updates.responseTimeUnit)) {
          return res.status(400).json({ error: "responseTimeUnit must be: minutes, hours, or business_days" });
        }
      }

      // Validate coverMediaType when coverImage is set (must be 'image' or 'video')
      if (coverMediaType !== undefined) {
        if (coverMediaType !== null && coverMediaType !== 'image' && coverMediaType !== 'video') {
          return res.status(400).json({ error: "coverMediaType must be 'image' or 'video'" });
        }
        updates.coverMediaType = coverMediaType;
      }
      
      // Require coverMediaType when setting coverImage
      if (coverImage !== undefined) {
        updates.coverImage = coverImage;
        if (coverImage !== null && coverMediaType === undefined) {
          return res.status(400).json({ error: "coverMediaType is required when setting coverImage" });
        }
      }

      const updated = await storage.updateBusiness(business.id, updates);

      // Sync hoursOfOperation to weeklyAvailability table as safety net
      // Supports both frontend format { open: true, start, end } and legacy format
      if (updates.hoursOfOperation) {
        await syncHoursOfOperationToWeeklyAvailability(
          'business',
          business.id,
          updates.hoursOfOperation as Record<string, any>
        );
      }

      res.json({ business: updated });
    } catch (error) {
      console.error("Update vendor business error:", error);
      res.status(500).json({ error: "Failed to update business" });
    }
  });

  // ==================== VENDOR AVAILABILITY CALENDAR ROUTES (Business & Photographer) ====================

  // Get vendor availability (for the current vendor - business or photographer)
  app.get("/api/vendor/availability", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { startDate, endDate } = req.query;
      
      // Check for business first
      const business = await storage.getBusinessByOwnerId(userId);
      if (business) {
        const availability = await storage.getBusinessAvailability(
          business.id,
          startDate as string | undefined,
          endDate as string | undefined
        );
        return res.json({ availability, vendorType: "business" });
      }
      
      // Check for photographer
      const photographer = await storage.getPhotographerByUserId(userId);
      if (photographer) {
        const availability = await storage.getPhotographerAvailability(
          photographer.id,
          startDate as string | undefined,
          endDate as string | undefined
        );
        return res.json({ availability, vendorType: "photographer" });
      }
      
      return res.status(404).json({ error: "No business or photographer profile found" });
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

  // Create availability slot (for business or photographer)
  app.post("/api/vendor/availability", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
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

      // Check for business first
      const business = await storage.getBusinessByOwnerId(userId);
      if (business) {
        const slot = await storage.createBusinessAvailability({
          businessId: business.id,
          ...validated,
        });
        return res.status(201).json({ slot, vendorType: "business" });
      }
      
      // Check for photographer
      const photographer = await storage.getPhotographerByUserId(userId);
      if (photographer) {
        const slot = await storage.createPhotographerAvailability({
          photographerId: photographer.id,
          ...validated,
        });
        return res.status(201).json({ slot, vendorType: "photographer" });
      }

      return res.status(404).json({ error: "No business or photographer profile found" });
    } catch (error) {
      console.error("Create availability slot error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create availability slot" });
    }
  });

  // Update availability slot (for business or photographer)
  app.patch("/api/vendor/availability/:slotId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
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

      // Check for business first
      const business = await storage.getBusinessByOwnerId(userId);
      if (business) {
        const existingSlot = await storage.getBusinessAvailabilitySlot(req.params.slotId);
        if (!existingSlot || existingSlot.businessId !== business.id) {
          return res.status(404).json({ error: "Slot not found" });
        }
        const updated = await storage.updateBusinessAvailability(req.params.slotId, validated);
        return res.json({ slot: updated, vendorType: "business" });
      }
      
      // Check for photographer
      const photographer = await storage.getPhotographerByUserId(userId);
      if (photographer) {
        const existingSlot = await storage.getPhotographerAvailabilitySlot(req.params.slotId);
        if (!existingSlot || existingSlot.photographerId !== photographer.id) {
          return res.status(404).json({ error: "Slot not found" });
        }
        const updated = await storage.updatePhotographerAvailability(req.params.slotId, validated);
        return res.json({ slot: updated, vendorType: "photographer" });
      }

      return res.status(404).json({ error: "No business or photographer profile found" });
    } catch (error) {
      console.error("Update availability slot error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to update availability slot" });
    }
  });

  // Delete availability slot (for business or photographer)
  app.delete("/api/vendor/availability/:slotId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      // Check for business first
      const business = await storage.getBusinessByOwnerId(userId);
      if (business) {
        const existingSlot = await storage.getBusinessAvailabilitySlot(req.params.slotId);
        if (!existingSlot || existingSlot.businessId !== business.id) {
          return res.status(404).json({ error: "Slot not found" });
        }
        await storage.deleteBusinessAvailability(req.params.slotId);
        return res.json({ success: true, vendorType: "business" });
      }
      
      // Check for photographer
      const photographer = await storage.getPhotographerByUserId(userId);
      if (photographer) {
        const existingSlot = await storage.getPhotographerAvailabilitySlot(req.params.slotId);
        if (!existingSlot || existingSlot.photographerId !== photographer.id) {
          return res.status(404).json({ error: "Slot not found" });
        }
        await storage.deletePhotographerAvailability(req.params.slotId);
        return res.json({ success: true, vendorType: "photographer" });
      }

      return res.status(404).json({ error: "No business or photographer profile found" });
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

  // Vendor eligibility — single source of truth for the frontend onboarding flow.
  // Returns exactly which gates remain before products/services can go live.
  app.get("/api/vendor/eligibility", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.json({
          success: true,
          data: {
            hasBusiness: false,
            requiresApproval: false,
            requiresPlanSelection: false,
            requiresOnboarding: false,
            requiresSubscription: false,
            canPublishProducts: false,
            canPublishServices: false,
            currentStep: 'no_business',
            approvalStatus: null,
            subscriptionStatus: null,
            stripeOnboardingComplete: false,
            currentTier: null,
          },
        });
      }

      const approvalStatus = (business as Record<string, unknown>).approvalStatus as string || 'pending';
      const isApproved = approvalStatus === 'approved';

      // Check Stripe onboarding (self-healing sync with Stripe API)
      let stripeOnboardingComplete = business.stripeOnboardingComplete || false;
      if (!stripeOnboardingComplete && business.stripeAccountId) {
        stripeOnboardingComplete = await stripeService.syncOnboardingStatus({
          entityType: 'business',
          entityId: business.id,
          stripeAccountId: business.stripeAccountId,
          currentOnboardingComplete: false,
          updateFn: (id: string, data: Record<string, unknown>) => storage.updateBusiness(id, data),
        });
      }

      // Check subscription via vendor_subscriptions table (NOT businesses.subscriptionActive)
      const subscription = await storage.getVendorSubscriptionByBusinessId(business.id);
      const hasPlanSelected = !!subscription;

      // A subscription with a stripeSubscriptionId that isn't in a terminal/failed state
      // is treated as provisioned — even if the webhook hasn't fired yet to set 'active'
      const rawSubStatus = (subscription?.status || '').toLowerCase();
      const hasProvisionedSub =
        !!subscription?.stripeSubscriptionId &&
        rawSubStatus !== 'canceled' &&
        rawSubStatus !== 'incomplete_expired' &&
        rawSubStatus !== 'unpaid';

      const canPublish = isApproved && hasProvisionedSub && stripeOnboardingComplete;

      // Determine current onboarding step for frontend routing
      let currentStep = 'complete';
      if (!isApproved) currentStep = 'awaiting_approval';
      else if (!hasPlanSelected) currentStep = 'select_plan';
      else if (!business.stripeAccountId) currentStep = 'stripe_onboarding';
      else if (!stripeOnboardingComplete) currentStep = 'stripe_onboarding';
      else if (!hasProvisionedSub) currentStep = 'subscription_pending';

      // Get current tier info if subscription exists
      let currentTier: { id: string; name: string; displayName: string; priceInCents: number } | null = null;
      if (subscription?.tierId) {
        const tiers = await stripeService.getSubscriptionTiers();
        const tier = tiers.find((t: { id: string }) => t.id === subscription.tierId);
        if (tier) {
          currentTier = { id: tier.id, name: tier.name, displayName: tier.displayName, priceInCents: tier.priceInCents };
        }
      }

      res.json({
        success: true,
        data: {
          hasBusiness: true,
          businessId: business.id,
          businessName: business.name,

          // Gates (ordered — frontend should check top to bottom)
          requiresApproval: !isApproved,
          requiresPlanSelection: isApproved && !hasPlanSelected,
          requiresOnboarding: isApproved && hasPlanSelected && !stripeOnboardingComplete,
          requiresSubscription: !hasProvisionedSub,
          canPublishProducts: canPublish,
          canPublishServices: canPublish,

          // Current step for frontend routing
          currentStep,

          // Raw status fields
          approvalStatus,
          subscriptionStatus: hasProvisionedSub ? (rawSubStatus || 'active') : (subscription?.status || 'none'),
          stripeOnboardingComplete,
          hasStripeAccount: !!business.stripeAccountId,
          currentTier,
        },
      });
    } catch (error) {
      console.error("Vendor eligibility error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to check eligibility' } });
    }
  });

  // Get vendor's products
  app.get("/api/vendor/products", async (req, res) => {
    const userId = getUserIdFromRequest(req);
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
      // Vendors can create products before subscribing (content hidden until subscription active)
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const productSchema = z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        price: z.number().min(700, "Price must be at least $7.00"),
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
      // Vendors can update products before subscribing (content hidden until subscription active)
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
        price: z.number().min(700, "Price must be at least $7.00").optional(),
        compareAtPrice: z.number().nullable().optional(),
        imageUrl: z.string().nullable().optional(),
        images: z.array(z.string()).optional(),
        category: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        inventory: z.number().optional(),
        trackInventory: z.boolean().optional(),
        isActive: z.boolean().optional(),
        isFeatured: z.boolean().optional(),
        status: z.enum(['draft', 'live', 'paused', 'archived']).optional(),
      });

      const validated = updateSchema.parse(req.body);
      
      // Handle Stripe catalog updates for live products.
      let stripeUpdates: any = {};
      if (product.status === 'live' && product.stripeProductId) {
        // Name/description/image sync (metadata only — no provisioning, no gates).
        if (validated.name || validated.description !== undefined || validated.images !== undefined) {
          await stripeService.updateStripeProduct(product.stripeProductId, {
            name: validated.name || product.name,
            description: validated.description !== undefined ? (validated.description || undefined) : (product.description || undefined),
            images: validated.images || product.images || (product.imageUrl ? [product.imageUrl] : undefined),
          });
        }

        // Price change: route through the chokepoint so the new Price is created on
        // the vendor's Connect account, the old Price is archived, and auth gates are
        // re-enforced (subscription lapse should block even a price edit).
        if (validated.price !== undefined && validated.price !== product.price) {
          try {
            const priceResult = await authorizeAndProvisionGoLive(
              { ...product, price: validated.price },
              business,
              'product',
            );
            stripeUpdates.stripePriceId = priceResult.stripePriceId;
          } catch (err) {
            if (err instanceof GoLiveError) {
              return res.status(409).json({ code: err.code, message: err.message });
            }
            throw err;
          }
        }
      }

      const updated = await storage.updateVendorProduct(req.params.id, { ...validated, ...stripeUpdates });
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
      // Vendors can delete products before subscribing (content hidden until subscription active)
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

  // Go Live - Publish vendor product to Stripe
  app.post("/api/vendor/products/:id/go-live", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      // Approval gate (separate from Connect/subscription — remains a 403)
      if ((business as any).approvalStatus !== 'approved') {
        return res.status(403).json({
          error: "Business not approved",
          message: "Your business application must be approved before you can publish products. Please wait for admin approval.",
          requiresApproval: true,
        });
      }

      const product = await storage.getVendorProduct(req.params.id);
      if (!product || product.businessId !== business.id) {
        return res.status(404).json({ error: "Product not found" });
      }

      // Single chokepoint: enforces Connect onboarding + active subscription, then
      // provisions (or idempotently reuses) the Stripe Product+Price on the vendor's
      // own Connect account. Throws GoLiveError on gate failure.
      let provisionResult: { stripeProductId: string; stripePriceId: string };
      try {
        provisionResult = await authorizeAndProvisionGoLive(product, business, 'product');
      } catch (err) {
        if (err instanceof GoLiveError) {
          return res.status(409).json({ code: err.code, message: err.message });
        }
        throw err;
      }

      // Persist Stripe IDs and mark live.
      const updated = await storage.updateVendorProduct(product.id, {
        status: 'live',
        stripeProductId: provisionResult.stripeProductId,
        stripePriceId: provisionResult.stripePriceId,
      });

      res.json({ product: updated, message: "Product is now live" });
    } catch (error) {
      console.error("Go live vendor product error:", error);
      res.status(500).json({ error: "Failed to publish product" });
    }
  });

  // Archive vendor product (set status to archived)
  app.post("/api/vendor/products/:id/archive", async (req, res) => {
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

      // Archive in Stripe if it exists
      if (product.stripeProductId) {
        await stripeService.archiveStripeProduct(product.stripeProductId);
      }
      // Deactivate the price if it exists
      if (product.stripePriceId) {
        await stripeService.deactivateStripePrice(product.stripePriceId);
      }

      // Clear Stripe IDs and set status to archived
      const updated = await storage.updateVendorProduct(product.id, {
        status: 'archived',
        stripePriceId: null,
      });

      res.json({ product: updated, message: "Product archived" });
    } catch (error) {
      console.error("Archive vendor product error:", error);
      res.status(500).json({ error: "Failed to archive product" });
    }
  });

  // Get vendor's services
  app.get("/api/vendor/services", async (req, res) => {
    const userId = getUserIdFromRequest(req);
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
      // Vendors can create services before subscribing (content hidden until subscription active)
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const serviceSchema = z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        price: z.number().min(700, "Price must be at least $7.00"),
        durationMinutes: z.number().min(5),
        category: z.string().nullable().optional(),
        isActive: z.boolean().optional(),
        isFeatured: z.boolean().optional(),
        fullRefundWindow: z.enum(['1_week', '48_hours', '24_hours', '1_hour', 'never']).optional(),
        hasPartialRefund: z.boolean().optional(),
        partialRefundWindow: z.enum(['1_week', '48_hours', '24_hours', '1_hour', 'never']).nullable().optional(),
        partialRefundPercentage: z.number().int().min(0).max(100).nullable().optional(),
        hasCancellationFee: z.boolean().optional(),
        cancellationFeeType: z.enum(['flat', 'percentage']).nullable().optional(),
        cancellationFeeAmount: z.number().int().min(0).nullable().optional(),
        serviceLocationType: z.enum(['business', 'alternate', 'customer', 'virtual']).optional(),
        alternateAddress: z.string().nullable().optional(),
        alternateCity: z.string().nullable().optional(),
        alternateState: z.string().nullable().optional(),
        alternateZipCode: z.string().nullable().optional(),
        virtualLink: z.string().nullable().optional(),
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
      // Vendors can update services before subscribing (content hidden until subscription active)
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
        price: z.number().min(700, "Price must be at least $7.00").optional(),
        durationMinutes: z.number().min(5).optional(),
        category: z.string().nullable().optional(),
        isActive: z.boolean().optional(),
        isFeatured: z.boolean().optional(),
        status: z.enum(["draft", "live", "paused", "archived"]).optional(),
        fullRefundWindow: z.enum(['1_week', '48_hours', '24_hours', '1_hour', 'never']).optional(),
        hasPartialRefund: z.boolean().optional(),
        partialRefundWindow: z.enum(['1_week', '48_hours', '24_hours', '1_hour', 'never']).nullable().optional(),
        partialRefundPercentage: z.number().int().min(0).max(100).nullable().optional(),
        hasCancellationFee: z.boolean().optional(),
        cancellationFeeType: z.enum(['flat', 'percentage']).nullable().optional(),
        cancellationFeeAmount: z.number().int().min(0).nullable().optional(),
        serviceLocationType: z.enum(['business', 'alternate', 'customer', 'virtual']).optional(),
        alternateAddress: z.string().nullable().optional(),
        alternateCity: z.string().nullable().optional(),
        alternateState: z.string().nullable().optional(),
        alternateZipCode: z.string().nullable().optional(),
        virtualLink: z.string().nullable().optional(),
      });

      const validated = updateSchema.parse(req.body);

      // Handle Stripe catalog updates for live services.
      let stripeUpdates: any = {};
      if (service.status === 'live' && service.stripeProductId) {
        // Name/description sync (metadata only — no provisioning, no gates).
        if (validated.name || validated.description !== undefined) {
          await stripeService.updateStripeProduct(service.stripeProductId, {
            name: validated.name || service.name,
            description: validated.description !== undefined ? (validated.description || undefined) : (service.description || undefined),
          });
        }

        // Price change: route through the chokepoint so the new Price is created on
        // the vendor's Connect account, the old Price is archived, and auth gates are
        // re-enforced (subscription lapse should block even a price edit).
        if (validated.price !== undefined && validated.price !== service.price) {
          try {
            const priceResult = await authorizeAndProvisionGoLive(
              { ...service, price: validated.price },
              business,
              'service',
            );
            stripeUpdates.stripePriceId = priceResult.stripePriceId;
          } catch (err) {
            if (err instanceof GoLiveError) {
              return res.status(409).json({ code: err.code, message: err.message });
            }
            throw err;
          }
        }
      }

      const updated = await storage.updateVendorService(req.params.id, { ...validated, ...stripeUpdates });
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
      // Vendors can delete services before subscribing (content hidden until subscription active)
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

  // Go Live - Publish vendor service to Stripe
  app.post("/api/vendor/services/:id/go-live", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      // Approval gate (separate from Connect/subscription — remains a 403)
      if ((business as any).approvalStatus !== 'approved') {
        return res.status(403).json({
          error: "Business not approved",
          message: "Your business application must be approved before you can publish services. Please wait for admin approval.",
          requiresApproval: true,
        });
      }

      const service = await storage.getVendorService(req.params.id);
      if (!service || service.businessId !== business.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      // Single chokepoint: enforces Connect onboarding + active subscription, then
      // provisions (or idempotently reuses) the Stripe Product+Price on the vendor's
      // own Connect account. Throws GoLiveError on gate failure.
      let provisionResult: { stripeProductId: string; stripePriceId: string };
      try {
        provisionResult = await authorizeAndProvisionGoLive(service, business, 'service');
      } catch (err) {
        if (err instanceof GoLiveError) {
          return res.status(409).json({ code: err.code, message: err.message });
        }
        throw err;
      }

      // Persist Stripe IDs and mark live.
      const updated = await storage.updateVendorService(service.id, {
        status: 'live',
        stripeProductId: provisionResult.stripeProductId,
        stripePriceId: provisionResult.stripePriceId,
      });

      res.json({ service: updated, message: "Service is now live" });
    } catch (error) {
      console.error("Go live vendor service error:", error);
      res.status(500).json({ error: "Failed to publish service" });
    }
  });

  // Archive vendor service
  app.post("/api/vendor/services/:id/archive", async (req, res) => {
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

      // Archive in Stripe if it exists
      if (service.stripeProductId) {
        await stripeService.archiveStripeProduct(service.stripeProductId);
      }
      // Deactivate the price if it exists
      if (service.stripePriceId) {
        await stripeService.deactivateStripePrice(service.stripePriceId);
      }

      // Clear Stripe IDs and set status to archived
      const updated = await storage.updateVendorService(service.id, {
        status: 'archived',
        stripePriceId: null,
      });

      res.json({ service: updated, message: "Service archived" });
    } catch (error) {
      console.error("Archive vendor service error:", error);
      res.status(500).json({ error: "Failed to archive service" });
    }
  });

  // Apply one service's cancellation policy to all other services for this business
  app.post("/api/vendor/services/:id/apply-cancellation-policy-to-all", async (req, res) => {
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

      const policy = {
        fullRefundWindow: service.fullRefundWindow ?? null,
        hasPartialRefund: service.hasPartialRefund ?? false,
        partialRefundWindow: service.partialRefundWindow ?? null,
        partialRefundPercentage: service.partialRefundPercentage ?? null,
        hasCancellationFee: service.hasCancellationFee ?? false,
        cancellationFeeType: service.cancellationFeeType ?? null,
        cancellationFeeAmount: service.cancellationFeeAmount ?? null,
      };

      const [updatedCount] = await Promise.all([
        storage.updateAllVendorServicesCancellationPolicy(business.id, service.id, policy),
        storage.updateBusiness(business.id, policy),
      ]);

      res.json({ success: true, updatedCount });
    } catch (error) {
      console.error("Apply cancellation policy to all error:", error);
      res.status(500).json({ error: "Failed to apply cancellation policy" });
    }
  });

  // ==================== STAFF MANAGEMENT ROUTES ====================

  // Get all staff members for a business (owner/manager only)
  app.get("/api/vendor/staff", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found for this account" });
      }

      const staff = await storage.getStaffMembersByBusiness(business.id);
      res.json({ staff });
    } catch (error) {
      console.error("Get staff error:", error);
      res.status(500).json({ error: "Failed to get staff members" });
    }
  });

  // Stripe Connect redirect stubs for the auto-onboarding flow triggered by acceptStaffInvite.
  // Registered before /:staffId to prevent path shadowing.
  // Full redirect UX (deep-link back to staff dashboard) is a follow-up task.
  app.get("/api/vendor/staff/connect/refresh", (req, res) => {
    const { staffId } = req.query;
    console.log(`[stripe] Staff Connect onboarding refresh — staffId=${staffId}`);
    res.redirect("/vendor-dashboard");
  });

  app.get("/api/vendor/staff/connect/return", (req, res) => {
    const { staffId } = req.query;
    console.log(`[stripe] Staff Connect onboarding return — staffId=${staffId}`);
    res.redirect("/vendor-dashboard");
  });

  // Get pending invites for a business (must be registered before /:staffId to avoid shadowing)
  app.get("/api/vendor/staff/invites", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const invites = await storage.getStaffInvitesByBusiness(business.id);

      // Self-heal: a pending invite past its expiresAt is effectively dead even
      // though nothing has written status="expired" yet (that normally only
      // happens lazily, on an accept attempt). Never show it as "pending" here.
      const effectiveInvites = await Promise.all(
        invites.map(async (invite) => {
          if (!isInviteExpired(invite)) {
            return invite;
          }
          const updated = await storage.updateStaffInvite(invite.id, { status: "expired" });
          return updated || { ...invite, status: "expired" };
        })
      );

      res.json({ invites: effectiveInvites });
    } catch (error) {
      console.error("Get staff invites error:", error);
      res.status(500).json({ error: "Failed to get invites" });
    }
  });

  // Get current seat usage for a business (must be registered before /:staffId to avoid shadowing).
  // Read-only — lets the dashboard show seat usage at all times, not just at invite time (B5/F5).
  app.get("/api/vendor/staff/seat-status", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const activeCount = await storage.getActiveStaffCount(business.id);
      const tier = await getSubscriptionTierForBusiness(business.id);
      const allInvites = await storage.getStaffInvitesByBusiness(business.id);
      const pendingCount = allInvites.filter(
        (inv: StaffInvite) => inv.status === "pending" && !isInviteExpired(inv)
      ).length;
      const usedSeats = activeCount + pendingCount;

      res.json({
        activeCount,
        pendingCount,
        usedSeats,
        maxStaff: tier?.maxStaff ?? null,
        tierName: tier?.displayName ?? "Unknown",
      });
    } catch (error) {
      console.error("Get staff seat status error:", error);
      res.status(500).json({ error: "Failed to get seat status" });
    }
  });

  // Get single staff member details
  app.get("/api/vendor/staff/:staffId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found for this account" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      res.json({ staff });
    } catch (error) {
      console.error("Get staff member error:", error);
      res.status(500).json({ error: "Failed to get staff member" });
    }
  });

  // Create a new staff member (owner only)
  app.post("/api/vendor/staff", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found for this account" });
      }

      const staffSchema = z.object({
        displayName: z.string().min(1, "Name is required"),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        bio: z.string().optional(),
        profileImageUrl: z.string().optional(),
        serviceIds: z.array(z.string()).optional(),
        specialties: z.array(z.string()).optional(),
        role: z.enum(["staff", "manager", "owner"]).optional(),
        hoursOfOperation: z.any().optional(),
      });

      const validated = staffSchema.parse(req.body);

      const staff = await storage.createStaffMember({
        businessId: business.id,
        displayName: validated.displayName,
        email: validated.email,
        phone: validated.phone,
        bio: validated.bio,
        profileImageUrl: validated.profileImageUrl,
        serviceIds: validated.serviceIds,
        specialties: validated.specialties,
        role: validated.role || "staff",
        status: "active",
        hoursOfOperation: validated.hoursOfOperation,
      });

      res.status(201).json({ staff });
    } catch (error) {
      console.error("Create staff error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create staff member" });
    }
  });

  // Update a staff member
  app.patch("/api/vendor/staff/:staffId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found for this account" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      const updateSchema = z.object({
        displayName: z.string().optional(),
        email: z.string().email().optional().nullable(),
        phone: z.string().optional().nullable(),
        bio: z.string().optional().nullable(),
        profileImageUrl: z.string().optional().nullable(),
        serviceIds: z.array(z.string()).optional(),
        specialties: z.array(z.string()).optional(),
        role: z.enum(["staff", "manager", "owner"]).optional(),
        status: z.enum(["active", "inactive", "pending", "archived"]).optional(),
        hoursOfOperation: z.any().optional(),
      });

      const validated = updateSchema.parse(req.body);
      const updated = await storage.updateStaffMember(staff.id, validated);

      res.json({ staff: updated });
    } catch (error) {
      console.error("Update staff error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to update staff member" });
    }
  });

  // Offboard a staff member — soft-archive, not a hard delete. Existing
  // appointments/availability rows stay untouched; every call site that gates
  // on status === "active" simply stops matching this row (G6).
  app.delete("/api/vendor/staff/:staffId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found for this account" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      const archived = await storage.updateStaffMember(staff.id, { status: "archived" });
      res.json({ staff: archived, message: "Staff member archived" });
    } catch (error) {
      console.error("Archive staff error:", error);
      res.status(500).json({ error: "Failed to archive staff member" });
    }
  });

  // ==================== STAFF AVAILABILITY ROUTES ====================

  // Get staff member's availability
  app.get("/api/vendor/staff/:staffId/availability", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      const { startDate, endDate } = req.query;
      const availability = await storage.getStaffAvailability(
        staff.id,
        startDate as string | undefined,
        endDate as string | undefined
      );

      res.json({ availability });
    } catch (error) {
      console.error("Get staff availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  });

  // Create staff availability slot
  app.post("/api/vendor/staff/:staffId/availability", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
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

      const slot = await storage.createStaffAvailability({
        staffMemberId: staff.id,
        businessId: business.id,
        ...validated,
      });

      res.status(201).json({ slot });
    } catch (error) {
      console.error("Create staff availability error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create availability slot" });
    }
  });

  // Update staff availability slot
  app.patch("/api/vendor/staff/:staffId/availability/:slotId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      const slot = await storage.getStaffAvailabilitySlot(req.params.slotId);
      if (!slot || slot.staffMemberId !== staff.id) {
        return res.status(404).json({ error: "Availability slot not found" });
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
      const updated = await storage.updateStaffAvailability(slot.id, validated);

      res.json({ slot: updated });
    } catch (error) {
      console.error("Update staff availability error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to update availability" });
    }
  });

  // Delete staff availability slot
  app.delete("/api/vendor/staff/:staffId/availability/:slotId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      const slot = await storage.getStaffAvailabilitySlot(req.params.slotId);
      if (!slot || slot.staffMemberId !== staff.id) {
        return res.status(404).json({ error: "Availability slot not found" });
      }

      await storage.deleteStaffAvailability(slot.id);
      res.json({ message: "Availability slot deleted" });
    } catch (error) {
      console.error("Delete staff availability error:", error);
      res.status(500).json({ error: "Failed to delete availability" });
    }
  });

  // ==================== STAFF INVITE ROUTES ====================

  // Create a staff invite
  app.post("/api/vendor/staff/invites", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      // Hard seat-limit block for capped tiers: count active + pending invites.
      // Pending invites claim a seat even before the invitee signs up, so a vendor
      // at cap should not be able to send additional invites.
      const tier = await getSubscriptionTierForBusiness(business.id);
      if (tier && tier.maxStaff != null) {
        const activeCount = await storage.getActiveStaffCount(business.id);
        const allInvites = await storage.getStaffInvitesByBusiness(business.id);
        const pendingCount = allInvites.filter(
          (inv: StaffInvite) => inv.status === "pending" && !isInviteExpired(inv)
        ).length;
        const usedSeats = activeCount + pendingCount;
        if (usedSeats >= tier.maxStaff) {
          return res.status(403).json({
            error: `Seat limit reached. You're using ${usedSeats} of ${tier.maxStaff} seats on ${tier.displayName}. Upgrade to add more team members.`,
          });
        }
      }

      // Soft seat-limit nudge (warning returned after invite is created, not a block).
      const seatWarning = await getStaffSeatWarning(business.id);

      const inviteSchema = z.object({
        email: z.string().email("Valid email is required"),
        role: z.enum(["staff", "manager"]).optional(),
        phone: z.string().optional(),
      });

      const validated = inviteSchema.parse(req.body);

      // Check if there's already a pending invite for this email — a pending
      // invite whose expiresAt has already passed is effectively dead and must
      // not block a fresh invite, even if its stored status hasn't caught up yet.
      const existingInvites = await storage.getStaffInvitesByBusiness(business.id);
      const emailInvites = existingInvites.filter((inv: StaffInvite) => inv.email === validated.email);
      const pendingInvite = emailInvites.find(
        (inv: StaffInvite) => inv.status === "pending" && !isInviteExpired(inv)
      );
      if (pendingInvite) {
        return res.status(400).json({ error: "An invite is already pending for this email" });
      }

      // Resend: reuse the most recent dead invite row (expired/revoked/stale
      // pending) instead of inserting a duplicate staff_invites row for the
      // same email at this business — same find-or-reactivate spirit as G7.
      // getStaffInvitesByBusiness is already ordered desc by createdAt, so the
      // first match here is the most recent one.
      const reusableInvite = emailInvites.find(
        (inv: StaffInvite) => inv.status === "revoked" || inv.status === "expired" || isInviteExpired(inv)
      );

      const invite = reusableInvite
        ? await storage.reactivateStaffInvite(reusableInvite.id, {
            phone: validated.phone ?? null,
            role: validated.role || "staff",
            invitedByUserId: userId,
          })
        : await storage.createStaffInvite({
            businessId: business.id,
            email: validated.email,
            phone: validated.phone ?? null,
            role: validated.role || "staff",
            invitedByUserId: userId,
          });

      if (!invite) {
        return res.status(500).json({ error: "Failed to create invite" });
      }

      // Send invite email — invite row persists regardless of send outcome
      const { sent, error: sendError } = await sendStaffInviteEmail(
        invite.email,
        business.name || "Outsyde Business",
        invite.inviteCode,
        invite.role || "staff",
      );

      if (sent) {
        await storage.updateStaffInvite(invite.id, { sentAt: new Date() });
        invite.sentAt = new Date();
      } else {
        console.warn(`[staff/invites] Email not sent for invite ${invite.id}: ${sendError}`);
      }

      res.status(201).json({ invite, sent, seatWarning });
    } catch (error) {
      console.error("Create staff invite error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create invite" });
    }
  });

  // Revoke a staff invite
  app.delete("/api/vendor/staff/invites/:inviteId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const invite = await storage.getStaffInvite(req.params.inviteId);
      if (!invite || invite.businessId !== business.id) {
        return res.status(404).json({ error: "Invite not found" });
      }

      await storage.updateStaffInvite(invite.id, { status: "revoked" });
      res.json({ message: "Invite revoked" });
    } catch (error) {
      console.error("Revoke staff invite error:", error);
      res.status(500).json({ error: "Failed to revoke invite" });
    }
  });

  // Public preview of a staff invite — no auth required
  app.get("/api/staff/invites/:code", async (req, res) => {
    try {
      const { code } = req.params;
      const preview = await storage.getStaffInviteWithContext(code);
      if (!preview) {
        return res.status(404).json({ error: "Invalid invite code" });
      }
      res.json(preview);
    } catch (error) {
      console.error("Get staff invite preview error:", error);
      res.status(500).json({ error: "Failed to get invite details" });
    }
  });

  // Accept a staff invite (explicit accept by an already-registered, logged-in user)
  app.post("/api/staff/accept-invite", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const acceptSchema = z.object({
        inviteCode: z.string().min(1, "Invite code is required"),
      });

      const { inviteCode } = acceptSchema.parse(req.body);

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const result = await acceptStaffInvite(inviteCode, user);
      if (!result.success) {
        return res.status(result.statusCode).json({ error: result.error });
      }

      res.json({ message: "Invite accepted", staff: result.staff });
    } catch (error) {
      console.error("Accept staff invite error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to accept invite" });
    }
  });

  // ==================== STAFF STRIPE CONNECT ROUTES ====================

  // Get staff member's Stripe onboarding status
  app.get("/api/vendor/staff/:staffId/stripe-status", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      res.json({
        hasStripeAccount: !!staff.stripeAccountId,
        stripeOnboardingComplete: staff.stripeOnboardingComplete || false,
      });
    } catch (error) {
      console.error("Get staff Stripe status error:", error);
      res.status(500).json({ error: "Failed to get Stripe status" });
    }
  });

  // Create Stripe Connect account for staff member
  app.post("/api/vendor/staff/:staffId/stripe-connect", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      if (staff.stripeAccountId) {
        return res.status(400).json({ error: "Staff member already has a Stripe account" });
      }

      // Create Stripe Express account using the staff-specific function so
      // capabilities (transfers-only), MCC, and metadata (role:"staff") are correct.
      // This matters for the account.updated webhook — metadata.role="staff" must
      // match for the staff branch to trigger without falling to the fallback lookup.
      const account = await stripeService.createStaffConnectAccount(
        staff.email || `staff-${staff.id}@outsyde.app`,
        staff.id,
        business.id,
        staff.displayName,
      );

      // Generate onboarding link using the same redirect routes as the auto-accept path.
      const appBaseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
      const accountLink = await stripeService.createConnectOnboardingLink(
        account.id,
        `${appBaseUrl}/api/vendor/staff/connect/refresh?staffId=${staff.id}`,
        `${appBaseUrl}/api/vendor/staff/connect/return?staffId=${staff.id}`,
      );

      // Update staff record with Stripe account ID
      await storage.updateStaffMember(staff.id, {
        stripeAccountId: account.id,
        stripeOnboardingComplete: false,
        stripeOnboardingUrl: accountLink.url,
      });

      res.json({ onboardingUrl: accountLink.url });
    } catch (error) {
      console.error("Create staff Stripe account error:", error);
      res.status(500).json({ error: "Failed to create Stripe account" });
    }
  });

  // Get fresh onboarding link for staff member
  app.get("/api/vendor/staff/:staffId/stripe-onboarding-link", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) {
        return res.status(404).json({ error: "No business found" });
      }

      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== business.id) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      if (!staff.stripeAccountId) {
        return res.status(400).json({ error: "Staff member does not have a Stripe account" });
      }

      // Generate fresh onboarding link
      const accountLink = await stripeService.createConnectOnboardingLink(
        staff.stripeAccountId,
        `${req.protocol}://${req.get('host')}/staff/onboarding/refresh?staffId=${staff.id}`,
        `${req.protocol}://${req.get('host')}/staff/onboarding/complete?staffId=${staff.id}`
      );

      await storage.updateStaffMember(staff.id, {
        stripeOnboardingUrl: accountLink.url,
      });

      res.json({ onboardingUrl: accountLink.url });
    } catch (error) {
      console.error("Get staff Stripe onboarding link error:", error);
      res.status(500).json({ error: "Failed to get onboarding link" });
    }
  });

  // Public endpoint: Get staff members for a business (for customer booking)
  app.get("/api/businesses/:businessId/staff", async (req, res) => {
    try {
      const staff = await storage.getStaffMembersByBusiness(req.params.businessId);

      // Only return active staff with completed Stripe onboarding and at least one live staff service.
      const activeBase = staff.filter((s: StaffMember & { username: string | null }) =>
        s.status === "active" && s.stripeOnboardingComplete
      );
      const liveServiceFlags = await Promise.all(
        activeBase.map((s: StaffMember & { username: string | null }) =>
          storage.hasLiveStaffServices(s.id)
        )
      );
      const activeStaff = activeBase.filter((_: unknown, i: number) => liveServiceFlags[i]);

      // Return sanitized staff info for public viewing
      const publicStaff = activeStaff.map((s: StaffMember & { username: string | null }) => ({
        id: s.id,
        displayName: s.displayName,
        username: s.username,
        bio: s.bio,
        profileImageUrl: s.profileImageUrl,
        specialties: s.specialties,
        serviceIds: s.serviceIds,
      }));

      res.json({ staff: publicStaff });
    } catch (error) {
      console.error("Get public staff error:", error);
      res.status(500).json({ error: "Failed to get staff members" });
    }
  });

  // Public endpoint: Get staff member availability (for customer booking)
  app.get("/api/businesses/:businessId/staff/:staffId/availability", async (req, res) => {
    try {
      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== req.params.businessId) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      // Same gate as the public staff listing endpoint (GET /api/businesses/:businessId/staff):
      // never expose availability for a staff member who isn't active, hasn't finished Stripe
      // onboarding, or has no live staff services.
      const hasLive = await storage.hasLiveStaffServices(staff.id);
      if (staff.status !== "active" || !staff.stripeOnboardingComplete || !hasLive) {
        return res.status(404).json({ error: "Staff member is not available" });
      }

      const { startDate, endDate } = req.query;
      const availability = await storage.getStaffAvailability(
        staff.id,
        startDate as string | undefined,
        endDate as string | undefined
      );

      res.json({ availability });
    } catch (error) {
      console.error("Get public staff availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  });

  // Public endpoint: Get live services for a staff member (for customer browsing)
  app.get("/api/businesses/:businessId/staff/:staffId/services", async (req, res) => {
    try {
      const staff = await storage.getStaffMember(req.params.staffId);
      if (!staff || staff.businessId !== req.params.businessId) {
        return res.status(404).json({ error: "Staff member not found" });
      }

      // Same three-part bookability gate as /availability and the public staff listing:
      // active status + Stripe onboarding complete + at least one live service.
      const hasLive = await storage.hasLiveStaffServices(staff.id);
      if (staff.status !== "active" || !staff.stripeOnboardingComplete || !hasLive) {
        return res.status(404).json({ error: "Staff member is not available" });
      }

      const rawServices = await storage.getLiveStaffServicesByStaffMember(staff.id);

      // Map to the same shape as GET /api/businesses/:id/services so the frontend
      // can reuse existing rendering logic without branching. The only field that
      // differs between the two tables is priceCents (staff) vs price (vendor).
      const services = rawServices.map((s) => ({
        id: s.id,
        staffMemberId: s.staffMemberId,
        businessId: s.businessId,
        name: s.name,
        description: s.description,
        category: s.category,
        price: s.priceCents,
        durationMinutes: s.durationMinutes,
        isActive: s.isActive,
        status: s.status,
        serviceLocationType: s.serviceLocationType,
        alternateAddress: s.alternateAddress,
        alternateCity: s.alternateCity,
        alternateState: s.alternateState,
        alternateZipCode: s.alternateZipCode,
        virtualLink: s.virtualLink,
        fullRefundWindow: s.fullRefundWindow,
        hasPartialRefund: s.hasPartialRefund,
        partialRefundWindow: s.partialRefundWindow,
        partialRefundPercentage: s.partialRefundPercentage,
        hasCancellationFee: s.hasCancellationFee,
        cancellationFeeType: s.cancellationFeeType,
        cancellationFeeAmount: s.cancellationFeeAmount,
        createdAt: s.createdAt,
      }));

      res.json({ services });
    } catch (error) {
      console.error("Get public staff services error:", error);
      res.status(500).json({ error: "Failed to get staff services" });
    }
  });

  // ==================== STAFF DASHBOARD ROUTES (Staff-facing) ====================
  // Note: These endpoints now support both JWT (Authorization header) and session-based auth

  // Get current user's staff profile
  app.get("/api/staff/me", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      res.json({ staff });
    } catch (error) {
      console.error("Get staff profile error:", error);
      res.status(500).json({ error: "Failed to get staff profile" });
    }
  });

  // Staff member's own assigned services. Deliberately does NOT go through
  // isBusinessVisibleToPublic() — that gate exists to hide incomplete storefronts
  // from customers, but a staff member viewing their own assigned services is an
  // authenticated self-access, not a public/customer-facing read. Without this,
  // a staff member at a business that hasn't finished Stripe onboarding (or lacks
  // an active subscription) would 404 trying to see their own services.
  app.get("/api/staff/my-services", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const services = await storage.getStaffServicesByStaffMember(staff.id);
      res.json({ services });
    } catch (error) {
      console.error("Get staff services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  });

  // ==================== STAFF SERVICE CRUD ====================

  const staffServiceCreateSchema = z.object({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    priceCents: z.number().int().min(700, "Price must be at least $7.00"),
    durationMinutes: z.number().int().min(5),
    serviceLocationType: z.enum(['business', 'alternate', 'customer', 'virtual']).optional(),
    alternateAddress: z.string().nullable().optional(),
    alternateCity: z.string().nullable().optional(),
    alternateState: z.string().nullable().optional(),
    alternateZipCode: z.string().nullable().optional(),
    virtualLink: z.string().nullable().optional(),
    fullRefundWindow: z.enum(['1_week', '48_hours', '24_hours', '1_hour', 'never']).optional(),
    hasPartialRefund: z.boolean().optional(),
    partialRefundWindow: z.enum(['1_week', '48_hours', '24_hours', '1_hour', 'never']).nullable().optional(),
    partialRefundPercentage: z.number().int().min(0).max(100).nullable().optional(),
    hasCancellationFee: z.boolean().optional(),
    cancellationFeeType: z.enum(['flat', 'percentage']).nullable().optional(),
    cancellationFeeAmount: z.number().int().min(0).nullable().optional(),
  });

  const staffServiceUpdateSchema = staffServiceCreateSchema.partial();

  // Create a staff service
  app.post("/api/staff/services", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const validated = staffServiceCreateSchema.parse(req.body);
      const service = await storage.createStaffService({
        ...validated,
        staffMemberId: staff.id,
        businessId: staff.businessId,
        status: 'draft',
      });

      res.json({ service });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create staff service error:", error);
      res.status(500).json({ error: "Failed to create service" });
    }
  });

  // Get a single staff service
  app.get("/api/staff/services/:id", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const service = await storage.getStaffService(req.params.id);
      if (!service || service.staffMemberId !== staff.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      res.json({ service });
    } catch (error) {
      console.error("Get staff service error:", error);
      res.status(500).json({ error: "Failed to get service" });
    }
  });

  // Update a staff service
  app.patch("/api/staff/services/:id", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const service = await storage.getStaffService(req.params.id);
      if (!service || service.staffMemberId !== staff.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      if (service.status === 'archived') {
        return res.status(409).json({ error: "Archived services cannot be edited" });
      }

      const validated = staffServiceUpdateSchema.parse(req.body);
      const updated = await storage.updateStaffService(req.params.id, validated);
      res.json({ service: updated });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update staff service error:", error);
      res.status(500).json({ error: "Failed to update service" });
    }
  });

  // Delete a staff service (draft or archived only)
  app.delete("/api/staff/services/:id", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const service = await storage.getStaffService(req.params.id);
      if (!service || service.staffMemberId !== staff.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      if (service.status === 'live') {
        return res.status(409).json({ error: "Cannot delete a live service — archive it first" });
      }

      await storage.deleteStaffService(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete staff service error:", error);
      res.status(500).json({ error: "Failed to delete service" });
    }
  });

  // Publish a staff service (draft → live)
  app.post("/api/staff/services/:id/go-live", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      if (staff.status !== 'active' || !staff.stripeOnboardingComplete) {
        return res.status(409).json({
          error: "Stripe onboarding must be completed before publishing services",
        });
      }

      const service = await storage.getStaffService(req.params.id);
      if (!service || service.staffMemberId !== staff.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      if (service.status === 'archived') {
        return res.status(409).json({ error: "Cannot publish an archived service" });
      }

      const updated = await storage.updateStaffService(req.params.id, { status: 'live' });
      res.json({ service: updated, message: "Service is now live" });
    } catch (error) {
      console.error("Go live staff service error:", error);
      res.status(500).json({ error: "Failed to publish service" });
    }
  });

  // Archive a staff service (live → archived)
  app.post("/api/staff/services/:id/archive", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const service = await storage.getStaffService(req.params.id);
      if (!service || service.staffMemberId !== staff.id) {
        return res.status(404).json({ error: "Service not found" });
      }

      if (service.status === 'archived') {
        return res.status(409).json({ error: "Service is already archived" });
      }

      const updated = await storage.updateStaffService(req.params.id, { status: 'archived' });
      res.json({ service: updated, message: "Service archived" });
    } catch (error) {
      console.error("Archive staff service error:", error);
      res.status(500).json({ error: "Failed to archive service" });
    }
  });

  // Get staff member's own bookings
  app.get("/api/staff/my-bookings", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const bookings = await storage.getAppointmentsByStaffMember(staff.id);
      res.json({ bookings });
    } catch (error) {
      console.error("Get staff bookings error:", error);
      res.status(500).json({ error: "Failed to get bookings" });
    }
  });

  // Get staff member's own availability
  app.get("/api/staff/my-availability", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const { startDate, endDate } = req.query;
      const availability = await storage.getStaffAvailability(
        staff.id,
        startDate as string | undefined,
        endDate as string | undefined
      );

      res.json({ availability });
    } catch (error) {
      console.error("Get staff availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  });

  // Add staff member's own availability
  app.post("/api/staff/my-availability", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const availabilitySchema = z.object({
        date: z.string().min(1, "Date is required"),
        startTime: z.string().min(1, "Start time is required"),
        endTime: z.string().min(1, "End time is required"),
        // Staff can self-create 'available' or 'blocked' slots only —
        // 'booked'/'break' stay system/owner-controlled.
        slotType: z.enum(["available", "blocked"]).optional().default("available"),
      });

      const data = availabilitySchema.parse(req.body);

      const availability = await storage.createStaffAvailability({
        staffMemberId: staff.id,
        businessId: staff.businessId,
        date: data.date,
        startTime: data.startTime,
        endTime: data.endTime,
        slotType: data.slotType,
      });

      res.status(201).json({ availability });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create staff availability error:", error);
      res.status(500).json({ error: "Failed to create availability" });
    }
  });

  // Delete staff member's own availability
  app.delete("/api/staff/my-availability/:id", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      // Get the availability slot to verify ownership
      const availabilitySlots = await storage.getStaffAvailability(staff.id);
      const slot = availabilitySlots.find(s => s.id === req.params.id);
      
      if (!slot) {
        return res.status(404).json({ error: "Availability slot not found" });
      }

      await storage.deleteStaffAvailability(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete staff availability error:", error);
      res.status(500).json({ error: "Failed to delete availability" });
    }
  });

  // ── Staff weekly (recurring) availability ──────────────────────────────────
  // These endpoints let a staff member manage their own recurring weekly schedule,
  // stored as staffMemberId-scoped rows in the weekly_availability table.
  // The hoursOfOperation sync is intentionally skipped — staff rows are excluded
  // from the business-wide sync that the business-owner PUT endpoint performs.

  // GET /api/staff/me/weekly-availability
  app.get("/api/staff/me/weekly-availability", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const availability = await storage.getWeeklyAvailability(
        "business",
        staff.businessId,
        staff.id
      );

      res.json({ availability });
    } catch (error) {
      console.error("Get staff weekly availability error:", error);
      res.status(500).json({ error: "Failed to get weekly availability" });
    }
  });

  // PUT /api/staff/me/weekly-availability
  app.put("/api/staff/me/weekly-availability", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const slotSchema = z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startTime: z.string().regex(/^\d{2}:\d{2}$/, "startTime must be HH:MM"),
        endTime: z.string().regex(/^\d{2}:\d{2}$/, "endTime must be HH:MM"),
        isActive: z.boolean().optional().default(true),
      });

      const bodySchema = z.object({
        slots: z.array(slotSchema),
      });

      const { slots } = bodySchema.parse(req.body);

      const availability = await storage.setWeeklyAvailability(
        "business",
        staff.businessId,
        slots,
        staff.id
      );

      res.json({ availability });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Set staff weekly availability error:", error);
      res.status(500).json({ error: "Failed to set weekly availability" });
    }
  });

  // Get staff member's earnings
  app.get("/api/staff/my-earnings", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      const bookings = await storage.getAppointmentsByStaffMember(staff.id);

      // Calculate earnings from completed bookings
      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      let total = 0;
      let thisMonth = 0;
      let pending = 0;

      for (const booking of bookings) {
        const payout = booking.staffPayout || 0;
        const bookingDate = new Date(booking.appointmentDate);

        if (booking.status === "completed") {
          total += payout;
          if (bookingDate >= thisMonthStart) {
            thisMonth += payout;
          }
        } else if (booking.status === "confirmed" || booking.status === "pending") {
          pending += payout;
        }
      }

      res.json({ total, thisMonth, pending });
    } catch (error) {
      console.error("Get staff earnings error:", error);
      res.status(500).json({ error: "Failed to get earnings" });
    }
  });

  // Staff member initiates their own Stripe onboarding
  app.post("/api/staff/stripe-onboarding/create-link", async (req, res) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const resolved = await resolveRequestingStaffMember(req, userId);
      if ("status" in resolved) {
        return res.status(resolved.status).json(resolved.body);
      }
      const staff = resolved.staff;

      let accountId = staff.stripeAccountId;

      // Create Stripe account if doesn't exist.
      // Must use createStaffConnectAccount (not the generic photographer alias) so
      // metadata.role="staff" is set — the webhook handler's staff branch depends on it.
      if (!accountId) {
        const account = await stripeService.createStaffConnectAccount(
          staff.email || `staff-${staff.id}@outsyde.app`,
          staff.id,
          staff.businessId,
          staff.displayName,
        );
        accountId = account.id;

        await storage.updateStaffMember(staff.id, {
          stripeAccountId: accountId,
          stripeOnboardingComplete: false,
        });
      }

      // Generate onboarding link.
      // Redirect URLs must be HTTPS (Stripe rejects custom-scheme deep links directly).
      // /api/stripe/connect-return and /api/stripe/connect-refresh bounce back into the
      // app via the outsyde:// deep link, passing type=staff so the app can distinguish
      // this from the vendor/business onboarding return.
      const baseUrl = process.env.API_BASE_URL || 'https://outsyde-backend.onrender.com';
      const accountLink = await stripeService.createConnectOnboardingLink(
        accountId,
        `${baseUrl}/api/stripe/connect-refresh?account=${accountId}&type=staff&staffId=${staff.id}`,
        `${baseUrl}/api/stripe/connect-return?account=${accountId}&type=staff&staffId=${staff.id}`,
      );

      await storage.updateStaffMember(staff.id, {
        stripeOnboardingUrl: accountLink.url,
      });

      res.json({ url: accountLink.url });
    } catch (error) {
      console.error("Staff Stripe onboarding error:", error);
      res.status(500).json({ error: "Failed to create onboarding link" });
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
      
      // Get unread counts per conversation
      const unreadCounts = await storage.getUnreadCountPerConversation(userId);
      
      // Sanitize user data and include unread count
      const sanitizedConversations = conversations.map(convo => ({
        ...convo,
        otherParticipant: {
          id: convo.otherParticipant.id,
          displayName: convo.otherParticipant.name || convo.otherParticipant.username,
          avatar: convo.otherParticipant.profileImageUrl,
          type: convo.otherParticipant.isPhotographer
            ? "photographer"
            : convo.otherParticipant.isVendor
              ? "business"
              : "consumer",
        },
        unreadCount: unreadCounts.get(convo.id) || 0,
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
        participantType: z.string().optional(),
        participantName: z.string().optional(),
        participantAvatar: z.string().optional(),
      });
      const parsed = createConvoSchema.parse(req.body);
      const participantId = parsed.participantId;
      const participantType = parsed.participantType || "user";

      console.log("DEBUG - Create conversation request:");
      console.log("DEBUG - participantId:", participantId);
      console.log("DEBUG - participantType (raw):", parsed.participantType);
      console.log("DEBUG - participantType (resolved):", participantType);
      console.log("DEBUG - userId (authenticated):", userId);

      // Resolve the actual userId based on participant type
      let otherUserId: string;
      let otherUserName: string;

      if (participantType === "photographer") {
        console.log("DEBUG - Entering photographer lookup branch");
        // participantId is a photographer entity ID - look up the photographer to get their userId
        const photographer = await storage.getPhotographer(participantId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        otherUserId = photographer.userId;
        console.log("DEBUG - Photographer found, userId:", photographer.userId);
        const photographerUser = await storage.getUser(photographer.userId);
        otherUserName = photographerUser?.name || photographer.displayName || "Photographer";
      } else if (participantType === "vendor" || participantType === "business") {
        console.log("DEBUG - Entering vendor/business lookup branch");
        // participantId is a business entity ID - look up the business to get the owner's userId
        const business = await storage.getBusiness(participantId);
        if (!business) {
          return res.status(404).json({ error: "Business not found" });
        }
        otherUserId = business.ownerId;
        console.log("DEBUG - Business found, ownerId:", business.ownerId);
        const businessUser = await storage.getUser(business.ownerId);
        otherUserName = businessUser?.name || business.name || "Vendor";
      } else {
        console.log("DEBUG - Entering default user lookup branch");
        // participantId is already a userId
        otherUserId = participantId;
        const otherUser = await storage.getUser(participantId);
        if (!otherUser) {
          return res.status(404).json({ error: "User not found" });
        }
        otherUserName = otherUser.name || "User";
      }

      // HARDENED SELF-CHECK: Compare resolved user IDs
      console.log("DEBUG - Self-check: authenticatedUserId:", userId, "vs resolvedOtherUserId:", otherUserId);
      if (otherUserId === userId) {
        console.log("DEBUG - BLOCKED: User attempted to message themselves");
        return res.status(400).json({ 
          error: "Cannot create conversation with yourself",
          code: "SELF_MESSAGE_BLOCKED",
          debug: { authenticatedUserId: userId, resolvedOtherUserId: otherUserId }
        });
      }

      console.log("DEBUG - Creating conversation between:", userId, "and", otherUserId);
      const conversation = await storage.getOrCreateConversation(userId, otherUserId);
      const otherUserRecord = await storage.getUser(otherUserId);
      const resolvedType = participantType === "photographer"
        ? "photographer"
        : participantType === "business" || participantType === "vendor"
          ? "business"
          : otherUserRecord?.isPhotographer
            ? "photographer"
            : otherUserRecord?.isVendor
              ? "business"
              : "consumer";
      res.json({
        conversation,
        otherParticipant: {
          id: otherUserId,
          name: otherUserName,
          displayName: otherUserName,
          avatar: otherUserRecord?.profileImageUrl || null,
          type: resolvedType,
        },
      });
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

      // ============================================================
      // PUSH NOTIFICATION: Send to recipient (REST fallback)
      // Note: WebSocket handler also sends push notifications
      // ============================================================
      try {
        const { sendPushNotification, isPushConfigured } = await import('./pushService');
        if (isPushConfigured()) {
          const subscriptions = await storage.getUserPushSubscriptions(otherUserId);
          if (subscriptions.length > 0) {
            const sender = await storage.getUser(userId);
            const totalUnreadCount = await storage.getUnreadCount(otherUserId);
            
            const messagePreview = content.length > 50 
              ? content.substring(0, 47) + "..." 
              : content;
            
            const pushPayload = {
              title: sender?.name || "New Message",
              body: messagePreview,
              url: `/messages?conversation=${req.params.id}`,
              tag: `message-${req.params.id}`,
              data: {
                type: "new_message",
                conversationId: req.params.id,
                senderDisplayName: sender?.name || "Unknown",
                messagePreview,
                badgeCount: totalUnreadCount,
              },
            };
            
            for (const subscription of subscriptions) {
              await sendPushNotification(subscription, pushPayload);
            }
            console.log(`[PUSH/REST] Sent message notification to ${otherUserId}`);
          }
        }
      } catch (pushError) {
        console.error("Push notification error (REST):", pushError);
        // Don't fail message send if push fails
      }

      res.json({ message });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Send message error:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // Get unread message count (total across all conversations)
  app.get("/api/messages/unread-count", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const totalUnreadCount = await storage.getUnreadCount(userId);
      res.json({ totalUnreadCount, count: totalUnreadCount }); // count for backwards compatibility
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

  // ==================== PUBLIC USER PROFILE ROUTE ====================

  // Public profile for any user (consumer, vendor, photographer, influencer).
  // No auth middleware — unauthenticated access is intentional.
  // Returns only public-safe fields; private fields (email, phone, password,
  // address, billing, tokens, stripe ids) are never exposed.
  // Placed AFTER all static /api/users/* and /api/users/:userId/* routes so
  // it does not shadow more specific handlers (e.g. GET /api/users/blocked).
  app.get("/api/users/:id", async (req, res) => {
    try {
      const { id } = req.params;
      console.log('[GET /api/users/:id] returning public profile for', id);

      const user = await storage.getUser(id);
      if (!user || !user.isActive) {
        return res.status(404).json({ error: "User not found" });
      }

      const [followerCount, followingCount] = await Promise.all([
        storage.getFollowerCount(id),
        storage.getFollowingCount(id),
      ]);

      const publicProfile = {
        // Identity
        id: user.id,
        userId: user.id,          // explicit alias — mobile client keys on userId
        name: user.name,          // users.name is the display-name equivalent; no displayName column on users
        username: user.username,
        bio: user.bio,
        // Avatar / cover media — profileImageUrl is the real column name; avatarUrl is a stable alias
        profileImageUrl: user.profileImageUrl,
        avatarUrl: user.profileImageUrl,
        coverMediaUrl: user.coverMediaUrl,
        coverMediaType: user.coverMediaType,
        // Location (coarse — city/state only, not full address)
        city: user.city,
        state: user.state,
        // Role flags (no single role column; boolean flags convey the same info)
        isVendor: user.isVendor,
        isPhotographer: user.isPhotographer,
        isInfluencer: user.isInfluencer,
        // Social counts — derived from the follows table
        followerCount,
        followingCount,
      };

      res.json({ user: publicProfile });
    } catch (error) {
      console.error("[GET /api/users/:id] error:", error);
      res.status(500).json({ error: "Failed to get user profile" });
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
        transactionType: z.enum(['photographer_booking', 'business_transaction', 'bonus']),
        businessId: z.string().optional(),
        businessName: z.string().optional(),
        referenceType: z.string().optional(),
        referenceId: z.string().optional(),
      });
      const data = earnSchema.parse(req.body);

      const transaction = await storage.earnPoints({
        userId,
        dollarAmountCents: data.dollarAmountCents,
        transactionType: data.transactionType,
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

  // Register Expo push token for mobile notifications
  app.post("/api/push/expo-token", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    try {
      const { expoPushToken } = req.body;
      if (!expoPushToken || typeof expoPushToken !== 'string') {
        return res.status(400).json({ success: false, message: "expoPushToken is required" });
      }

      await storage.updateUser(userId, { expoPushToken });
      res.json({ success: true, message: "Push token registered" });
    } catch (error) {
      console.error("Register Expo token error:", error);
      res.status(500).json({ success: false, message: "Failed to register push token" });
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
          return res.status(403).json({ success: false, error: { code: 'VENDOR_UNAVAILABLE', message: 'This business is currently unavailable for purchases' } });
        }
      }

      // Check stock before adding to cart
      const product = await storage.getVendorProduct(data.productId);
      if (product?.trackInventory) {
        const currentCart = await storage.getCartItems(userId);
        const existingQty = currentCart.find(i => i.productId === data.productId)?.quantity || 0;
        const totalRequested = existingQty + data.quantity;
        const available = product.inventory ?? 0;
        if (available <= 0) {
          return res.status(400).json({ success: false, error: { code: 'OUT_OF_STOCK', message: `${product.name} is out of stock` } });
        }
        if (totalRequested > available) {
          return res.status(400).json({ success: false, error: { code: 'INSUFFICIENT_STOCK', message: `Only ${available} units available (${existingQty} already in cart)` } });
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
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }

    try {
      const { quantity } = req.body;
      if (typeof quantity !== 'number' || !Number.isInteger(quantity)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Integer quantity required' } });
      }
      if (quantity < 0) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Quantity cannot be negative' } });
      }

      // quantity 0 = remove item
      if (quantity === 0) {
        await storage.removeCartItem(req.params.id);
        const items = await storage.getCartItems(userId);
        return res.json({ success: true, item: null, itemCount: items.reduce((sum, i) => sum + i.quantity, 0) });
      }

      // Check stock if product tracks inventory
      const existingItems = await storage.getCartItems(userId);
      const cartItem = existingItems.find(i => i.id === req.params.id);
      if (cartItem) {
        const product = await storage.getVendorProduct(cartItem.productId);
        if (product?.trackInventory && product.inventory !== null && quantity > (product.inventory ?? 0)) {
          return res.status(400).json({
            success: false,
            error: { code: 'INSUFFICIENT_STOCK', message: `Only ${product.inventory} units available` }
          });
        }
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
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to update cart item' } });
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

  // Cart checkout - create single Stripe checkout session for all cart items (supports multi-vendor)
  // For multi-vendor carts, payment is collected once and then split between vendors via transfers
  app.post("/api/cart/checkout", authRateLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { shippingAddress } = req.body || {};

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get cart items
      const cartItems = await storage.getCartItems(userId);
      if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ error: "Cart is empty" });
      }

      // Get products for each cart item, validate they're live, and check stock
      const productMap = new Map<string, any>();
      const businessIds = new Set<string>();
      const unavailableItems: Array<{ productId: string; name: string; requested: number; available: number }> = [];
      
      for (const item of cartItems) {
        const product = await storage.getVendorProduct(item.productId);
        if (!product) {
          return res.status(400).json({ success: false, error: { code: 'PRODUCT_NOT_FOUND', message: `Product not found: ${item.productId}` } });
        }
        if (product.status !== 'live') {
          return res.status(400).json({ success: false, error: { code: 'PRODUCT_UNAVAILABLE', message: `Product is not available: ${product.name}` } });
        }
        if (!product.stripePriceId) {
          return res.status(400).json({ success: false, error: { code: 'PRODUCT_NOT_READY', message: `Product is not ready for checkout: ${product.name}` } });
        }
        // Stock validation
        if (product.trackInventory && product.inventory !== null && item.quantity > (product.inventory ?? 0)) {
          unavailableItems.push({
            productId: product.id,
            name: product.name,
            requested: item.quantity,
            available: product.inventory ?? 0,
          });
        }
        productMap.set(product.id, product);
        businessIds.add(product.businessId);
      }

      // Reject checkout if any items are out of stock
      if (unavailableItems.length > 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'ITEMS_UNAVAILABLE', message: 'One or more items are out of stock', items: unavailableItems }
        });
      }

      // Validate all businesses exist, have active subscriptions, and completed Stripe onboarding
      const businessList = Array.from(businessIds);
      for (const businessId of businessList) {
        const business = await storage.getBusiness(businessId);
        if (!business) {
          return res.status(404).json({ error: `Business not found: ${businessId}` });
        }
        const subStatus = await storage.isBusinessSubscriptionActive(businessId);
        if (!subStatus.active) {
          return res.status(403).json({ error: `${business.name} is currently unavailable for purchases` });
        }
        // Ensure vendor has completed Stripe onboarding
        if (!business.stripeAccountId || !business.stripeOnboardingComplete) {
          return res.status(403).json({ success: false, error: { code: 'VENDOR_NOT_ONBOARDED', message: `${business.name} cannot accept payments yet` } });
        }
        
        // Verify Stripe account is enabled for charges and payouts via Stripe API
        try {
          const accountStatus = await stripeService.getConnectAccountStatus(business.stripeAccountId);
          if (!accountStatus.chargesEnabled) {
            return res.status(403).json({ error: `${business.name} is not yet able to accept payments. Please contact the vendor.` });
          }
          if (!accountStatus.payoutsEnabled) {
            return res.status(403).json({ error: `${business.name} has not completed payment setup. Please contact the vendor.` });
          }
        } catch (stripeError) {
          console.error(`Stripe account verification failed for ${businessId}:`, stripeError);
          return res.status(403).json({ error: `Unable to verify payment status for ${business.name}. Please try again later.` });
        }
      }

      // Get or create Stripe customer
      let stripeCustomerId: string;
      if (user.stripeCustomerId) {
        stripeCustomerId = user.stripeCustomerId;
      } else {
        const customer = await stripeService.createCustomer(user.email!, userId, user.name || user.email!);
        stripeCustomerId = customer.id;
        await storage.updateUser(userId, { stripeCustomerId: customer.id });
      }

      const baseUrl = process.env.API_BASE_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000'}`;

      // Group cart items by vendor
      const itemsByVendor = new Map<string, typeof cartItems>();
      for (const item of cartItems) {
        const product = productMap.get(item.productId);
        const businessId = product.businessId;
        if (!itemsByVendor.has(businessId)) {
          itemsByVendor.set(businessId, []);
        }
        itemsByVendor.get(businessId)!.push(item);
      }

      const isMultiVendor = businessList.length > 1;
      let orderGroupId: string | null = null;

      // Create order group if multi-vendor
      if (isMultiVendor) {
        const orderGroup = await storage.createOrderGroup({
          customerId: userId,
          totalVendors: businessList.length,
          completedVendors: 0,
          status: 'pending',
        });
        orderGroupId = orderGroup.id;
      }

      // Build all line items for single checkout session
      const allLineItems: Array<{ stripePriceId: string; quantity: number }> = [];
      const createdOrders: Array<{ orderId: string; businessId: string; businessName: string; vendorNet: number }> = [];
      let totalAmountInCents = 0;
      let totalPlatformFeeInCents = 0;
      let totalConsumerServiceFeeCents = 0;

      // Create order records for each vendor (but single checkout session)
      for (const businessId of businessList) {
        const vendorItems = itemsByVendor.get(businessId)!;
        const business = await storage.getBusiness(businessId);
        
        // Calculate totals for this vendor
        let vendorTotalInCents = 0;
        
        for (const item of vendorItems) {
          const product = productMap.get(item.productId);
          vendorTotalInCents += product.price * item.quantity;
          allLineItems.push({
            stripePriceId: product.stripePriceId!,
            quantity: item.quantity,
          });
        }

        totalAmountInCents += vendorTotalInCents;

        // Check influencer attribution for this customer
        const { getActiveAttribution } = await import('./influencerTrackingService');
        const attribution = await getActiveAttribution(userId);
        const isInfluencerAttributed = !!attribution;

        // Calculate full fee breakdown using v2 engine
        const { calculateProductFees } = await import('./fees');
        const feeBreakdown = calculateProductFees(vendorTotalInCents, {
          influencerAttributed: isInfluencerAttributed,
        });

        totalPlatformFeeInCents += feeBreakdown.platformFeeCents;
        totalConsumerServiceFeeCents += feeBreakdown.consumerServiceFeeCents;

        // Create order record with full fee snapshot
        const order = await storage.createOrder({
          customerId: userId,
          businessId,
          orderGroupId: orderGroupId || undefined,
          totalAmount: vendorTotalInCents,
          platformFee: feeBreakdown.platformFeeCents,
          vendorNet: feeBreakdown.vendorNetCents,
          consumerServiceFee: feeBreakdown.consumerServiceFeeCents,
          influencerCommission: feeBreakdown.influencerCommissionCents,
          grossChargeAmount: feeBreakdown.customerTotalBeforeTaxCents,
          outsydeGrossRevenue: feeBreakdown.outsydeGrossRevenueCents,
          attributedInfluencerId: attribution?.influencerId || null,
          influencerCodeUsed: attribution?.refCode || null,
          commissionStatus: isInfluencerAttributed ? 'pending' : null,
          influencerTransferStatus: isInfluencerAttributed ? 'pending' : null,
          feeModelVersion: feeBreakdown.feeModelVersion,
          status: 'pending',
          shippingAddress: shippingAddress ? JSON.stringify(shippingAddress) : null,
          items: vendorItems.map(item => ({
            productId: item.productId,
            name: productMap.get(item.productId).name,
            quantity: item.quantity,
            price: productMap.get(item.productId).price,
          })),
        });

        createdOrders.push({
          orderId: order.id,
          businessId,
          businessName: business?.name || 'Unknown',
          vendorNet: feeBreakdown.vendorNetCents,
        });
      }

      // Determine success URL - always go to success page (single payment = no continuation flow)
      const successUrl = orderGroupId
        ? `${baseUrl}/order-success?orderGroupId=${orderGroupId}`
        : `${baseUrl}/order-success?orderId=${createdOrders[0].orderId}`;

      // Create single checkout session for all items
      // For single vendor with connected account, use destination charges
      // For multi-vendor OR vendors without connected accounts, collect on platform and transfer later
      let session;
      
      if (!isMultiVendor) {
        // Single vendor - check if they have Stripe Connect
        const singleBusinessId = businessList[0];
        const singleBusiness = await storage.getBusiness(singleBusinessId);
        
        if (singleBusiness?.stripeAccountId && singleBusiness?.stripeOnboardingComplete) {
          // Use destination charges for single vendor with connected account
          session = await stripeService.createCartCheckout({
            customerId: stripeCustomerId,
            lineItems: allLineItems,
            successUrl,
            cancelUrl: `${baseUrl}/cart?cancelled=true`,
            connectedAccountId: singleBusiness.stripeAccountId,
            platformFeeInCents: totalPlatformFeeInCents,
            consumerServiceFeeCents: totalConsumerServiceFeeCents,
            metadata: {
              type: 'cart_checkout',
              orderId: createdOrders[0].orderId,
              orderGroupId: '',
              userId,
              businessId: singleBusinessId,
              isMultiVendor: 'false',
            },
          });
        } else {
          // Platform checkout for single vendor without connected account
          session = await stripeService.createCartCheckoutPlatform({
            customerId: stripeCustomerId,
            lineItems: allLineItems,
            successUrl,
            cancelUrl: `${baseUrl}/cart?cancelled=true`,
            consumerServiceFeeCents: totalConsumerServiceFeeCents,
            metadata: {
              type: 'cart_checkout',
              orderId: createdOrders[0].orderId,
              orderGroupId: '',
              userId,
              businessId: singleBusinessId,
              isMultiVendor: 'false',
            },
          });
        }
      } else {
        // Multi-vendor: Single checkout session, platform collects payment
        session = await stripeService.createMultiVendorCartCheckout({
          customerId: stripeCustomerId,
          lineItems: allLineItems,
          successUrl,
          cancelUrl: `${baseUrl}/cart?cancelled=true`,
          consumerServiceFeeCents: totalConsumerServiceFeeCents,
          metadata: {
            type: 'multi_vendor_cart_checkout',
            orderGroupId: orderGroupId!,
            userId,
            orderIds: createdOrders.map(o => o.orderId).join(','),
            vendorData: JSON.stringify(createdOrders.map(o => ({
              orderId: o.orderId,
              businessId: o.businessId,
              vendorNet: o.vendorNet,
            }))),
            isMultiVendor: 'true',
          },
        });
      }

      // Update all orders with Stripe checkout session ID
      for (const orderData of createdOrders) {
        await storage.updateOrder(orderData.orderId, {
          stripePaymentIntentId: session.id,
          stripeCheckoutSessionId: session.id,
        });
      }

      // Return single checkout URL
      res.json({
        url: session.url,
        orderId: createdOrders[0].orderId,
        orderGroupId,
        isMultiVendor,
        totalVendors: businessList.length,
        vendors: createdOrders.map(o => ({ businessId: o.businessId, businessName: o.businessName, orderId: o.orderId })),
      });
    } catch (error) {
      console.error("Cart checkout error:", error);
      res.status(500).json({ error: "Failed to create checkout" });
    }
  });

  // Continue multi-vendor checkout - get next vendor's checkout session
  app.get("/api/cart/checkout/continue/:orderGroupId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { orderGroupId } = req.params;
      const { completedOrderId } = req.query;

      // Get the order group
      const orderGroup = await storage.getOrderGroup(orderGroupId);
      if (!orderGroup) {
        return res.status(404).json({ error: "Order group not found" });
      }
      
      if (orderGroup.customerId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // If a completed order ID was provided, mark it as paid
      if (completedOrderId && typeof completedOrderId === 'string') {
        const completedOrder = await storage.getOrder(completedOrderId);
        if (completedOrder && completedOrder.customerId === userId && completedOrder.orderGroupId === orderGroupId) {
          await storage.updateOrder(completedOrderId, { status: 'paid' });
          
          // Update the order group completed count
          const currentCompleted = orderGroup.completedVendors || 0;
          await storage.updateOrderGroup(orderGroupId, {
            completedVendors: currentCompleted + 1,
          });
        }
      }

      // Get the next pending order in this group
      const nextOrder = await storage.getNextPendingOrderInGroup(orderGroupId);

      if (!nextOrder) {
        // All orders completed - update group status and redirect to success
        await storage.updateOrderGroup(orderGroupId, { status: 'completed' });
        
        // Clear the cart
        await storage.clearCart(userId);

        return res.json({
          completed: true,
          orderGroupId,
          redirectUrl: `/order-success?orderGroupId=${orderGroupId}`,
        });
      }

      // Get the checkout URL for the next order
      // Since we stored the session ID, we need to get the session URL
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const business = await storage.getBusiness(nextOrder.businessId);
      const baseUrl = process.env.API_BASE_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000'}`;

      // We need to create a new session for the next order since sessions expire
      // Get products from the order items to rebuild the checkout
      const lineItems: Array<{ stripePriceId: string; quantity: number }> = [];
      for (const item of nextOrder.items) {
        const product = await storage.getVendorProduct(item.productId);
        if (product?.stripePriceId) {
          lineItems.push({
            stripePriceId: product.stripePriceId,
            quantity: item.quantity,
          });
        }
      }

      const successUrl = `${baseUrl}/checkout/continue?orderGroupId=${orderGroupId}&completedOrderId=${nextOrder.id}`;

      const vendorBusiness = await storage.getBusiness(nextOrder.businessId);
      let session;

      if (vendorBusiness?.stripeAccountId && vendorBusiness?.stripeOnboardingComplete) {
        session = await stripeService.createCartCheckout({
          customerId: user.stripeCustomerId!,
          lineItems,
          successUrl,
          cancelUrl: `${baseUrl}/cart?cancelled=true`,
          connectedAccountId: vendorBusiness.stripeAccountId,
          platformFeeInCents: nextOrder.platformFee || 0,
          consumerServiceFeeCents: nextOrder.consumerServiceFee || 0,
          metadata: {
            type: 'cart_checkout',
            orderId: nextOrder.id,
            orderGroupId,
            userId,
            businessId: nextOrder.businessId,
            isMultiVendor: 'true',
          },
        });
      } else {
        session = await stripeService.createCartCheckoutPlatform({
          customerId: user.stripeCustomerId!,
          lineItems,
          successUrl,
          cancelUrl: `${baseUrl}/cart?cancelled=true`,
          consumerServiceFeeCents: nextOrder.consumerServiceFee || 0,
          metadata: {
            type: 'cart_checkout',
            orderId: nextOrder.id,
            orderGroupId,
            userId,
            businessId: nextOrder.businessId,
            isMultiVendor: 'true',
          },
        });
      }

      // Update order with new session ID
      await storage.updateOrder(nextOrder.id, {
        stripePaymentIntentId: session.id,
        stripeCheckoutSessionId: session.id,
      });

      res.json({
        completed: false,
        url: session.url,
        orderId: nextOrder.id,
        businessName: business?.name || 'Unknown',
        orderGroupId,
        remainingVendors: (orderGroup.totalVendors || 0) - (orderGroup.completedVendors || 0) - 1,
      });
    } catch (error) {
      console.error("Continue checkout error:", error);
      res.status(500).json({ error: "Failed to continue checkout" });
    }
  });

  // Get order group status
  app.get("/api/order-groups/:id", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const orderGroup = await storage.getOrderGroup(req.params.id);
      if (!orderGroup) {
        return res.status(404).json({ error: "Order group not found" });
      }
      
      if (orderGroup.customerId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const orders = await storage.getOrderGroupOrders(req.params.id);
      
      // Enrich orders with business info
      const enrichedOrders = await Promise.all(orders.map(async (order) => {
        const business = await storage.getBusiness(order.businessId);
        return {
          ...order,
          businessName: business?.name || 'Unknown',
        };
      }));

      res.json({
        orderGroup,
        orders: enrichedOrders,
      });
    } catch (error) {
      console.error("Get order group error:", error);
      res.status(500).json({ error: "Failed to get order group" });
    }
  });

  // ==================== ADMIN VENDOR APPLICATIONS ROUTES ====================

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
  // Supports both session-based auth (web) and JWT-based auth (mobile)
  // Order: JWT first (if present), then session fallback
  // This ensures mobile apps use the JWT identity, not a stale session
  const requireAdmin = async (req: any, res: any, next: any) => {
    console.log("requireAdmin check:", {
      hasSession: !!req.session?.userId,
      authHeader: req.headers.authorization?.substring(0, 50),
      sessionUserId: req.session?.userId
    });

    let userId: string | null = null;
    let tokenPayload: TokenPayload | null = null;

    // First, try JWT-based auth (prioritize over session for mobile clients)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      tokenPayload = verifyAccessToken(token);
      if (tokenPayload) {
        userId = tokenPayload.userId;
        console.log("requireAdmin: Using JWT auth, userId:", userId, "isAdmin:", tokenPayload.isAdmin);
        // Set session userId for compatibility with downstream code
        if (req.session) {
          req.session.userId = tokenPayload.userId;
        }
        // Quick check: if JWT says isAdmin is false, reject early
        if (!tokenPayload.isAdmin) {
          return res.status(403).json({ error: "Admin access required" });
        }
      }
    }

    // Fall back to session-based auth if no valid JWT (web clients)
    if (!userId && req.session?.userId) {
      userId = req.session.userId;
      console.log("requireAdmin: Using session auth, userId:", userId);
    }

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Fetch user from database to verify current admin status and email
    const user = await storage.getUser(userId);
    
    // Check both isAdmin flag AND email is in allowed list (double verification)
    if (!user?.isAdmin || !isAllowedAdminEmail(user.email)) {
      console.log("requireAdmin: Admin check failed for user:", user?.email, "isAdmin:", user?.isAdmin);
      return res.status(403).json({ error: "Admin access required" });
    }

    console.log("requireAdmin: Access granted for admin:", user.email);
    req.adminUser = user;
    req.user = tokenPayload || req.user; // Preserve token payload for downstream use
    next();
  };

  // Trigger admin notification for new business application (called by mobile app after vendor signup)
  // Requires authentication - caller must be the business owner
  app.post("/api/admin/notifications/business-application", async (req, res) => {
    try {
      // Check for JWT auth (mobile) or session auth (web)
      let userId: string | null = null;
      
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const token = authHeader.substring(7);
          const decoded = verifyAccessToken(token);
          if (decoded) {
            userId = decoded.userId;
          }
        } catch (e) {
          // JWT verification failed, try session
        }
      }
      
      // Fall back to session auth
      if (!userId && req.session?.userId) {
        userId = req.session.userId;
      }
      
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const { businessId } = req.body;
      
      if (!businessId) {
        return res.status(400).json({ error: "businessId is required" });
      }
      
      const business = await storage.getBusiness(businessId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }
      
      // Verify the caller owns this business
      if ((business as any).ownerId !== userId) {
        return res.status(403).json({ error: "Not authorized to trigger notifications for this business" });
      }
      
      const owner = await storage.getUser((business as any).ownerId);
      if (!owner) {
        return res.status(404).json({ error: "Business owner not found" });
      }
      
      // Trigger admin notifications (in-app + email)
      await NotificationTriggers.newVendorApplication({
        businessId: business.id,
        businessName: business.name,
        businessCategory: business.category,
        ownerName: owner.name || 'Unknown',
        ownerEmail: owner.email || '',
        city: business.city,
        state: business.state,
      });
      
      res.json({ success: true, message: "Admin notification sent" });
    } catch (error) {
      console.error("Admin notification error:", error);
      res.status(500).json({ error: "Failed to send admin notification" });
    }
  });

  // Get pending vendor applications
  app.get("/api/admin/applications", requireAdmin, async (req, res) => {
    try {
      const { status = "pending" } = req.query;
      const applications = await storage.getBusinessesByApprovalStatus(status as string);
      
      // Enrich with owner info
      const enriched = applications.map((business) => {
        const owner = business.owner;
        return {
          ...business,
          ownerName: owner?.name || null,
          ownerEmail: owner?.email || null,
          ownerPhone: owner?.phone || null,
          ownerAddress: owner?.address || null,
          ownerCity: owner?.city || null,
          ownerState: owner?.state || null,
          ownerZipCode: owner?.zipCode || null,
        };
      });

      res.json({ applications: enriched });
    } catch (error) {
      console.error("Get vendor applications error:", error);
      res.status(500).json({ error: "Failed to get applications" });
    }
  });

  // Get single vendor application with full details
  app.get("/api/admin/applications/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const business = await storage.getBusiness(id);
      
      if (!business) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      const owner = await storage.getUser((business as any).ownerId);
      
      res.json({
        application: {
          ...business,
          ownerName: owner?.name || null,
          ownerEmail: owner?.email || null,
          ownerPhone: owner?.phone || null,
          ownerAddress: owner?.address || null,
          ownerCity: owner?.city || null,
          ownerState: owner?.state || null,
          ownerZipCode: owner?.zipCode || null,
          ownerDateOfBirth: null,
          ownerCreatedAt: owner?.createdAt || null,
        },
      });
    } catch (error) {
      console.error("Get vendor application error:", error);
      res.status(500).json({ error: "Failed to get application" });
    }
  });

  // Approve vendor application
  app.post("/api/admin/applications/:id/approve", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;
      const adminUser = (req as any).adminUser;

      const business = await storage.getBusiness(id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      if ((business as any).approvalStatus === "approved") {
        return res.status(400).json({ error: "Business is already approved" });
      }

      const updated = await storage.updateBusiness(id, {
        approvalStatus: "approved",
        approvalNotes: notes || null,
        approvedAt: new Date(),
        approvedBy: adminUser.id,
        // subscriptionActive NOT set here — only set when real Stripe subscription activates
      });

      // Enable monetization on the business owner's user record
      const ownerId = (business as any).ownerId;
      if (ownerId) {
        await storage.updateUser(ownerId, { canMonetize: true });
        console.log(`[Admin] Enabled canMonetize for user ${ownerId} (business ${id} approved)`);
      }

      // Create audit log
      await storage.createAuditLog({
        actorId: adminUser.id,
        actorType: "admin",
        action: "approve_vendor",
        targetType: "business",
        targetId: id,
        beforeState: { approvalStatus: (business as any).approvalStatus },
        afterState: { approvalStatus: "approved" },
      });

      // Send approval notification to business owner
      const owner = await storage.getUser((business as any).ownerId);
      if (owner) {
        await NotificationTriggers.vendorApplicationApproved({
          ownerId: owner.id,
          ownerName: owner.name || owner.email || 'Unknown',
          ownerEmail: owner.email || '',
          businessId: business.id,
          businessName: business.name,
          stripeOnboardingUrl: null,
        });
      }
      
      console.log(`[Admin] Approved vendor: ${business.name} by ${adminUser.email}`);

      res.json({ success: true, business: updated });
    } catch (error) {
      console.error("Approve vendor error:", error);
      res.status(500).json({ error: "Failed to approve vendor" });
    }
  });

  // Reject vendor application
  app.post("/api/admin/applications/:id/reject", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;
      const adminUser = (req as any).adminUser;

      if (!notes) {
        return res.status(400).json({ error: "Rejection reason is required" });
      }

      const business = await storage.getBusiness(id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      if ((business as any).approvalStatus === "rejected") {
        return res.status(400).json({ error: "Business is already rejected" });
      }

      const updated = await storage.updateBusiness(id, {
        approvalStatus: "rejected",
        approvalNotes: notes,
        approvedAt: new Date(),
        approvedBy: adminUser.id,
      });

      // Create audit log
      await storage.createAuditLog({
        actorId: adminUser.id,
        actorType: "admin",
        action: "reject_vendor",
        targetType: "business",
        targetId: id,
        beforeState: { approvalStatus: (business as any).approvalStatus },
        afterState: { approvalStatus: "rejected", reason: notes },
      });

      // Send rejection notification to business owner
      const owner = await storage.getUser((business as any).ownerId);
      if (owner) {
        await NotificationTriggers.vendorApplicationRejected({
          ownerId: owner.id,
          ownerName: owner.name || owner.email || 'Unknown',
          ownerEmail: owner.email || '',
          businessId: business.id,
          businessName: business.name,
          rejectionReason: notes,
        });
      }
      
      console.log(`[Admin] Rejected vendor: ${business.name} by ${adminUser.email} - Reason: ${notes}`);

      res.json({ success: true, business: updated });
    } catch (error) {
      console.error("Reject vendor error:", error);
      res.status(500).json({ error: "Failed to reject vendor" });
    }
  });

  // Admin delete any post
  app.delete("/api/admin/posts/:postId", requireAdmin, async (req, res) => {
    try {
      const { postId } = req.params;
      const adminUser = (req as any).adminUser;
      
      const post = await storage.getFeedPost(postId);
      if (!post) {
        return res.status(404).json({ error: "Post not found" });
      }

      await storage.deleteFeedPost(postId);

      // Create audit log
      await storage.createAuditLog({
        actorId: adminUser.id,
        actorType: "admin",
        action: "delete_post",
        targetType: "feed_post",
        targetId: postId,
        beforeState: { authorId: post.authorId, content: post.content?.substring(0, 100) },
        afterState: null,
      });

      console.log(`[Admin] Deleted post ${postId} by ${adminUser.email}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Admin delete post error:", error);
      res.status(500).json({ error: "Failed to delete post" });
    }
  });

  // ==================== ADMIN PHOTOGRAPHER VISIBILITY ====================

  // List all photographers (admin view - includes hidden/flagged)
  app.get("/api/admin/photographers", requireAdmin, async (req, res) => {
    try {
      const allPhotographers = await storage.listAllPhotographers();
      res.json(allPhotographers);
    } catch (error) {
      console.error("Admin list photographers error:", error);
      res.status(500).json({ error: "Failed to list photographers" });
    }
  });

  // Update photographer visibility status
  app.patch("/api/admin/photographers/:id/visibility", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { visibilityStatus, adminNotes } = req.body;
      const adminUser = (req as any).adminUser;

      if (!visibilityStatus || !['public', 'hidden', 'flagged'].includes(visibilityStatus)) {
        return res.status(400).json({ 
          error: "Invalid visibility status. Must be 'public', 'hidden', or 'flagged'" 
        });
      }

      const photographer = await storage.getPhotographer(id);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer not found" });
      }

      const beforeState = {
        visibilityStatus: photographer.visibilityStatus,
        adminNotes: photographer.adminNotes,
      };

      const updatedPhotographer = await storage.updatePhotographer(id, {
        visibilityStatus,
        adminNotes: adminNotes || photographer.adminNotes,
      });

      // Create audit log
      await storage.createAuditLog({
        actorId: adminUser.id,
        actorType: "admin",
        action: "update_photographer_visibility",
        targetType: "photographer",
        targetId: id,
        beforeState,
        afterState: { visibilityStatus, adminNotes },
      });

      console.log(`[Admin] Updated photographer ${id} visibility to ${visibilityStatus} by ${adminUser.email}`);
      res.json({ 
        photographer: updatedPhotographer,
        message: `Photographer visibility updated to ${visibilityStatus}`,
      });
    } catch (error) {
      console.error("Admin update photographer visibility error:", error);
      res.status(500).json({ error: "Failed to update photographer visibility" });
    }
  });

  // ==================== ADMIN FULFILLMENT ROUTES ====================

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
        // Issue Stripe refund for the actual payment
        let stripeRefundId: string | null = null;
        if (request.targetId) {
          try {
            let paymentIntentId: string | null = null;
            if (request.targetType === 'order') {
              const order = await storage.getOrder(request.targetId);
              paymentIntentId = order?.stripePaymentIntentId || null;
            } else if (request.targetType === 'shoot_booking') {
              const booking = await storage.getShootBooking(request.targetId);
              paymentIntentId = booking?.stripePaymentIntentId || null;
            } else if (request.targetType === 'appointment') {
              const appointment = await storage.getAppointment(request.targetId);
              paymentIntentId = appointment?.stripePaymentIntentId || null;
            }

            if (paymentIntentId) {
              const refund = await stripeService.createBookingRefund({
                paymentIntentId,
                amountCents: request.amount,
                reason: 'requested_by_customer',
                metadata: {
                  refundRequestId: id,
                  targetType: request.targetType || '',
                  targetId: request.targetId,
                  approvedBy: adminUser.id,
                },
              });
              stripeRefundId = refund.id;
              console.log(`[Refund] Stripe refund ${refund.id} issued for ${request.targetType} ${request.targetId}: ${request.amount}¢`);
            } else {
              console.warn(`[Refund] No Stripe payment found for ${request.targetType} ${request.targetId} — skipping Stripe refund`);
            }
          } catch (stripeError: any) {
            console.error(`[Refund] Stripe refund failed for ${request.targetType} ${request.targetId}:`, stripeError.message);
            return res.status(402).json({ success: false, message: `Stripe refund failed: ${stripeError.message}` });
          }
        }

        // Update order/booking status to refunded with state machine validation
        if (request.targetType === 'order' && request.targetId) {
          const refundedOrder = await storage.getOrder(request.targetId);

          // Reverse influencer commission if applicable
          if (refundedOrder?.attributedInfluencerId && refundedOrder.influencerCommission && refundedOrder.influencerCommission > 0) {
            const { reverseInfluencerCommission } = await import('./influencerPayoutService');
            await reverseInfluencerCommission(request.targetId, request.amount, true);
          }

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
          await storage.releasePhotographerSlot(request.targetId);
        } else if (request.targetType === 'appointment' && request.targetId) {
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

  // ==================== INFLUENCER ROUTES ====================

  // User: Submit influencer application
  app.post("/api/influencer/apply", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check if already an influencer
      if (user.isInfluencer) {
        return res.status(400).json({ error: "You are already an influencer" });
      }

      // Only customers can apply - vendors and photographers cannot become influencers
      if (user.isVendor || user.isPhotographer) {
        return res.status(403).json({ error: "Business owners and photographers cannot apply as influencers. The influencer program is only for customers." });
      }

      // Check for existing pending application
      const existingApplication = await storage.getInfluencerApplicationByUserId(userId);
      if (existingApplication && existingApplication.status === 'pending') {
        return res.status(400).json({ error: "You already have a pending application" });
      }

      const { instagramUrl, tiktokUrl, youtubeUrl, twitterUrl, followerCount, contentNiche, whyInfluencer } = req.body;

      const application = await storage.createInfluencerApplication({
        userId,
        instagramUrl: instagramUrl || null,
        tiktokUrl: tiktokUrl || null,
        youtubeUrl: youtubeUrl || null,
        twitterUrl: twitterUrl || null,
        followerCount: followerCount ? parseInt(followerCount) : null,
        contentNiche: contentNiche || null,
        whyInfluencer: whyInfluencer || null,
      });

      res.status(201).json({ success: true, application });
    } catch (error) {
      console.error("Create influencer application error:", error);
      res.status(500).json({ error: "Failed to submit application" });
    }
  });

  // User: Get own influencer application status
  app.get("/api/influencer/application", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const application = await storage.getInfluencerApplicationByUserId(userId);
      res.json({ application: application || null });
    } catch (error) {
      console.error("Get influencer application error:", error);
      res.status(500).json({ error: "Failed to get application" });
    }
  });

  // Admin: Get all influencer applications
  app.get("/api/admin/influencer-applications", requireAdmin, async (req, res) => {
    try {
      const { status } = req.query;
      const applications = await storage.getInfluencerApplications(status as string | undefined);
      
      // Enrich with user data
      const enrichedApplications = await Promise.all(
        applications.map(async (app) => {
          const user = await storage.getUser(app.userId);
          return {
            ...app,
            user: user ? { 
              id: user.id, 
              name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.name,
              email: user.email,
              profileImageUrl: user.profileImageUrl 
            } : null,
          };
        })
      );
      
      res.json({ applications: enrichedApplications });
    } catch (error) {
      console.error("Get influencer applications error:", error);
      res.status(500).json({ error: "Failed to get applications" });
    }
  });

  // Admin: Approve influencer application
  app.post("/api/admin/influencer-applications/:id/approve", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { commissionRate, promoCode } = req.body;

    try {
      const application = await storage.getInfluencerApplication(id);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (application.status !== 'pending') {
        return res.status(400).json({ error: "Application is not pending" });
      }

      // Update application status
      await storage.updateInfluencerApplication(id, {
        status: 'approved',
        reviewedAt: new Date(),
        reviewedBy: req.session?.userId,
      });

      // Update user's isInfluencer flag
      await storage.updateUser(application.userId, { isInfluencer: true });

      // Get user for display name
      const user = await storage.getUser(application.userId);
      
      // Create influencer profile
      const generatedPromoCode = promoCode || `INF${application.userId.substring(0, 6).toUpperCase()}`;
      const displayName = user?.firstName && user?.lastName 
        ? `${user.firstName} ${user.lastName}` 
        : user?.name || null;
      const profile = await storage.createInfluencerProfile({
        userId: application.userId,
        displayName,
        bio: application.whyInfluencer,
        promoCode: generatedPromoCode,
        instagramUrl: application.instagramUrl,
        tiktokUrl: application.tiktokUrl,
        youtubeUrl: application.youtubeUrl,
        twitterUrl: application.twitterUrl,
        followerCount: application.followerCount,
      });

      res.json({ success: true, profile });
    } catch (error) {
      console.error("Approve influencer application error:", error);
      res.status(500).json({ error: "Failed to approve application" });
    }
  });

  // Admin: Reject influencer application
  app.post("/api/admin/influencer-applications/:id/reject", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { rejectionReason } = req.body;

    try {
      const application = await storage.getInfluencerApplication(id);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (application.status !== 'pending') {
        return res.status(400).json({ error: "Application is not pending" });
      }

      await storage.updateInfluencerApplication(id, {
        status: 'rejected',
        adminNotes: rejectionReason || null,
        reviewedAt: new Date(),
        reviewedBy: req.session?.userId,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Reject influencer application error:", error);
      res.status(500).json({ error: "Failed to reject application" });
    }
  });

  // Influencer: Get own profile
  app.get("/api/influencer/profile", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user?.isInfluencer) {
        return res.status(403).json({ error: "Not an influencer" });
      }

      const profile = await storage.getInfluencerProfileByUserId(userId);
      res.json({ profile: profile || null });
    } catch (error) {
      console.error("Get influencer profile error:", error);
      res.status(500).json({ error: "Failed to get profile" });
    }
  });

  // Influencer: Update own profile
  app.patch("/api/influencer/profile", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user?.isInfluencer) {
        return res.status(403).json({ error: "Not an influencer" });
      }

      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(404).json({ error: "Influencer profile not found" });
      }

      const { displayName, bio, instagramUrl, tiktokUrl, youtubeUrl, twitterUrl, followerCount } = req.body;
      
      const updatedProfile = await storage.updateInfluencerProfile(profile.id, {
        displayName: displayName ?? profile.displayName,
        bio: bio ?? profile.bio,
        instagramUrl: instagramUrl ?? profile.instagramUrl,
        tiktokUrl: tiktokUrl ?? profile.tiktokUrl,
        youtubeUrl: youtubeUrl ?? profile.youtubeUrl,
        twitterUrl: twitterUrl ?? profile.twitterUrl,
        followerCount: followerCount ?? profile.followerCount,
      });

      res.json({ profile: updatedProfile });
    } catch (error) {
      console.error("Update influencer profile error:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // Influencer: Get dashboard summary
  app.get("/api/influencer/dashboard", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user?.isInfluencer) {
        return res.status(403).json({ error: "Not an influencer" });
      }

      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(404).json({ error: "Influencer profile not found" });
      }

      // Get earnings summary
      const allEarnings = await storage.getInfluencerEarningLedger(profile.id);
      const pendingEarnings = allEarnings.filter(e => e.status === 'pending');
      const readyEarnings = allEarnings.filter(e => e.status === 'ready_for_payout');
      const paidEarnings = allEarnings.filter(e => e.status === 'paid');

      const pendingAmount = pendingEarnings.reduce((sum, e) => sum + e.amountCents, 0);
      const readyAmount = readyEarnings.reduce((sum, e) => sum + e.amountCents, 0);
      const paidAmount = paidEarnings.reduce((sum, e) => sum + e.amountCents, 0);

      // Get referral events
      const referralEvents = await storage.getInfluencerReferralEvents(profile.id);

      // Get active campaign assignments
      const campaignAssignments = await storage.getInfluencerCampaignAssignments({ influencerId: profile.id });
      const activeCampaigns = campaignAssignments.filter(a => a.status === 'active');

      // Get payouts
      const payouts = await storage.getInfluencerPayouts(profile.id);

      res.json({
        profile,
        earnings: {
          pendingCents: pendingAmount,
          readyForPayoutCents: readyAmount,
          totalPaidCents: paidAmount,
          totalEarnedCents: pendingAmount + readyAmount + paidAmount,
        },
        referrals: {
          total: referralEvents.length,
          recent: referralEvents.slice(0, 10),
        },
        campaigns: {
          active: activeCampaigns.length,
          total: campaignAssignments.length,
        },
        payouts: {
          total: payouts.length,
          recent: payouts.slice(0, 5),
        },
      });
    } catch (error) {
      console.error("Get influencer dashboard error:", error);
      res.status(500).json({ error: "Failed to get dashboard" });
    }
  });

  // Influencer: Get referral events
  app.get("/api/influencer/referrals", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user?.isInfluencer) {
        return res.status(403).json({ error: "Not an influencer" });
      }

      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(404).json({ error: "Influencer profile not found" });
      }

      const referralEvents = await storage.getInfluencerReferralEvents(profile.id);
      res.json({ referrals: referralEvents });
    } catch (error) {
      console.error("Get influencer referrals error:", error);
      res.status(500).json({ error: "Failed to get referrals" });
    }
  });

  // Influencer: Get campaigns
  app.get("/api/influencer/campaigns", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user?.isInfluencer) {
        return res.status(403).json({ error: "Not an influencer" });
      }

      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(404).json({ error: "Influencer profile not found" });
      }

      const assignments = await storage.getInfluencerCampaignAssignments({ influencerId: profile.id });
      
      // Enrich with campaign details
      const enrichedAssignments = await Promise.all(
        assignments.map(async (a) => {
          const campaign = await storage.getInfluencerCampaign(a.campaignId);
          return { ...a, campaign };
        })
      );

      res.json({ campaigns: enrichedAssignments });
    } catch (error) {
      console.error("Get influencer campaigns error:", error);
      res.status(500).json({ error: "Failed to get campaigns" });
    }
  });

  // Influencer: Get earnings ledger
  app.get("/api/influencer/earnings", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user?.isInfluencer) {
        return res.status(403).json({ error: "Not an influencer" });
      }

      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(404).json({ error: "Influencer profile not found" });
      }

      const { status } = req.query;
      const earnings = await storage.getInfluencerEarningLedger(profile.id, status as string | undefined);
      res.json({ earnings });
    } catch (error) {
      console.error("Get influencer earnings error:", error);
      res.status(500).json({ error: "Failed to get earnings" });
    }
  });

  // Influencer: Get payouts
  app.get("/api/influencer/payouts", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user?.isInfluencer) {
        return res.status(403).json({ error: "Not an influencer" });
      }

      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(404).json({ error: "Influencer profile not found" });
      }

      const payouts = await storage.getInfluencerPayouts(profile.id);
      res.json({ payouts });
    } catch (error) {
      console.error("Get influencer payouts error:", error);
      res.status(500).json({ error: "Failed to get payouts" });
    }
  });

  // Admin: Get all influencer profiles
  app.get("/api/admin/influencers", requireAdmin, async (req, res) => {
    try {
      const profiles = await storage.listInfluencerProfiles();
      
      // Enrich with user data
      const enrichedProfiles = await Promise.all(
        profiles.map(async (profile) => {
          const user = await storage.getUser(profile.userId);
          return {
            ...profile,
            user: user ? { 
              id: user.id, 
              name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.name,
              email: user.email,
              profileImageUrl: user.profileImageUrl 
            } : null,
          };
        })
      );
      
      res.json({ influencers: enrichedProfiles });
    } catch (error) {
      console.error("Get influencers error:", error);
      res.status(500).json({ error: "Failed to get influencers" });
    }
  });

  // Admin: Create influencer campaign
  app.post("/api/admin/influencer-campaigns", requireAdmin, async (req, res) => {
    try {
      const { name, description, flatAmountCents, commissionBps, payoutType, startDate, endDate } = req.body;

      const campaign = await storage.createInfluencerCampaign({
        name,
        description: description || null,
        flatAmountCents: flatAmountCents ? parseInt(flatAmountCents) : 0,
        commissionBps: commissionBps ? parseInt(commissionBps) : 0,
        payoutType: payoutType || 'flat',
        createdByAdminId: req.session?.userId || null,
        createdByVendorId: null,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        status: 'active',
      });

      res.status(201).json({ success: true, campaign });
    } catch (error) {
      console.error("Create influencer campaign error:", error);
      res.status(500).json({ error: "Failed to create campaign" });
    }
  });

  // Admin: Get all campaigns
  app.get("/api/admin/influencer-campaigns", requireAdmin, async (req, res) => {
    try {
      const { status } = req.query;
      const campaigns = await storage.getInfluencerCampaigns({ status: status as string | undefined });
      res.json({ campaigns });
    } catch (error) {
      console.error("Get influencer campaigns error:", error);
      res.status(500).json({ error: "Failed to get campaigns" });
    }
  });

  // Admin: Assign influencer to campaign
  app.post("/api/admin/influencer-campaigns/:campaignId/assign", requireAdmin, async (req, res) => {
    const { campaignId } = req.params;
    const { influencerId } = req.body;

    try {
      const campaign = await storage.getInfluencerCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const profile = await storage.getInfluencerProfile(influencerId);
      if (!profile) {
        return res.status(404).json({ error: "Influencer not found" });
      }

      const assignment = await storage.createInfluencerCampaignAssignment({
        campaignId,
        influencerId,
        status: 'active',
      });

      res.status(201).json({ success: true, assignment });
    } catch (error) {
      console.error("Assign influencer to campaign error:", error);
      res.status(500).json({ error: "Failed to assign influencer" });
    }
  });

  // Admin: Complete campaign assignment and trigger payout
  app.post("/api/admin/influencer-campaign-assignments/:id/complete", requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
      const assignment = await storage.getInfluencerCampaignAssignment(id);
      if (!assignment) {
        return res.status(404).json({ error: "Assignment not found" });
      }

      if (assignment.status !== 'active') {
        return res.status(400).json({ error: "Assignment is not active" });
      }

      const campaign = await storage.getInfluencerCampaign(assignment.campaignId);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      // Mark assignment as completed
      await storage.updateInfluencerCampaignAssignment(id, {
        status: 'completed',
        completedAt: new Date(),
      });

      // Create earning ledger entry for this campaign completion
      // Use flatAmountCents for flat payouts or commissionBps for commission-based
      const payoutAmount = campaign.payoutType === 'flat' ? (campaign.flatAmountCents || 0) : 0;
      await storage.createInfluencerEarningLedger({
        influencerId: assignment.influencerId,
        sourceType: 'campaign',
        sourceRefId: assignment.campaignId,
        amountCents: payoutAmount,
        description: `Campaign completed: ${campaign.name}`,
        status: 'ready_for_payout',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Complete campaign assignment error:", error);
      res.status(500).json({ error: "Failed to complete assignment" });
    }
  });

  // Admin: Initiate influencer payout
  app.post("/api/admin/influencer-payouts", requireAdmin, async (req, res) => {
    const { influencerId } = req.body;

    try {
      const profile = await storage.getInfluencerProfile(influencerId);
      if (!profile) {
        return res.status(404).json({ error: "Influencer not found" });
      }

      // Check if the target influencer's user can monetize
      const influencerUser = await storage.getUser(profile.userId);
      if (influencerUser && !influencerUser.canMonetize) {
        return res.status(403).json({ 
          error: "Monetization not enabled", 
          message: "The influencer's account is not approved for monetization." 
        });
      }

      if (!profile.stripeAccountId || !profile.stripeOnboardingComplete) {
        return res.status(400).json({ error: "Influencer has not completed Stripe onboarding" });
      }

      // Get all ready for payout earnings
      const readyEarnings = await storage.getReadyForPayoutLedgerEntries(influencerId);
      if (readyEarnings.length === 0) {
        return res.status(400).json({ error: "No earnings ready for payout" });
      }

      const totalAmount = readyEarnings.reduce((sum, e) => sum + e.amountCents, 0);

      // Create Stripe transfer
      const transfer = await stripeService.createInfluencerPayout(
        profile.stripeAccountId,
        totalAmount,
        {
          influencerId,
          earningIds: readyEarnings.map(e => e.id).join(','),
        }
      );

      // Create payout record
      const payout = await storage.createInfluencerPayout({
        influencerId,
        amountCents: totalAmount,
        stripeTransferId: transfer.id,
        status: 'completed',
        ledgerIds: readyEarnings.map(e => e.id),
      });

      // Update earning ledger entries
      for (const earning of readyEarnings) {
        await storage.updateInfluencerEarningLedger(earning.id, {
          status: 'paid',
          payoutId: payout.id,
        });
      }

      res.json({ success: true, payout, transfer });
    } catch (error) {
      console.error("Initiate influencer payout error:", error);
      res.status(500).json({ error: "Failed to initiate payout" });
    }
  });

  // ==================== INFLUENCER PAYOUT VISIBILITY ====================

  // Addition 1: Admin payout visibility
  app.get("/api/admin/influencer-payouts/history", requireAdmin, async (req, res) => {
    try {
      const {
        status,
        influencer_id,
        business_id,
        date_from,
        date_to,
        page = '1',
        limit: limitStr = '50',
      } = req.query;

      const pageNum = Math.max(1, parseInt(page as string));
      const limitNum = Math.min(200, Math.max(1, parseInt(limitStr as string)));
      const offsetNum = (pageNum - 1) * limitNum;

      // Build conditions for the earning ledger query
      const conditions: unknown[] = [
        eq(influencerEarningLedger.sourceType, 'commission'),
      ];

      if (status) conditions.push(eq(influencerEarningLedger.status, status as string));
      if (influencer_id) conditions.push(eq(influencerEarningLedger.influencerId, influencer_id as string));
      if (date_from) conditions.push(gte(influencerEarningLedger.createdAt, new Date(date_from as string)));
      if (date_to) conditions.push(lte(influencerEarningLedger.createdAt, new Date(date_to as string)));

      // Count total
      const [countRow] = await db.select({ count: sql<number>`count(*)` })
        .from(influencerEarningLedger)
        .where(and(...(conditions as any)));
      const total = Number(countRow?.count || 0);

      // Fetch paginated results
      const rows = await db.select()
        .from(influencerEarningLedger)
        .where(and(...(conditions as any)))
        .orderBy(desc(influencerEarningLedger.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      // Enrich with influencer + order + business data
      const results = [];
      for (const row of rows) {
        const profile = await storage.getInfluencerProfile(row.influencerId);
        const user = profile ? await storage.getUser(profile.userId) : null;
        let orderData: { businessId?: string; businessName?: string; subtotal?: number; refCode?: string } = {};
        if (row.sourceRefId) {
          const order = await storage.getOrder(row.sourceRefId);
          if (order) {
            const biz = await storage.getBusiness(order.businessId);
            orderData = {
              businessId: order.businessId,
              businessName: biz?.name || 'Unknown',
              subtotal: order.totalAmount,
              refCode: order.influencerCodeUsed || undefined,
            };
          }
        }

        // Filter by business_id if specified
        if (business_id && orderData.businessId !== business_id) continue;

        results.push({
          id: row.id,
          influencer_id: row.influencerId,
          influencer_username: user?.username || user?.name || 'Unknown',
          order_id: row.sourceRefId,
          business_id: orderData.businessId || null,
          business_name: orderData.businessName || null,
          referral_code: orderData.refCode || null,
          order_subtotal: (orderData.subtotal || 0) / 100,
          commission_rate: 0.15,
          commission_amount: row.amountCents / 100,
          stripe_transfer_id: row.stripeTransferId || null,
          status: row.status,
          created_at: row.createdAt,
          paid_at: row.paidAt,
        });
      }

      // Summary aggregations
      const summaryRows = await db.select({
        status: influencerEarningLedger.status,
        total: sql<number>`COALESCE(SUM(${influencerEarningLedger.amountCents}), 0)`,
      })
        .from(influencerEarningLedger)
        .where(eq(influencerEarningLedger.sourceType, 'commission'))
        .groupBy(influencerEarningLedger.status);

      const summary = {
        total_paid: 0,
        total_pending: 0,
        total_reversed: 0,
        total_disputed: 0,
      };
      for (const s of summaryRows) {
        const val = Number(s.total) / 100;
        if (s.status === 'completed' || s.status === 'transfer_sent') summary.total_paid += val;
        else if (s.status === 'pending' || s.status === 'approved') summary.total_pending += val;
        else if (s.status === 'reversed') summary.total_reversed += Math.abs(val);
      }

      res.json({ total, page: pageNum, limit: limitNum, results, summary });
    } catch (error) {
      console.error("Admin influencer payouts error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to load payout history' } });
    }
  });

  // Addition 2: Influencer Stripe Connect onboarding link
  app.get("/api/influencer/stripe-connect/onboarding-link", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
    }

    try {
      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Influencer profile not found' } });
      }

      const baseUrl = process.env.API_BASE_URL || 'https://outsyde-backend.onrender.com';

      // Case 1: Already has a Stripe account — check if fully verified
      if (profile.stripeAccountId) {
        try {
          const accountStatus = await stripeService.getConnectAccountStatus(profile.stripeAccountId);
          if (accountStatus.chargesEnabled && accountStatus.payoutsEnabled) {
            return res.json({ already_connected: true, stripe_account_id: profile.stripeAccountId });
          }
        } catch (statusErr) {
          console.error("[InfluencerStripe] Account status check failed:", statusErr);
        }

        // Account exists but not fully verified — generate new onboarding link
        const stripe = await (await import('./stripe/stripeClient')).getUncachableStripeClient();
        const accountLink = await stripe.accountLinks.create({
          account: profile.stripeAccountId,
          type: 'account_onboarding',
          refresh_url: `${baseUrl}/api/stripe/connect-refresh?account=${profile.stripeAccountId}&type=influencer`,
          return_url: `${baseUrl}/api/stripe/connect-return?account=${profile.stripeAccountId}&type=influencer`,
        });

        return res.json({
          already_connected: false,
          url: accountLink.url,
          expires_at: accountLink.expires_at,
        });
      }

      // Case 2: No Stripe account — create one
      const stripe = await (await import('./stripe/stripeClient')).getUncachableStripeClient();
      const user = await storage.getUser(userId);

      const account = await stripe.accounts.create({
        type: 'standard',
        email: user?.email || undefined,
        metadata: {
          influencerId: profile.id,
          userId,
          type: 'influencer',
        },
      });

      // Store the new account ID
      await storage.updateInfluencerProfile(profile.id, {
        stripeAccountId: account.id,
      });

      // Generate onboarding link
      const accountLink = await stripe.accountLinks.create({
        account: account.id,
        type: 'account_onboarding',
        refresh_url: `${baseUrl}/api/stripe/connect-refresh?account=${account.id}&type=influencer`,
        return_url: `${baseUrl}/api/stripe/connect-return?account=${account.id}&type=influencer`,
      });

      res.json({
        already_connected: false,
        url: accountLink.url,
        expires_at: accountLink.expires_at,
      });
    } catch (error) {
      console.error("Influencer Stripe Connect onboarding error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to generate onboarding link' } });
    }
  });

  // Addition 3: Influencer personal payout history (enhanced version)
  app.get("/api/influencer/payout-history", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
    }

    try {
      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Influencer profile not found' } });
      }

      // Fetch all commission ledger entries for this influencer
      const ledger = await storage.getInfluencerEarningLedger(profile.id);
      const commissions = ledger.filter(e => e.sourceType === 'commission' || e.sourceType === 'commission_reversal');

      // Build summary
      let totalEarned = 0;
      let totalPending = 0;
      let totalReversed = 0;

      for (const entry of commissions) {
        if (entry.status === 'completed' || entry.status === 'transfer_sent') {
          totalEarned += entry.amountCents;
        } else if (entry.status === 'pending' || entry.status === 'approved') {
          totalPending += entry.amountCents;
        }
        if (entry.sourceType === 'commission_reversal') {
          totalReversed += Math.abs(entry.amountCents);
        }
      }

      // Build payout list (commission entries only, not reversals)
      const payouts = commissions
        .filter(e => e.sourceType === 'commission')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map(entry => {
          // Look up order info if available
          return {
            id: entry.id,
            order_id: entry.sourceRefId,
            commission_amount: entry.amountCents / 100,
            commission_rate: 0.15,
            order_subtotal: 0, // would need order lookup for exact value
            referral_code: '',
            status: entry.status,
            created_at: entry.createdAt,
            paid_at: entry.paidAt,
          };
        });

      res.json({
        summary: {
          total_earned: totalEarned / 100,
          total_pending: totalPending / 100,
          total_reversed: totalReversed / 100,
        },
        payouts,
      });
    } catch (error) {
      console.error("Influencer payout history error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to load payout history' } });
    }
  });

  // ==================== INFLUENCER TRACKING ROUTES ====================

  // Referral link redirect — tracks click + sets attribution cookie
  app.get("/ref/:refCode", async (req, res) => {
    try {
      const { refCode } = req.params;
      const { utm_source, utm_medium, utm_campaign, product, service, business } = req.query;

      await trackLinkClick(refCode, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
        utmSource: utm_source as string,
        utmMedium: utm_medium as string,
        utmCampaign: utm_campaign as string,
      });

      // Build redirect URL — preserve ref code for attribution on signup
      const redirectUrl = new URL('/', `${req.protocol}://${req.get('host')}`);
      redirectUrl.searchParams.set('ref', refCode);
      if (product) redirectUrl.searchParams.set('product', product as string);
      if (service) redirectUrl.searchParams.set('service', service as string);
      if (business) redirectUrl.searchParams.set('business', business as string);

      // Set attribution cookie (30-day window, first-click only)
      res.cookie('outsyde_ref', refCode, {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
      });

      res.redirect(302, redirectUrl.toString());
    } catch (error) {
      console.error("Referral redirect error:", error);
      res.redirect('/');
    }
  });

  // Record attribution (called by client after signup with ref param/cookie)
  app.post("/api/influencer-tracking/attribute", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { refCode, utm_source, utm_medium, utm_campaign } = req.body;
      if (!refCode) {
        return res.status(400).json({ error: "refCode is required" });
      }

      const attribution = await recordAttribution(userId, refCode, {
        utm_source, utm_medium, utm_campaign,
      });

      if (attribution) {
        await trackAttributedSignup(userId);
      }

      res.json({ success: true, attributed: !!attribution });
    } catch (error) {
      console.error("Attribution error:", error);
      res.status(500).json({ error: "Failed to record attribution" });
    }
  });

  // Track app download event (called by mobile client on first launch with ref)
  app.post("/api/influencer-tracking/download", async (req, res) => {
    try {
      const { refCode, deviceType, platform } = req.body;
      if (!refCode) {
        return res.status(400).json({ error: "refCode is required" });
      }

      const profile = await storage.getInfluencerProfileByPromoCode(refCode);
      if (!profile) {
        return res.status(404).json({ error: "Invalid referral code" });
      }

      const { trackEvent } = await import("./influencerTrackingService");
      await trackEvent({
        influencerId: profile.id,
        eventType: 'app_download',
        refCode,
        deviceType: deviceType || detectDeviceFromRequest(req),
        platform: platform || 'unknown',
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Download tracking error:", error);
      res.status(500).json({ error: "Failed to track download" });
    }
  });

  // Influencer: Get own tracking dashboard
  app.get("/api/influencer/tracking", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(403).json({ error: "Not an influencer" });
      }

      const dashboard = await getInfluencerDashboardData(profile.id);

      res.json({
        referralLink: dashboard.referralLink,
        deepLink: generateDeepLink(profile.promoCode || profile.id),
        stats: dashboard.stats ? {
          totalClicks: dashboard.stats.totalClicks,
          totalDownloads: dashboard.stats.totalDownloads,
          totalSignups: dashboard.stats.totalSignups,
          totalPurchases: dashboard.stats.totalPurchases,
          totalRevenueCents: dashboard.stats.totalRevenueCents,
          totalPoints: dashboard.stats.totalPoints,
          conversionRate: dashboard.stats.conversionRate,
          rollingAvgConversionRate: dashboard.stats.rollingAvgConversionRate,
          totalCommissionEarnedCents: dashboard.stats.totalCommissionEarnedCents,
          pendingCommissionCents: dashboard.stats.pendingCommissionCents,
        } : null,
        tier: dashboard.tier ? {
          name: dashboard.tier.name,
          displayName: dashboard.tier.displayName,
          commissionPercent: dashboard.tier.commissionBps / 100,
        } : null,
        nextTier: dashboard.nextTier ? {
          name: dashboard.nextTier.name,
          displayName: dashboard.nextTier.displayName,
          minConversionRate: dashboard.nextTier.minConversionRate,
          conversionNeeded: dashboard.conversionNeededForNextTier,
        } : null,
      });
    } catch (error) {
      console.error("Influencer tracking dashboard error:", error);
      res.status(500).json({ error: "Failed to get tracking data" });
    }
  });

  // Influencer: Generate custom referral link with UTM params
  app.post("/api/influencer/tracking/link", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const profile = await storage.getInfluencerProfileByUserId(userId);
      if (!profile) {
        return res.status(403).json({ error: "Not an influencer" });
      }

      const { utm_source, utm_medium, utm_campaign, productId, serviceId } = req.body;
      const refCode = profile.promoCode || profile.id;
      const origin = `${req.protocol}://${req.get('host')}`;

      const referralLink = generateReferralLink(refCode, origin, {
        utm_source, utm_medium, utm_campaign, productId, serviceId,
      });

      const deepLink = generateDeepLink(refCode, { productId, serviceId }, {
        utm_source, utm_medium, utm_campaign,
      });

      res.json({ referralLink, deepLink, refCode });
    } catch (error) {
      console.error("Generate referral link error:", error);
      res.status(500).json({ error: "Failed to generate link" });
    }
  });

  // Admin: Get influencer leaderboard with tracking stats
  app.get("/api/admin/influencer-tracking", requireAdmin, async (req, res) => {
    try {
      const { tierId, startDate, endDate, utmSource, tierChangeOnly, limit, offset } = req.query;

      const result = await getInfluencerLeaderboard({
        tierId: tierId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        utmSource: utmSource as string,
        tierChangeOnly: tierChangeOnly === 'true',
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });

      res.json(result);
    } catch (error) {
      console.error("Admin influencer tracking error:", error);
      res.status(500).json({ error: "Failed to get influencer tracking data" });
    }
  });

  // Admin: Acknowledge tier change flag
  app.post("/api/admin/influencer-tracking/:influencerId/acknowledge-tier-change", requireAdmin, async (req, res) => {
    try {
      const { influencerId } = req.params;
      await clearTierChangeFlag(influencerId);
      res.json({ success: true });
    } catch (error) {
      console.error("Acknowledge tier change error:", error);
      res.status(500).json({ error: "Failed to acknowledge tier change" });
    }
  });

  // Admin: Get all tiers (configurable)
  app.get("/api/admin/influencer-tiers", requireAdmin, async (req, res) => {
    try {
      const { influencerTiers: tiersTable } = await import("@shared/schema");
      const tiers = await db.select().from(tiersTable).orderBy(tiersTable.sortOrder);
      res.json({ tiers });
    } catch (error) {
      console.error("Get tiers error:", error);
      res.status(500).json({ error: "Failed to get tiers" });
    }
  });

  // Admin: Update tier commission/points (configurable without code changes)
  app.patch("/api/admin/influencer-tiers/:tierId", requireAdmin, async (req, res) => {
    try {
      const { tierId } = req.params;
      const { commissionBps, pointMultiplier, displayName } = req.body;
      const { influencerTiers: tiersTable } = await import("@shared/schema");

      const updates: any = { };
      if (commissionBps !== undefined) updates.commissionBps = commissionBps;
      if (pointMultiplier !== undefined) updates.pointMultiplier = pointMultiplier;
      if (displayName !== undefined) updates.displayName = displayName;

      const [updated] = await db.update(tiersTable).set(updates).where(eq(tiersTable.id, tierId)).returning();
      res.json({ success: true, tier: updated });
    } catch (error) {
      console.error("Update tier error:", error);
      res.status(500).json({ error: "Failed to update tier" });
    }
  });

  // Admin: Get/update point config
  app.get("/api/admin/influencer-point-config", requireAdmin, async (req, res) => {
    try {
      const { influencerPointConfig: configTable } = await import("@shared/schema");
      const config = await db.select().from(configTable);
      res.json({ config });
    } catch (error) {
      console.error("Get point config error:", error);
      res.status(500).json({ error: "Failed to get point config" });
    }
  });

  app.patch("/api/admin/influencer-point-config/:eventType", requireAdmin, async (req, res) => {
    try {
      const { eventType } = req.params;
      const { pointsAwarded } = req.body;
      const { influencerPointConfig: configTable } = await import("@shared/schema");

      const [updated] = await db.update(configTable)
        .set({ pointsAwarded, updatedAt: new Date() })
        .where(eq(configTable.eventType, eventType))
        .returning();
      res.json({ success: true, config: updated });
    } catch (error) {
      console.error("Update point config error:", error);
      res.status(500).json({ error: "Failed to update point config" });
    }
  });

  // ==================== VENDOR DASHBOARD ROUTES ====================
  console.log("[ROUTES] Registering GET /api/business/orders");

  app.get("/api/business/orders", hybridAuthMiddleware, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const orders = await storage.getVendorOrders(business.id);

      const enrichedOrders = await Promise.all(
        orders.map(async (order) => {
          const shipments = await storage.getShipmentsByOrder(order.id);
          return {
            ...order,
            shipment: shipments.length > 0 ? shipments[0] : null,
          };
        })
      );

      res.json({ orders: enrichedOrders });
    } catch (error) {
      console.error("Get business orders error:", error);
      res.status(500).json({ error: "Failed to get orders" });
    }
  });

  app.patch("/api/business/orders/:id", hybridAuthMiddleware, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const orderId = req.params.id;
      const existingOrder = await storage.getOrder(orderId);
      if (!existingOrder) return res.status(404).json({ error: "Order not found" });
      if (existingOrder.businessId !== business.id) {
        return res.status(403).json({ error: "Not authorized to update this order" });
      }

      const { status, trackingNumber, carrier, shippedAt } = req.body as {
        status?: string;
        trackingNumber?: string;
        carrier?: string;
        shippedAt?: string;
      };

      // Phase 1a: require tracking data when marking shipped
      if (status === "shipped" && (!trackingNumber?.trim() || !carrier?.trim())) {
        return res.status(400).json({ error: "Tracking number and carrier are required to mark an order as shipped." });
      }

      // --- Refund gate: paid → cancelled requires Stripe refund BEFORE status change ---
      // Order status must NOT change to 'cancelled' if the Stripe call throws.
      let refundResult: { refund: any; transferReversal: any } | null = null;
      if (status === 'cancelled' && existingOrder.status === 'paid') {
        const piId = existingOrder.stripePaymentIntentId;
        if (!piId) {
          return res.status(400).json({ error: "Order has no payment intent — cannot issue refund" });
        }
        const refundAmountCents = existingOrder.totalAmount;
        const vendorReclaimCents = existingOrder.vendorNet ?? 0;
        if (!refundAmountCents || refundAmountCents <= 0) {
          return res.status(400).json({ error: "Order total amount is missing — cannot issue refund" });
        }

        refundResult = await stripeService.refundOrderCancellation({
          paymentIntentId: piId,
          refundAmountCents,
          vendorReclaimCents,
          metadata: {
            orderId,
            reason: 'order_cancelled_by_business',
          },
        });
      }
      // --- End refund gate ---

      const orderUpdates: Partial<typeof existingOrder> = {};
      if (status !== undefined) orderUpdates.status = status;

      let updatedOrder = existingOrder;
      if (Object.keys(orderUpdates).length > 0) {
        const result = await storage.updateOrderWithValidation(orderId, orderUpdates, userId);
        if (!result.success) {
          return res.status(400).json({ error: result.error || "Failed to update order" });
        }
        updatedOrder = result.order!;
      }

      // Post-refund: audit log + notification (fire-and-forget — order is already cancelled)
      if (refundResult) {
        storage.createAuditLog({
          actorId: userId,
          actorType: 'user',
          action: 'order_refund_issued',
          targetType: 'order',
          targetId: orderId,
          metadata: {
            stripeRefundId: refundResult.refund?.id ?? null,
            stripeTransferReversalId: refundResult.transferReversal?.id ?? null,
            refundAmountCents: existingOrder.totalAmount,
            vendorReclaimCents: existingOrder.vendorNet ?? 0,
          },
        }).catch(err => console.error('Audit log error (refund):', err));

        NotificationTriggers.refundIssued({
          userId: existingOrder.customerId,
          amount: existingOrder.totalAmount,
          referenceType: 'order',
          referenceId: orderId,
          reason: 'Order cancelled by business',
        }).catch(err => console.error('Notification error (refund):', err));
      }

      if (trackingNumber && carrier) {
        // Phase 1b: upsert shipment — update existing rather than inserting a duplicate
        const existingShipments = await storage.getShipmentsByOrder(orderId);
        if (existingShipments.length > 0) {
          await storage.updateShipment(existingShipments[0].id, {
            carrier,
            trackingNumber,
            shippedAt: shippedAt ? new Date(shippedAt) : new Date(),
          });
        } else {
          await storage.createShipment({
            orderId,
            businessId: business.id,
            carrier,
            trackingNumber,
            shippedAt: shippedAt ? new Date(shippedAt) : new Date(),
          });
        }

        // Phase 1c: audit log for shipment
        storage.createAuditLog({
          actorId: userId,
          actorType: 'user',
          action: 'shipment_created',
          targetType: 'order',
          targetId: orderId,
          metadata: { carrier, trackingNumber },
        }).catch(err => console.error('Audit log error (shipment):', err));

        NotificationTriggers.orderShipped({
          customerId: existingOrder.customerId,
          orderId,
          carrier,
          trackingNumber,
        }).catch(err => console.error('Notification error:', err));

        // Phase 1f: transactional shipment email (fire-and-forget)
        ;(async () => {
          try {
            const { sendOrderShippedEmail } = await import('./emailService');
            const consumer = await storage.getUser(existingOrder.customerId);
            const firstItem = (existingOrder.items as Array<{ name?: string }>)?.[0];
            const CARRIER_URLS: Record<string, string> = {
              UPS: `https://www.ups.com/track?tracknum=${trackingNumber}`,
              FedEx: `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
              USPS: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
              DHL: `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
            };
            const trackingUrl = CARRIER_URLS[carrier] ?? `https://google.com/search?q=${encodeURIComponent(carrier + ' tracking ' + trackingNumber)}`;
            if (consumer?.email) {
              await sendOrderShippedEmail({
                toEmail: consumer.email,
                consumerName: consumer.name || consumer.firstName || 'there',
                vendorName: business.name,
                productName: firstItem?.name || 'your item',
                orderId,
                carrier,
                trackingNumber,
                trackingUrl,
              });
            }
          } catch (emailErr) {
            console.error('Order shipped email error:', emailErr);
          }
        })();
      }

      return res.json({ order: updatedOrder });
    } catch (error) {
      console.error("Update business order error:", error);
      return res.status(500).json({ error: "Failed to update order" });
    }
  });

  app.get("/api/business/bookings", authMiddleware, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const bookings = await storage.getAppointmentsByBusinessWithDetails(business.id);
      res.json({ bookings });
    } catch (error) {
      console.error("Get business bookings error:", error);
      res.status(500).json({ error: "Failed to get bookings" });
    }
  });

  app.get("/api/business/products", authMiddleware, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const products = await storage.getVendorProducts(business.id);
      res.json({ products });
    } catch (error) {
      console.error("Get business products error:", error);
      res.status(500).json({ error: "Failed to get products" });
    }
  });

  app.get("/api/business/services", authMiddleware, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const services = await storage.getVendorServicesByBusiness(business.id);
      res.json({ services });
    } catch (error) {
      console.error("Get business services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  });

  app.get("/api/business/stats", authMiddleware, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const allOrders = await storage.getVendorOrders(business.id);
      const bookings = await storage.getAppointmentsByBusiness(business.id);

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const paidStatuses = ['paid', 'shipped', 'delivered'];
      const paidOrders = allOrders.filter(o => paidStatuses.includes(o.status || ''));
      const monthlyRevenue = paidOrders
        .filter(o => new Date(o.createdAt) >= monthStart)
        .reduce((sum, o) => sum + (o.totalAmount || 0), 0);

      const confirmedBookings = bookings.filter(b =>
        b.status === 'confirmed' || b.status === 'completed'
      );

      const monthlyBookingRevenue = confirmedBookings
        .filter(b => new Date(b.createdAt) >= monthStart)
        .reduce((sum, b) => sum + (b.totalPrice || 0), 0);

      res.json({
        stats: {
          orderCount: paidOrders.length,
          bookingCount: confirmedBookings.length,
          monthlyRevenueCents: monthlyRevenue + monthlyBookingRevenue,
          reviewCount: business.reviewCount || 0,
          averageRating: business.rating ? (business.rating / 10) : 0,
        },
      });
    } catch (error) {
      console.error("Get business stats error:", error);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  app.patch("/api/business/settings", authMiddleware, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const { autoAcceptBookings } = req.body;
      if (typeof autoAcceptBookings !== 'boolean') {
        return res.status(400).json({ error: "autoAcceptBookings must be a boolean" });
      }

      await storage.updateBusiness(business.id, { autoAcceptBookings });
      res.json({ success: true });
    } catch (error) {
      console.error("Update business settings error:", error);
      res.status(500).json({ error: "Failed to update settings" });
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

      const totalRevenue = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
      const totalBookingRevenue = bookings.reduce((sum, booking) => sum + (booking.totalPrice || 0), 0);

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

  // Admin: Get known issues (Overview "Known Issues" panel)
  app.get("/api/admin/issues", requireAdmin, async (req, res) => {
    try {
      const { status = "open" } = req.query;
      const { adminIssues } = await import("@shared/schema");
      const query = status === "all"
        ? db.select().from(adminIssues).orderBy(desc(adminIssues.createdAt))
        : db.select().from(adminIssues).where(eq(adminIssues.status, status as string)).orderBy(desc(adminIssues.createdAt));
      const issues = await query;
      res.json({ issues });
    } catch (error) {
      console.error("Get admin issues error:", error);
      res.status(500).json({ error: "Failed to get issues" });
    }
  });

  // Admin: Create a known issue
  app.post("/api/admin/issues", requireAdmin, async (req, res) => {
    try {
      const schema = z.object({
        title: z.string().min(1),
        area: z.string().min(1),
        severity: z.enum(['low', 'medium', 'high']).optional(),
      });
      const data = schema.parse(req.body);
      const adminUser = (req as any).adminUser;
      const { adminIssues } = await import("@shared/schema");

      const [issue] = await db.insert(adminIssues).values({
        title: data.title,
        area: data.area,
        severity: data.severity || 'medium',
        createdBy: adminUser.id,
      }).returning();

      await storage.createAuditLog({
        actorId: adminUser.id,
        actorType: "admin",
        action: "create_admin_issue",
        targetType: "admin_issue",
        targetId: issue.id,
        beforeState: null,
        afterState: { title: issue.title, severity: issue.severity },
      });

      res.status(201).json({ success: true, issue });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Create admin issue error:", error);
      res.status(500).json({ error: "Failed to create issue" });
    }
  });

  // Admin: Update a known issue (e.g. resolve it)
  app.patch("/api/admin/issues/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const schema = z.object({
        status: z.enum(['open', 'resolved']).optional(),
        severity: z.enum(['low', 'medium', 'high']).optional(),
      });
      const data = schema.parse(req.body);
      const adminUser = (req as any).adminUser;
      const { adminIssues } = await import("@shared/schema");

      const [existing] = await db.select().from(adminIssues).where(eq(adminIssues.id, id));
      if (!existing) {
        return res.status(404).json({ error: "Issue not found" });
      }

      const updates: Record<string, any> = { ...data };
      if (data.status === 'resolved') {
        updates.resolvedAt = new Date();
      }

      const [issue] = await db.update(adminIssues).set(updates).where(eq(adminIssues.id, id)).returning();

      await storage.createAuditLog({
        actorId: adminUser.id,
        actorType: "admin",
        action: "update_admin_issue",
        targetType: "admin_issue",
        targetId: id,
        beforeState: { status: existing.status, severity: existing.severity },
        afterState: { status: issue.status, severity: issue.severity },
      });

      res.json({ success: true, issue });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Update admin issue error:", error);
      res.status(500).json({ error: "Failed to update issue" });
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
        isActive: u.isActive,
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
          isActive: user.isActive,
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

  // Admin: Disable user account
  app.post("/api/admin/users/:userId/disable", requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (user.isAdmin) {
        return res.status(403).json({ error: "Cannot disable admin accounts" });
      }

      await storage.updateUser(userId, { isActive: false });
      res.json({ success: true, user: { id: user.id, email: user.email, isActive: false } });
    } catch (error) {
      console.error("Disable user error:", error);
      res.status(500).json({ error: "Failed to disable user" });
    }
  });

  // Admin: Enable user account
  app.post("/api/admin/users/:userId/enable", requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      await storage.updateUser(userId, { isActive: true });
      res.json({ success: true, user: { id: user.id, email: user.email, isActive: true } });
    } catch (error) {
      console.error("Enable user error:", error);
      res.status(500).json({ error: "Failed to enable user" });
    }
  });

  // Admin: Get all businesses
  app.get("/api/admin/businesses", requireAdmin, async (req, res) => {
    try {
      const { search, category, limit = "50", offset = "0" } = req.query;
      let businesses = await storage.getAllBusinesses();

      // Filter out demo/test data - admin should only see real businesses
      businesses = businesses.filter(b => 
        !b.isDemo && 
        !b.ownerId?.includes('demo') && 
        !b.ownerId?.includes('vendor-test')
      );

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

  // Admin: Get single business by ID
  app.get("/api/admin/businesses/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const business = await storage.getBusiness(id);

      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // Get owner info
      const owner = await storage.getUser(business.ownerId);

      // Get products and services for this business
      const products = await storage.getVendorProducts(id);
      const services = await storage.getVendorServicesByBusiness(id);

      // Get staff members if any
      const staff = await storage.getStaffMembersByBusiness(id);

      res.json({
        ...business,
        owner: owner ? {
          id: owner.id,
          email: owner.email,
          name: owner.name,
          profileImage: owner.profileImageUrl,
          phone: owner.phone,
        } : null,
        products,
        services,
        staff,
        productCount: products.length,
        serviceCount: services.length,
        staffCount: staff.length,
      });
    } catch (error) {
      console.error("Get admin business detail error:", error);
      res.status(500).json({ error: "Failed to get business details" });
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

  // Admin: Approve business (alias for /api/admin/applications/:id/approve)
  app.post("/api/admin/businesses/:id/approve", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;
      const adminUser = (req as any).adminUser;

      const business = await storage.getBusiness(id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      if ((business as any).approvalStatus === "approved") {
        return res.status(400).json({ error: "Business is already approved" });
      }

      const updated = await storage.updateBusiness(id, {
        approvalStatus: "approved",
        approvalNotes: notes || null,
        approvedAt: new Date(),
        approvedBy: adminUser.id,
        // subscriptionActive NOT set here — only set when real Stripe subscription activates
      });

      // Enable monetization on the business owner's user record
      const ownerId = (business as any).ownerId;
      if (ownerId) {
        await storage.updateUser(ownerId, { canMonetize: true });
        console.log(`[Admin] Enabled canMonetize for user ${ownerId} (business ${id} approved)`);
      }

      // Create audit log
      await storage.createAuditLog({
        actorId: adminUser.id,
        actorType: "admin",
        action: "approve_vendor",
        targetType: "business",
        targetId: id,
        beforeState: { approvalStatus: (business as any).approvalStatus },
        afterState: { approvalStatus: "approved" },
      });

      // Send approval notification to business owner
      const owner = await storage.getUser((business as any).ownerId);
      if (owner) {
        await NotificationTriggers.vendorApplicationApproved({
          ownerId: owner.id,
          ownerName: owner.name || owner.email || 'Unknown',
          ownerEmail: owner.email || '',
          businessId: business.id,
          businessName: business.name,
          stripeOnboardingUrl: null,
        });
      }

      console.log(`[Admin] Approved business: ${business.name} by ${adminUser.email}`);

      res.json({ success: true, business: updated });
    } catch (error) {
      console.error("Approve business error:", error);
      res.status(500).json({ error: "Failed to approve business" });
    }
  });

  // Admin: Reject business (alias for /api/admin/applications/:id/reject)
  app.post("/api/admin/businesses/:id/reject", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { notes, reason } = req.body;
      const adminUser = (req as any).adminUser;

      const rejectionReason = notes || reason;
      if (!rejectionReason) {
        return res.status(400).json({ error: "Rejection reason is required" });
      }

      const business = await storage.getBusiness(id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      if ((business as any).approvalStatus === "rejected") {
        return res.status(400).json({ error: "Business is already rejected" });
      }

      const updated = await storage.updateBusiness(id, {
        approvalStatus: "rejected",
        approvalNotes: rejectionReason,
        approvedAt: new Date(),
        approvedBy: adminUser.id,
      });

      // Create audit log
      await storage.createAuditLog({
        actorId: adminUser.id,
        actorType: "admin",
        action: "reject_vendor",
        targetType: "business",
        targetId: id,
        beforeState: { approvalStatus: (business as any).approvalStatus },
        afterState: { approvalStatus: "rejected" },
      });

      // Send rejection notification to business owner
      const owner = await storage.getUser((business as any).ownerId);
      if (owner) {
        await NotificationTriggers.vendorApplicationRejected({
          ownerId: owner.id,
          ownerName: owner.name || owner.email || 'Unknown',
          ownerEmail: owner.email || '',
          businessId: business.id,
          businessName: business.name,
          rejectionReason: rejectionReason,
        });
      }

      console.log(`[Admin] Rejected business: ${business.name} by ${adminUser.email} - Reason: ${rejectionReason}`);

      res.json({ success: true, business: updated });
    } catch (error) {
      console.error("Reject business error:", error);
      res.status(500).json({ error: "Failed to reject business" });
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

      // Enrich with customer, business, and shipment info
      const enrichedOrders = await Promise.all(paginatedOrders.map(async (order) => {
        const customer = await storage.getUser(order.customerId);
        const business = await storage.getBusiness(order.businessId);
        const shipments = await storage.getShipmentsByOrder(order.id);
        return {
          ...order,
          customerEmail: customer?.email,
          customerName: customer?.name || `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim(),
          businessName: business?.name,
          shipment: shipments[0] || null,
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
        const customer = await storage.getUser(booking.clientId);
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
        const participantIds = [conv.participant1Id, conv.participant2Id];
        const participants = await Promise.all(participantIds.map(async (pId: string) => {
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
        resolvedBy: data.status !== "pending" ? req.session?.userId : undefined,
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
      const [reporter, reported, conversationMessages] = await Promise.all([
        storage.getUser(report.reporterId),
        storage.getUser(report.reportedUserId),
        storage.getMessages(report.conversationId),
      ]);
      const message = conversationMessages.find(m => m.id === report.messageId);

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

  // ==================== VENDOR ANALYTICS DASHBOARD ====================

  app.get("/api/dashboard/analytics", optionalAuthMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
    }

    try {
      const period = (req.query.period as string) || '30d';
      const periodDays = period === '7d' ? 7 : period === '90d' ? 90 : period === 'all' ? 3650 : 30;
      const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
      const periodEnd = new Date();

      const business = await storage.getBusinessByOwnerId(userId);
      const photographer = await storage.getPhotographerByUserId(userId);

      if (!business && !photographer) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Vendor or photographer account required' } });
      }

      let totalRevenue = 0;
      let totalBookings = 0;
      let totalOrders = 0;
      let platformFeesCollected = 0;

      if (business) {
        // Revenue from orders (SQL aggregation)
        const orderStats = await db.select({
          revenue: sql<number>`COALESCE(SUM(${orders.totalAmount}), 0)`,
          count: sql<number>`COUNT(*)`,
          fees: sql<number>`COALESCE(SUM(${orders.platformFee}), 0)`,
        }).from(orders).where(and(
          eq(orders.businessId, business.id),
          or(eq(orders.status, 'paid'), eq(orders.status, 'shipped'), eq(orders.status, 'delivered')),
          gte(orders.createdAt, periodStart),
        ));
        totalOrders = Number(orderStats[0]?.count || 0);
        totalRevenue += Number(orderStats[0]?.revenue || 0);
        platformFeesCollected += Number(orderStats[0]?.fees || 0);

        // Revenue from appointments (SQL aggregation)
        const apptStats = await db.select({
          revenue: sql<number>`COALESCE(SUM(${appointments.totalPrice}), 0)`,
          count: sql<number>`COUNT(*)`,
          fees: sql<number>`COALESCE(SUM(${appointments.platformFee}), 0)`,
        }).from(appointments).where(and(
          eq(appointments.businessId, business.id),
          or(eq(appointments.status, 'confirmed'), eq(appointments.status, 'completed')),
          gte(appointments.createdAt, periodStart),
        ));
        totalBookings += Number(apptStats[0]?.count || 0);
        totalRevenue += Number(apptStats[0]?.revenue || 0);
        platformFeesCollected += Number(apptStats[0]?.fees || 0);
      }

      if (photographer) {
        // Revenue from shoot bookings (SQL aggregation)
        const shootStats = await db.select({
          revenue: sql<number>`COALESCE(SUM(${shootBookings.totalPrice}), 0)`,
          count: sql<number>`COUNT(*)`,
          fees: sql<number>`COALESCE(SUM(${shootBookings.platformFee}), 0)`,
        }).from(shootBookings).where(and(
          eq(shootBookings.photographerId, photographer.id),
          or(eq(shootBookings.status, 'confirmed'), eq(shootBookings.status, 'completed')),
          gte(shootBookings.createdAt, periodStart),
        ));
        totalBookings += Number(shootStats[0]?.count || 0);
        totalRevenue += Number(shootStats[0]?.revenue || 0);
        platformFeesCollected += Number(shootStats[0]?.fees || 0);
      }

      res.json({
        success: true,
        data: {
          totalRevenue,
          totalBookings,
          totalOrders,
          platformFeesCollected,
          netPayout: totalRevenue - platformFeesCollected,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        },
      });
    } catch (error) {
      console.error("Dashboard analytics error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to load analytics' } });
    }
  });

  // ==================== FEED POSTS ROUTES ====================

  // IMPORTANT: Discovery feed uses live GPS coordinates passed from the frontend
  // at query time — NOT the user's stored home address. The stored address is
  // for shipping/billing only. Frontend should pass ?lat=XX.XXXX&lng=XX.XXXX
  // (current device coordinates). If no coordinates, fall back to stored city/state.
  // Supports: ?city= (case-insensitive filter), ?cursor= or ?offset=, ?lat=&lng= (optional)
  app.get("/api/feed", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const cursor = req.query.cursor as string | undefined;
      const offset = cursor ? parseInt(Buffer.from(cursor, 'base64').toString(), 10) || 0
        : parseInt(req.query.offset as string) || 0;
      const userId = req.session?.userId || getUserIdFromRequest(req);
      const city = req.query.city ? (req.query.city as string).trim() : undefined;

      const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
      const lng = req.query.lng ? parseFloat(req.query.lng as string) : undefined;

      if (userId && lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng)) {
        try {
          await storage.updateUser(userId, { latitude: lat, longitude: lng });
        } catch (_) { /* non-fatal */ }
      }

      const posts = await storage.getAlgorithmicFeed(userId || null, limit, offset, city);
      
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

      // Always show the authenticated user's own posts at the top of their feed,
      // bypassing city filters, subscription checks, and scoring thresholds.
      // This ensures a user sees their own freshly-posted content immediately.
      if (userId) {
        const ownPosts = (await storage.getUserFeedPosts(userId)).slice(0, limit);

        // Strip any own-post entries already in the list before re-inserting.
        // This guards against duplicate rows that can arise when the algorithmic
        // query (which joins multiple tables sharing the column name "id") returns
        // a null id for an own post, making ID-based deduplication unreliable.
        const otherActivePosts = activePosts.filter((p: any) => p.authorId !== userId);

        // Rebuild activePosts: own posts newest-first at the top, then others
        activePosts.length = 0;
        activePosts.push(...ownPosts, ...otherActivePosts);
      }

      // Batch-fetch liked post IDs for the viewer — ONE query, no N+1
      const activePostIds = activePosts.map((p: any) => p.id).filter(Boolean) as string[];
      const likedSet = userId
        ? await storage.getLikedPostIds(userId, activePostIds)
        : new Set<string>();
      // TODO: remove before final merge
      console.log('[isLiked]', 'feed=main', 'viewer=', userId, 'likedCount=', likedSet.size);

      // Enrich posts with author, tagged entities, and product/service info
      // Filter out posts with missing/invalid authors (fail closed)
      const enrichedPosts: any[] = [];
      
      for (const post of activePosts) {
        const author = await storage.getUser(post.authorId);
        
        // FAIL CLOSED: Skip posts with missing or invalid authors
        if (!author) {
          console.warn(`[Feed] Skipping post ${post.id}: author ${post.authorId} not found`);
          continue;
        }
        
        let taggedBusiness = null;
        let taggedPhotographer = null;
        let product = null;
        let service = null;
        let photographerService = null;
        let authorBusinessId: string | null = null;
        let authorPhotographerId: string | null = null;
        
        // Get the author's storefront ID based on their type
        // Also determines the role for the canonical author object
        let authorRole: 'consumer' | 'photographer' | 'vendor' = 'consumer';
        
        if (post.authorType === 'vendor' && post.authorId) {
          const business = await storage.getBusinessByOwnerId(post.authorId);
          if (business) {
            authorBusinessId = business.id;
            authorRole = 'vendor';
          }
        } else if (post.authorType === 'photographer' && post.authorId) {
          const photographer = await storage.getPhotographerByUserId(post.authorId);
          if (photographer) {
            authorPhotographerId = photographer.id;
            authorRole = 'photographer';
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
        if (post.photographerServiceId) {
          photographerService = await storage.getPhotographerService(post.photographerServiceId);
        }
        
        // Build media object for response (prefer new fields, fall back to legacy imageUrl)
        const mediaObj = (post.mediaUrl || post.imageUrl) ? {
          mediaUrl: post.mediaUrl || post.imageUrl,
          mediaType: post.mediaType || 'image',
          width: post.mediaWidth || null,
          height: post.mediaHeight || null,
          aspectRatio: post.aspectRatio || null,
        } : null;
        
        enrichedPosts.push({
          ...post,
          // Canonical author object - ALWAYS present (fail closed ensures this)
          author: {
            userId: author.id,
            username: author.username || null,
            displayName: author.name || author.firstName || 'Anonymous',
            profilePhotoUrl: author.profileImageUrl || null,
            role: authorRole,
          },
          // Media metadata object
          media: mediaObj,
          // Per-viewer like status — false for logged-out viewers
          isLiked: likedSet.has(post.id),
          // Legacy identity fields for backwards compatibility
          userId: post.authorId,
          username: author.username || null,
          displayName: author.name || author.firstName || null,
          providerId: authorPhotographerId || authorBusinessId || null,
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
          photographerService: photographerService ? {
            id: photographerService.id,
            name: photographerService.name,
            description: photographerService.description,
            basePrice: photographerService.priceCents,
            durationMinutes: photographerService.estimatedDurationMinutes,
            photographerId: photographerService.photographerId,
          } : null,
        });
      }
      
      const nextOffset = offset + enrichedPosts.length;
      const hasMore = enrichedPosts.length === limit;
      const nextCursor = hasMore ? Buffer.from(String(nextOffset)).toString('base64') : null;

      res.json({
        success: true,
        data: { posts: enrichedPosts, nextCursor, hasMore, nextOffset },
        posts: enrichedPosts,
      });
    } catch (error) {
      console.error("Get feed error:", error);
      res.status(500).json({ success: false, message: "Failed to get feed", data: { posts: [], nextCursor: null, hasMore: false } });
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
        imageUrl: z.string().optional(), // Legacy field, use media object for new posts
        // Nested media object (web frontend format)
        media: z.object({
          url: z.string(),
          type: z.enum(['image', 'video']),
          thumbnailUrl: z.string().optional(), // Video poster image
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          aspectRatio: z.number().positive().optional(),
        }).optional(),
        // Flat mobile app format (alternative to nested media object)
        videoUrl: z.string().optional(), // Mobile app sends this for videos
        mediaUrl: z.string().optional(), // Mobile app may send this for images
        mediaType: z.enum(['image', 'video']).optional(), // Mobile app sends this at top level
        thumbnailUrl: z.string().optional(), // Mobile app sends this at top level
        mediaDuration: z.number().optional(), // Mobile app sends video duration
        taggedBusinessId: z.string().optional(),
        taggedPhotographerId: z.string().optional(),
        postType: z.enum(['text', 'product', 'service']).optional(),
        postIntent: z.enum(['social', 'review', 'promotion']).optional().default('social'), // Default to social for legacy clients
        displayLayout: z.enum(['pro', 'pulse']).optional(), // Optional layout hint for frontend display (legacy)
        feedSurface: z.enum(['pulse', 'pro']).optional(), // SOURCE OF TRUTH: which feed the post belongs to
        productId: z.string().optional(),
        serviceId: z.string().optional(),
        photographerServiceId: z.string().optional(),
      }).refine(data => {
        // Normalize: check for media URL from either format (all possible fields)
        const hasMediaUrl = data.media?.url || data.videoUrl || data.mediaUrl || data.imageUrl;
        const mediaType = data.media?.type || data.mediaType;
        
        // For Pulse posts with video, content is optional (caption)
        if (data.feedSurface === 'pulse' && mediaType === 'video') {
          return true;
        }
        // For text posts without media, content is required
        if (!data.postType || data.postType === 'text') {
          // If there's media, content is optional
          if (hasMediaUrl) {
            return true;
          }
          return data.content && data.content.length > 0;
        }
        // For product/service posts, content is optional
        return true;
      }, { message: "Content is required for text posts without media" });

      const data = schema.parse(req.body);
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Determine author type and user role
      let authorType = 'customer';
      let userRole: 'business' | 'photographer' | 'consumer' = 'consumer';
      if (user.isVendor) {
        authorType = 'vendor';
        userRole = 'business';
      }
      if (user.isPhotographer) {
        authorType = 'photographer';
        userRole = 'photographer';
      }

      // ==================== POST INTENT VALIDATION ====================
      
      // 1. PROMOTION INTENT - Role-based permissions
      if (data.postIntent === 'promotion') {
        // Allow only: business, photographer, or approved influencer
        const canPostPromotion = 
          userRole === 'business' || 
          userRole === 'photographer' || 
          (userRole === 'consumer' && user.isInfluencer === true);
        
        if (!canPostPromotion) {
          return res.status(403).json({
            code: "PROMOTION_NOT_ALLOWED",
            message: "Promotional posts require influencer approval"
          });
        }
      }
      
      // 2. REVIEW INTENT - Requires tagging + transaction history
      if (data.postIntent === 'review') {
        // taggedEntityId REQUIRED for reviews
        if (!data.taggedBusinessId && !data.taggedPhotographerId) {
          return res.status(400).json({
            code: "TAGGED_ENTITY_REQUIRED",
            message: "Review posts must tag a business or photographer"
          });
        }
        
        // Validate user has transaction/booking history with tagged entity
        if (data.taggedBusinessId) {
          const hasHistory = await storage.canCustomerTagBusiness(userId, data.taggedBusinessId);
          if (!hasHistory) {
            return res.status(403).json({
              code: "NO_TRANSACTION_HISTORY",
              message: "You can only review businesses you've purchased from or used services of"
            });
          }
        }
        
        if (data.taggedPhotographerId) {
          const hasHistory = await storage.canCustomerTagPhotographer(userId, data.taggedPhotographerId);
          if (!hasHistory) {
            return res.status(403).json({
              code: "NO_TRANSACTION_HISTORY",
              message: "You can only review photographers you've had sessions with"
            });
          }
        }
      }
      
      // 3. SOCIAL INTENT - taggedEntityId OPTIONAL (no validation required)
      // No special validation needed for social posts

      // ==================== END POST INTENT VALIDATION ====================

      // Validate productId ownership - only business owners can attach their products
      if (data.productId) {
        const product = await storage.getVendorProduct(data.productId);
        if (!product) {
          return res.status(404).json({ error: "Product not found" });
        }
        const business = await storage.getBusinessByOwnerId(userId);
        if (!business || product.businessId !== business.id) {
          return res.status(403).json({ error: "You can only attach your own products" });
        }
      }

      // Validate serviceId ownership - only business owners can attach their services
      if (data.serviceId) {
        const service = await storage.getVendorService(data.serviceId);
        if (!service) {
          return res.status(404).json({ error: "Service not found" });
        }
        const business = await storage.getBusinessByOwnerId(userId);
        if (!business || service.businessId !== business.id) {
          return res.status(403).json({ error: "You can only attach your own services" });
        }
      }

      // Validate photographerServiceId ownership - only photographers can attach their services
      if (data.photographerServiceId) {
        const photographerService = await storage.getPhotographerService(data.photographerServiceId);
        if (!photographerService) {
          return res.status(404).json({ error: "Photographer service not found" });
        }
        const photographer = await storage.getPhotographerByUserId(userId);
        if (!photographer || photographerService.photographerId !== photographer.id) {
          return res.status(403).json({ error: "You can only attach your own photographer services" });
        }
      }

      // NOTE: Global tagging requirement REMOVED - tagging is only required for review intent

      // NORMALIZE: Support both nested media object (web) and flat fields (mobile app)
      // Mobile sends: { videoUrl, mediaType, thumbnailUrl } or { mediaUrl, mediaType }
      // Web sends: { media: { url, type, thumbnailUrl } }
      const normalizedMediaUrl = data.media?.url || data.videoUrl || data.mediaUrl || data.imageUrl;
      const normalizedMediaType = data.media?.type || data.mediaType;
      const normalizedThumbnailUrl = data.media?.thumbnailUrl || data.thumbnailUrl;
      
      // Validate: Pulse video posts MUST have a media URL
      if (data.feedSurface === 'pulse' && normalizedMediaType === 'video' && !normalizedMediaUrl) {
        return res.status(400).json({
          code: "MEDIA_URL_REQUIRED",
          message: "Pulse video posts require a video URL"
        });
      }

      // LOG: Verify feedSurface is received and persisted correctly
      console.log(`[POST /api/feed] RAW REQ BODY:`, JSON.stringify(req.body, null, 2));
      console.log(`[POST /api/feed] NORMALIZED: feedSurface=${data.feedSurface}, mediaType=${normalizedMediaType}, mediaUrl=${normalizedMediaUrl?.substring(0, 50)}, thumbnailUrl=${normalizedThumbnailUrl?.substring(0, 50)}`);
      
      const insertData = {
        authorId: userId,
        authorType,
        postType: data.postType || 'text',
        postIntent: data.postIntent, // 'social' | 'review' | 'promotion'
        displayLayout: data.displayLayout, // 'pro' | 'pulse' - optional, null if not specified (legacy)
        feedSurface: data.feedSurface, // SOURCE OF TRUTH: 'pulse' | 'pro' - persisted exactly as sent
        content: data.content,
        imageUrl: normalizedMediaUrl, // Backwards compat: populate legacy field
        mediaUrl: normalizedMediaUrl,
        mediaType: normalizedMediaType,
        thumbnailUrl: normalizedThumbnailUrl,
        mediaWidth: data.media?.width,
        mediaHeight: data.media?.height,
        aspectRatio: data.media?.aspectRatio,
        taggedBusinessId: data.taggedBusinessId,
        taggedPhotographerId: data.taggedPhotographerId,
        productId: data.productId,
        serviceId: data.serviceId,
        photographerServiceId: data.photographerServiceId,
      };
      console.log(`[POST /api/feed] INSERT DATA:`, JSON.stringify(insertData, null, 2));
      console.log('[POST /api/feed] persisting', { displayLayout: insertData.displayLayout, feedSurface: insertData.feedSurface });
      
      const post = await storage.createFeedPost(insertData as any);
      console.log(`[POST /api/feed] CREATED POST ID=${post.id}, feedSurface=${post.feedSurface}, mediaType=${post.mediaType}`);

      // Build canonical author object
      let authorBusinessId: string | null = null;
      let authorPhotographerId: string | null = null;
      let authorRoleResponse: 'consumer' | 'photographer' | 'vendor' = 'consumer';
      
      if (authorType === 'vendor') {
        const business = await storage.getBusinessByOwnerId(userId);
        if (business) {
          authorBusinessId = business.id;
          authorRoleResponse = 'vendor';
        }
      } else if (authorType === 'photographer') {
        const photographer = await storage.getPhotographerByUserId(userId);
        if (photographer) {
          authorPhotographerId = photographer.id;
          authorRoleResponse = 'photographer';
        }
      }

      // Build media object for response (prefer new fields, fall back to legacy imageUrl)
      const mediaResponse = (post.mediaUrl || post.imageUrl) ? {
        mediaUrl: post.mediaUrl || post.imageUrl,
        mediaType: post.mediaType || 'image',
        width: post.mediaWidth || null,
        height: post.mediaHeight || null,
        aspectRatio: post.aspectRatio || null,
      } : null;

      // Return post with canonical author object
      res.json({ 
        success: true, 
        post: {
          ...post,
          author: {
            userId: user.id,
            username: user.username || null,
            displayName: user.name || user.firstName || 'Anonymous',
            profilePhotoUrl: user.profileImageUrl || null,
            role: authorRoleResponse,
          },
          media: mediaResponse,
          providerId: authorPhotographerId || authorBusinessId || null,
        }
      });
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

  // Save a post
  app.post("/api/feed/:postId/save", async (req, res) => {
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

      const saved = await storage.savePost(postId, userId);
      res.json({ success: true, saved });
    } catch (error) {
      console.error("Save post error:", error);
      res.status(500).json({ error: "Failed to save post" });
    }
  });

  // Unsave a post
  app.delete("/api/feed/:postId/save", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { postId } = req.params;
      await storage.unsavePost(postId, userId);
      res.json({ success: true, saved: false });
    } catch (error) {
      console.error("Unsave post error:", error);
      res.status(500).json({ error: "Failed to unsave post" });
    }
  });

  // Get current user's saved posts
  app.get("/api/users/me/saved-posts", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const posts = await storage.getSavedPosts(userId);
      res.json({ posts });
    } catch (error) {
      console.error("Get saved posts error:", error);
      res.status(500).json({ error: "Failed to get saved posts" });
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

  app.get("/api/feed/:postId", optionalAuthMiddleware, async (req, res) => {
    try {
      const { postId } = req.params;
      const post = await storage.getFeedPost(postId);

      if (!post || post.isActive === false) {
        return res.status(404).json({ error: "Post not found" });
      }

      res.json({ post });
    } catch (error) {
      console.error("Get post error:", error);
      res.status(500).json({ error: "Failed to get post" });
    }
  });

  app.patch("/api/feed/:postId", async (req, res) => {
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
        return res.status(403).json({ error: "You can only edit your own posts" });
      }

      const schema = z.object({
        content: z.string().max(2000),
      });
      const data = schema.parse(req.body);

      const updatedPost = await storage.updateFeedPostContent(postId, data.content);
      res.json({ post: updatedPost });
    } catch (error) {
      console.error("Update post error:", error);
      res.status(500).json({ error: "Failed to update post" });
    }
  });

  // =====================================================
  // PULSE FEED ROUTES (TikTok-style Discovery)
  // =====================================================

  // Get Pulse feed - separate from Pro feed, purely discovery-based
  // Location is optional — if missing, falls back to recency/popularity ranking
  // Supports offset or cursor-based pagination; hard limit 10 per page (max 50)
  app.get("/api/pulse/feed", async (req, res) => {
    try {
      const userId = req.session?.userId || getUserIdFromRequest(req) || undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

      // Support both cursor and offset pagination
      const cursor = req.query.cursor as string | undefined;
      const offset = cursor ? parseInt(Buffer.from(cursor, 'base64').toString(), 10) || 0
        : parseInt(req.query.offset as string) || 0;

      const excludeIds = req.query.excludeIds 
        ? (req.query.excludeIds as string).split(',').filter(Boolean)
        : [];

      // Location is optional — never required, never causes an error
      const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
      const lng = req.query.lng ? parseFloat(req.query.lng as string) : undefined;
      const city = (req.query.city as string) || undefined;

      const { getPulseFeed } = await import('./pulseService');
      const { formatVideoCards } = await import('./feedSerializer');
      
      const posts = await getPulseFeed({
        userId,
        limit,
        offset,
        excludePostIds: excludeIds,
        city,
        lat: (lat !== undefined && !isNaN(lat)) ? lat : undefined,
        lng: (lng !== undefined && !isNaN(lng)) ? lng : undefined,
      });

      // Serialize through VideoCard contract — guaranteed shape, no nulls on required fields
      const videos = formatVideoCards(posts);

      // Batch-fetch liked post IDs for the viewer — ONE query, no N+1
      const pulsePostIds = videos.map(v => v.id).filter(Boolean) as string[];
      const pulseLikedSet = userId
        ? await storage.getLikedPostIds(userId, pulsePostIds)
        : new Set<string>();
      // TODO: remove before final merge
      console.log('[isLiked]', 'feed=pulse', 'viewer=', userId, 'likedCount=', pulseLikedSet.size);
      for (const card of videos) {
        card.isLiked = pulseLikedSet.has(card.id);
      }

      const nextOffset = offset + videos.length;
      const hasMore = videos.length === limit;
      const nextCursor = hasMore ? Buffer.from(String(nextOffset)).toString('base64') : null;

      res.json({
        success: true,
        data: {
          videos,
          nextCursor,
          hasMore,
          nextOffset,
          pageSize: limit,
        },
      });
    } catch (error) {
      console.error("Get Pulse feed error:", error);
      res.status(500).json({ success: false, message: "Failed to get Pulse feed", data: { videos: [], nextCursor: null, hasMore: false } });
    }
  });

  // Record engagement for Pulse ranking
  app.post("/api/pulse/engagement", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const schema = z.object({
        postId: z.string().min(1),
        watchTimeMs: z.number().int().min(0),
        videoDurationMs: z.number().int().min(0),
        isRewatch: z.boolean().optional().default(false),
        shared: z.boolean().optional(),
        saved: z.boolean().optional(),
      });

      const data = schema.parse(req.body);
      const { recordEngagement } = await import('./pulseService');
      
      const engagement = await recordEngagement({
        userId,
        postId: data.postId,
        watchTimeMs: data.watchTimeMs,
        videoDurationMs: data.videoDurationMs,
        isRewatch: data.isRewatch,
        shared: data.shared,
        saved: data.saved,
      });

      res.json({ success: true, engagement });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid engagement data", details: error.errors });
      }
      console.error("Record Pulse engagement error:", error);
      res.status(500).json({ error: "Failed to record engagement" });
    }
  });

  // Get post distribution stats (for debugging/analytics)
  app.get("/api/pulse/distribution/:postId", async (req, res) => {
    try {
      const { postId } = req.params;
      const { getPostDistribution } = await import('./pulseService');
      
      const dist = await getPostDistribution(postId);
      if (!dist) {
        return res.status(404).json({ error: "Distribution data not found" });
      }

      res.json({ distribution: dist });
    } catch (error) {
      console.error("Get post distribution error:", error);
      res.status(500).json({ error: "Failed to get distribution data" });
    }
  });

  // Get user interests (for debugging/personalization insights)
  app.get("/api/pulse/interests", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { getUserInterests } = await import('./pulseService');
      
      const interests = await getUserInterests(userId);
      res.json({ interests: interests || { interestVector: {}, recentEngagements: [] } });
    } catch (error) {
      console.error("Get user interests error:", error);
      res.status(500).json({ error: "Failed to get user interests" });
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

  // Consumer: Confirm delivery of an order
  app.post("/api/orders/:orderId/confirm-delivery", hybridAuthMiddleware, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId || req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const { orderId } = req.params;
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.customerId !== userId) {
        return res.status(403).json({ error: "Not authorized to confirm this order" });
      }
      if (order.status === 'delivered') {
        return res.json({ message: "Order already marked as delivered" });
      }
      if (order.status !== 'shipped') {
        return res.status(400).json({ error: "Order must be in shipped status to confirm delivery" });
      }

      const shipments = await storage.getShipmentsByOrder(orderId);
      if (shipments.length > 0) {
        await storage.updateShipment(shipments[0].id, {
          status: 'delivered',
          deliveredAt: new Date(),
        });
      }

      await storage.updateOrder(orderId, { status: 'delivered' });

      storage.createAuditLog({
        actorId: userId,
        actorType: 'user',
        action: 'consumer_confirmed_delivery',
        targetType: 'order',
        targetId: orderId,
        metadata: { shipmentId: shipments[0]?.id ?? null },
      }).catch(err => console.error('Audit log error (confirm_delivery):', err));

      return res.json({ message: "Delivery confirmed" });
    } catch (error) {
      console.error("Confirm delivery error:", error);
      return res.status(500).json({ error: "Failed to confirm delivery" });
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

        // Phase 1d: audit log for shipment delivered
        storage.createAuditLog({
          actorId: userId,
          actorType: 'user',
          action: 'shipment_delivered',
          targetType: 'order',
          targetId: shipment.orderId,
          metadata: { shipmentId, carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
        }).catch(err => console.error('Audit log error (shipment_delivered):', err));
        
        // Credit influencer earnings if this order has a referral event (atomic/idempotent)
        try {
          const order = await storage.getOrder(shipment.orderId);
          if (order) {
            const referralEvents = await storage.getInfluencerReferralEventsByOrder(shipment.orderId);
            for (const event of referralEvents) {
              // Skip if already credited (fast check before DB operations)
              if (event.creditedAt) {
                console.log(`[influencer] Skipping already credited referral event ${event.id} for order ${shipment.orderId}`);
                continue;
              }
              
              // Only process if there's commission to credit
              if (event.commissionEarnedCents && event.commissionEarnedCents > 0) {
                // Create earning ledger entry linked to this referral event
                const ledgerEntry = await storage.createInfluencerEarningLedger({
                  influencerId: event.influencerId,
                  sourceType: "referral_commission",
                  sourceRefId: event.id,
                  amountCents: event.commissionEarnedCents,
                  description: `Commission from order #${shipment.orderId.slice(0, 8)}`,
                  status: "pending",
                });
                
                // Atomically mark the referral event as credited (only succeeds if creditedAt is NULL)
                const wasCredited = await storage.markInfluencerReferralEventCredited(event.id, ledgerEntry.id);
                
                if (!wasCredited) {
                  // Another concurrent request already credited this event - delete the duplicate ledger entry
                  console.log(`[influencer] Concurrent credit detected for event ${event.id}, rolling back duplicate ledger entry ${ledgerEntry.id}`);
                  await storage.updateInfluencerEarningLedger(ledgerEntry.id, { status: "cancelled" });
                  continue;
                }
                
                // Update influencer profile pending earnings
                const profile = await storage.getInfluencerProfile(event.influencerId);
                if (profile) {
                  await storage.updateInfluencerProfile(event.influencerId, {
                    pendingEarnings: (profile.pendingEarnings || 0) + event.commissionEarnedCents,
                  });
                }
                
                console.log(`[influencer] Credited ${event.commissionEarnedCents} cents to influencer ${event.influencerId} for order ${shipment.orderId} (ledger entry ${ledgerEntry.id})`);
              }
            }
          }
        } catch (influencerError) {
          console.error("Error processing influencer referral:", influencerError);
          // Don't fail the shipment update if influencer crediting fails
        }
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
  app.get("/api/my-orders", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const orders = await storage.getUserOrders(userId);
      
      // Enrich orders with business names, shipment info, and item image URLs
      const enrichedOrders = await Promise.all(
        orders.map(async (order) => {
          const business = await storage.getBusiness(order.businessId);
          const shipments = await storage.getShipmentsByOrder(order.id);

          const productIds = (order.items ?? []).map((item) => item.productId);
          const imageMap = await storage.getProductImagesByIds(productIds);

          return {
            id: order.id,
            businessId: order.businessId,
            businessName: business?.name || "Unknown Business",
            items: (order.items ?? []).map((item) => ({
              productId: item.productId,
              name: item.name,
              quantity: item.quantity,
              price: item.price,
              imageUrl: imageMap[item.productId] ?? null,
            })),
            total: order.totalAmount,
            grossChargeAmount: order.grossChargeAmount,
            shippingAddress: order.shippingAddress,
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

  /* =====================================================
     TEMP / TEST ONLY - Development Test Endpoints
     Remove before production deployment
  ===================================================== */

  /**
   * TEMP / TEST ONLY: Create or retrieve a draft photographer booking for payment testing
   * This endpoint bypasses normal booking flow for Postman/API testing purposes
   * 
   * Usage: POST /api/dev/test-booking
   * Optional body: { photographerId?: string, clientId?: string, totalPrice?: number }
   * 
   * DO NOT USE IN PRODUCTION - Remove before deployment
   */
  app.post("/api/dev/test-booking", async (req, res) => {
    // TEMP / TEST ONLY - This endpoint is for development testing
    console.log("[DEV] Test booking endpoint called - FOR TESTING ONLY");

    try {
      const { photographerId, clientId, totalPrice } = req.body;

      // Try to find an existing draft booking first
      const existingDraft = await db.select()
        .from(shootBookings)
        .where(eq(shootBookings.status, BOOKING_STATES.DRAFT))
        .orderBy(desc(shootBookings.createdAt))
        .limit(1);

      if (existingDraft.length > 0) {
        console.log(`[DEV] Returning existing draft booking: ${existingDraft[0].id}`);
        return res.json({
          bookingId: existingDraft[0].id,
          status: existingDraft[0].status,
          total: existingDraft[0].totalPrice,
          photographerId: existingDraft[0].photographerId,
          clientId: existingDraft[0].clientId,
          message: "Existing draft booking found"
        });
      }

      // No existing draft - create a new one with placeholder data
      // First, find a photographer and user to use
      const allPhotographers = await storage.getAllPhotographers();
      const allUsers = await storage.getAllUsers();

      if (allPhotographers.length === 0) {
        return res.status(400).json({ 
          error: "No photographers exist in the database. Create a photographer first." 
        });
      }

      if (allUsers.length === 0) {
        return res.status(400).json({ 
          error: "No users exist in the database. Create a user first." 
        });
      }

      const testPhotographerId = photographerId || allPhotographers[0].id;
      const testClientId = clientId || allUsers[0].id;
      const testTotalPrice = totalPrice || 7500; // $75.00 default

      // Create the draft booking
      const newBookingId = crypto.randomUUID();
      const now = new Date();
      const scheduledDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 1 week from now

      await db.insert(shootBookings).values({
        id: newBookingId,
        photographerId: testPhotographerId,
        clientId: testClientId,
        status: BOOKING_STATES.DRAFT,
        totalPrice: testTotalPrice,
        shootType: "portrait", // Required field
        date: scheduledDate.toISOString().split('T')[0], // YYYY-MM-DD format
        startTime: "10:00",
        endTime: "11:00",
        durationHours: 1,
        locationType: "studio",
        locationDetails: "Test Location - 123 Main St",
        specialRequests: "TEST BOOKING - Created via /api/dev/test-booking endpoint",
        createdAt: now,
        updatedAt: now,
        draftExpiresAt: new Date(now.getTime() + 10 * 60 * 1000) // 10 minutes from now
      });

      console.log(`[DEV] Created new test draft booking: ${newBookingId}`);

      res.json({
        bookingId: newBookingId,
        status: BOOKING_STATES.DRAFT,
        total: testTotalPrice,
        photographerId: testPhotographerId,
        clientId: testClientId,
        scheduledDate: scheduledDate.toISOString(),
        message: "New draft booking created for testing"
      });
    } catch (error: any) {
      console.error("[DEV] Test booking error:", error);
      res.status(500).json({ error: "Failed to create test booking", details: error.message });
    }
  });

  /**
   * TEMP / TEST ONLY: Get a test booking for an appointment (business service)
   * POST /api/dev/test-appointment
   */
  app.post("/api/dev/test-appointment", async (req, res) => {
    console.log("[DEV] Test appointment endpoint called - FOR TESTING ONLY");

    try {
      const { businessId, clientId, totalPrice } = req.body;

      // Try to find an existing draft appointment first
      const existingDraft = await db.select()
        .from(appointments)
        .where(eq(appointments.status, BOOKING_STATES.DRAFT))
        .orderBy(desc(appointments.createdAt))
        .limit(1);

      if (existingDraft.length > 0) {
        console.log(`[DEV] Returning existing draft appointment: ${existingDraft[0].id}`);
        return res.json({
          bookingId: existingDraft[0].id,
          status: existingDraft[0].status,
          total: existingDraft[0].totalPrice,
          businessId: existingDraft[0].businessId,
          clientId: existingDraft[0].clientId,
          message: "Existing draft appointment found"
        });
      }

      // No existing draft - create a new one
      const allBusinesses = await storage.getAllBusinesses();
      const allUsers = await storage.getAllUsers();
      const allServices = await storage.getServices();

      if (allBusinesses.length === 0) {
        return res.status(400).json({ 
          error: "No businesses exist in the database. Create a business first." 
        });
      }

      if (allUsers.length === 0) {
        return res.status(400).json({ 
          error: "No users exist in the database. Create a user first." 
        });
      }

      const testBusinessId = businessId || allBusinesses[0].id;
      const testClientId = clientId || allUsers[0].id;
      const testTotalPrice = totalPrice || 5000; // $50.00 default
      const testServiceId = allServices.length > 0 ? allServices[0].id : null;

      const newAppointmentId = crypto.randomUUID();
      const now = new Date();
      const scheduledDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      await db.insert(appointments).values({
        id: newAppointmentId,
        businessId: testBusinessId,
        clientId: testClientId,
        serviceId: testServiceId || '',
        status: BOOKING_STATES.DRAFT,
        totalPrice: testTotalPrice,
        appointmentDate: scheduledDate.toISOString().split('T')[0],
        appointmentTime: '10:00',
        durationMinutes: 30,
        createdAt: now,
        updatedAt: now,
        draftExpiresAt: new Date(now.getTime() + 10 * 60 * 1000)
      });

      console.log(`[DEV] Created new test draft appointment: ${newAppointmentId}`);

      res.json({
        bookingId: newAppointmentId,
        status: BOOKING_STATES.DRAFT,
        total: testTotalPrice,
        businessId: testBusinessId,
        clientId: testClientId,
        scheduledDate: scheduledDate.toISOString(),
        message: "New draft appointment created for testing"
      });
    } catch (error: any) {
      console.error("[DEV] Test appointment error:", error);
      res.status(500).json({ error: "Failed to create test appointment", details: error.message });
    }
  });

  /**
   * TEMP / TEST ONLY: Create a Stripe PaymentIntent for testing
   * POST /api/dev/test-payment-intent
   * 
   * Body: { bookingId: string, amount?: number (cents, default 7500) }
   * 
   * This endpoint:
   * - Creates a PaymentIntent in Stripe test mode
   * - Attaches bookingId in metadata
   * - Does NOT confirm or capture payment
   * - Does NOT require authentication
   * 
   * Returns: { paymentIntentId, clientSecret, status }
   */
  app.post("/api/dev/test-payment-intent", async (req, res) => {
    console.log("[DEV] ===== TEST PAYMENT INTENT ENDPOINT - FOR TESTING ONLY =====");

    try {
      const { bookingId, amount } = req.body;

      if (!bookingId) {
        return res.status(400).json({ 
          error: "bookingId is required" 
        });
      }

      const testAmount = amount || 7500; // Default $75.00

      console.log(`[DEV] Creating PaymentIntent for bookingId: ${bookingId}, amount: ${testAmount} cents`);

      // Get Stripe client
      const stripe = await getUncachableStripeClient();
      
      // Create PaymentIntent directly via Stripe SDK (no connected account, platform only)
      const paymentIntent = await stripe.paymentIntents.create({
        amount: testAmount,
        currency: 'usd',
        capture_method: 'manual', // Don't capture automatically
        metadata: {
          test_mode: 'true',
          bookingId: bookingId,
          created_via: '/api/dev/test-payment-intent',
          created_at: new Date().toISOString()
        },
        description: `TEST PaymentIntent for booking ${bookingId}`,
      });

      console.log(`[DEV] ✓ PaymentIntent created successfully!`);
      console.log(`[DEV]   - PaymentIntent ID: ${paymentIntent.id}`);
      console.log(`[DEV]   - Status: ${paymentIntent.status}`);
      console.log(`[DEV]   - Amount: ${paymentIntent.amount} ${paymentIntent.currency}`);
      console.log(`[DEV]   - Capture Method: ${paymentIntent.capture_method}`);
      console.log(`[DEV]   - Metadata: ${JSON.stringify(paymentIntent.metadata)}`);
      console.log(`[DEV] ===== END TEST PAYMENT INTENT =====`);

      res.json({
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        captureMethod: paymentIntent.capture_method,
        metadata: paymentIntent.metadata,
        message: "TEST PaymentIntent created - check Stripe Dashboard"
      });
    } catch (error: any) {
      console.error("[DEV] Test PaymentIntent error:", error);
      res.status(500).json({ 
        error: "Failed to create test PaymentIntent", 
        details: error.message,
        type: error.type || 'unknown'
      });
    }
  });

  /* END TEMP / TEST ONLY */

  // ==================== PHASE 3 ROUTES ====================
  const { registerPhase3Routes } = await import("./phase3Routes");
  registerPhase3Routes(app, requireAdmin);

  // ==================== PLACES PROXY ROUTES ====================
  const { registerPlacesRoutes } = await import("./placesRoutes");
  registerPlacesRoutes(app);

  // ==================== MEDIA ROUTES (R2 + Mux) ====================

  const multerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  });

  // POST /api/media/upload-image — upload an image to Cloudflare R2 (auth required)
  app.post("/api/media/upload-image", hybridAuthMiddleware, (req, res, next) => {
    multerUpload.single("file")(req as any, res as any, next);
  }, async (req, res) => {
    if (!(req as any).file) {
      return res.status(400).json({ error: "No file provided" });
    }
    const file = (req as any).file as Express.Multer.File;
    const folder = (req.body?.folder as string) || "posts";
    const allowedFolders = ["posts", "profiles", "covers", "products", "logos"];
    if (!allowedFolders.includes(folder)) {
      return res.status(400).json({ error: "Invalid folder" });
    }
    try {
      const { uploadImageToR2 } = await import("./services/r2");
      const url = await uploadImageToR2(file.buffer, file.mimetype, folder);
      return res.json({ url });
    } catch (error) {
      console.error("[R2] Image upload failed:", error);
      return res.status(500).json({ error: "Failed to upload image" });
    }
  });

  // POST /api/media/video-upload-url — issue a Mux direct-upload URL (auth required)
  app.post("/api/media/video-upload-url", hybridAuthMiddleware, async (req, res) => {
    try {
      const { createMuxUploadUrl } = await import("./services/mux");
      const result = await createMuxUploadUrl();
      return res.json(result);
    } catch (error) {
      console.error("[Mux] Failed to create upload URL:", error);
      return res.status(500).json({ error: "Failed to create video upload URL" });
    }
  });

  // POST /api/webhooks/mux — Mux webhook handler
  // Updates the feed_posts record when a video finishes processing on Mux.
  // The mediaUrl field temporarily holds the Mux uploadId so we can locate
  // the right row once the asset is ready.
  app.post("/api/webhooks/mux", async (req, res) => {
    try {
      const payload = req.body;
      const { type, data } = payload ?? {};

      if (type === "video.asset.ready") {
        const playbackId: string | undefined = data?.playback_ids?.[0]?.id;
        const uploadId: string | undefined = data?.upload_id;

        if (playbackId && uploadId) {
          const videoUrl = `https://stream.mux.com/${playbackId}.m3u8`;
          const thumbnailUrl = `https://image.mux.com/${playbackId}/thumbnail.jpg`;

          await db
            .update(feedPosts)
            .set({
              mediaUrl: videoUrl,
              imageUrl: videoUrl,
              thumbnailUrl,
              updatedAt: new Date(),
            })
            .where(eq(feedPosts.mediaUrl, uploadId));

          console.log(
            `[Mux] webhook: updated post for uploadId=${uploadId} → playbackId=${playbackId}`
          );

          // Update businesses whose coverImage was set to the Mux uploadId
          const businessResult = await db
            .update(businesses)
            .set({ coverImage: videoUrl })
            .where(eq(businesses.coverImage, uploadId));

          console.log(
            `[Mux] webhook: updated businesses coverImage for uploadId=${uploadId} → ${videoUrl}`
          );

          // Update photographers whose coverImage was set to the Mux uploadId
          const photographerResult = await db
            .update(photographers)
            .set({ coverImage: videoUrl })
            .where(eq(photographers.coverImage, uploadId));

          console.log(
            `[Mux] webhook: updated photographers coverImage for uploadId=${uploadId} → ${videoUrl}`
          );
        }
      }

      return res.json({ received: true });
    } catch (error) {
      console.error("[Mux] Webhook processing error:", error);
      return res.status(500).json({ error: "Webhook processing error" });
    }
  });

  // =========================
  // SAVED PAYMENT METHODS
  // =========================

  app.get("/api/me/payment-methods", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      if (!user.stripeCustomerId) {
        return res.json({ paymentMethods: [], defaultPaymentMethodId: null });
      }

      const stripe = await getUncachableStripeClient();
      const pms = await stripe.paymentMethods.list({
        customer: user.stripeCustomerId,
        type: 'card',
        limit: 20,
      });

      res.json({
        paymentMethods: pms.data,
        defaultPaymentMethodId: user.defaultPaymentMethodId || null,
      });
    } catch (error: any) {
      console.error("List payment methods error:", error);
      res.status(500).json({ error: "Failed to list payment methods" });
    }
  });

  app.post("/api/me/payment-methods/setup-intent", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const stripeCustomerId = await stripeService.getOrCreateStripeCustomer({
        userId,
        email: user.email,
        name: user.name || undefined,
        existingStripeCustomerId: user.stripeCustomerId,
      });
      if (!user.stripeCustomerId || user.stripeCustomerId !== stripeCustomerId) {
        await storage.updateUser(userId, { stripeCustomerId });
      }

      const stripe = await getUncachableStripeClient();
      const setupIntent = await stripe.setupIntents.create({
        customer: stripeCustomerId,
        usage: 'off_session',
        automatic_payment_methods: { enabled: true },
      });

      res.json({ clientSecret: setupIntent.client_secret, setupIntentId: setupIntent.id });
    } catch (error: any) {
      console.error("Create SetupIntent error:", error);
      res.status(500).json({ error: "Failed to create setup intent" });
    }
  });

  app.delete("/api/me/payment-methods/:paymentMethodId", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const { paymentMethodId } = req.params;
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.stripeCustomerId) return res.status(400).json({ error: "No saved payment methods" });

      const stripe = await getUncachableStripeClient();
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (pm.customer !== user.stripeCustomerId) {
        return res.status(403).json({ error: "Payment method does not belong to this account" });
      }

      await stripe.paymentMethods.detach(paymentMethodId);

      if (user.defaultPaymentMethodId === paymentMethodId) {
        await storage.updateUser(userId, { defaultPaymentMethodId: null });
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete payment method error:", error);
      res.status(500).json({ error: "Failed to delete payment method" });
    }
  });

  app.patch("/api/me/payment-methods/default", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const { paymentMethodId } = req.body;
      if (!paymentMethodId || typeof paymentMethodId !== 'string') {
        return res.status(400).json({ error: "paymentMethodId is required" });
      }

      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.stripeCustomerId) return res.status(400).json({ error: "No saved payment methods" });

      const stripe = await getUncachableStripeClient();
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (pm.customer !== user.stripeCustomerId) {
        return res.status(403).json({ error: "Payment method does not belong to this account" });
      }

      await storage.updateUser(userId, { defaultPaymentMethodId: paymentMethodId });
      res.json({ success: true, defaultPaymentMethodId: paymentMethodId });
    } catch (error: any) {
      console.error("Set default payment method error:", error);
      res.status(500).json({ error: "Failed to set default payment method" });
    }
  });

  // =========================
  // CONSUMER SAVED ADDRESSES
  // =========================

  app.get("/api/me/addresses", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const addresses = await storage.getConsumerAddresses(userId);
      res.json({ addresses });
    } catch (error: any) {
      console.error("List addresses error:", error);
      res.status(500).json({ error: "Failed to list addresses" });
    }
  });

  app.post("/api/me/addresses", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const parsed = insertConsumerAddressSchema.safeParse({ ...req.body, userId });
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid address data", details: parsed.error.flatten() });
      }

      // If new address is default, clear isDefault on all existing addresses first
      if (parsed.data.isDefault) {
        const existing = await storage.getConsumerAddresses(userId);
        for (const addr of existing) {
          if (addr.isDefault) {
            await storage.updateConsumerAddress(addr.id, userId, { isDefault: false });
          }
        }
      }

      const address = await storage.createConsumerAddress(parsed.data);
      res.status(201).json({ address });
    } catch (error: any) {
      console.error("Create address error:", error);
      res.status(500).json({ error: "Failed to create address" });
    }
  });

  app.put("/api/me/addresses/:id", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const { id } = req.params;

      // If updating to isDefault=true, clear isDefault on all other addresses first
      if (req.body.isDefault === true) {
        const existing = await storage.getConsumerAddresses(userId);
        for (const addr of existing) {
          if (addr.isDefault && addr.id !== id) {
            await storage.updateConsumerAddress(addr.id, userId, { isDefault: false });
          }
        }
      }

      const address = await storage.updateConsumerAddress(id, userId, req.body);
      res.json({ address });
    } catch (error: any) {
      if (error.message === 'Address not found or access denied') {
        return res.status(404).json({ error: error.message });
      }
      console.error("Update address error:", error);
      res.status(500).json({ error: "Failed to update address" });
    }
  });

  app.delete("/api/me/addresses/:id", authMiddleware, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const { id } = req.params;
      await storage.deleteConsumerAddress(id, userId);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete address error:", error);
      res.status(500).json({ error: "Failed to delete address" });
    }
  });

  return httpServer;
}
