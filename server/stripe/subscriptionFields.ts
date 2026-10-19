/**
 * Read Stripe subscription and invoice fields across API versions.
 *
 * The live webhook endpoint sends API 2025-06-30.basil and stripe-node 20 (no pinned version) reads
 * 2025-11-17.clover. From basil on, Stripe moved:
 *   - subscription.current_period_start / _end  -> subscription.items.data[].current_period_start / _end
 *   - invoice.subscription                       -> invoice.parent.subscription_details.subscription
 * Older payloads still carry the old fields. These helpers read the new field first, then the old one,
 * and never throw: a missing value comes back as null so callers can skip that write instead of
 * crashing (new Date(undefined * 1000) is an Invalid Date that drizzle rejects with a RangeError).
 */

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && typeof (value as any).id === 'string') return (value as any).id;
  return null;
}

function unixToDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const d = new Date(value * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface SubscriptionPeriod {
  start: Date;
  end: Date;
}

/**
 * The subscription's current billing period. basil/clover: from its items (earliest start, latest end;
 * Outsyde subscriptions have one item). Older versions: the top-level fields. null when neither is usable.
 */
export function getSubscriptionPeriod(subscription: any): SubscriptionPeriod | null {
  if (!subscription || typeof subscription !== 'object') return null;

  const items: any[] = Array.isArray(subscription.items?.data) ? subscription.items.data : [];
  let start: Date | null = null;
  let end: Date | null = null;
  for (const item of items) {
    const s = unixToDate(item?.current_period_start);
    const e = unixToDate(item?.current_period_end);
    if (s && (!start || s < start)) start = s;
    if (e && (!end || e > end)) end = e;
  }

  if (!start) start = unixToDate(subscription.current_period_start);
  if (!end) end = unixToDate(subscription.current_period_end);

  if (!start || !end) return null;
  return { start, end };
}

/**
 * The id of the subscription an invoice belongs to, or null for a one-off invoice.
 * basil/clover: invoice.parent.subscription_details.subscription (or a line item's
 * parent.subscription_item_details.subscription). Older versions: invoice.subscription.
 */
export function getInvoiceSubscriptionId(invoice: any): string | null {
  if (!invoice || typeof invoice !== 'object') return null;

  const fromParent = idOf(invoice.parent?.subscription_details?.subscription);
  if (fromParent) return fromParent;

  const legacy = idOf(invoice.subscription);
  if (legacy) return legacy;

  const lines: any[] = Array.isArray(invoice.lines?.data) ? invoice.lines.data : [];
  for (const line of lines) {
    const fromLine =
      idOf(line?.parent?.subscription_item_details?.subscription) ?? idOf(line?.subscription);
    if (fromLine) return fromLine;
  }
  return null;
}
