/**
 * Account setup status — the single answer to "what does this person still need to do?"
 *
 * Used by GET /api/account-setup/status (app + goutsyde.com /finish) and by the reminder job,
 * so the checklist people see and the reminders they get can never disagree.
 *
 * Business plan/payout rules mirror GET /api/vendor/eligibility (routes.ts) without changing it:
 *  - plan  = a vendor_subscriptions row that isSubscriptionProvisioned() accepts (paid, grandfathered,
 *            or an active complimentary/waived grant whose period has not ended)
 *  - payouts = stripe_onboarding_complete, self-healed from Stripe when an account exists
 */
import { storage } from "../storage";
import { stripeService } from "../stripe/stripeService";
import { isSubscriptionProvisioned, type SubscriptionRowFields, type TierPriceFields } from "../complimentary";

export type StepKey = "password" | "username" | "approval" | "plan" | "payouts";
export type StepState = "done" | "todo" | "waiting";
export type SetupRole = "consumer" | "business" | "photographer" | "staff";

export interface SetupStep {
  key: StepKey;
  state: StepState;
  label: string;
}

export interface SetupStatus {
  role: SetupRole;
  complete: boolean;
  /** First step the person can act on now; null when nothing is actionable. */
  next: StepKey | null;
  steps: SetupStep[];
}

export interface SetupInput {
  hasLoginMethod: boolean;
  hasUsername: boolean;
  business?: {
    approvalStatus: string | null;
    subscription: SubscriptionRowFields | null;
    tier: TierPriceFields | null;
    payoutsComplete: boolean;
  } | null;
  photographer?: { payoutsComplete: boolean } | null;
  /** Active staff rows only. */
  staff?: { payoutsComplete: boolean }[] | null;
  now?: Date;
}

const LABELS: Record<StepKey, string> = {
  password: "Create your password",
  username: "Pick your username",
  approval: "Business approval",
  plan: "Choose your plan",
  payouts: "Connect payouts with Stripe",
};

function step(key: StepKey, state: StepState): SetupStep {
  return { key, state, label: LABELS[key] };
}

/**
 * Payouts are ready only when the onboarding flag is set AND a Stripe account exists. A flag with no
 * account (e.g. Braids by Lana, Oct 2026) means payouts can't actually work, so it stays a todo.
 */
export function payoutsReady(flag: boolean | null | undefined, stripeAccountId: string | null | undefined): boolean {
  return flag === true && typeof stripeAccountId === "string" && stripeAccountId.length > 0;
}

/** Pure: turns facts about an account into the ordered checklist. */
export function computeSetupSteps(input: SetupInput): SetupStatus {
  const steps: SetupStep[] = [];
  let role: SetupRole = "consumer";

  steps.push(step("password", input.hasLoginMethod ? "done" : "todo"));

  if (input.business) {
    role = "business";
    const approved = (input.business.approvalStatus || "pending") === "approved";
    steps.push(step("approval", approved ? "done" : "waiting"));
    if (approved) {
      const planDone = isSubscriptionProvisioned(input.business.subscription, input.business.tier, input.now ?? new Date());
      steps.push(step("plan", planDone ? "done" : "todo"));
      steps.push(step("payouts", input.business.payoutsComplete ? "done" : "todo"));
    }
  } else if (input.photographer) {
    role = "photographer";
    steps.push(step("payouts", input.photographer.payoutsComplete ? "done" : "todo"));
  } else if (input.staff && input.staff.length > 0) {
    role = "staff";
    const allDone = input.staff.every((s) => s.payoutsComplete);
    steps.push(step("payouts", allDone ? "done" : "todo"));
  }

  steps.push(step("username", input.hasUsername ? "done" : "todo"));

  const next = steps.find((s) => s.state === "todo")?.key ?? null;
  const complete = steps.every((s) => s.state === "done");
  return { role, complete, next, steps };
}

/**
 * Loads everything computeSetupSteps needs for one user.
 * syncStripe=true asks Stripe about accounts the DB still marks incomplete (self-heal, same helper
 * the eligibility route uses); the status endpoint and the reminder job both pass true.
 */
export async function getAccountSetupStatus(
  userId: string,
  opts: { syncStripe?: boolean } = {},
): Promise<SetupStatus | null> {
  const user = await storage.getUser(userId);
  if (!user) return null;

  const hasLoginMethod = !!user.password || !!user.appleId || !!user.googleSub;
  const input: SetupInput = { hasLoginMethod, hasUsername: !!user.username };

  if (user.isVendor) {
    const business = await storage.getBusinessByOwnerId(user.id);
    if (business) {
      let payoutsComplete = payoutsReady(business.stripeOnboardingComplete, business.stripeAccountId);
      if (!payoutsComplete && business.stripeAccountId && opts.syncStripe) {
        payoutsComplete = await stripeService
          .syncOnboardingStatus({
            entityType: "business",
            entityId: business.id,
            stripeAccountId: business.stripeAccountId,
            currentOnboardingComplete: false,
            updateFn: (id, data) => storage.updateBusiness(id, data),
          })
          .catch(() => false);
      }
      const subscription = (await storage.getVendorSubscriptionByBusinessId(business.id)) ?? null;
      let tier: TierPriceFields | null = null;
      if (subscription?.tierId) {
        const tiers = await stripeService.getSubscriptionTiers();
        tier = (tiers.find((t: { id: string }) => t.id === subscription.tierId) as TierPriceFields | undefined) ?? null;
      }
      input.business = {
        approvalStatus: (business as { approvalStatus?: string | null }).approvalStatus ?? null,
        subscription,
        tier,
        payoutsComplete,
      };
    }
  }

  if (!input.business && user.isPhotographer) {
    const photographer = await storage.getPhotographerByUserId(user.id);
    if (photographer) {
      let payoutsComplete = payoutsReady(photographer.stripeOnboardingComplete, photographer.stripeAccountId);
      if (!payoutsComplete && photographer.stripeAccountId && opts.syncStripe) {
        payoutsComplete = await stripeService
          .syncOnboardingStatus({
            entityType: "photographer",
            entityId: photographer.id,
            stripeAccountId: photographer.stripeAccountId,
            currentOnboardingComplete: false,
            updateFn: (id, data) => storage.updatePhotographer(id, data),
          })
          .catch(() => false);
      }
      input.photographer = { payoutsComplete };
    }
  }

  if (!input.business && !input.photographer) {
    const staffRows = await storage.getStaffMembersByUserId(user.id);
    const active = staffRows.filter((s) => s.status === "active");
    if (active.length > 0) {
      input.staff = active.map((s) => ({ payoutsComplete: payoutsReady(s.stripeOnboardingComplete, s.stripeAccountId) }));
    }
  }

  return computeSetupSteps(input);
}
