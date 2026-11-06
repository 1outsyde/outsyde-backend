/**
 * Change email (migration 107, Legend 2026-11-06). Step 1 of 4: backend only.
 *
 *   POST   /api/auth/email-change/request  { newEmail, password? }  signed in (Bearer or session)
 *   POST   /api/auth/email-change/confirm  { code }                 signed in
 *   GET    /api/auth/email-change                                   the open request, or null
 *   DELETE /api/auth/email-change                                   cancel the open request
 *
 * Flow: the user asks for a new address, a 6 digit code goes to the NEW address (proves they own it), and
 * entering the code moves users.email. Legend's calls: a password is required when the account has one
 * (Google or Apple only accounts have none and need just the code), other devices stay signed in (tokens
 * carry only the user id), and the OLD address gets a "your email was changed" notice.
 *
 * Guards:
 *  - Admin accounts can't use this, and admin addresses can't be chosen: admin access is decided by email in
 *    several places (requirePlatformAdmin, quotes, estimates, Google admin sign up).
 *  - users.email is unique but case sensitive while every lookup ignores case, so "taken" is checked
 *    lowercased at request time AND again inside the confirm statement (two users racing for one address).
 *  - Only an HMAC of the code is stored; 15 minutes; 5 tries per code; 5 requests per user per hour.
 *  - The code email is never written to the email log (same rule as password codes, Legend 2026-10-16).
 *
 * After a confirm: the user's Stripe customer email is updated (an alert to Outsyde if that fails), the
 * user's own linked staff profiles and pending staff invites that carried the old address follow it, and an
 * audit log row is written. Everything else that emails a user reads users.email when it sends.
 */
import type { Express, Request, Response } from "express";
import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { storage } from "../storage";
import { getUserIdFromRequest, isUserAllowedToAuthenticate } from "../auth";

export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_TRIES = 5;
export const MAX_REQUESTS_PER_HOUR = 5;

/** Addresses that grant admin access somewhere in the backend. Never a change target. */
export const ADMIN_EMAILS = ["info@goutsyde.com", "jamesmeyers2304@gmail.com"];

export const isAdminAddress = (email: string | null | undefined): boolean =>
  !!email && ADMIN_EMAILS.includes(email.trim().toLowerCase());

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const requestBodySchema = z.object({
  newEmail: z.string().trim().min(3).max(254).email(),
  password: z.string().min(1).max(200).optional(),
}).strict();

export const confirmBodySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
}).strict();

/* ───────────────────────────── Code ───────────────────────────── */

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function codeSecret(): string {
  const s = process.env.EMAIL_CHANGE_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
}

/** Bound to the request id, so a code from one request never works on another. */
export function hashCode(requestId: string, code: string): string {
  return createHmac("sha256", codeSecret()).update(`${requestId}:${code}`).digest("hex");
}

export function codeMatches(requestId: string, code: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(requestId, code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ───────────────────────────── Emails ───────────────────────────── */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function buildCodeEmail(code: string): { subject: string; html: string } {
  return {
    subject: "Your Outsyde email change code",
    html: `
      <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1A3C34;">Outsyde</h2>
        <p>Use this code to confirm this is your new email address on Outsyde.</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 20px; background: #f5f5f5; border-radius: 8px; margin: 16px 0;">${code}</div>
        <p style="color: #666;">This code expires in 15 minutes. If you didn't ask to change your email, you can ignore this message and nothing will change.</p>
        <p style="color: #999; font-size: 12px;">Outsyde Team</p>
      </div>`,
  };
}

export function buildChangedNotice(newEmail: string): { subject: string; html: string } {
  return {
    subject: "Your Outsyde email was changed",
    html: `
      <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1A3C34;">Outsyde</h2>
        <p>The email on your Outsyde account was changed to <strong>${esc(newEmail)}</strong>. From now on, sign in and receive your Outsyde emails at that address.</p>
        <p>If you didn't make this change, contact us right away at <a href="mailto:info@goutsyde.com">info@goutsyde.com</a> so we can secure your account.</p>
        <p style="color: #999; font-size: 12px;">Outsyde Team</p>
      </div>`,
  };
}

/* ───────────────────────────── Dependencies (swapped in tests) ───────────────────────────── */

export const emailChangeDeps = {
  /** Code email: never logged. */
  sendCode: async (to: string, code: string): Promise<boolean> => {
    const { sendAdminEmail } = await import("../emailService");
    const e = buildCodeEmail(code);
    return sendAdminEmail({ to, subject: e.subject, html: e.html });
  },
  /** Notice to the old address: logged as an account email. */
  sendChangedNotice: async (to: string, newEmail: string): Promise<boolean> => {
    const { sendAdminEmail } = await import("../emailService");
    const e = buildChangedNotice(newEmail);
    return sendAdminEmail({ to, subject: e.subject, html: e.html, log: { kind: "account", label: "Email changed" } });
  },
  updateStripeCustomerEmail: async (customerId: string, email: string): Promise<void> => {
    const { getUncachableStripeClient } = await import("../stripe/stripeClient");
    const stripe = await getUncachableStripeClient();
    await stripe.customers.update(customerId, { email });
  },
  alertOutsyde: async (subject: string, text: string): Promise<void> => {
    try {
      const { sendAdminEmail, ADMIN_NOTIFICATION_EMAIL } = await import("../emailService");
      await sendAdminEmail({ to: ADMIN_NOTIFICATION_EMAIL, subject: `[Account] Action needed: ${subject}`, html: `<p>${esc(text)}</p>` });
    } catch (e) { console.error("[EmailChange] admin alert failed:", e); }
  },
  now: (): Date => new Date(),
};

/* ───────────────────────────── Service ───────────────────────────── */

export interface ServiceResult { status: number; body: Record<string, unknown> }
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): ServiceResult =>
  ({ status, body: { success: false, error: { code, message }, ...extra } });

export type PasswordVerifier = (password: string, hash: string) => Promise<boolean>;

interface PendingRow { id: string; newEmail: string; codeHash: string; expiresAt: Date; attempts: number }

async function loadPending(userId: string): Promise<PendingRow | null> {
  const r = await db.execute(sql`
    SELECT id, new_email, code_hash, expires_at, attempts FROM email_change_requests
     WHERE user_id = ${userId} AND status = 'pending' LIMIT 1`);
  const row = r.rows[0] as any;
  if (!row) return null;
  return { id: row.id, newEmail: row.new_email, codeHash: row.code_hash, expiresAt: new Date(row.expires_at), attempts: Number(row.attempts) };
}

/** Another account already uses this address (any letter case). */
async function emailTakenByOther(email: string, userId: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM users WHERE lower(email) = ${email} AND id <> ${userId} LIMIT 1`);
  return r.rows.length > 0;
}

const isUniqueViolation = (e: any) =>
  (e?.code ?? e?.cause?.code) === "23505" || /duplicate key|unique constraint/i.test(String(e?.message ?? ""));

async function loadEligibleUser(userId: string): Promise<{ user: any } | ServiceResult> {
  const user: any = await storage.getUser(userId);
  if (!user || !isUserAllowedToAuthenticate(user) || (user.deletionStatus && user.deletionStatus !== "active")) {
    return fail(403, "ACCOUNT_UNAVAILABLE", "This account can't change its email.");
  }
  if (user.isAdmin || isAdminAddress(user.email)) {
    return fail(403, "ADMIN_ACCOUNT", "Admin accounts can't change their email here.");
  }
  return { user };
}

export async function requestEmailChange(p: { userId: string; body: unknown; verifyPassword: PasswordVerifier }): Promise<ServiceResult> {
  const parsed = requestBodySchema.safeParse(p.body);
  if (!parsed.success) return fail(400, "INVALID_EMAIL", "Enter a valid email address.");
  const newEmail = normalizeEmail(parsed.data.newEmail);

  const loaded = await loadEligibleUser(p.userId);
  if ("status" in loaded) return loaded;
  const { user } = loaded;

  if (user.email && normalizeEmail(user.email) === newEmail) return fail(400, "SAME_EMAIL", "That's already your email.");
  if (isAdminAddress(newEmail)) return fail(400, "EMAIL_NOT_ALLOWED", "This email can't be used.");

  // Password when the account has one (Google or Apple only accounts have none: the code alone proves it).
  if (user.password) {
    if (!parsed.data.password) return fail(400, "PASSWORD_REQUIRED", "Enter your password to change your email.");
    let ok = false;
    try { ok = await p.verifyPassword(parsed.data.password, user.password); } catch { ok = false; }
    if (!ok) return fail(401, "WRONG_PASSWORD", "That password isn't right.");
  }

  if (await emailTakenByOther(newEmail, user.id)) return fail(409, "EMAIL_TAKEN", "This email is already used by another Outsyde account.");

  const now = emailChangeDeps.now();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const recent = await db.execute(sql`
    SELECT count(*)::int AS n FROM email_change_requests WHERE user_id = ${user.id} AND created_at > ${hourAgo.toISOString()}::timestamptz`);
  if (Number((recent.rows[0] as any)?.n ?? 0) >= MAX_REQUESTS_PER_HOUR) {
    return fail(429, "TOO_MANY_REQUESTS", "Too many tries. Please wait an hour and try again.");
  }

  // One statement: the old open request is replaced and the new one saved (one pending per user, index 107).
  const id = (await db.execute(sql`SELECT gen_random_uuid()::varchar AS id`)).rows[0] as any;
  const requestId = String(id.id);
  const code = generateCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  try {
    await db.execute(sql`
      WITH old AS (
        UPDATE email_change_requests SET status = 'replaced', cancelled_at = now()
         WHERE user_id = ${user.id} AND status = 'pending' RETURNING id
      )
      INSERT INTO email_change_requests (id, user_id, old_email, new_email, code_hash, expires_at)
      SELECT ${requestId}, ${user.id}, ${user.email ?? null}, ${newEmail}, ${hashCode(requestId, code)}, ${expiresAt.toISOString()}::timestamptz
        FROM (SELECT count(*) FROM old) _`);
  } catch (e) {
    if (isUniqueViolation(e)) return fail(409, "REQUEST_BUSY", "Your last request is still being set up. Try again in a moment.");
    throw e;
  }

  let sent = false;
  try { sent = await emailChangeDeps.sendCode(newEmail, code); } catch { sent = false; }
  if (!sent) {
    await db.execute(sql`UPDATE email_change_requests SET status = 'cancelled', cancelled_at = now() WHERE id = ${requestId} AND status = 'pending'`);
    return fail(502, "EMAIL_FAILED", "We couldn't send the code to that address. Check it and try again.");
  }
  return { status: 200, body: { success: true, pending: { newEmail, expiresAt: expiresAt.toISOString() } } };
}

export async function confirmEmailChange(p: { userId: string; body: unknown; ip?: string | null; userAgent?: string | null }): Promise<ServiceResult> {
  const parsed = confirmBodySchema.safeParse(p.body);
  if (!parsed.success) return fail(400, "INVALID_CODE", "Enter the 6 digit code.");

  const loaded = await loadEligibleUser(p.userId);
  if ("status" in loaded) return loaded;
  const { user } = loaded;

  const pending = await loadPending(user.id);
  if (!pending) return fail(404, "NO_PENDING", "There's no email change waiting. Start again.");
  const now = emailChangeDeps.now();
  if (pending.expiresAt.getTime() <= now.getTime()) {
    await db.execute(sql`UPDATE email_change_requests SET status = 'expired' WHERE id = ${pending.id} AND status = 'pending'`);
    return fail(410, "CODE_EXPIRED", "This code expired. Ask for a new one.");
  }

  // Count the try first (atomic), so parallel guesses can't get past the limit.
  const tried = await db.execute(sql`
    UPDATE email_change_requests SET attempts = attempts + 1
     WHERE id = ${pending.id} AND status = 'pending' AND attempts < ${MAX_CODE_TRIES}
    RETURNING attempts`);
  const attemptsRow = tried.rows[0] as any;
  if (!attemptsRow) {
    await db.execute(sql`UPDATE email_change_requests SET status = 'expired' WHERE id = ${pending.id} AND status = 'pending'`);
    return fail(429, "TOO_MANY_TRIES", "Too many wrong codes. Ask for a new one.");
  }
  if (!codeMatches(pending.id, parsed.data.code, pending.codeHash)) {
    const left = MAX_CODE_TRIES - Number(attemptsRow.attempts);
    if (left <= 0) {
      await db.execute(sql`UPDATE email_change_requests SET status = 'expired' WHERE id = ${pending.id} AND status = 'pending'`);
      return fail(429, "TOO_MANY_TRIES", "Too many wrong codes. Ask for a new one.");
    }
    return fail(400, "WRONG_CODE", "That code isn't right.", { triesLeft: left });
  }

  if (isAdminAddress(pending.newEmail)) return fail(400, "EMAIL_NOT_ALLOWED", "This email can't be used.");
  const oldEmail: string | null = user.email ?? null;

  // One statement: the email moves only if the request is still open and no other account took the address
  // since; then the request closes, and the user's own staff profiles and pending invites that carried the
  // old address follow it. The exact unique constraint backs up the lowercase check on a race.
  let moved = false;
  try {
    const r = await db.execute(sql`
      WITH u AS (
        UPDATE users SET email = ${pending.newEmail}
         WHERE id = ${user.id}
           AND EXISTS (SELECT 1 FROM email_change_requests r WHERE r.id = ${pending.id} AND r.status = 'pending')
           AND NOT EXISTS (SELECT 1 FROM users x WHERE lower(x.email) = ${pending.newEmail} AND x.id <> ${user.id})
        RETURNING id
      ),
      req AS (
        UPDATE email_change_requests SET status = 'confirmed', confirmed_at = now()
         WHERE id = ${pending.id} AND status = 'pending' AND EXISTS (SELECT 1 FROM u)
        RETURNING id
      ),
      staff AS (
        UPDATE staff_members SET email = ${pending.newEmail}
         WHERE user_id = ${user.id} AND ${oldEmail}::text IS NOT NULL AND lower(email) = lower(${oldEmail}::text)
           AND EXISTS (SELECT 1 FROM u)
        RETURNING id
      ),
      inv AS (
        UPDATE staff_invites SET email = ${pending.newEmail}
         WHERE status = 'pending' AND ${oldEmail}::text IS NOT NULL AND lower(email) = lower(${oldEmail}::text)
           AND EXISTS (SELECT 1 FROM u)
        RETURNING id
      )
      SELECT (SELECT count(*) FROM u)::int AS moved, (SELECT count(*) FROM staff)::int AS staff, (SELECT count(*) FROM inv)::int AS invites`);
    moved = Number((r.rows[0] as any)?.moved ?? 0) === 1;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  if (!moved) {
    await db.execute(sql`UPDATE email_change_requests SET status = 'cancelled', cancelled_at = now() WHERE id = ${pending.id} AND status = 'pending'`);
    return fail(409, "EMAIL_TAKEN", "This email was just taken by another Outsyde account. Choose a different one.");
  }

  // Stripe keeps its own copy of the email (receipts, Checkout). Best effort; Outsyde is told on failure.
  if (user.stripeCustomerId) {
    try {
      await emailChangeDeps.updateStripeCustomerEmail(user.stripeCustomerId, pending.newEmail);
    } catch (e) {
      console.error(`[EmailChange] Stripe customer ${user.stripeCustomerId} email update failed:`, e instanceof Error ? e.message : "unknown error");
      await emailChangeDeps.alertOutsyde("Update a Stripe customer email",
        `User ${user.id} changed their Outsyde email to ${pending.newEmail}, but Stripe customer ${user.stripeCustomerId} could not be updated. Change the customer's email in Stripe.`);
    }
  }

  await storage.createAuditLog({
    actorId: user.id, actorType: "user", action: "user.email_change", targetType: "user", targetId: user.id,
    beforeState: { email: oldEmail } as any, afterState: { email: pending.newEmail } as any,
    metadata: { requestId: pending.id }, ipAddress: p.ip ?? null, userAgent: p.userAgent ?? null,
  } as any).catch((e: unknown) => console.error("[EmailChange] audit failed:", e));

  if (oldEmail) {
    try { await emailChangeDeps.sendChangedNotice(oldEmail, pending.newEmail); }
    catch (e) { console.error("[EmailChange] notice to the old address failed:", e); }
  }

  return { status: 200, body: { success: true, email: pending.newEmail } };
}

export async function getPendingEmailChange(userId: string): Promise<ServiceResult> {
  const pending = await loadPending(userId);
  if (!pending || pending.expiresAt.getTime() <= emailChangeDeps.now().getTime()) {
    return { status: 200, body: { success: true, pending: null } };
  }
  return {
    status: 200,
    body: { success: true, pending: { newEmail: pending.newEmail, expiresAt: pending.expiresAt.toISOString(), triesLeft: Math.max(0, MAX_CODE_TRIES - pending.attempts) } },
  };
}

export async function cancelEmailChange(userId: string): Promise<ServiceResult> {
  const r = await db.execute(sql`
    UPDATE email_change_requests SET status = 'cancelled', cancelled_at = now()
     WHERE user_id = ${userId} AND status = 'pending' RETURNING id`);
  return { status: 200, body: { success: true, cancelled: r.rows.length > 0 } };
}

/* ───────────────────────────── Routes ───────────────────────────── */

export function registerEmailChangeRoutes(app: Express, opts: { verifyPassword: PasswordVerifier }): void {
  const withUser = (handler: (userId: string, req: Request) => Promise<ServiceResult>) =>
    async (req: Request, res: Response) => {
      const userId = getUserIdFromRequest(req);
      if (!userId) return res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "Please sign in." } });
      try {
        const out = await handler(userId, req);
        res.status(out.status).json(out.body);
      } catch (e) {
        console.error("[EmailChange] error:", e instanceof Error ? e.message : e);
        res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Something went wrong. Please try again." } });
      }
    };

  app.post("/api/auth/email-change/request", withUser((userId, req) =>
    requestEmailChange({ userId, body: req.body, verifyPassword: opts.verifyPassword })));
  app.post("/api/auth/email-change/confirm", withUser((userId, req) =>
    confirmEmailChange({ userId, body: req.body, ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null })));
  app.get("/api/auth/email-change", withUser((userId) => getPendingEmailChange(userId)));
  app.delete("/api/auth/email-change", withUser((userId) => cancelEmailChange(userId)));
}
