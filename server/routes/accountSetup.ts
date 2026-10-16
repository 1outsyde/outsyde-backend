/**
 * /api/account-setup — finish-your-account endpoints shared by OutsydeCapture and goutsyde.com.
 *
 *   GET  /status        (auth)  what this user still needs to do
 *   POST /username      (auth)  set a username when the account has none
 *   POST /send-code             email a 6-digit code to a passwordless account (always 200)
 *   POST /claim                 code-verified token + password (+ username) → signed in
 *   GET  /unsubscribe           one-click stop for setup reminder emails
 *
 * Existing routes are untouched: /api/auth/forgot-password/verify-code turns the emailed code into
 * the resetToken that /claim consumes.
 */
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  authMiddleware,
  hashPassword,
  generateAccessToken,
  generateRefreshToken,
  REFRESH_TOKEN_EXPIRY_MS,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  type AuthenticatedRequest,
  type TokenPayload,
} from "../auth";
import { validateUsername } from "../usernameUtils";
import { sanitizeUserForResponse } from "../routes";
import { getAccountSetupStatus } from "../accountSetup/status";
import { isClaimable, issueClaimCode, resetTokenMatches } from "../accountSetup/claim";
import { verifyUnsubscribeSig } from "../accountSetup/emails";
import { sendDueReminders, previewReminderEmail } from "../accountSetup/reminders";
import { requirePlatformAdmin } from "../middleware/requirePlatformAdmin";
import { getBudget } from "../emailHistory";

const router = Router();

const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many attempts, please try again later" } },
});

const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many attempts, please try again later" } },
});

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ success: false, error: { code, message, ...extra } });
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

// ── status ──────────────────────────────────────────────────────────────────

router.get("/status", authMiddleware, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
  try {
    const status = await getAccountSetupStatus(userId, { syncStripe: true });
    if (!status) return fail(res, 404, "NOT_FOUND", "User not found");
    res.json({ success: true, ...status });
  } catch (err) {
    console.error("[AccountSetup] status error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load your setup steps");
  }
});

// ── username (first one only) ───────────────────────────────────────────────

router.post("/username", authMiddleware, claimLimiter, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
  try {
    const user = await storage.getUser(userId);
    if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
    if (user.username) return fail(res, 409, "ALREADY_SET", "You already have a username. Change it in Settings.");

    const v = validateUsername(req.body?.username);
    if (!v.valid || !v.cleaned) return fail(res, 400, "INVALID_USERNAME", v.reason || "Invalid username", { reason: v.reason });

    const taken = await storage.getUserByUsername(v.cleaned);
    if (taken && taken.id !== user.id) return fail(res, 409, "USERNAME_TAKEN", "That username is taken. Try another.");

    try {
      await storage.updateUser(user.id, { username: v.cleaned });
    } catch (err) {
      if (isUniqueViolation(err)) return fail(res, 409, "USERNAME_TAKEN", "That username is taken. Try another.");
      throw err;
    }
    res.json({ success: true, username: v.cleaned });
  } catch (err) {
    console.error("[AccountSetup] username error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not save your username");
  }
});

// ── send a claim code ───────────────────────────────────────────────────────

router.post("/send-code", codeLimiter, async (req: Request, res: Response) => {
  const ok = () => res.json({ success: true, message: "If that account needs setting up, we emailed a 6-digit code." });
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase().trim() : "";
    if (!email) return fail(res, 400, "INVALID_INPUT", "Email is required");
    const user = await storage.getUserByEmail(email);
    if (!user || !isClaimable(user)) return ok();
    await issueClaimCode(user);
    return ok();
  } catch (err) {
    console.error("[AccountSetup] send-code error:", err);
    return ok();
  }
});

// ── claim ───────────────────────────────────────────────────────────────────

const claimSchema = z.object({
  email: z.string().min(3),
  resetToken: z.string().min(10),
  newPassword: z.string(),
  username: z.string().optional(),
});

router.post("/claim", claimLimiter, async (req: Request, res: Response) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_INPUT", "Email, code token and password are required");
  const { email, resetToken, newPassword, username } = parsed.data;

  try {
    const user = await storage.getUserByEmail(email.toLowerCase().trim());
    if (!user || !resetTokenMatches(user, resetToken)) {
      return fail(res, 400, "INVALID_TOKEN", "This link or code has expired. Request a new code.");
    }
    if (!isClaimable(user)) {
      return fail(res, 409, "ALREADY_CLAIMED", "This account already has a password. Sign in, or use Forgot password.");
    }
    if (newPassword.length < 6) {
      return fail(res, 400, "INVALID_PASSWORD", "Password must be at least 6 characters");
    }

    const updates: Record<string, unknown> = {
      password: await hashPassword(newPassword),
      resetTokenHash: null,
      resetTokenExpiresAt: null,
      resetCodeHash: null,
      resetCodeExpiresAt: null,
      resetCodeAttempts: 0,
    };

    if (!user.username) {
      if (!username) return fail(res, 400, "USERNAME_REQUIRED", "Pick a username to finish your account");
      const v = validateUsername(username);
      if (!v.valid || !v.cleaned) return fail(res, 400, "INVALID_USERNAME", v.reason || "Invalid username", { reason: v.reason });
      const taken = await storage.getUserByUsername(v.cleaned);
      if (taken && taken.id !== user.id) return fail(res, 409, "USERNAME_TAKEN", "That username is taken. Try another.");
      updates.username = v.cleaned;
    }

    let updated;
    try {
      updated = await storage.updateUser(user.id, updates as any);
    } catch (err) {
      if (isUniqueViolation(err)) return fail(res, 409, "USERNAME_TAKEN", "That username is taken. Try another.");
      throw err;
    }
    if (!updated) return fail(res, 404, "NOT_FOUND", "User not found");

    await storage.revokeAllUserRefreshTokens(updated.id);

    // Same token + session issue as POST /api/auth/mobile/login, so clients reuse their login handling.
    const tokenPayload: TokenPayload = {
      userId: updated.id,
      isVendor: updated.isVendor || false,
      isPhotographer: updated.isPhotographer || false,
      isAdmin: updated.isAdmin || false,
    };
    if (updated.isVendor || updated.isAdmin) {
      const business = await storage.getBusinessByOwnerId(updated.id);
      if (business) tokenPayload.businessId = business.id;
    }
    if (updated.isPhotographer) {
      const photographer = await storage.getPhotographerByUserId(updated.id);
      if (photographer) tokenPayload.photographerId = photographer.id;
    }
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);
    await storage.storeRefreshToken(updated.id, refreshToken, new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS));

    if (req.session) {
      req.session.userId = updated.id;
      req.session.role = updated.isAdmin ? "admin" : updated.isVendor ? "vendor" : updated.isPhotographer ? "photographer" : "consumer";
      req.session.isPhotographer = updated.isPhotographer || false;
      req.session.isVendor = updated.isVendor || false;
      if (tokenPayload.businessId) req.session.businessId = tokenPayload.businessId;
      if (tokenPayload.photographerId) req.session.photographerId = tokenPayload.photographerId;
    }

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: REFRESH_TOKEN_EXPIRY_MS,
      path: "/",
    });

    console.log(`[AccountSetup] account claimed: ${updated.id}`);
    res.json({
      success: true,
      user: sanitizeUserForResponse(updated, { includeOwnData: true }),
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    });
  } catch (err) {
    console.error("[AccountSetup] claim error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not finish your account. Please try again.");
  }
});

// ── unsubscribe ─────────────────────────────────────────────────────────────

function unsubscribePage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#04100d;color:#F5F0E6;font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box">
<main style="max-width:420px;text-align:center"><div style="color:#E8B930;letter-spacing:.2em;font-weight:700;margin-bottom:16px">OUTSYDE</div><h1 style="font-size:24px;margin:0 0 12px">${title}</h1><p style="color:rgba(245,240,230,.75);line-height:1.6;margin:0">${body}</p></main></body></html>`;
}

async function handleUnsubscribe(req: Request, res: Response) {
  const userId = String((req.query.u ?? req.body?.u) || "");
  const sig = String((req.query.s ?? req.body?.s) || "");
  if (!verifyUnsubscribeSig(userId, sig)) {
    return res.status(400).type("html").send(unsubscribePage("This link isn't valid", "Reply to any Outsyde email or write info@goutsyde.com and we'll stop the reminders."));
  }
  try {
    await db.execute(sql`INSERT INTO account_setup_optouts (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`);
    res.type("html").send(unsubscribePage("You're unsubscribed", "You won't get any more account setup reminders. Order and booking emails still arrive as usual."));
  } catch (err) {
    console.error("[AccountSetup] unsubscribe error:", err);
    res.status(500).type("html").send(unsubscribePage("Something went wrong", "Please try the link again, or write info@goutsyde.com."));
  }
}

router.get("/unsubscribe", handleUnsubscribe);
router.post("/unsubscribe", handleUnsubscribe); // RFC 8058 one-click (List-Unsubscribe-Post)

export default router;

// ── admin: preview + manual send ────────────────────────────────────────────
// Mounted at /api/admin/account-setup. Preview never writes anything.

export const accountSetupAdminRouter = Router();

accountSetupAdminRouter.get("/preview", requirePlatformAdmin, async (_req: Request, res: Response) => {
  try {
    const results = await sendDueReminders({ dryRun: true });
    res.json({ success: true, count: results.length, reminders: results });
  } catch (err) {
    console.error("[AccountSetup] preview error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not build the reminder preview");
  }
});

/**
 * The exact email one account would get right now (subject, html, text), built but never sent.
 * Writes nothing: no Stripe self heal, no reminder log, and claim emails show a placeholder link.
 */
accountSetupAdminRouter.get("/preview/:userId/email", requirePlatformAdmin, async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId || "");
    if (!userId || userId.length > 100) return fail(res, 400, "INVALID_USER_ID", "userId is required");
    const preview = await previewReminderEmail(userId);
    if (!preview) return fail(res, 404, "NOT_DUE", "Nothing is due for this account right now");
    res.json({ success: true, ...preview });
  } catch (err) {
    console.error("[AccountSetup] email preview error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not build the email preview");
  }
});

/** Max people per manual send (goutsyde.com/admin/account-setup sends the ones ticked). */
export const MAX_PICKED_USERS = 200;

accountSetupAdminRouter.post("/send", requirePlatformAdmin, async (req: Request, res: Response) => {
  try {
    const dryRun = req.body?.dryRun !== false;
    const raw = req.body?.userIds;
    let userIds: string[] | undefined;
    if (raw !== undefined) {
      if (
        !Array.isArray(raw) ||
        raw.length === 0 ||
        raw.length > MAX_PICKED_USERS ||
        !raw.every((v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 100)
      ) {
        return fail(res, 400, "INVALID_USER_IDS", `userIds must be a list of 1–${MAX_PICKED_USERS} account ids`);
      }
      userIds = Array.from(new Set(raw as string[]));
    }
    if (!dryRun) {
      // Daily limit (emails started from the admin page, see emailHistory.ts): count what would go out first.
      const planned = (await sendDueReminders({ dryRun: true, userIds })).length;
      const budget = await getBudget();
      if (budget.remaining !== null && planned > budget.remaining) {
        return fail(res, 429, "OVER_DAILY_LIMIT",
          `This would send ${planned} emails, but only ${budget.remaining} are left today. Send fewer people or try tomorrow.`,
          { budget, planned });
      }
    }
    const adminId = (req as unknown as { adminUser?: { id?: string } }).adminUser?.id ?? null;
    const results = await sendDueReminders({ dryRun, userIds, sentBy: dryRun ? null : adminId });
    const handled = new Set(results.map((r) => r.userId));
    res.json({
      success: true,
      dryRun,
      sent: results.filter((r) => r.outcome === "sent").length,
      failed: results.filter((r) => r.outcome === "failed").length,
      reminders: results,
      // Picked accounts with nothing due right now (already emailed, finished, opted out, or not found).
      ...(userIds ? { notDue: userIds.filter((id) => !handled.has(id)) } : {}),
    });
  } catch (err) {
    console.error("[AccountSetup] send error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not send reminders");
  }
});
