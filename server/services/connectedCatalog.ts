/**
 * Generic Stripe Product+Price provisioning on a Connect account.
 *
 * This is the single home for catalog-item provisioning logic.
 * It is intentionally entity-agnostic — the caller decides the connected
 * account and passes the right IDs.  Gates (onboarding, subscription,
 * approval) are the caller's responsibility; this function only talks
 * to Stripe.
 *
 * Consumers:
 *   - authorizeAndProvisionGoLive (goLiveGate.ts) — business/vendor path
 *   - PhotographerController.updateService — photographer price rotation
 *
 * STAFF-READY: pass staffMember.stripeAccountId as connectedAccountId
 * when staff go-live routes are added; no changes needed here.
 */

import { getUncachableStripeClient } from '../stripe/stripeClient';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ProvisionCatalogParams {
  /**
   * Stripe Connect account ID of the entity that owns the catalog item.
   * All Stripe calls use { stripeAccount: connectedAccountId }.
   */
  connectedAccountId: string;

  name: string;
  description?: string | null;

  /**
   * Price in cents (integer).
   * Confirmed: vendor_services.price and vendor_products.price are integer("price")
   * in shared/schema.ts — i.e. already cents, no conversion needed.
   * Photographer fields priceCents / hourlyRateCents are also integer cents.
   */
  unitAmountCents: number;
  currency?: string;

  /**
   * Current Stripe Product ID on the connected account, if already provisioned.
   * Pass null / undefined to create a fresh Product.
   */
  existingProductId?: string | null;

  /**
   * Current active Stripe Price ID on the connected account, if already provisioned.
   * Pass null / undefined when the product exists but has no active price
   * (e.g. after an archive → re-publish cycle).
   */
  existingPriceId?: string | null;
}

export interface ProvisionCatalogResult {
  stripeProductId: string;
  stripePriceId: string;
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Create or update a Stripe Product+Price on the given Connect account.
 *
 * Idempotency / rotation contract:
 *
 *   Case A  no existingProductId
 *           → products.create  then  prices.create  (both on connectedAccountId)
 *           → returns new { stripeProductId, stripePriceId }
 *
 *   Case B  existingProductId set, existingPriceId null
 *           → prices.create  then  products.update({ default_price })
 *           → returns existing productId + new stripePriceId
 *
 *   Case C  both set, Stripe unit_amount == unitAmountCents
 *           → zero Stripe API calls (idempotent re-publish)
 *           → returns existing { stripeProductId, stripePriceId }
 *
 *   Case C' both set, Stripe unit_amount != unitAmountCents  (price rotation)
 *           → prices.create (new)
 *           → products.update({ default_price: newPriceId })
 *           → prices.update(oldPriceId, { active: false })  (archive old)
 *           → returns existing productId + new stripePriceId
 *           Product ID is NEVER duplicated; only Prices rotate.
 */
export async function provisionConnectedCatalogItem(
  params: ProvisionCatalogParams,
): Promise<ProvisionCatalogResult> {
  const {
    connectedAccountId,
    name,
    description,
    unitAmountCents,
    currency = 'usd',
    existingProductId,
    existingPriceId,
  } = params;

  const stripe = await getUncachableStripeClient();
  const acct = { stripeAccount: connectedAccountId } as const;

  // ── Case A: fresh provision ────────────────────────────────────────────────
  if (!existingProductId) {
    const product = await stripe.products.create(
      { name, description: description || undefined },
      acct,
    );
    const price = await stripe.prices.create(
      { product: product.id, unit_amount: unitAmountCents, currency },
      acct,
    );
    return { stripeProductId: product.id, stripePriceId: price.id };
  }

  // ── Case B: product exists, no active price ────────────────────────────────
  if (!existingPriceId) {
    const price = await stripe.prices.create(
      { product: existingProductId, unit_amount: unitAmountCents, currency },
      acct,
    );
    await stripe.products.update(existingProductId, { default_price: price.id }, acct);
    return { stripeProductId: existingProductId, stripePriceId: price.id };
  }

  // ── Cases C / C': both exist — compare live amount ────────────────────────
  const currentPrice = await stripe.prices.retrieve(existingPriceId, {}, acct);

  if ((currentPrice.unit_amount ?? null) === unitAmountCents) {
    // Case C: price unchanged — fully idempotent, zero Stripe calls
    return { stripeProductId: existingProductId, stripePriceId: existingPriceId };
  }

  // Case C': price changed — rotate
  const newPrice = await stripe.prices.create(
    { product: existingProductId, unit_amount: unitAmountCents, currency },
    acct,
  );
  await stripe.products.update(existingProductId, { default_price: newPrice.id }, acct);
  await stripe.prices.update(existingPriceId, { active: false }, acct);

  return { stripeProductId: existingProductId, stripePriceId: newPrice.id };
}
