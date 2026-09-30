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

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { subscriptionTiers, type Business, type SubscriptionTier } from "@shared/schema";
import { stripeService } from "../stripe/stripeService";
import { isComplimentaryTier } from "../complimentary";

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

// Raw db.execute rows can carry a Date or Postgres text ("2099-01-01 00:00:00" — `timestamp`
// columns are UTC with no zone). Normalise both to an ISO-8601 string with a trailing Z.
function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) {
    const parsed = new Date(text.replace(" ", "T") + "Z");
    return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
  }
  return text;
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
 * Grant / extend / re-grant after expiry: ONE statement.
 * Returns the resulting row, or null when the conflict WHERE refused (a live paid
 * row exists) — in that case no row is written and no audit row is inserted.
 */
export async function runGrantStatement(p: GrantStatementParams): Promise<ComplimentarySubscriptionRow | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
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
        updated_at = EXCLUDED.updated_at
      WHERE vendor_subscriptions.stripe_subscription_id IS NULL
         OR (vendor_subscriptions.status IN ('canceled','incomplete_expired')
             AND (vendor_subscriptions.current_period_end IS NULL
                  OR vendor_subscriptions.current_period_end < (now() AT TIME ZONE 'UTC')))
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
  `);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
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
