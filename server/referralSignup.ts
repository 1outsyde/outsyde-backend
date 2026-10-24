// server/referralSignup.ts
//
// Friend referral code at signup (2026-10-23). Customer, Google and Apple signups accept an
// optional referralCode. It is applied after the account exists and NEVER blocks the signup:
// a missing, malformed, unknown or refused code just means referralApplied: false.

import { storage } from "./storage";

export async function applyReferralAtSignup(userId: string, raw: unknown): Promise<boolean> {
  if (typeof raw !== "string") return false;
  const code = raw.trim();
  if (!code || code.length > 20) return false;
  try {
    const result = await storage.processReferral(userId, code);
    if (!result.success) {
      console.warn(`[signup] referral code not applied for user ${userId}: ${result.error}`);
    }
    return result.success;
  } catch (err) {
    console.error(`[signup] referral code failed for user ${userId}:`, err);
    return false;
  }
}
