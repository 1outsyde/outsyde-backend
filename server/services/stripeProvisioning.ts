// Shared Stripe Connect provisioning for vendor catalog items (services + products).
// Ensures a live item always has a real Product/Price on the vendor's Connect account,
// never on the platform account, and never gets created twice for the same item.
import { stripeService } from "../stripe/stripeService";
import type { Business, VendorProduct, VendorService } from "@shared/schema";

export class ConnectNotReadyError extends Error {
  readonly code = "connect_incomplete" as const;

  constructor(message = "Complete your payment setup to publish this item.") {
    super(message);
    this.name = "ConnectNotReadyError";
  }
}

/**
 * Connect readiness = has a Connect account AND Stripe charges are enabled on it.
 * `business.stripeOnboardingComplete` is the authoritative stored flag (kept in sync by
 * the account.updated webhook — see server/stripe/webhookHandlers.ts — and self-healed via
 * stripeService.syncOnboardingStatus before go-live checks). Callers should run that sync
 * before invoking this helper so the flag reflects the latest known Stripe state.
 */
export function isBusinessConnectReady(business: Pick<Business, "stripeAccountId" | "stripeOnboardingComplete">): boolean {
  return Boolean(business.stripeAccountId) && business.stripeOnboardingComplete === true;
}

export type ProvisionableService = Pick<
  VendorService,
  "id" | "name" | "description" | "price" | "durationMinutes" | "stripeProductId" | "stripePriceId"
>;
export type ProvisionableProduct = Pick<
  VendorProduct,
  "id" | "name" | "description" | "price" | "images" | "imageUrl" | "stripeProductId" | "stripePriceId"
>;

export type ProvisionKind = "service" | "product";

export interface ProvisionResult {
  stripeProductId: string;
  stripePriceId: string;
}

/**
 * Idempotently provisions a Stripe Product + Price on the vendor's Connect account for a
 * draft->live transition.
 * - Throws ConnectNotReadyError (does not call Stripe) if the business isn't Connect-ready.
 * - Reuses the item's existing stripeProductId/stripePriceId if already set — never creates
 *   a duplicate Product. (Matches the pre-existing "already live" idempotency behavior in the
 *   go-live routes; price re-sync for already-live items remains handled separately by each
 *   route's existing price-change branch, which is out of scope here.)
 */
export async function provisionStripeForItem(
  item: ProvisionableService | ProvisionableProduct,
  business: Business,
  kind: ProvisionKind
): Promise<ProvisionResult> {
  if (!isBusinessConnectReady(business)) {
    throw new ConnectNotReadyError();
  }

  if (item.stripeProductId && item.stripePriceId) {
    return { stripeProductId: item.stripeProductId, stripePriceId: item.stripePriceId };
  }

  const isService = kind === "service";
  const service = isService ? (item as ProvisionableService) : undefined;
  const product = !isService ? (item as ProvisionableProduct) : undefined;

  const stripeProduct = await stripeService.createStripeProduct({
    name: item.name,
    description: item.description || undefined,
    metadata: {
      type: isService ? "vendor_service" : "vendor_product",
      itemId: item.id,
      businessId: business.id,
    },
    images: product ? (product.images || (product.imageUrl ? [product.imageUrl] : undefined)) : undefined,
    connectedAccountId: business.stripeAccountId!,
  });

  const stripePrice = await stripeService.createStripePrice({
    productId: stripeProduct.id,
    unitAmountCents: item.price,
    metadata: {
      ...(isService ? { vendorServiceId: item.id } : { vendorProductId: item.id }),
      businessId: business.id,
      ...(service ? { durationMinutes: String(service.durationMinutes) } : {}),
    },
    connectedAccountId: business.stripeAccountId!,
  });

  return { stripeProductId: stripeProduct.id, stripePriceId: stripePrice.id };
}
