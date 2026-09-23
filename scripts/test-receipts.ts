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

  origLog(`\nAll ${passed} assertions passed.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    origErr(err);
    process.exit(1);
  });
