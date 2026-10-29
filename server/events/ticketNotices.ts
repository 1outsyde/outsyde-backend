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
import { inviteTitle, joinedCopy, type TeamRole } from "./teamRoles";
import { sql } from "drizzle-orm";
import { rows, hostIdentity } from "./eventsRouter";
import { holderCanSeeAddress } from "./eventRules";
import { qrUrlFor } from "./ticketQr";
import type { TicketEmailEvent } from "../emailService";
import { startOfNewYorkDay } from "../emailHistory";

export type NoticeDeps = {
  sendReceipt: (p: Parameters<typeof import("../emailService").sendTicketReceiptToBuyer>[0]) => Promise<void>;
  sendRefund: (p: Parameters<typeof import("../emailService").sendTicketRefundToBuyer>[0]) => Promise<void>;
  sendCancelled: (p: Parameters<typeof import("../emailService").sendEventCancelledToGuest>[0]) => Promise<void>;
  sendAddressReveal: (p: Parameters<typeof import("../emailService").sendAddressRevealToHolder>[0]) => Promise<void>;
  sendPush: (p: { userId: string; title: string; body: string; data?: Record<string, unknown> }) => Promise<boolean>;
  /** Activity (notifications table) row. Optional so older test fakes keep compiling; missing = not recorded. */
  createActivity?: (p: ActivityItem) => Promise<void>;
  sendDoorInvite?: (p: Parameters<typeof import("../emailService").sendDoorTeamInviteEmail>[0]) => Promise<void>;
};

export type ActivityItem = {
  userId: string; type: string; title: string; message: string;
  referenceType: string; referenceId: string; metadata: Record<string, unknown>; triggeredByUserId: string | null;
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
    createActivity: async (p) => {
      const { storage } = await import("../storage");
      await storage.createNotification(p as any);
    },
    sendDoorInvite: email.sendDoorTeamInviteEmail,
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
 * Free RSVP emails stop once today's email_log total (New York day, all kinds) reaches this. Below the address
 * reveal job's 70 (addressReveal.ts) so the last slots of Resend's 100 a day stay for receipts, bookings and resets.
 */
export const RSVP_EMAIL_DAILY_CEILING = 60;

function rsvpEmailable(o: any): boolean {
  return !!o && o.status === "completed" && Number(o.total_cents) === 0 && o.event_status !== "cancelled" && !!o.buyer_email;
}

async function emailsSentToday(now: Date): Promise<number> {
  const start = startOfNewYorkDay(now).toISOString();
  const [r] = await rows<any>(sql`
    SELECT count(*)::int AS n FROM email_log
    WHERE created_at >= ${start}::timestamptz AND created_at < ${start}::timestamptz + interval '1 day'`);
  return Number(r?.n ?? 0);
}

/**
 * After a free RSVP is created (new order only, never on a repeated idempotency key): the guest gets the
 * "Your RSVP is confirmed" email with one QR image per ticket, the same email paid buyers get without the
 * money lines. Skipped for paid orders (they get notifyOrderSettled), cancelled events and anything not
 * completed. No host push (that stays a paid sale notice).
 */
export async function notifyRsvpConfirmed(orderId: string, opts: { emailCeiling?: number; now?: Date } = {}): Promise<void> {
  try {
    const d = await noticeDeps();
    const o = await loadOrder(orderId);
    if (!rsvpEmailable(o)) return;
    const tix = await rows<any>(sql`SELECT id, code FROM tickets WHERE order_id = ${orderId} AND status = 'valid' ORDER BY item_index`);
    if (!tix.length) return;
    // Resend allows 100 emails a day for everything (receipts, bookings, password resets). Free RSVPs can come in
    // bursts, so their email stops once today's total reaches the ceiling; the guest still has the tickets and QR
    // codes in My Tickets.
    const ceiling = opts.emailCeiling ?? RSVP_EMAIL_DAILY_CEILING;
    if ((await emailsSentToday(opts.now ?? new Date())) >= ceiling) {
      console.log(`[Tickets] daily email budget reached: RSVP ${orderId} confirmed without an email`);
      return;
    }
    const codes = tix.map((t) => String(t.code));
    // A QR failure must never block the email: it just goes without images.
    let qrUrls: string[] | undefined;
    try { qrUrls = tix.map((t) => qrBuilder(String(t.id))); }
    catch (err) { console.error(`[Tickets] qr urls failed for RSVP ${orderId}:`, (err as Error)?.message ?? err); }
    await paced(async () => {
      // The pacing queue can be long (e.g. during a mass cancel): check the order again right before sending.
      if (!rsvpEmailable(await loadOrder(orderId))) return;
      await d.sendReceipt({
        toEmail: o.buyer_email, firstName: o.buyer_first_name ?? null, event: emailEvent(o),
        ticketTypeName: String(o.ticket_type_name ?? "Ticket"), quantity: tix.length,
        ticketPriceCents: 0, serviceFeeCents: 0, totalCents: 0, codes, qrUrls,
      });
    }).catch((err) => console.error(`[Tickets] RSVP email failed for order ${orderId}:`, (err as Error)?.message ?? err));
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

/**
 * Door team invites (p4-scanner, migration 075). The invite email shares the New York day budget of all email_log
 * rows with the day-of address email (addressReveal.ts TOTAL_EMAIL_DAILY_CEILING) and goes at most once a day per row.
 */
export const DOOR_INVITE_EMAIL_CEILING = 70;

function doorUrl(): string {
  const base = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || "https://www.goutsyde.com").replace(/\/+$/, "");
  return `${base}/events/door`;
}

const doorTable = (scope: "standing" | "event") => sql.raw(scope === "standing" ? "event_door_team" : "event_door_members");

/** At most this many invite emails per host per New York day, so one host can't use up the shared budget. */
export const DOOR_INVITE_EMAILS_PER_HOST_DAY = 10;
/** A second invite to the same person within this many minutes (cancel, then invite again) gets no push. */
export const DOOR_INVITE_PUSH_QUIET_MINUTES = 10;

type InvitePair = { scope: "standing" | "event"; inviteId: string; hostUserId: string; memberUserId: string; eventId: string; role: TeamRole };
/**
 * Every row (removed ones too) for this host, person and role: standing rows by host, event rows by event.
 * Per role (p4-team): a second role for the same person is its own invite and gets its own push and email.
 */
const pairKey = (p: InvitePair) => p.scope === "standing"
  ? sql`host_user_id = ${p.hostUserId} AND member_user_id = ${p.memberUserId} AND role = ${p.role}`
  : sql`event_id = ${p.eventId} AND member_user_id = ${p.memberUserId} AND role = ${p.role}`;

/**
 * Claims today's invite email for this row. True only when nobody emailed this person about this host's team (or
 * this event) in the last 24 hours, on any row, cancelled ones included; the host is under 10 invite emails today;
 * and the New York day's email_log total is under the shared ceiling.
 */
async function claimInviteEmail(p: InvitePair): Promise<boolean> {
  const nyDayStart = startOfNewYorkDay(new Date()).toISOString();
  const got = await rows<any>(sql`
    UPDATE ${doorTable(p.scope)} SET invite_emailed_at = now()
    WHERE id = ${p.inviteId}
      AND NOT EXISTS (SELECT 1 FROM ${doorTable(p.scope)} x WHERE ${pairKey(p)} AND x.invite_emailed_at > now() - interval '24 hours')
      AND (SELECT count(*) FROM event_door_team t WHERE t.host_user_id = ${p.hostUserId} AND t.invite_emailed_at >= ${nyDayStart}::timestamptz)
        + (SELECT count(*) FROM event_door_members m JOIN events e ON e.id = m.event_id
           WHERE e.host_user_id = ${p.hostUserId} AND m.invite_emailed_at >= ${nyDayStart}::timestamptz) < ${DOOR_INVITE_EMAILS_PER_HOST_DAY}
      AND (SELECT count(*) FROM email_log WHERE created_at >= ${nyDayStart}::timestamptz
             AND created_at < ${nyDayStart}::timestamptz + interval '1 day') < ${DOOR_INVITE_EMAIL_CEILING}
    RETURNING id`);
  return got.length > 0;
}

/** Another row for this pair was sent in the last 10 minutes (a cancel, then invite again): skip the push. */
async function pushedRecently(p: InvitePair): Promise<boolean> {
  const r = await rows<any>(sql`
    SELECT 1 AS x FROM ${doorTable(p.scope)} WHERE ${pairKey(p)} AND id <> ${p.inviteId}
      AND invited_at > now() - (${DOOR_INVITE_PUSH_QUIET_MINUTES} * interval '1 minute') LIMIT 1`);
  return r.length > 0;
}

/**
 * After a host sends (or re-sends) a door team invite: push, Activity item, and an email while the budget lasts.
 * eventId is the event the host invited from (its host identity names the host). Never throws; each channel on its own.
 */
export async function notifyDoorInvite(p: { inviteId: string; scope: "standing" | "event"; eventId: string; memberUserId: string; hostUserId: string; role?: TeamRole }): Promise<void> {
  const role: TeamRole = p.role ?? "door";
  try {
    const d = await noticeDeps();
    const [e] = await rows<any>(sql`SELECT * FROM events WHERE id = ${p.eventId}`);
    const [m] = await rows<any>(sql`SELECT email, first_name FROM users WHERE id = ${p.memberUserId}`);
    if (!e || !m) return;
    const hostName = (await hostIdentity(e)).publicName;
    const title = inviteTitle(hostName, role);
    const message = p.scope === "event" ? `Only this event: ${String(e.title)}.` : `All of ${hostName}'s events.`;
    const log = (what: string) => (err: unknown) => console.error(`[Door] invite ${what} failed for ${p.inviteId}:`, (err as Error)?.message ?? err);
    const pair: InvitePair = { scope: p.scope, inviteId: p.inviteId, hostUserId: p.hostUserId, memberUserId: p.memberUserId, eventId: p.eventId, role };
    if (!(await pushedRecently(pair).catch(() => false))) {
      await d.sendPush({ userId: p.memberUserId, title, body: "Tap to accept or decline.", data: { type: "door_team_invite", inviteId: p.inviteId } })
        .catch(log("push"));
    }
    if (d.createActivity) {
      await d.createActivity({
        userId: p.memberUserId, type: "door_team_invite", title, message,
        referenceType: "event_door_invite", referenceId: p.inviteId,
        metadata: { inviteId: p.inviteId, scope: p.scope, eventId: p.scope === "event" ? p.eventId : null, role },
        triggeredByUserId: p.hostUserId,
      }).catch(log("activity"));
    }
    if (d.sendDoorInvite && m.email && (await claimInviteEmail(pair).catch(() => false))) {
      await d.sendDoorInvite({
        toEmail: String(m.email), firstName: m.first_name ?? null, hostName, scope: p.scope,
        eventTitle: p.scope === "event" ? String(e.title) : null,
        whenText: p.scope === "event" ? formatEventWhen(e.starts_at, e.timezone) : null,
        doorUrl: doorUrl(), role,
      }).catch(log("email"));
    }
  } catch (err) {
    console.error(`[Door] invite notices failed for ${p.inviteId}:`, (err as Error)?.message ?? err);
  }
}

/**
 * The host's push when someone accepts (no notice on decline). Named by first name, else @username, the same
 * names the host sees on the team list. Never throws.
 */
export async function notifyDoorAccepted(p: { hostUserId: string; memberUserId: string; scope: "standing" | "event"; eventId: string | null; role?: TeamRole }): Promise<void> {
  try {
    const d = await noticeDeps();
    const [m] = await rows<any>(sql`SELECT first_name, username FROM users WHERE id = ${p.memberUserId}`);
    if (!m) return;
    const name = (m.first_name && String(m.first_name).trim()) || (m.username ? `@${m.username}` : "Someone");
    let what = "all your events";
    if (p.scope === "event" && p.eventId) {
      const [e] = await rows<any>(sql`SELECT title FROM events WHERE id = ${p.eventId}`);
      if (e) what = String(e.title);
    }
    const copy = joinedCopy(name, p.role ?? "door", what);
    await d.sendPush({
      userId: p.hostUserId, title: copy.title, body: copy.body,
      data: { type: "door_team_accepted", eventId: p.scope === "event" ? p.eventId : null },
    });
  } catch (err) {
    console.error(`[Door] accept push failed for host ${p.hostUserId}:`, (err as Error)?.message ?? err);
  }
}
