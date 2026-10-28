/**
 * Cart line pricing for POST /api/cart/payment-intent.
 *
 * Every line that names a real product (productId matches a vendor_products row)
 * is priced from the database: the picked variant's price when a variant is
 * given, otherwise the product's price. The line is also checked for the right
 * vendor, live status, variant choice and stock.
 *
 * Lines that do not name a real product (no productId, an external product, the
 * app's production-shoot credit line "shoot_booking") keep the price the client
 * sent, exactly as before this change, and are logged. A later step will refuse
 * them once every client sends real product ids.
 *
 * Add-ons (migration 075, server/productAddons.ts): only a line that carries an
 * `addons` array is checked and priced for add-ons. Old app builds send no such
 * key, so their lines are priced exactly as before and are never refused for a
 * required add-on group (decision, Oct 28). The unit price on a line with
 * add-ons is the variant or product price plus the add-ons' prices.
 *
 * Kept free of Express, Stripe and the db client so it can be tested directly
 * (server/cartPricing.test.ts) with in-memory lookups.
 */

import { priceLineAddons, addonsLabel, type AddonGroupWithChoices, type AddonCheckoutError, type PricedAddon } from './productAddons';

export interface CartLineInput {
  productId?: string | null;
  variantId?: string | null;
  vendorId: string;
  priceCents: number;
  quantity: number;
  name?: string;
  [key: string]: unknown;
}

export interface PricedCartLine extends CartLineInput {
  priceCents: number;
  name: string;
  variantId?: string;
  variantLabel?: string;
  /** true when the price came from the database, false for a legacy client-priced line */
  dbPriced: boolean;
  /** Only on lines bought with add-ons: the unit price without them */
  basePriceCents?: number;
  addons?: PricedAddon[];
  addonsLabel?: string;
}

export interface ProductRow {
  id: string;
  businessId: string;
  name: string;
  price: number;
  inventory: number | null;
  trackInventory: boolean | null;
  isActive: boolean | null;
  status: string;
}

export interface VariantRow {
  id: string;
  productId: string;
  label: string;
  /** null = use the product's price (migration 049) */
  priceCents: number | null;
  inventory: number | null;
  trackInventory: boolean | null;
  isActive: boolean | null;
}

export interface CartPricingDeps {
  getProduct(id: string): Promise<ProductRow | undefined>;
  /** active variants only */
  getActiveVariants(productId: string): Promise<VariantRow[]>;
  logLegacyLine?(line: CartLineInput): void;
  /** All add-on groups of a product with their choices (active or not). Needed only when a line sends add-ons. */
  getAddonGroups?(productId: string): Promise<AddonGroupWithChoices[]>;
}

export type CartPricingError = {
  code:
    | 'PRODUCT_VENDOR_MISMATCH'
    | 'PRODUCT_UNAVAILABLE'
    | 'INVALID_VARIANT'
    | 'VARIANT_REQUIRED'
    | 'INSUFFICIENT_STOCK'
    | AddonCheckoutError['code'];
  message: string;
  productId?: string;
};

export type CartPricingResult =
  | { ok: true; lines: PricedCartLine[] }
  | { ok: false; error: CartPricingError };

/**
 * Stock that applies to a purchase, using the same rule as decrementInventory
 * in webhookHandlers.ts: the variant's own count when it tracks one, otherwise
 * the product's count. null means no limit.
 */
export function effectiveStock(product: ProductRow, variant?: VariantRow): number | null {
  if (variant && variant.trackInventory !== false && variant.inventory !== null && variant.inventory !== undefined) {
    return variant.inventory;
  }
  if (product.trackInventory !== false && product.inventory !== null && product.inventory !== undefined) {
    return product.inventory;
  }
  return null;
}

export async function priceCartLines(
  items: CartLineInput[],
  deps: CartPricingDeps,
): Promise<CartPricingResult> {
  const lines: PricedCartLine[] = [];
  // Quantity of each product/variant across the whole cart, for the stock check.
  const requested = new Map<string, number>();

  for (const item of items) {
    const productId = typeof item.productId === 'string' && item.productId.length > 0 ? item.productId : null;
    const product = productId ? await deps.getProduct(productId) : undefined;

    if (!product) {
      // Legacy path: not a known product. Unchanged behavior.
      deps.logLegacyLine?.(item);
      const { variantId: _ignoredVariant, addons: _ignoredAddons, ...rest } = item;
      lines.push({ ...rest, name: item.name ?? 'Item', dbPriced: false });
      continue;
    }

    if (product.businessId !== item.vendorId) {
      return { ok: false, error: { code: 'PRODUCT_VENDOR_MISMATCH', message: 'This product does not belong to that store', productId: product.id } };
    }
    if (product.isActive === false || product.status !== 'live') {
      return { ok: false, error: { code: 'PRODUCT_UNAVAILABLE', message: `${product.name} is no longer available`, productId: product.id } };
    }

    const variants = await deps.getActiveVariants(product.id);
    let variant: VariantRow | undefined;
    if (item.variantId) {
      variant = variants.find((v) => v.id === item.variantId);
      if (!variant) {
        return { ok: false, error: { code: 'INVALID_VARIANT', message: `The option picked for ${product.name} is no longer available`, productId: product.id } };
      }
    } else if (variants.length > 0) {
      return { ok: false, error: { code: 'VARIANT_REQUIRED', message: `Choose an option for ${product.name}`, productId: product.id } };
    }

    const stock = effectiveStock(product, variant);
    if (stock !== null) {
      const key = variant && variant.trackInventory !== false && variant.inventory !== null ? `v:${variant.id}` : `p:${product.id}`;
      const total = (requested.get(key) ?? 0) + item.quantity;
      requested.set(key, total);
      if (total > stock) {
        const what = variant ? `${product.name} (${variant.label})` : product.name;
        return {
          ok: false,
          error: {
            code: 'INSUFFICIENT_STOCK',
            // Stock counts are not shown to customers (decision, Oct 28): no count in the message,
            // and no `available` field (no app or site read it).
            message: stock <= 0 ? `${what} is out of stock` : `There aren't enough of ${what} left for this order. Lower the quantity and try again.`,
            productId: product.id,
          },
        };
      }
    }

    const basePriceCents = variant ? (variant.priceCents ?? product.price) : product.price;
    let addonPart: Pick<PricedCartLine, 'basePriceCents' | 'addons' | 'addonsLabel'> = {};
    let perUnitAddons = 0;
    if (item.addons !== undefined && item.addons !== null) {
      const groups = deps.getAddonGroups ? await deps.getAddonGroups(product.id) : [];
      const priced = priceLineAddons(groups, item.addons, product.name);
      if (!priced.ok) {
        return { ok: false, error: { ...priced.error, productId: product.id } };
      }
      if (priced.addons.length > 0) {
        perUnitAddons = priced.perUnitCents;
        addonPart = { basePriceCents, addons: priced.addons, addonsLabel: addonsLabel(priced.addons) };
      }
    }

    const { variantId: _clientVariant, addons: _clientAddons, ...rest } = item;
    lines.push({
      ...rest,
      productId: product.id,
      name: product.name,
      priceCents: basePriceCents + perUnitAddons,
      ...(variant ? { variantId: variant.id, variantLabel: variant.label } : {}),
      ...addonPart,
      dbPriced: true,
    });
  }

  return { ok: true, lines };
}

/** The shape stored in orders.items. variantId/variantLabel only when a variant was bought; add-on fields only when add-ons were. */
export function toOrderItem(line: PricedCartLine): {
  // Typed as string to match orders.items; legacy lines with no product have
  // always been stored without one (unchanged from before this file existed).
  productId: string;
  name: string;
  quantity: number;
  price: number;
  variantId?: string;
  variantLabel?: string;
  basePrice?: number;
  addons?: PricedAddon[];
  addonsLabel?: string;
} {
  return {
    productId: line.productId as string,
    name: line.name,
    quantity: line.quantity,
    // Includes add-ons, so every reader that sums price × quantity stays right.
    price: line.priceCents,
    ...(line.variantId ? { variantId: line.variantId, variantLabel: line.variantLabel } : {}),
    ...(line.addons && line.addons.length > 0
      ? { basePrice: line.basePriceCents, addons: line.addons, addonsLabel: line.addonsLabel }
      : {}),
  };
}
