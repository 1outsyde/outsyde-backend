/**
 * Business, staff and photographer booking lists (Part D, approved by Legend 2026-10-18).
 *
 * A dashboard only shows bookings a business can act on or look back at. `draft` (a slot lock
 * before payment) and `pending_payment` (a customer still on the payment screen, or a walk-away
 * the Part B job expires within 15 minutes) are not bookings yet, so the lists leave them out.
 * Real requests are `pending_provider`. `?status=<one status>` returns exactly that status, the
 * same rule GET /api/business/appointments already had, so a caller can still ask for any status.
 *
 * Applied at the four dashboard routes only. The storage functions they use are also used by
 * revenue/stats, the admin list and staff earnings, which keep every row.
 */
export const HIDDEN_FROM_PROVIDER_LISTS: ReadonlySet<string> = new Set(["draft", "pending_payment"]);

export function filterProviderBookings<T extends { status?: string | null }>(rows: T[], statusParam?: unknown): T[] {
  if (typeof statusParam === "string" && statusParam.length > 0) {
    return rows.filter((r) => r.status === statusParam);
  }
  return rows.filter((r) => !HIDDEN_FROM_PROVIDER_LISTS.has(String(r.status ?? "")));
}
