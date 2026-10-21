/**
 * Hidden plan offers (Plan Offers board 1.3 to 1.6, decided by Legend 2026-10-19 and 2026-10-21).
 *
 * An admin offers one business a plan nobody else can pick: Grandfathered ($40.99 a month) or the Free plan
 * (an end date, or permanent). The offer is saved in plan_offers (one pending per business, migration 062).
 * The owner is emailed, pushed (when the app has a token) and gets an in-app notification; the app and
 * goutsyde.com show it from GET /api/vendor/plan-offer until it is accepted or withdrawn.
 *
 * Accepting:
 *   Free:            one statement writes the Free row and accepts the offer. A live paid plan is replaced:
 *                    the Free row is written first (it no longer points at the Stripe subscription), then the
 *                    Stripe subscription is cancelled now with no refund, so Stripe's "subscription ended"
 *                    webhook matches no row and never pauses listings or sends "plan ended".
 *   Grandfathered:   on a live paid plan, the normal paid switch (full new price now, billing date restarts,
 *                    no credit; a Send invoice plan is refused). Otherwise a new subscription: one tap with the
 *                    saved card, falling back to Stripe Checkout when there is no card, the bank wants a
 *                    confirmation, or the charge fails. Over a Free plan with an end date (48 hours or more
 *                    away) billing starts when the Free plan ends (a Stripe trial until then); over a
 *                    permanent Free plan billing starts today and the Free plan ends.
 *
 * Only the business owner (businesses.owner_id) can read or accept the offer. Never uses
 * createTierSubscriptionNative (it creates a Stripe subscription with no row, and its invoice payment_intent
 * expand no longer exists in the Stripe API version the backend uses).
 *
 * Copy rules: real punctuation, no dashes, never the service fee percentage.
 */
import { sql, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { storage } from "../storage";
import { subscriptionTiers, type SubscriptionTier, type VendorSubscription } from "@shared/schema";
import { getUncachableStripeClient } from "../stripe/stripeClient";
import { getSubscriptionPeriod } from "../stripe/subscriptionFields";
import { escapeHtml } from "../adminApplicationDetails";
import { realName } from "../personName";
import { PERMANENT_EXPIRY_ISO, isComplimentaryTier, isTerminalStripeStatus, isoOrNull } from "../complimentary";
import { getComplimentaryTier } from "../services/complimentarySubscription";
import { activatePaidSubscription } from "./activation";
import { enforceSubscriptionAccess } from "./lifecycle";
import { loadNoticeContext, noticeDeps, sendSubscriptionNotice } from "./notices";
import { switchPaidPlan, applySwitchedPlan, SWITCH_DECLINED_MESSAGE } from "./planSwitch";
import { toDate } from "./policy";

export const WEB_BASE_URL = "https://www.goutsyde.com";
export const PLAN_OFFER_URL = `${WEB_BASE_URL}/plan-offer`;
/** Where Stripe Checkout sends the vendor back: FRONTEND_URL like the regular checkout (goutsyde.com in production). */
const frontendBase = () => (process.env.FRONTEND_URL || WEB_BASE_URL).replace(/\/$/, "");
/** Stripe Checkout needs a trial end at least 48 hours away. Closer than that, billing starts now. */
export const MIN_DEFERRED_BILLING_MS = 48 * 60 * 60 * 1000;
const PERMANENT_MS = new Date(PERMANENT_EXPIRY_ISO).getTime();

export type OfferPlan = "grandfathered" | "free";
export type OfferStatus = "pending" | "accepted" | "withdrawn";

export interface PlanOffer {
  id: string;
  businessId: string;
  ownerId: string;
  plan: OfferPlan;
  tierId: string;
  freeExpiresAt: string | null;
  status: OfferStatus;
  createdBy: string;
  createdAt: string | null;
  acceptedAt: string | null;
  withdrawnAt: string | null;
  checkoutSessionId: string | null;
  notifiedAt: string | null;
}

export interface ServiceResult {
  status: number;
  body: Record<string, unknown>;
}

function mapOffer(r: Record<string, unknown>): PlanOffer {
  return {
    id: String(r.id),
    businessId: String(r.business_id),
    ownerId: String(r.owner_id),
    plan: r.plan as OfferPlan,
    tierId: String(r.tier_id),
    freeExpiresAt: isoOrNull(r.free_expires_at),
    status: r.status as OfferStatus,
    createdBy: String(r.created_by),
    createdAt: isoOrNull(r.created_at),
    acceptedAt: isoOrNull(r.accepted_at),
    withdrawnAt: isoOrNull(r.withdrawn_at),
    checkoutSessionId: (r.checkout_session_id as string | null) ?? null,
    notifiedAt: isoOrNull(r.notified_at),
  };
}

const err = (status: number, code: string, message: string): ServiceResult => ({ status, body: { success: false, error: { code, message } } });

/* ───────────────────────────── Tiers ───────────────────────────── */

/** The Grandfathered tier, by name, with a Stripe price (never shown in public lists: sort_order -1). */
export async function getGrandfatheredTier(): Promise<SubscriptionTier | null> {
  const [tier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.name, "grandfathered"));
  return tier && tier.stripePriceId && tier.isActive !== false ? tier : null;
}

async function getTier(tierId: string): Promise<SubscriptionTier | null> {
  const [tier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, tierId));
  return tier ?? null;
}

/* ───────────────────────────── Reading offers ───────────────────────────── */

export async function getPendingOfferForBusiness(businessId: string): Promise<PlanOffer | null> {
  const r = await db.execute(sql`SELECT * FROM plan_offers WHERE business_id = ${businessId} AND status = 'pending' LIMIT 1`);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  return row ? mapOffer(row) : null;
}

export interface AdminOfferSummary {
  id: string;
  plan: OfferPlan;
  status: OfferStatus;
  freeExpiresAt: string | null;
  permanent: boolean;
  createdAt: string | null;
  acceptedAt: string | null;
  withdrawnAt: string | null;
}

export function toAdminSummary(o: PlanOffer): AdminOfferSummary {
  return {
    id: o.id,
    plan: o.plan,
    status: o.status,
    freeExpiresAt: o.freeExpiresAt,
    permanent: o.plan === "free" && o.freeExpiresAt == null,
    createdAt: o.createdAt,
    acceptedAt: o.acceptedAt,
    withdrawnAt: o.withdrawnAt,
  };
}

/** GET /api/admin/businesses: the latest offer per business (additive `planOffer`), one query. */
export async function getLatestOfferSummaries(businessIds: string[]): Promise<Map<string, AdminOfferSummary>> {
  const out = new Map<string, AdminOfferSummary>();
  if (businessIds.length === 0) return out;
  const r = await db.execute(sql`
    SELECT DISTINCT ON (business_id) * FROM plan_offers
     WHERE business_id IN (${sql.join(businessIds.map((id) => sql`${id}`), sql`, `)})
     ORDER BY business_id, created_at DESC`);
  for (const row of r.rows as Record<string, unknown>[]) {
    const o = mapOffer(row);
    out.set(o.businessId, toAdminSummary(o));
  }
  return out;
}

/* ───────────────────────────── What accepting will do ───────────────────────────── */

export type AcceptOutcome =
  | "start_free"              // no plan (or a lapsed one): the Free plan starts now
  | "replace_paid_with_free"  // a live paid plan is cancelled now (no refund) and the Free plan starts now
  | "start_paid"              // no live plan: Grandfathered starts now, charged today
  | "switch_paid"             // a live paid plan switches now: full new price today, billing date restarts
  | "start_paid_after_free"   // a Free plan with an end date: billing starts when it ends
  | "replace_free_with_paid"  // a permanent Free plan: billing starts today and the Free plan ends
  | "invoice_billed"          // a live Send invoice plan: can't be switched here
  | "paid_plan_late"          // the current paid plan is late: pay it first (no second charge for the same time)
  | "already_on_plan";

interface PlanState {
  row: VendorSubscription | null;
  rowTier: SubscriptionTier | null;
  paidLive: boolean;
  freeLive: boolean;
  freeEndsAt: Date | null;
}

async function loadPlanState(businessId: string, now: Date): Promise<PlanState> {
  const row = (await storage.getVendorSubscriptionByBusinessId(businessId)) ?? null;
  const rowTier = row ? await getTier(row.tierId) : null;
  const status = row?.status ?? "";
  const end = toDate(row?.currentPeriodEnd ?? null);
  const paidLive = !!row?.stripeSubscriptionId && (status === "active" || status === "trialing" || status === "past_due");
  const freeLive = !!row && !row.stripeSubscriptionId && isComplimentaryTier(rowTier) && status === "active" && !!end && end.getTime() >= now.getTime();
  return { row, rowTier, paidLive, freeLive, freeEndsAt: freeLive ? end : null };
}

/** When billing should start for Grandfathered over a dated Free plan, or null to charge now. Pure. */
export function deferredBillingStart(freeEndsAt: Date | null, now: Date = new Date()): Date | null {
  if (!freeEndsAt) return null;
  const t = freeEndsAt.getTime();
  if (t >= PERMANENT_MS - 24 * 60 * 60 * 1000) return null; // permanent: billing starts today (Legend 2026-10-21)
  if (t - now.getTime() < MIN_DEFERRED_BILLING_MS) return null;
  return freeEndsAt;
}

async function acceptOutcome(offer: PlanOffer, state: PlanState, now: Date): Promise<{ outcome: AcceptOutcome; billingStartsAt: Date | null }> {
  if (state.row && state.row.tierId === offer.tierId && (await storage.isBusinessSubscriptionActive(offer.businessId)).active) {
    return { outcome: "already_on_plan", billingStartsAt: null };
  }
  if (offer.plan === "free") return { outcome: state.paidLive ? "replace_paid_with_free" : "start_free", billingStartsAt: null };
  if (state.paidLive) {
    try {
      const stripe = await getUncachableStripeClient();
      const sub: any = await stripe.subscriptions.retrieve(state.row!.stripeSubscriptionId!);
      if (sub?.collection_method && sub.collection_method !== "charge_automatically") return { outcome: "invoice_billed", billingStartsAt: null };
    } catch {
      // the switch itself reports a Stripe problem
    }
    // A late plan has an open invoice for the same time: starting Grandfathered now could charge twice.
    if (state.row?.status === "past_due") return { outcome: "paid_plan_late", billingStartsAt: null };
    return { outcome: "switch_paid", billingStartsAt: null };
  }
  if (state.freeLive) {
    const start = deferredBillingStart(state.freeEndsAt, now);
    return start ? { outcome: "start_paid_after_free", billingStartsAt: start } : { outcome: "replace_free_with_paid", billingStartsAt: null };
  }
  return { outcome: "start_paid", billingStartsAt: null };
}

/* ───────────────────────────── Saved card ───────────────────────────── */

export interface SavedCard { id: string; brand: string | null; last4: string | null }

/** The customer's default card, else the most recent card on the customer. Any Stripe error: no card. */
export async function findSavedCard(customerId: string | null | undefined): Promise<SavedCard | null> {
  if (!customerId) return null;
  try {
    const stripe = await getUncachableStripeClient();
    const customer: any = await stripe.customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method"] });
    if (!customer || customer.deleted) return null;
    const def = customer.invoice_settings?.default_payment_method;
    if (def && typeof def === "object" && def.type === "card") {
      return { id: def.id, brand: def.card?.brand ?? null, last4: def.card?.last4 ?? null };
    }
    const list: any = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
    const pm = list?.data?.[0];
    return pm ? { id: pm.id, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null } : null;
  } catch (e) {
    console.error(`[PlanOffer] could not read saved cards for ${customerId}:`, e instanceof Error ? e.message : "unknown error");
    return null;
  }
}

/* ───────────────────────────── Admin: offer, withdraw ───────────────────────────── */

const offerBodySchema = z.union([
  z.object({ plan: z.literal("grandfathered") }).strict(),
  z.object({ plan: z.literal("free"), expiresAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({ plan: z.literal("free"), permanent: z.literal(true) }).strict(),
]);

/** POST /api/admin/businesses/:id/plan-offer (caller passed requireAdmin). */
export async function createPlanOffer(p: { businessId: string; adminId: string; body: unknown; now?: Date }): Promise<ServiceResult> {
  const now = p.now ?? new Date();
  const parsed = offerBodySchema.safeParse(p.body);
  if (!parsed.success) return err(400, "INVALID_INPUT", "Send plan grandfathered, or plan free with expiresAt or permanent true.");
  const body = parsed.data;

  const business = await storage.getBusiness(p.businessId);
  if (!business) return err(404, "NOT_FOUND", "Business not found.");
  const owner = business.ownerId ? await storage.getUser(business.ownerId) : undefined;
  if (!owner) return err(400, "NO_OWNER", "This business has no owner account to send the offer to.");

  let tier: SubscriptionTier | null;
  let freeExpiresAt: Date | null = null;
  if (body.plan === "grandfathered") {
    tier = await getGrandfatheredTier();
    if (!tier) return err(500, "TIER_MISSING", "The Grandfathered plan isn't set up.");
  } else {
    tier = await getComplimentaryTier();
    if (!tier) return err(500, "TIER_MISSING", "The Free plan isn't set up.");
    if ("expiresAt" in body) {
      freeExpiresAt = new Date(body.expiresAt);
      if (freeExpiresAt.getTime() <= now.getTime()) return err(400, "INVALID_INPUT", "The Free plan end date must be in the future.");
    }
  }

  const state = await loadPlanState(business.id, now);
  if (state.row && state.row.tierId === tier.id && (await storage.isBusinessSubscriptionActive(business.id)).active) {
    return err(409, "ALREADY_ON_PLAN", body.plan === "free"
      ? "This business is already on the Free plan. Use Extend to change its end date."
      : "This business is already on the Grandfathered plan.");
  }

  let offer: PlanOffer;
  try {
    const r = await db.execute(sql`
      INSERT INTO plan_offers (business_id, owner_id, plan, tier_id, free_expires_at, created_by)
      VALUES (${business.id}, ${owner.id}, ${body.plan}, ${tier.id}, ${freeExpiresAt ? freeExpiresAt.toISOString() : null}::timestamptz AT TIME ZONE 'UTC', ${p.adminId})
      RETURNING *`);
    offer = mapOffer(r.rows[0] as Record<string, unknown>);
  } catch (e: any) {
    const code = e?.code ?? e?.cause?.code;
    if (code === "23505" || /uq_plan_offers_one_pending|duplicate key/i.test(String(e?.message ?? ""))) {
      return err(409, "OFFER_PENDING", "This business already has an offer waiting. Withdraw it first.");
    }
    throw e;
  }

  await storage.createAuditLog({
    actorId: p.adminId, actorType: "admin", action: "plan_offer.create", targetType: "business", targetId: business.id,
    beforeState: null as any, afterState: toAdminSummary(offer) as any, metadata: { offerId: offer.id },
  } as any).catch((e: unknown) => console.error("[PlanOffer] audit failed:", e));

  const sent = await notifyOwnerOfOffer(offer, { businessName: business.name, ownerId: owner.id, ownerEmail: owner.email ?? null, ownerFirstName: owner.firstName ?? null, tier });
  if (sent) {
    await db.execute(sql`UPDATE plan_offers SET notified_at = now() WHERE id = ${offer.id}`);
    offer = { ...offer, notifiedAt: new Date().toISOString() };
  }
  return { status: 201, body: { success: true, offer: toAdminSummary(offer), notified: sent } };
}

/** DELETE /api/admin/businesses/:id/plan-offer: withdraw the pending offer, close its open checkout. */
export async function withdrawPlanOffer(p: { businessId: string; adminId: string }): Promise<ServiceResult> {
  const r = await db.execute(sql`
    UPDATE plan_offers SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = ${p.adminId}
     WHERE business_id = ${p.businessId} AND status = 'pending'
    RETURNING *`);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return err(404, "NO_PENDING_OFFER", "This business has no offer waiting.");
  const offer = mapOffer(row);
  if (offer.checkoutSessionId) {
    try {
      const stripe = await getUncachableStripeClient();
      const session: any = await stripe.checkout.sessions.retrieve(offer.checkoutSessionId);
      if (session?.status === "open") await stripe.checkout.sessions.expire(offer.checkoutSessionId);
    } catch (e) {
      // A payment that already completed is honored (decided 2026-10-19); nothing else to undo.
      console.error(`[PlanOffer] could not expire checkout for offer ${offer.id}:`, e instanceof Error ? e.message : "unknown error");
    }
  }
  await storage.createAuditLog({
    actorId: p.adminId, actorType: "admin", action: "plan_offer.withdraw", targetType: "business", targetId: p.businessId,
    beforeState: null as any, afterState: toAdminSummary(offer) as any, metadata: { offerId: offer.id },
  } as any).catch((e: unknown) => console.error("[PlanOffer] audit failed:", e));
  return { status: 200, body: { success: true, offer: toAdminSummary(offer) } };
}

/* ───────────────────────────── Owner: read ───────────────────────────── */

/** GET /api/vendor/plan-offer: the owner's pending offer with everything the popup and confirm page show. */
export async function getOwnerPlanOffer(userId: string, now: Date = new Date()): Promise<ServiceResult> {
  const business = await storage.getBusinessByOwnerId(userId);
  if (!business) return { status: 200, body: { success: true, offer: null } };
  const offer = await getPendingOfferForBusiness(business.id);
  // Ownership is the business's current owner (the same rule accept uses), not who owned it when offered.
  if (!offer) return { status: 200, body: { success: true, offer: null } };

  const tier = await getTier(offer.tierId);
  const user = await storage.getUser(userId);
  const state = await loadPlanState(business.id, now);
  const { outcome, billingStartsAt } = await acceptOutcome(offer, state, now);
  const savedCard = offer.plan === "grandfathered" ? await findSavedCard(user?.stripeCustomerId) : null;

  return {
    status: 200,
    body: {
      success: true,
      offer: {
        id: offer.id,
        plan: offer.plan,
        tierId: offer.tierId,
        planName: tier?.displayName || tier?.name || (offer.plan === "free" ? "Free plan" : "Grandfathered"),
        priceInCents: offer.plan === "free" ? 0 : tier?.priceInCents ?? null,
        maxStaff: tier?.maxStaff ?? null,
        freeExpiresAt: offer.freeExpiresAt,
        permanent: offer.plan === "free" && offer.freeExpiresAt == null,
        createdAt: offer.createdAt,
        businessId: business.id,
        businessName: (business.name ?? "").trim(),
        username: user?.username ?? null,
        outcome,
        dueTodayCents: offer.plan === "free" || outcome === "start_paid_after_free" ? 0 : tier?.priceInCents ?? null,
        billingStartsAt: billingStartsAt ? billingStartsAt.toISOString() : null,
        currentPlanName: state.rowTier ? state.rowTier.displayName || state.rowTier.name : null,
        savedCard: savedCard ? { brand: savedCard.brand, last4: savedCard.last4 } : null,
      },
    },
  };
}

/* ───────────────────────────── Owner: accept ───────────────────────────── */

const acceptBodySchema = z.object({
  offerId: z.string().min(1),
  /** true = skip the saved card and go straight to Stripe Checkout ("Change" on the confirm page). */
  useCheckout: z.boolean().optional(),
}).strict();

async function loadOwnedPendingOffer(userId: string, offerId: string): Promise<{ offer: PlanOffer; businessId: string } | ServiceResult> {
  const r = await db.execute(sql`
    SELECT o.* FROM plan_offers o JOIN businesses b ON b.id = o.business_id
     WHERE o.id = ${offerId} AND b.owner_id = ${userId}`);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return err(404, "OFFER_NOT_FOUND", "This offer isn't available for your account.");
  const offer = mapOffer(row);
  if (offer.status !== "pending") {
    return err(409, "OFFER_NOT_AVAILABLE", offer.status === "accepted" ? "You already accepted this offer." : "This offer is no longer available.");
  }
  return { offer, businessId: offer.businessId };
}

/** POST /api/vendor/plan-offer/accept */
export async function acceptPlanOffer(p: { userId: string; body: unknown; ip?: string | null; userAgent?: string | null; now?: Date }): Promise<ServiceResult> {
  const parsed = acceptBodySchema.safeParse(p.body);
  if (!parsed.success) return err(400, "INVALID_INPUT", "offerId is required.");
  const loaded = await loadOwnedPendingOffer(p.userId, parsed.data.offerId);
  if ("status" in loaded) return loaded;
  const { offer } = loaded;
  // One accept at a time per offer (a double tap must never start two payments). One Render instance today;
  // the Stripe idempotency key and the offer's single open checkout cover the rest.
  if (acceptInFlight.has(offer.id)) return err(409, "OFFER_BUSY", "Your plan is already being set up. Give it a moment.");
  acceptInFlight.add(offer.id);
  try {
    return offer.plan === "free"
      ? await acceptFreeOffer(offer, p)
      : await acceptGrandfatheredOffer(offer, { ...p, useCheckout: parsed.data.useCheckout === true });
  } finally {
    acceptInFlight.delete(offer.id);
  }
}

const acceptInFlight = new Set<string>();

/** An offer accepted any other way must not leave a payable Checkout behind (review 2026-10-21). */
async function expireOfferCheckout(offer: PlanOffer): Promise<void> {
  if (!offer.checkoutSessionId) return;
  try {
    const stripe = await getUncachableStripeClient();
    const session: any = await stripe.checkout.sessions.retrieve(offer.checkoutSessionId);
    if (session?.status === "open") await stripe.checkout.sessions.expire(offer.checkoutSessionId);
  } catch (e) {
    console.error(`[PlanOffer] could not expire checkout for offer ${offer.id}:`, e instanceof Error ? e.message : "unknown error");
  }
}

/** Free: ONE statement accepts the offer and writes the Free row (also over a paid row). */
export function buildAcceptFreeStatement(p: { offerId: string; userId: string; ip: string | null; userAgent: string | null }) {
  return sql`
    WITH off AS (
      UPDATE plan_offers o SET status = 'accepted', accepted_at = now() AT TIME ZONE 'UTC'
       WHERE o.id = ${p.offerId} AND o.status = 'pending' AND o.plan = 'free'
         AND (o.free_expires_at IS NULL OR o.free_expires_at > (now() AT TIME ZONE 'UTC'))
         AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = o.business_id AND b.owner_id = ${p.userId}::varchar)
      RETURNING o.id, o.business_id, o.tier_id, o.free_expires_at
    ),
    prev AS (
      SELECT vs.* FROM vendor_subscriptions vs JOIN off ON vs.business_id = off.business_id
    ),
    up AS (
      INSERT INTO vendor_subscriptions
        (vendor_id, business_id, tier_id, status, current_period_start, current_period_end,
         current_quarter_start, current_quarter_end, stripe_subscription_id, stripe_customer_id,
         created_at, updated_at)
      SELECT ${p.userId}::varchar, off.business_id, off.tier_id, 'active',
             now() AT TIME ZONE 'UTC',
             COALESCE(off.free_expires_at, (${PERMANENT_EXPIRY_ISO}::timestamptz AT TIME ZONE 'UTC')),
             NULL, NULL, NULL, NULL, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
        FROM off
      ON CONFLICT (business_id) DO UPDATE SET
        vendor_id = EXCLUDED.vendor_id,
        tier_id = EXCLUDED.tier_id,
        status = 'active',
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        current_quarter_start = NULL,
        current_quarter_end = NULL,
        stripe_subscription_id = NULL,
        stripe_customer_id = NULL,
        past_due_since = NULL,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    ),
    biz AS (
      UPDATE businesses SET subscription_active = true WHERE id IN (SELECT business_id FROM up) RETURNING id
    ),
    aud AS (
      INSERT INTO audit_logs
        (actor_id, actor_type, action, target_type, target_id, before_state, after_state, metadata, ip_address, user_agent)
      SELECT ${p.userId}::text, 'vendor', 'plan_offer.accept_free', 'vendor_subscription', up.id,
             (SELECT to_jsonb(prev) FROM prev LIMIT 1), to_jsonb(up),
             jsonb_build_object('businessId', up.business_id, 'offerId', off.id,
                                'permanent', (off.free_expires_at IS NULL),
                                'replacedStripeSubscriptionId', (SELECT stripe_subscription_id FROM prev LIMIT 1)),
             ${p.ip}::text, ${p.userAgent}::text
        FROM up CROSS JOIN off RETURNING id
    )
    SELECT up.id, up.vendor_id, up.business_id, up.tier_id, up.current_period_end,
           (SELECT stripe_subscription_id FROM prev LIMIT 1) AS replaced_stripe_subscription_id,
           (SELECT count(*) FROM aud) AS aud_written
      FROM up`;
}

async function acceptFreeOffer(offer: PlanOffer, p: { userId: string; ip?: string | null; userAgent?: string | null }): Promise<ServiceResult> {
  const r = await db.execute(buildAcceptFreeStatement({ offerId: offer.id, userId: p.userId, ip: p.ip ?? null, userAgent: p.userAgent ?? null }));
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return err(409, "OFFER_NOT_AVAILABLE", "This offer is no longer available.");

  // The Free row no longer points at the old Stripe subscription, so cancel it now: no refund (Legend).
  const replaced = (row.replaced_stripe_subscription_id as string | null) ?? null;
  if (replaced) {
    try {
      const stripe = await getUncachableStripeClient();
      const old: any = await stripe.subscriptions.retrieve(replaced);
      if (!isTerminalStripeStatus(old?.status)) {
        await stripe.subscriptions.cancel(replaced, { invoice_now: false, prorate: false } as any);
        console.log(`[PlanOffer] Free offer accepted: cancelled paid subscription ${replaced} for business ${offer.businessId}`);
      }
    } catch (e) {
      console.error(`[PlanOffer] could not cancel ${replaced} after a Free offer was accepted:`, e instanceof Error ? e.message : "unknown error");
      await alertOutsyde(`Cancel ${replaced} in Stripe`, `A Free plan offer was accepted for business ${offer.businessId}, but the old paid Stripe subscription ${replaced} could not be cancelled. Cancel it in Stripe so the business isn't billed again.`);
    }
  }

  await enforceSubscriptionAccess(offer.businessId, "free_offer_accepted");

  const vs = await storage.getVendorSubscriptionByBusinessId(offer.businessId);
  if (vs) {
    const ctx = await loadNoticeContext(vs);
    await sendSubscriptionNotice("free_started", `offer:${offer.id}`, ctx, {
      freeEndsAt: offer.freeExpiresAt ? new Date(offer.freeExpiresAt) : null,
      permanent: offer.freeExpiresAt == null,
    });
  }
  return { status: 200, body: { success: true, accepted: true, plan: "free", freeExpiresAt: offer.freeExpiresAt, permanent: offer.freeExpiresAt == null } };
}

export const PLAN_LATE_MESSAGE =
  "Your current plan payment is late. Pay it from Manage Plan first, then come back to accept this plan.";

/** This offer's one tap subscription on the customer, if Stripe made one (for a lost answer). */
async function findOfferSubscription(customerId: string, offerId: string): Promise<any | null> {
  try {
    const stripe = await getUncachableStripeClient();
    const list: any = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 } as any);
    return (list?.data ?? []).find((s: any) => s?.metadata?.offerId === offerId && s?.metadata?.source === "plan_offer_one_tap" && s.status !== "canceled" && s.status !== "incomplete_expired") ?? null;
  } catch (e) {
    console.error(`[PlanOffer] could not list subscriptions for ${customerId}:`, e instanceof Error ? e.message : "unknown error");
    return null;
  }
}

async function ensureStripeCustomer(userId: string): Promise<string> {
  const user = await storage.getUser(userId);
  if (!user) throw new Error("user not found");
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const { stripeService } = await import("../stripe/stripeService");
  const customer = await stripeService.createCustomer(user.email!, userId, realName(user) || user.email!);
  await storage.updateUser(userId, { stripeCustomerId: customer.id });
  return customer.id;
}

async function acceptGrandfatheredOffer(
  offer: PlanOffer,
  p: { userId: string; useCheckout: boolean; now?: Date },
): Promise<ServiceResult> {
  const now = p.now ?? new Date();
  const tier = await getTier(offer.tierId);
  if (!tier?.stripePriceId) return err(500, "TIER_MISSING", "The Grandfathered plan isn't set up.");
  const state = await loadPlanState(offer.businessId, now);
  const { outcome, billingStartsAt } = await acceptOutcome(offer, state, now);

  if (outcome === "already_on_plan") {
    await db.execute(sql`UPDATE plan_offers SET status = 'accepted', accepted_at = now() WHERE id = ${offer.id} AND status = 'pending'`);
    await expireOfferCheckout(offer);
    return { status: 200, body: { success: true, accepted: true, plan: "grandfathered" } };
  }
  if (outcome === "invoice_billed") {
    const { INVOICE_BILLED_MESSAGE } = await import("./planSwitch");
    return err(400, "NOT_SWITCHABLE", INVOICE_BILLED_MESSAGE);
  }
  if (outcome === "paid_plan_late") {
    return err(409, "PLAN_LATE", PLAN_LATE_MESSAGE);
  }

  // A live paid plan: the normal paid switch (full new price now, billing date restarts, no credit).
  if (outcome === "switch_paid") {
    const stripe = await getUncachableStripeClient();
    const sw = await switchPaidPlan(stripe, state.row!.stripeSubscriptionId!, tier.stripePriceId);
    if (sw.kind === "not_switchable") return err(400, "NOT_SWITCHABLE", sw.message);
    if (sw.kind === "pending") {
      // The bank wants a confirmation or the card was declined: the old plan stays. When the vendor pays on
      // the Stripe page, the webhook applies the switch and marks the offer accepted.
      if (sw.url) return { status: 200, body: { success: true, pendingPayment: true, url: sw.url } };
      return err(402, "PAYMENT_FAILED", SWITCH_DECLINED_MESSAGE);
    }
    await applySwitchedPlan(state.row!, tier, sw);
    await db.execute(sql`UPDATE plan_offers SET status = 'accepted', accepted_at = now() WHERE id = ${offer.id} AND status = 'pending'`);
    await expireOfferCheckout(offer);
    return { status: 200, body: { success: true, accepted: true, plan: "grandfathered" } };
  }

  // A new subscription: now, or after a dated Free plan ends.
  const customerId = await ensureStripeCustomer(p.userId);
  const trialEnd = billingStartsAt ? Math.floor(billingStartsAt.getTime() / 1000) : null;
  const metadata = { type: "vendor_subscription", vendorId: p.userId, businessId: offer.businessId, tierId: tier.id, offerId: offer.id };
  // Marks a one tap subscription so the webhook can activate it if this request never saves the row.
  const oneTapMetadata = { ...metadata, source: "plan_offer_one_tap" };
  const stripe = await getUncachableStripeClient();

  const card = p.useCheckout ? null : await findSavedCard(customerId);
  if (card) {
    let sub: any = null;
    try {
      // On session (the vendor is tapping): a bank that wants a confirmation leaves it incomplete and we use Checkout.
      sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: tier.stripePriceId }],
        default_payment_method: card.id,
        payment_behavior: "allow_incomplete",
        ...(trialEnd ? { trial_end: trialEnd } : {}),
        metadata: oneTapMetadata,
        expand: ["latest_invoice"],
      } as any, { idempotencyKey: `plan-offer-${offer.id}-${card.id}-${trialEnd ?? "now"}-${Math.floor(Date.now() / (10 * 60 * 1000))}` });
    } catch (e: any) {
      console.error(`[PlanOffer] one tap charge failed for offer ${offer.id}:`, e instanceof Error ? e.message : "unknown error");
      if (e?.statusCode === 409 || e?.type === "StripeIdempotencyError") {
        return err(409, "OFFER_BUSY", "Your plan is already being set up. Give it a moment.");
      }
      // The charge may have gone through with the answer lost: find this offer's subscription before anything else.
      sub = await findOfferSubscription(customerId, offer.id);
    }
    if (sub && (sub.status === "active" || sub.status === "trialing")) {
      const invoice = sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
      await activatePaidSubscription({
        vendorId: p.userId,
        businessId: offer.businessId,
        tierId: tier.id,
        stripeSubscriptionId: sub.id,
        stripeCustomerId: customerId,
        ref: `subscription:${sub.id}`,
        amountCents: typeof invoice?.amount_paid === "number" ? invoice.amount_paid : null,
        stripeSubscription: sub,
      });
      await expireOfferCheckout(offer);
      const period = getSubscriptionPeriod(sub);
      return {
        status: 200,
        body: {
          success: true,
          accepted: true,
          plan: "grandfathered",
          status: sub.status,
          billingStartsAt: billingStartsAt ? billingStartsAt.toISOString() : null,
          renewsAt: period?.end ? period.end.toISOString() : null,
        },
      };
    }
    // Declined, or the bank wants a confirmation: drop the unpaid subscription and use Checkout instead.
    if (sub?.id) {
      try { await stripe.subscriptions.cancel(sub.id); } catch (e) {
        console.error(`[PlanOffer] could not cancel incomplete ${sub.id}:`, e instanceof Error ? e.message : "unknown error");
      }
    }
  }

  // Stripe Checkout. Reuse this offer's open session so two taps never make two payments.
  if (offer.checkoutSessionId) {
    try {
      const open: any = await stripe.checkout.sessions.retrieve(offer.checkoutSessionId);
      if (open?.status === "open" && open.url) return { status: 200, body: { success: true, checkoutUrl: open.url } };
    } catch {
      // make a new one
    }
  }
  const session: any = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: tier.stripePriceId, quantity: 1 }],
    success_url: `${frontendBase()}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendBase()}/plan-offer`,
    metadata,
    subscription_data: { metadata: { vendorId: p.userId, businessId: offer.businessId, tierId: tier.id, offerId: offer.id }, ...(trialEnd ? { trial_end: trialEnd } : {}) },
  } as any);
  await db.execute(sql`UPDATE plan_offers SET checkout_session_id = ${session.id} WHERE id = ${offer.id}`);
  return { status: 200, body: { success: true, checkoutUrl: session.url } };
}

/* ───────────────────────────── Reconcile (success page) ───────────────────────────── */

/**
 * POST /api/vendor/subscription/reconcile { sessionId }: the success page asks the backend to check Stripe and
 * activate now if the webhook hasn't landed yet (or crashed: it runs after Stripe gets its 200 and is never
 * retried). Only the vendor who started the checkout can reconcile it.
 */
export async function reconcileCheckoutSession(p: { userId: string; body: unknown }): Promise<ServiceResult> {
  const parsed = z.object({ sessionId: z.string().regex(/^cs_[A-Za-z0-9_]+$/) }).strict().safeParse(p.body);
  if (!parsed.success) return err(400, "INVALID_INPUT", "sessionId is required.");
  const stripe = await getUncachableStripeClient();
  let session: any;
  try {
    session = await stripe.checkout.sessions.retrieve(parsed.data.sessionId);
  } catch {
    return err(404, "NOT_FOUND", "Checkout not found.");
  }
  const md = session?.metadata ?? {};
  const business = await storage.getBusinessByOwnerId(p.userId);
  if (md.type !== "vendor_subscription" || md.vendorId !== p.userId || !business || md.businessId !== business.id) {
    return err(404, "NOT_FOUND", "Checkout not found.");
  }
  if (session.status === "complete" && session.subscription) {
    const row = await storage.getVendorSubscriptionByBusinessId(business.id);
    const alreadyLinked = row?.stripeSubscriptionId === session.subscription && (row?.status === "active" || row?.status === "trialing");
    // Only a checkout the row doesn't reflect yet is applied, and only while its subscription is paid up
    // (activation refuses past_due, unpaid and canceled ones), so an old session can never bring access back.
    if (!alreadyLinked) {
      const { WebhookHandlers } = await import("../stripe/webhookHandlers");
      await WebhookHandlers.handleVendorSubscriptionCheckoutCompleted(session, { strict: true });
    }
  }
  const policy = await storage.isBusinessSubscriptionActive(business.id);
  return { status: 200, body: { success: true, checkoutStatus: session.status ?? null, active: policy.active, subscriptionStatus: policy.status ?? null } };
}

/* ───────────────────────────── Notifying the owner ───────────────────────────── */

const money = (c?: number | null) => (typeof c === "number" ? `$${(c / 100).toFixed(2)}` : null);
const longDay = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });

export interface OfferCopy {
  subject: string;
  heading: string;
  lead: string;
  body: string;
  cta: { label: string; url: string };
  push: { title: string; body: string };
  inApp: { title: string; message: string };
}

/** The offer email, push and in-app text. Pure, for tests. No dashes, never the fee percentage. */
export function offerCopy(p: { plan: OfferPlan; businessName: string; firstName: string | null; priceInCents: number | null; freeExpiresAt: Date | null }): OfferCopy {
  const biz = p.businessName.trim() || "your business";
  if (p.plan === "grandfathered") {
    const price = money(p.priceInCents) ?? "$40.99";
    return {
      subject: "Your Grandfathered plan is ready",
      heading: p.firstName ? `Hi ${p.firstName}, your founding price is saved` : "Your founding price is saved",
      lead: `We reserved the Grandfathered plan for ${biz}.`,
      body: `It's ${price} a month, includes everything in the app, and your price stays locked as long as you keep it. New businesses can't get this plan. You'll sign in with your Outsyde account if you aren't already, then confirm your plan in one step. You'll also see the offer the next time you open the Outsyde app.`,
      cta: { label: "Review and accept", url: PLAN_OFFER_URL },
      push: { title: "Your Grandfathered plan is ready", body: `${price} a month, reserved for ${biz}. Tap to review.` },
      inApp: { title: "Your Grandfathered plan is ready", message: `We reserved the Grandfathered plan for ${biz} at ${price} a month. Open it to review and accept.` },
    };
  }
  const until = p.freeExpiresAt ? `until ${longDay(p.freeExpiresAt)}` : "with no end date";
  return {
    subject: "You won a free Outsyde plan",
    heading: p.firstName ? `Congrats, ${p.firstName}, your plan is on us` : "Congrats, your plan is on us",
    lead: `Outsyde is covering the subscription for ${biz}.`,
    body: `Your free plan runs ${until}. You get Growth plan features, and there's no card to add. You'll sign in with your Outsyde account if you aren't already, and the plan turns on with one tap. You'll also see the offer the next time you open the Outsyde app.`,
    cta: { label: "Claim free plan", url: PLAN_OFFER_URL },
    push: { title: "You won a free Outsyde plan", body: `Outsyde is covering ${biz}'s plan. Tap to claim it.` },
    inApp: { title: "You won a free Outsyde plan", message: `Outsyde is covering ${biz}'s plan ${until}. Open it to claim.` },
  };
}

async function notifyOwnerOfOffer(
  offer: PlanOffer,
  who: { businessName: string; ownerId: string; ownerEmail: string | null; ownerFirstName: string | null; tier: SubscriptionTier },
): Promise<boolean> {
  const copy = offerCopy({
    plan: offer.plan,
    businessName: who.businessName,
    firstName: who.ownerFirstName,
    priceInCents: who.tier.priceInCents ?? null,
    freeExpiresAt: offer.freeExpiresAt ? new Date(offer.freeExpiresAt) : null,
  });
  const d = await noticeDeps();
  let any = false;
  if (who.ownerEmail) {
    try {
      const e = await import("../emailService");
      const html = e.wrapEmail(`
        ${e.emailHeader(escapeHtml(copy.heading), escapeHtml(copy.lead))}
        <tr><td style="background:#1A1A1A;padding:8px 32px 4px;">
          <p style="color:#F5F0E8;font-size:14px;line-height:1.6;margin:0;">${escapeHtml(copy.body)}</p>
        </td></tr>
        ${e.emailCta(escapeHtml(copy.cta.label), escapeHtml(copy.cta.url))}
        ${e.emailFooter()}
      `);
      if (await d.sendEmail({ to: who.ownerEmail, subject: copy.subject, html, log: { kind: "subscription", label: "Plan offer (vendor)" } })) any = true;
    } catch (e) { console.error("[PlanOffer] offer email failed:", e); }
  }
  try {
    if (await d.sendPush({ userId: who.ownerId, title: copy.push.title, body: copy.push.body, data: { type: "plan_offer", offerId: offer.id, screen: "plan_offer" } })) any = true;
  } catch (e) { console.error("[PlanOffer] offer push failed:", e); }
  try {
    await d.createInApp({ userId: who.ownerId, type: "plan_offer", title: copy.inApp.title, message: copy.inApp.message, referenceId: offer.id, metadata: { offerId: offer.id, plan: offer.plan } });
    any = true;
  } catch (e) { console.error("[PlanOffer] offer in-app failed:", e); }
  return any;
}

async function alertOutsyde(subject: string, text: string): Promise<void> {
  try {
    const d = await noticeDeps();
    const e = await import("../emailService");
    await d.sendEmail({
      to: d.adminEmail,
      subject: `[Subscription] Action needed: ${subject}`,
      html: e.wrapEmail(`${e.emailHeader("Action needed", "Subscription update")}<tr><td style="background:#1A1A1A;padding:8px 32px 16px;"><p style="color:#F5F0E8;font-size:14px;line-height:1.6;margin:0;">${escapeHtml(text)}</p></td></tr>${e.emailFooter()}`),
    });
  } catch (e) { console.error("[PlanOffer] admin alert failed:", e); }
}
