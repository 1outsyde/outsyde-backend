import { db } from "./db";
import {
  pulseEngagements,
  postDistribution,
  userInterests,
  feedPosts,
  users,
  userBlocks,
  type PulseEngagement,
  type PostDistribution,
  type UserInterests,
  type FeedPost
} from "@shared/schema";
import { eq, and, desc, sql, gte, lte, isNull, or, ne, inArray } from "drizzle-orm";

// =====================================================
// PULSE FEED CONFIGURATION (TikTok 2020-style)
// =====================================================

export const PULSE_CONFIG = {
  // Tier thresholds (impressions required to advance)
  TIER_1_THRESHOLD: 1000,
  TIER_2_THRESHOLD: 10000,
  TIER_3_THRESHOLD: 50000,
  TIER_4_UNLIMITED: true,

  // Cold start configuration
  COLD_START_MIN_IMPRESSIONS: 300,
  COLD_START_MAX_IMPRESSIONS: 1000,
  COLD_START_DURATION_MINUTES: 60, // 30-90 min, we use 60

  // Ranking weights (TikTok 2020 style - attention/retention focused)
  WEIGHTS: {
    AVG_WATCH_TIME: 0.30,      // Highest weight - time is most valuable
    COMPLETION_RATE: 0.25,     // Second - did they finish?
    REWATCH_RATE: 0.20,        // Third - did they come back?
    SHARE_RATE: 0.12,          // Fourth - viral potential
    SAVE_RATE: 0.08,           // Fifth - bookmark intent
    COMMENT_RATE: 0.04,        // Sixth - engagement (quality matters)
    LIKE_RATE: 0.01,           // Lowest - cosmetic only
  },

  // Tier advancement thresholds (minimum scores to advance)
  TIER_ADVANCEMENT: {
    TIER_1_TO_2: 0.15,  // Must score above 15% to advance
    TIER_2_TO_3: 0.25,  // Must score above 25% to advance
    TIER_3_TO_4: 0.35,  // Must score above 35% to go viral
  },

  // Interest decay factor (recent behavior matters more)
  INTEREST_DECAY_DAYS: 7,      // Half-life for interest weights
  MAX_RECENT_ENGAGEMENTS: 100, // Keep last 100 interactions

  // Feed batch size
  DEFAULT_FEED_SIZE: 10,
  MAX_FEED_SIZE: 50,
};

// =====================================================
// ENGAGEMENT TRACKING
// =====================================================

export interface EngagementData {
  userId: string;
  postId: string;
  watchTimeMs: number;
  videoDurationMs: number;  // To calculate completion rate
  isRewatch?: boolean;
  shared?: boolean;
  saved?: boolean;
}

export async function recordEngagement(data: EngagementData): Promise<PulseEngagement> {
  const completionRate = data.videoDurationMs > 0 
    ? Math.min(1.0, data.watchTimeMs / data.videoDurationMs)
    : 0;

  // Check for existing engagement
  const existing = await db
    .select()
    .from(pulseEngagements)
    .where(and(
      eq(pulseEngagements.userId, data.userId),
      eq(pulseEngagements.postId, data.postId)
    ))
    .limit(1);

  if (existing.length > 0) {
    // Update existing engagement
    const current = existing[0];
    const newWatchTime = current.watchTimeMs + data.watchTimeMs;
    const newCompletionRate = Math.max(current.completionRate || 0, completionRate);
    const newRewatchCount = data.isRewatch ? current.rewatchCount + 1 : current.rewatchCount;

    const [updated] = await db
      .update(pulseEngagements)
      .set({
        watchTimeMs: newWatchTime,
        completionRate: newCompletionRate,
        rewatchCount: newRewatchCount,
        shared: data.shared ?? current.shared,
        saved: data.saved ?? current.saved,
        lastInteractionAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pulseEngagements.id, current.id))
      .returning();

    // Update post distribution metrics
    await updatePostDistributionMetrics(data.postId);
    
    // Update user interests
    await updateUserInterests(data.userId, data.postId, {
      watchTimeMs: data.watchTimeMs,
      completionRate,
      isRewatch: data.isRewatch,
      shared: data.shared,
      saved: data.saved,
    });

    return updated;
  } else {
    // Create new engagement (first impression)
    const [created] = await db
      .insert(pulseEngagements)
      .values({
        userId: data.userId,
        postId: data.postId,
        watchTimeMs: data.watchTimeMs,
        completionRate,
        rewatchCount: 0,
        shared: data.shared ?? false,
        saved: data.saved ?? false,
        impressionAt: new Date(),
        lastInteractionAt: new Date(),
      })
      .returning();

    // Update post distribution (new impression)
    await recordImpression(data.postId);
    
    // Update post distribution metrics
    await updatePostDistributionMetrics(data.postId);
    
    // Update user interests
    await updateUserInterests(data.userId, data.postId, {
      watchTimeMs: data.watchTimeMs,
      completionRate,
      isRewatch: false,
      shared: data.shared,
      saved: data.saved,
    });

    return created;
  }
}

// =====================================================
// POST DISTRIBUTION & TIER SYSTEM
// =====================================================

export async function initializePostDistribution(postId: string): Promise<PostDistribution> {
  // Check if already exists
  const existing = await db
    .select()
    .from(postDistribution)
    .where(eq(postDistribution.postId, postId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  // Create new distribution record with cold start
  const coldStartEndsAt = new Date();
  coldStartEndsAt.setMinutes(coldStartEndsAt.getMinutes() + PULSE_CONFIG.COLD_START_DURATION_MINUTES);

  const [created] = await db
    .insert(postDistribution)
    .values({
      postId,
      currentTier: 1,
      impressionsTier1: 0,
      impressionsTier2: 0,
      impressionsTier3: 0,
      impressionsTier4: 0,
      coldStartEndsAt,
      isActive: true,
    })
    .returning();

  return created;
}

async function recordImpression(postId: string): Promise<void> {
  const dist = await initializePostDistribution(postId);
  
  // Increment appropriate tier counter
  const tierField = `impressions_tier${dist.currentTier}` as const;
  
  await db
    .update(postDistribution)
    .set({
      [`impressionsTier${dist.currentTier}`]: sql`${postDistribution[`impressionsTier${dist.currentTier}` as keyof typeof postDistribution]} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(postDistribution.postId, postId));
}

async function updatePostDistributionMetrics(postId: string): Promise<void> {
  // Calculate aggregate metrics from all engagements
  const metrics = await db
    .select({
      avgWatchTime: sql<number>`AVG(${pulseEngagements.watchTimeMs})`.as('avg_watch_time'),
      avgCompletion: sql<number>`AVG(${pulseEngagements.completionRate})`.as('avg_completion'),
      totalRewatches: sql<number>`SUM(${pulseEngagements.rewatchCount})`.as('total_rewatches'),
      totalShares: sql<number>`SUM(CASE WHEN ${pulseEngagements.shared} THEN 1 ELSE 0 END)`.as('total_shares'),
      totalSaves: sql<number>`SUM(CASE WHEN ${pulseEngagements.saved} THEN 1 ELSE 0 END)`.as('total_saves'),
    })
    .from(pulseEngagements)
    .where(eq(pulseEngagements.postId, postId));

  if (metrics.length > 0) {
    const m = metrics[0];
    await db
      .update(postDistribution)
      .set({
        avgWatchTimeMs: Math.round(m.avgWatchTime || 0),
        avgCompletionRate: m.avgCompletion || 0,
        totalRewatches: m.totalRewatches || 0,
        totalShares: m.totalShares || 0,
        totalSaves: m.totalSaves || 0,
        updatedAt: new Date(),
      })
      .where(eq(postDistribution.postId, postId));
  }

  // Check for tier advancement
  await checkTierAdvancement(postId);
}

async function checkTierAdvancement(postId: string): Promise<void> {
  const [dist] = await db
    .select()
    .from(postDistribution)
    .where(eq(postDistribution.postId, postId))
    .limit(1);

  if (!dist || !dist.isActive) return;

  // Calculate current tier's impression count
  const currentImpressions = dist[`impressionsTier${dist.currentTier}` as keyof PostDistribution] as number || 0;
  
  // Get tier threshold
  const tierThresholds = [
    PULSE_CONFIG.TIER_1_THRESHOLD,
    PULSE_CONFIG.TIER_2_THRESHOLD,
    PULSE_CONFIG.TIER_3_THRESHOLD,
  ];

  if (dist.currentTier > 3) return; // Already at max tier

  const threshold = tierThresholds[dist.currentTier - 1];
  
  if (currentImpressions >= threshold) {
    // Calculate score to determine if post advances
    const score = calculatePostScore(dist);
    const advancementThreshold = getAdvancementThreshold(dist.currentTier);

    if (score >= advancementThreshold) {
      // Advance to next tier
      await db
        .update(postDistribution)
        .set({
          currentTier: dist.currentTier + 1,
          tierAdvancedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(postDistribution.postId, postId));
    } else {
      // Post failed to advance - stop distribution
      await db
        .update(postDistribution)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(eq(postDistribution.postId, postId));
    }
  }
}

function getAdvancementThreshold(currentTier: number): number {
  switch (currentTier) {
    case 1: return PULSE_CONFIG.TIER_ADVANCEMENT.TIER_1_TO_2;
    case 2: return PULSE_CONFIG.TIER_ADVANCEMENT.TIER_2_TO_3;
    case 3: return PULSE_CONFIG.TIER_ADVANCEMENT.TIER_3_TO_4;
    default: return 1.0; // Max tier, no advancement needed
  }
}

// =====================================================
// RANKING ALGORITHM
// =====================================================

function calculatePostScore(dist: PostDistribution): number {
  // Normalize metrics to 0-1 scale
  const totalImpressions = 
    dist.impressionsTier1 + dist.impressionsTier2 + dist.impressionsTier3 + dist.impressionsTier4;

  if (totalImpressions === 0) return 0;

  // Watch time score (normalize to ~30 second average as baseline)
  const avgWatchTimeScore = Math.min(1.0, (dist.avgWatchTimeMs || 0) / 30000);

  // Completion rate is already 0-1
  const completionScore = dist.avgCompletionRate || 0;

  // Rewatch rate (rewatches per impression)
  const rewatchScore = Math.min(1.0, (dist.totalRewatches || 0) / totalImpressions);

  // Share rate
  const shareScore = Math.min(1.0, ((dist.totalShares || 0) / totalImpressions) * 10); // Scale up since shares are rare

  // Save rate
  const saveScore = Math.min(1.0, ((dist.totalSaves || 0) / totalImpressions) * 5); // Scale up since saves are rare

  // Calculate weighted score
  const score = 
    avgWatchTimeScore * PULSE_CONFIG.WEIGHTS.AVG_WATCH_TIME +
    completionScore * PULSE_CONFIG.WEIGHTS.COMPLETION_RATE +
    rewatchScore * PULSE_CONFIG.WEIGHTS.REWATCH_RATE +
    shareScore * PULSE_CONFIG.WEIGHTS.SHARE_RATE +
    saveScore * PULSE_CONFIG.WEIGHTS.SAVE_RATE;

  return score;
}

// =====================================================
// USER INTEREST GRAPH
// =====================================================

interface InterestUpdate {
  watchTimeMs: number;
  completionRate: number;
  isRewatch?: boolean;
  shared?: boolean;
  saved?: boolean;
}

async function updateUserInterests(
  userId: string, 
  postId: string, 
  engagement: InterestUpdate
): Promise<void> {
  // Get or create user interests
  let userInterest = await db
    .select()
    .from(userInterests)
    .where(eq(userInterests.userId, userId))
    .limit(1);

  if (userInterest.length === 0) {
    await db.insert(userInterests).values({
      userId,
      interestVector: {},
      recentEngagements: [],
      totalWatched: 0,
      totalSkipped: 0,
      totalShared: 0,
      totalSaved: 0,
    });
    userInterest = await db
      .select()
      .from(userInterests)
      .where(eq(userInterests.userId, userId))
      .limit(1);
  }

  const current = userInterest[0];

  // Get post category/tags for interest mapping
  const [post] = await db
    .select()
    .from(feedPosts)
    .where(eq(feedPosts.id, postId))
    .limit(1);

  if (!post) return;

  // Determine engagement quality
  const isPositive = engagement.completionRate > 0.5 || engagement.isRewatch || engagement.shared || engagement.saved;
  const isSkip = engagement.watchTimeMs < 2000 && engagement.completionRate < 0.1; // Less than 2 seconds = skip

  // Update counters
  const updates: Partial<UserInterests> = {
    totalWatched: current.totalWatched + 1,
    totalSkipped: isSkip ? current.totalSkipped + 1 : current.totalSkipped,
    totalShared: engagement.shared ? current.totalShared + 1 : current.totalShared,
    totalSaved: engagement.saved ? current.totalSaved + 1 : current.totalSaved,
    lastUpdated: new Date(),
  };

  // Update interest vector based on engagement
  const interestVector = (current.interestVector as Record<string, number>) || {};
  
  // Use author type as a simple category for now
  const category = post.authorType || 'general';
  const currentWeight = interestVector[category] || 0.5;
  
  // Adjust weight based on engagement
  let weightDelta = 0;
  if (isPositive) {
    weightDelta = 0.05 * engagement.completionRate; // More completion = more interest
    if (engagement.isRewatch) weightDelta += 0.1;
    if (engagement.shared) weightDelta += 0.15;
    if (engagement.saved) weightDelta += 0.1;
  } else if (isSkip) {
    weightDelta = -0.03; // Small penalty for skips
  }

  interestVector[category] = Math.max(0, Math.min(1, currentWeight + weightDelta));
  updates.interestVector = interestVector;

  // Update recent engagements (for time decay)
  const recentEngagements = (current.recentEngagements as any[]) || [];
  recentEngagements.unshift({
    postId,
    category,
    action: isPositive ? 'positive' : (isSkip ? 'skip' : 'neutral'),
    weight: weightDelta,
    timestamp: new Date().toISOString(),
  });

  // Keep only recent engagements
  updates.recentEngagements = recentEngagements.slice(0, PULSE_CONFIG.MAX_RECENT_ENGAGEMENTS);

  await db
    .update(userInterests)
    .set(updates)
    .where(eq(userInterests.userId, userId));
}

// =====================================================
// PULSE FEED GENERATION
// =====================================================

export interface PulseFeedOptions {
  userId?: string;
  limit?: number;
  offset?: number;
  excludePostIds?: string[];
  city?: string;
  lat?: number;
  lng?: number;
}

export interface PulseFeedPost extends FeedPost {
  pulseScore: number;
  // Top-level fields for mobile frontend compatibility
  videoUrl: string | null;
  thumbnailUrl: string | null;
  author: {
    userId: string;
    username: string | null;
    displayName: string;
    profilePhotoUrl: string | null;
    role: 'consumer' | 'vendor' | 'photographer';
  };
  media: {
    mediaUrl: string | null;
    mediaType: string | null;
    width: number | null;
    height: number | null;
    aspectRatio: number | null;
  } | null;
}

export async function getPulseFeed(options: PulseFeedOptions): Promise<PulseFeedPost[]> {
  const limit = Math.min(options.limit || PULSE_CONFIG.DEFAULT_FEED_SIZE, PULSE_CONFIG.MAX_FEED_SIZE);
  const offset = options.offset || 0;

  // Get user interests for personalization
  let userInterestVector: Record<string, number> = {};
  if (options.userId) {
    const [ui] = await db
      .select()
      .from(userInterests)
      .where(eq(userInterests.userId, options.userId))
      .limit(1);
    if (ui) {
      userInterestVector = (ui.interestVector as Record<string, number>) || {};
    }
  }

  // Build conditions — location is never required
  const conditions = [
    eq(feedPosts.isActive, true),
    eq(feedPosts.feedSurface, 'pulse'),
    eq(feedPosts.mediaType, 'video'),
    // Only return posts that have a valid media URL (never return broken records)
    sql`(${feedPosts.mediaUrl} IS NOT NULL AND ${feedPosts.mediaUrl} != '')`,
  ];

  if (options.excludePostIds && options.excludePostIds.length > 0) {
    conditions.push(
      sql`${feedPosts.id} NOT IN (${sql.join(options.excludePostIds.map(id => sql`${id}`), sql`, `)})`
    );
  }

  if (options.userId) {
    const blockedByMe = await db.select({ blockedId: userBlocks.blockedId })
      .from(userBlocks)
      .where(eq(userBlocks.blockerId, options.userId));
    const blockedMe = await db.select({ blockerId: userBlocks.blockerId })
      .from(userBlocks)
      .where(eq(userBlocks.blockedId, options.userId));
    const excludedAuthorIds = [
      ...blockedByMe.map(b => b.blockedId),
      ...blockedMe.map(b => b.blockerId),
    ];
    if (excludedAuthorIds.length > 0) {
      conditions.push(
        sql`${feedPosts.authorId} NOT IN (${sql.join(excludedAuthorIds.map(id => sql`${id}`), sql`, `)})`
      );
    }
  }

  const eligiblePosts = await db
    .select({
      post: feedPosts,
      dist: postDistribution,
    })
    .from(feedPosts)
    .leftJoin(postDistribution, eq(feedPosts.id, postDistribution.postId))
    .where(and(...conditions))
    .orderBy(desc(feedPosts.createdAt))
    .limit(limit * 3);

  // Calculate scores and rank
  const scoredPosts = eligiblePosts.map(({ post, dist }) => {
    let score = 0.5; // Base score

    if (dist) {
      // Add distribution-based score
      score += calculatePostScore(dist) * 0.5;

      // Boost for cold start posts (give new content a chance)
      if (dist.coldStartEndsAt && new Date(dist.coldStartEndsAt) > new Date()) {
        score += 0.2;
      }

      // Tier-based boost (higher tier = more proven)
      score += (dist.currentTier - 1) * 0.1;
    } else {
      // New post without distribution record - high cold start boost
      score += 0.3;
    }

    // Personalization based on user interests
    if (userInterestVector[post.authorType]) {
      score += userInterestVector[post.authorType] * 0.2;
    }

    // Recency boost (newer posts get slight boost)
    const ageHours = (Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < 24) {
      score += 0.1 * (1 - ageHours / 24);
    }

    return { post, score };
  });

  // Sort by score and take top results
  scoredPosts.sort((a, b) => b.score - a.score);
  const topPosts = scoredPosts.slice(offset, offset + limit);

  // Enrich with author data
  const enrichedPosts: PulseFeedPost[] = [];
  for (const { post, score } of topPosts) {
    const [author] = await db
      .select()
      .from(users)
      .where(eq(users.id, post.authorId))
      .limit(1);

    if (!author) continue;

    let role: 'consumer' | 'vendor' | 'photographer' = 'consumer';
    if (author.isVendor) role = 'vendor';
    if (author.isPhotographer) role = 'photographer';

    const mediaResponse = (post.mediaUrl || post.imageUrl) ? {
      mediaUrl: post.mediaUrl || post.imageUrl,
      mediaType: post.mediaType || 'image',
      width: post.mediaWidth || null,
      height: post.mediaHeight || null,
      aspectRatio: post.aspectRatio || null,
    } : null;

    enrichedPosts.push({
      ...post,
      // Add top-level fields that mobile frontend expects
      videoUrl: post.mediaUrl || post.imageUrl || null,
      thumbnailUrl: post.thumbnailUrl || null,
      pulseScore: score,
      author: {
        userId: author.id,
        username: author.username || null,
        displayName: author.name || author.firstName || 'Anonymous',
        profilePhotoUrl: author.profileImageUrl || null,
        role,
      },
      media: mediaResponse,
    });
  }

  return enrichedPosts;
}

// =====================================================
// UTILITY EXPORTS
// =====================================================

export async function getPostDistribution(postId: string): Promise<PostDistribution | null> {
  const [dist] = await db
    .select()
    .from(postDistribution)
    .where(eq(postDistribution.postId, postId))
    .limit(1);
  return dist || null;
}

export async function getUserInterests(userId: string): Promise<UserInterests | null> {
  const [ui] = await db
    .select()
    .from(userInterests)
    .where(eq(userInterests.userId, userId))
    .limit(1);
  return ui || null;
}
