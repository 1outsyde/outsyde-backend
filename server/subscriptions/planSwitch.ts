/**
 * Paid plan switch (step 1.0b, decided by Legend 2026-10-19): the vendor moves to the new plan now, the
 * full new price is charged now, the billing date restarts today, and there is no credit for unused time.
 *
 * Stripe call: proration_behavior 'none' + billing_cycle_anchor 'now' (invoice for the full new price,
 * no proration lines) + payment_behavior 'pending_if_incomplete' (the change only applies once that
 * invoice is paid; a decline or a bank confirmation leaves the old plan in place with a pending_update).
 * Pending updates need collection_method charge_automatically, so a Send invoice plan (Lotus today) is
 * refused with a message instead.
 *
 * Tier, benefits and notices switch only when the payment succeeded. If the webhook
 * (customer.subscription.updated with the new price) lands first, it does the same work; the route
 * re-reads the row and skips what is already done, and the notice ref is shared, so nothing doubles.
 */
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { subscriptionTiers, type SubscriptionTier, type VendorSubscription } from "@shared/schema";
import { getSubscriptionPeriod, type SubscriptionPeriod } from "../stripe/subscriptionFields";
import { NotificationTriggers } from "../notificationService";
import { loadNoticeContext, sendSubscriptionNotice } from "./notices";

export type SwitchOutcome =
  | { kind: "switched"; period: SubscriptionPeriod | null; amountCents: number | null; invoiceId: string | null }
  | { kind: "pending"; url: string | null; invoiceId: string | null }
  | { kind: "not_switchable"; message: string };

export const INVOICE_BILLED_MESSAGE =
  "Your plan is billed by invoice, so it can't be switched here. Email info@goutsyde.com and we'll switch it for you.";
export const SWITCH_DECLINED_MESSAGE =
  "Your card was declined, so your plan didn't change. Update your card and try again.";

/** Shared ref so the route and the webhook send the "plan switched" notice once. */
export function planSwitchRef(newTierId: string, periodStart: Date | null | undefined): string {
  return `switch:${newTierId}:${periodStart ? periodStart.toISOString() : "unknown"}`;
}

export async function switchPaidPlan(stripe: Stripe, stripeSubscriptionId: string, newPriceId: string): Promise<SwitchOutcome> {
  const current: any = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  if (current.collection_method && current.collection_method !== "charge_automatically") {
    return { kind: "not_switchable", message: INVOICE_BILLED_MESSAGE };
  }
  const itemId = current.items?.data?.[0]?.id;
  if (!itemId) return { kind: "not_switchable", message: "Your current plan has no items to switch." };

  const updated: any = await stripe.subscriptions.update(stripeSubscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: "none",
    billing_cycle_anchor: "now",
    payment_behavior: "pending_if_incomplete",
    expand: ["latest_invoice"],
  } as any);
  const invoice = updated.latest_invoice && typeof updated.latest_invoice === "object" ? updated.latest_invoice : null;

  if (updated.pending_update) {
    return { kind: "pending", url: invoice?.hosted_invoice_url ?? null, invoiceId: invoice?.id ?? null };
  }
  return {
    kind: "switched",
    period: getSubscriptionPeriod(updated),
    amountCents: typeof invoice?.amount_paid === "number" ? invoice.amount_paid : null,
    invoiceId: invoice?.id ?? null,
  };
}

/** Saves a paid switch: tier, period, benefits, in-app notification, notice to the vendor and Outsyde. */
export async function applySwitchedPlan(vs: VendorSubscription, newTier: SubscriptionTier, outcome: Extract<SwitchOutcome, { kind: "switched" }>) {
  const previousTierId = vs.tierId;
  const [previousTier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, previousTierId));
  const fresh = await storage.getVendorSubscriptionByBusinessId(vs.businessId);
  const alreadyApplied = fresh?.tierId === newTier.id; // the webhook got there first

  await storage.updateVendorSubscription(vs.id, {
    tierId: newTier.id,
    status: "active",
    pastDueSince: null,
    ...(outcome.period ? { currentPeriodStart: outcome.period.start, currentPeriodEnd: outcome.period.end } : {}),
  } as any);
  await storage.updateBusiness(vs.businessId, { subscriptionActive: true });
  if (alreadyApplied) return;

  const previousName = previousTier?.displayName || previousTier?.name || "previous plan";
  const newName = newTier.displayName || newTier.name;
  const isUpgrade = (newTier.priceInCents || 0) > (previousTier?.priceInCents || 0);

  await storage.createAuditLog({
    actorId: vs.vendorId, actorType: "vendor",
    action: isUpgrade ? "subscription_upgraded" : "subscription_downgraded",
    targetType: "vendor_subscription", targetId: vs.id,
    beforeState: { tierId: previousTierId, tierName: previousName, priceInCents: previousTier?.priceInCents ?? 0 },
    afterState: { tierId: newTier.id, tierName: newName, priceInCents: newTier.priceInCents },
    metadata: { businessId: vs.businessId, stripeSubscriptionId: vs.stripeSubscriptionId, changeType: isUpgrade ? "upgrade" : "downgrade", chargedNowCents: outcome.amountCents },
  }).catch((err: unknown) => console.error("[PlanSwitch] audit failed:", err));
  await storage.migrateBenefitsForTierChange(vs.id, previousTierId, newTier.id);
  await NotificationTriggers.subscriptionTierChanged({
    userId: vs.vendorId, previousTierName: previousName, newTierName: newName, isUpgrade,
    subscriptionId: vs.id, effectiveDate: new Date().toLocaleDateString(),
  }).catch((err: unknown) => console.error("[PlanSwitch] notification failed:", err));

  const ctx = await loadNoticeContext({ ...vs, tierId: newTier.id });
  await sendSubscriptionNotice("plan_switched", planSwitchRef(newTier.id, outcome.period?.start), ctx, {
    previousPlanName: previousName, amountCents: outcome.amountCents, invoiceId: outcome.invoiceId, periodEnd: outcome.period?.end ?? null,
  });
}
