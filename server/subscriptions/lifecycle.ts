/**
 * Subscription access enforcement and the hourly grace job (step 1.0b).
 *
 * enforceSubscriptionAccess(businessId) is state based and safe to call any number of times:
 *   plan active by policy (storage.isBusinessSubscriptionActive) -> bring back what the system paused
 *   plan inactive                                                  -> pause live products and services
 * The policy itself (7 day grace from past_due_since, canceled active until period end) lives in
 * storage.checkSubscriptionActiveStatus, so visibility, cart, go-live and this all agree.
 *
 * Only paid rows (with a Stripe subscription id) are enforced here. Free plan rows keep their own
 * daily expiry job, which by design never mass-pauses.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { SUBSCRIPTION_GRACE_DAYS, SUBSCRIPTION_REMINDER_DAY, daysPastDue, toDate } from "./policy";
import { loadNoticeContext, sendSubscriptionNotice } from "./notices";
import type { VendorSubscription } from "@shared/schema";

export interface EnforcementResult {
  active: boolean;
  paused: number;
  unpaused: number;
}

export async function enforceSubscriptionAccess(businessId: string, reason: string): Promise<EnforcementResult> {
  const policy = await storage.isBusinessSubscriptionActive(businessId);
  if (policy.active) {
    const r = await storage.unpauseBusinessPausedItems(businessId);
    const unpaused = r.unpausedProducts + r.unpausedServices;
    if (unpaused > 0) {
      console.log(`[Subscription Enforcement] Unpaused ${r.unpausedProducts} products and ${r.unpausedServices} services for business ${businessId} (${reason})`);
      await storage.createAuditLog({
        actorId: "system", actorType: "system", action: "items_auto_unpaused", targetType: "business", targetId: businessId,
        beforeState: { subscriptionStatus: policy.status ?? null },
        afterState: { unpausedProducts: r.unpausedProducts, unpausedServices: r.unpausedServices },
        metadata: { reason },
      }).catch((err: unknown) => console.error("[Subscription Enforcement] audit failed:", err));
    }
    return { active: true, paused: 0, unpaused };
  }
  const r = await storage.pauseBusinessLiveItems(businessId);
  const paused = r.pausedProducts + r.pausedServices;
  if (paused > 0) {
    console.log(`[Subscription Enforcement] Paused ${r.pausedProducts} products and ${r.pausedServices} services for business ${businessId} (${policy.reason ?? reason})`);
    await storage.createAuditLog({
      actorId: "system", actorType: "system", action: "items_auto_paused", targetType: "business", targetId: businessId,
      beforeState: { subscriptionStatus: policy.status ?? null },
      afterState: { pausedProducts: r.pausedProducts, pausedServices: r.pausedServices, reason: policy.reason ?? null },
      metadata: { reason: "subscription_inactive_after_grace_period" },
    }).catch((err: unknown) => console.error("[Subscription Enforcement] audit failed:", err));
  }
  return { active: false, paused, unpaused: 0 };
}

/** Key that identifies one run of failed payments, so its reminder and pause notice go out once. */
export function lateRunRef(pastDueSince: Date): string {
  return pastDueSince.toISOString();
}

/**
 * One pass of the hourly job over every paid row:
 *   day >= REMINDER_DAY of a late run  -> "listings pause soon" (once per run)
 *   plan inactive by policy            -> pause live items, "listings paused" / "plan ended" (once)
 *   plan active again                  -> bring back what the system paused
 */
export async function runSubscriptionGraceJob(now: Date = new Date()): Promise<{ checked: number; reminded: number; paused: number; unpaused: number }> {
  const result = await db.execute(sql`
    SELECT id FROM vendor_subscriptions WHERE stripe_subscription_id IS NOT NULL`);
  const ids = (result.rows as { id: string }[]).map((r) => r.id);
  let reminded = 0, paused = 0, unpaused = 0;
  for (const id of ids) {
    try {
      const [vs] = await db.execute(sql`SELECT * FROM vendor_subscriptions WHERE id = ${id}`).then((r) => r.rows as any[]);
      if (!vs) continue;
      const row = {
        id: vs.id as string, vendorId: vs.vendor_id as string, businessId: vs.business_id as string,
        tierId: vs.tier_id as string, stripeSubscriptionId: (vs.stripe_subscription_id ?? null) as string | null,
        status: (vs.status ?? null) as string | null, pastDueSince: toDate(vs.past_due_since),
        currentPeriodEnd: toDate(vs.current_period_end),
      };
      const enf = await enforceSubscriptionAccess(row.businessId, "grace_job");
      unpaused += enf.unpaused;
      if (row.status === "past_due" && row.pastDueSince) {
        const days = daysPastDue(row.pastDueSince, now);
        if (!enf.active) {
          paused += enf.paused;
          const ctx = await loadNoticeContext(row);
          await sendSubscriptionNotice("paused", lateRunRef(row.pastDueSince), ctx, { pastDueSince: row.pastDueSince, pausedItems: enf.paused });
        } else if (enf.active && days >= SUBSCRIPTION_REMINDER_DAY && days < SUBSCRIPTION_GRACE_DAYS) {
          const ctx = await loadNoticeContext(row);
          if (await sendSubscriptionNotice("grace_reminder", lateRunRef(row.pastDueSince), ctx, { pastDueSince: row.pastDueSince })) reminded++;
        }
      } else if (!enf.active) {
        // Not late but inactive (canceled and past its period, unpaid, incomplete): tell once per subscription.
        paused += enf.paused;
        const ctx = await loadNoticeContext(row);
        await sendSubscriptionNotice("ended", `ended:${row.stripeSubscriptionId}`, ctx, { pausedItems: enf.paused, periodEnd: row.currentPeriodEnd });
      }
    } catch (err) {
      console.error(`[SubscriptionGraceJob] row ${id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked: ids.length, reminded, paused, unpaused };
}

let jobStarted = false;
export function startSubscriptionGraceJob(intervalMs = 60 * 60 * 1000) {
  if (jobStarted) return;
  jobStarted = true;
  const run = () => runSubscriptionGraceJob()
    .then((r) => { if (r.reminded || r.paused || r.unpaused) console.log("[SubscriptionGraceJob]", r); })
    .catch((err) => console.error("[SubscriptionGraceJob] failed:", err));
  setTimeout(run, 60 * 1000);
  setInterval(run, intervalMs);
}

/** Row shape helpers used by the webhook handlers. */
export function pastDueSinceOf(vs: VendorSubscription): Date | null {
  return toDate((vs as any).pastDueSince);
}
