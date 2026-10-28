/**
 * Login and password reset limits (p4-loginlimit, 2026-10-28).
 *
 * Before: one shared `strictAuthRateLimiter` (5 per 15 min per network address, every request
 * counted) on login AND password reset. goutsyde.com and the vendor sites call the backend from
 * their own servers, so all of a site's visitors shared those 5 tries.
 *
 * Now:
 *   Login (/api/auth/login, /api/auth/mobile/login)
 *     - per account: 10 failed tries per 15 min per email or username (any case). Successes don't count.
 *     - per visitor backstop: 100 failed tries per 15 min (stops one source trying many accounts).
 *   Password reset
 *     - asking for a code or link (/api/auth/forgot-password, /send-code): 5 per 15 min per email
 *       (stops email floods to one person).
 *     - using a code or link (/verify-code, /api/auth/reset-password): 15 per 15 min per email
 *       (each code also allows only 5 wrong entries, routes.ts verify-code).
 *     - per visitor backstop on all four: 30 per 15 min.
 *   Login and reset fields that are not strings (an array email, say) get a 400 before any lookup,
 *   so the account key and the user lookup can never disagree.
 * The visitor key is `quickSignupKey`: goutsyde.com's own visitor address when it proves itself
 * with OUTSYDE_PROXY_KEY, otherwise the caller's address (req.ip). Login and reset never share a count.
 *
 * 429 bodies keep a top level `message` string (what the app and the vendor sites show) and add
 * `code: "RATE_LIMITED"` and `error: { code, message }` (the shape of the login 401s, which the
 * goutsyde.com login BFFs read). A 429 is never counted as a failure by the login backstop.
 */
import type { Request, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { quickSignupKey } from "./quickSignup";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ID_LENGTH = 254;

export const LOGIN_LIMIT_MESSAGE = "Too many tries. Please wait a few minutes and try again.";
export const RESET_LIMIT_MESSAGE = "Too many requests. Please wait a few minutes and try again.";

const text = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase().slice(0, MAX_ID_LENGTH) : "");
// validateUsername (usernameUtils.ts) drops one leading "@", so "@maya" and "maya" are one account.
const asUsername = (v: unknown): string => text(v).replace(/^@/, "");
const networkKey = (req: Request) => `net:${quickSignupKey(req)}`;
const bodyOf = (req: Request) => (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

/** The account a login names, in the same order the login handlers resolve it (email, username, identifier). */
export function loginAccountKey(req: Request): string {
  const b = bodyOf(req);
  let id = text(b.email) || asUsername(b.username);
  if (!id && typeof b.identifier === "string") {
    const isEmail = b.identifier.includes("@") && b.identifier.includes(".");
    id = isEmail ? text(b.identifier) : asUsername(b.identifier);
  }
  return id ? `acct:${id}` : networkKey(req);
}

/** First of `fields` that is present but not a string, else null. */
export function badAuthFields(body: unknown, fields: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const f of fields) {
    if (b[f] !== undefined && b[f] !== null && typeof b[f] !== "string") return f;
  }
  return null;
}

function stringFieldsOnly(fields: string[]): RequestHandler {
  return (req, res, next) => {
    const bad = badAuthFields(req.body, fields);
    if (!bad) return next();
    const message = "Please check what you typed and try again.";
    return res.status(400).json({ success: false, message, error: { code: "INVALID_INPUT", message } });
  };
}

export function resetEmailKey(req: Request): string {
  const email = text(bodyOf(req).email);
  return email ? `email:${email}` : networkKey(req);
}

const loginBody = { success: false, code: "RATE_LIMITED", message: LOGIN_LIMIT_MESSAGE, error: { code: "RATE_LIMITED", message: LOGIN_LIMIT_MESSAGE } };
const resetBody = { success: false, code: "RATE_LIMITED", message: RESET_LIMIT_MESSAGE, error: { code: "RATE_LIMITED", message: RESET_LIMIT_MESSAGE } };

export const loginNetworkLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // A 429 from the account count is not a new failure: a locked person clicking again must not
  // use up the count shared by everyone on the same site.
  requestWasSuccessful: (_req, res) => res.statusCode < 400 || res.statusCode === 429,
  keyGenerator: (req) => networkKey(req),
  message: loginBody,
});

export const loginAccountLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10,
  // No RateLimit headers: they would tell anyone how many tries are left on someone's account.
  standardHeaders: false,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => loginAccountKey(req),
  message: loginBody,
});

export const resetNetworkLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => networkKey(req),
  message: resetBody,
});

export const resetRequestEmailLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 5,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => resetEmailKey(req),
  message: resetBody,
});

export const resetUseEmailLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 15,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => resetEmailKey(req),
  message: resetBody,
});

/** Middleware chains for the routes. */
export const loginLimits = [stringFieldsOnly(["email", "username", "identifier", "password"]), loginNetworkLimiter, loginAccountLimiter];
/** /api/auth/forgot-password and /api/auth/forgot-password/send-code */
export const resetRequestLimits = [stringFieldsOnly(["email"]), resetNetworkLimiter, resetRequestEmailLimiter];
/** /api/auth/forgot-password/verify-code and /api/auth/reset-password */
export const resetUseLimits = [stringFieldsOnly(["email"]), resetNetworkLimiter, resetUseEmailLimiter];
