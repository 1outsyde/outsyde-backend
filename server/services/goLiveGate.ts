/**
 * Go-live authorization + Stripe provisioning chokepoint.
 *
 * Single function (authorizeAndProvisionGoLive) that:
 *   1. Enforces Connect onboarding completion.
 *   2. Enforces active vendor subscription.
 *   3. Provisions (or rotates the Price on) the vendor's Stripe catalog item
 *      in their own Connect account.
 *
 * Both go-live routes (POST /api/vendor/products/:id/go-live and
 * POST /api/vendor/services/:id/go-live) and the price-change-while-live
 * path in the two PATCH routes call this function exclusively — no other
 * code site talks to Stripe for vendor catalog provisioning.
 */

import { storage } from '../storage';
import { stripeService } from '../stripe/stripeService';
import { getUncachableStripeClient } from '../stripe/stripeClient';
import type { Business } from '@shared/schema';

// ─── Typed errors ─────────────────────────────────────────────────────────────

/**
 * Thrown by authorizeAndProvisionGoLive when a gate condition is not met.
 * The caller maps this to HTTP 409 { code, message }.
 */
export class GoLiveError extends Error {
  constructor(
    public readonly code: 'connect_incomplete' | 'subscription_inactive',
    message: string,
  ) {
    super(message);
    this.name = 'GoLiveError';
  }
}

// ─── Shared types ─────────────────────────────────────────────────────────────

/**
 * Minimal item view the chokepoint needs.
 * Pass the current DB values for stripeProductId/stripePriceId and the
 * *desired* price (may differ from the currently stored price on price-change).
 */
export interface GoLiveItem {
  id: string;
  name: string;
  description?: string | null;
  /** Desired price in cents (the value that should end up as the active Stripe Price). */
  price: number;
  stripeProductId?: string | null;
  stripePriceId?: string | null;
}

export interface GoLiveResult {
  stripeProductId: string;
  stripePriceId: string;
}

// ─── Chokepoint ───────────────────────────────────────────────────────────────

/**
 * Authorize + provision a vendor catalog item for go-live.
 *
 * Authoritative fields (VERIFIED in codebase):
 *
 *   Connect onboarding:
 *     - businesses.stripeAccountId   — non-null means a Connect account exists.
 *     - businesses.stripeOnboardingComplete — set to true by the account.updated
 *       webhook handler (webhookHandlers.ts:handleConnectAccountUpdated) when
 *       account.charges_enabled && account.details_submitted are both true.
 *       A self-healing Stripe API check runs here if the local flag is stale.
 *
 *   Subscription:
 *     - vendorSubscriptions.status evaluated by storage.isBusinessSubscriptionActive().
 *       This is the authoritative gate field; businesses.subscriptionActive is a
 *       denormalized copy that can diverge and is NOT used here.
 *
 * Throws GoLiveError on auth failure — caller converts to HTTP 409.
 *
 * Idempotency contract:
 *   - item.stripeProductId == null         → create Product + Price on connected account.
 *   - stripeProductId set, stripePriceId null → create new Price, set as product default.
 *   - Both set, price unchanged            → return existing IDs, zero Stripe API calls.
 *   - Both set, price changed              → new Price, set as default, archive old Price.
 *     Product ID is never duplicated; only Prices rotate.
 */
export async function authorizeAndProvisionGoLive(
  item: GoLiveItem,
  business: Business,
  kind: 'service' | 'product',
): Promise<GoLiveResult> {

  // ── Gate 1: Connect onboarding ────────────────────────────────────────────
  // Authoritative: businesses.stripeAccountId (non-null) AND
  //                businesses.stripeOnboardingComplete (boolean).
  // Self-healing: if the local flag is stale, fetch live status from Stripe and sync.
  let onboardingComplete = business.stripeOnboardingComplete ?? false;
  if (!onboardingComplete && business.stripeAccountId) {
    onboardingComplete = await stripeService.syncOnboardingStatus({
      entityType: 'business',
      entityId: business.id,
      stripeAccountId: business.stripeAccountId,
      currentOnboardingComplete: false,
      updateFn: (id, data) => storage.updateBusiness(id, data),
    });
  }

  if (!business.stripeAccountId || !onboardingComplete) {
    throw new GoLiveError(
      'connect_incomplete',
      'Stripe Connect onboarding must be completed before publishing.',
    );
  }

  // ── Gate 2: Active subscription ───────────────────────────────────────────
  // Authoritative: vendorSubscriptions.status (via isBusinessSubscriptionActive).
  // businesses.subscriptionActive is a denormalized flag that can diverge from the
  // vendorSubscriptions table; we gate exclusively on the latter.
  const subStatus = await storage.isBusinessSubscriptionActive(business.id);
  if (!subStatus.active) {
    throw new GoLiveError(
      'subscription_inactive',
      `An active subscription is required to publish items (${subStatus.reason ?? 'no active subscription'}).`,
    );
  }

  // ── Provision ─────────────────────────────────────────────────────────────
  const connectedAccountId = business.stripeAccountId;

  // Case A: No Stripe Product yet — full provision on the vendor's connected account.
  if (!item.stripeProductId) {
    const stripeProduct = await stripeService.createStripeProduct({
      name: item.name,
      description: item.description || undefined,
      metadata: {
        type: kind === 'service' ? 'vendor_service' : 'vendor_product',
        itemId: item.id,
        businessId: business.id,
      },
      connectedAccountId,
    });

    const stripePrice = await stripeService.createStripePrice({
      productId: stripeProduct.id,
      unitAmountCents: item.price,
      connectedAccountId,
    });

    return { stripeProductId: stripeProduct.id, stripePriceId: stripePrice.id };
  }

  // Case B: Product exists but no active Price (e.g. after archive then re-publish).
  if (!item.stripePriceId) {
    const stripePrice = await stripeService.createStripePrice({
      productId: item.stripeProductId,
      unitAmountCents: item.price,
      connectedAccountId,
    });

    const stripe = await getUncachableStripeClient();
    await stripe.products.update(
      item.stripeProductId,
      { default_price: stripePrice.id },
      { stripeAccount: connectedAccountId },
    );

    return { stripeProductId: item.stripeProductId, stripePriceId: stripePrice.id };
  }

  // Case C: Both Product and Price exist — compare live Stripe amount vs. desired.
  const stripe = await getUncachableStripeClient();
  const currentStripePrice = await stripe.prices.retrieve(
    item.stripePriceId,
    {},
    { stripeAccount: connectedAccountId },
  );

  if ((currentStripePrice.unit_amount ?? null) === item.price) {
    // Price unchanged — idempotent, no Stripe API calls needed.
    return { stripeProductId: item.stripeProductId, stripePriceId: item.stripePriceId };
  }

  // Price changed: create new Price → set as default → archive old Price.
  // Product ID is never duplicated.
  const newStripePrice = await stripeService.createStripePrice({
    productId: item.stripeProductId,
    unitAmountCents: item.price,
    connectedAccountId,
  });

  await stripe.products.update(
    item.stripeProductId,
    { default_price: newStripePrice.id },
    { stripeAccount: connectedAccountId },
  );

  await stripeService.deactivateStripePrice(item.stripePriceId, connectedAccountId);

  return { stripeProductId: item.stripeProductId, stripePriceId: newStripePrice.id };
}
