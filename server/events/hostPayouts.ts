/**
 * Events & Ticketing Phase 2, PR 5a: host payout accounts and readiness.
 *
 *   POST /api/events/payouts/setup-link   (auth) body { web?: boolean }  create (or replace once) my payout account, return an onboarding link
 *   GET  /api/events/payouts/status       (auth) ?hostType=user|business|photographer  { hasAccount, ready, needsSetup }
 *
 * A plain customer (hostType user) gets a Stripe Express account saved in user_payout_accounts. A business or
 * photographer host uses the account they already have (businesses / photographers .stripe_account_id).
 * isHostReady is the one check the paid publish rule and the payout job call: local flag first, then Stripe live.
 * Mounted on /api/events BEFORE eventsRouter so /payouts/* is not read as an event id.
 */
import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import { rows, fail, loadActiveUser } from "./eventsRouter";

const router = Router();

export type PayoutDestination = {
  destinationType: "user" | "business" | "photographer";
  accountId: string | null;
  localReady: boolean;
};
export type HostEventRef = {
  host_type: string;
  host_user_id: string;
  host_business_id?: string | null;
  host_photographer_id?: string | null;
};
export type ReadyReason = "no_account" | "not_complete" | "stripe_not_ready";
export type ReadinessStripe = {
  getPayoutReadiness(accountId: string): Promise<{ ready: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }>;
};

async function realStripe(): Promise<ReadinessStripe> {
  const { stripeService } = await import("../stripe/stripeService");
  return stripeService as unknown as ReadinessStripe;
}

/** Where this event's money goes, by host type, and whether our own record says that account is finished. */
export async function hostPayoutDestination(event: HostEventRef): Promise<PayoutDestination> {
  if (event.host_type === "business" && event.host_business_id) {
    const [b] = await rows<any>(sql`SELECT stripe_account_id, stripe_onboarding_complete FROM businesses WHERE id = ${event.host_business_id}`);
    return { destinationType: "business", accountId: b?.stripe_account_id ?? null, localReady: !!b?.stripe_onboarding_complete };
  }
  if (event.host_type === "photographer" && event.host_photographer_id) {
    const [p] = await rows<any>(sql`SELECT stripe_account_id, stripe_onboarding_complete FROM photographers WHERE id = ${event.host_photographer_id}`);
    return { destinationType: "photographer", accountId: p?.stripe_account_id ?? null, localReady: !!p?.stripe_onboarding_complete };
  }
  const [u] = await rows<any>(sql`SELECT stripe_account_id, onboarding_complete FROM user_payout_accounts WHERE user_id = ${event.host_user_id}`);
  return { destinationType: "user", accountId: u?.stripe_account_id ?? null, localReady: !!u?.onboarding_complete };
}

/** Can this host be paid right now? Local record first (cheap), then Stripe live (charges and payouts enabled). */
export async function isHostReady(event: HostEventRef, s?: ReadinessStripe): Promise<{ ready: boolean; reason: ReadyReason | null }> {
  const d = await hostPayoutDestination(event);
  if (!d.accountId) return { ready: false, reason: "no_account" };
  if (!d.localReady) return { ready: false, reason: "not_complete" };
  const live = await (s ?? (await realStripe())).getPayoutReadiness(d.accountId);
  if (!live.ready) return { ready: false, reason: "stripe_not_ready" };
  return { ready: true, reason: null };
}

/** Business host = the caller's approved business, photographer host = the caller's profile (same rule as event create). */
async function resolveOwnedHost(res: Response, userId: string, hostType: "business" | "photographer"): Promise<HostEventRef | null> {
  if (hostType === "business") {
    const [biz] = await rows<any>(sql`
      SELECT id, approval_status FROM businesses WHERE owner_id = ${userId}
      ORDER BY (approval_status = 'approved') DESC, created_at ASC LIMIT 1`);
    if (!biz) { fail(res, 403, "NOT_A_BUSINESS_OWNER", "You don't own a business on Outsyde."); return null; }
    if (biz.approval_status !== "approved") { fail(res, 403, "BUSINESS_NOT_APPROVED", "Your business has to be approved before it can host events."); return null; }
    return { host_type: "business", host_user_id: userId, host_business_id: biz.id, host_photographer_id: null };
  }
  const [p] = await rows<any>(sql`SELECT id FROM photographers WHERE user_id = ${userId} ORDER BY created_at ASC LIMIT 1`);
  if (!p) { fail(res, 403, "NOT_A_PHOTOGRAPHER", "You don't have a photographer profile."); return null; }
  return { host_type: "photographer", host_user_id: userId, host_business_id: null, host_photographer_id: p.id };
}

router.post("/payouts/setup-link", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to set up payouts.");
  try {
    const user = await loadActiveUser(userId);
    if (!user) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't host events.");
    const web = req.body?.web === true;
    const { stripeService, isUnreachableConnectAccountError } = await import("../stripe/stripeService");

    const [row] = await rows<any>(sql`SELECT stripe_account_id FROM user_payout_accounts WHERE user_id = ${userId}`);
    const saved: string | null = row?.stripe_account_id ?? null;

    const createAccount = async (replacing: string | null): Promise<string> => {
      const [u] = await rows<any>(sql`SELECT email FROM users WHERE id = ${userId}`);
      const account = await stripeService.createHostConnectAccount(u?.email || `host-${userId}@outsyde.app`, userId);
      if (replacing) {
        // Only swap the exact account we found unreachable; a new account starts unfinished.
        await rows(sql`
          UPDATE user_payout_accounts SET stripe_account_id = ${account.id}, onboarding_complete = false, last_event_at = NULL, updated_at = now()
          WHERE user_id = ${userId} AND stripe_account_id = ${replacing}`);
      } else {
        await rows(sql`
          INSERT INTO user_payout_accounts (user_id, stripe_account_id) VALUES (${userId}, ${account.id})
          ON CONFLICT (user_id) DO NOTHING`);
      }
      // Whatever is saved now is the account to use (a parallel request may have saved its own first).
      const [now] = await rows<any>(sql`SELECT stripe_account_id FROM user_payout_accounts WHERE user_id = ${userId}`);
      return now.stripe_account_id as string;
    };

    let accountId = saved ?? (await createAccount(null));
    const baseUrl = process.env.API_BASE_URL || "https://outsyde-backend.onrender.com";
    const type = web ? "host-web" : "host";
    const makeLink = (id: string) =>
      stripeService.createConnectOnboardingLink(
        id,
        `${baseUrl}/api/stripe/connect-refresh?account=${id}&type=${type}`,
        `${baseUrl}/api/stripe/connect-return?account=${id}&type=${type}`,
      );

    let link;
    try {
      link = await makeLink(accountId);
    } catch (err) {
      // Saved account was deleted or belongs to another platform or mode: replace it once.
      if (!saved || !isUnreachableConnectAccountError(err)) throw err;
      console.warn(`[Events] saved payout account ${saved} unreachable for user ${userId}; creating a new one`);
      accountId = await createAccount(saved);
      link = await makeLink(accountId);
    }
    return res.json({ success: true, url: link.url });
  } catch (err) {
    console.error("[Events] payout setup-link failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't start payout setup. Try again.");
  }
});

router.get("/payouts/status", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to see your payout status.");
  const hostType = String(req.query.hostType ?? "user");
  if (hostType !== "user" && hostType !== "business" && hostType !== "photographer") {
    return fail(res, 400, "INVALID_HOST_TYPE", "hostType must be user, business or photographer.");
  }
  try {
    const user = await loadActiveUser(userId);
    if (!user) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't host events.");
    const ref: HostEventRef | null = hostType === "user"
      ? { host_type: "user", host_user_id: userId, host_business_id: null, host_photographer_id: null }
      : await resolveOwnedHost(res, userId, hostType);
    if (!ref) return; // resolveOwnedHost already answered
    const dest = await hostPayoutDestination(ref);
    const { ready } = await isHostReady(ref);
    return res.json({ success: true, hostType, hasAccount: !!dest.accountId, ready, needsSetup: !ready });
  } catch (err) {
    console.error("[Events] payout status failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load your payout status.");
  }
});

export default router;
