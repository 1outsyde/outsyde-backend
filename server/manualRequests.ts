/**
 * Manual-accept booking requests (Part C, approved by Legend 2026-10-18).
 *
 * A business or photographer that accepts bookings by hand only ever sees a request once the
 * customer's card is on hold:
 *  - The customer's checkout stays `pending_payment` until Stripe confirms the authorization
 *    (PaymentIntent `requires_capture`, capture_method `manual`). Then the booking moves to
 *    `pending_provider`, the business/photographer and customer are told, and the deadline starts.
 *    Two paths do this, whichever comes first: the `payment_intent.amount_capturable_updated`
 *    webhook, and the cleanup job (in case that webhook is late or never arrives).
 *  - Deadline = 48 hours after the request, or the appointment start if sooner. The start is read in
 *    the business/photographer's time zone (`time_zone`, from their phone or browser; null = New York).
 *  - Reminder ("Action needed") once: 24 hours before the deadline; when the whole window is under
 *    24 hours, halfway through it, never in the first hour. Claimed with `provider_reminder_sent_at`
 *    so it is sent once.
 *  - At the deadline the card hold is released first, then the booking expires through the state
 *    machine (audit log, points and code release). Both sides are told once (only the run that wins
 *    the conditional transition sends). If Stripe can't release the hold, nothing changes and the
 *    next run retries. A PaymentIntent that already took money is never expired: it is logged loudly.
 *  - Walk-aways (never authorized) never become requests; the Part B job expires them quietly.
 */
import { db } from "./db";
import { appointments, shootBookings, BOOKING_STATES } from "@shared/schema";
import { and, eq, isNull, isNotNull, gt, lt } from "drizzle-orm";
import type { StateTransitionResult } from "./bookingStateMachine";
import { realName } from "./personName";

export const DEFAULT_TIME_ZONE = "America/New_York";
export const REQUEST_WINDOW_MS = 48 * 60 * 60 * 1000;
const REMIND_BEFORE_MS = 24 * 60 * 60 * 1000;
const MIN_REMINDER_DELAY_MS = 60 * 60 * 1000;
/** Give the webhook the first minute before the job promotes a paid checkout itself. */
export const PROMOTE_AFTER_MS = 60 * 1000;

const TERMINAL = new Set<string>([
  BOOKING_STATES.EXPIRED, BOOKING_STATES.CANCELED, BOOKING_STATES.DECLINED,
  BOOKING_STATES.COMPLETED, BOOKING_STATES.NO_SHOW,
]);

// ─── Time ────────────────────────────────────────────────────────────────────

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(tz: unknown): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function zoneOffsetMs(instantMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** "2026-10-18" + "14:30" (wall clock in `tz`) → the real instant. Null when the text is not a date/time. */
export function wallClockToUtc(date: string | null | undefined, time: string | null | undefined, tz: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(time ?? "").trim());
  if (!d || !t) return null;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  if (!Number.isFinite(guess)) return null;
  let ts = guess - zoneOffsetMs(guess, tz);
  ts = guess - zoneOffsetMs(ts, tz); // second pass settles daylight saving edges
  return new Date(ts);
}

/** 48 hours from `from`, or the appointment start if that comes first. */
export function requestDeadline(start: Date | null, from: Date): Date {
  const twoDays = new Date(from.getTime() + REQUEST_WINDOW_MS);
  return start && start.getTime() < twoDays.getTime() ? start : twoDays;
}

/** When the "Action needed" reminder is due, or null when the window is too short for one. */
export function reminderDueAt(pendingSince: Date, deadline: Date): Date | null {
  const windowMs = deadline.getTime() - pendingSince.getTime();
  const due = windowMs > REMIND_BEFORE_MS
    ? deadline.getTime() - REMIND_BEFORE_MS
    : pendingSince.getTime() + Math.max(windowMs / 2, MIN_REMINDER_DELAY_MS);
  return due < deadline.getTime() ? new Date(due) : null;
}

/** "Sat, Oct 18" from "2026-10-18" (wall clock, no zone math). */
export function formatDateLabel(date: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
  if (!m) return String(date ?? "");
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    .format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

/** "2:30 PM" from "14:30". */
export function formatTimeLabel(time: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time ?? "").trim());
  if (!m) return String(time ?? "");
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** "Fri, Oct 17, 9:30 PM EDT" in the provider's zone. */
export function formatDeadlineLabel(deadline: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(deadline);
}

// ─── Who is involved ─────────────────────────────────────────────────────────

type Kind = "appointment" | "shoot_booking";

interface RequestView {
  kind: Kind;
  id: string;
  clientId: string;
  serviceName: string;
  date: string;
  time: string;
  /** What the customer's card hold is for (Stripe amount). */
  amountCents: number;
  /** Booking price incl. add-ons (what the vendor request email has always shown). */
  totalPriceCents: number;
}

interface Parties {
  providerName: string;
  providerUserId: string | null;
  timeZone: string;
}

export interface ManualRequestDeps {
  getPaymentIntent: (id: string) => Promise<{ id: string; status: string; capture_method?: string | null; amount?: number | null; latest_charge?: unknown }>;
  cancelPaymentIntent: (id: string) => Promise<unknown>;
  transitionAppointment: (id: string, toState: string, metadata: Record<string, any>, source: "webhook" | "cron") => Promise<StateTransitionResult>;
  transitionShoot: (id: string, toState: string, metadata: Record<string, any>, source: "webhook" | "cron") => Promise<StateTransitionResult>;
  releasePhotographerSlot: (shootBookingId: string) => Promise<unknown>;
  partiesFor: (kind: Kind, providerId: string) => Promise<Parties | null>;
  getUser: (id: string) => Promise<{ id: string; name?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null; username?: string | null } | undefined>;
  notify: Notifier;
}

export interface Notifier {
  newRequest(req: RequestView, parties: Parties, deadline: Date, customer: { id: string; name: string; email?: string | null; username?: string | null } | undefined): Promise<void>;
  reminder(req: RequestView, parties: Parties, deadline: Date, customerName: string): Promise<void>;
  expired(req: RequestView, parties: Parties, customer: { id: string; name: string; email?: string | null } | undefined): Promise<void>;
}

async function defaultDeps(): Promise<ManualRequestDeps> {
  const { stripeService } = await import("./stripe/stripeService");
  const { transitionAppointmentState, transitionShootBookingState } = await import("./bookingStateMachine");
  const { storage } = await import("./storage");
  const ctx = (metadata: Record<string, any>, source: "webhook" | "cron") => ({
    triggeredBy: source === "webhook" ? "stripe" : "system",
    triggerSource: source,
    metadata,
  });
  return {
    getPaymentIntent: (id) => stripeService.getPaymentIntent(id) as any,
    cancelPaymentIntent: (id) => stripeService.cancelPaymentIntent(id, "abandoned"),
    transitionAppointment: (id, to, m, s) => transitionAppointmentState(id, to as any, ctx(m, s)),
    transitionShoot: (id, to, m, s) => transitionShootBookingState(id, to as any, ctx(m, s)),
    releasePhotographerSlot: (id) => storage.releasePhotographerSlot(id),
    partiesFor: async (kind, providerId) => {
      if (kind === "appointment") {
        const b = await storage.getBusiness(providerId);
        if (!b) return null;
        return { providerName: b.name?.trim() || "the business", providerUserId: b.ownerId ?? null, timeZone: resolveTimeZone((b as any).timeZone) };
      }
      const p = await storage.getPhotographer(providerId);
      if (!p) return null;
      return { providerName: p.displayName?.trim() || "your photographer", providerUserId: p.userId ?? null, timeZone: resolveTimeZone((p as any).timeZone) };
    },
    getUser: (id) => storage.getUser(id) as any,
    notify: defaultNotifier(),
  };
}

// ─── Messages (copy approved by Legend 2026-10-18; no dashes, no fee percentage) ──

function defaultNotifier(): Notifier {
  const push = async (userId: string | null | undefined, title: string, body: string, data: Record<string, string>) => {
    if (!userId) return;
    const { sendExpoPush } = await import("./expoPushService");
    await sendExpoPush({ userId, title, body, data }).catch(() => false);
  };
  const emailTo = async (userId: string | null | undefined) => {
    if (!userId) return undefined;
    const { storage } = await import("./storage");
    return storage.getUser(userId).catch(() => undefined);
  };
  return {
    async newRequest(req, parties, deadline, customer) {
      const email = await import("./emailService");
      const dateLabel = formatDateLabel(req.date);
      const timeLabel = formatTimeLabel(req.time);
      const customerName = realName(customer) || "A customer";
      const isShoot = req.kind === "shoot_booking";
      await push(parties.providerUserId, isShoot ? "New Shoot Request" : "New Booking Request",
        `${customerName} requested ${req.serviceName} on ${dateLabel} at ${timeLabel}. Accept by ${formatDeadlineLabel(deadline, parties.timeZone)}.`,
        { type: "booking_request", screen: "dashboard", bookingId: req.id });
      const provider = await emailTo(parties.providerUserId);
      if (provider?.email) {
        await email.sendBookingRequestToVendor({
          toEmail: provider.email,
          vendorName: parties.providerName,
          consumerName: realName(customer) || "Customer",
          consumerUsername: customer?.username ?? undefined,
          serviceName: req.serviceName,
          bookingId: req.id,
          date: req.date,
          time: req.time,
          basePrice: req.totalPriceCents,
          expiresAt: deadline,
          timeZone: parties.timeZone,
        });
      }
      if (customer) {
        await push(customer.id, isShoot ? "Shoot Request Sent" : "Booking Request Sent",
          `Your request for ${req.serviceName} with ${parties.providerName} is waiting for approval. Your card is on hold, not charged.`,
          { type: "booking_request_sent", screen: "bookings", bookingId: req.id });
      }
      if (customer?.email) {
        await email.sendBookingRequestReceivedToConsumer({
          toEmail: customer.email,
          consumerName: realName(customer) || customer.email,
          vendorName: parties.providerName,
          serviceName: req.serviceName,
          bookingId: req.id,
          date: req.date,
          time: req.time,
          expiresAt: deadline,
          timeZone: parties.timeZone,
        });
      }
      if (!isShoot) {
        await email.sendAdminBookingAlert({
          type: "new_pending",
          businessName: parties.providerName,
          customerName: realName(customer) || "Unknown Customer",
          serviceName: req.serviceName,
          date: req.date,
          amount: `$${(req.amountCents / 100).toFixed(2)}`,
          bookingId: req.id,
        }).catch(() => {});
      }
    },

    async reminder(req, parties, deadline, customerName) {
      const email = await import("./emailService");
      const dateLabel = formatDateLabel(req.date);
      const timeLabel = formatTimeLabel(req.time);
      const deadlineLabel = formatDeadlineLabel(deadline, parties.timeZone);
      await push(parties.providerUserId, "Action needed: booking request expiring",
        `${customerName} is waiting on you for ${req.serviceName} on ${dateLabel} at ${timeLabel}. Accept by ${deadlineLabel} or you'll lose this booking.`,
        { type: "booking_request_reminder", screen: "dashboard", bookingId: req.id });
      const provider = await emailTo(parties.providerUserId);
      if (provider?.email) {
        await email.sendRequestReminderToProvider({
          toEmail: provider.email,
          kind: req.kind === "shoot_booking" ? "shoot" : "booking",
          customerName, providerName: parties.providerName, serviceName: req.serviceName,
          dateLabel, timeLabel, deadlineLabel,
        });
      }
    },

    async expired(req, parties, customer) {
      const email = await import("./emailService");
      const dateLabel = formatDateLabel(req.date);
      const timeLabel = formatTimeLabel(req.time);
      const customerName = realName(customer) || "A customer";
      const kind = req.kind === "shoot_booking" ? "shoot" as const : "booking" as const;
      await push(parties.providerUserId, "Booking lost",
        `${customerName}'s request for ${req.serviceName} on ${dateLabel} at ${timeLabel} expired before it was accepted. The customer was not charged.`,
        { type: "booking_expired", screen: "dashboard", bookingId: req.id });
      const provider = await emailTo(parties.providerUserId);
      if (provider?.email) {
        await email.sendRequestExpiredToProvider({
          toEmail: provider.email, kind, customerName, providerName: parties.providerName,
          serviceName: req.serviceName, dateLabel, timeLabel,
        });
      }
      if (customer) {
        await push(customer.id, "Booking request expired",
          `${parties.providerName} couldn't confirm ${req.serviceName} in time. Nothing was charged. Tap to pick another time.`,
          { type: "booking_expired", screen: "bookings", bookingId: req.id });
        if (customer.email) {
          await email.sendRequestExpiredToCustomer({
            toEmail: customer.email, kind, customerName, providerName: parties.providerName,
            serviceName: req.serviceName, dateLabel, timeLabel,
          });
        }
      }
    },
  };
}

// ─── Rows ────────────────────────────────────────────────────────────────────

async function loadRequest(kind: Kind, id: string) {
  if (kind === "appointment") {
    const [r] = await db.select().from(appointments).where(eq(appointments.id, id));
    if (!r) return null;
    return {
      status: r.status, captureMethod: r.captureMethod, pi: r.stripePaymentIntentId, providerId: r.businessId,
      pendingSince: r.stateChangedAt ?? r.createdAt, deadline: r.pendingProviderExpiresAt,
      view: { kind, id: r.id, clientId: r.clientId, serviceName: r.serviceName || "Appointment", date: r.appointmentDate, time: r.appointmentTime, amountCents: 0, totalPriceCents: r.totalPrice ?? 0 } as RequestView,
    };
  }
  const [r] = await db.select().from(shootBookings).where(eq(shootBookings.id, id));
  if (!r) return null;
  return {
    status: r.status, captureMethod: r.captureMethod, pi: r.stripePaymentIntentId, providerId: r.photographerId,
    pendingSince: r.stateChangedAt ?? r.createdAt, deadline: r.pendingProviderExpiresAt,
    view: { kind, id: r.id, clientId: r.clientId, serviceName: r.shootType || "Shoot", date: r.date, time: r.startTime, amountCents: 0, totalPriceCents: r.totalPrice ?? 0 } as RequestView,
  };
}

// ─── 1. A paid checkout becomes a request ───────────────────────────────────

export type PromoteOutcome = "promoted" | "not_ready" | "not_manual" | "not_pending_payment" | "missing" | "lost_race";

/**
 * Move a manual-capture checkout to `pending_provider` once its card hold is confirmed, and tell
 * everyone. Safe to call from the webhook and the job for the same row: only the call that wins the
 * conditional transition sends anything.
 */
export async function promoteAuthorizedRequest(
  kind: Kind,
  id: string,
  pi: { id: string; status?: string | null; capture_method?: string | null; amount?: number | null; amount_capturable?: number | null },
  source: "webhook" | "cron",
  deps?: ManualRequestDeps,
  now: Date = new Date(),
): Promise<PromoteOutcome> {
  const d = deps ?? (await defaultDeps());
  // Stripe only has an amount waiting to be captured on a manual-capture PaymentIntent whose card
  // is on hold (status requires_capture). Either signal is enough; an automatic capture never is.
  if (pi.capture_method === "automatic" || pi.capture_method === "automatic_async") return "not_manual";
  const onHold = pi.status ? pi.status === "requires_capture" : (pi.amount_capturable ?? 0) > 0;
  if (!onHold) return "not_ready";
  const row = await loadRequest(kind, id);
  if (!row) return "missing";
  if (row.status !== BOOKING_STATES.PENDING_PAYMENT) return "not_pending_payment";

  const parties = await d.partiesFor(kind, row.providerId);
  const tz = parties?.timeZone ?? DEFAULT_TIME_ZONE;
  const deadline = requestDeadline(wallClockToUtc(row.view.date, row.view.time, tz), now);
  const metadata = { event: "card_hold_confirmed", via: source, paymentIntentId: pi.id, pendingProviderExpiresAt: deadline.toISOString() };
  const result = kind === "appointment"
    ? await d.transitionAppointment(id, BOOKING_STATES.PENDING_PROVIDER, metadata, source)
    : await d.transitionShoot(id, BOOKING_STATES.PENDING_PROVIDER, metadata, source);
  if (!result.success) return "lost_race";

  console.log(`[ManualRequest] ${kind} ${id} is now a request (card hold confirmed via ${source}); deadline ${deadline.toISOString()}`);
  if (parties) {
    const customer = await d.getUser(row.view.clientId).catch(() => undefined);
    await d.notify.newRequest({ ...row.view, amountCents: pi.amount ?? 0 }, parties, deadline, customer
      ? { id: customer.id, name: realName(customer) || "", email: customer.email, username: customer.username }
      : undefined).catch((err) => console.error(`[ManualRequest] ${kind} ${id}: new request notices failed`, err));
  }
  return "promoted";
}

async function promoteWaitingCheckouts(now: Date, d: ManualRequestDeps): Promise<number> {
  const cutoff = new Date(now.getTime() - PROMOTE_AFTER_MS);
  const waiting: { kind: Kind; id: string; pi: string | null }[] = [
    ...(await db.select({ id: appointments.id, pi: appointments.stripePaymentIntentId }).from(appointments)
      .where(and(eq(appointments.status, BOOKING_STATES.PENDING_PAYMENT), eq(appointments.captureMethod, "manual"),
        isNotNull(appointments.stripePaymentIntentId), lt(appointments.updatedAt, cutoff))))
      .map((r) => ({ kind: "appointment" as const, ...r })),
    ...(await db.select({ id: shootBookings.id, pi: shootBookings.stripePaymentIntentId }).from(shootBookings)
      .where(and(eq(shootBookings.status, BOOKING_STATES.PENDING_PAYMENT), eq(shootBookings.captureMethod, "manual"),
        isNotNull(shootBookings.stripePaymentIntentId), lt(shootBookings.updatedAt, cutoff))))
      .map((r) => ({ kind: "shoot_booking" as const, ...r })),
  ];
  let promoted = 0;
  for (const w of waiting) {
    try {
      const pi = await d.getPaymentIntent(w.pi!);
      if (pi.status !== "requires_capture") continue; // not paid yet: the Part B job decides
      if ((await promoteAuthorizedRequest(w.kind, w.id, pi, "cron", d, now)) === "promoted") promoted++;
    } catch (err) {
      console.error(`[ManualRequest] ${w.kind} ${w.id}: could not check its PaymentIntent, will retry`, err);
    }
  }
  return promoted;
}

// ─── 2. "Action needed" reminder ─────────────────────────────────────────────

async function sendDueReminders(now: Date, d: ManualRequestDeps): Promise<number> {
  const open = [
    ...(await db.select({ id: appointments.id }).from(appointments)
      .where(and(eq(appointments.status, BOOKING_STATES.PENDING_PROVIDER), isNull(appointments.providerReminderSentAt),
        gt(appointments.pendingProviderExpiresAt, now)))).map((r) => ({ kind: "appointment" as const, id: r.id })),
    ...(await db.select({ id: shootBookings.id }).from(shootBookings)
      .where(and(eq(shootBookings.status, BOOKING_STATES.PENDING_PROVIDER), isNull(shootBookings.providerReminderSentAt),
        gt(shootBookings.pendingProviderExpiresAt, now)))).map((r) => ({ kind: "shoot_booking" as const, id: r.id })),
  ];
  let sent = 0;
  for (const o of open) {
    try {
      const row = await loadRequest(o.kind, o.id);
      if (!row || !row.deadline || !row.pendingSince) continue;
      const due = reminderDueAt(new Date(row.pendingSince), new Date(row.deadline));
      if (!due || now.getTime() < due.getTime()) continue;
      // Only for a request whose card is really on hold (rows made before Part C may not be).
      if (!row.pi) continue;
      const pi = await d.getPaymentIntent(row.pi);
      if (pi.status !== "requires_capture") continue;
      // Claim it: only one run sends.
      const claimed = o.kind === "appointment"
        ? await db.update(appointments).set({ providerReminderSentAt: now })
          .where(and(eq(appointments.id, o.id), eq(appointments.status, BOOKING_STATES.PENDING_PROVIDER), isNull(appointments.providerReminderSentAt)))
          .returning({ id: appointments.id })
        : await db.update(shootBookings).set({ providerReminderSentAt: now })
          .where(and(eq(shootBookings.id, o.id), eq(shootBookings.status, BOOKING_STATES.PENDING_PROVIDER), isNull(shootBookings.providerReminderSentAt)))
          .returning({ id: shootBookings.id });
      if (claimed.length === 0) continue;
      const parties = await d.partiesFor(o.kind, row.providerId);
      if (!parties) continue;
      const customer = await d.getUser(row.view.clientId).catch(() => undefined);
      await d.notify.reminder(row.view, parties, new Date(row.deadline), realName(customer) || "A customer");
      sent++;
      console.log(`[ManualRequest] ${o.kind} ${o.id}: reminder sent`);
    } catch (err) {
      console.error(`[ManualRequest] ${o.kind} ${o.id}: reminder failed, will retry`, err);
    }
  }
  return sent;
}

// ─── 3. Expiry ───────────────────────────────────────────────────────────────

export type ExpiryDecision = "expire_quietly" | "cancel_then_expire" | "expire_notify" | "flag_money_taken";

/**
 * What to do at the deadline, from the PaymentIntent (null = none). `authorized` means the customer
 * really had a card hold, so both sides are told; otherwise (a request made before Part C that was
 * never paid) it ends quietly.
 */
export function decideExpiry(pi: { status: string; latest_charge?: unknown } | null): { decision: ExpiryDecision; authorized: boolean } {
  if (!pi) return { decision: "expire_quietly", authorized: false };
  if (pi.status === "succeeded" || pi.status === "processing") return { decision: "flag_money_taken", authorized: true };
  if (pi.status === "canceled") {
    const authorized = !!pi.latest_charge; // a charge exists only if the card was authorized
    return { decision: authorized ? "expire_notify" : "expire_quietly", authorized };
  }
  if (pi.status === "requires_capture") return { decision: "cancel_then_expire", authorized: true };
  return { decision: "cancel_then_expire", authorized: false };
}

const doneCodes = new Set(["BOOKING_EXPIRED", "CONCURRENT_TRANSITION", "INVALID_STATE"]);

export async function expireDueRequests(now: Date, d: ManualRequestDeps): Promise<{ appointments: number; shootBookings: number; skipped: number }> {
  const due = [
    ...(await db.select({ id: appointments.id }).from(appointments)
      .where(and(eq(appointments.status, BOOKING_STATES.PENDING_PROVIDER), lt(appointments.pendingProviderExpiresAt, now))))
      .map((r) => ({ kind: "appointment" as const, id: r.id })),
    ...(await db.select({ id: shootBookings.id }).from(shootBookings)
      .where(and(eq(shootBookings.status, BOOKING_STATES.PENDING_PROVIDER), lt(shootBookings.pendingProviderExpiresAt, now))))
      .map((r) => ({ kind: "shoot_booking" as const, id: r.id })),
  ];
  let appts = 0, shoots = 0, skipped = 0;
  for (const r of due) {
    try {
      const row = await loadRequest(r.kind, r.id);
      if (!row || row.status !== BOOKING_STATES.PENDING_PROVIDER) continue;

      let pi: Awaited<ReturnType<ManualRequestDeps["getPaymentIntent"]>> | null = null;
      if (row.pi) {
        try {
          pi = await d.getPaymentIntent(row.pi);
        } catch (err) {
          skipped++;
          console.error(`[ManualRequest] ${r.kind} ${r.id}: could not read PaymentIntent ${row.pi}, will retry`, err);
          continue;
        }
      }
      const { decision, authorized } = decideExpiry(pi);
      if (decision === "flag_money_taken") {
        skipped++;
        console.error(`[ManualRequest] FLAG ${r.kind} ${r.id}: past its deadline but PaymentIntent ${row.pi} is ${pi?.status}. Not expired, not refunded. Check by hand.`);
        continue;
      }
      if (decision === "cancel_then_expire") {
        try {
          await d.cancelPaymentIntent(row.pi!);
        } catch (err) {
          skipped++;
          console.error(`[ManualRequest] ${r.kind} ${r.id}: could not release the card hold (${row.pi}), will retry`, err);
          continue;
        }
      }

      const metadata = { action: "request_expired", authorized };
      const result = r.kind === "appointment"
        ? await d.transitionAppointment(r.id, BOOKING_STATES.EXPIRED, metadata, "cron")
        : await d.transitionShoot(r.id, BOOKING_STATES.EXPIRED, metadata, "cron");
      if (!result.success) {
        if (!doneCodes.has(String(result.code))) {
          skipped++;
          console.error(`[ManualRequest] ${r.kind} ${r.id}: could not expire (${result.code}): ${result.error}`);
        }
        continue;
      }
      if (r.kind === "appointment") appts++; else shoots++;
      if (r.kind === "shoot_booking") {
        const after = await loadRequest(r.kind, r.id);
        if (after && TERMINAL.has(after.status)) await d.releasePhotographerSlot(r.id);
      }
      if (authorized) {
        const parties = await d.partiesFor(r.kind, row.providerId);
        const customer = await d.getUser(row.view.clientId).catch(() => undefined);
        if (parties) {
          await d.notify.expired(row.view, parties, customer ? { id: customer.id, name: realName(customer) || "", email: customer.email } : undefined)
            .catch((err) => console.error(`[ManualRequest] ${r.kind} ${r.id}: expiry notices failed`, err));
        }
      }
    } catch (err) {
      skipped++;
      console.error(`[ManualRequest] ${r.kind} ${r.id}: expiry failed, will retry`, err);
    }
  }
  if (appts || shoots || skipped) {
    console.log(`[ManualRequest] Expired ${appts} appointment requests, ${shoots} shoot requests; ${skipped} left for a later run`);
  }
  return { appointments: appts, shootBookings: shoots, skipped };
}

// ─── Job step ────────────────────────────────────────────────────────────────

/** One run: promote paid checkouts, send due reminders, expire due requests. Each part isolated. */
export async function runManualRequestJob(now: Date = new Date(), deps?: ManualRequestDeps) {
  const d = deps ?? (await defaultDeps());
  let promoted = 0, reminded = 0;
  let expired = { appointments: 0, shootBookings: 0, skipped: 0 };
  try { promoted = await promoteWaitingCheckouts(now, d); } catch (err) { console.error("[ManualRequest] promote step failed:", err); }
  try { reminded = await sendDueReminders(now, d); } catch (err) { console.error("[ManualRequest] reminder step failed:", err); }
  try { expired = await expireDueRequests(now, d); } catch (err) { console.error("[ManualRequest] expiry step failed:", err); }
  return { promoted, reminded, expired };
}

export { defaultDeps as manualRequestDefaultDeps };
