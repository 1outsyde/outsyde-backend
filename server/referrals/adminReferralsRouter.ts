/**
 * Admin referrals (goutsyde.com/admin/referrals, referral Step 5b). Mounted at /api/admin/referrals, every route behind
 * requirePlatformAdmin.
 *
 *   GET  /api/admin/referrals                      { success, totals, attention, business, friends }
 *   POST /api/admin/referrals/payouts/:id/pause    { success, payout }   pending or held -> paused (job skips it)
 *   POST /api/admin/referrals/payouts/:id/release  { success, payout }   paused -> pending, due now
 *   POST /api/admin/referrals/payouts/:id/cancel   { success, payout }   pending, held or review -> cancelled (final)
 *   POST /api/admin/referrals/payouts/:id/retry    { success, payout }   review -> pending, attempts 0
 * Errors: { success: false, error: { code, message } }; 404 PAYOUT_NOT_FOUND, 409 for every other refusal.
 * Logic and rules: adminReferrals.ts. Friend referrals are view only (Legend, 2026-10-24).
 */
import { Router, type Response } from "express";
import { requirePlatformAdmin } from "../middleware/requirePlatformAdmin";
import {
  listAdminReferrals, pauseReferralPayout, releaseReferralPayout, cancelReferralPayout, retryReferralPayout,
  type AdminActionResult,
} from "./adminReferrals";

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const adminIdOf = (req: any): string => String(req.adminUser?.id ?? "");

const MESSAGES: Record<string, string> = {
  PAYOUT_SENDING: "This payout may be sending right now. Wait a few minutes, then reload and try again.",
  NOT_PAUSABLE: "Only a payout that is waiting to be sent can be paused. Reload to see where it is.",
  NOT_PAUSED: "This payout isn't paused. Reload to see where it is.",
  NOT_CANCELLABLE: "This payout was already paid or cancelled. Reload to see where it is.",
  NOT_IN_REVIEW: "This payout isn't in review any more. Reload to see where it is.",
};

export const adminReferralsRouter = Router();
adminReferralsRouter.use(requirePlatformAdmin);

adminReferralsRouter.get("/", async (_req, res) => {
  try {
    res.json({ success: true, ...(await listAdminReferrals()) });
  } catch (err) {
    console.error("[AdminReferrals] list failed:", err);
    fail(res, 500, "SERVER_ERROR", "Couldn't load referrals.");
  }
});

const ACTIONS: Record<string, (id: string, adminId: string) => Promise<AdminActionResult>> = {
  pause: pauseReferralPayout,
  release: releaseReferralPayout,
  cancel: cancelReferralPayout,
  retry: retryReferralPayout,
};
for (const [name, run] of Object.entries(ACTIONS)) {
  adminReferralsRouter.post(`/payouts/:payoutId/${name}`, async (req, res) => {
    const id = String(req.params.payoutId);
    if (!ID_RE.test(id)) return fail(res, 404, "PAYOUT_NOT_FOUND", "Payout not found.");
    try {
      const r = await run(id, adminIdOf(req));
      if (r.ok) return res.json({ success: true, payout: r.payout });
      if (r.code === "PAYOUT_NOT_FOUND") return fail(res, 404, r.code, "Payout not found.");
      return fail(res, 409, r.code, MESSAGES[r.code] ?? "Couldn't do that. Reload and try again.");
    } catch (err) {
      console.error(`[AdminReferrals] ${name} failed:`, err);
      fail(res, 500, "SERVER_ERROR", "Couldn't update this payout.");
    }
  });
}
