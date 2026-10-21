/**
 * Paid plan activation (Plan Offers board 1.5): the ONE place a new paid subscription is written and announced.
 *
 * Used by the checkout.session.completed webhook, the success page reconcile route
 * (POST /api/vendor/subscription/reconcile) and the one tap plan offer accept, so the vendor has access the
 * moment Stripe reports the subscription paid, whichever of them gets there first.
 *
 * Safe to run any number of times for the same subscription: every write sets the same values, the old
 * Stripe subscription is only cancelled when it differs from the new one, and the notices (vendor email,
 * push, in-app, Outsyde copy) are claimed once per `ref` in subscription_notices.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { subscriptionTiers } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripe/stripeClient";
import { getSubscriptionPeriod } from "../stripe/subscriptionFields";
import { NotificationTriggers } from "../notificationService";
import { enforceSubscriptionAccess } from "./lifecycle";
import { loadNoticeContext, sendSubscriptionNotice } from "./notices";

export interface ActivationInput {
  vendorId: string;
  businessId: string;
  tierId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  /** Notice key: the same activation reached twice (webhook + reconcile) must share it. */
  ref: string;
  amountCents?: number | null;
  /** The Stripe subscription when the caller already has it (saves a retrieve). */
  stripeSubscription?: any;
}

export interface ActivationResult {
  subscriptionRowId: string;
  status: "active" | "trialing";
  /** True only for the call that sent the notices. */
  announced: boolean;
}

/** A paid plan for this business and tier was started: any pending offer for it is now accepted. */
export async function markPlanOffersAccepted(businessId: string, tierId: string): Promise<number> {
  const r = await db.execute(sql`
    UPDATE plan_offers SET status = 'accepted', accepted_at = now()
     WHERE business_id = ${businessId} AND tier_id = ${tierId} AND status = 'pending'
    RETURNING id`);
  return r.rows.length;
}

export async function activatePaidSubscription(input: ActivationInput): Promise<ActivationResult> {
  const { vendorId, businessId, tierId, stripeSubscriptionId, stripeCustomerId } = input;

  // The Stripe subscription: its status (a plan that starts on a free trial is 'trialing') and period.
  let stripeSub: any = input.stripeSubscription ?? null;
  if (!stripeSub) {
    try {
      const stripe = await getUncachableStripeClient();
      stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    } catch (err) {
      console.error(`[Activation] Could not read ${stripeSubscriptionId} from Stripe:`, err instanceof Error ? err.message : "unknown error");
    }
  }
  const status: "active" | "trialing" = stripeSub?.status === "trialing" ? "trialing" : "active";
  const period = stripeSub ? getSubscriptionPeriod(stripeSub) : null;
  const trialEnd = status === "trialing" && typeof stripeSub?.trial_end === "number" ? new Date(stripeSub.trial_end * 1000) : null;

  // One row per business (uq_vendor_subscriptions_business): by business first, then by vendor.
  const existing =
    (await storage.getVendorSubscriptionByBusinessId(businessId)) ??
    (await storage.getVendorSubscription(vendorId));

  let subscriptionRowId: string;
  if (existing) {
    const oldStripeSubId = existing.stripeSubscriptionId;
    await storage.updateVendorSubscription(existing.id, {
      tierId,
      status,
      stripeSubscriptionId,
      stripeCustomerId,
      pastDueSince: null,
    } as any);
    subscriptionRowId = existing.id;

    // A different Stripe subscription (a lapsed old plan) is cancelled so the business is never billed twice.
    if (oldStripeSubId && oldStripeSubId !== stripeSubscriptionId) {
      try {
        const stripe = await getUncachableStripeClient();
        await stripe.subscriptions.cancel(oldStripeSubId);
        console.log(`[Activation] Cancelled old Stripe subscription ${oldStripeSubId}, replaced by ${stripeSubscriptionId} for vendor ${vendorId}`);
      } catch (cancelErr) {
        console.error(`[Activation] Failed to cancel old Stripe subscription ${oldStripeSubId}:`, cancelErr);
      }
    }
  } else {
    const newSub = await storage.createVendorSubscription({
      vendorId,
      businessId,
      tierId,
      stripeCustomerId: stripeCustomerId ?? undefined,
      stripeSubscriptionId,
    } as any);
    subscriptionRowId = newSub.id;
    await storage.updateVendorSubscription(newSub.id, { status } as any);
  }

  await storage.updateBusiness(businessId, { subscriptionActive: true });
  if (period) {
    await storage.updateVendorSubscription(subscriptionRowId, { currentPeriodStart: period.start, currentPeriodEnd: period.end });
  }

  // Resubscribing brings back whatever the system paused for a lapsed plan (decided 2026-10-19).
  const restored = (await enforceSubscriptionAccess(businessId, "subscription_activated")).unpaused;

  try {
    await markPlanOffersAccepted(businessId, tierId);
  } catch (err) {
    console.error(`[Activation] Could not mark the plan offer accepted for business ${businessId}:`, err instanceof Error ? err.message : err);
  }

  console.log(`[Activation] Subscription ${status}: vendor=${vendorId} business=${businessId} tier=${tierId} stripeSubId=${stripeSubscriptionId}`);

  let announced = false;
  const row = await storage.getVendorSubscriptionByBusinessId(businessId);
  if (row) {
    const ctx = await loadNoticeContext(row);
    announced = await sendSubscriptionNotice("activated", input.ref, ctx, {
      amountCents: input.amountCents ?? null,
      periodEnd: period?.end ?? null,
      billingStartsAt: trialEnd,
      restoredItems: restored,
    });
    if (restored > 0) await sendSubscriptionNotice("restored", input.ref, ctx, { restoredItems: restored, periodEnd: period?.end ?? null });
  }

  // In-app notifications once, together with the notices (a webhook retry or the reconcile route adds none).
  if (announced) {
    const [tier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, tierId));
    const tierName = tier?.displayName || tier?.name || "subscription";
    await NotificationTriggers.subscriptionActivated({ userId: vendorId, tierName, subscriptionId: subscriptionRowId });
    if (status === "active") {
      await NotificationTriggers.paymentSucceeded({
        userId: vendorId,
        amount: input.amountCents || 0,
        referenceType: "vendor_subscription",
        referenceId: subscriptionRowId,
        description: `Your ${tierName} subscription payment was successful.`,
      });
    }
  }

  return { subscriptionRowId, status, announced };
}
