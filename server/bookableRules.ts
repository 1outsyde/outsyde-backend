/**
 * Pure booking rules (no database), shared by server/bookableService.ts. See that file for the why.
 */

/** Shown as is by the vendor sites (they print the backend message), so: plain words, no dashes. */
export const SERVICE_UNAVAILABLE_MESSAGE =
  "This service isn't available to book right now. Please choose another service.";

export function isServiceBookable(svc: { status?: string | null; isActive?: boolean | null } | null | undefined): boolean {
  return !!svc && svc.status === "live" && svc.isActive === true;
}

export function ownsService(serviceOwnerId: string | null | undefined, providerId: string): boolean {
  return !!serviceOwnerId && !!providerId && serviceOwnerId === providerId;
}

/** A paid (Stripe) plan that is no longer active by policy, i.e. past its 7 day grace. */
export function planLapsedFromPolicy(
  row: { stripeSubscriptionId?: string | null } | null | undefined,
  policyActive: boolean,
): boolean {
  return !!row?.stripeSubscriptionId && !policyActive;
}
