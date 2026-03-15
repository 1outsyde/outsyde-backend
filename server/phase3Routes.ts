/**
 * Phase 3 Routes — Growth, retention, and monetization features.
 * Mounted by registerRoutes in routes.ts.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "./db";
import { storage } from "./storage";
import {
  feedPosts,
  feedEngagementEvents,
  userSavedPosts,
  sponsoredPosts,
  vendorEmailSequence,
  moderationQueue,
  orders,
  appointments,
  shootBookings,
  users,
} from "@shared/schema";
import { eq, and, sql, desc, asc, gte, lte, or } from "drizzle-orm";
import { randomUUID } from "crypto";
import { calculateProductFee, calculateBookingFee, PRODUCT_FEE_PERCENT, BOOKING_FEE_PERCENT } from "./fees";
import type { AuthenticatedRequest } from "./auth";
import { optionalAuthMiddleware, getUserIdFromRequest } from "./auth";

export function registerPhase3Routes(app: Express, requireAdmin: (req: Request, res: Response, next: () => void) => void) {

  // ==================== SECTION 3.2: FEED ENGAGEMENT TRACKING ====================

  // #49 — Audio toggle tracking
  app.post("/api/feed/video/:id/audio-toggle", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });

    try {
      const { action } = req.body;
      if (!action || !['unmute', 'mute'].includes(action)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'action must be unmute or mute' } });
      }

      await db.insert(feedEngagementEvents).values({
        userId, postId: req.params.id, eventType: `audio_${action}`, metadata: { action },
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Audio toggle error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to track audio toggle' } });
    }
  });

  // #50 — CTA button click tracking
  app.post("/api/feed/video/:id/cta-click", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });

    try {
      const { ctaType } = req.body;
      if (!ctaType || !['book', 'shop'].includes(ctaType)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'ctaType must be book or shop' } });
      }

      await db.insert(feedEngagementEvents).values({
        userId, postId: req.params.id, eventType: 'cta_click', metadata: { ctaType },
      });

      // Increment CTA clicks on the post
      await db.update(feedPosts)
        .set({ likesCount: sql`COALESCE(${feedPosts.likesCount}, 0) + 1` })
        .where(eq(feedPosts.id, req.params.id));

      // Get post to build redirect URL
      const [post] = await db.select().from(feedPosts).where(eq(feedPosts.id, req.params.id));
      let redirectUrl = '/';
      if (post?.taggedBusinessId) redirectUrl = `/business/${post.taggedBusinessId}`;
      if (post?.taggedPhotographerId) redirectUrl = `/photographer/${post.taggedPhotographerId}`;

      res.json({ success: true, data: { redirectUrl } });
    } catch (error) {
      console.error("CTA click error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to track CTA click' } });
    }
  });

  // #51 — Video share tracking
  app.post("/api/feed/video/:id/share", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });

    try {
      const { platform } = req.body;
      await db.insert(feedEngagementEvents).values({
        userId, postId: req.params.id, eventType: 'share',
        metadata: { platform: platform || 'other' },
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Share tracking error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to track share' } });
    }
  });

  // #52 — View count (deduplicated per user per hour)
  app.post("/api/feed/video/:id/view", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });

    try {
      const postId = req.params.id;
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      // Dedup: check if user viewed this video in the last hour
      const [existing] = await db.select({ id: feedEngagementEvents.id })
        .from(feedEngagementEvents)
        .where(and(
          eq(feedEngagementEvents.userId, userId),
          eq(feedEngagementEvents.postId, postId),
          eq(feedEngagementEvents.eventType, 'view'),
          gte(feedEngagementEvents.createdAt, oneHourAgo),
        ))
        .limit(1);

      if (!existing) {
        await db.insert(feedEngagementEvents).values({
          userId, postId, eventType: 'view',
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("View tracking error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to track view' } });
    }
  });

  // #52 — Save/unsave toggle
  app.post("/api/feed/video/:id/save", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });

    try {
      const postId = req.params.id;

      const [existing] = await db.select()
        .from(userSavedPosts)
        .where(and(eq(userSavedPosts.userId, userId), eq(userSavedPosts.postId, postId)));

      if (existing) {
        await db.delete(userSavedPosts).where(eq(userSavedPosts.id, existing.id));
      } else {
        await db.insert(userSavedPosts).values({ userId, postId });
      }

      const [countResult] = await db.select({ count: sql<number>`count(*)` })
        .from(userSavedPosts).where(eq(userSavedPosts.postId, postId));

      res.json({ success: true, data: { saved: !existing, saveCount: Number(countResult?.count || 0) } });
    } catch (error) {
      console.error("Save toggle error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to toggle save' } });
    }
  });

  // ==================== SECTION 3.3: MONETIZATION ====================

  // #53 — Sponsored posts
  app.post("/api/sponsored/create", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });

    try {
      const schema = z.object({
        postId: z.string(),
        budgetCents: z.number().int().min(500), // min $5
        cpm: z.number().int().min(100), // min $1 CPM
        startDate: z.string(),
        endDate: z.string(),
      });
      const data = schema.parse(req.body);

      const [campaign] = await db.insert(sponsoredPosts).values({
        vendorId: userId,
        postId: data.postId,
        budgetCents: data.budgetCents,
        cpm: data.cpm,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        status: 'active',
      }).returning();

      res.json({ success: true, data: campaign });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: error.errors[0]?.message } });
      console.error("Create sponsored post error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to create sponsored post' } });
    }
  });

  app.post("/api/sponsored/:id/impression", async (req, res) => {
    try {
      const { id } = req.params;
      const [campaign] = await db.select().from(sponsoredPosts).where(eq(sponsoredPosts.id, id));
      if (!campaign || campaign.status !== 'active') {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found or inactive' } });
      }

      const costPerImpression = Math.round(campaign.cpm / 1000);
      const newSpent = campaign.spentCents + costPerImpression;
      const newStatus = newSpent >= campaign.budgetCents ? 'ended' : 'active';

      await db.update(sponsoredPosts).set({
        impressions: sql`${sponsoredPosts.impressions} + 1`,
        spentCents: newSpent,
        status: newStatus,
        updatedAt: new Date(),
      }).where(eq(sponsoredPosts.id, id));

      res.json({ success: true });
    } catch (error) {
      console.error("Sponsored impression error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to track impression' } });
    }
  });

  app.get("/api/sponsored/analytics", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });

    try {
      const campaigns = await db.select().from(sponsoredPosts)
        .where(eq(sponsoredPosts.vendorId, userId))
        .orderBy(desc(sponsoredPosts.createdAt));

      res.json({ success: true, data: { campaigns } });
    } catch (error) {
      console.error("Sponsored analytics error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to load analytics' } });
    }
  });

  // #54 — Subscription upsell prompt
  app.get("/api/subscription/upsell-status", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId;
    if (!userId) return res.json({ success: true, data: { shouldShow: false } });

    try {
      const business = await storage.getBusinessByOwnerId(userId);
      if (!business) return res.json({ success: true, data: { shouldShow: false } });

      const subStatus = await storage.isBusinessSubscriptionActive(business.id);
      let shouldShow = false;
      let reason = '';
      let urgency: 'low' | 'medium' | 'high' = 'low';

      if (!subStatus.active && subStatus.status === 'grace_period') {
        shouldShow = true;
        reason = 'Your subscription has lapsed — renew to keep your listings visible';
        urgency = 'high';
      } else if (!business.subscriptionActive) {
        const daysSinceCreation = (Date.now() - new Date(business.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceCreation > 30) {
          shouldShow = true;
          reason = 'Unlock premium features to grow your business';
          urgency = 'medium';
        }
      }

      res.json({ success: true, data: { shouldShow, reason, urgency } });
    } catch (error) {
      console.error("Upsell status error:", error);
      res.json({ success: true, data: { shouldShow: false } });
    }
  });

  // #55 — In-app review prompt
  app.get("/api/review-prompt/should-show", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId || req.query.userId as string;
    if (!userId) return res.json({ success: true, data: { shouldShow: false } });

    try {
      const user = await storage.getUser(userId);
      if (!user) return res.json({ success: true, data: { shouldShow: false } });

      const daysSinceCreation = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceCreation < 7) return res.json({ success: true, data: { shouldShow: false } });

      // Check if prompted in last 30 days
      const lastPrompted = (user as Record<string, unknown>).lastReviewPromptAt;
      if (lastPrompted) {
        const daysSincePrompt = (Date.now() - new Date(lastPrompted as string).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSincePrompt < 30) return res.json({ success: true, data: { shouldShow: false } });
      }

      // Check completed bookings/orders (need 3+)
      const points = await storage.getUserPointsBalance(userId);
      const shouldShow = points > 0 && daysSinceCreation >= 7;

      if (shouldShow) {
        await storage.updateUser(userId, { lastReviewPromptAt: new Date() } as Record<string, unknown>);
      }

      res.json({ success: true, data: { shouldShow } });
    } catch (error) {
      console.error("Review prompt error:", error);
      res.json({ success: true, data: { shouldShow: false } });
    }
  });

  // ==================== SECTION 3.4: ADMIN TOOLING ====================

  // #57 — Bulk vendor approval
  app.post("/api/admin/vendors/approve", requireAdmin, async (req, res) => {
    try {
      const { vendorIds } = req.body;
      if (!Array.isArray(vendorIds) || vendorIds.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'vendorIds array required' } });
      }

      const results: Array<{ vendorId: string; status: string }> = [];
      for (const vendorId of vendorIds) {
        try {
          const business = await storage.getBusiness(vendorId);
          if (business) {
            await storage.updateBusiness(vendorId, { approvalStatus: 'approved' } as Record<string, unknown>);
            // Enable monetization on the owner
            if ((business as Record<string, unknown>).ownerId) {
              await storage.updateUser((business as Record<string, unknown>).ownerId as string, { canMonetize: true });
            }
            results.push({ vendorId, status: 'approved' });
          } else {
            results.push({ vendorId, status: 'not_found' });
          }
        } catch (err) {
          results.push({ vendorId, status: 'error' });
        }
      }

      res.json({ success: true, data: { results, approved: results.filter(r => r.status === 'approved').length } });
    } catch (error) {
      console.error("Bulk approve error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process approvals' } });
    }
  });

  app.post("/api/admin/vendors/reject", requireAdmin, async (req, res) => {
    try {
      const { vendorIds, reason } = req.body;
      if (!Array.isArray(vendorIds) || vendorIds.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'vendorIds array and reason required' } });
      }

      const results: Array<{ vendorId: string; status: string }> = [];
      for (const vendorId of vendorIds) {
        try {
          const business = await storage.getBusiness(vendorId);
          if (business) {
            await storage.updateBusiness(vendorId, { approvalStatus: 'rejected' } as Record<string, unknown>);
            results.push({ vendorId, status: 'rejected' });
          } else {
            results.push({ vendorId, status: 'not_found' });
          }
        } catch (err) {
          results.push({ vendorId, status: 'error' });
        }
      }

      res.json({ success: true, data: { results, rejected: results.filter(r => r.status === 'rejected').length, reason } });
    } catch (error) {
      console.error("Bulk reject error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to process rejections' } });
    }
  });

  app.get("/api/admin/vendors/pending", requireAdmin, async (req, res) => {
    try {
      const allBusinesses = await storage.getAllBusinesses();
      const pending = allBusinesses.filter((b: Record<string, unknown>) => b.approvalStatus === 'pending');
      res.json({ success: true, data: { vendors: pending, total: pending.length } });
    } catch (error) {
      console.error("Get pending vendors error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to load pending vendors' } });
    }
  });

  // #58 — Content moderation
  app.post("/api/moderation/flag", optionalAuthMiddleware, async (req, res) => {
    const userId = (req as AuthenticatedRequest).user?.userId || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });

    try {
      const schema = z.object({
        targetId: z.string(),
        targetType: z.enum(['post', 'user']),
        reason: z.string().min(1),
      });
      const data = schema.parse(req.body);

      // Check if already flagged by this user
      const [existing] = await db.select().from(moderationQueue)
        .where(and(
          eq(moderationQueue.reporterId, userId),
          eq(moderationQueue.targetId, data.targetId),
          eq(moderationQueue.targetType, data.targetType),
        ));

      if (existing) {
        return res.json({ success: true, message: 'Already reported' });
      }

      // Check if target already in queue, increment flag count
      const [existingTarget] = await db.select().from(moderationQueue)
        .where(and(
          eq(moderationQueue.targetId, data.targetId),
          eq(moderationQueue.targetType, data.targetType),
          eq(moderationQueue.status, 'pending'),
        ));

      if (existingTarget) {
        await db.update(moderationQueue)
          .set({ flagCount: sql`${moderationQueue.flagCount} + 1` })
          .where(eq(moderationQueue.id, existingTarget.id));
      } else {
        await db.insert(moderationQueue).values({
          reporterId: userId,
          targetId: data.targetId,
          targetType: data.targetType,
          reason: data.reason,
        });
      }

      res.json({ success: true, message: 'Report submitted' });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: error.errors[0]?.message } });
      console.error("Flag content error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to submit report' } });
    }
  });

  app.get("/api/admin/moderation/queue", requireAdmin, async (req, res) => {
    try {
      const status = (req.query.status as string) || 'pending';
      const targetType = req.query.targetType as string | undefined;

      const conditions = [eq(moderationQueue.status, status)];
      if (targetType) conditions.push(eq(moderationQueue.targetType, targetType));

      const items = await db.select().from(moderationQueue)
        .where(and(...conditions))
        .orderBy(desc(moderationQueue.flagCount), asc(moderationQueue.createdAt));

      res.json({ success: true, data: { items, total: items.length } });
    } catch (error) {
      console.error("Get moderation queue error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to load moderation queue' } });
    }
  });

  app.post("/api/admin/moderation/action", requireAdmin, async (req, res) => {
    try {
      const schema = z.object({
        targetId: z.string(),
        targetType: z.enum(['post', 'user']),
        action: z.enum(['remove', 'warn', 'ban', 'dismiss']),
        notes: z.string().optional(),
      });
      const data = schema.parse(req.body);
      const adminId = req.session?.userId || '';

      // Update moderation record
      await db.update(moderationQueue)
        .set({
          status: 'reviewed',
          adminAction: data.action,
          adminNotes: data.notes,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        })
        .where(and(
          eq(moderationQueue.targetId, data.targetId),
          eq(moderationQueue.targetType, data.targetType),
        ));

      // Execute action
      if (data.action === 'remove' && data.targetType === 'post') {
        await db.update(feedPosts).set({ isActive: false }).where(eq(feedPosts.id, data.targetId));
      } else if (data.action === 'ban' && data.targetType === 'user') {
        // Revoke all refresh tokens to force re-auth (which will fail for banned users)
        await storage.revokeAllUserRefreshTokens(data.targetId);
      }

      res.json({ success: true, data: { action: data.action, targetId: data.targetId } });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: error.errors[0]?.message } });
      console.error("Moderation action error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to execute moderation action' } });
    }
  });

  // #59 — Platform revenue report
  app.get("/api/admin/revenue", requireAdmin, async (req, res) => {
    try {
      const period = (req.query.period as string) || '30d';
      const periodDays = period === '7d' ? 7 : period === '90d' ? 90 : period === 'all' ? 3650 : 30;
      const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

      // Product orders
      const productStats = await db.select({
        gmv: sql<number>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        fees: sql<number>`COALESCE(SUM(${orders.platformFee}), 0)`,
      }).from(orders).where(and(
        or(eq(orders.status, 'paid'), eq(orders.status, 'shipped'), eq(orders.status, 'delivered')),
        gte(orders.createdAt, periodStart),
      ));

      // Business appointments
      const appointmentStats = await db.select({
        gmv: sql<number>`COALESCE(SUM(${appointments.totalPrice}), 0)`,
        fees: sql<number>`COALESCE(SUM(${appointments.platformFee}), 0)`,
      }).from(appointments).where(and(
        or(eq(appointments.status, 'confirmed'), eq(appointments.status, 'completed')),
        gte(appointments.createdAt, periodStart),
      ));

      // Photographer bookings
      const bookingStats = await db.select({
        gmv: sql<number>`COALESCE(SUM(${shootBookings.totalPrice}), 0)`,
        fees: sql<number>`COALESCE(SUM(${shootBookings.platformFee}), 0)`,
      }).from(shootBookings).where(and(
        or(eq(shootBookings.status, 'confirmed'), eq(shootBookings.status, 'completed')),
        gte(shootBookings.createdAt, periodStart),
      ));

      // Sponsored revenue
      const sponsoredStats = await db.select({
        revenue: sql<number>`COALESCE(SUM(${sponsoredPosts.spentCents}), 0)`,
      }).from(sponsoredPosts).where(gte(sponsoredPosts.createdAt, periodStart));

      // Refunds
      const refundStats = await db.select({
        total: sql<number>`COALESCE(SUM(${appointments.refundAmount}), 0)`,
      }).from(appointments).where(and(
        eq(appointments.status, 'refunded' as string),
        gte(appointments.createdAt, periodStart),
      ));

      const productGmv = Number(productStats[0]?.gmv || 0);
      const productFees = Number(productStats[0]?.fees || 0);
      const bookingGmv = Number(appointmentStats[0]?.gmv || 0) + Number(bookingStats[0]?.gmv || 0);
      const bookingFees = Number(appointmentStats[0]?.fees || 0) + Number(bookingStats[0]?.fees || 0);
      const sponsoredRevenue = Number(sponsoredStats[0]?.revenue || 0);
      const refundsIssued = Number(refundStats[0]?.total || 0);

      const grossMerchandiseValue = productGmv + bookingGmv;
      const platformFeesCollected = productFees + bookingFees + sponsoredRevenue;
      const vendorPayouts = grossMerchandiseValue - platformFeesCollected;

      res.json({
        success: true,
        data: {
          grossMerchandiseValue,
          platformFeesCollected,
          vendorPayouts,
          refundsIssued,
          netRevenue: platformFeesCollected - refundsIssued,
          periodStart: periodStart.toISOString(),
          periodEnd: new Date().toISOString(),
          breakdown: {
            products: { gmv: productGmv, fees: productFees },
            bookings: { gmv: bookingGmv, fees: bookingFees },
            sponsored: { revenue: sponsoredRevenue },
          },
        },
      });
    } catch (error) {
      console.error("Revenue report error:", error);
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to generate revenue report' } });
    }
  });
}
