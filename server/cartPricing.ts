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
 * Kept free of Express, Stripe and the db client so it can be tested directly
 * (server/cartPricing.test.ts) with in-memory lookups.
 */

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
}

export type CartPricingError = {
  code:
    | 'PRODUCT_VENDOR_MISMATCH'
    | 'PRODUCT_UNAVAILABLE'
    | 'INVALID_VARIANT'
    | 'VARIANT_REQUIRED'
    | 'INSUFFICIENT_STOCK';
  message: string;
  productId?: string;
  available?: number;
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
      const { variantId: _ignoredVariant, ...rest } = item;
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
            message: stock <= 0 ? `${what} is out of stock` : `Only ${stock} of ${what} available`,
            productId: product.id,
            available: Math.max(0, stock),
          },
        };
      }
    }

    const { variantId: _clientVariant, ...rest } = item;
    lines.push({
      ...rest,
      productId: product.id,
      name: product.name,
      priceCents: variant ? (variant.priceCents ?? product.price) : product.price,
      ...(variant ? { variantId: variant.id, variantLabel: variant.label } : {}),
      dbPriced: true,
    });
  }

  return { ok: true, lines };
}

/** The shape stored in orders.items. variantId/variantLabel only when a variant was bought. */
export function toOrderItem(line: PricedCartLine): {
  // Typed as string to match orders.items; legacy lines with no product have
  // always been stored without one (unchanged from before this file existed).
  productId: string;
  name: string;
  quantity: number;
  price: number;
  variantId?: string;
  variantLabel?: string;
} {
  return {
    productId: line.productId as string,
    name: line.name,
    quantity: line.quantity,
    price: line.priceCents,
    ...(line.variantId ? { variantId: line.variantId, variantLabel: line.variantLabel } : {}),
  };
}
