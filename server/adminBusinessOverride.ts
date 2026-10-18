// Platform admin acting on a vendor's business from a vendor site dashboard.
// Same rule as GET /api/business/orders (JWT isAdmin + ?businessId) and the product
// routes (JWT isAdmin + x-business-id header): only a token with isAdmin === true can
// pick another business, and only when it names one. Everyone else gets null, which
// means "use the business this user owns" exactly as before.

function firstId(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Returns the business id the admin asked for, or null.
 * The x-business-id header wins over the ?businessId query param.
 */
export function adminOverrideBusinessId(
  isAdmin: boolean,
  headerValue: unknown,
  queryValue: unknown,
): string | null {
  if (isAdmin !== true) return null;
  return firstId(headerValue) ?? firstId(queryValue);
}
