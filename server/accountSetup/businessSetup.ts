/**
 * Business setup checklist (Manage Business step 3, 2026-10-28).
 *
 * One answer to "what does this business still need to set up?", read by the app's Manage business
 * hub and by the vendor site dashboards through GET /api/vendor/setup-status, so they can't disagree.
 *
 * Separate from GET /api/account-setup/status on purpose: that list (password, approval, plan, payouts,
 * username) also drives the reminder emails, and adding storefront steps there would change who gets
 * emailed. The approval, plan and payouts steps here use the same rules as that list
 * (isSubscriptionProvisioned, payoutsReady).
 *
 * Also holds the business cancellation policy rules used by PUT /api/vendor/my-business/cancellation-policy.
 */
import { z } from "zod";
import { isSubscriptionProvisioned, type SubscriptionRowFields, type TierPriceFields } from "../complimentary";
import { payoutsReady } from "../search/searchReady";
import { MIN_DEPOSIT_CENTS } from "../deposits";

// ── Cancellation policy ────────────────────────────────────────────────────────

export const REFUND_WINDOWS = ["1_week", "48_hours", "24_hours", "1_hour", "never"] as const;

export interface BusinessCancellationPolicy {
  fullRefundWindow: (typeof REFUND_WINDOWS)[number];
  hasPartialRefund: boolean;
  partialRefundWindow: (typeof REFUND_WINDOWS)[number] | null;
  partialRefundPercentage: number | null;
  hasCancellationFee: boolean;
  cancellationFeeType: "flat" | "percentage" | null;
  cancellationFeeAmount: number | null;
}

export const POLICY_KEYS = [
  "fullRefundWindow",
  "hasPartialRefund",
  "partialRefundWindow",
  "partialRefundPercentage",
  "hasCancellationFee",
  "cancellationFeeType",
  "cancellationFeeAmount",
] as const;

// Same field rules as the service create/update schemas (routes.ts), so a policy saved here can be
// copied onto any service unchanged.
const policySchema = z.object({
  fullRefundWindow: z.enum(REFUND_WINDOWS),
  hasPartialRefund: z.boolean().optional(),
  partialRefundWindow: z.enum(REFUND_WINDOWS).nullable().optional(),
  partialRefundPercentage: z.number().int().min(0).max(100).nullable().optional(),
  hasCancellationFee: z.boolean().optional(),
  cancellationFeeType: z.enum(["flat", "percentage"]).nullable().optional(),
  cancellationFeeAmount: z.number().int().min(0).nullable().optional(),
});

/**
 * Validates a whole business policy (the save replaces all seven fields). A part that is switched off
 * has its fields cleared, so the stored row never carries a hidden percentage or fee.
 */
export function parseCancellationPolicy(
  body: unknown,
): { ok: true; policy: BusinessCancellationPolicy } | { ok: false; error: string } {
  const parsed = policySchema.safeParse(body ?? {});
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    const field = first?.path?.join(".") || "policy";
    return { ok: false, error: field === "fullRefundWindow" ? "Choose when customers get a full refund" : `${field} is not valid` };
  }
  const p = parsed.data;
  const hasPartialRefund = p.hasPartialRefund === true;
  const hasCancellationFee = p.hasCancellationFee === true;

  if (hasPartialRefund) {
    if (p.partialRefundPercentage == null || p.partialRefundPercentage < 1) {
      return { ok: false, error: "Enter the percentage customers get back" };
    }
  }
  if (hasCancellationFee) {
    if (!p.cancellationFeeType) return { ok: false, error: "Choose a flat or percentage cancellation fee" };
    if (p.cancellationFeeAmount == null || p.cancellationFeeAmount < 1) {
      return { ok: false, error: "Enter the cancellation fee" };
    }
    if (p.cancellationFeeType === "percentage" && p.cancellationFeeAmount > 100) {
      return { ok: false, error: "A percentage fee can't be more than 100" };
    }
  }

  return {
    ok: true,
    policy: {
      fullRefundWindow: p.fullRefundWindow,
      hasPartialRefund,
      partialRefundWindow: hasPartialRefund ? (p.partialRefundWindow ?? null) : null,
      partialRefundPercentage: hasPartialRefund ? (p.partialRefundPercentage ?? null) : null,
      hasCancellationFee,
      cancellationFeeType: hasCancellationFee ? (p.cancellationFeeType ?? null) : null,
      cancellationFeeAmount: hasCancellationFee ? (p.cancellationFeeAmount ?? null) : null,
    },
  };
}

// ── Default deposit ────────────────────────────────────────────────────────────

/**
 * Business default deposit (pre-fills NEW services only). null or 0 = no default. Otherwise at least
 * $7.00, the same minimum as service deposits. It can't be checked against a price here; the service
 * save still checks the deposit against that service's price.
 */
export function parseDefaultDeposit(
  value: unknown,
): { ok: true; value: number | null } | { ok: false; message: string } {
  if (value === null || value === 0) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, message: "Default deposit must be a whole number of cents." };
  }
  if (value < MIN_DEPOSIT_CENTS) return { ok: false, message: "Deposit must be at least $7.00." };
  if (value > 10_000_000) return { ok: false, message: "Default deposit is too large." };
  return { ok: true, value };
}

// ── Checklist ──────────────────────────────────────────────────────────────────

export type BusinessStepKey =
  | "approval"
  | "first_item"
  | "product_photos"
  | "service_photos"
  | "hours"
  | "cancellation_policy"
  | "terms"
  | "payouts"
  | "plan";
export type BusinessStepState = "done" | "todo" | "waiting";
/** The Manage business page that fixes the step (matches the app's SetupTarget). */
export type BusinessStepTarget = "products" | "services" | "hours" | "booking" | "payouts" | null;

export interface BusinessSetupStep {
  key: BusinessStepKey;
  state: BusinessStepState;
  label: string;
  target: BusinessStepTarget;
  /** Items still missing something (photos), when it applies. */
  missingCount?: number;
}

export interface BusinessSetupStatus {
  businessId: string;
  complete: boolean;
  next: BusinessStepKey | null;
  doneCount: number;
  totalCount: number;
  steps: BusinessSetupStep[];
}

interface ItemLike {
  name: string;
  imageUrl?: string | null;
  status?: string | null;
}

export interface BusinessSetupInput {
  businessId: string;
  approvalStatus: string | null;
  hasServicesFlag: boolean | null;
  products: ItemLike[];
  services: ItemLike[];
  hoursOfOperation: unknown;
  vendorTermsAndConditions: string | null;
  cancellationPolicySetAt: Date | string | null;
  subscription: SubscriptionRowFields | null;
  tier: TierPriceFields | null;
  payoutsComplete: boolean;
  now?: Date;
}

/** At least one day that is not marked closed. Handles both the app format and the legacy one. */
export function hasOpenHours(raw: unknown): boolean {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).some((day) => {
    if (!day || typeof day !== "object") return false;
    const d = day as { closed?: unknown; open?: unknown; isAvailable?: unknown };
    if (d.closed === true || d.open === false || d.isAvailable === false) return false;
    return true;
  });
}

const notArchived = (list: ItemLike[]) => list.filter((i) => i.status !== "archived");

function photoLabel(missing: ItemLike[], noun: "products" | "services"): string {
  if (missing.length === 0) return noun === "products" ? "Add a photo to every product" : "Add a photo to every service";
  if (missing.length === 1) return `Add a photo to ${missing[0].name}`;
  return `Add photos to ${missing.length} ${noun}`;
}

/** Pure: facts about a business → the ordered checklist. */
export function computeBusinessSetupSteps(input: BusinessSetupInput): BusinessSetupStatus {
  const products = notArchived(input.products);
  const services = notArchived(input.services);
  const offersServices = Boolean(input.hasServicesFlag) || services.length > 0;
  const approved = (input.approvalStatus || "pending") === "approved";
  const steps: BusinessSetupStep[] = [];
  const add = (s: BusinessSetupStep) => steps.push(s);

  if (!approved) {
    add({ key: "approval", state: "waiting", label: "Business approval", target: null });
  }

  add({
    key: "first_item",
    state: products.length + services.length > 0 ? "done" : "todo",
    label: "Add your first product or service",
    target: products.length === 0 && offersServices ? "services" : "products",
  });

  if (products.length > 0) {
    const missing = products.filter((p) => !p.imageUrl);
    add({ key: "product_photos", state: missing.length ? "todo" : "done", label: photoLabel(missing, "products"), target: "products", missingCount: missing.length });
  }
  if (services.length > 0) {
    const missing = services.filter((s) => !s.imageUrl);
    add({ key: "service_photos", state: missing.length ? "todo" : "done", label: photoLabel(missing, "services"), target: "services", missingCount: missing.length });
  }

  if (offersServices) {
    add({ key: "hours", state: hasOpenHours(input.hoursOfOperation) ? "done" : "todo", label: "Set your hours", target: "hours" });
    add({
      key: "cancellation_policy",
      state: input.cancellationPolicySetAt ? "done" : "todo",
      label: "Choose your cancellation policy",
      target: "booking",
    });
    add({
      key: "terms",
      state: input.vendorTermsAndConditions && input.vendorTermsAndConditions.trim() ? "done" : "todo",
      label: "Add your business terms",
      target: "booking",
    });
  }

  if (approved) {
    add({ key: "payouts", state: input.payoutsComplete ? "done" : "todo", label: "Connect payouts with Stripe", target: "payouts" });
    const planDone = isSubscriptionProvisioned(input.subscription, input.tier, input.now ?? new Date());
    add({ key: "plan", state: planDone ? "done" : "todo", label: "Choose your plan", target: "payouts" });
  }

  const doneCount = steps.filter((s) => s.state === "done").length;
  return {
    businessId: input.businessId,
    complete: steps.every((s) => s.state === "done"),
    next: steps.find((s) => s.state === "todo")?.key ?? null,
    doneCount,
    totalCount: steps.length,
    steps,
  };
}

export { payoutsReady };
