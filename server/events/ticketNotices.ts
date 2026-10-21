/**
 * Events & Ticketing Phase 2 PR 4: emails and pushes for ticket orders.
 *
 *   buyer receipt (paid order, first settle only), with the ticket codes
 *   host push for each paid sale (no host email per sale: Resend's plan allows 100 emails a day)
 *   buyer refund email (when Stripe confirms the refund), wording by reason
 *   free RSVP guests: "event cancelled" email
 *
 * Every function here is fire and forget: it never throws, so a failed email can't undo a sale or a refund.
 * Senders are injectable so tests can check what would be sent without Resend or Expo.
 */
import { sql } from "drizzle-orm";
import { rows } from "./eventsRouter";
import type { TicketEmailEvent } from "../emailService";

export type NoticeDeps = {
  sendReceipt: (p: Parameters<typeof import("../emailService").sendTicketReceiptToBuyer>[0]) => Promise<void>;
  sendRefund: (p: Parameters<typeof import("../emailService").sendTicketRefundToBuyer>[0]) => Promise<void>;
  sendCancelled: (p: Parameters<typeof import("../emailService").sendEventCancelledToGuest>[0]) => Promise<void>;
  sendPush: (p: { userId: string; title: string; body: string; data?: Record<string, unknown> }) => Promise<boolean>;
};

let testDeps: NoticeDeps | null = null;
/** Tests only: route every notice to these senders (null restores the real ones). */
export function setNoticeDepsForTest(d: NoticeDeps | null) { testDeps = d; }

async function deps(): Promise<NoticeDeps> {
  if (testDeps) return testDeps;
  const email = await import("../emailService");
  const push = await import("../expoPushService");
  return {
    sendReceipt: email.sendTicketReceiptToBuyer,
    sendRefund: email.sendTicketRefundToBuyer,
    sendCancelled: email.sendEventCancelledToGuest,
    sendPush: (p) => push.sendExpoPush(p as any),
  };
}

/**
 * Emails go out one at a time with a short gap: Resend allows 10 requests a second, and cancelling a big
 * event sends one email per guest. (The daily cap on the Resend plan is separate: see the launch checklist.)
 */
export const EMAIL_GAP_MS = 150;
let emailChain: Promise<unknown> = Promise.resolve();
function paced<T>(send: () => Promise<T>): Promise<T> {
  const run = emailChain.then(send);
  emailChain = run.then(
    () => new Promise((r) => setTimeout(r, EMAIL_GAP_MS)),
    () => new Promise((r) => setTimeout(r, EMAIL_GAP_MS)),
  );
  return run;
}

/** "Saturday, October 24 at 8:00 PM EDT", in the event's own time zone. */
export function formatEventWhen(startsAt: Date | string, timeZone: string): string {
  const d = new Date(startsAt);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(d);
  } catch {
    return d.toUTCString();
  }
}

export function formatEventWhere(e: { venue_name?: string | null; address_line1?: string | null; address_line2?: string | null; city?: string | null; state?: string | null; postal_code?: string | null }): string | null {
  const street = [e.address_line1, e.address_line2].filter(Boolean).join(" ");
  const cityLine = [e.city, [e.state, e.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const parts = [e.venue_name, street, cityLine].map((s) => (s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function emailEvent(e: any): TicketEmailEvent {
  return { title: String(e.title), whenText: formatEventWhen(e.starts_at, e.timezone), whereText: formatEventWhere(e) };
}

async function loadOrder(orderId: string) {
  const [o] = await rows<any>(sql`
    SELECT o.*, u.email AS buyer_email, u.first_name AS buyer_first_name,
           e.title, e.starts_at, e.timezone, e.venue_name, e.address_line1, e.address_line2, e.city, e.state, e.postal_code,
           e.status AS event_status, e.host_user_id, e.cancel_reason,
           (SELECT tt.name FROM ticket_order_items i JOIN ticket_types tt ON tt.id = i.ticket_type_id
             WHERE i.order_id = o.id ORDER BY i.created_at LIMIT 1) AS ticket_type_name
    FROM ticket_orders o JOIN users u ON u.id = o.buyer_user_id JOIN events e ON e.id = o.event_id
    WHERE o.id = ${orderId}`);
  return o ?? null;
}

/** After a paid order is settled for the first time. Skipped when the event was cancelled meanwhile (the refund email follows). */
export async function notifyOrderSettled(orderId: string): Promise<void> {
  try {
    const d = await deps();
    const o = await loadOrder(orderId);
    if (!o || o.status !== "completed" || Number(o.total_cents) === 0 || o.event_status === "cancelled") return;
    const codes = (await rows<any>(sql`SELECT code FROM tickets WHERE order_id = ${orderId} ORDER BY item_index`)).map((t) => String(t.code));
    const n = Number(o.ticket_count);
    if (o.buyer_email) {
      await paced(() => d.sendReceipt({
        toEmail: o.buyer_email, firstName: o.buyer_first_name ?? null, event: emailEvent(o),
        ticketTypeName: String(o.ticket_type_name ?? "Ticket"), quantity: n,
        ticketPriceCents: Number(o.subtotal_cents) + Number(o.tax_cents) - Number(o.discount_cents),
        serviceFeeCents: Number(o.service_fee_cents) + Number(o.per_ticket_fee_cents),
        totalCents: Number(o.total_cents), codes,
      })).catch((err) => console.error(`[Tickets] receipt email failed for order ${orderId}:`, (err as Error)?.message ?? err));
    }
    const who = o.buyer_first_name ? String(o.buyer_first_name) : "Someone";
    await d.sendPush({
      userId: o.host_user_id, title: "Tickets sold",
      body: `${who} bought ${n} ${n === 1 ? "ticket" : "tickets"} to ${o.title}.`,
      data: { type: "ticket_sold", eventId: o.event_id, orderId },
    }).catch((err) => console.error(`[Tickets] host push failed for order ${orderId}:`, (err as Error)?.message ?? err));
  } catch (err) {
    console.error(`[Tickets] sale notices failed for order ${orderId}:`, (err as Error)?.message ?? err);
  }
}

/** After Stripe confirmed a refund. */
export async function notifyOrderRefunded(orderId: string, reason: "buyer" | "host" | "event_cancelled", refundCents: number): Promise<void> {
  try {
    const d = await deps();
    const o = await loadOrder(orderId);
    if (!o || !o.buyer_email) return;
    const kept = Math.max(0, Number(o.total_cents) - Number(o.refunded_cents));
    await paced(() => d.sendRefund({
      toEmail: o.buyer_email, firstName: o.buyer_first_name ?? null, event: emailEvent(o), reason, refundCents,
      keptFeeCents: kept, cancelReason: reason === "event_cancelled" ? o.cancel_reason ?? null : null,
    }));
  } catch (err) {
    console.error(`[Tickets] refund email failed for order ${orderId}:`, (err as Error)?.message ?? err);
  }
}

/** Free RSVP guests of a cancelled event (paid buyers get the refund email instead). */
export async function notifyFreeOrdersCancelled(orderIds: string[]): Promise<void> {
  if (!orderIds.length) return;
  const d = await deps().catch(() => null);
  if (!d) return;
  for (const id of orderIds) {
    try {
      const o = await loadOrder(id);
      if (!o || !o.buyer_email) continue;
      await paced(() => d.sendCancelled({ toEmail: o.buyer_email, firstName: o.buyer_first_name ?? null, event: emailEvent(o), cancelReason: o.cancel_reason ?? null }));
    } catch (err) {
      console.error(`[Tickets] cancel email failed for order ${id}:`, (err as Error)?.message ?? err);
    }
  }
}

/** After an event payout was sent (or found already sent) to the host's Stripe account: one push to the host. */
export async function notifyPayoutSent(payoutId: string): Promise<void> {
  try {
    const d = await deps();
    const [p] = await rows<any>(sql`
      SELECT p.id, p.status, p.event_id, e.title, e.host_user_id
      FROM event_payouts p JOIN events e ON e.id = p.event_id WHERE p.id = ${payoutId}`);
    if (!p || p.status !== "paid") return;
    await d.sendPush({
      userId: p.host_user_id, title: "Payout sent",
      body: `Your payout for ${p.title} is on its way to your bank.`,
      data: { type: "event_payout_sent", eventId: p.event_id, payoutId },
    });
  } catch (err) {
    console.error(`[Tickets] payout push failed for payout ${payoutId}:`, (err as Error)?.message ?? err);
  }
}
