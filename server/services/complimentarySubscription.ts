/**
 * Complimentary ("waived") subscription service.
 *
 * Every multi-write here is ONE raw SQL statement run through db.execute(sql`…`).
 * The neon-http driver has no interactive transactions, so each write path is a single
 * statement with data-modifying CTEs. One statement is atomic: the subscription row, the
 * businesses flag and the audit row commit together or not at all.
 *
 * ON CONFLICT (business_id) requires uq_vendor_subscriptions_business
 * (migrations/037_vendor_subscriptions_business_unique.sql, hand-run in Neon).
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  subscriptionTiers,
  vendorSubscriptions,
  type Business,
  type SubscriptionTier,
} from "@shared/schema";
import { stripeService } from "../stripe/stripeService";
import { getUncachableStripeClient } from "../stripe/stripeClient";
import {
  PERMANENT_EXPIRY_ISO,
  buildAdminSubscriptionSummary,
  isComplimentaryTier,
  isTerminalStripeStatus,
  isoOrNull,
  type AdminSubscriptionSummary,
} from "../complimentary";

export interface ComplimentarySubscriptionRow {
  id: string;
  vendorId: string;
  businessId: string;
  tierId: string;
  status: string | null;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function mapRow(row: Record<string, unknown>): ComplimentarySubscriptionRow {
  return {
    id: String(row.id),
    vendorId: String(row.vendor_id),
    businessId: String(row.business_id),
    tierId: String(row.tier_id),
    status: (row.status as string | null) ?? null,
    stripeSubscriptionId: (row.stripe_subscription_id as string | null) ?? null,
    stripeCustomerId: (row.stripe_customer_id as string | null) ?? null,
    currentPeriodStart: isoOrNull(row.current_period_start),
    currentPeriodEnd: isoOrNull(row.current_period_end),
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
  };
}

/**
 * The single complimentary tier, resolved server-side (never from a request body).
 * Returns null unless exactly one active tier is priced 0 with no Stripe price.
 */
export async function getComplimentaryTier(): Promise<SubscriptionTier | null> {
  const rows = await db
    .select()
    .from(subscriptionTiers)
    .where(and(eq(subscriptionTiers.priceInCents, 0), isNull(subscriptionTiers.stripePriceId)));
  const matches = rows.filter((t) => isComplimentaryTier(t) && t.isActive !== false);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Is this business able to receive payouts? True iff it has a Stripe Connect account
 * AND Stripe reports charges_enabled && payouts_enabled.
 *
 * Deliberately does NOT read or change businesses.stripe_onboarding_complete (that flag
 * can be true with no account id). Any Stripe error → false, logged without secrets.
 */
export async function computeConnectReady(
  business: Pick<Business, "id" | "stripeAccountId">,
): Promise<boolean> {
  if (!business.stripeAccountId) return false;
  try {
    const status = await stripeService.getConnectAccountStatus(business.stripeAccountId);
    return status.chargesEnabled === true && status.payoutsEnabled === true;
  } catch (error) {
    console.error(
      `[Complimentary] connectReady check failed for business ${business.id}:`,
      error instanceof Error ? error.message : "unknown error",
    );
    return false;
  }
}

export interface GrantStatementParams {
  businessId: string;
  ownerId: string;
  tierId: string;
  expiresAtIso: string;
  permanent: boolean;
  action: "complimentary_subscription.grant" | "complimentary_subscription.extend";
  actorId: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The upsert tail shared by the admin grant/extend statement and the claim-link redeem
 * statement: a live paid row (Stripe subscription id that is not canceled/incomplete_expired
 * with an ended period) is never overwritten. Keep both statements on this ONE fragment so they
 * cannot drift.
 */
const UPSERT_ON_CONFLICT = sql`ON CONFLICT (business_id) DO UPDATE SET
        vendor_id = EXCLUDED.vendor_id,
        tier_id = EXCLUDED.tier_id,
        status = 'active',
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        current_quarter_start = NULL,
        current_quarter_end = NULL,
        stripe_subscription_id = NULL,
        stripe_customer_id = NULL,
        updated_at = EXCLUDED.updated_at
      WHERE vendor_subscriptions.stripe_subscription_id IS NULL
         OR (vendor_subscriptions.status IN ('canceled','incomplete_expired')
             AND (vendor_subscriptions.current_period_end IS NULL
                  OR vendor_subscriptions.current_period_end < (now() AT TIME ZONE 'UTC')))`;

/**
 * Grant / extend / re-grant after expiry: ONE statement.
 * Returns the resulting row, or null when the conflict WHERE refused (a live paid
 * row exists) — in that case no row is written and no audit row is inserted.
 */
export function buildGrantStatement(p: GrantStatementParams) {
  return sql`
    WITH prev AS (
      SELECT * FROM vendor_subscriptions WHERE business_id = ${p.businessId}::varchar
    ),
    up AS (
      INSERT INTO vendor_subscriptions
        (vendor_id, business_id, tier_id, status, current_period_start, current_period_end,
         current_quarter_start, current_quarter_end, stripe_subscription_id, stripe_customer_id,
         created_at, updated_at)
      VALUES
        (${p.ownerId}::varchar, ${p.businessId}::varchar, ${p.tierId}::varchar, 'active',
         now() AT TIME ZONE 'UTC', (${p.expiresAtIso}::timestamptz AT TIME ZONE 'UTC'),
         NULL, NULL, NULL, NULL, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
      ${UPSERT_ON_CONFLICT}
      RETURNING *
    ),
    biz AS (
      UPDATE businesses SET subscription_active = true
      WHERE id IN (SELECT business_id FROM up) RETURNING id
    ),
    aud AS (
      INSERT INTO audit_logs
        (actor_id, actor_type, action, target_type, target_id, before_state, after_state,
         metadata, ip_address, user_agent)
      SELECT ${p.actorId}::text, 'admin', ${p.action}::text, 'vendor_subscription', up.id,
             (SELECT to_jsonb(prev) FROM prev LIMIT 1), to_jsonb(up),
             jsonb_build_object('businessId', up.business_id, 'expiresAt', up.current_period_end,
                                'permanent', ${p.permanent}::boolean,
                                'replacedStripeSubscriptionId', (SELECT stripe_subscription_id FROM prev LIMIT 1),
                                'replacedStripeCustomerId', (SELECT stripe_customer_id FROM prev LIMIT 1)),
             ${p.ip}::text, ${p.userAgent}::text
      FROM up RETURNING id
    )
    SELECT up.*, (SELECT count(*) FROM biz) AS biz_updated, (SELECT count(*) FROM aud) AS aud_written FROM up
  `;
}

export async function runGrantStatement(p: GrantStatementParams): Promise<ComplimentarySubscriptionRow | null> {
  const result = await db.execute<Record<string, unknown>>(buildGrantStatement(p));
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** 409 text shared by the grant route, link creation and the redeem re-read. */
export const PAID_ROW_LIVE_MESSAGE =
  "This business has a paid subscription that is still live. Complimentary grant refused.";

/**
 * A past payer keeps a stripe_subscription_id on the row. Only convert it when Stripe confirms
 * the old subscription can never bill again; any Stripe error refuses.
 * Returns the 409 message to send, or null when it is safe to continue.
 */
export async function checkPreviousStripeSubscription(
  businessId: string,
  stripeSubscriptionId: string | null | undefined,
): Promise<string | null> {
  if (!stripeSubscriptionId) return null;
  try {
    const stripe = await getUncachableStripeClient();
    const oldSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    if (!isTerminalStripeStatus(oldSub.status)) {
      return `This business has a Stripe subscription that is still ${oldSub.status}. Cancel it in Stripe before granting a complimentary plan.`;
    }
    return null;
  } catch (stripeError) {
    console.error(
      `[Complimentary] Could not verify previous Stripe subscription for business ${businessId}:`,
      stripeError instanceof Error ? stripeError.message : "unknown error",
    );
    return "Could not verify this business's previous Stripe subscription with Stripe. Nothing was changed.";
  }
}

export interface RedeemStatementParams {
  /** sha256 hex of the claim token — the raw token never reaches SQL, audit rows or logs. */
  tokenHash: string;
  /** The authenticated caller; must own the link's business. */
  userId: string;
  tierId: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Claim a free-plan link: ONE statement.
 *
 * The `link` CTE marks the link redeemed only when EVERY guard holds (link unused, unrevoked,
 * unexpired; plan not already expired; caller owns the business; no live paid row). The upsert,
 * businesses.subscription_active and audit row all hang off that CTE, so a refused claim writes
 * nothing and leaves the link unused. Two concurrent claims: the second blocks on the link row
 * lock, re-evaluates `redeemed_at IS NULL` and gets 0 rows — exactly one grant.
 *
 * The paid-row guard repeats the upsert's conflict WHERE (NULL status counts as live, like the
 * conflict WHERE does) so the link is never burned by an upsert that would then refuse.
 * Returns the subscription row, or null when any guard refused.
 */
export function buildRedeemStatement(p: RedeemStatementParams) {
  return sql`
    WITH link AS (
      UPDATE complimentary_grant_links l
         SET redeemed_at = now() AT TIME ZONE 'UTC', redeemed_by = ${p.userId}::varchar
       WHERE l.token_hash = ${p.tokenHash}::text
         AND l.redeemed_at IS NULL AND l.revoked_at IS NULL
         AND l.link_expires_at > (now() AT TIME ZONE 'UTC')
         AND (l.plan_expires_at IS NULL OR l.plan_expires_at > (now() AT TIME ZONE 'UTC'))
         AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = l.business_id AND b.owner_id = ${p.userId}::varchar)
         AND NOT EXISTS (
           SELECT 1 FROM vendor_subscriptions vs
            WHERE vs.business_id = l.business_id AND vs.stripe_subscription_id IS NOT NULL
              AND NOT (COALESCE(vs.status, '') IN ('canceled','incomplete_expired')
                       AND (vs.current_period_end IS NULL
                            OR vs.current_period_end < (now() AT TIME ZONE 'UTC'))))
      RETURNING l.id, l.business_id, l.plan_expires_at, l.created_by
    ),
    prev AS (
      SELECT vs.* FROM vendor_subscriptions vs JOIN link ON vs.business_id = link.business_id
    ),
    up AS (
      INSERT INTO vendor_subscriptions
        (vendor_id, business_id, tier_id, status, current_period_start, current_period_end,
         current_quarter_start, current_quarter_end, stripe_subscription_id, stripe_customer_id,
         created_at, updated_at)
      SELECT ${p.userId}::varchar, link.business_id, ${p.tierId}::varchar, 'active',
             now() AT TIME ZONE 'UTC',
             COALESCE(link.plan_expires_at, (${PERMANENT_EXPIRY_ISO}::timestamptz AT TIME ZONE 'UTC')),
             NULL, NULL, NULL, NULL, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
        FROM link
      ${UPSERT_ON_CONFLICT}
      RETURNING *
    ),
    biz AS (
      UPDATE businesses SET subscription_active = true
      WHERE id IN (SELECT business_id FROM up) RETURNING id
    ),
    aud AS (
      INSERT INTO audit_logs
        (actor_id, actor_type, action, target_type, target_id, before_state, after_state,
         metadata, ip_address, user_agent)
      SELECT ${p.userId}::text, 'vendor', 'complimentary_subscription.redeem', 'vendor_subscription', up.id,
             (SELECT to_jsonb(prev) FROM prev LIMIT 1), to_jsonb(up),
             jsonb_build_object('businessId', up.business_id, 'linkId', link.id, 'createdBy', link.created_by,
                                'expiresAt', up.current_period_end,
                                'permanent', (link.plan_expires_at IS NULL),
                                'replacedStripeSubscriptionId', (SELECT stripe_subscription_id FROM prev LIMIT 1),
                                'replacedStripeCustomerId', (SELECT stripe_customer_id FROM prev LIMIT 1)),
             ${p.ip}::text, ${p.userAgent}::text
      FROM up CROSS JOIN link RETURNING id
    )
    SELECT up.*, (SELECT count(*) FROM biz) AS biz_updated, (SELECT count(*) FROM aud) AS aud_written FROM up
  `;
}

export async function runRedeemStatement(p: RedeemStatementParams): Promise<ComplimentarySubscriptionRow | null> {
  const result = await db.execute<Record<string, unknown>>(buildRedeemStatement(p));
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * GET /api/admin/businesses: the additive per-row `subscription` summary for one page of
 * businesses. ONE query (vendor_subscriptions ⨝ subscription_tiers) bounded by the page's ids,
 * no Stripe calls. Businesses without a row are absent from the map.
 */
export async function getAdminSubscriptionSummaries(
  businessIds: string[],
): Promise<Map<string, AdminSubscriptionSummary>> {
  const summaries = new Map<string, AdminSubscriptionSummary>();
  if (businessIds.length === 0) return summaries;
  const rows = await db
    .select({
      businessId: vendorSubscriptions.businessId,
      tierName: subscriptionTiers.name,
      tierDisplayName: subscriptionTiers.displayName,
      priceInCents: subscriptionTiers.priceInCents,
      stripePriceId: subscriptionTiers.stripePriceId,
      status: vendorSubscriptions.status,
      currentPeriodEnd: vendorSubscriptions.currentPeriodEnd,
      stripeSubscriptionId: vendorSubscriptions.stripeSubscriptionId,
    })
    .from(vendorSubscriptions)
    .innerJoin(subscriptionTiers, eq(vendorSubscriptions.tierId, subscriptionTiers.id))
    .where(inArray(vendorSubscriptions.businessId, businessIds))
    .orderBy(desc(vendorSubscriptions.createdAt));
  for (const row of rows) {
    if (!summaries.has(row.businessId)) summaries.set(row.businessId, buildAdminSubscriptionSummary(row));
  }
  return summaries;
}

export interface RevokeStatementParams {
  businessId: string;
  actorId: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Revoke: ONE statement. Expires the complimentary row now and clears
 * businesses.subscription_active. Only touches a row with NO Stripe subscription id
 * on a complimentary tier. Returns null when no row matched (caller decides 404 vs 409).
 */
export async function runRevokeStatement(p: RevokeStatementParams): Promise<ComplimentarySubscriptionRow | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH prev AS (
      SELECT * FROM vendor_subscriptions WHERE business_id = ${p.businessId}::varchar
    ),
    rev AS (
      UPDATE vendor_subscriptions
      SET status = 'canceled',
          current_period_end = now() AT TIME ZONE 'UTC',
          updated_at = now() AT TIME ZONE 'UTC'
      WHERE business_id = ${p.businessId}::varchar
        AND stripe_subscription_id IS NULL
        AND tier_id IN (SELECT id FROM subscription_tiers WHERE price_in_cents = 0 AND stripe_price_id IS NULL)
      RETURNING *
    ),
    biz AS (
      UPDATE businesses SET subscription_active = false
      WHERE id IN (SELECT business_id FROM rev) RETURNING id
    ),
    aud AS (
      INSERT INTO audit_logs
        (actor_id, actor_type, action, target_type, target_id, before_state, after_state,
         metadata, ip_address, user_agent)
      SELECT ${p.actorId}::text, 'admin', 'complimentary_subscription.revoke', 'vendor_subscription', rev.id,
             (SELECT to_jsonb(prev) FROM prev LIMIT 1), to_jsonb(rev),
             jsonb_build_object('businessId', rev.business_id),
             ${p.ip}::text, ${p.userAgent}::text
      FROM rev RETURNING id
    )
    SELECT rev.*, (SELECT count(*) FROM biz) AS biz_updated, (SELECT count(*) FROM aud) AS aud_written FROM rev
  `);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Daily expiry job (registered in server/index.ts): complimentary rows whose period has
 * ended become 'canceled' and their business loses subscription_active. ONE statement.
 * Paid rows never match (stripe_subscription_id IS NULL). Does NOT pause products or
 * services — the visibility and go-live gates already hide/block an inactive business.
 * Returns the number of expired subscription rows.
 */
export async function expireComplimentarySubscriptions(): Promise<number> {
  const result = await db.execute<{ expired: number; businesses: number }>(sql`
    WITH expired AS (
      UPDATE vendor_subscriptions vs SET status='canceled', updated_at=now()
      WHERE vs.stripe_subscription_id IS NULL AND vs.status='active'
        AND vs.current_period_end < now()
        AND vs.tier_id IN (SELECT id FROM subscription_tiers WHERE price_in_cents=0 AND stripe_price_id IS NULL)
      RETURNING vs.business_id),
    biz AS (
      UPDATE businesses SET subscription_active=false WHERE id IN (SELECT business_id FROM expired) RETURNING id)
    SELECT (SELECT count(*) FROM expired)::int AS expired, (SELECT count(*) FROM biz)::int AS businesses
  `);
  const row = result.rows[0];
  const expired = Number(row?.expired ?? 0);
  console.log(
    `[Complimentary] expiry job: expired ${expired} subscription row(s), cleared subscription_active on ${Number(row?.businesses ?? 0)} business(es)`,
  );
  return expired;
}
