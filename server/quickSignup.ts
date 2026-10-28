/**
 * Quick sign up on goutsyde.com event pages (p4-quicksignup, 2026-10-28).
 *
 * POST /api/auth/customer/quick-signup  { firstName, email, phone, password }
 * Reuses handleCustomerSignup (same account, tokens, admin notice, referral code) with:
 *   - only the quick fields passed on (source is always 'outsyde-web-event'),
 *   - phone required (10+ digits) → 400 PHONE_REQUIRED,
 *   - an existing email → 409 EMAIL_EXISTS (the regular route answers 400 "Email already registered"),
 *   - its own limiter: 60 per 15 minutes per visitor network.
 *
 * Visitor address: goutsyde.com calls this route from its server, so req.ip is Vercel's address.
 * goutsyde.com proves itself with `x-outsyde-proxy-key` (OUTSYDE_PROXY_KEY on both sides) and sends
 * the visitor's address in `x-outsyde-client-ip`. The header is trusted only when the env key is set,
 * is 32+ characters and matches exactly. Otherwise the limiter keys on req.ip (today's behavior).
 */
import crypto from "crypto";
import net from "net";
import type { Request, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

export const QUICK_SIGNUP_SOURCE = "outsyde-web-event";
export const QUICK_SIGNUP_LIMIT_MESSAGE = "Too many sign ups from this network. Please try again in a few minutes.";
const MIN_PROXY_KEY_LENGTH = 32;

function headerValue(req: Request, name: string): string | null {
  const v = req.headers?.[name];
  if (typeof v === "string") return v;
  return null; // missing, or sent more than once
}

function proxyKeyMatches(sent: string | null, expected: string | undefined): boolean {
  if (!expected || expected.length < MIN_PROXY_KEY_LENGTH || !sent) return false;
  const a = Buffer.from(sent, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Limiter key: the visitor's address when goutsyde.com proves itself, otherwise req.ip. */
export function quickSignupKey(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  if (proxyKeyMatches(headerValue(req, "x-outsyde-proxy-key"), env.OUTSYDE_PROXY_KEY)) {
    const clientIp = headerValue(req, "x-outsyde-client-ip")?.trim() ?? "";
    if (clientIp && net.isIP(clientIp) !== 0) return ipKeyGenerator(clientIp);
  }
  return req.ip ? ipKeyGenerator(req.ip) : "unknown";
}

export const quickSignupRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => quickSignupKey(req),
  message: {
    success: false,
    code: "RATE_LIMITED",
    error: QUICK_SIGNUP_LIMIT_MESSAGE,
    message: QUICK_SIGNUP_LIMIT_MESSAGE,
  },
});

const asText = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function makeQuickSignupHandler(
  signup: RequestHandler,
  getUserByEmail: (email: string) => Promise<unknown | undefined>,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      if (phone.replace(/\D/g, "").length < 10) {
        return res.status(400).json({
          success: false,
          code: "PHONE_REQUIRED",
          error: "Enter a phone number with at least 10 digits.",
          message: "Enter a phone number with at least 10 digits.",
        });
      }
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (email && (await getUserByEmail(email))) {
        return res.status(409).json({
          success: false,
          code: "EMAIL_EXISTS",
          error: "That email already has an Outsyde account.",
          message: "That email already has an Outsyde account.",
        });
      }
      // Only the quick fields go on. No username, invite or referral code, or profile fields.
      req.body = {
        firstName: asText(body.firstName)?.trim(),
        email: email || asText(body.email),
        phone,
        password: asText(body.password),
        source: QUICK_SIGNUP_SOURCE,
      };
      return signup(req, res, next);
    } catch (err) {
      console.error("[quick-signup] error:", err);
      return res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Signup failed" });
    }
  };
}
