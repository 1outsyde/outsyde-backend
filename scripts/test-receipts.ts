/**
 * Integration test for paid-transaction receipts (consumer, vendor, admin).
 *
 * Runs the real Stripe webhook handlers against a LOCAL Postgres (see
 * AGENTS.md "Local Database Setup") with outbound HTTP stubbed: Resend calls
 * are recorded instead of sent, Expo push calls are no-ops. Stripe is never
 * called — fixtures have no connected accounts, so payouts are skipped.
 *
 *   DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs" \
 *   RESEND_API_KEY=re_test ADMIN_NOTIFICATION_EMAIL=ops-test@example.com \
 *   npx tsx scripts/test-receipts.ts
 *
 * Exits non-zero on the first failed assertion. Refuses to run against a
 * non-local DATABASE_URL.
 */
import { randomUUID } from "node:crypto";

const dbUrl = process.env.DATABASE_URL || "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)) {
  console.error("Refusing to run: DATABASE_URL must point at a local database.");
  process.exit(2);
}
const ADMIN = process.env.ADMIN_NOTIFICATION_EMAIL;
if (!ADMIN || !process.env.RESEND_API_KEY) {
  console.error("Set ADMIN_NOTIFICATION_EMAIL and RESEND_API_KEY (any value) to run.");
  process.exit(2);
}

// A dedicated fixture business plays XO, so the XO sender rule is testable
// without touching the real XO row. Must be set before server modules load.
const XO_TEST_BUSINESS_ID = randomUUID();
process.env.XO_BUSINESS_ID = XO_TEST_BUSINESS_ID;

// ─── Outbound HTTP stub ─────────────────────────────────────────────────────
interface SentEmail { to: string; from: string; subject: string; html: string }
const sent: SentEmail[] = [];
const failFor = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.includes("127.0.0.1") || url.includes("localhost")) return realFetch(input, init);
  if (url.includes("api.resend.com")) {
    const body = JSON.parse(init?.body ?? "{}");
    const to = Array.isArray(body.to) ? body.to[0] : body.to;
    if (failFor.has(to)) {
      return new Response(JSON.stringify({ name: "validation_error", message: `forced failure for ${to}`, statusCode: 422 }),
        { status: 422, headers: { "content-type": "application/json" } });
    }
    sent.push({ to, from: body.from, subject: body.subject, html: body.html ?? "" });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  // Expo push and anything else: pretend success.
  return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

// ─── Log capture ────────────────────────────────────────────────────────────
const receiptLogs: string[] = [];
const origLog = console.log;
const origErr = console.error;
const capture = (orig: (...a: any[]) => void) => (...args: any[]) => {
  const line = args.map(a => (typeof a === "string" ? a : a?.message ?? String(a))).join(" ");
  if (line.startsWith("[Receipt]")) receiptLogs.push(line);
  if (process.env.VERBOSE) orig(...args);
};
console.log = capture(origLog);
console.error = capture(origErr);

// ─── Assertions ─────────────────────────────────────────────────────────────
let passed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    origErr(`✗ ${msg}`);
    origErr("  sent:", JSON.stringify(sent.map(s => s.to)));
    origErr("  receipt logs:\n   " + receiptLogs.join("\n   "));
    process.exit(1);
  }
  passed++;
  origLog(`✓ ${msg}`);
}
function reset(): void {
  sent.length = 0;
  receiptLogs.length = 0;
  failFor.clear();
}
function recipients(): string[] {
  return sent.map(s => s.to).sort();
}

async function main() {
  const { db } = await import("../server/db");
  const schema = await import("@shared/schema");
  const { storage } = await import("../server/storage");
  const { WebhookHandlers } = await import("../server/stripe/webhookHandlers");
  const { BOOKING_STATES } = schema;
  const { eq } = await import("drizzle-orm");

  const tag = randomUUID().slice(0, 8);
  const consumerEmail = `consumer-${tag}@example.com`;
  const vendorEmail = `vendor-${tag}@example.com`;
  const photogEmail = `photog-${tag}@example.com`;

  const [consumer] = await db.insert(schema.users).values({ username: `c_${tag}`, email: consumerEmail, name: "Test Consumer" } as any).returning();
  const [vendorUser] = await db.insert(schema.users).values({ username: `v_${tag}`, email: vendorEmail, name: "Test Vendor" } as any).returning();
  const [photogUser] = await db.insert(schema.users).values({ username: `p_${tag}`, email: photogEmail, name: "Test Photog" } as any).returning();
  const [business] = await db.insert(schema.businesses).values({ ownerId: vendorUser.id, name: "Test Braids", category: "beauty" } as any).returning();
  const [photographer] = await db.insert(schema.photographers).values({ userId: photogUser.id, displayName: "Test Photog", hourlyRate: 10000 } as any).returning();

  const expect3 = [ADMIN!, consumerEmail, vendorEmail].sort();

  // Each fixture gets its own slot (appointments/shoots have unique slot constraints).
  // A far-future year per run keeps reruns against the same DB from colliding.
  const runYear = 3000 + Math.floor(Math.random() * 6000);
  let slot = 0;
  const nextSlot = () => {
    slot++;
    return { date: `${runYear}-01-${String(1 + Math.floor(slot / 12)).padStart(2, "0")}`, time: `${String(8 + (slot % 12)).padStart(2, "0")}:00` };
  };

  async function newAppointment(opts: { totalPrice: number; deposit?: number | null }) {
    const { date, time } = nextSlot();
    const [a] = await db.insert(schema.appointments).values({
      businessId: business.id,
      clientId: consumer.id,
      appointmentDate: date,
      appointmentTime: time,
      totalPrice: opts.totalPrice,
      depositAmountCents: opts.deposit ?? null,
      serviceName: "Small mid back knotless",
      status: BOOKING_STATES.PENDING_PAYMENT,
    } as any).returning();
    return a;
  }
  async function newOrder() {
    const [o] = await db.insert(schema.orders).values({
      businessId: business.id,
      customerId: consumer.id,
      items: [{ productId: null, name: "Tea", quantity: 1, price: 2000 }],
      totalAmount: 2000,
      status: "pending",
    } as any).returning();
    return o;
  }
  async function newShoot() {
    const { date, time } = nextSlot();
    const [b] = await db.insert(schema.shootBookings).values({
      photographerId: photographer.id,
      clientId: consumer.id,
      shootType: "Portrait",
      date,
      startTime: time,
      endTime: time,
      durationHours: 1,
      totalPrice: 15000,
      status: BOOKING_STATES.PENDING_PAYMENT,
    } as any).returning();
    return b;
  }
  const pi = (amount: number, metadata: Record<string, string>) => ({ id: `pi_test_${randomUUID()}`, amount, metadata });
  const receiptSentCount = () => receiptLogs.filter(l => / → (consumer|vendor|admin) sent$/.test(l)).length;

  // ── Non-payment transitions: parity harness ──────────────────────────────
  // Uses only APIs present on both main (8500932) and this branch, so the same
  // file can run against a main worktree with ONLY=transitions. Each scenario
  // records a normalized result; TRANSITIONS_OUT writes them as JSON for diffing.
  async function runTransitions(): Promise<Record<string, unknown>> {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { registerRoutes } = await import("../server/routes");
    const { stripeService } = await import("../server/stripe/stripeService");
    const { generateAccessToken } = await import("../server/auth");
    const sm = await import("../server/bookingStateMachine");
    const { expireOldHolds } = await import("../server/availabilityService");
    const { startReminderJob } = await import("../server/reminderService");

    const app = express();
    app.use(express.json());
    const server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const tokens = {
      vendor: generateAccessToken({ userId: vendorUser.id, isVendor: true, businessId: business.id }),
      photographer: generateAccessToken({ userId: photogUser.id, isVendor: false, isPhotographer: true, photographerId: photographer.id }),
      consumer: generateAccessToken({ userId: consumer.id, isVendor: false }),
    };
    await db.update(schema.users).set({ stripeCustomerId: `cus_test_${tag}` } as any).where(eq(schema.users.id, consumer.id));
    // One admin user so the per-admin notification paths (cancellation admin
    // email) run. Emails to it are recorded under the "admin-user" role.
    const adminUserEmail = `admin-${tag}@example.com`;
    await db.insert(schema.users).values({ username: `a_${tag}`, email: adminUserEmail, name: "Test Admin", isAdmin: true } as any);

    // Stripe stub: record every call the routes/jobs make.
    const stripeCalls: string[] = [];
    const stubs: Record<string, (...a: any[]) => any> = {
      capturePaymentIntent: async (id: string) => { stripeCalls.push("capturePaymentIntent"); return { id, amount: 16200, amount_received: 16200, status: "succeeded", metadata: {} }; },
      cancelPaymentIntent: async (id: string) => { stripeCalls.push("cancelPaymentIntent"); return { id, status: "canceled" }; },
      createBookingRefund: async (a: any) => { stripeCalls.push(`createBookingRefund:${a?.amountCents ?? "full"}`); return { id: "re_test", amount: a?.amountCents }; },
      refundPayment: async (_id: string, amt?: number) => { stripeCalls.push(`refundPayment:${amt ?? "full"}`); return { id: "re_test" }; },
      getPaymentMethodIdFromIntent: async () => { stripeCalls.push("getPaymentMethodIdFromIntent"); return "pm_test"; },
      chargeSavedPaymentMethod: async (a: any) => { stripeCalls.push(`chargeSavedPaymentMethod:${a?.amountCents}`); return { id: "pi_fee", status: "succeeded" }; },
      getPaymentIntent: async (id: string) => { stripeCalls.push("getPaymentIntent"); return { id, status: "requires_capture", amount: 16200 }; },
      // Consumer cancel reads what a refund can still return (absent on main).
      getPaymentIntentForRefund: async () => { stripeCalls.push("getPaymentIntentForRefund"); return { status: "succeeded", amountReceived: 13500, amountRefunded: 0 }; },
    };
    const originals: Record<string, any> = {};
    for (const [k, fn] of Object.entries(stubs)) { originals[k] = (stripeService as any)[k]; (stripeService as any)[k] = fn; }

    const role = (to: string) => to === consumerEmail ? "consumer" : to === vendorEmail ? "vendor" : to === photogEmail ? "photographer" : to === ADMIN ? "admin" : to === adminUserEmail ? "admin-user" : "other";
    const norm = (subj: string) => subj.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\d{4}-\d{2}-\d{2}/g, "<date>");
    async function settle() {
      let last = -1, stable = 0;
      for (let i = 0; i < 400 && stable < 8; i++) {
        await new Promise(r => setTimeout(r, 10));
        if (sent.length === last) stable++; else { stable = 0; last = sent.length; }
      }
    }
    async function call(method: string, path: string, who: keyof typeof tokens, body: unknown = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json: any = await res.json().catch(() => ({}));
      return { http: res.status, success: json?.success ?? null };
    }
    async function apptRow(id: string) { return (await db.select().from(schema.appointments).where(eq(schema.appointments.id, id)))[0] as any; }
    async function shootRow(id: string) { return (await db.select().from(schema.shootBookings).where(eq(schema.shootBookings.id, id)))[0] as any; }
    async function service(policy: Record<string, unknown>) {
      const [svc] = await db.insert(schema.vendorServices).values({ businessId: business.id, name: "Policy test", price: 12500, durationMinutes: 60, ...policy } as any).returning();
      return svc;
    }
    async function appt(status: string, extra: Record<string, unknown> = {}) {
      const a = await newAppointment({ totalPrice: 12500 });
      await db.update(schema.appointments).set({ status, captureMethod: "manual", stripePaymentIntentId: `pi_test_${randomUUID()}`, pendingProviderExpiresAt: new Date(Date.now() + 86_400_000), ...extra } as any).where(eq(schema.appointments.id, a.id));
      return a.id;
    }
    async function shoot(status: string, extra: Record<string, unknown> = {}) {
      const b = await newShoot();
      await db.update(schema.shootBookings).set({ status, captureMethod: "manual", stripePaymentIntentId: `pi_test_${randomUUID()}`, pendingProviderExpiresAt: new Date(Date.now() + 86_400_000), ...extra } as any).where(eq(schema.shootBookings.id, b.id));
      return b.id;
    }
    function snapshot(r: { http?: number; success?: unknown }, row: any) {
      return {
        http: r.http ?? null,
        success: r.success ?? null,
        status: row?.status ?? null,
        stripe: [...stripeCalls].sort(),
        emails: sent.map(e => `${role(e.to)} | ${norm(e.subject)}`).sort(),
        refundAmount: row?.refundAmount ?? null,
        hasRefundId: !!row?.stripeRefundId,
        cancellationReason: row?.cancellationReason ?? null,
        reminder24hSent: row?.reminder24hSent ?? null,
      };
    }
    const results: Record<string, any> = {};
    async function scenario(name: string, fn: () => Promise<any>) {
      reset(); stripeCalls.length = 0;
      results[name] = await fn();
    }
    // Far-future dates so refund windows are open; the fixtures use year 3000+.

    await scenario("appt: vendor declines pending request", async () => {
      const id = await appt(BOOKING_STATES.PENDING_PROVIDER);
      const r = await call("POST", `/api/bookings/appointments/${id}/decline`, "vendor", { reason: "Unavailable" });
      await settle(); return snapshot(r, await apptRow(id));
    });
    await scenario("appt: vendor accepts pending request", async () => {
      const id = await appt(BOOKING_STATES.PENDING_PROVIDER);
      const r = await call("POST", `/api/bookings/appointments/${id}/accept`, "vendor");
      await settle(); return snapshot(r, await apptRow(id));
    });
    await scenario("appt: consumer cancels confirmed (full refund window)", async () => {
      const svc = await service({ fullRefundWindow: "24_hours" });
      const id = await appt(BOOKING_STATES.CONFIRMED, { serviceId: svc.id });
      const r = await call("POST", `/api/bookings/appointments/${id}/cancel`, "consumer");
      await settle(); return snapshot(r, await apptRow(id));
    });
    await scenario("appt: consumer cancels confirmed (no refund, $5 fee)", async () => {
      const svc = await service({ fullRefundWindow: "never", hasCancellationFee: true, cancellationFeeType: "flat", cancellationFeeAmount: 500 });
      const id = await appt(BOOKING_STATES.CONFIRMED, { serviceId: svc.id });
      const r = await call("POST", `/api/bookings/appointments/${id}/cancel`, "consumer");
      await settle(); return snapshot(r, await apptRow(id));
    });
    await scenario("appt: vendor cancels with refund", async () => {
      const id = await appt(BOOKING_STATES.CONFIRMED);
      const r = await call("POST", `/api/bookings/appointments/${id}/refund`, "vendor", { reason: "Vendor canceled" });
      await settle(); return snapshot(r, await apptRow(id));
    });
    await scenario("appt: vendor cancels without refund (no-show)", async () => {
      const id = await appt(BOOKING_STATES.CONFIRMED);
      const r = await call("POST", `/api/bookings/appointments/${id}/cancel-no-refund`, "vendor", { reason: "No-show" });
      await settle(); return snapshot(r, await apptRow(id));
    });
    await scenario("appt: request expires (cleanupExpiredPendingProvider)", async () => {
      const id = await appt(BOOKING_STATES.PENDING_PROVIDER, { pendingProviderExpiresAt: new Date(Date.now() - 60_000) });
      await sm.cleanupExpiredPendingProvider();
      await settle(); return snapshot({}, await apptRow(id));
    });
    await scenario("appt: draft expires (cleanupExpiredDrafts)", async () => {
      const id = await appt(BOOKING_STATES.DRAFT, { draftExpiresAt: new Date(Date.now() - 60_000) });
      await sm.cleanupExpiredDrafts();
      await settle(); return snapshot({}, await apptRow(id));
    });
    await scenario("hold expires (expireOldHolds)", async () => {
      const [h] = await db.insert(schema.bookingHolds).values({
        providerType: "business", providerId: business.id, userId: consumer.id, serviceId: randomUUID(), serviceName: "Hold test",
        servicePriceCents: 12500, durationMinutes: 60, holdDate: `${runYear}-02-01`, startTime: "09:00", endTime: "10:00",
        startAt: new Date(Date.now() + 86_400_000), endAt: new Date(Date.now() + 90_000_000), expiresAt: new Date(Date.now() - 60_000), status: "active",
      } as any).returning();
      await expireOldHolds();
      await settle();
      const [row] = await db.select().from(schema.bookingHolds).where(eq(schema.bookingHolds.id, h.id));
      return snapshot({}, row);
    });
    await scenario("appt: reminder job (24h)", async () => {
      // Any free minute inside the ±15 min reminder window (reruns leave rows behind).
      let a: any;
      for (const off of [...Array(21).keys()].map(i => i - 10).sort(() => Math.random() - 0.5)) {
        const when = new Date(Date.now() + 24 * 3600_000 + off * 60_000);
        try {
          [a] = await db.insert(schema.appointments).values({
            businessId: business.id, clientId: consumer.id, appointmentDate: when.toISOString().slice(0, 10), appointmentTime: when.toISOString().slice(11, 16),
            totalPrice: 12500, serviceName: "Reminder test", status: BOOKING_STATES.CONFIRMED,
          } as any).returning();
          break;
        } catch { /* slot taken; try the next minute */ }
      }
      startReminderJob(2_000_000_000);
      for (let i = 0; i < 300 && !(await apptRow(a.id)).reminder24hSent; i++) await new Promise(r => setTimeout(r, 20));
      await settle();
      const snap = snapshot({}, await apptRow(a.id));
      // Other test rows could fall in the window; keep only this appointment's reminder.
      snap.emails = snap.emails.filter((e: string) => e.startsWith("consumer"));
      return snap;
    });
    await scenario("shoot: photographer declines pending request", async () => {
      const id = await shoot(BOOKING_STATES.PENDING_PROVIDER);
      const r = await call("POST", `/api/bookings/photographer/${id}/decline`, "photographer", { reason: "Unavailable" });
      await settle(); return snapshot(r, await shootRow(id));
    });
    await scenario("shoot: photographer accepts pending request", async () => {
      const id = await shoot(BOOKING_STATES.PENDING_PROVIDER);
      const r = await call("POST", `/api/bookings/photographer/${id}/accept`, "photographer");
      await settle(); return snapshot(r, await shootRow(id));
    });
    await scenario("shoot: photographer cancels with refund", async () => {
      const id = await shoot(BOOKING_STATES.CONFIRMED);
      const r = await call("POST", `/api/bookings/photographer/${id}/refund`, "photographer", { reason: "Photographer canceled" });
      await settle(); return snapshot(r, await shootRow(id));
    });
    await scenario("shoot: consumer cancels confirmed", async () => {
      const id = await shoot(BOOKING_STATES.CONFIRMED);
      const r = await call("POST", `/api/bookings/shoot/${id}/cancel`, "consumer");
      await settle(); return snapshot(r, await shootRow(id));
    });
    await scenario("shoot: request expires (cleanupExpiredPendingProvider)", async () => {
      const id = await shoot(BOOKING_STATES.PENDING_PROVIDER, { pendingProviderExpiresAt: new Date(Date.now() - 60_000) });
      await sm.cleanupExpiredPendingProvider();
      await settle(); return snapshot({}, await shootRow(id));
    });

    for (const [k, fn] of Object.entries(originals)) (stripeService as any)[k] = fn;
    server.close();
    return results;
  }

  // ── Consumer cancel: deposit rule, refund cap, failures ──────────────────
  // Real route and stripeService; Stripe is mocked only at the SDK boundary
  // (resource prototypes), so every wrapper runs as in production.
  async function runCancelTests(): Promise<void> {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { registerRoutes } = await import("../server/routes");
    const { generateAccessToken } = await import("../server/auth");
    const Stripe: any = (await import("stripe")).default;
    const R = Stripe.resources;

    const app = express();
    app.use(express.json());
    const server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const token = generateAccessToken({ userId: consumer.id, isVendor: false });
    await db.update(schema.users).set({ stripeCustomerId: `cus_test_${tag}` } as any).where(eq(schema.users.id, consumer.id));

    const calls: string[] = [];
    let pi = { status: "succeeded", amount_received: 0, amount_refunded: 0 };
    let refundThrows = false;
    let cancelThrows = false;
    const originals = {
      refundCreate: R.Refunds.prototype.create,
      piRetrieve: R.PaymentIntents.prototype.retrieve,
      piCancel: R.PaymentIntents.prototype.cancel,
      piCreate: R.PaymentIntents.prototype.create,
    };
    R.Refunds.prototype.create = async function (p: any, o: any) {
      calls.push(`refunds.create:${p?.amount}`);
      if (refundThrows) throw new Error("forced refund failure");
      assert(typeof o?.idempotencyKey === "string" && o.idempotencyKey.includes(String(p?.amount)), "refund carries a per-amount idempotency key");
      return { id: `re_${randomUUID()}`, amount: p?.amount };
    };
    R.PaymentIntents.prototype.retrieve = async function (id: string, p: any) {
      calls.push(p?.expand ? "paymentIntents.retrieve(expand)" : "paymentIntents.retrieve");
      return { id, status: pi.status, amount_received: pi.amount_received, payment_method: "pm_test", latest_charge: { id: "ch_test", amount_refunded: pi.amount_refunded } };
    };
    R.PaymentIntents.prototype.cancel = async function (id: string) {
      calls.push("paymentIntents.cancel");
      if (cancelThrows) throw new Error("forced cancel failure");
      return { id, status: "canceled" };
    };
    // Cancellation fee charges go through paymentIntents.create.
    R.PaymentIntents.prototype.create = async function (p: any) {
      calls.push(`paymentIntents.create:${p?.amount}`);
      return { id: `pi_fee_${randomUUID()}`, status: "succeeded", amount: p?.amount };
    };

    async function svc(policy: Record<string, unknown>) {
      const [s] = await db.insert(schema.vendorServices).values({ businessId: business.id, name: "Cancel test", price: 12500, durationMinutes: 60, ...policy } as any).returning();
      return s;
    }
    const FULL = { fullRefundWindow: "1_week", hasCancellationFee: true, cancellationFeeType: "flat", cancellationFeeAmount: 500 };
    const HALF = { fullRefundWindow: "never", hasPartialRefund: true, partialRefundWindow: "24_hours", partialRefundPercentage: 50, hasCancellationFee: true, cancellationFeeType: "flat", cancellationFeeAmount: 500 };
    const NONE_WITH_FEE = { fullRefundWindow: "never", hasCancellationFee: true, cancellationFeeType: "flat", cancellationFeeAmount: 500 };
    async function confirmed(opts: { totalPrice: number; deposit?: number | null; policy: Record<string, unknown>; capture?: "automatic" | "manual"; extra?: Record<string, unknown> }) {
      const s = await svc(opts.policy);
      const a = await newAppointment({ totalPrice: opts.totalPrice, deposit: opts.deposit });
      await db.update(schema.appointments).set({
        status: BOOKING_STATES.CONFIRMED, serviceId: s.id, captureMethod: opts.capture ?? "automatic",
        stripePaymentIntentId: `pi_test_${randomUUID()}`, ...(opts.extra ?? {}),
      } as any).where(eq(schema.appointments.id, a.id));
      return a.id;
    }
    async function cancel(id: string, method = "POST", suffix = "cancel") {
      const res = await fetch(`http://127.0.0.1:${port}/api/bookings/appointments/${id}/${suffix}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      return { http: res.status, body: (await res.json().catch(() => ({}))) as any };
    }
    async function row(id: string) { return (await db.select().from(schema.appointments).where(eq(schema.appointments.id, id)))[0] as any; }
    function start(state: Partial<typeof pi> = {}) {
      calls.length = 0; refundThrows = false; cancelThrows = false;
      pi = { status: "succeeded", amount_received: 0, amount_refunded: 0, ...state };
    }
    const noFee = () => !calls.some(c => c.startsWith("paymentIntents.create"));

    // B 27500 / D 3000 / auto capture: deposit is non-refundable, no fee, no Stripe call.
    {
      start();
      const id = await confirmed({ totalPrice: 27500, deposit: 3000, policy: NONE_WITH_FEE });
      const r = await cancel(id); const a = await row(id);
      assert(r.http === 200 && r.body.refundAmountCents === 0 && r.body.feeAmountCents === 0 && r.body.feeCharged === false, "deposit cancel: 200, refund 0, fee 0, fee not charged");
      assert(calls.length === 0, `deposit cancel (auto capture): no Stripe calls (got ${JSON.stringify(calls)})`);
      assert(a.status === BOOKING_STATES.CANCELED && !!a.canceledAt && !a.stripeRefundId, "deposit cancel: status canceled, canceledAt set, no refund recorded");
    }
    // Preview for B 27500 / D 3000.
    {
      start();
      const id = await confirmed({ totalPrice: 27500, deposit: 3000, policy: FULL });
      const r = await cancel(id, "GET", "cancel-preview");
      assert(r.http === 200 && r.body.cancellable === true && r.body.refundAmountCents === 0 && r.body.feeAmountCents === 0 && r.body.feeWouldBeCharged === false, "deposit preview: refund 0, fee 0");
      assert(calls.length === 0, "deposit preview: no Stripe calls");
    }
    // B 27500 / depositAmountCents 0: treated as no deposit.
    {
      start({ amount_received: 29700 });
      const id = await confirmed({ totalPrice: 27500, deposit: 0, policy: FULL });
      const r = await cancel(id); const a = await row(id);
      assert(r.http === 200 && r.body.refundAmountCents === 27500 && calls.includes("refunds.create:27500"), "deposit 0 is no deposit: refund 27500 at 100%");
      assert(a.status === BOOKING_STATES.CANCELED && a.refundAmount === 27500, "deposit 0: canceled, refundAmount 27500");
    }
    // B 12500 / no deposit / 100%.
    {
      start({ amount_received: 13500 });
      const id = await confirmed({ totalPrice: 12500, policy: FULL });
      const r = await cancel(id); const a = await row(id);
      assert(r.http === 200 && r.body.refundAmountCents === 12500 && calls.filter(c => c.startsWith("refunds.create")).join() === "refunds.create:12500", "no deposit 100%: refund 12500");
      assert(noFee() && a.status === BOOKING_STATES.CANCELED && !!a.canceledAt && !!a.stripeRefundId, "no deposit 100%: no fee, canceled, refund recorded");
    }
    // B 12500 / no deposit / 50%: refund 6250, fee charged only after refund and cancel.
    {
      start({ amount_received: 13500 });
      const id = await confirmed({ totalPrice: 12500, policy: HALF });
      const r = await cancel(id); const a = await row(id);
      assert(r.http === 200 && r.body.refundAmountCents === 6250 && calls.includes("refunds.create:6250"), "no deposit 50%: refund 6250");
      const refundAt = calls.indexOf("refunds.create:6250"), feeAt = calls.indexOf("paymentIntents.create:500");
      assert(feeAt > refundAt && r.body.feeCharged === true && a.status === BOOKING_STATES.CANCELED, "no deposit 50%: $5 fee charged after the refund, status canceled");
    }
    // Cap: received 13500, already refunded 9000 → at most 4500.
    {
      start({ amount_received: 13500, amount_refunded: 9000 });
      const id = await confirmed({ totalPrice: 12500, policy: FULL });
      const r = await cancel(id); const a = await row(id);
      assert(r.http === 200 && r.body.refundAmountCents === 4500 && calls.includes("refunds.create:4500") && a.refundAmount === 4500, "refund capped at amount_received minus prior refunds (4500)");
    }
    // No-deposit refund throws: error returned, nothing else happens.
    {
      start({ amount_received: 13500 }); refundThrows = true;
      const id = await confirmed({ totalPrice: 12500, policy: HALF });
      const r = await cancel(id); const a = await row(id);
      assert(r.http === 502 && r.body.code === "REFUND_FAILED", "refund failure: 502 REFUND_FAILED");
      assert(a.status === BOOKING_STATES.CONFIRMED && !a.canceledAt && !a.stripeRefundId && noFee(), "refund failure: still confirmed, no canceledAt, no refund, no fee");
    }
    // Retry after a refund succeeded but the status change did not.
    {
      start({ amount_received: 13500 });
      const id = await confirmed({ totalPrice: 12500, policy: FULL, extra: { stripeRefundId: "re_prior", refundAmount: 12500, refundedAt: new Date() } });
      const r = await cancel(id); const a = await row(id);
      assert(!calls.some(c => c.startsWith("refunds.create")), "retry with stripeRefundId set: no second refund");
      assert(r.http === 200 && r.body.refundAmountCents === 12500 && a.status === BOOKING_STATES.CANCELED && a.stripeRefundId === "re_prior", "retry: canceled, keeps the prior refund");
    }
    // Uncaptured authorization: release it, never refund, never charge a fee.
    for (const [label, deposit] of [["deposit", 3000], ["no deposit", null]] as const) {
      start({ status: "requires_capture", amount_received: 0 });
      const id = await confirmed({ totalPrice: label === "deposit" ? 27500 : 12500, deposit, policy: HALF, capture: "manual" });
      const r = await cancel(id); const a = await row(id);
      assert(calls.filter(c => c === "paymentIntents.cancel").length === 1 && !calls.some(c => c.startsWith("refunds.create")) && noFee(), `${label} requires_capture: paymentIntents.cancel once, no refund, no fee`);
      assert(r.http === 200 && r.body.refundAmountCents === 0 && a.status === BOOKING_STATES.CANCELED && !!a.canceledAt, `${label} requires_capture: refund 0, status canceled`);
    }
    // Releasing the authorization fails.
    {
      start({ status: "requires_capture", amount_received: 0 }); cancelThrows = true;
      const id = await confirmed({ totalPrice: 12500, policy: FULL, capture: "manual" });
      const r = await cancel(id); const a = await row(id);
      assert(r.http === 502 && r.body.code === "AUTH_RELEASE_FAILED", "authorization release failure: 502 AUTH_RELEASE_FAILED");
      assert(a.status === BOOKING_STATES.CONFIRMED && !a.canceledAt, "authorization release failure: still confirmed, no canceledAt");
    }

    R.Refunds.prototype.create = originals.refundCreate;
    R.PaymentIntents.prototype.retrieve = originals.piRetrieve;
    R.PaymentIntents.prototype.cancel = originals.piCancel;
    R.PaymentIntents.prototype.create = originals.piCreate;
    server.close();
  }

  if (process.env.ONLY === "cancel") {
    await runCancelTests();
    origLog(`\nAll ${passed} assertions passed.`);
    return;
  }

  if (process.env.ONLY === "transitions") {
    const results = await runTransitions();
    if (process.env.TRANSITIONS_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.TRANSITIONS_OUT, JSON.stringify(results, null, 2));
    }
    origLog(JSON.stringify(results, null, 2));
    return;
  }

  // ── Case 1 + 5: each type sends exactly 3, and a duplicate adds none ─────
  const cases: Array<{ name: string; run: () => Promise<{ first: () => Promise<void>; again: () => Promise<void> }> }> = [
    { name: "appointment (deposit)", run: async () => {
      const a = await newAppointment({ totalPrice: 27500, deposit: 3000 });
      const p = pi(3240, { type: "appointment", appointmentId: a.id, businessId: business.id, staffMemberId: "" });
      return { first: () => WebhookHandlers.handlePaymentIntentSucceeded(p), again: () => WebhookHandlers.handlePaymentIntentSucceeded(p) };
    } },
    { name: "appointment (full)", run: async () => {
      const a = await newAppointment({ totalPrice: 12500 });
      const p = pi(13500, { type: "appointment", appointmentId: a.id, businessId: business.id, staffMemberId: "" });
      return { first: () => WebhookHandlers.handlePaymentIntentSucceeded(p), again: () => WebhookHandlers.handlePaymentIntentSucceeded(p) };
    } },
    { name: "appointment_booking (legacy)", run: async () => {
      const a = await newAppointment({ totalPrice: 12500 });
      const p = pi(13500, { type: "appointment_booking", bookingId: a.id, clientId: consumer.id });
      return { first: () => WebhookHandlers.handlePaymentIntentSucceeded(p), again: () => WebhookHandlers.handlePaymentIntentSucceeded(p) };
    } },
    { name: "deposit (legacy XO)", run: async () => {
      const a = await newAppointment({ totalPrice: 12500 });
      const p = pi(3000, { type: "deposit", appointmentId: a.id, businessId: business.id });
      return { first: () => WebhookHandlers.handlePaymentIntentSucceeded(p), again: () => WebhookHandlers.handlePaymentIntentSucceeded(p) };
    } },
    { name: "shoot_booking", run: async () => {
      const b = await newShoot();
      const p = pi(16200, { type: "shoot_booking", bookingId: b.id, clientId: consumer.id });
      return { first: () => WebhookHandlers.handlePaymentIntentSucceeded(p), again: () => WebhookHandlers.handlePaymentIntentSucceeded(p) };
    } },
    { name: "product_purchase", run: async () => {
      const o = await newOrder();
      const p = pi(2160, { type: "product_purchase", orderId: o.id, businessId: business.id, userId: consumer.id });
      return { first: () => WebhookHandlers.handlePaymentIntentSucceeded(p), again: () => WebhookHandlers.handlePaymentIntentSucceeded(p) };
    } },
    { name: "multi_vendor_product_purchase", run: async () => {
      const o = await newOrder();
      const groupId = randomUUID();
      const p = pi(2160, {
        type: "multi_vendor_product_purchase", orderGroupId: groupId, userId: consumer.id,
        vendorOrders: JSON.stringify([{ orderId: o.id, businessId: business.id, vendorNetCents: 1960 }]),
      });
      return { first: () => WebhookHandlers.handlePaymentIntentSucceeded(p), again: () => WebhookHandlers.handlePaymentIntentSucceeded(p) };
    } },
    { name: "checkout: cart_checkout", run: async () => {
      const o = await newOrder();
      const session = { id: `cs_${tag}`, payment_intent: `pi_${randomUUID()}`, amount_total: 2160, customer: null,
        metadata: { type: "cart_checkout", orderId: o.id, userId: consumer.id, businessId: business.id } };
      return { first: () => WebhookHandlers.handleCheckoutCompleted(session), again: () => WebhookHandlers.handleCheckoutCompleted(session) };
    } },
    { name: "checkout: appointment_booking", run: async () => {
      const a = await newAppointment({ totalPrice: 12500 });
      const session = { id: `cs_${tag}`, payment_intent: `pi_${randomUUID()}`, amount_total: 13500, customer: null,
        metadata: { type: "appointment_booking", appointmentId: a.id, clientId: consumer.id } };
      return { first: () => WebhookHandlers.handleCheckoutCompleted(session), again: () => WebhookHandlers.handleCheckoutCompleted(session) };
    } },
    { name: "checkout: shoot_booking", run: async () => {
      const b = await newShoot();
      const session = { id: `cs_${tag}`, payment_intent: `pi_${randomUUID()}`, amount_total: 16200, customer: null,
        metadata: { type: "shoot_booking", shootBookingId: b.id, clientId: consumer.id } };
      return { first: () => WebhookHandlers.handleCheckoutCompleted(session), again: () => WebhookHandlers.handleCheckoutCompleted(session) };
    } },
  ];

  for (const c of cases) {
    reset();
    const { first, again } = await c.run();
    await first();
    const isShoot = c.name.includes("shoot");
    const expected = isShoot ? [ADMIN!, consumerEmail, photogEmail].sort() : expect3;
    assert(JSON.stringify(recipients()) === JSON.stringify(expected), `${c.name}: 3 receipts (consumer, vendor, admin)`);
    await again();
    assert(sent.length === 3, `${c.name}: duplicate delivery sends nothing more (3 total, not 6)`);
    assert(receiptLogs.some(l => l.includes("SKIPPED: already processed")), `${c.name}: duplicate logs SKIPPED: already processed`);
  }

  // ── Case 5b: concurrent duplicate deliveries still send exactly 3 ────────
  {
    reset();
    const a = await newAppointment({ totalPrice: 27500, deposit: 3000 });
    const p = pi(3240, { type: "appointment", appointmentId: a.id, businessId: business.id, staffMemberId: "" });
    await Promise.all([
      WebhookHandlers.handlePaymentIntentSucceeded(p),
      WebhookHandlers.handlePaymentIntentSucceeded(p),
    ]);
    assert(sent.length === 3, "appointment: two concurrent deliveries send exactly 3 receipts");
  }

  // ── Case 2: vendor send fails; consumer + admin still send ──────────────
  {
    reset();
    const a = await newAppointment({ totalPrice: 12500 });
    failFor.add(vendorEmail);
    await WebhookHandlers.handlePaymentIntentSucceeded(pi(13500, { type: "appointment", appointmentId: a.id, businessId: business.id, staffMemberId: "" }));
    assert(JSON.stringify(recipients()) === JSON.stringify([ADMIN!, consumerEmail].sort()), "vendor failure: consumer and admin still sent");
    assert(receiptLogs.some(l => l.includes(`appointment ${a.id} → vendor FAILED`)), "vendor failure: FAILED log names txn id and role");
  }

  // ── Case 3: points failure doesn't block receipts ───────────────────────
  {
    reset();
    const origEarn = storage.earnPoints.bind(storage);
    const origPending = storage.createPendingPointTransaction.bind(storage);
    (storage as any).earnPoints = async () => { throw new Error("forced earnPoints failure"); };
    (storage as any).createPendingPointTransaction = async () => { throw new Error("forced points failure"); };
    try {
      const a = await newAppointment({ totalPrice: 12500 });
      await WebhookHandlers.handlePaymentIntentSucceeded(pi(13500, { type: "appointment_booking", bookingId: a.id, clientId: consumer.id }));
      assert(sent.length === 3, "earnPoints throws: all 3 receipts still sent");
      const o = await newOrder();
      reset();
      await WebhookHandlers.handlePaymentIntentSucceeded(pi(2160, { type: "product_purchase", orderId: o.id, businessId: business.id, userId: consumer.id }));
      assert(sent.length === 3, "earnPoints throws (product): all 3 receipts still sent");
      const [paid] = await db.select().from(schema.orders).where(eq(schema.orders.id, o.id));
      assert(paid.status === "paid", "product: order status is paid");
    } finally {
      (storage as any).earnPoints = origEarn;
      (storage as any).createPendingPointTransaction = origPending;
    }
  }

  // ── Case 4: admin fee lines use the amount actually charged ─────────────
  {
    reset();
    const a = await newAppointment({ totalPrice: 27500, deposit: 3000 });
    await WebhookHandlers.handlePaymentIntentSucceeded(pi(3240, { type: "appointment", appointmentId: a.id, businessId: business.id, staffMemberId: "" }));
    const admin = sent.find(s => s.to === ADMIN)!;
    assert(admin.subject.includes("(deposit)"), "deposit admin subject marks deposit");
    assert(admin.html.includes("+$2.40"), "deposit admin: 8% on D = $2.40");
    assert(admin.html.includes("-$0.60"), "deposit admin: 2% on D = $0.60");
    assert(admin.html.includes("$245.00"), "deposit admin: due at appointment $245.00");
    assert(!admin.html.includes("+$22.00"), "deposit admin: no 8% on B ($22.00)");
    const consumerMail = sent.find(s => s.to === consumerEmail)!;
    assert(consumerMail.html.includes("$32.40") && consumerMail.html.includes("$245.00"), "deposit consumer: shows $32.40 paid and $245.00 due");
    const [row] = await db.select().from(schema.appointments).where(eq(schema.appointments.id, a.id));
    assert(row.status === BOOKING_STATES.CONFIRMED, "deposit appointment moved to confirmed");

    reset();
    const f = await newAppointment({ totalPrice: 12500 });
    await WebhookHandlers.handlePaymentIntentSucceeded(pi(13500, { type: "appointment", appointmentId: f.id, businessId: business.id, staffMemberId: "" }));
    const adminFull = sent.find(s => s.to === ADMIN)!;
    assert(adminFull.html.includes("+$10.00") && adminFull.html.includes("-$2.50"), "full-pay admin: 8% = $10.00, 2% = $2.50");
  }

  // ── Deposit (legacy XO) sender is Outsyde, not XO ────────────────────────
  {
    reset();
    const a = await newAppointment({ totalPrice: 12500 });
    await WebhookHandlers.handlePaymentIntentSucceeded(pi(3000, { type: "deposit", appointmentId: a.id, businessId: business.id }));
    assert(sent.every(s => !s.from.includes("xobeautyandlashes")), "deposit emails no longer sent from the XO domain");
    assert(!sent.some(s => s.to === "fleekbynik@gmail.com"), "deposit vendor alert never falls back to XO owner");
  }

  // ── Order row parity: new conditional claim vs old storage.updateOrder ────
  // For each paid path, the order row written by the webhook must match a row
  // updated with the old call (status 'paid' + stripePaymentIntentId) in every
  // column except identity/creation columns.
  {
    const skip = new Set(["id", "order_number", "created_at", "order_group_id"]);
    // Raw row as JSON so timestamps compare as text (the local Neon proxy
    // returns timestamps drizzle can't parse, which would hide differences).
    const { sql } = await import("drizzle-orm");
    const rowOf = async (id: string) => ((await db.execute(sql`SELECT to_jsonb(o) AS r FROM orders o WHERE o.id = ${id}`)) as any).rows[0].r;
    const parity = async (label: string, run: (orderId: string, piId: string) => Promise<void>) => {
      const piId = `pi_test_${randomUUID()}`;
      const viaNew = await newOrder();
      const viaOld = await newOrder();
      const beforeNew = await rowOf(viaNew.id), beforeOld = await rowOf(viaOld.id);
      await run(viaNew.id, piId);
      await storage.updateOrder(viaOld.id, { status: "paid", stripePaymentIntentId: piId } as any);
      const afterNew = await rowOf(viaNew.id), afterOld = await rowOf(viaOld.id);
      // Compare what each path wrote: the changed columns and their new values.
      const changes = (before: any, after: any) => Object.fromEntries(
        Object.keys(after).filter(k => !skip.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(k => [k, after[k]]));
      const cNew = changes(beforeNew, afterNew), cOld = changes(beforeOld, afterOld);
      const same = JSON.stringify(Object.keys(cNew).sort()) === JSON.stringify(Object.keys(cOld).sort())
        && Object.keys(cOld).every(k => JSON.stringify(cNew[k]) === JSON.stringify(cOld[k]));
      assert(same, `order row parity (${label}): same columns and values as old updateOrder (new=${JSON.stringify(Object.keys(cNew))} old=${JSON.stringify(Object.keys(cOld))})`);
    };
    await parity("product_purchase PI", (id, piId) =>
      WebhookHandlers.handlePaymentIntentSucceeded({ id: piId, amount: 2160, metadata: { type: "product_purchase", orderId: id, businessId: business.id, userId: consumer.id } }));
    await parity("cart checkout", (id, piId) =>
      WebhookHandlers.handleCheckoutCompleted({ id: `cs_${randomUUID()}`, payment_intent: piId, amount_total: 2160, customer: null,
        metadata: { type: "cart_checkout", orderId: id, userId: consumer.id, businessId: business.id } }));
    await parity("multi-vendor PI", (id, piId) =>
      WebhookHandlers.handlePaymentIntentSucceeded({ id: piId, amount: 2160, metadata: {
        type: "multi_vendor_product_purchase", orderGroupId: randomUUID(), userId: consumer.id,
        vendorOrders: JSON.stringify([{ orderId: id, businessId: business.id, vendorNetCents: 1960 }]) } }));
    await parity("multi-vendor checkout", (id, piId) =>
      WebhookHandlers.handleCheckoutCompleted({ id: `cs_${randomUUID()}`, payment_intent: piId, amount_total: 2160, customer: null,
        metadata: { type: "multi_vendor_cart_checkout", orderGroupId: randomUUID(), userId: consumer.id,
          vendorData: JSON.stringify([{ orderId: id, businessId: business.id, vendorNet: 1960 }]) } }));
  }

  // ── Non-payment transitions (same harness used for the main-vs-branch diff) ─
  {
    const t: Record<string, any> = await runTransitions();
    const expect = (name: string, status: string, stripe: string[], mustEmail: string[] = []) => {
      const r = t[name];
      assert(r && r.status === status, `${name}: status ${status} (got ${r?.status})`);
      assert(JSON.stringify(r.stripe) === JSON.stringify([...stripe].sort()), `${name}: Stripe calls ${JSON.stringify(stripe)} (got ${JSON.stringify(r.stripe)})`);
      for (const m of mustEmail) assert(r.emails.some((e: string) => e.startsWith(m)), `${name}: email "${m}"`);
      if (r.http != null) assert(r.http === 200, `${name}: HTTP 200 (got ${r.http})`);
    };
    expect("appt: vendor declines pending request", "declined", ["cancelPaymentIntent"], ["consumer | Booking request not accepted", "admin | [Outsyde] Booking Declined"]);
    expect("appt: vendor accepts pending request", "confirmed", ["capturePaymentIntent"], ["consumer | 🎉 Your appointment is confirmed", "vendor | 🎉 New booking received", "admin | [Outsyde] appointment_booking"]);
    expect("appt: consumer cancels confirmed (full refund window)", "canceled", ["createBookingRefund:12500", "getPaymentIntentForRefund"], ["admin | [Outsyde Admin] Appointment Refunded"]);
    expect("appt: consumer cancels confirmed (no refund, $5 fee)", "canceled", ["chargeSavedPaymentMethod:500", "getPaymentIntentForRefund", "getPaymentMethodIdFromIntent"], ["admin | [Outsyde Admin] Appointment Canceled"]);
    expect("appt: vendor cancels with refund", "canceled", ["createBookingRefund:12500"]);
    expect("appt: vendor cancels without refund (no-show)", "no_show", []);
    expect("appt: request expires (cleanupExpiredPendingProvider)", "expired", ["cancelPaymentIntent"], ["consumer | Booking request expired"]);
    expect("appt: draft expires (cleanupExpiredDrafts)", "expired", []);
    expect("hold expires (expireOldHolds)", "expired", []);
    expect("appt: reminder job (24h)", "confirmed", [], ["consumer | Your appointment is tomorrow"]);
    assert(t["appt: reminder job (24h)"].reminder24hSent === true, "reminder job: reminder_24h_sent set, status unchanged");
    expect("shoot: photographer declines pending request", "declined", ["cancelPaymentIntent"], ["consumer | Booking request not accepted"]);
    expect("shoot: photographer accepts pending request", "confirmed", ["capturePaymentIntent"], ["consumer | 🎉 Your shoot is confirmed", "photographer | 🎉 New shoot booked", "admin | [Outsyde] shoot_booking"]);
    expect("shoot: photographer cancels with refund", "canceled", ["createBookingRefund:15000"]);
    expect("shoot: consumer cancels confirmed", "canceled", [], ["photographer | Your Booking Was Canceled"]);
    expect("shoot: request expires (cleanupExpiredPendingProvider)", "expired", ["cancelPaymentIntent"], ["consumer | Booking request expired", "photographer | Booking Request Expired"]);
  }

  // ── Multi-vendor checkout: points only via the Stripe-customer lookup ─────
  {
    const origEarn = storage.earnPoints.bind(storage);
    const origFind = WebhookHandlers.findUserByStripeCustomer;
    const earnCalls: any[] = [];
    (storage as any).earnPoints = async (data: any) => { earnCalls.push(data); return origEarn(data); };
    try {
      const runCheckout = async () => {
        const o = await newOrder();
        const groupId = randomUUID();
        await WebhookHandlers.handleCheckoutCompleted({
          id: `cs_${randomUUID()}`, payment_intent: `pi_${randomUUID()}`, amount_total: 2160, customer: null,
          metadata: {
            type: "multi_vendor_cart_checkout", orderGroupId: groupId, userId: consumer.id,
            vendorData: JSON.stringify([{ orderId: o.id, businessId: business.id, vendorNet: 1960 }]),
          },
        });
        return groupId;
      };

      reset(); earnCalls.length = 0;
      const g1 = await runCheckout();
      assert(!earnCalls.some(c => c.referenceId === g1), "multi-vendor checkout: no points when the Stripe-customer lookup finds no user");
      assert(sent.some(e => e.to === consumerEmail), "multi-vendor checkout: consumer receipt still sent via the metadata userId fallback");
      assert(receiptSentCount() === 3, "multi-vendor checkout: 3 receipts (consumer, vendor, admin)");

      reset(); earnCalls.length = 0;
      (WebhookHandlers as any).findUserByStripeCustomer = async () => storage.getUser(consumer.id);
      const g2 = await runCheckout();
      assert(earnCalls.filter(c => c.referenceId === g2).length === 1, "multi-vendor checkout: points awarded once when the Stripe-customer lookup finds the user");
    } finally {
      (storage as any).earnPoints = origEarn;
      (WebhookHandlers as any).findUserByStripeCustomer = origFind;
    }
  }

  // ── Legacy deposit sender: XO keeps its own, other vendors get Outsyde ────
  {
    const [xoOwner] = await db.insert(schema.users).values({ username: `xo_${tag}`, email: `xo-${tag}@example.com`, name: "XO Owner" } as any).returning();
    const [xo] = await db.insert(schema.businesses).values({ id: XO_TEST_BUSINESS_ID, ownerId: xoOwner.id, name: "XO Beauty & Lashes", category: "beauty", contactEmail: `xo-${tag}@example.com` } as any).returning();
    const { date, time } = nextSlot();
    const [xoAppt] = await db.insert(schema.appointments).values({
      businessId: xo.id, clientId: consumer.id, appointmentDate: date, appointmentTime: time,
      totalPrice: 12500, serviceName: "Lash Bath", status: BOOKING_STATES.PENDING_PAYMENT,
    } as any).returning();
    reset();
    await WebhookHandlers.handlePaymentIntentSucceeded(pi(3000, { type: "deposit", appointmentId: xoAppt.id, businessId: xo.id }));
    const xoConsumer = sent.find(e => e.to === consumerEmail);
    const xoVendor = sent.find(e => e.to === `xo-${tag}@example.com`);
    assert(xoConsumer?.from === "XO Beauty & Lashes <bookings@xobeautyandlashes.com>", "XO deposit consumer email keeps XO's sender");
    assert(xoVendor?.from === "XO Beauty & Lashes <bookings@xobeautyandlashes.com>", "XO deposit vendor alert keeps XO's sender");
    assert(sent.find(e => e.to === ADMIN)?.from === "orders@info.goutsyde.com", "XO deposit admin copy comes from Outsyde");

    reset();
    const other = await newAppointment({ totalPrice: 12500 });
    await WebhookHandlers.handlePaymentIntentSucceeded(pi(3000, { type: "deposit", appointmentId: other.id, businessId: business.id }));
    assert(sent.filter(e => e.to !== ADMIN).every(e => e.from === "orders@info.goutsyde.com"), "non-XO deposit emails come from orders@info.goutsyde.com");
  }

  // ── Request-then-accept (vendor auto-accept OFF) ─────────────────────────
  // Mounts the real routes in-process; only the Stripe capture call is stubbed.
  // The stub can fire the payment_intent.succeeded webhook before the accept
  // route's transition, after it, or concurrently with it.
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const { registerRoutes } = await import("../server/routes");
  const { stripeService } = await import("../server/stripe/stripeService");
  const { generateAccessToken } = await import("../server/auth");

  const app = express();
  app.use(express.json());
  const server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const vendorToken = generateAccessToken({ userId: vendorUser.id, isVendor: true, businessId: business.id });
  const photogToken = generateAccessToken({ userId: photogUser.id, isVendor: false, isPhotographer: true, photographerId: photographer.id });

  type WebhookTiming = "none" | "before" | "after" | "concurrent";
  let webhookTiming: WebhookTiming = "none";
  let pendingWebhook: Promise<void> | null = null;
  (stripeService as any).capturePaymentIntent = async (paymentIntentId: string) => {
    const captured = { ...capturable.get(paymentIntentId)!, status: "succeeded" };
    const fire = () => WebhookHandlers.handlePaymentIntentSucceeded(captured);
    if (webhookTiming === "before") await fire();
    if (webhookTiming === "concurrent") pendingWebhook = fire();
    return captured;
  };
  const capturable = new Map<string, any>();

  const receiptSubjects = (kind: "appt" | "shoot") => sent.filter(e =>
    kind === "appt"
      ? /Your appointment is confirmed|New booking received|\[Outsyde\] appointment_booking/.test(e.subject)
      : /Your shoot is confirmed|New shoot booked|\[Outsyde\] shoot_booking/.test(e.subject));

  async function pendingProviderAppointment() {
    const a = await newAppointment({ totalPrice: 27500, deposit: 3000 });
    const piId = `pi_test_${randomUUID()}`;
    await db.update(schema.appointments).set({ status: BOOKING_STATES.PENDING_PROVIDER, captureMethod: "manual", stripePaymentIntentId: piId, pendingProviderExpiresAt: new Date(Date.now() + 86_400_000) } as any).where(eq(schema.appointments.id, a.id));
    capturable.set(piId, { id: piId, amount: 3240, amount_received: 3240, metadata: { type: "appointment", appointmentId: a.id, businessId: business.id, staffMemberId: "" } });
    return { id: a.id, piId };
  }
  async function pendingProviderShoot() {
    const b = await newShoot();
    const piId = `pi_test_${randomUUID()}`;
    await db.update(schema.shootBookings).set({ status: BOOKING_STATES.PENDING_PROVIDER, captureMethod: "manual", stripePaymentIntentId: piId, pendingProviderExpiresAt: new Date(Date.now() + 86_400_000) } as any).where(eq(schema.shootBookings.id, b.id));
    capturable.set(piId, { id: piId, amount: 16200, amount_received: 16200, metadata: { type: "shoot_booking", bookingId: b.id, clientId: consumer.id } });
    return { id: b.id, piId };
  }
  async function accept(kind: "appt" | "shoot", id: string) {
    const url = kind === "appt"
      ? `http://127.0.0.1:${port}/api/bookings/appointments/${id}/accept`
      : `http://127.0.0.1:${port}/api/bookings/photographer/${id}/accept`;
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${kind === "appt" ? vendorToken : photogToken}`, "Content-Type": "application/json" } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  for (const kind of ["appt", "shoot"] as const) {
    const label = kind === "appt" ? "appointment" : "shoot";
    for (const timing of ["none", "after", "before", "concurrent"] as const) {
      reset();
      webhookTiming = timing;
      pendingWebhook = null;
      const { id, piId } = kind === "appt" ? await pendingProviderAppointment() : await pendingProviderShoot();
      const res = await accept(kind, id);
      if (timing === "after") await WebhookHandlers.handlePaymentIntentSucceeded({ ...capturable.get(piId), status: "succeeded" });
      if (pendingWebhook) await pendingWebhook;
      const name = timing === "none" ? "vendor accepts (no webhook yet)" : `vendor accept + webhook ${timing}`;
      assert(res.status === 200 && res.body?.success === true, `${label} ${name}: vendor gets success (HTTP ${res.status})`);
      assert(receiptSentCount() === 3, `${label} ${name}: exactly 3 receipts sent (got ${receiptSentCount()})`);
      assert(receiptSubjects(kind).length === 3, `${label} ${name}: 3 receipt emails (consumer, vendor, admin)`);
      const row = kind === "appt"
        ? (await db.select().from(schema.appointments).where(eq(schema.appointments.id, id)))[0]
        : (await db.select().from(schema.shootBookings).where(eq(schema.shootBookings.id, id)))[0];
      assert(row.status === BOOKING_STATES.CONFIRMED, `${label} ${name}: status confirmed`);
      if (timing !== "none") {
        assert(receiptLogs.some(l => l.includes("SKIPPED: already processed")), `${label} ${name}: the losing path logs SKIPPED`);
      }
    }
  }

  // ── Admin email transport: RESEND_API_KEY, never the Replit connector ────
  {
    reset();
    const { id } = await pendingProviderAppointment();
    webhookTiming = "none";
    await accept("appt", id);
    // sendAdminBookingAlert is fire-and-forget in the accept route; give it a tick.
    for (let i = 0; i < 50 && !sent.some(e => e.subject.startsWith("[Outsyde] Booking Accepted")); i++) {
      await new Promise(r => setImmediate(r));
    }
    const alert = sent.find(e => e.subject.startsWith("[Outsyde] Booking Accepted"));
    assert(alert && alert.to === ADMIN, "admin booking alert sent via RESEND_API_KEY to ADMIN_NOTIFICATION_EMAIL");
    assert(alert && alert.from === "orders@info.goutsyde.com", "admin booking alert from orders@info.goutsyde.com");
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../server/emailService.ts", import.meta.url), "utf8");
    assert(!/getUncachableResendClient|REPLIT_CONNECTORS_HOSTNAME|X_REPLIT_TOKEN|api\/v2\/connection/.test(src), "emailService.ts has no Replit connector call");
  }

  await runCancelTests();

  server.close();
  origLog(`\nAll ${passed} assertions passed.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    origErr(err);
    process.exit(1);
  });
