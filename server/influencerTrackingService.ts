import { db } from "./db";
import { storage } from "./storage";
import {
  influencerTrackingEvents,
  influencerAttributions,
  influencerTiers,
  influencerStats,
  influencerPointConfig,
  influencerProfiles,
  type InfluencerTrackingEvent,
  type InfluencerAttribution,
  type InfluencerTier,
  type InfluencerStats,
} from "@shared/schema";
import { eq, and, sql, desc, asc, gte, lte, ilike, or } from "drizzle-orm";

const ATTRIBUTION_WINDOW_DAYS = 30;
const ROLLING_WINDOW_POSTS = 5; // re-evaluate every 3-5 posts
const ROLLING_WINDOW_DAYS = 90; // or every 90 days

// Default point values (used if influencer_point_config table is empty)
const DEFAULT_POINTS: Record<string, number> = {
  app_download: 10,
  signup: 25,
  first_purchase: 50,
  repeat_purchase: 25,
};

// =====================================================
//  REFERRAL LINK GENERATION
// =====================================================

export function generateReferralLink(
  username: string,
  baseUrl: string = "https://outsyde.com",
  params?: { utm_source?: string; utm_medium?: string; utm_campaign?: string; productId?: string; serviceId?: string }
): string {
  const url = new URL(`/ref/${username}`, baseUrl);
  if (params?.utm_source) url.searchParams.set("utm_source", params.utm_source);
  if (params?.utm_medium) url.searchParams.set("utm_medium", params.utm_medium);
  if (params?.utm_campaign) url.searchParams.set("utm_campaign", params.utm_campaign);
  if (params?.productId) url.searchParams.set("product", params.productId);
  if (params?.serviceId) url.searchParams.set("service", params.serviceId);
  return url.toString();
}

export function generateDeepLink(
  refCode: string,
  target?: { productId?: string; serviceId?: string; businessId?: string },
  utmParams?: { utm_source?: string; utm_medium?: string; utm_campaign?: string }
): string {
  const base = `outsyde://app`;
  const params = new URLSearchParams({ ref: refCode });
  if (target?.productId) params.set("product", target.productId);
  if (target?.serviceId) params.set("service", target.serviceId);
  if (target?.businessId) params.set("business", target.businessId);
  if (utmParams?.utm_source) params.set("utm_source", utmParams.utm_source);
  if (utmParams?.utm_medium) params.set("utm_medium", utmParams.utm_medium);
  if (utmParams?.utm_campaign) params.set("utm_campaign", utmParams.utm_campaign);
  return `${base}?${params.toString()}`;
}

// =====================================================
//  POINT CONFIG — Load from DB or use defaults
// =====================================================

async function getPointsForEvent(eventType: string): Promise<number> {
  const [config] = await db.select()
    .from(influencerPointConfig)
    .where(and(eq(influencerPointConfig.eventType, eventType), eq(influencerPointConfig.isActive, true)));
  return config?.pointsAwarded ?? DEFAULT_POINTS[eventType] ?? 0;
}

// =====================================================
//  ATTRIBUTION — First-click, 30-day window
// =====================================================

export async function recordAttribution(
  userId: string,
  refCode: string,
  utmParams?: { utm_source?: string; utm_medium?: string; utm_campaign?: string }
): Promise<InfluencerAttribution | null> {
  const profile = await storage.getInfluencerProfileByPromoCode(refCode);
  if (!profile) return null;

  // First-click attribution: only create if no existing attribution for this user
  const [existing] = await db.select()
    .from(influencerAttributions)
    .where(eq(influencerAttributions.userId, userId));
  if (existing) return existing;

  const expiresAt = new Date(Date.now() + ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [attribution] = await db.insert(influencerAttributions)
    .values({
      userId,
      influencerId: profile.id,
      refCode,
      utmSource: utmParams?.utm_source,
      utmMedium: utmParams?.utm_medium,
      utmCampaign: utmParams?.utm_campaign,
      firstClickAt: new Date(),
      expiresAt,
    })
    .returning();

  return attribution;
}

export async function getActiveAttribution(userId: string): Promise<InfluencerAttribution | null> {
  const [attribution] = await db.select()
    .from(influencerAttributions)
    .where(and(
      eq(influencerAttributions.userId, userId),
      gte(influencerAttributions.expiresAt, new Date())
    ));
  return attribution ?? null;
}

// =====================================================
//  EVENT TRACKING
// =====================================================

export async function trackEvent(params: {
  influencerId: string;
  eventType: 'link_click' | 'app_download' | 'signup' | 'first_purchase' | 'repeat_purchase';
  attributedUserId?: string;
  orderId?: string;
  orderTotalCents?: number;
  campaignId?: string;
  refCode?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  deviceType?: string;
  platform?: string;
  userAgent?: string;
  ipAddress?: string;
}): Promise<InfluencerTrackingEvent> {
  const pointsAwarded = params.eventType === 'link_click' ? 0 : await getPointsForEvent(params.eventType);

  const [event] = await db.insert(influencerTrackingEvents)
    .values({
      influencerId: params.influencerId,
      eventType: params.eventType,
      attributedUserId: params.attributedUserId,
      orderId: params.orderId,
      orderTotalCents: params.orderTotalCents,
      campaignId: params.campaignId,
      refCode: params.refCode,
      utmSource: params.utmSource,
      utmMedium: params.utmMedium,
      utmCampaign: params.utmCampaign,
      deviceType: params.deviceType,
      platform: params.platform,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
      pointsAwarded,
    })
    .returning();

  console.log(`[InfluencerTracking] ${params.eventType} recorded for influencer ${params.influencerId}, points: ${pointsAwarded}`);

  // Update aggregate stats
  await updateInfluencerStats(params.influencerId);

  return event;
}

/**
 * Track a link click event. Called from the /ref/:refCode redirect endpoint.
 */
export async function trackLinkClick(
  refCode: string,
  meta: { userAgent?: string; ipAddress?: string; utmSource?: string; utmMedium?: string; utmCampaign?: string }
): Promise<void> {
  const profile = await storage.getInfluencerProfileByPromoCode(refCode);
  if (!profile) return;

  const deviceType = detectDeviceType(meta.userAgent);
  const platform = detectPlatform(meta.userAgent);

  await trackEvent({
    influencerId: profile.id,
    eventType: 'link_click',
    refCode,
    utmSource: meta.utmSource,
    utmMedium: meta.utmMedium,
    utmCampaign: meta.utmCampaign,
    deviceType,
    platform,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  });
}

/**
 * Track an attributed signup. Called after user registration when attribution exists.
 */
export async function trackAttributedSignup(userId: string): Promise<void> {
  const attribution = await getActiveAttribution(userId);
  if (!attribution) return;

  await trackEvent({
    influencerId: attribution.influencerId,
    eventType: 'signup',
    attributedUserId: userId,
    refCode: attribution.refCode,
    utmSource: attribution.utmSource ?? undefined,
    utmMedium: attribution.utmMedium ?? undefined,
    utmCampaign: attribution.utmCampaign ?? undefined,
  });
}

/**
 * Track an attributed purchase. Called after a successful order/booking payment.
 */
export async function trackAttributedPurchase(
  userId: string,
  orderId: string,
  orderTotalCents: number
): Promise<void> {
  const attribution = await getActiveAttribution(userId);
  if (!attribution) return;

  // Determine if this is the user's first purchase attributed to this influencer
  const existingPurchases = await db.select({ count: sql<number>`count(*)` })
    .from(influencerTrackingEvents)
    .where(and(
      eq(influencerTrackingEvents.influencerId, attribution.influencerId),
      eq(influencerTrackingEvents.attributedUserId, userId),
      or(
        eq(influencerTrackingEvents.eventType, 'first_purchase'),
        eq(influencerTrackingEvents.eventType, 'repeat_purchase')
      )
    ));
  const purchaseCount = Number(existingPurchases[0]?.count || 0);
  const eventType = purchaseCount === 0 ? 'first_purchase' : 'repeat_purchase';

  await trackEvent({
    influencerId: attribution.influencerId,
    eventType,
    attributedUserId: userId,
    orderId,
    orderTotalCents,
    refCode: attribution.refCode,
    utmSource: attribution.utmSource ?? undefined,
    utmMedium: attribution.utmMedium ?? undefined,
    utmCampaign: attribution.utmCampaign ?? undefined,
  });

  // Calculate and record commission
  await recordCommission(attribution.influencerId, orderId, orderTotalCents);
}

// =====================================================
//  COMMISSION CALCULATION
// =====================================================

async function recordCommission(
  influencerId: string,
  orderId: string,
  orderTotalCents: number
): Promise<void> {
  const stats = await getOrCreateStats(influencerId);
  if (!stats.tierId) return; // no tier assigned yet

  const [tier] = await db.select()
    .from(influencerTiers)
    .where(eq(influencerTiers.id, stats.tierId));
  if (!tier) return;

  const commissionCents = Math.round(orderTotalCents * tier.commissionBps / 10000);

  // Create earning ledger entry
  await storage.createInfluencerEarningLedger({
    influencerId,
    sourceType: 'commission',
    sourceRefId: orderId,
    amountCents: commissionCents,
    description: `Commission on order (${tier.displayName} tier, ${tier.commissionBps / 100}%)`,
    status: 'pending',
  });

  // Update stats
  await db.update(influencerStats)
    .set({
      totalCommissionEarnedCents: sql`${influencerStats.totalCommissionEarnedCents} + ${commissionCents}`,
      pendingCommissionCents: sql`${influencerStats.pendingCommissionCents} + ${commissionCents}`,
      updatedAt: new Date(),
    })
    .where(eq(influencerStats.influencerId, influencerId));

  // Update profile earnings
  await storage.updateInfluencerProfile(influencerId, {
    totalEarnings: sql`${influencerProfiles.totalEarnings} + ${commissionCents}` as any,
    pendingEarnings: sql`${influencerProfiles.pendingEarnings} + ${commissionCents}` as any,
  });

  console.log(`[InfluencerTracking] Commission ${commissionCents}¢ recorded for influencer ${influencerId} on order ${orderId}`);
}

// =====================================================
//  STATS + CONVERSION RATE + TIER ASSIGNMENT
// =====================================================

function safeDate(value: any): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

async function getOrCreateStats(influencerId: string): Promise<InfluencerStats> {
  const [existing] = await db.select()
    .from(influencerStats)
    .where(eq(influencerStats.influencerId, influencerId));

  if (existing) return existing;

  // Assign default tier (bronze)
  const [bronzeTier] = await db.select()
    .from(influencerTiers)
    .where(eq(influencerTiers.name, 'bronze'));

  const [stats] = await db.insert(influencerStats)
    .values({
      influencerId,
      tierId: bronzeTier?.id,
    })
    .returning();

  return stats;
}

export async function getInfluencerStatsById(influencerId: string): Promise<InfluencerStats | null> {
  const [stats] = await db.select()
    .from(influencerStats)
    .where(eq(influencerStats.influencerId, influencerId));
  return stats ?? null;
}

async function updateInfluencerStats(influencerId: string): Promise<void> {
  const stats = await getOrCreateStats(influencerId);

  // Count events by type
  const eventCounts = await db.select({
    eventType: influencerTrackingEvents.eventType,
    count: sql<number>`count(*)`,
    totalRevenue: sql<number>`COALESCE(sum(${influencerTrackingEvents.orderTotalCents}), 0)`,
    totalPoints: sql<number>`COALESCE(sum(${influencerTrackingEvents.pointsAwarded}), 0)`,
  })
    .from(influencerTrackingEvents)
    .where(eq(influencerTrackingEvents.influencerId, influencerId))
    .groupBy(influencerTrackingEvents.eventType);

  let totalClicks = 0, totalDownloads = 0, totalSignups = 0;
  let totalFirstPurchases = 0, totalRepeatPurchases = 0;
  let totalRevenueCents = 0, totalPoints = 0;

  for (const row of eventCounts) {
    const count = Number(row.count);
    const revenue = Number(row.totalRevenue);
    const points = Number(row.totalPoints);
    totalPoints += points;

    switch (row.eventType) {
      case 'link_click': totalClicks = count; break;
      case 'app_download': totalDownloads = count; break;
      case 'signup': totalSignups = count; break;
      case 'first_purchase': totalFirstPurchases = count; totalRevenueCents += revenue; break;
      case 'repeat_purchase': totalRepeatPurchases = count; totalRevenueCents += revenue; break;
    }
  }

  const totalPurchases = totalFirstPurchases + totalRepeatPurchases;
  const conversionRate = totalClicks > 0 ? (totalPurchases / totalClicks) * 100 : 0;

  // Rolling average calculation
  let rollingAvgConversionRate = stats.rollingAvgConversionRate;
  let rollingWindowPostCount = stats.rollingWindowPostCount + 1;
  const windowStart = safeDate(stats.rollingWindowStartDate);

  const windowAgeMs = windowStart ? Date.now() - windowStart.getTime() : 0;
  const shouldRecalcRolling =
    rollingWindowPostCount >= ROLLING_WINDOW_POSTS ||
    (windowStart && windowAgeMs > ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  if (shouldRecalcRolling) {
    rollingAvgConversionRate = conversionRate;
    rollingWindowPostCount = 0;
  }

  // Determine tier based on rolling average
  const newTier = await determineTier(rollingAvgConversionRate || conversionRate);
  const tierChanged = newTier?.id !== stats.tierId;

  const now = new Date();
  await db.update(influencerStats)
    .set({
      totalClicks,
      totalDownloads,
      totalSignups,
      totalFirstPurchases,
      totalRepeatPurchases,
      totalPurchases,
      totalRevenueCents,
      totalPoints,
      conversionRate,
      rollingAvgConversionRate,
      rollingWindowPostCount,
      rollingWindowStartDate: shouldRecalcRolling ? now : (windowStart || now),
      tierId: newTier?.id || stats.tierId,
      tierChangedAt: tierChanged ? now : (safeDate(stats.tierChangedAt) || undefined),
      previousTierId: tierChanged ? stats.tierId : stats.previousTierId,
      tierChangeFlag: tierChanged ? true : stats.tierChangeFlag,
      updatedAt: now,
    })
    .where(eq(influencerStats.influencerId, influencerId));

  if (tierChanged && newTier) {
    console.log(`[InfluencerTracking] Influencer ${influencerId} tier changed to ${newTier.name} (conversion: ${conversionRate.toFixed(2)}%)`);
  }
}

async function determineTier(conversionRate: number): Promise<InfluencerTier | null> {
  const tiers = await db.select()
    .from(influencerTiers)
    .where(eq(influencerTiers.isActive, true))
    .orderBy(desc(influencerTiers.minConversionRate));

  for (const tier of tiers) {
    if (conversionRate >= tier.minConversionRate) {
      if (tier.maxConversionRate === null || conversionRate < tier.maxConversionRate) {
        return tier;
      }
    }
  }

  // Fallback to lowest tier
  return tiers[tiers.length - 1] ?? null;
}

// =====================================================
//  ADMIN QUERIES
// =====================================================

export async function getInfluencerLeaderboard(filters?: {
  tierId?: string;
  startDate?: Date;
  endDate?: Date;
  utmSource?: string;
  tierChangeOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ influencers: any[]; total: number }> {
  const conditions: any[] = [];

  if (filters?.tierId) {
    conditions.push(eq(influencerStats.tierId, filters.tierId));
  }
  if (filters?.tierChangeOnly) {
    conditions.push(eq(influencerStats.tierChangeFlag, true));
  }

  const countResult = await db.select({ count: sql<number>`count(*)` })
    .from(influencerStats)
    .innerJoin(influencerProfiles, eq(influencerStats.influencerId, influencerProfiles.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const total = Number(countResult[0]?.count || 0);

  const rows = await db.select({
    stats: influencerStats,
    profile: influencerProfiles,
  })
    .from(influencerStats)
    .innerJoin(influencerProfiles, eq(influencerStats.influencerId, influencerProfiles.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(influencerStats.totalRevenueCents))
    .limit(filters?.limit ?? 50)
    .offset(filters?.offset ?? 0);

  // Load tier info
  const allTiers = await db.select().from(influencerTiers);
  const tierMap = new Map(allTiers.map(t => [t.id, t]));

  const influencers = rows.map(({ stats, profile }) => ({
    influencerId: profile.id,
    userId: profile.userId,
    displayName: profile.displayName,
    promoCode: profile.promoCode,
    tier: stats.tierId ? tierMap.get(stats.tierId) : null,
    totalClicks: stats.totalClicks,
    totalDownloads: stats.totalDownloads,
    totalSignups: stats.totalSignups,
    totalPurchases: stats.totalPurchases,
    totalRevenueCents: stats.totalRevenueCents,
    totalPoints: stats.totalPoints,
    conversionRate: stats.conversionRate,
    rollingAvgConversionRate: stats.rollingAvgConversionRate,
    totalCommissionEarnedCents: stats.totalCommissionEarnedCents,
    pendingCommissionCents: stats.pendingCommissionCents,
    tierChangeFlag: stats.tierChangeFlag,
    tierChangedAt: stats.tierChangedAt,
  }));

  return { influencers, total };
}

export async function clearTierChangeFlag(influencerId: string): Promise<void> {
  await db.update(influencerStats)
    .set({ tierChangeFlag: false, updatedAt: new Date() })
    .where(eq(influencerStats.influencerId, influencerId));
}

// =====================================================
//  INFLUENCER DASHBOARD DATA
// =====================================================

export async function getInfluencerDashboardData(influencerId: string): Promise<{
  referralLink: string;
  stats: InfluencerStats | null;
  tier: InfluencerTier | null;
  nextTier: InfluencerTier | null;
  conversionNeededForNextTier: number;
}> {
  const profile = await storage.getInfluencerProfile(influencerId);
  const refCode = profile?.promoCode || influencerId;
  const referralLink = generateReferralLink(refCode);

  const stats = await getInfluencerStatsById(influencerId);
  let tier: InfluencerTier | null = null;
  let nextTier: InfluencerTier | null = null;
  let conversionNeededForNextTier = 0;

  if (stats?.tierId) {
    const [currentTier] = await db.select()
      .from(influencerTiers)
      .where(eq(influencerTiers.id, stats.tierId));
    tier = currentTier ?? null;

    if (tier) {
      const tiers = await db.select()
        .from(influencerTiers)
        .where(eq(influencerTiers.isActive, true))
        .orderBy(asc(influencerTiers.sortOrder));

      const currentIdx = tiers.findIndex(t => t.id === tier!.id);
      if (currentIdx >= 0 && currentIdx < tiers.length - 1) {
        nextTier = tiers[currentIdx + 1];
        conversionNeededForNextTier = nextTier.minConversionRate - (stats.rollingAvgConversionRate || 0);
      }
    }
  }

  return { referralLink, stats, tier, nextTier, conversionNeededForNextTier };
}

// =====================================================
//  SEED DEFAULT TIERS + POINT CONFIG
// =====================================================

export async function seedInfluencerTiersAndConfig(): Promise<void> {
  const existingTiers = await db.select().from(influencerTiers);
  if (existingTiers.length > 0) return;

  console.log("[InfluencerTracking] Seeding default tiers and point config...");

  await db.insert(influencerTiers).values([
    { name: 'bronze', displayName: 'Bronze', minConversionRate: 0, maxConversionRate: 1, commissionBps: 200, pointMultiplier: 1.0, sortOrder: 0 },
    { name: 'silver', displayName: 'Silver', minConversionRate: 1, maxConversionRate: 3, commissionBps: 350, pointMultiplier: 1.25, sortOrder: 1 },
    { name: 'gold', displayName: 'Gold', minConversionRate: 3, maxConversionRate: 6, commissionBps: 500, pointMultiplier: 1.5, sortOrder: 2 },
    { name: 'elite', displayName: 'Elite', minConversionRate: 6, maxConversionRate: null, commissionBps: 750, pointMultiplier: 2.0, sortOrder: 3 },
  ]);

  const existingConfig = await db.select().from(influencerPointConfig);
  if (existingConfig.length === 0) {
    await db.insert(influencerPointConfig).values([
      { eventType: 'app_download', pointsAwarded: 10, description: 'App download attributed to influencer' },
      { eventType: 'signup', pointsAwarded: 25, description: 'New user signup attributed to influencer' },
      { eventType: 'first_purchase', pointsAwarded: 50, description: 'First purchase by attributed user' },
      { eventType: 'repeat_purchase', pointsAwarded: 25, description: 'Repeat purchase by attributed user' },
    ]);
  }

  console.log("[InfluencerTracking] Default tiers and point config seeded.");
}

// =====================================================
//  HELPERS
// =====================================================

function detectDeviceType(userAgent?: string): string {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (/tablet|ipad/.test(ua)) return 'tablet';
  if (/mobile|iphone|android/.test(ua)) return 'mobile';
  return 'desktop';
}

function detectPlatform(userAgent?: string): string {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  return 'web';
}
