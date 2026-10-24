/**
 * Business referral cash (referral program Step 4, rules by Legend 2026-10-23/24).
 *
 * Anyone with an Outsyde account who refers a BUSINESS earns $25 cash (photographers don't count). Everyone shares
 * one code (users.referral_code): a customer signup with it is a friend referral (points, loyaltyLedger.ts), a
 * business signup with it is a business referral (cash, here).
 *
 *   1. applyBusinessReferralAtSignup: business signup with a code -> one business_referrals row ('pending'),
 *      expires 90 days after the business was created. Never fails the signup.
 *   2. checkBusinessReferral: called (fire and forget) whenever one of the facts can change, plus an hourly sweep.
 *      Qualifies when ALL hold, before it expires:
 *        approved, not demo, owner active; account setup complete (getAccountSetupStatus: password, approval, plan,
 *        payouts, username); a PAID plan whose first real charge cleared (vendor_subscriptions.first_paid_at, set by
 *        invoice.paid only when amount_paid > 0) and that is active now; an active feed post by the owner (stories
 *        don't count); a live service, staff service or product.
 *      Blocked when the referrer owns or staffs the business, or shares its Stripe account or email. At most 20 per
 *      referrer per New York calendar year (the 21st is blocked). Qualifying and creating the payout row is ONE
 *      statement, so qualified money is always counted as held by the bank payout job (computeHeld).
 *   3. sendReferralPayout: 7 days after qualifying. Same claim / lock / ownership / bounded calls / one key per claim
 *      / lookup-before-create shape as the event payout job (events/eventPayouts.ts). Before sending: blocks again,
 *      and the first plan payment must still stand (not refunded, not disputed), else 'cancelled'. Paid to the
 *      referrer's own business account, else photographer account, else their personal payout account
 *      (user_payout_accounts). None ready -> 'held', checked hourly, the referrer is told once how to set up payouts.
 *      Not enough platform balance -> stays 'pending', not counted as a try, admin emailed at most daily.
 *      Other errors -> backoff 10, 20, 40, 60 minutes; after 5 tries 'review' + one admin email.
 *
 * Copy rules: real punctuation, no dashes, never a fee percentage.
 * Why raw SQL in single statements: the neon-http driver has no transactions.
 */
import { sql } from "drizzle-orm";
import { rows } from "../events/eventsRouter";

export const BUSINESS_REFERRAL_CENTS = 2500;
export const BUSINESS_REFERRAL_WINDOW_DAYS = 90;
export const BUSINESS_REFERRAL_PAY_DELAY_DAYS = 7;
export const BUSINESS_REFERRAL_YEARLY_CAP = 20;
export const REFERRAL_PAYOUT_MAX_ATTEMPTS = 5;
export const REFERRAL_PAYOUT_LOCK_MINUTES = 10;
export const REFERRAL_PAYOUT_JOB_LIMIT = 20;
const STRIPE_CALL_BOUND = { timeoutMs: 30000, maxNetworkRetries: 1 };
const CODE_RE = /^[A-Za-z0-9]{1,20}$/;

type Bound = { timeoutMs?: number; maxNetworkRetries?: number };
export type InvoiceStanding = "stands" | "refunded" | "disputed" | "unpaid" | "unknown";
export interface ReferralStripe {
  getPayoutReadiness(accountId: string, opts?: Bound): Promise<{ ready: boolean }>;
  findReferralPayoutTransfer(businessReferralId: string, payoutId: string, opts?: Bound): Promise<{ id: string; amount: number } | null>;
  createReferralPayoutTransfer(p: { businessReferralId: string; payoutId: string; destination: string; amountCents: number; idempotencyKey: string } & Bound): Promise<{ id: string }>;
  getInvoicePaymentStanding(invoiceId: string, opts?: Bound): Promise<InvoiceStanding>;
  isInsufficientFundsError(err: unknown): boolean;
}
export type CheckResult = "none" | "pending" | "qualified" | "expired" | "blocked";
export type PayoutResult = "paid" | "held" | "retry" | "insufficient" | "review" | "cancelled" | "not_due";

const yes = (v: unknown) => v === true || v === "t" || v === "true";

async function realStripe(): Promise<ReferralStripe> {
  const { stripeService } = await import("../stripe/stripeService");
  return stripeService as unknown as ReferralStripe;
}

async function notify(kind: "qualified" | "setup_payouts" | "paid", payoutOrReferralId: string, userId: string, extra: { payableAfter?: Date | string | null } = {}): Promise<void> {
  try {
    const { NotificationTriggers } = await import("../notificationService");
    await NotificationTriggers.businessReferralReward({ kind, referenceId: payoutOrReferralId, userId, payableAfter: extra.payableAfter ?? null });
  } catch (err) {
    console.error(`[BusinessReferral] ${kind} notice for ${payoutOrReferralId} failed:`, (err as Error)?.message ?? err);
  }
}

async function alertAdmin(subject: string, detail: string): Promise<void> {
  try {
    const { alertPayouts } = await import("../bankPayout");
    await alertPayouts(subject, detail);
  } catch (err) {
    console.error(`[BusinessReferral] admin alert failed (${subject}):`, (err as Error)?.message ?? err);
  }
}

// ─── Plan payments ──────────────────────────────────────────────────────────

/**
 * invoice.paid: remember the plan's first real charge, once. A $0 invoice (trial, 100% coupon) never counts.
 * Returns the business id when this call set it (so the caller can re-check that business's referral).
 */
export async function recordFirstPlanPayment(vendorSubscriptionId: string, invoice: any): Promise<string | null> {
  const amount = typeof invoice?.amount_paid === "number" ? invoice.amount_paid : 0;
  if (!invoice?.id || invoice.status !== "paid" || amount <= 0) return null;
  const [r] = await rows<{ business_id: string }>(sql`
    UPDATE vendor_subscriptions SET first_paid_at = now(), first_paid_invoice_id = ${String(invoice.id)}
    WHERE id = ${vendorSubscriptionId} AND first_paid_at IS NULL
    RETURNING business_id`);
  return r?.business_id ?? null;
}

// ─── 1. Signup ──────────────────────────────────────────────────────────────

/** Business signup with a code: create the pending referral. Never throws, never fails the signup. */
export async function applyBusinessReferralAtSignup(ownerUserId: string, businessId: string, raw: unknown): Promise<boolean> {
  try {
    if (typeof raw !== "string") return false;
    const code = raw.trim();
    if (!CODE_RE.test(code)) return false;
    const made = await rows<{ id: string }>(sql`
      INSERT INTO business_referrals (referrer_user_id, business_id, referred_owner_user_id, code, expires_at)
      SELECT ref.id, b.id, b.owner_id, ${code.toUpperCase()}, b.created_at + make_interval(days => ${BUSINESS_REFERRAL_WINDOW_DAYS}::int)
      FROM businesses b
      JOIN users ref ON UPPER(ref.referral_code) = UPPER(${code})
      WHERE b.id = ${businessId} AND b.owner_id = ${ownerUserId} AND ref.id <> b.owner_id
        AND ref.is_active = true AND ref.deletion_status = 'active'
      ON CONFLICT (business_id) DO NOTHING
      RETURNING id`);
    if (!made[0]) {
      console.warn(`[BusinessReferral] code not applied for business ${businessId}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[BusinessReferral] signup code failed for business ${businessId}:`, (err as Error)?.message ?? err);
    return false;
  }
}

// ─── 2. Qualification ──────────────────────────────────────────────────────

/** Why this referral must not pay, or null. Checked when qualifying and again right before sending. */
export async function businessReferralBlock(referralId: string): Promise<string | null> {
  const [b] = await rows<any>(sql`
    SELECT
      (biz.owner_id = r.referrer_user_id) AS owner,
      EXISTS (SELECT 1 FROM staff_members s WHERE s.business_id = biz.id
              AND (s.user_id = r.referrer_user_id OR (ref.email IS NOT NULL AND lower(s.email) = lower(ref.email)))) AS staff,
      (biz.stripe_account_id IS NOT NULL AND (
         EXISTS (SELECT 1 FROM businesses b2 WHERE b2.owner_id = r.referrer_user_id AND b2.id <> biz.id AND b2.stripe_account_id = biz.stripe_account_id)
         OR EXISTS (SELECT 1 FROM photographers p WHERE p.user_id = r.referrer_user_id AND p.stripe_account_id = biz.stripe_account_id)
         OR EXISTS (SELECT 1 FROM user_payout_accounts a WHERE a.user_id = r.referrer_user_id AND a.stripe_account_id = biz.stripe_account_id))) AS shared_stripe,
      (ref.email IS NOT NULL AND (lower(biz.contact_email) = lower(ref.email) OR lower(owner_u.email) = lower(ref.email))) AS shared_email,
      (ref.is_active = false OR ref.deletion_status <> 'active') AS referrer_gone
    FROM business_referrals r
    JOIN businesses biz ON biz.id = r.business_id
    JOIN users ref ON ref.id = r.referrer_user_id
    JOIN users owner_u ON owner_u.id = biz.owner_id
    WHERE r.id = ${referralId}`);
  if (!b) return "missing";
  if (yes(b.owner)) return "owner";
  if (yes(b.staff)) return "staff";
  if (yes(b.shared_stripe)) return "shared_stripe";
  if (yes(b.shared_email)) return "shared_email";
  if (yes(b.referrer_gone)) return "referrer_inactive";
  return null;
}

/** Facts other than account setup, in one read. */
async function businessFacts(businessId: string): Promise<{ approvedActive: boolean; paidPlan: boolean; posted: boolean; live: boolean }> {
  const [f] = await rows<any>(sql`
    SELECT
      (b.approval_status = 'approved' AND COALESCE(b.is_demo, false) = false AND o.is_active = true AND o.deletion_status = 'active') AS approved_active,
      EXISTS (SELECT 1 FROM vendor_subscriptions vs WHERE vs.business_id = b.id AND vs.stripe_subscription_id IS NOT NULL
              AND vs.status = 'active' AND vs.first_paid_at IS NOT NULL) AS paid_plan,
      EXISTS (SELECT 1 FROM feed_posts p WHERE p.author_id = b.owner_id AND p.is_active = true) AS posted,
      (EXISTS (SELECT 1 FROM vendor_services s WHERE s.business_id = b.id AND s.status = 'live' AND s.is_active = true)
       OR EXISTS (SELECT 1 FROM staff_services ss WHERE ss.business_id = b.id AND ss.status = 'live' AND ss.is_active = true)
       OR EXISTS (SELECT 1 FROM vendor_products vp WHERE vp.business_id = b.id AND vp.status = 'live' AND vp.is_active = true)) AS live
    FROM businesses b JOIN users o ON o.id = b.owner_id
    WHERE b.id = ${businessId}`);
  return { approvedActive: yes(f?.approved_active), paidPlan: yes(f?.paid_plan), posted: yes(f?.posted), live: yes(f?.live) };
}

/** Test seam: replaces getAccountSetupStatus (it reads Stripe tiers through the real service). Never set in production. */
let setupCompleteForTest: ((ownerUserId: string) => Promise<boolean>) | null = null;
export function setSetupCheckForTest(fn: ((ownerUserId: string) => Promise<boolean>) | null): void {
  setupCompleteForTest = fn;
}
async function setupComplete(ownerUserId: string): Promise<boolean> {
  if (setupCompleteForTest) return setupCompleteForTest(ownerUserId);
  const { getAccountSetupStatus } = await import("../accountSetup/status");
  const s = await getAccountSetupStatus(ownerUserId, { syncStripe: false });
  return s?.complete === true;
}

/** Re-check one business's referral. Idempotent, safe to run any number of times at once. */
export async function checkBusinessReferral(businessId: string): Promise<CheckResult> {
  const [r] = await rows<any>(sql`
    SELECT id, referrer_user_id, referred_owner_user_id, status, (expires_at <= now()) AS expired
    FROM business_referrals WHERE business_id = ${businessId}`);
  if (!r) return "none";
  if (r.status !== "pending") return r.status as CheckResult;

  if (yes(r.expired)) {
    await rows(sql`UPDATE business_referrals SET status = 'expired', last_checked_at = now(), updated_at = now() WHERE id = ${r.id} AND status = 'pending'`);
    return "expired";
  }
  const block = await businessReferralBlock(r.id);
  if (block) {
    await rows(sql`UPDATE business_referrals SET status = 'blocked', block_reason = ${block}, last_checked_at = now(), updated_at = now() WHERE id = ${r.id} AND status = 'pending'`);
    return "blocked";
  }
  const facts = await businessFacts(businessId);
  const ready = facts.approvedActive && facts.paidPlan && facts.posted && facts.live && (await setupComplete(r.referred_owner_user_id));
  if (!ready) {
    await rows(sql`UPDATE business_referrals SET last_checked_at = now() WHERE id = ${r.id}`);
    return "pending";
  }

  // Qualify and create the payout in ONE statement (the yearly cap is checked inside it).
  const made = await rows<{ id: string; payable_after: string }>(sql`
    WITH cap AS (
      SELECT count(*)::int AS n FROM referral_payouts p JOIN business_referrals x ON x.id = p.business_referral_id
      WHERE x.referrer_user_id = ${r.referrer_user_id} AND p.status <> 'cancelled'
        AND x.qualified_at >= (date_trunc('year', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
    ), q AS (
      UPDATE business_referrals SET status = 'qualified', qualified_at = now(), last_checked_at = now(), updated_at = now()
      WHERE id = ${r.id} AND status = 'pending' AND expires_at > now() AND (SELECT n FROM cap) < ${BUSINESS_REFERRAL_YEARLY_CAP}
      RETURNING id, referrer_user_id, qualified_at
    )
    INSERT INTO referral_payouts (business_referral_id, recipient_user_id, amount_cents, status, payable_after, next_attempt_at)
    SELECT id, referrer_user_id, ${BUSINESS_REFERRAL_CENTS}, 'pending',
           qualified_at + make_interval(days => ${BUSINESS_REFERRAL_PAY_DELAY_DAYS}::int),
           qualified_at + make_interval(days => ${BUSINESS_REFERRAL_PAY_DELAY_DAYS}::int)
    FROM q
    ON CONFLICT (business_referral_id) DO NOTHING
    RETURNING id, payable_after`);
  if (made[0]) {
    void notify("qualified", r.id, r.referrer_user_id, { payableAfter: made[0].payable_after });
    return "qualified";
  }
  // Not qualified by this call: another call did it, or the yearly cap is reached (the 21st is blocked).
  const [now] = await rows<any>(sql`SELECT status FROM business_referrals WHERE id = ${r.id}`);
  if (now?.status === "pending") {
    await rows(sql`UPDATE business_referrals SET status = 'blocked', block_reason = 'yearly_cap', last_checked_at = now(), updated_at = now() WHERE id = ${r.id} AND status = 'pending'`);
    return "blocked";
  }
  return (now?.status ?? "none") as CheckResult;
}

/** Fire and forget from hooks: never throws, never delays the caller's response. */
export function checkBusinessReferralSoon(businessId: string | null | undefined): void {
  if (!businessId) return;
  void checkBusinessReferral(businessId).catch((err) =>
    console.error(`[BusinessReferral] check for business ${businessId} failed:`, (err as Error)?.message ?? err));
}

/** Same, for hooks that only know the owner (feed post). */
export function checkBusinessReferralsForOwnerSoon(ownerUserId: string | null | undefined): void {
  if (!ownerUserId) return;
  void (async () => {
    const list = await rows<{ business_id: string }>(sql`
      SELECT business_id FROM business_referrals WHERE referred_owner_user_id = ${ownerUserId} AND status = 'pending'`);
    for (const x of list) await checkBusinessReferral(x.business_id);
  })().catch((err) => console.error(`[BusinessReferral] owner check for ${ownerUserId} failed:`, (err as Error)?.message ?? err));
}

/** Hourly: re-check pending referrals (least recently checked first) and expire old ones. */
export async function sweepBusinessReferrals(limit = 200): Promise<{ checked: number; qualified: number; expired: number }> {
  const out = { checked: 0, qualified: 0, expired: 0 };
  const list = await rows<{ business_id: string }>(sql`
    SELECT business_id FROM business_referrals WHERE status = 'pending'
    ORDER BY last_checked_at NULLS FIRST, created_at LIMIT ${limit}`);
  for (const x of list) {
    try {
      const res = await checkBusinessReferral(x.business_id);
      out.checked++;
      if (res === "qualified") out.qualified++;
      if (res === "expired") out.expired++;
    } catch (err) {
      console.error(`[BusinessReferral] sweep check for ${x.business_id} failed:`, (err as Error)?.message ?? err);
    }
  }
  return out;
}

export function startBusinessReferralSweep(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  const run = () => sweepBusinessReferrals()
    .then((o) => { if (o.qualified || o.expired) console.log(`[BusinessReferral] sweep: checked ${o.checked}, qualified ${o.qualified}, expired ${o.expired}`); })
    .catch((err) => console.error("[BusinessReferral] sweep failed:", (err as Error)?.message ?? err));
  setTimeout(run, 60 * 1000);
  return setInterval(run, intervalMs);
}

// ─── 3. Payout ─────────────────────────────────────────────────────────────

type Destination = { destinationType: "business" | "photographer" | "user"; accountId: string; localReady: boolean };

/** Where the referrer can be paid, best first: own business, own photographer profile, personal payout account. */
export async function referralPayoutDestinations(userId: string): Promise<Destination[]> {
  const list = await rows<any>(sql`
    SELECT 'business' AS t, stripe_account_id AS acct, COALESCE(stripe_onboarding_complete, false) AS ok, 1 AS ord, created_at
      FROM businesses WHERE owner_id = ${userId} AND stripe_account_id IS NOT NULL AND stripe_account_id <> '' AND approval_status = 'approved'
    UNION ALL
    SELECT 'photographer', stripe_account_id, COALESCE(stripe_onboarding_complete, false), 2, created_at
      FROM photographers WHERE user_id = ${userId} AND stripe_account_id IS NOT NULL AND stripe_account_id <> ''
    UNION ALL
    SELECT 'user', stripe_account_id, onboarding_complete, 3, created_at
      FROM user_payout_accounts WHERE user_id = ${userId}
    ORDER BY ord, created_at`);
  return list.map((d) => ({ destinationType: d.t, accountId: d.acct, localReady: yes(d.ok) }));
}

const OWNER_TAG = sql`(extract(epoch from updated_at) * 1000000)::bigint::text`;

const HOLD_TEXT: Record<string, string> = {
  no_account: "the referrer has no payout account yet",
  not_complete: "the referrer hasn't finished payout setup",
  stripe_not_ready: "Stripe says the referrer's account can't take payouts yet",
};

/** Hold: not counted as a try, rechecked in an hour. The referrer is told once per reason how to fix it (no admin email: normal). */
async function hold(p: any, reason: string, tag: string): Promise<PayoutResult> {
  const [h] = await rows<any>(sql`
    UPDATE referral_payouts SET status = 'held', hold_reason = ${reason}, attempts = GREATEST(0, attempts - 1),
           next_attempt_at = now() + interval '1 hour', alerted_at = now(), updated_at = now()
    WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
      AND (status <> 'held' OR alerted_at IS NULL OR hold_reason IS DISTINCT FROM ${reason})
    RETURNING id`);
  if (!h) {
    const [same] = await rows<any>(sql`
      UPDATE referral_payouts SET attempts = GREATEST(0, attempts - 1), next_attempt_at = now() + interval '1 hour', updated_at = now()
      WHERE id = ${p.id} AND status = 'held' AND ${OWNER_TAG} = ${tag}
      RETURNING id`);
    return same ? "held" : "not_due";
  }
  if (reason === "no_account" || reason === "not_complete") void notify("setup_payouts", p.id, p.recipient_user_id);
  console.log(`[BusinessReferral] payout ${p.id} held: ${HOLD_TEXT[reason] ?? reason}`);
  return "held";
}

async function cancel(p: any, why: string, tag: string): Promise<PayoutResult> {
  const [c] = await rows<any>(sql`
    UPDATE referral_payouts SET status = 'cancelled', last_error = ${why.slice(0, 300)}, next_attempt_at = NULL, updated_at = now()
    WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
    RETURNING id`);
  if (!c) return "not_due";
  console.warn(`[BusinessReferral] payout ${p.id} cancelled: ${why}`);
  return "cancelled";
}

async function toReview(p: any, why: string, tag: string): Promise<PayoutResult> {
  const [r] = await rows<any>(sql`
    UPDATE referral_payouts SET status = 'review', last_error = ${why.slice(0, 300)}, next_attempt_at = NULL, updated_at = now()
    WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
    RETURNING id`);
  if (!r) return "not_due";
  await alertAdmin("Referral payout needs a look",
    `Business referral payout ${p.id} of ${p.amount_cents} cents to user ${p.recipient_user_id} (referral ${p.business_referral_id}): ${why}. Check Stripe, then set it back to pending with attempts 0 to retry.`);
  return "review";
}

/** Sends one referral payout. Safe to run any number of times, at the same time too. */
export async function sendReferralPayout(payoutId: string, s?: ReferralStripe): Promise<PayoutResult> {
  const [p] = await rows<any>(sql`
    UPDATE referral_payouts SET attempts = attempts + 1,
           next_attempt_at = now() + make_interval(mins => ${REFERRAL_PAYOUT_LOCK_MINUTES}::int), updated_at = now()
    WHERE id = ${payoutId} AND status IN ('pending', 'held') AND payable_after <= now()
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    RETURNING id, business_referral_id, recipient_user_id, amount_cents, attempts, ${OWNER_TAG} AS claim_tag`);
  if (!p) return "not_due";
  let tag = String(p.claim_tag);
  const amount = Number(p.amount_cents);
  const st = s ?? (await realStripe());

  const block = await businessReferralBlock(p.business_referral_id);
  if (block) {
    await rows(sql`UPDATE business_referrals SET status = 'blocked', block_reason = ${block}, updated_at = now() WHERE id = ${p.business_referral_id}`);
    return cancel(p, `blocked: ${block}`, tag);
  }

  try {
    // The first plan payment must still stand (7 day wait decided by Legend 2026-10-24).
    const [inv] = await rows<any>(sql`
      SELECT vs.first_paid_invoice_id FROM business_referrals r JOIN vendor_subscriptions vs ON vs.business_id = r.business_id
      WHERE r.id = ${p.business_referral_id}`);
    if (!inv?.first_paid_invoice_id) return await cancel(p, "the business has no paid plan invoice on record", tag);
    const standing = await st.getInvoicePaymentStanding(inv.first_paid_invoice_id, STRIPE_CALL_BOUND);
    if (standing === "refunded" || standing === "disputed" || standing === "unpaid") {
      return await cancel(p, `the business's first plan payment was ${standing}`, tag);
    }
    if (standing !== "stands") return await toReview(p, `Stripe couldn't confirm the first plan payment (invoice ${inv.first_paid_invoice_id})`, tag);

    // Destination: the first one that is ready; otherwise hold with the best one's reason.
    const dests = await referralPayoutDestinations(p.recipient_user_id);
    let dest: Destination | null = null;
    let reason = "no_account";
    for (const d of dests) {
      if (!d.localReady) { if (reason === "no_account") reason = "not_complete"; continue; }
      try {
        if ((await st.getPayoutReadiness(d.accountId, STRIPE_CALL_BOUND)).ready) { dest = d; break; }
        reason = "stripe_not_ready";
      } catch {
        reason = "stripe_not_ready";
      }
    }
    if (!dest) return await hold(p, reason, tag);

    // Re-take the lock while this claim still owns the row.
    const [mine] = await rows<any>(sql`
      UPDATE referral_payouts SET next_attempt_at = now() + make_interval(mins => ${REFERRAL_PAYOUT_LOCK_MINUTES}::int),
             status = 'pending', hold_reason = NULL,
             alerted_at = CASE WHEN status = 'held' THEN NULL ELSE alerted_at END, updated_at = now()
      WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`);
    if (!mine) return "not_due";
    tag = String(mine.tag);

    const existing = await st.findReferralPayoutTransfer(p.business_referral_id, p.id, STRIPE_CALL_BOUND);
    let transferId: string;
    if (existing) {
      if (existing.amount !== amount) return await toReview(p, `Stripe already has transfer ${existing.id} of ${existing.amount} cents for this payout, but the payout is ${amount} cents`, tag);
      transferId = existing.id;
    } else {
      // One key per claim (the claim's own timestamp): Stripe replays a saved error for 24 hours.
      transferId = (await st.createReferralPayoutTransfer({
        businessReferralId: p.business_referral_id, payoutId: p.id, destination: dest.accountId, amountCents: amount,
        idempotencyKey: `referral_payout_${p.id}_${p.claim_tag}`, ...STRIPE_CALL_BOUND,
      })).id;
    }
    const [done] = await rows<any>(sql`
      UPDATE referral_payouts SET status = 'paid', transfer_id = ${transferId}, paid_at = now(),
             destination_type = ${dest.destinationType}, connected_account_id = ${dest.accountId},
             hold_reason = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = ${p.id} AND status IN ('pending', 'held')
        AND (${OWNER_TAG} = ${tag} OR next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING id`);
    if (!done) return "not_due";
    void notify("paid", p.id, p.recipient_user_id);
    return "paid";
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 300);
    let insufficient = false;
    try { insufficient = st.isInsufficientFundsError(err); } catch { /* treat as other */ }
    if (insufficient) {
      const [w] = await rows<any>(sql`
        UPDATE referral_payouts SET status = 'pending', attempts = GREATEST(0, attempts - 1),
               next_attempt_at = now() + interval '1 hour', last_error = ${msg},
               alerted_at = CASE WHEN alerted_at IS NULL OR alerted_at < now() - interval '24 hours' THEN now() ELSE alerted_at END,
               updated_at = now()
        WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
        RETURNING (alerted_at = now()) AS emailed`);
      if (!w) return "not_due";
      if (yes(w.emailed)) {
        await alertAdmin("Referral payout waiting for balance",
          `Business referral payout ${p.id} of ${amount} cents can't be sent: not enough available balance on Stripe. It is tried again every hour, and the daily bank payout waits until it is sent.`);
      }
      return "insufficient";
    }
    console.error(`[BusinessReferral] payout try ${p.attempts} failed for ${p.id}: ${msg}`);
    const [still] = await rows<any>(sql`
      UPDATE referral_payouts SET last_error = ${msg},
             next_attempt_at = now() + make_interval(mins => LEAST(60, ${REFERRAL_PAYOUT_LOCK_MINUTES}::int * power(2, LEAST(attempts - 1, 6)))::int),
             updated_at = now()
      WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`).catch(() => [] as any[]);
    if (!still) return "not_due";
    tag = String(still.tag);
    if (Number(p.attempts) >= REFERRAL_PAYOUT_MAX_ATTEMPTS) return toReview(p, `the transfer failed ${p.attempts} times, last error: ${msg}`, tag);
    return "retry";
  }
}

/** Every minute: send up to 20 due referral payouts (least recently tried first). */
export async function runReferralPayoutJob(s?: ReferralStripe): Promise<{ paid: number; held: number; cancelled: number; review: number }> {
  const out = { paid: 0, held: 0, cancelled: 0, review: 0 };
  const due = await rows<{ id: string }>(sql`
    SELECT id FROM referral_payouts
    WHERE status IN ('pending', 'held') AND payable_after <= now() AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY updated_at LIMIT ${REFERRAL_PAYOUT_JOB_LIMIT}`);
  for (const d of due) {
    try {
      const r = await sendReferralPayout(d.id, s);
      if (r === "paid") out.paid++;
      else if (r === "held") out.held++;
      else if (r === "cancelled") out.cancelled++;
      else if (r === "review") out.review++;
    } catch (err) {
      console.error(`[BusinessReferral] payout ${d.id} failed:`, (err as Error)?.message ?? err);
    }
  }
  if (out.paid || out.cancelled || out.review) {
    console.log(`[BusinessReferral] payout job: paid ${out.paid}, held ${out.held}, cancelled ${out.cancelled}, review ${out.review}`);
  }
  return out;
}

// ─── Read model for the referrer's dashboards ──────────────────────────────

export async function listBusinessReferralsFor(userId: string): Promise<{
  referrals: Array<{ businessName: string; status: string; qualifiedAt: string | null; expiresAt: string; payout: { status: string; amountCents: number; payableAfter: string; paidAt: string | null; holdReason: string | null } | null }>;
  totals: { invited: number; qualified: number; paidCents: number; waitingCents: number };
}> {
  const list = await rows<any>(sql`
    SELECT b.name AS business_name, r.status, r.qualified_at, r.expires_at,
           p.status AS payout_status, p.amount_cents, p.payable_after, p.paid_at, p.hold_reason
    FROM business_referrals r JOIN businesses b ON b.id = r.business_id
    LEFT JOIN referral_payouts p ON p.business_referral_id = r.id
    WHERE r.referrer_user_id = ${userId}
    ORDER BY r.created_at DESC LIMIT 100`);
  const referrals = list.map((x) => ({
    businessName: x.business_name,
    status: x.status,
    qualifiedAt: x.qualified_at ? new Date(x.qualified_at).toISOString() : null,
    expiresAt: new Date(x.expires_at).toISOString(),
    payout: x.payout_status ? {
      status: x.payout_status, amountCents: Number(x.amount_cents),
      payableAfter: new Date(x.payable_after).toISOString(),
      paidAt: x.paid_at ? new Date(x.paid_at).toISOString() : null,
      holdReason: x.hold_reason ?? null,
    } : null,
  }));
  const totals = {
    invited: referrals.length,
    qualified: referrals.filter((r) => r.status === "qualified").length,
    paidCents: referrals.reduce((a, r) => a + (r.payout?.status === "paid" ? r.payout.amountCents : 0), 0),
    waitingCents: referrals.reduce((a, r) => a + (r.payout && ["pending", "held", "review"].includes(r.payout.status) ? r.payout.amountCents : 0), 0),
  };
  return { referrals, totals };
}
