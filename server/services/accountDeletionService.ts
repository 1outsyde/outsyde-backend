import { db } from "../db";
import { objectStorageClient } from "../objectStorage";
import { deleteMuxAsset, getMuxAssetIdByPlaybackId } from "./mux";
import { deleteFromR2 } from "./r2";
import {
  users,
  businesses,
  staffMembers,
  photographers,
  influencerProfiles,
  refreshTokens,
  pushSubscriptions,
  notifications,
  cartItems,
  bookingHolds,
  follows,
  postLikes,
  postComments,
  pulseEngagements,
  userInterests,
  userSavedPosts,
  userFavorites,
  feedEngagementEvents,
  influencerApplications,
  influencerAttributions,
  vendorEmailSequence,
  pointTransactions,
  userBlocks,
  bookingAuditLog,
  feedPosts,
  orders,
  shootBookings,
  appointments,
  benefitUsage,
  sponsoredPosts,
  adminIssues,
  postDistribution,
  stories,
  storyViews,
  storyHighlights,
} from "../../shared/schema";
import { eq, or, lte, and, inArray, sql } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripe/stripeClient";

const DELETION_SUPPORT_EMAIL = "info@goutsyde.com";

// Active statuses that block deletion — only states where real work is in flight
// pending/processing/confirmed/in_progress = legacy values still in DB from before the shipping-flow refactor
// paid = payment captured, awaiting shipment; shipped = in transit, awaiting delivery
const ACTIVE_ORDER_STATUSES = ["pending", "processing", "confirmed", "in_progress", "paid", "shipped"];
const ACTIVE_BOOKING_STATUSES = ["pending_payment", "pending_provider", "confirmed"];

async function deleteGcsObjectByUrl(url: string): Promise<void> {
  if (!url.startsWith("https://storage.googleapis.com/")) return;
  try {
    const pathname = new URL(url).pathname; // "/{bucket}/{path...}"
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length < 2) return;
    const bucketName = parts[0];
    const objectName = parts.slice(1).join("/");
    await objectStorageClient.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
  } catch (err) {
    console.warn("[accountDeletion] GCS delete failed for", url, err);
  }
}

async function deleteImageAsset(url: string, postId: string): Promise<void> {
  if (url.startsWith("https://storage.googleapis.com/")) {
    await deleteGcsObjectByUrl(url);
  } else {
    // R2 (current upload path) or any other non-GCS, non-Mux URL
    try {
      await deleteFromR2(url);
    } catch (err) {
      console.warn(`[accountDeletion] R2 delete failed for post ${postId}:`, url, err);
    }
  }
}

export async function purgePostMediaAssets(
  userId: string,
  posts: Array<{ id: string; mediaUrl: string | null; imageUrl: string | null; mediaType: string | null; mediaItems?: Array<{ url: string }> | null }>
): Promise<void> {
  for (const post of posts) {
    // Mux video asset
    if (post.mediaType === "video" && post.mediaUrl?.includes("stream.mux.com")) {
      // URL format: https://stream.mux.com/{playbackId}.m3u8
      const match = post.mediaUrl.match(/stream\.mux\.com\/([^.]+)\.m3u8/);
      if (match) {
        try {
          const assetId = await getMuxAssetIdByPlaybackId(match[1]);
          if (assetId) await deleteMuxAsset(assetId);
        } catch (err) {
          console.warn(`[accountDeletion] Mux delete failed for post ${post.id}:`, err);
        }
      }
    } else if (post.mediaUrl) {
      // GCS (legacy) or R2 (current) image
      await deleteImageAsset(post.mediaUrl, post.id);
    }
    // Legacy imageUrl field — GCS or R2 depending on age of the post
    if (post.imageUrl) await deleteImageAsset(post.imageUrl, post.id);
    // Multi-photo posts (migration 045): photos 2-10 live only in mediaItems.
    // Photo 1 equals mediaUrl/imageUrl and was deleted above, so skip those.
    for (const item of post.mediaItems ?? []) {
      if (!item?.url || item.url === post.mediaUrl || item.url === post.imageUrl) continue;
      await deleteImageAsset(item.url, post.id);
    }
  }
  console.log(`[accountDeletion] User ${userId}: purged media for ${posts.length} post(s)`);
}

async function deleteUserFeedPosts(userId: string): Promise<void> {
  const posts = await db
    .select({ id: feedPosts.id, mediaUrl: feedPosts.mediaUrl, imageUrl: feedPosts.imageUrl, mediaType: feedPosts.mediaType, mediaItems: feedPosts.mediaItems })
    .from(feedPosts)
    .where(eq(feedPosts.authorId, userId));

  if (posts.length === 0) return;

  // Purge media assets before removing DB rows so we don't lose the URL references
  await purgePostMediaAssets(userId, posts);

  const postIds = posts.map(p => p.id);
  // Every table with a foreign key to feed_posts (all ON DELETE NO ACTION in Neon, checked 2026-10-16).
  // Rows written by OTHER users (their saves, likes, comments, engagement) must go first or the post delete fails.
  await db.delete(postLikes).where(inArray(postLikes.postId, postIds));
  await db.delete(postComments).where(inArray(postComments.postId, postIds));
  await db.delete(userSavedPosts).where(inArray(userSavedPosts.postId, postIds));
  await db.delete(pulseEngagements).where(inArray(pulseEngagements.postId, postIds));
  await db.delete(feedEngagementEvents).where(inArray(feedEngagementEvents.postId, postIds));
  await db.delete(postDistribution).where(inArray(postDistribution.postId, postIds));
  await db.delete(sponsoredPosts).where(inArray(sponsoredPosts.postId, postIds));
  await db.delete(feedPosts).where(eq(feedPosts.authorId, userId));
}

async function purgeMediaUrl(url: string | null | undefined, label: string): Promise<void> {
  if (!url) return;
  if (url.includes("stream.mux.com")) {
    const match = url.match(/stream\.mux\.com\/([^.]+)\.m3u8/);
    if (!match) return;
    try {
      const assetId = await getMuxAssetIdByPlaybackId(match[1]);
      if (assetId) await deleteMuxAsset(assetId);
    } catch (err) {
      console.warn(`[accountDeletion] Mux delete failed for ${label}:`, err);
    }
    return;
  }
  await deleteImageAsset(url, label);
}

async function deleteUserStories(userId: string): Promise<void> {
  const userStories = await db
    .select({ id: stories.id, mediaType: stories.mediaType, mediaUrl: stories.mediaUrl, muxAssetId: stories.muxAssetId, isActive: stories.isActive })
    .from(stories)
    .where(eq(stories.authorId, userId));

  // Expired stories already had their media removed by cleanupExpiredStories; only purge live ones.
  for (const story of userStories) {
    if (!story.isActive) continue;
    try {
      if (story.mediaType === "video" && story.muxAssetId) {
        await deleteMuxAsset(story.muxAssetId);
      } else if (story.mediaUrl) {
        await deleteImageAsset(story.mediaUrl, `story ${story.id}`);
      }
    } catch (err) {
      console.warn(`[accountDeletion] Story media delete failed for ${story.id}:`, err);
    }
  }

  const storyIds = userStories.map(s => s.id);
  // story_views and story_highlights reference stories (ON DELETE NO ACTION), so they go first.
  await db.delete(storyViews).where(eq(storyViews.viewerId, userId));
  await db.delete(storyHighlights).where(eq(storyHighlights.userId, userId));
  if (storyIds.length > 0) {
    await db.delete(storyViews).where(inArray(storyViews.storyId, storyIds));
    await db.delete(storyHighlights).where(inArray(storyHighlights.storyId, storyIds));
    await db.delete(stories).where(eq(stories.authorId, userId));
  }
}

/**
 * Deletes one account whose 30-day grace period has passed.
 *
 * The Neon HTTP driver has no transactions (db.transaction() always throws), so the steps run in order
 * and every step is safe to run again. The users row is marked "deleted" LAST: if any step fails, the
 * account stays "pending_deletion" and the next daily run starts over from the top.
 *
 * The users row itself is kept but scrubbed of personal data. Orders, bookings, messages, comments and
 * reviews keep pointing at it (those columns are NOT NULL in Neon), so they are left attached to an
 * anonymous "deleted_..." account rather than emptied.
 */
async function processSingleUserDeletion(userId: string): Promise<void> {
  console.log(`[accountDeletion] Starting deletion for user ${userId}`);

  const [account] = await db
    .select({ deletionStatus: users.deletionStatus, profileImageUrl: users.profileImageUrl, coverMediaUrl: users.coverMediaUrl })
    .from(users)
    .where(eq(users.id, userId));
  if (!account || account.deletionStatus !== "pending_deletion") {
    console.log(`[accountDeletion] User ${userId} is no longer pending deletion, skipping`);
    return;
  }

  // Group 0: force logout
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));

  // Group 1: pure engagement / session data
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await db.delete(cartItems).where(eq(cartItems.userId, userId));
  await db.delete(bookingHolds).where(eq(bookingHolds.userId, userId));
  await db.delete(follows).where(or(eq(follows.followerUserId, userId), eq(follows.targetUserId, userId)));
  await db.delete(pulseEngagements).where(eq(pulseEngagements.userId, userId));
  await db.delete(userInterests).where(eq(userInterests.userId, userId));
  await db.delete(userSavedPosts).where(eq(userSavedPosts.userId, userId));
  await db.delete(userFavorites).where(eq(userFavorites.userId, userId));
  await db.delete(feedEngagementEvents).where(eq(feedEngagementEvents.userId, userId));
  await db.delete(influencerApplications).where(eq(influencerApplications.userId, userId));
  await db.delete(vendorEmailSequence).where(eq(vendorEmailSequence.vendorId, userId));
  await db.delete(pointTransactions).where(eq(pointTransactions.userId, userId));
  await db.delete(influencerAttributions).where(eq(influencerAttributions.userId, userId));
  await db.delete(benefitUsage).where(eq(benefitUsage.vendorId, userId));
  await db.delete(postLikes).where(eq(postLikes.userId, userId));

  // Group 2: soft-reference cleanup
  await db.delete(userBlocks).where(or(eq(userBlocks.blockerId, userId), eq(userBlocks.blockedId, userId)));
  await db
    .update(bookingAuditLog)
    .set({ triggeredBy: null } as any)
    .where(eq(bookingAuditLog.triggeredBy, userId));

  // Group 3: social content. Comments, profile comments, messages and reviews stay attached to the
  // scrubbed users row (user/sender/reviewer columns are NOT NULL in Neon), so threads stay readable.

  // Group 4: feed posts + stories, with their media (R2 / legacy GCS images, Mux videos)
  await deleteUserFeedPosts(userId);
  await deleteUserStories(userId);

  // Group 5 + 6: financial records (orders, bookings, refunds, subscriptions, referrals) and trust & safety
  // reports are retained and stay attached to the scrubbed users row. Only nullable references are cleared.
  await db.update(adminIssues).set({ createdBy: null } as any).where(eq(adminIssues.createdBy, userId));

  // Group 7: staff unlink (userId is nullable on staffMembers)
  await db.update(staffMembers).set({ userId: null } as any).where(eq(staffMembers.userId, userId));

  // Group 8: vendor/profile deactivation + PII scrub
  // businesses has no isActive column; rejecting the approvalStatus hides it from
  // isBusinessVisibleToPublic() which is the gate on all public storefront endpoints.
  await db.update(businesses).set({
    approvalStatus: "rejected",
    contactEmail: null,
    contactPhone: null,
    address: null,
    city: null,
    state: null,
    zipCode: null,
    latitude: null,
    longitude: null,
    websiteUrl: null,
    socialMedia: null,
    coverImage: null,
    logoImage: null,
    billingAddress: null,
  } as any).where(eq(businesses.ownerId, userId));

  // photographers has no isActive column; setting visibilityStatus to 'hidden' removes
  // it from PhotographerService.list() and .get() which both filter on visibilityStatus = 'public'.
  await db.update(photographers).set({
    visibilityStatus: "hidden",
    bio: null,
    city: null,
    state: null,
    latitude: null,
    longitude: null,
    portfolioUrl: null,
    studioName: null,
    studioAddress: null,
    coverImage: null,
    logoImage: null,
    billingAddress: null,
    serviceLocations: null,
  } as any).where(eq(photographers.userId, userId));

  // influencerProfiles has no visibility gate, but scrub social handles and promo code.
  await db.update(influencerProfiles).set({
    bio: null,
    instagramUrl: null,
    tiktokUrl: null,
    youtubeUrl: null,
    twitterUrl: null,
    promoCode: null,
  } as any).where(eq(influencerProfiles.userId, userId));
  // influencer_referral_events / earning_ledger / payouts survive through influencer_profiles.id — no action needed

  // Group 9: profile photo and cover media files
  await purgeMediaUrl(account.profileImageUrl, "profile image");
  await purgeMediaUrl(account.coverMediaUrl, "cover media");

  // Group 10 (LAST): scrub PII from the users row (do NOT delete — it anchors retained records).
  // isActive=false + password=null blocks every login path (isUserAllowedToAuthenticate).
  const deletedUsername = `deleted_${userId.replace(/-/g, "").slice(0, 10)}`;
  await db.update(users).set({
    deletionStatus: "deleted",
    isActive: false,
    password: null,
    email: null,
    phone: null,
    name: null,
    firstName: null,
    lastName: null,
    bio: null,
    profileImageUrl: null,
    coverMediaUrl: null,
    coverMediaType: null,
    address: null,
    aptUnit: null,
    city: null,
    state: null,
    zipCode: null,
    latitude: null,
    longitude: null,
    billingAddress: null,
    billingStreet: null,
    billingAptUnit: null,
    billingCity: null,
    billingState: null,
    billingZip: null,
    billingCountry: null,
    dateOfBirth: null,
    gender: null,
    ethnicity: null,
    nationality: null,
    householdSize: null,
    incomeRange: null,
    education: null,
    occupation: null,
    shoppingFrequency: null,
    expoPushToken: null,
    pushTokenType: null,
    googleSub: null,
    appleId: null,
    stripeCustomerId: null,
    defaultPaymentMethodId: null,
    resetTokenHash: null,
    resetTokenExpiresAt: null,
    resetCodeHash: null,
    resetCodeExpiresAt: null,
    resetCodeAttempts: 0,
    username: deletedUsername,
    isAdmin: false,
    referralCode: null,
  } as any).where(eq(users.id, userId));

  console.log(`[accountDeletion] Completed deletion for user ${userId}`);
}

export async function processScheduledDeletions(): Promise<void> {
  const now = new Date();

  const due = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.deletionStatus, "pending_deletion"), lte(users.scheduledDeletionAt, now)));

  if (due.length === 0) return;

  console.log(`[accountDeletion] Processing ${due.length} scheduled deletion(s)`);

  for (const { id } of due) {
    try {
      await processSingleUserDeletion(id);
    } catch (err) {
      console.error(`[accountDeletion] Failed to delete user ${id}:`, err);
    }
  }
}

export async function checkVendorStripeBalances(userId: string): Promise<{ blocked: boolean; reason?: string }> {
  let stripe: Awaited<ReturnType<typeof getUncachableStripeClient>>;
  try {
    stripe = await getUncachableStripeClient();
  } catch {
    console.warn("[accountDeletion] Stripe unavailable — skipping balance check");
    return { blocked: false };
  }

  type StripeAccountEntry = { stripeAccountId: string | null; label: string };
  const entries: StripeAccountEntry[] = [];

  const bizRows = await db
    .select({ stripeAccountId: businesses.stripeAccountId, name: businesses.name })
    .from(businesses)
    .where(eq(businesses.ownerId, userId));
  for (const r of bizRows) entries.push({ stripeAccountId: r.stripeAccountId, label: `business "${r.name}"` });

  const photoRows = await db
    .select({ stripeAccountId: photographers.stripeAccountId })
    .from(photographers)
    .where(eq(photographers.userId, userId));
  for (const r of photoRows) entries.push({ stripeAccountId: r.stripeAccountId, label: "photographer account" });

  const influRows = await db
    .select({ stripeAccountId: influencerProfiles.stripeAccountId })
    .from(influencerProfiles)
    .where(eq(influencerProfiles.userId, userId));
  for (const r of influRows) entries.push({ stripeAccountId: r.stripeAccountId, label: "influencer account" });

  const staffRows = await db
    .select({ stripeAccountId: staffMembers.stripeAccountId })
    .from(staffMembers)
    .where(eq(staffMembers.userId, userId));
  for (const r of staffRows) entries.push({ stripeAccountId: r.stripeAccountId, label: "staff account" });

  for (const { stripeAccountId, label } of entries) {
    if (!stripeAccountId) continue;
    try {
      const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
      const hasBalance =
        balance.available.some(b => b.amount > 0) || balance.pending.some(b => b.amount > 0);
      if (hasBalance) {
        return {
          blocked: true,
          reason: `Your ${label} has a pending Stripe balance or payout. Wait for all payouts to complete before deleting your account. Contact ${DELETION_SUPPORT_EMAIL} for help.`,
        };
      }
    } catch (err) {
      console.warn(`[accountDeletion] Stripe balance check failed for ${label}:`, err);
    }
  }

  return { blocked: false };
}

export async function checkActiveOrders(userId: string): Promise<{ blocked: boolean; reason?: string }> {
  const [activeOrder] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.customerId, userId), inArray(orders.status, ACTIVE_ORDER_STATUSES)))
    .limit(1);

  if (activeOrder) {
    return {
      blocked: true,
      reason: "You have active orders that must be completed or cancelled before your account can be deleted.",
    };
  }

  const [activeAppt] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.clientId, userId), inArray(appointments.status, ACTIVE_BOOKING_STATUSES)))
    .limit(1);

  if (activeAppt) {
    return {
      blocked: true,
      reason: "You have active appointments that must be completed or cancelled before your account can be deleted.",
    };
  }

  const [activeBooking] = await db
    .select({ id: shootBookings.id })
    .from(shootBookings)
    .where(and(eq(shootBookings.clientId, userId), inArray(shootBookings.status, ACTIVE_BOOKING_STATUSES)))
    .limit(1);

  if (activeBooking) {
    return {
      blocked: true,
      reason: "You have active shoot bookings that must be completed or cancelled before your account can be deleted.",
    };
  }

  // As the PHOTOGRAPHER (2026-10-18): never delete someone a customer is still booked with.
  const ownPhotographers = await db
    .select({ id: photographers.id })
    .from(photographers)
    .where(eq(photographers.userId, userId));
  if (ownPhotographers.length) {
    const [hostedShoot] = await db
      .select({ id: shootBookings.id })
      .from(shootBookings)
      .where(and(
        inArray(shootBookings.photographerId, ownPhotographers.map((p) => p.id)),
        inArray(shootBookings.status, ACTIVE_BOOKING_STATUSES),
      ))
      .limit(1);
    if (hostedShoot) {
      return {
        blocked: true,
        reason: "There are shoots booked with this photographer that must be completed or cancelled before the account can be deleted.",
      };
    }
  }

  return { blocked: false };
}
