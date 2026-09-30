/**
 * Complimentary ("waived") subscription tier — pure helpers.
 *
 * No database or Stripe imports here so the logic can be unit-tested with
 * `npx tsx server/complimentary.test.ts`.
 *
 * A tier is complimentary when it costs nothing AND has no Stripe price:
 * there is nothing to check out, so the only way onto it is an admin grant.
 * Never decide this from the tier name.
 */

import { z } from "zod";

export interface TierPriceFields {
  priceInCents?: number | null;
  stripePriceId?: string | null;
}

export interface TierListItem {
  id: string;
  sortOrder?: number | null;
}

export interface SubscriptionRowFields {
  status?: string | null;
  stripeSubscriptionId?: string | null;
  currentPeriodEnd?: Date | string | null;
}

/** "Permanent" complimentary grants expire here. */
export const PERMANENT_EXPIRY_ISO = "2099-01-01T00:00:00.000Z";

/**
 * Stripe subscription statuses that can never come back to active.
 * `unpaid`, `past_due`, `incomplete` and `paused` CAN revive, so they are excluded.
 */
export const TERMINAL_STRIPE_STATUSES: readonly string[] = ["canceled", "incomplete_expired"];

export function isTerminalStripeStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_STRIPE_STATUSES.includes(status);
}

export function isComplimentaryTier(tier: TierPriceFields | null | undefined): boolean {
  return !!tier && tier.priceInCents === 0 && tier.stripePriceId == null;
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * /api/vendor/eligibility: does this row count as a provisioned subscription?
 *  - existing rule: a Stripe subscription id that isn't in a failed/terminal state
 *  - new rule: a complimentary tier, status 'active', period not yet ended
 */
export function isSubscriptionProvisioned(
  sub: SubscriptionRowFields | null | undefined,
  tier: TierPriceFields | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!sub) return false;
  const status = (sub.status || "").toLowerCase();

  const paidProvisioned =
    !!sub.stripeSubscriptionId &&
    status !== "canceled" &&
    status !== "incomplete_expired" &&
    status !== "unpaid";
  if (paidProvisioned) return true;

  const end = toMillis(sub.currentPeriodEnd);
  return isComplimentaryTier(tier) && status === "active" && end !== null && end >= now.getTime();
}

/**
 * Row-only backstop used by checkSubscriptionActiveStatus (which receives no tier).
 * True for an 'active' row with NO Stripe subscription whose period has ended.
 *
 * No paid row can match: every paid row is written with a Stripe subscription id
 * (webhookHandlers checkout branch + subscription events); only admin-granted
 * complimentary rows have a null id. The daily job is the real enforcement.
 */
export function isExpiredUnbilledActiveRow(
  sub: SubscriptionRowFields,
  now: Date = new Date(),
): boolean {
  if (sub.stripeSubscriptionId != null) return false;
  if (sub.status !== "active") return false;
  const end = toMillis(sub.currentPeriodEnd);
  return end !== null && end < now.getTime();
}

export interface TierVisibilityContext {
  /** The caller's own current tier id (soft auth), if any. */
  currentTierId?: string | null;
  /** Tier id named by a VERIFIED ?grant= token, if any. */
  grantTierId?: string | null;
  /** True only when the caller passes the same check as requireAdmin. */
  isAdmin?: boolean;
}

/**
 * GET /api/subscription-tiers: hidden tiers (sortOrder < 0) are only returned
 * to admins, to their holder, or to a holder of a verified grant token.
 * Input order is preserved (the query is already sorted by sortOrder).
 */
export function selectTiersForCaller<T extends TierListItem>(
  tiers: T[],
  ctx: TierVisibilityContext = {},
): T[] {
  if (ctx.isAdmin) return tiers;
  return tiers.filter(
    (t) =>
      (t.sortOrder ?? 0) >= 0 ||
      (!!ctx.currentTierId && t.id === ctx.currentTierId) ||
      (!!ctx.grantTierId && t.id === ctx.grantTierId),
  );
}

/**
 * Resolve the tier id from a ?grant= value. Any failure (bad/expired token, missing
 * GRANT_LINK_SECRET, non-string input) means "no grant" — the public list only.
 * Never logs the token.
 */
export function resolveGrantTierId(
  grant: unknown,
  verify: (token: string) => { tierId: string },
): string | null {
  if (typeof grant !== "string" || grant.length === 0) return null;
  try {
    const payload = verify(grant);
    return typeof payload?.tierId === "string" && payload.tierId ? payload.tierId : null;
  } catch {
    return null;
  }
}

/**
 * Request bodies for the complimentary admin routes. Nothing else is accepted: the tier is
 * resolved server-side and the owner comes from the business row.
 *  - grant / extend (POST /api/admin/businesses/:id/complimentary-subscription)
 *  - claim link     (POST /api/admin/subscription/complimentary-link) = the same shape + businessId
 * `expiresAt` is an ISO datetime WITH an offset; `permanent: true` means 2099-01-01.
 */
const expiresAtFields = { expiresAt: z.string().datetime({ offset: true }) };
const permanentFields = { permanent: z.literal(true) };

export const complimentaryGrantSchema = z.union([
  z.object(expiresAtFields).strict(),
  z.object(permanentFields).strict(),
]);

export const complimentaryLinkBodySchema = z.union([
  z.object({ businessId: z.string().min(1), ...expiresAtFields }).strict(),
  z.object({ businessId: z.string().min(1), ...permanentFields }).strict(),
]);

// Raw db.execute rows can carry a Date or Postgres text ("2099-01-01 00:00:00" — `timestamp`
// columns are UTC with no zone). Normalise both to an ISO-8601 string with a trailing Z.
export function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) {
    const parsed = new Date(text.replace(" ", "T") + "Z");
    return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
  }
  return text;
}

/**
 * Mirrors the WHERE of the complimentary upsert (ON CONFLICT … WHERE) in
 * services/complimentarySubscription.ts: a row with a Stripe subscription id is a LIVE paid row
 * unless it is canceled / incomplete_expired AND its period has ended (or has no end).
 */
export function isPaidRowLive(
  sub: SubscriptionRowFields | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!sub || sub.stripeSubscriptionId == null) return false;
  if (sub.status !== "canceled" && sub.status !== "incomplete_expired") return true;
  const end = toMillis(sub.currentPeriodEnd);
  return end !== null && end >= now.getTime();
}

export const ADMIN_LIST_DEFAULT_LIMIT = 50;
export const ADMIN_LIST_MAX_LIMIT = 200;

/** GET /api/admin/businesses ?limit=: parseInt, NaN → 50, then clamped to 1..200. */
export function clampAdminListLimit(raw: unknown): number {
  const parsed = parseInt(String(raw ?? ""), 10);
  if (Number.isNaN(parsed)) return ADMIN_LIST_DEFAULT_LIMIT;
  return Math.min(ADMIN_LIST_MAX_LIMIT, Math.max(1, parsed));
}

export interface AdminSubscriptionSummary {
  tierName: string;
  tierDisplayName: string;
  isComplimentary: boolean;
  status: string | null;
  currentPeriodEnd: string | null;
  hasStripeSubscription: boolean;
}

export interface AdminSubscriptionSource {
  tierName: string;
  tierDisplayName: string;
  priceInCents: number | null;
  stripePriceId: string | null;
  status: string | null;
  currentPeriodEnd: Date | string | null;
  stripeSubscriptionId: string | null;
}

/** Additive per-row `subscription` object on GET /api/admin/businesses (no Stripe calls). */
export function buildAdminSubscriptionSummary(row: AdminSubscriptionSource): AdminSubscriptionSummary {
  return {
    tierName: row.tierName,
    tierDisplayName: row.tierDisplayName,
    isComplimentary: isComplimentaryTier({ priceInCents: row.priceInCents, stripePriceId: row.stripePriceId }),
    status: row.status ?? null,
    currentPeriodEnd: isoOrNull(row.currentPeriodEnd),
    hasStripeSubscription: !!row.stripeSubscriptionId,
  };
}
