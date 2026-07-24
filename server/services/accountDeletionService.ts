import { db } from "../db";
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

async function deleteUserFeedPosts(userId: string): Promise<void> {
  const posts = await db
    .select({ id: feedPosts.id, mediaUrl: feedPosts.mediaUrl, imageUrl: feedPosts.imageUrl })
    .from(feedPosts)
    .where(eq(feedPosts.authorId, userId));

  if (posts.length === 0) return;

  // Log media for async R2/Mux cleanup — wire ObjectStorageService.deleteObject() here when available
  const mediaUrls = posts.flatMap(p => [p.mediaUrl, p.imageUrl].filter(Boolean));
  if (mediaUrls.length > 0) {
    console.log(`[accountDeletion] User ${userId}: ${mediaUrls.length} media asset(s) need R2/CDN cleanup:`, mediaUrls);
  }

  const postIds = posts.map(p => p.id);
  await db.delete(postLikes).where(inArray(postLikes.postId, postIds));
  await db.delete(postComments).where(inArray(postComments.postId, postIds));
  await db.delete(feedPosts).where(eq(feedPosts.authorId, userId));
}

async function processSingleUserDeletion(userId: string): Promise<void> {
  console.log(`[accountDeletion] Starting deletion for user ${userId}`);

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
  await db.delete(feedEngagementEvents).where(eq(feedEngagementEvents.userId, userId));
  await db.delete(influencerApplications).where(eq(influencerApplications.userId, userId));
  await db.delete(vendorEmailSequence).where(eq(vendorEmailSequence.vendorId, userId));
  await db.delete(pointTransactions).where(eq(pointTransactions.userId, userId));
  await db.delete(influencerAttributions).where(eq(influencerAttributions.userId, userId));
  await db.delete(benefitUsage).where(eq(benefitUsage.vendorId, userId));
  await db.delete(postLikes).where(eq(postLikes.userId, userId));

  // Group 2: soft-reference cleanup (no FK constraints in DB)
  await db.delete(userBlocks).where(or(eq(userBlocks.blockerId, userId), eq(userBlocks.blockedId, userId)));
  await db
    .update(bookingAuditLog)
    .set({ triggeredBy: null } as any)
    .where(eq(bookingAuditLog.triggeredBy, userId));

  // Group 3: social content — anonymize, preserve threads for other participants
  await db.update(postComments).set({ userId: null } as any).where(eq(postComments.userId, userId));
  await db.update(profileComments).set({ userId: null } as any).where(eq(profileComments.userId, userId));
  await db.update(messages).set({ senderId: null } as any).where(eq(messages.senderId, userId));
  await db.update(reviews).set({ reviewerId: null } as any).where(eq(reviews.reviewerId, userId));

  // Group 4: feed posts + log media for cleanup
  await deleteUserFeedPosts(userId);

  // Group 5: financial records — anonymize FK, retain row
  await db.update(orders).set({ customerId: null } as any).where(eq(orders.customerId, userId));
  await db.update(orderGroups).set({ customerId: null } as any).where(eq(orderGroups.customerId, userId));
  await db.update(shootBookings).set({ clientId: null } as any).where(eq(shootBookings.clientId, userId));
  await db.update(appointments).set({ clientId: null } as any).where(eq(appointments.clientId, userId));
  await db.update(scheduling).set({ clientId: null } as any).where(eq(scheduling.clientId, userId));
  await db.update(refundRequests).set({ requesterId: null } as any).where(eq(refundRequests.requesterId, userId));
  await db.update(alaCartePurchases).set({ vendorId: null } as any).where(eq(alaCartePurchases.vendorId, userId));
  await db.update(vendorSubscriptions).set({ vendorId: null } as any).where(eq(vendorSubscriptions.vendorId, userId));
  await db.update(fulfillmentTasks).set({ vendorId: null } as any).where(eq(fulfillmentTasks.vendorId, userId));
  await db.update(sponsoredPosts).set({ vendorId: null } as any).where(eq(sponsoredPosts.vendorId, userId));
  await db.update(referrals).set({ referrerId: null } as any).where(eq(referrals.referrerId, userId));
  await db.update(referrals).set({ referredUserId: null } as any).where(eq(referrals.referredUserId, userId));

  // Group 6: trust & safety — anonymize, retain
  await db
    .update(messageReports)
    .set({ reporterId: null, reportedUserId: null } as any)
    .where(or(eq(messageReports.reporterId, userId), eq(messageReports.reportedUserId, userId)));
  await db.update(moderationQueue).set({ reporterId: null } as any).where(eq(moderationQueue.reporterId, userId));
  await db.update(adminIssues).set({ createdBy: null } as any).where(eq(adminIssues.createdBy, userId));

  // Group 7: staff unlink (userId is nullable on staffMembers)
  await db.update(staffMembers).set({ userId: null } as any).where(eq(staffMembers.userId, userId));

  // Group 8: vendor/profile deactivation
  await db.update(businesses).set({ isActive: false } as any).where(eq(businesses.ownerId, userId));
  await db.update(photographers).set({ isActive: false } as any).where(eq(photographers.userId, userId));
  await db.update(influencerProfiles).set({ isActive: false } as any).where(eq(influencerProfiles.userId, userId));
  // influencer_referral_events / earning_ledger / payouts survive through influencer_profiles.id — no action needed

  // Group 10: scrub PII from the users row (do NOT delete — it anchors anonymized FKs)
  const deletedUsername = `deleted_${userId.replace(/-/g, "").slice(0, 10)}`;
  await db.update(users).set({
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
