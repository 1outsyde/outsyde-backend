/**
 * Claim = an account that exists (email, maybe name/phone) but has no way to sign in yet
 * gets a password and a username.
 *
 * Reuses the existing reset columns so nothing new is needed to verify:
 *  - 6-digit code  → reset_code_hash / reset_code_expires_at / reset_code_attempts
 *                    (verified by the unchanged POST /api/auth/forgot-password/verify-code)
 *  - one-time token → reset_token_hash / reset_token_expires_at
 *                    (from verify-code, or from a reminder email's "Claim my account" link)
 */
import { createHash, randomBytes, randomInt } from "crypto";
import type { User } from "@shared/schema";
import { storage } from "../storage";
import { isUserAllowedToAuthenticate } from "../auth";
import { sendClaimCodeEmail } from "./emails";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_RESEND_AFTER_MS = 60 * 1000;
export const LINK_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ClaimFields = Pick<User, "password" | "appleId" | "googleSub" | "email"> & { isActive?: boolean | null };

/** No password, no Apple/Google login, has an email, not disabled. */
export function isClaimable(user: ClaimFields | null | undefined): boolean {
  if (!user) return false;
  if (user.password || user.appleId || user.googleSub) return false;
  if (!user.email) return false;
  return isUserAllowedToAuthenticate(user);
}

/**
 * True when a code was issued less than CODE_RESEND_AFTER_MS ago. The code's issue time is
 * derived from its expiry (expiry = issued + CODE_TTL_MS), so no new column is needed.
 */
export function codeIssuedRecently(resetCodeExpiresAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!resetCodeExpiresAt) return false;
  const expiry = new Date(resetCodeExpiresAt).getTime();
  if (Number.isNaN(expiry) || expiry <= now.getTime()) return false;
  const issuedAt = expiry - CODE_TTL_MS;
  return now.getTime() - issuedAt < CODE_RESEND_AFTER_MS;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Emails a fresh 6-digit code unless one went out in the last minute. Never throws on email failure. */
export async function issueClaimCode(user: User): Promise<"sent" | "recent"> {
  if (codeIssuedRecently(user.resetCodeExpiresAt)) return "recent";
  const code = randomInt(100000, 1000000).toString();
  await storage.updateUser(user.id, {
    resetCodeHash: sha256(code),
    resetCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
    resetCodeAttempts: 0,
  });
  try {
    await sendClaimCodeEmail({ to: user.email!, firstName: user.firstName ?? firstNameOf(user.name), code });
  } catch (err) {
    console.error(`[AccountSetup] claim code email failed for user ${user.id}:`, err);
  }
  return "sent";
}

/** One-time token for a reminder email's "Claim my account" link (7 days). Replaces any earlier token. */
export async function issueClaimLinkToken(user: User): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  await storage.updateUser(user.id, {
    resetTokenHash: sha256(raw),
    resetTokenExpiresAt: new Date(Date.now() + LINK_TOKEN_TTL_MS),
  });
  return raw;
}

/** Same check the existing reset-password route performs. */
export function resetTokenMatches(user: Pick<User, "resetTokenHash" | "resetTokenExpiresAt">, rawToken: string, now: Date = new Date()): boolean {
  if (!user.resetTokenHash || typeof rawToken !== "string" || !rawToken) return false;
  if (sha256(rawToken) !== user.resetTokenHash) return false;
  const exp = user.resetTokenExpiresAt ? new Date(user.resetTokenExpiresAt).getTime() : NaN;
  return !Number.isNaN(exp) && exp >= now.getTime();
}

export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name || "").trim().split(/\s+/)[0];
  return first ? first : null;
}
