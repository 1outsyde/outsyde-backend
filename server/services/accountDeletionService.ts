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
  profileComments,
  pulseEngagements,
  userInterests,
  userSavedPosts,
  feedEngagementEvents,
  influencerApplications,
  influencerAttributions,
  vendorEmailSequence,
  pointTransactions,
  userBlocks,
  bookingAuditLog,
  messages,
  reviews,
  feedPosts,
  orders,
  orderGroups,
  shootBookings,
  appointments,
  scheduling,
  refundRequests,
  alaCartePurchases,
  vendorSubscriptions,
  benefitUsage,
  fulfillmentTasks,
  sponsoredPosts,
  referrals,
  messageReports,
  moderationQueue,
  adminIssues,
} from "../../shared/schema";
import { eq, or, lte, and, inArray, sql } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripe/stripeClient";

const DELETION_SUPPORT_EMAIL = "info@goutsyde.com";

// Active statuses that block deletion — only states where real work is in flight
const ACTIVE_ORDER_STATUSES = ["pending", "processing", "confirmed", "in_progress"];
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

async function purgePostMediaAssets(
  userId: string,
  posts: Array<{ id: string; mediaUrl: string | null; imageUrl: string | null; mediaType: string | null }>
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
  }
  console.log(`[accountDeletion] User ${userId}: purged media for ${posts.length} post(s)`);
}

async function deleteUserFeedPosts(userId: string, tx: typeof db): Promise<void> {
  const posts = await tx
    .select({ id: feedPosts.id, mediaUrl: feedPosts.mediaUrl, imageUrl: feedPosts.imageUrl, mediaType: feedPosts.mediaType })
    .from(feedPosts)
    .where(eq(feedPosts.authorId, userId));

  if (posts.length === 0) return;

  // Purge media assets before removing DB rows so we don't lose the URL references
  await purgePostMediaAssets(userId, posts);

  const postIds = posts.map(p => p.id);
  await tx.delete(postLikes).where(inArray(postLikes.postId, postIds));
  await tx.delete(postComments).where(inArray(postComments.postId, postIds));
  await tx.delete(feedPosts).where(eq(feedPosts.authorId, userId));
}

async function processSingleUserDeletion(userId: string): Promise<void> {
  console.log(`[accountDeletion] Starting deletion for user ${userId}`);

  await db.transaction(async (tx) => {
    // Group 0: force logout
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));

    // Group 1: pure engagement / session data
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    await tx.delete(notifications).where(eq(notifications.userId, userId));
    await tx.delete(cartItems).where(eq(cartItems.userId, userId));
    await tx.delete(bookingHolds).where(eq(bookingHolds.userId, userId));
    await tx.delete(follows).where(or(eq(follows.followerUserId, userId), eq(follows.targetUserId, userId)));
    await tx.delete(pulseEngagements).where(eq(pulseEngagements.userId, userId));
    await tx.delete(userInterests).where(eq(userInterests.userId, userId));
    await tx.delete(userSavedPosts).where(eq(userSavedPosts.userId, userId));
    await tx.delete(feedEngagementEvents).where(eq(feedEngagementEvents.userId, userId));
    await tx.delete(influencerApplications).where(eq(influencerApplications.userId, userId));
    await tx.delete(vendorEmailSequence).where(eq(vendorEmailSequence.vendorId, userId));
    await tx.delete(pointTransactions).where(eq(pointTransactions.userId, userId));
    await tx.delete(influencerAttributions).where(eq(influencerAttributions.userId, userId));
    await tx.delete(benefitUsage).where(eq(benefitUsage.vendorId, userId));
    await tx.delete(postLikes).where(eq(postLikes.userId, userId));

    // Group 2: soft-reference cleanup (no FK constraints in DB)
    await tx.delete(userBlocks).where(or(eq(userBlocks.blockerId, userId), eq(userBlocks.blockedId, userId)));
    await tx
      .update(bookingAuditLog)
      .set({ triggeredBy: null } as any)
      .where(eq(bookingAuditLog.triggeredBy, userId));

    // Group 3: social content — anonymize, preserve threads for other participants
    await tx.update(postComments).set({ userId: null } as any).where(eq(postComments.userId, userId));
    await tx.update(profileComments).set({ userId: null } as any).where(eq(profileComments.userId, userId));
    await tx.update(messages).set({ senderId: null } as any).where(eq(messages.senderId, userId));
    await tx.update(reviews).set({ reviewerId: null } as any).where(eq(reviews.reviewerId, userId));

    // Group 4: feed posts + purge media assets (GCS images / Mux videos)
    await deleteUserFeedPosts(userId, tx);

    // Group 5: financial records — anonymize FK, retain row
    await tx.update(orders).set({ customerId: null } as any).where(eq(orders.customerId, userId));
    await tx.update(orderGroups).set({ customerId: null } as any).where(eq(orderGroups.customerId, userId));
    await tx.update(shootBookings).set({ clientId: null } as any).where(eq(shootBookings.clientId, userId));
    await tx.update(appointments).set({ clientId: null } as any).where(eq(appointments.clientId, userId));
    await tx.update(scheduling).set({ clientId: null } as any).where(eq(scheduling.clientId, userId));
    await tx.update(refundRequests).set({ requesterId: null } as any).where(eq(refundRequests.requesterId, userId));
    await tx.update(alaCartePurchases).set({ vendorId: null } as any).where(eq(alaCartePurchases.vendorId, userId));
    await tx.update(vendorSubscriptions).set({ vendorId: null } as any).where(eq(vendorSubscriptions.vendorId, userId));
    await tx.update(fulfillmentTasks).set({ vendorId: null } as any).where(eq(fulfillmentTasks.vendorId, userId));
    await tx.update(sponsoredPosts).set({ vendorId: null } as any).where(eq(sponsoredPosts.vendorId, userId));
    await tx.update(referrals).set({ referrerId: null } as any).where(eq(referrals.referrerId, userId));
    await tx.update(referrals).set({ referredUserId: null } as any).where(eq(referrals.referredUserId, userId));

    // Group 6: trust & safety — anonymize, retain
    await tx
      .update(messageReports)
      .set({ reporterId: null, reportedUserId: null } as any)
      .where(or(eq(messageReports.reporterId, userId), eq(messageReports.reportedUserId, userId)));
    await tx.update(moderationQueue).set({ reporterId: null } as any).where(eq(moderationQueue.reporterId, userId));
    await tx.update(adminIssues).set({ createdBy: null } as any).where(eq(adminIssues.createdBy, userId));

    // Group 7: staff unlink (userId is nullable on staffMembers)
    await tx.update(staffMembers).set({ userId: null } as any).where(eq(staffMembers.userId, userId));

    // Group 8: vendor/profile deactivation + PII scrub
    // businesses has no isActive column; rejecting the approvalStatus hides it from
    // isBusinessVisibleToPublic() which is the gate on all public storefront endpoints.
    await tx.update(businesses).set({
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
    await tx.update(photographers).set({
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
    await tx.update(influencerProfiles).set({
      bio: null,
      instagramUrl: null,
      tiktokUrl: null,
      youtubeUrl: null,
      twitterUrl: null,
      promoCode: null,
    } as any).where(eq(influencerProfiles.userId, userId));
    // influencer_referral_events / earning_ledger / payouts survive through influencer_profiles.id — no action needed

    // Group 10: scrub PII from the users row (do NOT delete — it anchors anonymized FKs)
    const deletedUsername = `deleted_${userId.replace(/-/g, "").slice(0, 10)}`;
    await tx.update(users).set({
      deletionStatus: "deleted",
      email: null,
      phone: null,
      name: null,
      firstName: null,
      lastName: null,
      bio: null,
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
  });

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

  return { blocked: false };
}
