/**
 * Events & Ticketing Phase 2 PR 4: emails and pushes for ticket orders.
 *
 *   buyer receipt (paid order, first settle only), with the ticket codes
 *   host push for each paid sale (no host email per sale: Resend's plan allows 100 emails a day)
 *   buyer refund email (when Stripe confirms the refund), wording by reason
 *   free RSVP guests: "RSVP confirmed" email with QR codes, and the "event cancelled" email
 *
 * Every function here is fire and forget: it never throws, so a failed email can't undo a sale or a refund.
 * Senders are injectable so tests can check what would be sent without Resend or Expo.
 */
import { sql } from "drizzle-orm";
import { rows, hostIdentity } from "./eventsRouter";
import { holderCanSeeAddress } from "./eventRules";
import { qrUrlFor } from "./ticketQr";
import type { TicketEmailEvent } from "../emailService";

export type NoticeDeps = {
  sendReceipt: (p: Parameters<typeof import("../emailService").sendTicketReceiptToBuyer>[0]) => Promise<void>;
  sendRefund: (p: Parameters<typeof import("../emailService").sendTicketRefundToBuyer>[0]) => Promise<void>;
  sendCancelled: (p: Parameters<typeof import("../emailService").sendEventCancelledToGuest>[0]) => Promise<void>;
  sendAddressReveal: (p: Parameters<typeof import("../emailService").sendAddressRevealToHolder>[0]) => Promise<void>;
  sendPush: (p: { userId: string; title: string; body: string; data?: Record<string, unknown> }) => Promise<boolean>;
};

let testDeps: NoticeDeps | null = null;
/** Tests only: route every notice to these senders (null restores the real ones). */
export function setNoticeDepsForTest(d: NoticeDeps | null) { testDeps = d; }

let qrBuilder: (ticketId: string) => string = qrUrlFor;
/** Tests only (needs NODE_ENV !== "production" and ALLOW_TEST_SEAMS=1): replace the QR URL builder; null restores it. */
export function setQrBuilderForTest(f: ((ticketId: string) => string) | null) {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_TEST_SEAMS !== "1") return;
  qrBuilder = f ?? qrUrlFor;
}

export async function noticeDeps(): Promise<NoticeDeps> {
  if (testDeps) return testDeps;
  const email = await import("../emailService");
  const push = await import("../expoPushService");
  return {
    sendReceipt: email.sendTicketReceiptToBuyer,
    sendRefund: email.sendTicketRefundToBuyer,
    sendCancelled: email.sendEventCancelledToGuest,
    sendAddressReveal: email.sendAddressRevealToHolder,
    sendPush: (p) => push.sendExpoPush(p as any),
  };
}

/**
 * Emails go out one at a time with a short gap: Resend allows 10 requests a second, and cancelling a big
 * event sends one email per guest. (The daily cap on the Resend plan is separate: see the launch checklist.)
 */
export const EMAIL_GAP_MS = 150;
let emailChain: Promise<unknown> = Promise.resolve();
export function paced<T>(send: () => Promise<T>): Promise<T> {
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

/** "City, ST" (only the parts present), or null when the event has neither. */
function cityState(e: { city?: string | null; state?: string | null }): string | null {
  const parts = [e.city, e.state].map((s) => (s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** Day-of events keep the venue and street out of emails until the reveal time. */
function emailEvent(e: any, now: Date = new Date()): TicketEmailEvent {
  const full = holderCanSeeAddress(e.address_visibility, new Date(e.starts_at), e.timezone, now);
  return { title: String(e.title), whenText: formatEventWhen(e.starts_at, e.timezone), whereText: full ? formatEventWhere(e) : cityState(e) };
}

async function loadOrder(orderId: string) {
  const [o] = await rows<any>(sql`
    SELECT o.*, u.email AS buyer_email, u.first_name AS buyer_first_name,
           e.title, e.starts_at, e.timezone, e.address_visibility, e.venue_name, e.address_line1, e.address_line2, e.city, e.state, e.postal_code,
           e.status AS event_status, e.host_user_id, e.cancel_reason,
           (SELECT tt.name FROM ticket_order_items i JOIN ticket_types tt ON tt.id = i.ticket_type_id
             WHERE i.order_id = o.id ORDER BY i.created_at LIMIT 1) AS ticket_type_name
    FROM ticket_orders o JOIN users u ON u.id = o.buyer_user_id JOIN events e ON e.id = o.event_id
    WHERE o.id = ${orderId}`);
  return o ?? null;
}

/**
 * After a free RSVP is created (new order only, never on a repeated idempotency key): the guest gets the
 * "Your RSVP is confirmed" email with one QR image per ticket, the same email paid buyers get without the
 * money lines. Skipped for paid orders (they get notifyOrderSettled), cancelled events and anything not
 * completed. No host push (that stays a paid sale notice).
 */
export async function notifyRsvpConfirmed(orderId: string): Promise<void> {
  try {
    const d = await noticeDeps();
    const o = await loadOrder(orderId);
    if (!o || o.status !== "completed" || Number(o.total_cents) !== 0 || o.event_status === "cancelled" || !o.buyer_email) return;
    const tix = await rows<any>(sql`SELECT id, code FROM tickets WHERE order_id = ${orderId} AND status = 'valid' ORDER BY item_index`);
    if (!tix.length) return;
    const codes = tix.map((t) => String(t.code));
    // A QR failure must never block the email: it just goes without images.
    let qrUrls: string[] | undefined;
    try { qrUrls = tix.map((t) => qrBuilder(String(t.id))); }
    catch (err) { console.error(`[Tickets] qr urls failed for RSVP ${orderId}:`, (err as Error)?.message ?? err); }
    await paced(() => d.sendReceipt({
      toEmail: o.buyer_email, firstName: o.buyer_first_name ?? null, event: emailEvent(o),
      ticketTypeName: String(o.ticket_type_name ?? "Ticket"), quantity: tix.length,
      ticketPriceCents: 0, serviceFeeCents: 0, totalCents: 0, codes, qrUrls,
    })).catch((err) => console.error(`[Tickets] RSVP email failed for order ${orderId}:`, (err as Error)?.message ?? err));
  } catch (err) {
    console.error(`[Tickets] RSVP notice failed for order ${orderId}:`, (err as Error)?.message ?? err);
  }
}

/** After a paid order is settled for the first time. Skipped when the event was cancelled meanwhile (the refund email follows). */
export async function notifyOrderSettled(orderId: string): Promise<void> {
  try {
    const d = await noticeDeps();
    const o = await loadOrder(orderId);
    if (!o || o.status !== "completed" || Number(o.total_cents) === 0 || o.event_status === "cancelled") return;
    const tix = await rows<any>(sql`SELECT id, code FROM tickets WHERE order_id = ${orderId} ORDER BY item_index`);
    const codes = tix.map((t) => String(t.code));
    // A QR failure must never block the receipt or the host push: the email just goes without images.
    let qrUrls: string[] | undefined;
    try { qrUrls = tix.map((t) => qrBuilder(String(t.id))); }
    catch (err) { console.error(`[Tickets] qr urls failed for order ${orderId}:`, (err as Error)?.message ?? err); }
    const n = Number(o.ticket_count);
    if (o.buyer_email) {
      await paced(() => d.sendReceipt({
        toEmail: o.buyer_email, firstName: o.buyer_first_name ?? null, event: emailEvent(o),
        ticketTypeName: String(o.ticket_type_name ?? "Ticket"), quantity: n,
        ticketPriceCents: Number(o.subtotal_cents) + Number(o.tax_cents) - Number(o.discount_cents),
        serviceFeeCents: Number(o.service_fee_cents) + Number(o.per_ticket_fee_cents),
        totalCents: Number(o.total_cents), codes, qrUrls,
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
    const d = await noticeDeps();
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
  const d = await noticeDeps().catch(() => null);
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
    const d = await noticeDeps();
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

/** After a host adds someone to the door team (push only, no email). Never throws. */
export async function notifyDoorTeamAdded(p: { userId: string; scope: "standing" | "event"; eventId: string }): Promise<void> {
  try {
    const d = await noticeDeps();
    const [e] = await rows<any>(sql`SELECT * FROM events WHERE id = ${p.eventId}`);
    if (!e) return;
    const what = p.scope === "standing" ? `${(await hostIdentity(e)).publicName}'s events` : String(e.title);
    await d.sendPush({
      userId: p.userId, title: "You're on the door team",
      body: `You can now scan tickets for ${what}.`,
      data: { type: "door_team_added", eventId: p.eventId, scope: p.scope },
    });
  } catch (err) {
    console.error(`[Door] team push failed for event ${p.eventId}:`, (err as Error)?.message ?? err);
  }
}
