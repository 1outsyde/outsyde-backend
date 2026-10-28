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
 *   Password reset (/api/auth/forgot-password, /send-code, /verify-code, /api/auth/reset-password)
 *     - per email: 5 per 15 min (stops code guessing and email floods to one person).
 *     - per visitor backstop: 30 per 15 min.
 * The visitor key is `quickSignupKey`: goutsyde.com's own visitor address when it proves itself
 * with OUTSYDE_PROXY_KEY, otherwise the caller's address (req.ip). Login and reset never share a count.
 *
 * 429 bodies keep a top level `message` string (what the app and the vendor sites show) and add
 * `code: "RATE_LIMITED"`; login also carries `error: { code, message }` like its 401s, which the
 * goutsyde.com login BFFs read.
 */
import type { Request } from "express";
import rateLimit from "express-rate-limit";
import { quickSignupKey } from "./quickSignup";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ID_LENGTH = 254;

export const LOGIN_LIMIT_MESSAGE = "Too many tries. Please wait a few minutes and try again.";
export const RESET_LIMIT_MESSAGE = "Too many requests. Please wait a few minutes and try again.";

const text = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase().slice(0, MAX_ID_LENGTH) : "");
const networkKey = (req: Request) => `net:${quickSignupKey(req)}`;

/** The account a login names, in the same order the login handlers resolve it (email, username, identifier). */
export function loginAccountKey(req: Request): string {
  const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const id = text(b.email) || text(b.username) || text(b.identifier);
  return id ? `acct:${id}` : networkKey(req);
}

export function resetEmailKey(req: Request): string {
  const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const email = text(b.email);
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
  keyGenerator: (req) => networkKey(req),
  message: loginBody,
});

export const loginAccountLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10,
  standardHeaders: true,
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

export const resetEmailLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => resetEmailKey(req),
  message: resetBody,
});

/** Middleware chains for the routes. */
export const loginLimits = [loginNetworkLimiter, loginAccountLimiter];
export const resetLimits = [resetNetworkLimiter, resetEmailLimiter];
