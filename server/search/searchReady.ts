/**
 * Which businesses search may show (2026-10-21, Legend): a business shows in search, and so do its
 * products, services and staff, only once it is approved, has an active plan and has working
 * Stripe payouts. Admins still see everything (unchanged).
 *
 * "Working payouts" is the same rule as the account setup checklist (accountSetup/status.ts):
 * the onboarding flag AND a Stripe account id. A flag with no account can't take payment.
 */
export function payoutsReady(flag: boolean | null | undefined, stripeAccountId: string | null | undefined): boolean {
  return flag === true && typeof stripeAccountId === "string" && stripeAccountId.length > 0;
}

export interface SearchReadyBusinessFields {
  id: string;
  approvalStatus: string | null;
  ownerId: string | null;
  stripeOnboardingComplete: boolean | null;
  stripeAccountId: string | null;
}

/** Pure part: approved, not a demo owner, payouts working. The plan check needs the database. */
export function passesSearchBasics(b: SearchReadyBusinessFields): boolean {
  if ((b.approvalStatus || "pending") !== "approved") return false;
  if (b.ownerId?.toLowerCase().includes("demo")) return false;
  return payoutsReady(b.stripeOnboardingComplete, b.stripeAccountId);
}

/**
 * One checker per search request: each business's plan is looked up once, however many of its
 * products, services or staff come back.
 */
export function makeSearchReadyChecker(
  isPlanActive: (businessId: string) => Promise<boolean>,
  opts: { isAdmin: boolean },
): (b: SearchReadyBusinessFields) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return async (b) => {
    if (opts.isAdmin) return true;
    if (!passesSearchBasics(b)) return false;
    let p = cache.get(b.id);
    if (!p) {
      p = isPlanActive(b.id).catch(() => false);
      cache.set(b.id, p);
    }
    return p;
  };
}
