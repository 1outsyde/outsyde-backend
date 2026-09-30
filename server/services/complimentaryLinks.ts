/**
 * Free-plan claim links (complimentary_grant_links).
 *
 * An admin creates a single-use link for one business; the business OWNER signs in and claims it,
 * which grants the complimentary ("waived") plan. Only the sha256 of the token is stored; the raw
 * token exists only in the create response and the URL the admin copies.
 *
 * Every function returns { status, body } so the routes stay thin and the behaviour is testable.
 * EVERY message below is a static string: the token and its hash are never interpolated into a
 * response, log line, audit row or error message, and failures are logged by error NAME only
 * (driver errors can echo query values).
 */

import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { complimentaryGrantLinks } from "@shared/schema";
import { storage } from "../storage";
import {
  complimentaryLinkBodySchema,
  isPaidRowLive,
  isoOrNull,
  PERMANENT_EXPIRY_ISO,
} from "../complimentary";
import { TOKEN_RE, generate as generateToken, hash as hashToken } from "../utils/complimentaryLinkToken";
import {
  PAID_ROW_LIVE_MESSAGE,
  checkPreviousStripeSubscription,
  computeConnectReady,
  getComplimentaryTier,
  runRedeemStatement,
} from "./complimentarySubscription";

export interface ServiceResult {
  status: number;
  body: Record<string, unknown>;
}

/** Claim links live for 7 days (link_expires_at); the plan end is separate (plan_expires_at). */
export const LINK_TTL_DAYS = 7;
export const LIST_LIMIT = 100;

export const LINK_MESSAGES = {
  notFound: "This link is not valid.",
  unavailable: "This link has expired, been used, or been revoked.",
  noBusiness: "No business is linked to this account.",
  wrongAccount: "This link is for another business. Sign in with the business owner's account.",
  notRedeemed: "This link could not be redeemed. Nothing was changed.",
  redeemFailed: "Failed to redeem link",
  createFailed: "Failed to create complimentary link",
  listFailed: "Failed to list complimentary links",
  revokeFailed: "Failed to revoke complimentary link",
  tierNotConfigured: "Complimentary tier is not configured",
  alreadyUsedOrRevoked: "This link was already used or revoked.",
  linkNotFound: "Link not found",
} as const;

function result(status: number, body: Record<string, unknown>): ServiceResult {
  return { status, body };
}

function coded(status: number, message: string, code: string): ServiceResult {
  return result(status, { error: message, code });
}

/** Log a failure without its message: driver errors can echo query values (token hash). */
function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

interface LinkState {
  id: string;
  businessId: string;
  createdBy: string | null;
  redeemed: boolean;
  revoked: boolean;
  linkExpired: boolean;
  planExpired: boolean;
}

/** Link lookup by token hash. Expiry is evaluated on the DATABASE clock, like the redeem statement. */
async function loadLinkByHash(tokenHash: string): Promise<LinkState | null> {
  const res = await db.execute<Record<string, unknown>>(sql`
    SELECT id, business_id, created_by,
           (redeemed_at IS NOT NULL) AS redeemed,
           (revoked_at IS NOT NULL) AS revoked,
           (link_expires_at <= (now() AT TIME ZONE 'UTC')) AS link_expired,
           (plan_expires_at IS NOT NULL AND plan_expires_at <= (now() AT TIME ZONE 'UTC')) AS plan_expired
      FROM complimentary_grant_links
     WHERE token_hash = ${tokenHash}::text
     LIMIT 1
  `);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    createdBy: row.created_by == null ? null : String(row.created_by),
    redeemed: row.redeemed === true || row.redeemed === "true" || row.redeemed === "t",
    revoked: row.revoked === true || row.revoked === "true" || row.revoked === "t",
    linkExpired: row.link_expired === true || row.link_expired === "true" || row.link_expired === "t",
    planExpired: row.plan_expired === true || row.plan_expired === "true" || row.plan_expired === "t",
  };
}

function isUnavailable(link: LinkState): boolean {
  return link.redeemed || link.revoked || link.linkExpired || link.planExpired;
}

/**
 * POST /api/admin/subscription/complimentary-link (caller already passed requireAdmin).
 * Body: { businessId, expiresAt (ISO with offset, future) | permanent: true }.
 * Same refusal rules and messages as the grant route: a live paid row is never replaced, and a
 * past payer is only accepted when Stripe confirms the old subscription is canceled.
 */
export async function createComplimentaryLink(input: { body: unknown; adminId: string }): Promise<ServiceResult> {
  try {
    const parsed = complimentaryLinkBodySchema.safeParse(input.body);
    if (!parsed.success) {
      return result(400, { error: "Invalid data", details: parsed.error.errors });
    }

    const permanent = "permanent" in parsed.data;
    const expiresAtIso = "permanent" in parsed.data
      ? PERMANENT_EXPIRY_ISO
      : new Date(parsed.data.expiresAt).toISOString();
    if (!permanent && new Date(expiresAtIso).getTime() <= Date.now()) {
      return result(400, { error: "expiresAt must be in the future" });
    }

    const business = await storage.getBusiness(parsed.data.businessId);
    if (!business) {
      return result(404, { error: "Business not found" });
    }

    const tier = await getComplimentaryTier();
    if (!tier) {
      return result(500, { error: LINK_MESSAGES.tierNotConfigured });
    }

    const existing = await storage.getVendorSubscriptionByBusinessId(business.id);
    const stripeRefusal = await checkPreviousStripeSubscription(business.id, existing?.stripeSubscriptionId);
    if (stripeRefusal) {
      return result(409, { error: stripeRefusal });
    }
    if (isPaidRowLive(existing)) {
      return result(409, { error: PAID_ROW_LIVE_MESSAGE });
    }

    const token = generateToken();
    const planExpires = permanent ? sql`NULL` : sql`(${expiresAtIso}::timestamptz AT TIME ZONE 'UTC')`;
    const inserted = await db.execute<Record<string, unknown>>(sql`
      INSERT INTO complimentary_grant_links
        (token_hash, business_id, plan_expires_at, link_expires_at, created_by)
      VALUES
        (${hashToken(token)}::text, ${business.id}::varchar, ${planExpires},
         (now() AT TIME ZONE 'UTC') + make_interval(days => ${LINK_TTL_DAYS}::int), ${input.adminId}::varchar)
      RETURNING link_expires_at
    `);

    // linkExpiresAt first: if a response body is ever truncated in a log, the token (in `url`) is last.
    return result(200, {
      linkExpiresAt: isoOrNull(inserted.rows[0]?.link_expires_at),
      url: `${process.env.FRONTEND_URL}/subscribe/free/${token}`,
    });
  } catch (error) {
    console.error("[ComplimentaryLink] create failed:", errorLabel(error));
    return result(500, { error: LINK_MESSAGES.createFailed });
  }
}

/** GET /api/admin/subscription/complimentary-links?businessId= — explicit columns, never token_hash. */
export async function listComplimentaryLinks(businessId: unknown): Promise<ServiceResult> {
  if (typeof businessId !== "string" || businessId.length === 0) {
    return result(400, { error: "businessId is required" });
  }
  try {
    const rows = await db
      .select({
        id: complimentaryGrantLinks.id,
        businessId: complimentaryGrantLinks.businessId,
        planExpiresAt: complimentaryGrantLinks.planExpiresAt,
        linkExpiresAt: complimentaryGrantLinks.linkExpiresAt,
        createdBy: complimentaryGrantLinks.createdBy,
        createdAt: complimentaryGrantLinks.createdAt,
        redeemedAt: complimentaryGrantLinks.redeemedAt,
        redeemedBy: complimentaryGrantLinks.redeemedBy,
        revokedAt: complimentaryGrantLinks.revokedAt,
      })
      .from(complimentaryGrantLinks)
      .where(eq(complimentaryGrantLinks.businessId, businessId))
      .orderBy(desc(complimentaryGrantLinks.createdAt))
      .limit(LIST_LIMIT);

    return result(200, {
      links: rows.map((r) => ({
        id: r.id,
        businessId: r.businessId,
        planExpiresAt: isoOrNull(r.planExpiresAt),
        linkExpiresAt: isoOrNull(r.linkExpiresAt),
        createdBy: r.createdBy,
        createdAt: isoOrNull(r.createdAt),
        redeemedAt: isoOrNull(r.redeemedAt),
        redeemedBy: r.redeemedBy,
        revokedAt: isoOrNull(r.revokedAt),
      })),
    });
  } catch (error) {
    console.error("[ComplimentaryLink] list failed:", errorLabel(error));
    return result(500, { error: LINK_MESSAGES.listFailed });
  }
}

/** DELETE /api/admin/subscription/complimentary-link/:id — revoke a link that is still unused. */
export async function revokeComplimentaryLink(id: string): Promise<ServiceResult> {
  try {
    const revoked = await db.execute<Record<string, unknown>>(sql`
      UPDATE complimentary_grant_links
         SET revoked_at = now() AT TIME ZONE 'UTC'
       WHERE id = ${id}::varchar AND redeemed_at IS NULL AND revoked_at IS NULL
      RETURNING id
    `);
    if (revoked.rows.length > 0) {
      return result(200, { success: true });
    }
    const known = await db.execute<Record<string, unknown>>(sql`
      SELECT 1 AS found FROM complimentary_grant_links WHERE id = ${id}::varchar LIMIT 1
    `);
    if (known.rows.length === 0) {
      return result(404, { error: LINK_MESSAGES.linkNotFound });
    }
    return result(409, { error: LINK_MESSAGES.alreadyUsedOrRevoked });
  } catch (error) {
    console.error("[ComplimentaryLink] revoke failed:", errorLabel(error));
    return result(500, { error: LINK_MESSAGES.revokeFailed });
  }
}

/**
 * POST /api/subscription/complimentary-link/redeem (caller is authenticated; userId comes from
 * the verified JWT, never from the body — the body carries only the token).
 */
export async function redeemComplimentaryLink(input: {
  token: unknown;
  userId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<ServiceResult> {
  try {
    if (typeof input.token !== "string" || !TOKEN_RE.test(input.token)) {
      return coded(404, LINK_MESSAGES.notFound, "NOT_FOUND");
    }
    const tokenHash = hashToken(input.token);

    const link = await loadLinkByHash(tokenHash);
    if (!link) return coded(404, LINK_MESSAGES.notFound, "NOT_FOUND");
    if (isUnavailable(link)) return coded(410, LINK_MESSAGES.unavailable, "LINK_UNAVAILABLE");

    const business = await storage.getBusinessByOwnerId(input.userId);
    if (!business) return coded(403, LINK_MESSAGES.noBusiness, "NO_BUSINESS");
    if (business.id !== link.businessId) return coded(403, LINK_MESSAGES.wrongAccount, "WRONG_ACCOUNT");

    const existing = await storage.getVendorSubscriptionByBusinessId(link.businessId);
    const stripeRefusal = await checkPreviousStripeSubscription(business.id, existing?.stripeSubscriptionId);
    if (stripeRefusal) return result(409, { error: stripeRefusal });

    const tier = await getComplimentaryTier();
    if (!tier) return result(500, { error: LINK_MESSAGES.tierNotConfigured });

    const subscription = await runRedeemStatement({
      tokenHash,
      userId: input.userId,
      tierId: tier.id,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    if (!subscription) {
      // A guard refused inside the statement and the link was left unused. Say why.
      const again = await loadLinkByHash(tokenHash);
      if (!again) return coded(404, LINK_MESSAGES.notFound, "NOT_FOUND");
      if (isUnavailable(again)) return coded(410, LINK_MESSAGES.unavailable, "LINK_UNAVAILABLE");
      const current = await storage.getVendorSubscriptionByBusinessId(link.businessId);
      if (isPaidRowLive(current)) return result(409, { error: PAID_ROW_LIVE_MESSAGE });
      return result(409, { error: LINK_MESSAGES.notRedeemed });
    }

    const connectReady = await computeConnectReady(business);
    return result(200, { subscription, connectReady });
  } catch (error) {
    console.error("[ComplimentaryLink] redeem failed:", errorLabel(error));
    return result(500, { error: LINK_MESSAGES.redeemFailed });
  }
}
