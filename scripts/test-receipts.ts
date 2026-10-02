/**
 * Integration test for paid-transaction receipts (consumer, vendor, admin).
 *
 * Runs the real Stripe webhook handlers against a LOCAL Postgres (see
 * AGENTS.md "Local Database Setup") with outbound HTTP stubbed: Resend calls
 * are recorded instead of sent, Expo push calls are no-ops. Stripe is never
 * called — Stripe SDK methods the routes reach are stubbed, so the keys below
 * only need to be present (any placeholder value).
 *
 *   DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs" \
 *   RESEND_API_KEY=re_test ADMIN_NOTIFICATION_EMAIL=ops-test@example.com \
 *   STRIPE_SECRET_KEY=sk_test_placeholder STRIPE_PUBLISHABLE_KEY=pk_test_placeholder \
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

  // Stripe transfers never leave the process: list/create are recorded here
  // (Stripe SDK level, so transferBookingPayout's own dedupe logic runs).
  // Tests that need a different create temporarily override and restore it.
  const StripeSdk: any = (await import("stripe")).default;
  const stripeTransfers: Array<{ id: string; amount: number; destination: string; transfer_group: string; metadata: Record<string, string>; idempotencyKey?: string }> = [];
  const transferCalls: string[] = [];
  let transferCreateThrows: "none" | "before" | "after" = "none";
  StripeSdk.resources.Transfers.prototype.list = async function (p: any) {
    transferCalls.push(`transfers.list:${p?.transfer_group}`);
    return { data: stripeTransfers.filter(t => t.transfer_group === p?.transfer_group).slice(0, p?.limit ?? 10), has_more: false };
  };
  StripeSdk.resources.Transfers.prototype.create = async function (p: any, o: any) {
    transferCalls.push(`transfers.create:${p?.transfer_group}`);
    if (transferCreateThrows === "before") throw new Error("forced transfer failure");
    const t = { id: `tr_${randomUUID().slice(0, 8)}`, amount: p.amount, destination: p.destination, transfer_group: p.transfer_group, metadata: p.metadata ?? {}, idempotencyKey: o?.idempotencyKey };
    stripeTransfers.push(t);
    // Stripe created it but the response never arrived.
    if (transferCreateThrows === "after") throw new Error("forced timeout after transfer created");
    return t;
  };

  // Part 1 guard. Creates and deletes only its own rows. Refuses the production
  // Braids With Love id even if a fixture insert ever returned it.
  const BWL_BUSINESS_ID = "f94ae1a2-2ecd-40dc-8d81-4a8dfdfb0a8d";
  async function runGuardTests(): Promise<void> {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { registerRoutes } = await import("../server/routes");
    const { generateAccessToken } = await import("../server/auth");
    const gtag = randomUUID().slice(0, 8);
    const [owner] = await db.insert(schema.users).values({ username: `g_${gtag}`, email: `guard-${gtag}@example.com`, name: "Guard Owner" } as any).returning();
    const [photoUser] = await db.insert(schema.users).values({ username: `gp_${gtag}`, email: `guard-photo-${gtag}@example.com`, name: "Guard Photog" } as any).returning();
    const [biz] = await db.insert(schema.businesses).values({ ownerId: owner.id, name: `Guard Biz ${gtag}`, category: "beauty", autoAcceptBookings: true } as any).returning();
    const [photo] = await db.insert(schema.photographers).values({ userId: photoUser.id, displayName: `Guard Photog ${gtag}`, hourlyRate: 10000, autoAcceptBookings: true } as any).returning();
    assert(biz.id !== BWL_BUSINESS_ID, "guard fixture business is not Braids With Love");
    const priorAllow = process.env.MANUAL_ACCEPT_ALLOWLIST;
    const app = express();
    app.use(express.json());
    const server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const vendorToken = generateAccessToken({ userId: owner.id, isVendor: true, businessId: biz.id });
    const photoToken = generateAccessToken({ userId: photoUser.id, isVendor: false, isPhotographer: true, photographerId: photo.id });
    const call = async (method: string, path: string, token: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    const bizRow = async () => (await db.select().from(schema.businesses).where(eq(schema.businesses.id, biz.id)))[0] as any;
    const photoRow = async () => (await db.select().from(schema.photographers).where(eq(schema.photographers.id, photo.id)))[0] as any;
    try {
      delete process.env.MANUAL_ACCEPT_ALLOWLIST;
      let r = await call("PATCH", "/api/business/settings", vendorToken, { autoAcceptBookings: false });
      assert(r.status === 400 && r.body?.code === "MANUAL_ACCEPT_DISABLED", `business false → ${r.status} ${r.body?.code}`);
      assert((await bizRow()).autoAcceptBookings === true, "business false did not write the column");

      r = await call("PATCH", "/api/business/settings", vendorToken, { autoAcceptBookings: true });
      assert(r.status === 200 && r.body?.success === true, `business true → ${r.status}`);
      assert((await bizRow()).autoAcceptBookings === true, "business true still writes true");

      r = await call("PUT", "/api/businesses/me/weekly-availability", vendorToken, { slots: [], autoAcceptBookings: false });
      assert(r.status === 400 && r.body?.code === "MANUAL_ACCEPT_DISABLED", `weekly-availability false → ${r.status} ${r.body?.code}`);
      assert((await bizRow()).autoAcceptBookings === true, "weekly-availability false did not write the column");

      r = await call("PATCH", "/api/vendor/my-business", vendorToken, { name: `Guard Biz ${gtag} renamed`, autoAcceptBookings: false });
      assert(r.status === 200, `my-business with false flag → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      const afterProfile = await bizRow();
      assert(afterProfile.autoAcceptBookings === true && afterProfile.name === `Guard Biz ${gtag} renamed`, "profile save kept auto-accept and updated the name");

      r = await call("PATCH", "/api/photographers/me/settings", photoToken, { autoAcceptBookings: false });
      assert(r.status === 400 && r.body?.code === "MANUAL_ACCEPT_DISABLED", `photographer false → ${r.status} ${r.body?.code}`);
      assert((await photoRow()).autoAcceptBookings === true, "photographer false did not write the column");

      process.env.MANUAL_ACCEPT_ALLOWLIST = biz.id;
      r = await call("PATCH", "/api/business/settings", vendorToken, { autoAcceptBookings: false });
      assert(r.status === 200 && (await bizRow()).autoAcceptBookings === false, "allowlisted business can set false");
    } finally {
      if (priorAllow === undefined) delete process.env.MANUAL_ACCEPT_ALLOWLIST;
      else process.env.MANUAL_ACCEPT_ALLOWLIST = priorAllow;
      await db.delete(schema.photographers).where(eq(schema.photographers.id, photo.id));
      await db.delete(schema.businesses).where(eq(schema.businesses.id, biz.id));
      await db.delete(schema.users).where(eq(schema.users.id, owner.id));
      await db.delete(schema.users).where(eq(schema.users.id, photoUser.id));
      server.close();
    }
  }

  if (process.env.ONLY === "guard") {
    await runGuardTests();
    origLog(`\nAll ${passed} assertions passed.`);
    return;
  }

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

  // ── Free consultations ────────────────────────────────────────────────────
  // Real routes, real holds, local Postgres. Stripe is mocked at the SDK
  // resource prototypes and every call is recorded: free flows must make none.
  async function runFreeConsultationTests(): Promise<void> {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { registerRoutes } = await import("../server/routes");
    const { generateAccessToken } = await import("../server/auth");
    const Stripe: any = (await import("stripe")).default;
    const R = Stripe.resources;
    const { and: dAnd, sql: dSql } = await import("drizzle-orm");

    const app = express();
    app.use(express.json());
    // POST /api/feed reads req.session.userId only.
    app.use((req: any, _res, next) => { const u = req.headers["x-test-session-user"]; if (u) req.session = { userId: u }; next(); });
    const server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    // ── Stripe SDK recorder ─────────────────────────────────────────────────
    const stripeCalls: string[] = [];
    const orig = {
      piCreate: R.PaymentIntents.prototype.create, piCapture: R.PaymentIntents.prototype.capture,
      piCancel: R.PaymentIntents.prototype.cancel, piRetrieve: R.PaymentIntents.prototype.retrieve,
      refund: R.Refunds.prototype.create, prodCreate: R.Products.prototype.create, priceCreate: R.Prices.prototype.create,
      custCreate: R.Customers.prototype.create, custRetrieve: R.Customers.prototype.retrieve,
    };
    R.PaymentIntents.prototype.create = async function (p: any) {
      stripeCalls.push("paymentIntents.create");
      const id = `pi_free_${randomUUID().slice(0, 8)}`;
      return { id, client_secret: `${id}_secret`, amount: p.amount, capture_method: p.capture_method, status: "requires_payment_method", metadata: p.metadata };
    };
    R.PaymentIntents.prototype.capture = async function (id: string) { stripeCalls.push("paymentIntents.capture"); return { id, amount: 0, metadata: {} }; };
    R.PaymentIntents.prototype.cancel = async function (id: string) { stripeCalls.push("paymentIntents.cancel"); return { id, status: "canceled" }; };
    R.PaymentIntents.prototype.retrieve = async function (id: string) { stripeCalls.push("paymentIntents.retrieve"); return { id, status: "succeeded", amount: 0, amount_received: 0, amount_refunded: 0 }; };
    R.Refunds.prototype.create = async function () { stripeCalls.push("refunds.create"); return { id: "re_x", status: "succeeded" }; };
    R.Products.prototype.create = async function (p: any) { stripeCalls.push("products.create"); return { id: `prod_${randomUUID().slice(0, 8)}`, ...p }; };
    R.Prices.prototype.create = async function (p: any) { stripeCalls.push("prices.create"); return { id: `price_${randomUUID().slice(0, 8)}`, ...p }; };
    R.Customers.prototype.create = async function () { stripeCalls.push("customers.create"); return { id: `cus_${randomUUID().slice(0, 8)}` }; };
    R.Customers.prototype.retrieve = async function (id: string) { stripeCalls.push("customers.retrieve"); return { id, deleted: false }; };
    const transferCountBefore = stripeTransfers.length;

    const referralCalls: string[] = [];
    const origReferral = (WebhookHandlers as any).tryCompleteReferral;
    (WebhookHandlers as any).tryCompleteReferral = async (...a: any[]) => { referralCalls.push(String(a[1])); };
    const earnCalls: any[] = [];
    const origEarn = (storage as any).earnPoints;
    (storage as any).earnPoints = async function (this: any, data: any) { earnCalls.push(data); return origEarn.call(this, data); };
    const origSubActive = (storage as any).isBusinessSubscriptionActive;
    let subActive = true;
    (storage as any).isBusinessSubscriptionActive = async () => (subActive ? { active: true } : { active: false, reason: "test_inactive" });
    const priorInternalKey = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = `ik_${randomUUID()}`;

    // ── Fixtures ────────────────────────────────────────────────────────────
    const ft = randomUUID().slice(0, 8);
    async function newUser(label: string, extra: Record<string, unknown> = {}) {
      const [u] = await db.insert(schema.users).values({ username: `${label}_${ft}_${randomUUID().slice(0, 4)}`, email: `${label}-${ft}-${randomUUID().slice(0, 4)}@example.com`, name: `Free ${label}`, ...extra } as any).returning();
      return u as any;
    }
    async function newBusiness(autoAccept: boolean) {
      const owner = await newUser("fowner", { isVendor: true });
      const [b] = await db.insert(schema.businesses).values({
        ownerId: owner.id, name: `Free Biz ${autoAccept ? "auto" : "manual"} ${ft}`, category: "beauty",
        autoAcceptBookings: autoAccept, stripeAccountId: `acct_free_${randomUUID().slice(0, 8)}`, stripeOnboardingComplete: true,
        approvalStatus: "approved",
      } as any).returning();
      for (let day = 0; day < 7; day++) {
        await db.insert(schema.weeklyAvailability).values({ providerType: "business", providerId: b.id, dayOfWeek: day, startTime: "00:00", endTime: "23:59", isActive: true } as any);
      }
      return { biz: b as any, owner, token: generateAccessToken({ userId: owner.id, isVendor: true, businessId: b.id }) };
    }
    const tokenFor = (u: any) => generateAccessToken({ userId: u.id, isVendor: false });

    async function http(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    }
    const apptRow = async (id: string) => (await db.select().from(schema.appointments).where(eq(schema.appointments.id, id)))[0] as any;
    const apptsForHold = async (holdId: string) => db.select().from(schema.appointments).where(eq(schema.appointments.holdId, holdId));
    const holdRow = async (id: string) => (await db.select().from(schema.bookingHolds).where(eq(schema.bookingHolds.id, id)))[0] as any;
    async function hold(token: string, providerId: string, serviceId: string, staffMemberId?: string) {
      const { date, time } = nextSlot();
      const r = await http("POST", "/api/booking/hold", token, { providerType: "business", providerId, serviceId, date, startTime: time, ...(staffMemberId ? { staffMemberId } : {}) });
      assert(r.status === 200 && r.body?.holdId, `free: hold created (got ${r.status} ${JSON.stringify(r.body).slice(0, 200)})`);
      return r.body.holdId as string;
    }

    const auto = await newBusiness(true);
    const manual = await newBusiness(false);

    // ── Service create / patch ──────────────────────────────────────────────
    const questionsInput = [
      { label: "What's your goal?", type: "text", required: true },
      { label: "Hair length", type: "select", options: ["Short", "Long"], required: true },
      { label: "Event date", type: "date" },
    ];
    let freeSvc: any;
    {
      const r = await http("POST", "/api/vendor/services", auto.token, { name: `Free consult ${ft}`, price: 9000, depositAmountCents: 3000, durationMinutes: 30, isFreeConsultation: true, bookingQuestions: questionsInput });
      freeSvc = r.body?.service;
      assert(r.status === 200 && freeSvc?.isFreeConsultation === true && freeSvc.price === 0 && freeSvc.depositAmountCents === null,
        `free create: price forced 0, deposit null (got ${r.status} price=${freeSvc?.price} dep=${freeSvc?.depositAmountCents})`);
      assert(Array.isArray(freeSvc.bookingQuestions) && freeSvc.bookingQuestions.length === 3 && freeSvc.bookingQuestions.every((q: any) => /^[0-9a-f-]{36}$/.test(q.id)),
        "free create: 3 questions with server-generated ids");
      const bad = await http("POST", "/api/vendor/services", auto.token, { name: "bad q", durationMinutes: 30, isFreeConsultation: true, bookingQuestions: [{ label: "x", type: "select", options: ["one"] }] });
      assert(bad.status === 400 && bad.body?.code === "INVALID_BOOKING_QUESTIONS", `free create: invalid questions → 400 INVALID_BOOKING_QUESTIONS (got ${bad.status} ${bad.body?.code})`);
      const paidQ = await http("POST", "/api/vendor/services", auto.token, { name: "paid q", price: 9000, durationMinutes: 30, bookingQuestions: questionsInput });
      assert(paidQ.status === 400 && paidQ.body?.code === "INVALID_BOOKING_QUESTIONS", `paid create with questions → 400 (got ${paidQ.status})`);
      const paidLow = await http("POST", "/api/vendor/services", auto.token, { name: "paid low", price: 500, durationMinutes: 30 });
      assert(paidLow.status === 400, `paid create below $7 still → 400 (got ${paidLow.status})`);
      const badFlag = await http("POST", "/api/vendor/services", auto.token, { name: "flag", price: 9000, durationMinutes: 30, isFreeConsultation: "yes" });
      assert(badFlag.status === 400, `non-boolean isFreeConsultation → 400 (got ${badFlag.status})`);
    }
    // Patch: editing, turning off, turning on.
    {
      const [tmp] = await db.insert(schema.vendorServices).values({ businessId: auto.biz.id, name: `Toggle ${ft}`, price: 9000, durationMinutes: 30, depositAmountCents: 3000 } as any).returning();
      let r = await http("PATCH", `/api/vendor/services/${tmp.id}`, auto.token, { isFreeConsultation: true, bookingQuestions: [{ label: "Q", type: "long_text" }] });
      assert(r.status === 200 && r.body.service.isFreeConsultation === true && r.body.service.price === 0 && r.body.service.depositAmountCents === null && r.body.service.bookingQuestions.length === 1,
        `patch: turning free on forces price 0 / deposit null (got ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
      const qid = r.body.service.bookingQuestions[0].id;
      r = await http("PATCH", `/api/vendor/services/${tmp.id}`, auto.token, { price: 5000, name: `Toggle2 ${ft}`, bookingQuestions: [{ id: qid, label: "Q renamed", type: "long_text" }] });
      assert(r.status === 200 && r.body.service.price === 0 && r.body.service.name === `Toggle2 ${ft}` && r.body.service.bookingQuestions[0].id === qid,
        `patch: editing a free service keeps price 0 and existing question id (got price=${r.body?.service?.price})`);
      r = await http("PATCH", `/api/vendor/services/${tmp.id}`, auto.token, { isFreeConsultation: false });
      assert(r.status === 400 && r.body?.code === "FREE_CONSULTATION_PRICE_REQUIRED", `patch: turning free off without price → 400 FREE_CONSULTATION_PRICE_REQUIRED (got ${r.status} ${r.body?.code})`);
      r = await http("PATCH", `/api/vendor/services/${tmp.id}`, auto.token, { isFreeConsultation: false, price: 600 });
      assert(r.status === 400 && (await db.select().from(schema.vendorServices).where(eq(schema.vendorServices.id, tmp.id)))[0].isFreeConsultation === true,
        `patch: turning free off with price < $7 → 400, still free (got ${r.status})`);
      r = await http("PATCH", `/api/vendor/services/${tmp.id}`, auto.token, { isFreeConsultation: false, price: 8000 });
      assert(r.status === 200 && r.body.service.isFreeConsultation === false && r.body.service.price === 8000 && r.body.service.bookingQuestions === null,
        `patch: turning free off with price ≥ $7 → paid, questions cleared (got ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
      r = await http("PATCH", `/api/vendor/services/${tmp.id}`, auto.token, { bookingQuestions: [{ label: "x", type: "text" }] });
      assert(r.status === 400 && r.body?.code === "INVALID_BOOKING_QUESTIONS", `patch: questions on a paid service → 400 (got ${r.status})`);
      r = await http("PATCH", `/api/vendor/services/${tmp.id}`, auto.token, { price: 600 });
      assert(r.status === 400, `patch: paid min price rule unchanged (got ${r.status})`);
      await db.delete(schema.vendorServices).where(eq(schema.vendorServices.id, tmp.id));
    }
    const [paidSvc] = await db.insert(schema.vendorServices).values({ businessId: auto.biz.id, name: `Paid consult ${ft}`, price: 27500, durationMinutes: 60, status: "live", isActive: true } as any).returning();
    await db.update(schema.vendorServices).set({ status: "live", isActive: true } as any).where(eq(schema.vendorServices.id, freeSvc.id));
    const r2 = await http("POST", "/api/vendor/services", manual.token, { name: `Free manual ${ft}`, durationMinutes: 30, isFreeConsultation: true, bookingQuestions: questionsInput });
    const manualSvc = r2.body.service;
    await db.update(schema.vendorServices).set({ status: "live", isActive: true } as any).where(eq(schema.vendorServices.id, manualSvc.id));

    const answersFor = (svc: any, goal = "Volume <b>boost</b> & shine") => {
      const qs = svc.bookingQuestions;
      return [{ questionId: qs[0].id, answer: goal }, { questionId: qs[1].id, answer: "Long" }];
    };

    // ── Go-live: gate unchanged, no Stripe catalog for free ─────────────────
    {
      await db.update(schema.vendorServices).set({ status: "draft" } as any).where(eq(schema.vendorServices.id, freeSvc.id));
      stripeCalls.length = 0;
      subActive = false;
      let r = await http("POST", `/api/vendor/services/${freeSvc.id}/go-live`, auto.token);
      assert(r.status === 409 && r.body?.code === "subscription_inactive", `go-live free: subscription gate still applies (got ${r.status} ${r.body?.code})`);
      subActive = true;
      r = await http("POST", `/api/vendor/services/${freeSvc.id}/go-live`, auto.token);
      assert(r.status === 200 && r.body.service.status === "live" && r.body.service.stripeProductId === null && r.body.service.stripePriceId === null,
        `go-live free: live with no Stripe Product/Price (got ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
      assert(!stripeCalls.includes("products.create") && !stripeCalls.includes("prices.create"), `go-live free: no Stripe catalog calls (got ${JSON.stringify(stripeCalls)})`);
    }

    // ── Free auto-accept: hold → confirm-free → confirmed ───────────────────
    const c1 = await newUser("fc1");
    const t1 = tokenFor(c1);
    let autoApptId = "";
    let autoHoldId = "";
    {
      reset(); stripeCalls.length = 0; earnCalls.length = 0; referralCalls.length = 0;
      autoHoldId = await hold(t1, auto.biz.id, freeSvc.id);
      const r = await http("POST", `/api/booking/${autoHoldId}/confirm-free`, t1, { answers: answersFor(freeSvc) });
      assert(r.status === 200 && r.body.free === true && r.body.status === "confirmed" && !!r.body.appointmentId && typeof r.body.bookingNumber === "number",
        `free auto: confirm-free → 200 { free, appointmentId, bookingNumber, status: confirmed } (got ${r.status} ${JSON.stringify(r.body)})`);
      autoApptId = r.body.appointmentId;
      const row = await apptRow(autoApptId);
      assert(row.status === "confirmed" && row.paymentMethod === "free" && row.totalPrice === 0 && row.platformFee === 0 && row.vendorNet === 0
        && row.depositAmountCents === null && row.captureMethod === null && row.stripePaymentIntentId === null && row.servicePriceCents === 0,
        `free auto: row is free/0/no deposit/no capture/no PI (got ${JSON.stringify({ s: row.status, pm: row.paymentMethod, tp: row.totalPrice, d: row.depositAmountCents, c: row.captureMethod, pi: row.stripePaymentIntentId })})`);
      assert(!!row.settledAt && row.stripeTransferId === null, "free auto: settled_at claimed, no transfer id");
      assert(Array.isArray(row.bookingAnswers) && row.bookingAnswers.length === 3 && row.bookingAnswers[0].answer === "Volume <b>boost</b> & shine"
        && row.bookingAnswers[0].label === "What's your goal?" && row.bookingAnswers[2].answer === null,
        "free auto: answers snapshot saved (label + type + answer, unanswered optional = null)");
      assert((await holdRow(autoHoldId)).status === "converted", "free auto: hold converted");
      assert(stripeCalls.length === 0, `free auto: zero Stripe calls (got ${JSON.stringify(stripeCalls)})`);
      assert(stripeTransfers.length === transferCountBefore, "free auto: no transfer");
      const pend = await db.select().from(schema.pendingPointTransactions).where(eq(schema.pendingPointTransactions.referenceId, autoApptId));
      assert(pend.length === 0 && earnCalls.length === 0, "free auto: no points (pending or earned)");
      assert(referralCalls.length === 0, "free auto: no referral completion");
      const subjects = sent.map(s => `${s.to} | ${s.subject}`);
      assert(sent.length === 3 && sent.some(s => s.to === c1.email && s.subject.startsWith("🎉 Your free consultation is confirmed"))
        && sent.some(s => s.to === auto.owner.email && s.subject.startsWith("📋 New free consultation"))
        && sent.some(s => s.to === ADMIN && s.subject.startsWith("[Outsyde] Free Consultation CONFIRMED")),
        `free auto: consumer/vendor/admin free receipts (got ${JSON.stringify(subjects)})`);
      assert(sent.every(s => !s.html.includes("<b>boost</b>") && s.html.includes("Volume &lt;b&gt;boost&lt;/b&gt; &amp; shine")), "free auto: answers HTML-escaped in every email");
      assert(sent.every(s => !/Total Paid|Your Payout|platform fee/i.test(s.html)), "free auto: no money lines in free emails");
      const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.referenceId, autoApptId));
      assert(notes.length === 2 && notes.every((n: any) => n.title === "Booking confirmed"), `free auto: in-app "Booking confirmed" for customer + owner (got ${JSON.stringify(notes.map((n: any) => n.title))})`);
    }

    // ── Idempotent retry ────────────────────────────────────────────────────
    {
      reset();
      const r = await http("POST", `/api/booking/${autoHoldId}/confirm-free`, t1, { answers: answersFor(freeSvc) });
      assert(r.status === 200 && r.body.appointmentId === autoApptId && r.body.status === "confirmed", `free retry: same appointment returned (got ${r.status} ${JSON.stringify(r.body)})`);
      assert((await apptsForHold(autoHoldId)).length === 1 && sent.length === 0, "free retry: no second row, no second receipts");
    }

    // ── Limit 409, then frees up after cancel ───────────────────────────────
    let secondHold = "";
    {
      reset(); stripeCalls.length = 0;
      secondHold = await hold(t1, auto.biz.id, freeSvc.id);
      const r = await http("POST", `/api/booking/${secondHold}/confirm-free`, t1, { answers: answersFor(freeSvc) });
      assert(r.status === 409 && r.body?.code === "FREE_CONSULTATION_LIMIT" && !!r.body?.message, `free limit: second open consultation → 409 FREE_CONSULTATION_LIMIT (got ${r.status} ${r.body?.code})`);
      assert((await apptsForHold(secondHold)).length === 0 && sent.length === 0, "free limit: no row, no email");
      // Another business is a separate limit.
      const otherHold = await hold(t1, manual.biz.id, manualSvc.id);
      const other = await http("POST", `/api/booking/${otherHold}/confirm-free`, t1, { answers: answersFor(manualSvc) });
      assert(other.status === 200 && other.body.status === "pending_provider", `free limit: is per business (other business → ${other.status} ${other.body?.status})`);

      const preview = await http("GET", `/api/bookings/appointments/${autoApptId}/cancel-preview`, t1);
      assert(preview.status === 200 && preview.body.cancellable === true && preview.body.isFreeConsultation === true && preview.body.refundAmountCents === 0
        && preview.body.feeAmountCents === 0 && preview.body.chargedAmountCents === 0, `free cancel-preview: free, no refund, no fee (got ${JSON.stringify(preview.body)})`);
      const cancel = await http("POST", `/api/bookings/appointments/${autoApptId}/cancel`, t1);
      assert(cancel.status === 200 && cancel.body.refundAmountCents === 0 && cancel.body.feeAmountCents === 0 && cancel.body.feeCharged === false,
        `free cancel: 200, no refund, no fee (got ${cancel.status} ${JSON.stringify(cancel.body)})`);
      assert((await apptRow(autoApptId)).status === "canceled" && stripeCalls.length === 0, `free cancel: canceled, zero Stripe calls (got ${JSON.stringify(stripeCalls)})`);
      const again = await http("POST", `/api/booking/${secondHold}/confirm-free`, t1, { answers: answersFor(freeSvc) });
      assert(again.status === 200 && again.body.status === "confirmed", `free limit: after cancel the same customer can book again (got ${again.status} ${JSON.stringify(again.body)})`);
    }

    // ── Free manual: pending_provider → accept → confirmed + free receipts ──
    {
      reset(); stripeCalls.length = 0;
      const c2 = await newUser("fc2");
      const t2 = tokenFor(c2);
      const h = await hold(t2, manual.biz.id, manualSvc.id);
      const r = await http("POST", `/api/booking/${h}/confirm-free`, t2, { answers: answersFor(manualSvc, "Trim") });
      assert(r.status === 200 && r.body.free === true && r.body.status === "pending_provider", `free manual: confirm-free → pending_provider (got ${r.status} ${JSON.stringify(r.body)})`);
      const id = r.body.appointmentId;
      let row = await apptRow(id);
      assert(row.status === "pending_provider" && row.paymentMethod === "free" && !!row.pendingProviderExpiresAt && !row.settledAt && row.captureMethod === null,
        "free manual: pending_provider row, expiry set, not settled");
      assert((await holdRow(h)).status === "active", "free manual: hold not converted before accept");
      const subjects = sent.map(s => `${s.to} | ${s.subject}`);
      assert(sent.length === 3 && sent.some(s => s.to === c2.email && s.subject.startsWith("Consultation request received"))
        && sent.some(s => s.to === manual.owner.email && s.subject.startsWith("New consultation request"))
        && sent.some(s => s.to === ADMIN && s.subject.includes("Free Consultation REQUESTED"))
        && !sent.some(s => /Booking request received|New booking request/.test(s.subject)),
        `free manual: free request notifier, not notifyPendingBookingRequest (got ${JSON.stringify(subjects)})`);
      assert(sent.every(s => !/authorized|charged/i.test(s.html)), "free manual: no card-authorization wording");

      reset();
      const acc = await http("POST", `/api/bookings/appointments/${id}/accept`, manual.token);
      row = await apptRow(id);
      assert(acc.status === 200 && row.status === "confirmed" && !!row.settledAt && row.stripeTransferId === null, `free manual accept: confirmed + settled (got ${acc.status} ${row.status})`);
      assert((await holdRow(h)).status === "converted", "free manual accept: hold converted");
      const accSubjects = sent.map(s => `${s.to} | ${s.subject}`);
      assert(sent.length === 3 && sent.some(s => s.to === c2.email && s.subject.startsWith("Consultation accepted"))
        && sent.some(s => s.to === manual.owner.email && s.subject.startsWith("📋 New free consultation"))
        && sent.some(s => s.to === ADMIN && s.subject.includes("Free Consultation ACCEPTED")),
        `free manual accept: free receipts (got ${JSON.stringify(accSubjects)})`);
      assert(stripeCalls.length === 0 && stripeTransfers.length === transferCountBefore, `free manual: zero Stripe calls, no transfer (got ${JSON.stringify(stripeCalls)})`);

      // Vendor /refund on a free booking: plain state-machine cancel.
      const ref = await http("POST", `/api/bookings/appointments/${id}/refund`, manual.token, { reason: "Vendor sick" });
      assert(ref.status === 200 && (await apptRow(id)).status === "canceled" && stripeCalls.length === 0, `free /refund: plain cancel, no Stripe (got ${ref.status} ${JSON.stringify(ref.body)})`);
    }

    // ── Complete: no COMPLETION_POINTS ──────────────────────────────────────
    {
      reset(); earnCalls.length = 0;
      const c3 = await newUser("fc3");
      const t3 = tokenFor(c3);
      const h = await hold(t3, auto.biz.id, freeSvc.id);
      const r = await http("POST", `/api/booking/${h}/confirm-free`, t3, { answers: answersFor(freeSvc) });
      const done = await http("PATCH", `/api/bookings/appointments/${r.body.appointmentId}/complete`, auto.token);
      assert(done.status === 200 && done.body.pointsAwarded === 0 && earnCalls.length === 0 && (await apptRow(r.body.appointmentId)).status === "completed",
        `free complete: completed, 0 points (got ${done.status} ${JSON.stringify(done.body)}, earnPoints calls ${earnCalls.length})`);
      // The completed one no longer blocks.
      const h2 = await hold(t3, auto.biz.id, freeSvc.id);
      const r2b = await http("POST", `/api/booking/${h2}/confirm-free`, t3, { answers: answersFor(freeSvc) });
      assert(r2b.status === 200, `free limit: completed consultation does not block (got ${r2b.status})`);
    }

    // ── Invalid answers / not free ──────────────────────────────────────────
    {
      const c4 = await newUser("fc4");
      const t4 = tokenFor(c4);
      const h = await hold(t4, auto.biz.id, freeSvc.id);
      let r = await http("POST", `/api/booking/${h}/confirm-free`, t4, { answers: [{ questionId: freeSvc.bookingQuestions[1].id, answer: "Medium" }] });
      assert(r.status === 400 && r.body?.code === "INVALID_BOOKING_ANSWERS" && Array.isArray(r.body.errors) && r.body.errors.length === 2,
        `confirm-free: missing required + bad select → 400 INVALID_BOOKING_ANSWERS (got ${r.status} ${JSON.stringify(r.body)})`);
      r = await http("POST", `/api/booking/${h}/confirm-free`, t4, { answers: [...answersFor(freeSvc), { questionId: "unknown", answer: "x" }] });
      assert(r.status === 400 && r.body?.code === "INVALID_BOOKING_ANSWERS", "confirm-free: unknown question id → 400");
      assert((await apptsForHold(h)).length === 0, "confirm-free: invalid answers create no row");
      const paidHold = await hold(t4, auto.biz.id, paidSvc.id);
      r = await http("POST", `/api/booking/${paidHold}/confirm-free`, t4, {});
      assert(r.status === 400 && r.body?.code === "NOT_FREE_CONSULTATION" && (await apptsForHold(paidHold)).length === 0, `confirm-free on a paid service → 400 NOT_FREE_CONSULTATION (got ${r.status} ${r.body?.code})`);
      const other = await newUser("fc4b");
      r = await http("POST", `/api/booking/${h}/confirm-free`, tokenFor(other), { answers: answersFor(freeSvc) });
      assert(r.status === 400 && (await apptsForHold(h)).length === 0, `confirm-free: another user's hold → 400 (got ${r.status})`);
      r = await http("POST", `/api/booking/${h}/confirm-free`, null, {});
      assert(r.status === 401, `confirm-free: unauthenticated → 401 (got ${r.status})`);
    }

    // ── Payment routes refuse free holds; staff holds rejected ──────────────
    {
      const c5 = await newUser("fc5");
      const t5 = tokenFor(c5);
      stripeCalls.length = 0;
      const before = (await db.select({ n: dSql<number>`count(*)::int` }).from(schema.appointments))[0].n;
      const h = await hold(t5, auto.biz.id, freeSvc.id);
      let r = await http("POST", `/api/booking/${h}/create-payment-intent`, t5, {});
      assert(r.status === 400 && r.body?.code === "FREE_CONSULTATION" && !!r.body?.message && !!r.body?.error, `create-payment-intent on a free hold → 400 FREE_CONSULTATION (got ${r.status} ${JSON.stringify(r.body)})`);
      r = await http("POST", `/api/booking/${h}/create-deposit-intent`, t5, {});
      assert(r.status === 400 && r.body?.code === "FREE_CONSULTATION", `create-deposit-intent on a free hold → 400 FREE_CONSULTATION (got ${r.status} ${JSON.stringify(r.body)})`);

      const staffUser = await newUser("fstaff");
      const [staff] = await db.insert(schema.staffMembers).values({ businessId: auto.biz.id, userId: staffUser.id, displayName: "Free Staff", status: "active", stripeOnboardingComplete: true, stripeAccountId: `acct_fs_${ft}` } as any).returning();
      await db.insert(schema.staffServices).values({ staffMemberId: staff.id, businessId: auto.biz.id, name: "Staff svc", priceCents: 9000, durationMinutes: 30, status: "live" } as any);
      for (let day = 0; day < 7; day++) {
        await db.insert(schema.weeklyAvailability).values({ providerType: "business", providerId: auto.biz.id, staffMemberId: staff.id, dayOfWeek: day, startTime: "00:00", endTime: "23:59", isActive: true } as any);
      }
      const sh = await hold(t5, auto.biz.id, freeSvc.id, staff.id);
      r = await http("POST", `/api/booking/${sh}/confirm-free`, t5, { answers: answersFor(freeSvc) });
      assert(r.status === 400 && r.body?.code === "FREE_CONSULTATION_STAFF_UNSUPPORTED", `confirm-free with a staff-selected hold → 400 FREE_CONSULTATION_STAFF_UNSUPPORTED (got ${r.status} ${r.body?.code})`);
      r = await http("POST", `/api/booking/${sh}/create-payment-intent`, t5, {});
      assert(r.status === 400 && r.body?.code === "FREE_CONSULTATION", `create-payment-intent on a staff-selected free hold → 400 FREE_CONSULTATION (got ${r.status} ${r.body?.code})`);
      r = await http("POST", `/api/booking/${sh}/create-deposit-intent`, t5, {});
      assert(r.status === 400 && r.body?.code === "FREE_CONSULTATION", `create-deposit-intent on a staff-selected free hold → 400 FREE_CONSULTATION (got ${r.status} ${r.body?.code})`);
      const after = (await db.select({ n: dSql<number>`count(*)::int` }).from(schema.appointments))[0].n;
      assert(after === before && stripeCalls.length === 0, `payment routes on free holds: zero new rows, zero Stripe calls (rows ${before}→${after}, stripe ${JSON.stringify(stripeCalls)})`);

      // A paid hold still reaches Stripe (guard does not over-match).
      const ph = await hold(t5, auto.biz.id, paidSvc.id);
      r = await http("POST", `/api/booking/${ph}/create-payment-intent`, t5, {});
      assert(r.status === 200 && !!r.body.clientSecret && r.body.chargeAmountCents === 27500 && stripeCalls.includes("paymentIntents.create"), `paid hold still creates its PaymentIntent (got ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
    }

    // ── apply-deposit-to-all with a free service present ────────────────────
    {
      const r = await http("POST", "/api/vendor/services/apply-deposit-to-all", auto.token, { depositAmountCents: 3000 });
      const rows = await db.select().from(schema.vendorServices).where(eq(schema.vendorServices.businessId, auto.biz.id));
      const free = rows.find((s: any) => s.id === freeSvc.id) as any;
      const paid = rows.find((s: any) => s.id === paidSvc.id) as any;
      assert(r.status === 200 && r.body.updatedCount === rows.filter((s: any) => !s.isFreeConsultation).length,
        `apply-deposit-to-all: 200, free skipped in update count (got ${r.status} ${JSON.stringify(r.body)})`);
      assert(free.depositAmountCents === null && free.price === 0 && paid.depositAmountCents === 3000, "apply-deposit-to-all: free untouched (no deposit), paid updated");
    }

    // ── Capability filter: public lists only ────────────────────────────────
    {
      const ik = { "x-internal-api-key": process.env.INTERNAL_API_KEY! };
      const ids = (r: any) => (r.body.services ?? []).map((s: any) => s.id);
      let r = await http("GET", `/api/businesses/${auto.biz.id}/services`, null, undefined, ik);
      assert(r.status === 200 && ids(r).includes(paidSvc.id) && !ids(r).includes(freeSvc.id), `public services without capability: free hidden (got ${r.status} ${JSON.stringify(ids(r))})`);
      r = await http("GET", `/api/businesses/${auto.biz.id}/services`, null, undefined, { ...ik, "X-Outsyde-Capabilities": "something-else, free-consultation" });
      const freeDto = (r.body.services ?? []).find((s: any) => s.id === freeSvc.id);
      assert(r.status === 200 && ids(r).includes(paidSvc.id) && !!freeDto && freeDto.isFreeConsultation === true && Array.isArray(freeDto.bookingQuestions),
        "public services with capability: free shown with isFreeConsultation + bookingQuestions");
      const paidDto = (r.body.services ?? []).find((s: any) => s.id === paidSvc.id);
      assert(paidDto.isFreeConsultation === false && paidDto.bookingQuestions === null, "public services: paid DTO carries isFreeConsultation false");

      r = await http("GET", "/api/vendor/services", auto.token);
      assert(r.status === 200 && ids(r).includes(freeSvc.id), "owner list /api/vendor/services: not filtered");
      r = await http("GET", "/api/business/services", auto.token);
      assert(r.status === 200 && ids(r).includes(freeSvc.id), `owner list /api/business/services: not filtered (got ${r.status})`);

      const q = encodeURIComponent(ft);
      const searchIds = (x: any) => (x.body.results ?? []).map((s: any) => s.id);
      r = await http("GET", `/api/search?q=${q}&scope=services`, null);
      assert(r.status === 200 && searchIds(r).includes(paidSvc.id) && !searchIds(r).includes(freeSvc.id), `/api/search without capability: free hidden (got ${r.status} ${JSON.stringify(searchIds(r))} ${JSON.stringify(r.body).slice(0, 200)})`);
      r = await http("GET", `/api/search?q=${q}&scope=services`, null, undefined, { "X-Outsyde-Capabilities": "free-consultation" });
      assert(r.status === 200 && searchIds(r).includes(freeSvc.id), "/api/search with capability: free shown");

      await storage.rebuildSearchIndex();
      const idx = await db.select().from(schema.searchIndex).where(dAnd(eq(schema.searchIndex.entityType, "service"), eq(schema.searchIndex.parentId, auto.biz.id)));
      const idxIds = idx.map((e: any) => e.entityId);
      assert(idxIds.includes(paidSvc.id) && !idxIds.includes(freeSvc.id), `unified-search index: paid indexed, free excluded (got ${JSON.stringify(idxIds)})`);
    }

    // ── Feed post attach rejects free services ──────────────────────────────
    {
      await db.update(schema.users).set({ isVendor: true } as any).where(eq(schema.users.id, auto.owner.id));
      let r = await http("POST", "/api/feed", null, { content: "come see us", postType: "service", serviceId: freeSvc.id }, { "x-test-session-user": auto.owner.id });
      assert(r.status === 400 && r.body?.code === "FREE_CONSULTATION_NOT_ATTACHABLE", `feed attach free service → 400 (got ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
      r = await http("POST", "/api/feed", null, { content: "come see us", postType: "service", serviceId: paidSvc.id }, { "x-test-session-user": auto.owner.id });
      assert(r.body?.code !== "FREE_CONSULTATION_NOT_ATTACHABLE", `feed attach paid service not blocked by the free check (got ${r.status})`);
    }

    // ── Appointment DTOs (storage) ──────────────────────────────────────────
    {
      const bizList = await storage.getAppointmentsByBusinessWithDetails(auto.biz.id);
      const freeRow = bizList.find((a: any) => a.isFreeConsultation === true) as any;
      assert(!!freeRow && Array.isArray(freeRow.bookingAnswers) && freeRow.chargedAmountCents === 0, "getAppointmentsByBusinessWithDetails: isFreeConsultation + bookingAnswers");
      const paidRow = bizList.find((a: any) => a.isFreeConsultation === false) as any;
      assert(!!paidRow && paidRow.bookingAnswers === null, "getAppointmentsByBusinessWithDetails: paid rows isFreeConsultation false, answers null");
      const clientList = await storage.getAppointmentsByClientWithDetails(c1.id);
      assert(clientList.length > 0 && clientList.every((a: any) => a.isFreeConsultation === true && Array.isArray(a.bookingAnswers) && !("paymentMethod" in a)),
        "getAppointmentsByClientWithDetails: isFreeConsultation + bookingAnswers, no extra paymentMethod key");
    }

    // ── Restore ──────────────────────────────────────────────────────────────
    Object.assign(R.PaymentIntents.prototype, { create: orig.piCreate, capture: orig.piCapture, cancel: orig.piCancel, retrieve: orig.piRetrieve });
    R.Refunds.prototype.create = orig.refund;
    R.Products.prototype.create = orig.prodCreate;
    R.Prices.prototype.create = orig.priceCreate;
    Object.assign(R.Customers.prototype, { create: orig.custCreate, retrieve: orig.custRetrieve });
    (WebhookHandlers as any).tryCompleteReferral = origReferral;
    (storage as any).earnPoints = origEarn;
    (storage as any).isBusinessSubscriptionActive = origSubActive;
    if (priorInternalKey === undefined) delete process.env.INTERNAL_API_KEY; else process.env.INTERNAL_API_KEY = priorInternalKey;
    server.close();
  }

  if (process.env.ONLY === "free") {
    await runFreeConsultationTests();
    origLog(`\nAll ${passed} assertions passed.`);
    return;
  }

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
      transferBookingPayout: async (a: any) => { stripeCalls.push(`transferBookingPayout:${a?.recipient}`); return { id: "tr_test" }; },
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

  // ── App deposit prerequisites (Fix 2) ─────────────────────────────────────
  // Real routes and stripeService; Stripe mocked only at the SDK resource
  // prototypes. Each check is tagged with its test id and reported as a
  // PASS/FAIL table (no early exit), so the same file run against main shows
  // exactly which ids fail there.
  async function runDepositTests(): Promise<{ failed: string[] }> {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { registerRoutes } = await import("../server/routes");
    const { generateAccessToken } = await import("../server/auth");
    const Stripe: any = (await import("stripe")).default;
    const R = Stripe.resources;

    const results = new Map<string, string[]>();
    const check = (id: string, cond: unknown, msg: string) => {
      if (!results.has(id)) results.set(id, []);
      if (!cond) results.get(id)!.push(msg);
    };

    const app = express();
    app.use(express.json());
    const server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    // ── Fixtures ────────────────────────────────────────────────────────────
    const dtag = randomUUID().slice(0, 8);
    const [vendor2] = await db.insert(schema.users).values({ username: `v2_${dtag}`, email: `vendor2-${dtag}@example.com`, name: "Vendor Two" } as any).returning();
    const [business2] = await db.insert(schema.businesses).values({ ownerId: vendor2.id, name: "Second Braids", category: "beauty" } as any).returning();
    await db.update(schema.businesses).set({ stripeAccountId: `acct_biz_${dtag}`, autoAcceptBookings: true } as any).where(eq(schema.businesses.id, business.id));
    await db.update(schema.photographers).set({ stripeAccountId: `acct_ph_${dtag}`, stripeOnboardingComplete: true, autoAcceptBookings: true } as any).where(eq(schema.photographers.id, photographer.id));
    await db.update(schema.users).set({ stripeCustomerId: `cus_dep_${dtag}` } as any).where(eq(schema.users.id, consumer.id));
    const [staffUser] = await db.insert(schema.users).values({ username: `s_${dtag}`, email: `staff-${dtag}@example.com`, name: "Test Staff" } as any).returning();
    const [staff] = await db.insert(schema.staffMembers).values({ businessId: business.id, userId: staffUser.id, displayName: "Test Staff", status: "active", stripeOnboardingComplete: true, stripeAccountId: `acct_staff_${dtag}` } as any).returning();
    const [staffSvc] = await db.insert(schema.staffServices).values({ staffMemberId: staff.id, businessId: business.id, name: "Staff braids", priceCents: 12500, durationMinutes: 60, status: "live" } as any).returning();
    const [photoSvc] = await db.insert(schema.photographerServices).values({ photographerId: photographer.id, name: "Portrait", priceCents: 15000, estimatedDurationMinutes: 60, status: "live" } as any).returning();
    const [bizDep] = await db.insert(schema.vendorServices).values({ businessId: business.id, name: "Knotless (deposit)", price: 27500, durationMinutes: 60, depositAmountCents: 3000 } as any).returning();
    const [bizFull] = await db.insert(schema.vendorServices).values({ businessId: business.id, name: "Knotless (full)", price: 27500, durationMinutes: 60 } as any).returning();
    for (let day = 0; day < 7; day++) {
      await db.insert(schema.weeklyAvailability).values([
        { providerType: "business", providerId: business.id, dayOfWeek: day, startTime: "00:00", endTime: "23:59", isActive: true },
        { providerType: "business", providerId: business.id, staffMemberId: staff.id, dayOfWeek: day, startTime: "00:00", endTime: "23:59", isActive: true },
        { providerType: "photographer", providerId: photographer.id, dayOfWeek: day, startTime: "00:00", endTime: "23:59", isActive: true },
      ] as any);
    }
    const tok = {
      consumer: generateAccessToken({ userId: consumer.id, isVendor: false }),
      vendor: generateAccessToken({ userId: vendorUser.id, isVendor: true, businessId: business.id }),
      vendor2: generateAccessToken({ userId: vendor2.id, isVendor: true, businessId: business2.id }),
      staff: generateAccessToken({ userId: staffUser.id, isVendor: false }),
      photog: generateAccessToken({ userId: photogUser.id, isVendor: false, isPhotographer: true, photographerId: photographer.id }),
    };
    async function http(method: string, path: string, who: keyof typeof tok, body?: unknown) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { Authorization: `Bearer ${tok[who]}`, "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    }

    // ── Faithful Stripe SDK mock ─────────────────────────────────────────────
    const canon = (v: any): any => Array.isArray(v) ? v.map(canon)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
    const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
    const byKey = new Map<string, { params: any; pi: any }>();
    const piById = new Map<string, any>();
    const createCalls: Array<{ key: string | undefined; params: any }> = [];
    const createdIds: string[] = [];
    let nextCreateMode: "normal" | "fail_before" | "created_then_lost" = "normal";
    let retrieveStatus = "requires_payment_method";
    const orig = {
      piCreate: R.PaymentIntents.prototype.create, piRetrieve: R.PaymentIntents.prototype.retrieve,
      piCancel: R.PaymentIntents.prototype.cancel, custRetrieve: R.Customers.prototype.retrieve,
      custCreate: R.Customers.prototype.create, trCreate: R.Transfers.prototype.create,
    };
    R.PaymentIntents.prototype.create = async function (params: any, opts: any) {
      const key: string | undefined = opts?.idempotencyKey;
      createCalls.push({ key, params: canon(params) });
      const mode = nextCreateMode; nextCreateMode = "normal";
      if (mode === "fail_before") throw Object.assign(new Error("connection error before Stripe executed"), { type: "StripeConnectionError" });
      if (key && byKey.has(key)) {
        const prior = byKey.get(key)!;
        if (!same(prior.params, params)) {
          throw Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"),
            { type: "StripeIdempotencyError", rawType: "idempotency_error" });
        }
        return prior.pi;
      }
      const id = `pi_mock_${randomUUID().slice(0, 12)}`;
      const pi = { id, object: "payment_intent", client_secret: `${id}_secret`, amount: params.amount, amount_received: 0,
        capture_method: params.capture_method, status: "requires_payment_method", metadata: params.metadata };
      createdIds.push(id); piById.set(id, pi);
      if (key) byKey.set(key, { params: canon(params), pi });
      if (mode === "created_then_lost") throw Object.assign(new Error("connection lost after Stripe created the PaymentIntent"), { type: "StripeConnectionError" });
      return pi;
    };
    R.PaymentIntents.prototype.retrieve = async function (id: string) {
      const pi = piById.get(id);
      return { ...(pi ?? { id, amount: 0 }), status: retrieveStatus };
    };
    R.PaymentIntents.prototype.cancel = async function (id: string) { return { id, status: "canceled" }; };
    R.Customers.prototype.retrieve = async function (id: string) { return { id, deleted: false }; };
    R.Customers.prototype.create = async function () { return { id: `cus_new_${randomUUID().slice(0, 8)}` }; };
    const depTransfers: Array<{ id: string; amount: number; destination: string; transfer_group: string; metadata: Record<string, string> }> = [];
    R.Transfers.prototype.create = async function (p: any) {
      const t = { id: `tr_${randomUUID().slice(0, 8)}`, amount: p.amount, destination: p.destination, transfer_group: p.transfer_group, metadata: p.metadata ?? {} };
      depTransfers.push(t);
      return t;
    };

    async function hold(kind: "dep" | "full" | "staff" | "photo") {
      const { date, time } = nextSlot();
      const body = kind === "photo"
        ? { providerType: "photographer", providerId: photographer.id, serviceId: photoSvc.id, date, startTime: time }
        : kind === "staff"
          ? { providerType: "business", providerId: business.id, staffMemberId: staff.id, serviceId: staffSvc.id, date, startTime: time }
          : { providerType: "business", providerId: business.id, serviceId: kind === "dep" ? bizDep.id : bizFull.id, date, startTime: time };
      return http("POST", "/api/booking/hold", "consumer", body);
    }
    const pay = (holdId: string) => http("POST", `/api/booking/${holdId}/create-payment-intent`, "consumer", {});
    const lastCreate = () => createCalls[createCalls.length - 1];
    const apptsForHold = async (holdId: string) => db.select().from(schema.appointments).where(eq(schema.appointments.holdId, holdId));

    // ── T-2a: POST /api/vendor/services with Bearer only ────────────────────
    {
      const r = await http("POST", "/api/vendor/services", "vendor", { name: `Bearer svc ${dtag}`, price: 9000, durationMinutes: 60 });
      check("T-2a", r.status === 200 && r.body?.service?.businessId === business.id, `vendor Bearer POST → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
      const r2 = await http("POST", "/api/vendor/services", "vendor2", { name: `Bearer svc2 ${dtag}`, price: 9000, durationMinutes: 60 });
      check("T-2a", r2.status === 200 && r2.body?.service?.businessId === business2.id, `second vendor Bearer POST → ${r2.status}, businessId ${r2.body?.service?.businessId}`);
    }

    // ── T-2b: deposit validation ────────────────────────────────────────────
    {
      const post = (dep: number) => http("POST", "/api/vendor/services", "vendor", { name: `Dep ${dep} ${randomUUID().slice(0, 4)}`, price: 27500, durationMinutes: 60, depositAmountCents: dep });
      let r = await post(500);
      check("T-2b", r.status === 400 && r.body?.code === "INVALID_DEPOSIT" && !!r.body?.message && !!r.body?.error, `POST D=500 → ${r.status} ${r.body?.code}`);
      r = await post(27500);
      check("T-2b", r.status === 400 && r.body?.code === "INVALID_DEPOSIT", `POST D=B → ${r.status} ${r.body?.code}`);
      r = await post(0);
      check("T-2b", r.status === 200 && r.body?.service?.depositAmountCents === null, `POST D=0 → ${r.status}, stored ${r.body?.service?.depositAmountCents}`);
      r = await post(3000);
      check("T-2b", r.status === 200 && r.body?.service?.depositAmountCents === 3000, `POST D=3000 → ${r.status}, stored ${r.body?.service?.depositAmountCents}`);

      const [pSvc] = await db.insert(schema.vendorServices).values({ businessId: business.id, name: "Patch target", price: 27500, durationMinutes: 60, depositAmountCents: 3000 } as any).returning();
      r = await http("PATCH", `/api/vendor/services/${pSvc.id}`, "vendor", { price: 2500 });
      const [pAfter] = await db.select().from(schema.vendorServices).where(eq(schema.vendorServices.id, pSvc.id));
      check("T-2b", r.status === 400 && r.body?.code === "INVALID_DEPOSIT" && (pAfter as any).price === 27500, `PATCH price below stored D → ${r.status}, price now ${(pAfter as any).price}`);
      const [legacy] = await db.insert(schema.vendorServices).values({ businessId: business.id, name: "Legacy D=500", price: 27500, durationMinutes: 60, depositAmountCents: 500 } as any).returning();
      r = await http("PATCH", `/api/vendor/services/${legacy.id}`, "vendor", { name: "Legacy renamed" });
      check("T-2b", r.status === 200, `PATCH name only on legacy D=500 row → ${r.status}`);

      const [a1] = await db.insert(schema.vendorServices).values({ businessId: business2.id, name: "B2 big", price: 27500, durationMinutes: 60 } as any).returning();
      const [a2] = await db.insert(schema.vendorServices).values({ businessId: business2.id, name: "B2 small", price: 2500, durationMinutes: 60 } as any).returning();
      r = await http("POST", "/api/vendor/services/apply-deposit-to-all", "vendor2", { depositAmountCents: 3000 });
      const rowsAfter = await db.select().from(schema.vendorServices).where(eq(schema.vendorServices.businessId, business2.id));
      check("T-2b", r.status === 400 && r.body?.code === "INVALID_DEPOSIT"
        && Array.isArray(r.body?.invalidServices) && r.body.invalidServices.some((s: any) => s.id === a2.id)
        && rowsAfter.every((s: any) => s.depositAmountCents == null), `apply-to-all D=3000 with a $25 service → ${r.status}, invalid ${JSON.stringify(r.body?.invalidServices)}`);
      r = await http("POST", "/api/vendor/services/apply-deposit-to-all", "vendor2", { depositAmountCents: null });
      check("T-2b", r.status === 200 && r.body?.updatedCount === rowsAfter.length, `apply-to-all null → ${r.status} updated ${r.body?.updatedCount}`);
      void a1;
    }

    // ── T-2c: hold response is deposit-aware and matches the PI amount ──────
    const holdIds: Record<string, string> = {};
    const cases = [
      { kind: "dep" as const, B: 27500, D: 3000, due: 3240, rest: 24500 },
      { kind: "full" as const, B: 27500, D: null, due: 29700, rest: 0 },
      { kind: "staff" as const, B: 12500, D: null, due: 13500, rest: 0 },
      { kind: "photo" as const, B: 15000, D: null, due: 16200, rest: 0 },
    ];
    let seedingFailed = false;
    for (const c of cases) {
      const h = await hold(c.kind);
      if (h.status !== 200 || !h.body?.holdId) {
        seedingFailed = true;
        check("T-2c", false, `SEEDING: real hold for ${c.kind} → ${h.status} ${JSON.stringify(h.body).slice(0, 160)}`);
        continue;
      }
      holdIds[c.kind] = h.body.holdId;
      const hb = h.body;
      check("T-2c", hb.serviceTotalCents === c.B && hb.depositAmountCents === c.D && hb.chargeAmountCents === (c.D ?? c.B)
        && hb.dueNowCents === c.due && hb.dueAtAppointmentCents === c.rest && hb.depositNonRefundable === (c.D != null)
        && hb.dueNowFeeBreakdown?.grossChargeAmount === c.due,
        `${c.kind} hold fields: ${JSON.stringify({ s: hb.serviceTotalCents, d: hb.depositAmountCents, c: hb.chargeAmountCents, n: hb.dueNowCents, r: hb.dueAtAppointmentCents, nr: hb.depositNonRefundable })}`);
      check("T-2c", hb.feeBreakdown?.grossChargeAmount === Math.round(c.B * 1.08) && hb.servicePriceCents === c.B, `${c.kind} existing feeBreakdown (on B) unchanged: ${hb.feeBreakdown?.grossChargeAmount}`);
      const before = createCalls.length;
      const p = await pay(hb.holdId);
      const call = createCalls.length > before ? lastCreate() : undefined;
      check("T-2c", p.status === 200 && call && call.params.amount === hb.dueNowCents,
        `${c.kind} PI amount ${call?.params.amount} vs hold dueNowCents ${hb.dueNowCents} (PI http ${p.status})`);
      if (c.kind === "dep") (holdIds as any).depFirstPI = p.body;
    }

    // ── T-2d: reuse response carries the same money fields ──────────────────
    if (holdIds.dep) {
      const first = (holdIds as any).depFirstPI;
      retrieveStatus = "requires_payment_method";
      const again = await pay(holdIds.dep);
      const pick = (b: any) => ({ d: b?.depositAmountCents, s: b?.servicePriceCents, c: b?.chargeAmountCents, f: b?.feeBreakdown });
      check("T-2d", again.status === 200 && again.body?.paymentIntentId === first?.paymentIntentId && same(pick(again.body), pick(first))
        && again.body?.feeBreakdown?.grossChargeAmount === 3240 && again.body?.requiresApproval === false,
        `reuse money fields ${JSON.stringify(pick(again.body))} vs first ${JSON.stringify(pick(first))}`);
    } else check("T-2d", false, "no deposit hold (seeding failed)");

    // ── T-2f: PaymentIntent creation failure → resume ───────────────────────
    async function failThenRetry(kind: "full" | "dep", mode: "fail_before" | "created_then_lost", between?: () => Promise<void>) {
      const h = await hold(kind);
      if (h.status !== 200) return null;
      const holdId = h.body.holdId;
      const c0 = createCalls.length, ids0 = createdIds.length;
      nextCreateMode = mode;
      const a1 = await pay(holdId);
      if (between) await between();
      const a2 = await pay(holdId);
      const calls = createCalls.slice(c0);
      const rows = await apptsForHold(holdId);
      return { a1, a2, calls, rows, created: createdIds.slice(ids0) };
    }
    {
      const A = await failThenRetry("full", "fail_before");
      const apptId = A?.rows[0]?.id;
      check("T-2f", A && A.a1.status === 500 && A.a2.status === 200 && !!A.a2.body?.clientSecret, `A: attempt1 ${A?.a1.status}, attempt2 ${A?.a2.status}`);
      check("T-2f", A && A.calls.length === 2 && A.calls[0].key === `hold_pi_${apptId}` && A.calls[1].key === A.calls[0].key, `A: keys ${JSON.stringify(A?.calls.map(c => c.key))}`);
      check("T-2f", A && A.calls.length === 2 && same(A.calls[0].params, A.calls[1].params), `A: params deep-equal across attempts`);
      check("T-2f", A && A.calls[0]?.params && !("transfer_data" in A.calls[0].params) && A.calls[0].params.currency === "usd", `A: no transfer_data, currency usd`);
      check("T-2f", A && A.rows.length === 1 && (A.rows[0] as any).stripePaymentIntentId === A.a2.body?.paymentIntentId, `A: rows ${A?.rows.length}, saved PI ${(A?.rows[0] as any)?.stripePaymentIntentId}`);

      const B = await failThenRetry("full", "created_then_lost");
      check("T-2f", B && B.a1.status === 500 && B.a2.status === 200 && B.created.length === 1 && B.a2.body?.paymentIntentId === B.created[0],
        `B: attempt2 ${B?.a2.status}, returned ${B?.a2.body?.paymentIntentId}, created ${JSON.stringify(B?.created)}`);
      check("T-2f", B && B.calls.length === 2 && B.calls[0].key === B.calls[1].key && B.calls[0].key === `hold_pi_${B.rows[0]?.id}` && same(B.calls[0].params, B.calls[1].params),
        `B: identical key and deep-equal params`);
      check("T-2f", B && B.rows.length === 1, `B: rows ${B?.rows.length}`);

      const origName = business.name;
      const C = await failThenRetry("full", "created_then_lost", async () => {
        await db.update(schema.businesses).set({ name: `${origName} Renamed` } as any).where(eq(schema.businesses.id, business.id));
      });
      await db.update(schema.businesses).set({ name: origName } as any).where(eq(schema.businesses.id, business.id));
      check("T-2f", C && C.a2.status === 502 && C.a2.body?.code === "PI_IDEMPOTENCY_CONFLICT" && C.created.length === 1
        && C.rows.length === 1 && (C.rows[0] as any).status === BOOKING_STATES.PENDING_PAYMENT,
        `C: attempt2 ${C?.a2.status} ${C?.a2.body?.code}, created ${C?.created.length}, rows ${C?.rows.length}`);

      const sdk = new Stripe("sk_test_mock_selftest");
      const k = `selftest_${randomUUID()}`;
      await sdk.paymentIntents.create({ amount: 100, currency: "usd" }, { idempotencyKey: k });
      let threw: any = null;
      try { await sdk.paymentIntents.create({ amount: 200, currency: "usd" }, { idempotencyKey: k }); } catch (e) { threw = e; }
      check("T-2f", threw?.rawType === "idempotency_error", `D: mock self-test same key, different amount → ${threw?.rawType ?? "no error"}`);

      const E = await failThenRetry("dep", "fail_before");
      check("T-2f", E && E.a2.status === 200 && E.calls.length === 2 && E.calls[1].params.amount === 3240 && same(E.calls[0].params, E.calls[1].params),
        `E: deposit resume amount ${E?.calls[1]?.params.amount}, http ${E?.a2.status}`);

      // F / F2: manual-accept business. The vendor's "New booking request"
      // email must go out exactly once across both attempts.
      await db.update(schema.businesses).set({ autoAcceptBookings: false } as any).where(eq(schema.businesses.id, business.id));
      const settleEmails = async () => {
        let last = -1, stable = 0;
        for (let i = 0; i < 400 && stable < 10; i++) {
          await new Promise(r => setTimeout(r, 10));
          if (sent.length === last) stable++; else { stable = 0; last = sent.length; }
        }
      };
      for (const [label, mode] of [["F", "fail_before"], ["F2", "created_then_lost"]] as const) {
        // Only emails sent during this case (F and F2 can share a date).
        await settleEmails();
        const sentBefore = sent.length;
        const r = await failThenRetry("full", mode);
        await settleEmails();
        const requests = sent.slice(sentBefore).filter(e => e.to === vendorEmail && e.subject.startsWith("New booking request"));
        check("T-2f", r && r.a1.status === 500 && r.a2.status === 200, `${label}: attempt1 ${r?.a1.status}, attempt2 ${r?.a2.status}`);
        check("T-2f", r && r.calls.length === 2 && r.calls[0].params.capture_method === "manual" && r.calls[1].params.capture_method === "manual"
          && r.calls[0].key === `hold_pi_${r.rows[0]?.id}` && r.calls[1].key === r.calls[0].key && same(r.calls[0].params, r.calls[1].params),
          `${label}: capture ${JSON.stringify(r?.calls.map(c => c.params.capture_method))}, keys ${JSON.stringify(r?.calls.map(c => c.key))}`);
        check("T-2f", r && r.rows.length === 1 && (r.rows[0] as any).status === BOOKING_STATES.PENDING_PROVIDER, `${label}: rows ${r?.rows.length}, status ${(r?.rows[0] as any)?.status}`);
        check("T-2f", requests.length === 1, `${label}: vendor "New booking request" emails ${requests.length} (want exactly 1)`);
      }
      await db.update(schema.businesses).set({ autoAcceptBookings: true } as any).where(eq(schema.businesses.id, business.id));
    }

    // ── Confirm the deposit and full bookings through the webhook ───────────
    const { WebhookHandlers: WH } = await import("../server/stripe/webhookHandlers");
    async function confirmedBooking(kind: "dep" | "full") {
      const h = await hold(kind);
      if (h.status !== 200) return null;
      const before = createCalls.length;
      const p = await pay(h.body.holdId);
      const call = createCalls[before];
      if (p.status !== 200 || !call) return null;
      await WH.handlePaymentIntentSucceeded({ id: p.body.paymentIntentId, amount: call.params.amount, metadata: call.params.metadata });
      const [row] = await apptsForHold(h.body.holdId);
      return { id: (row as any)?.id as string, status: (row as any)?.status, amount: call.params.amount as number };
    }
    const depBk = await confirmedBooking("dep");
    const fullBk = await confirmedBooking("full");
    check("T-2g", depBk?.status === BOOKING_STATES.CONFIRMED && fullBk?.status === BOOKING_STATES.CONFIRMED, `bookings confirmed via webhook: ${depBk?.status}, ${fullBk?.status}`);

    // ── T-2g: cancel-preview ────────────────────────────────────────────────
    if (depBk && fullBk) {
      const pv = await http("GET", `/api/bookings/appointments/${depBk.id}/cancel-preview`, "consumer");
      const b = pv.body;
      check("T-2g", pv.status === 200 && b.chargedAmountCents === depBk.amount && b.chargedAmountCents === 3240 && b.isDepositBooking === true
        && b.depositAmountCents === 3000 && b.depositNonRefundable === true,
        `deposit preview new fields ${JSON.stringify({ c: b.chargedAmountCents, i: b.isDepositBooking, d: b.depositAmountCents, n: b.depositNonRefundable })}`);
      check("T-2g", b.refundTier === "none" && b.refundAmountCents === 0 && b.feeAmountCents === 0 && b.feeWouldBeCharged === false
        && b.subtotalCents === 27500 && b.grossChargeAmountCents === 29700, `deposit preview existing fields unchanged ${JSON.stringify({ t: b.refundTier, r: b.refundAmountCents, f: b.feeAmountCents, s: b.subtotalCents, g: b.grossChargeAmountCents })}`);
      const pf = await http("GET", `/api/bookings/appointments/${fullBk.id}/cancel-preview`, "consumer");
      check("T-2g", pf.status === 200 && pf.body.chargedAmountCents === 29700 && pf.body.isDepositBooking === false && pf.body.depositAmountCents === null
        && pf.body.grossChargeAmountCents === 29700 && pf.body.subtotalCents === 27500, `no-deposit preview ${JSON.stringify(pf.body)}`);
    } else check("T-2g", false, "could not create confirmed bookings");

    // ── T-2h: appointment payloads ──────────────────────────────────────────
    if (depBk && fullBk) {
      const mine = await http("GET", "/api/my-appointments", "consumer");
      const list: any[] = mine.body?.appointments ?? [];
      const md = list.find(a => a.id === depBk.id), mf = list.find(a => a.id === fullBk.id);
      check("T-2h", md && md.chargedAmountCents === depBk.amount && md.chargedAmountCents === 3240 && md.dueAtAppointmentCents === 24500
        && md.depositAmountCents === 3000 && md.serviceTotalCents === 27500 && md.totalPrice === 27500,
        `my-appointments deposit ${JSON.stringify(md && { c: md.chargedAmountCents, r: md.dueAtAppointmentCents, d: md.depositAmountCents, t: md.totalPrice })}`);
      check("T-2h", mf && mf.chargedAmountCents === 29700 && mf.dueAtAppointmentCents === 0 && mf.depositAmountCents === null && mf.totalPrice === 27500,
        `my-appointments full ${JSON.stringify(mf && { c: mf.chargedAmountCents, r: mf.dueAtAppointmentCents })}`);
      const biz = await http("GET", "/api/business/bookings", "vendor");
      const bl: any[] = biz.body?.bookings ?? [];
      const bd = bl.find(a => a.id === depBk.id), bf = bl.find(a => a.id === fullBk.id);
      check("T-2h", bd && bd.chargedAmountCents === depBk.amount && bd.dueAtAppointmentCents === 24500 && bd.depositAmountCents === 3000
        && bd.amount === 275 && bd.subtotalAmount === 275 && bd.bookingFeeAmount === 0.6 && bd.vendorNetAmount === 29.4,
        `business/bookings deposit ${JSON.stringify(bd && { c: bd.chargedAmountCents, r: bd.dueAtAppointmentCents, d: bd.depositAmountCents, a: bd.amount, f: bd.bookingFeeAmount, v: bd.vendorNetAmount })}`);
      check("T-2h", bf && bf.chargedAmountCents === 29700 && bf.dueAtAppointmentCents === 0 && bf.amount === 275 && bf.vendorNetAmount === 269.5,
        `business/bookings full ${JSON.stringify(bf && { c: bf.chargedAmountCents, a: bf.amount, v: bf.vendorNetAmount })}`);
    } else check("T-2h", false, "could not create confirmed bookings");

    // ── T-2s: staff service deposits ────────────────────────────────────────
    {
      const staffPost = (body: Record<string, unknown>) => http("POST", "/api/staff/services", "staff",
        { name: `Staff dep ${randomUUID().slice(0, 4)}`, priceCents: 27500, durationMinutes: 60, ...body });
      let r = await staffPost({ depositAmountCents: 600 });
      check("T-2s", r.status === 400 && r.body?.code === "INVALID_DEPOSIT" && !!r.body?.message && !!r.body?.error, `staff POST D=600 → ${r.status} ${r.body?.code}`);
      r = await staffPost({ depositAmountCents: 27500 });
      check("T-2s", r.status === 400 && r.body?.code === "INVALID_DEPOSIT", `staff POST D=B → ${r.status} ${r.body?.code}`);
      r = await staffPost({ depositAmountCents: 0 });
      check("T-2s", r.status === 200 && r.body?.service?.depositAmountCents === null, `staff POST D=0 → ${r.status}, stored ${r.body?.service?.depositAmountCents}`);
      r = await staffPost({ depositAmountCents: null });
      check("T-2s", r.status === 200 && r.body?.service?.depositAmountCents === null, `staff POST D=null → ${r.status}, stored ${r.body?.service?.depositAmountCents}`);
      r = await staffPost({});
      check("T-2s", r.status === 200 && r.body?.service?.depositAmountCents === null, `staff POST no D → ${r.status}, stored ${r.body?.service?.depositAmountCents}`);
      r = await staffPost({ depositAmountCents: 3000 });
      check("T-2s", r.status === 200 && r.body?.service?.depositAmountCents === 3000, `staff POST D=3000 → ${r.status}, stored ${r.body?.service?.depositAmountCents}`);
      const staffDepId: string | undefined = r.body?.service?.id;

      if (staffDepId) {
        const patch = (body: Record<string, unknown>) => http("PATCH", `/api/staff/services/${staffDepId}`, "staff", body);
        const stored = async () => (await db.select().from(schema.staffServices).where(eq(schema.staffServices.id, staffDepId)))[0] as any;
        r = await patch({ priceCents: 3000 });
        check("T-2s", r.status === 400 && r.body?.code === "INVALID_DEPOSIT" && (await stored()).priceCents === 27500, `staff PATCH price to stored D → ${r.status}, price now ${(await stored()).priceCents}`);
        r = await patch({ depositAmountCents: 600 });
        check("T-2s", r.status === 400 && r.body?.code === "INVALID_DEPOSIT" && (await stored()).depositAmountCents === 3000, `staff PATCH D=600 → ${r.status}`);
        r = await patch({ priceCents: 20000, depositAmountCents: 20000 });
        check("T-2s", r.status === 400 && r.body?.code === "INVALID_DEPOSIT", `staff PATCH D = new price → ${r.status}`);
        r = await patch({ depositAmountCents: 0 });
        check("T-2s", r.status === 200 && (await stored()).depositAmountCents === null, `staff PATCH D=0 → ${r.status}, stored ${(await stored()).depositAmountCents}`);
        r = await patch({ depositAmountCents: 3000 });
        check("T-2s", r.status === 200 && (await stored()).depositAmountCents === 3000, `staff PATCH D=3000 → ${r.status}, stored ${(await stored()).depositAmountCents}`);
        r = await patch({ name: "Staff knotless (deposit)" });
        check("T-2s", r.status === 200 && (await stored()).depositAmountCents === 3000, `staff PATCH name only → ${r.status}`);
        await db.update(schema.staffServices).set({ status: "live" } as any).where(eq(schema.staffServices.id, staffDepId));

        const pub = await http("GET", `/api/businesses/${business.id}/staff/${staff.id}/services`, "consumer");
        const listed = (pub.body?.services ?? []) as any[];
        check("T-2s", pub.status === 200 && listed.find(s => s.id === staffDepId)?.depositAmountCents === 3000
          && listed.find(s => s.id === staffSvc.id)?.depositAmountCents === null, `public staff services depositAmountCents ${JSON.stringify(listed.map(s => [s.name, s.depositAmountCents]))}`);

        // Hold → PaymentIntent → webhook settlement → cancel preview.
        const { date, time } = nextSlot();
        const h = await http("POST", "/api/booking/hold", "consumer", { providerType: "business", providerId: business.id, staffMemberId: staff.id, serviceId: staffDepId, date, startTime: time });
        const hb = h.body;
        check("T-2s", h.status === 200 && hb.serviceTotalCents === 27500 && hb.depositAmountCents === 3000 && hb.chargeAmountCents === 3000
          && hb.dueNowCents === 3240 && hb.dueAtAppointmentCents === 24500 && hb.depositNonRefundable === true
          && hb.dueNowFeeBreakdown?.grossChargeAmount === 3240 && hb.feeBreakdown?.grossChargeAmount === 29700,
          `staff deposit hold fields: ${h.status} ${JSON.stringify({ s: hb?.serviceTotalCents, d: hb?.depositAmountCents, c: hb?.chargeAmountCents, n: hb?.dueNowCents, r: hb?.dueAtAppointmentCents, nr: hb?.depositNonRefundable })}`);
        if (h.status === 200) {
          const before = createCalls.length;
          const p = await pay(hb.holdId);
          const call = createCalls.length > before ? lastCreate() : undefined;
          const [row] = await apptsForHold(hb.holdId) as any[];
          check("T-2s", p.status === 200 && call?.params.amount === 3240 && call?.params.amount === hb.dueNowCents && call?.params.metadata?.staffMemberId === staff.id,
            `staff deposit PI amount ${call?.params.amount} vs hold dueNowCents ${hb.dueNowCents} (PI http ${p.status})`);
          check("T-2s", row && row.depositAmountCents === 3000 && row.totalPrice === 27500 && row.staffServiceId === staffDepId && row.serviceId === null && row.staffMemberId === staff.id,
            `staff deposit appointment row ${JSON.stringify(row && { d: row.depositAmountCents, t: row.totalPrice, ss: row.staffServiceId, s: row.serviceId })}`);

          if (call && row) {
            const t0 = depTransfers.length;
            await WH.handlePaymentIntentSucceeded({ id: p.body.paymentIntentId, amount: call.params.amount, metadata: call.params.metadata });
            const tr = depTransfers.slice(t0).filter(t => t.transfer_group?.endsWith(row.id));
            const [after] = await db.select().from(schema.appointments).where(eq(schema.appointments.id, row.id)) as any[];
            check("T-2s", after.status === BOOKING_STATES.CONFIRMED && tr.length === 1 && tr[0].amount === 2940
              && tr[0].destination === `acct_staff_${dtag}` && tr[0].metadata.recipient === "staff" && after.staffPayout === 2940 && !!after.settledAt,
              `staff deposit settlement: status ${after.status}, transfers ${JSON.stringify(tr.map(t => [t.amount, t.destination, t.metadata.recipient]))}, staffPayout ${after.staffPayout}`);

            const pv = await http("GET", `/api/bookings/appointments/${row.id}/cancel-preview`, "consumer");
            const b = pv.body;
            check("T-2s", pv.status === 200 && b.isDepositBooking === true && b.refundAmountCents === 0 && b.refundTier === "none" && b.feeAmountCents === 0
              && b.depositAmountCents === 3000 && b.chargedAmountCents === 3240 && b.depositNonRefundable === true,
              `staff deposit cancel preview ${JSON.stringify({ i: b.isDepositBooking, r: b.refundAmountCents, t: b.refundTier, d: b.depositAmountCents, c: b.chargedAmountCents })}`);
          }
        }
      }

      // Staff service without a deposit: full price + 8% now, full vendor net to the staff member.
      {
        const { date, time } = nextSlot();
        const h = await http("POST", "/api/booking/hold", "consumer", { providerType: "business", providerId: business.id, staffMemberId: staff.id, serviceId: staffSvc.id, date, startTime: time });
        const hb = h.body;
        check("T-2s", h.status === 200 && hb.depositAmountCents === null && hb.dueNowCents === 13500 && hb.dueAtAppointmentCents === 0 && hb.depositNonRefundable === false,
          `staff no-deposit hold: ${h.status} ${JSON.stringify({ d: hb?.depositAmountCents, n: hb?.dueNowCents, r: hb?.dueAtAppointmentCents })}`);
        if (h.status === 200) {
          const before = createCalls.length;
          const p = await pay(hb.holdId);
          const call = createCalls.length > before ? lastCreate() : undefined;
          const [row] = await apptsForHold(hb.holdId) as any[];
          check("T-2s", p.status === 200 && call?.params.amount === 13500 && row?.depositAmountCents === null,
            `staff no-deposit PI amount ${call?.params.amount}, stored deposit ${row?.depositAmountCents}`);
          if (call && row) {
            const t0 = depTransfers.length;
            await WH.handlePaymentIntentSucceeded({ id: p.body.paymentIntentId, amount: call.params.amount, metadata: call.params.metadata });
            const tr = depTransfers.slice(t0).filter(t => t.transfer_group?.endsWith(row.id));
            check("T-2s", tr.length === 1 && tr[0].amount === 12250 && tr[0].destination === `acct_staff_${dtag}`,
              `staff no-deposit settlement transfers ${JSON.stringify(tr.map(t => [t.amount, t.destination]))}`);
          }
        }
      }
    }

    // ── T-2p: shoot settlement (h): transfer == PI metadata vendorPayoutCents ─
    // Both photographer create-payment-intent routes, real handlers, Stripe
    // mocked at the SDK.
    {
      const shootViaWebhook = async (label: string, call: { params: any } | undefined, bookingId: string | undefined) => {
        if (!call || !bookingId) { check("T-2p", false, `${label}: no PaymentIntent created`); return; }
        const meta = call.params.metadata;
        const [before] = await db.select().from(schema.shootBookings).where(eq(schema.shootBookings.id, bookingId)) as any[];
        const t0 = depTransfers.length;
        await WH.handlePaymentIntentSucceeded({ id: `pi_h_${randomUUID().slice(0, 8)}`, amount: call.params.amount, metadata: meta });
        const tr = depTransfers.slice(t0).filter(t => t.transfer_group === `shoot_booking_${bookingId}`);
        const [row] = await db.select().from(schema.shootBookings).where(eq(schema.shootBookings.id, bookingId)) as any[];
        check("T-2p", tr.length === 1 && tr[0].amount === Number(meta.vendorPayoutCents) && tr[0].amount === before.vendorNet && tr[0].destination === `acct_ph_${dtag}`,
          `${label}: transfers ${JSON.stringify(tr.map(t => [t.amount, t.destination]))}, PI vendorPayoutCents ${meta.vendorPayoutCents}, vendor_net ${before.vendorNet}`);
        check("T-2p", row.status === BOOKING_STATES.CONFIRMED && !!row.settledAt && row.stripeTransferId === tr[0]?.id,
          `${label}: status ${row.status}, settled ${!!row.settledAt}, transfer id ${row.stripeTransferId}`);
        const pts = earnCalls.filter(c => c.referenceType === "shoot_booking" && c.referenceId === bookingId);
        const base = meta.originalConsumerTotalCents ? Number(meta.originalConsumerTotalCents) : call.params.amount;
        check("T-2p", pts.length === 1 && pts[0].dollarAmountCents === base, `${label}: earnPoints calls ${JSON.stringify(pts.map(p => p.dollarAmountCents))}, expected one on ${base}`);
      };
      // earnPoints never writes under neon-http (db.transaction); record the calls.
      const earnCalls: any[] = [];
      const origEarnPoints = storage.earnPoints;
      (storage as any).earnPoints = async function (this: any, data: any) { earnCalls.push(data); return origEarnPoints.call(this, data); };

      // Hold flow.
      const h = await hold("photo");
      if (h.status === 200) {
        const before = createCalls.length;
        const p = await pay(h.body.holdId);
        const call = createCalls.length > before ? lastCreate() : undefined;
        await shootViaWebhook("hold-flow shoot PI", call, p.body?.shootBookingId);
        const [hr] = await db.select().from(schema.bookingHolds).where(eq(schema.bookingHolds.id, h.body.holdId)) as any[];
        check("T-2p", hr?.status === "converted" && hr?.convertedToBookingId === p.body?.shootBookingId, `hold-flow shoot hold ${hr?.status} → ${hr?.convertedToBookingId}`);
      } else check("T-2p", false, `photo hold → ${h.status}`);

      // Legacy POST /api/bookings/photographer/:bookingId/create-payment-intent.
      {
        const { date, time } = nextSlot();
        const [b] = await db.insert(schema.shootBookings).values({
          photographerId: photographer.id, clientId: consumer.id, shootType: "Portrait", date, startTime: time, endTime: time,
          durationHours: 1, totalPrice: 15000, status: BOOKING_STATES.PENDING_PAYMENT,
        } as any).returning();
        const before = createCalls.length;
        const r = await http("POST", `/api/bookings/photographer/${b.id}/create-payment-intent`, "consumer", {});
        const call = createCalls.length > before ? lastCreate() : undefined;
        check("T-2p", r.status === 200, `legacy shoot PI route → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
        await shootViaWebhook("legacy shoot PI", call, b.id);
      }
      (storage as any).earnPoints = origEarnPoints;
    }

    // ── T-2ph: photographer service deposits ────────────────────────────────
    // Live service routes (PhotographerController), real hold → PaymentIntent
    // → webhook / accept → settlement, cancel and refund routes.
    {
      const T = "T-2ph";
      await db.update(schema.users).set({ isPhotographer: true } as any).where(eq(schema.users.id, photogUser.id));
      const origCapture = R.PaymentIntents.prototype.capture, origRefund = R.Refunds.prototype.create, depCancel = R.PaymentIntents.prototype.cancel;
      R.PaymentIntents.prototype.capture = async function (id: string) {
        const p = piById.get(id);
        return { ...p, status: "succeeded", amount_received: p?.amount ?? 0 };
      };
      const refundCreates: any[] = [];
      R.Refunds.prototype.create = async function (p: any) { refundCreates.push(p); return { id: `re_${randomUUID().slice(0, 8)}`, amount: p.amount, status: "succeeded" }; };
      const piCancels: string[] = [];
      R.PaymentIntents.prototype.cancel = async function (id: string) { piCancels.push(id); return { id, status: "canceled" }; };

      const svcPost = (body: Record<string, unknown>) => http("POST", "/api/photographers/me/services", "photog",
        { name: `Photo dep ${randomUUID().slice(0, 4)}`, pricingModel: "package", priceCents: 27500, estimatedDurationMinutes: 60, ...body });
      const svcRow = async (id: string) => (await db.select().from(schema.photographerServices).where(eq(schema.photographerServices.id, id)))[0] as any;
      const shootRowOf = async (id: string) => (await db.select().from(schema.shootBookings).where(eq(schema.shootBookings.id, id)))[0] as any;
      const ok = (s: number) => s >= 200 && s < 300;

      // (a) validation
      let r = await svcPost({ depositAmountCents: 600 });
      check(T, r.status === 400 && r.body?.code === "INVALID_DEPOSIT", `(a) POST D=600 → ${r.status} ${r.body?.code}`);
      r = await svcPost({ depositAmountCents: 27500 });
      check(T, r.status === 400 && r.body?.code === "INVALID_DEPOSIT", `(a) POST D=price → ${r.status} ${r.body?.code}`);
      r = await svcPost({ depositAmountCents: 0 });
      check(T, ok(r.status) && r.body?.service?.depositAmountCents === null, `(a) POST D=0 → ${r.status}, stored ${r.body?.service?.depositAmountCents}`);
      r = await svcPost({ pricingModel: "hourly", priceCents: undefined, hourlyRateCents: 10000, depositAmountCents: 3000 });
      check(T, r.status === 400 && r.body?.code === "INVALID_DEPOSIT" && r.body?.message === "Deposits require a fixed price.",
        `(a) POST hourly with D → ${r.status} ${r.body?.code} ${r.body?.message}`);
      r = await svcPost({ pricingModel: "hourly", priceCents: undefined, hourlyRateCents: 10000 });
      check(T, ok(r.status) && r.body?.service?.depositAmountCents === null, `(a) POST hourly without D → ${r.status}`);
      r = await svcPost({ depositAmountCents: 3000 });
      check(T, ok(r.status) && r.body?.service?.depositAmountCents === 3000, `(a) POST D=3000 → ${r.status}, stored ${r.body?.service?.depositAmountCents}`);
      const depSvcId: string | undefined = r.body?.service?.id;
      if (depSvcId) {
        const patch = (body: Record<string, unknown>) => http("PATCH", `/api/photographers/me/services/${depSvcId}`, "photog", body);
        r = await patch({ priceCents: 3000 });
        check(T, r.status === 400 && r.body?.code === "INVALID_DEPOSIT" && (await svcRow(depSvcId)).priceCents === 27500,
          `(a) PATCH price to stored D → ${r.status}, price now ${(await svcRow(depSvcId)).priceCents}`);
        r = await patch({ priceCents: 2500 });
        check(T, r.status === 400 && r.body?.code === "INVALID_DEPOSIT", `(a) PATCH price below stored D → ${r.status}`);
        r = await patch({ priceCents: null });
        check(T, r.status === 400 && r.body?.code === "INVALID_DEPOSIT" && (await svcRow(depSvcId)).priceCents === 27500, `(a) PATCH price removed with stored D → ${r.status}`);
        r = await patch({ isContactForPricing: true });
        check(T, r.status === 400 && r.body?.code === "INVALID_DEPOSIT", `(a) PATCH contact-for-pricing with stored D → ${r.status}`);
        r = await patch({ depositAmountCents: 600 });
        check(T, r.status === 400 && (await svcRow(depSvcId)).depositAmountCents === 3000, `(a) PATCH D=600 → ${r.status}`);
        r = await patch({ name: "Portrait (deposit)" });
        check(T, r.status === 200 && (await svcRow(depSvcId)).depositAmountCents === 3000, `(a) PATCH name only → ${r.status}`);
        r = await patch({ depositAmountCents: 0 });
        check(T, r.status === 200 && (await svcRow(depSvcId)).depositAmountCents === null, `(a) PATCH D=0 → ${r.status}, stored ${(await svcRow(depSvcId)).depositAmountCents}`);
        r = await patch({ depositAmountCents: 3000 });
        check(T, r.status === 200 && (await svcRow(depSvcId)).depositAmountCents === 3000, `(a) PATCH D=3000 → ${r.status}`);
        // Far-future slots sit inside a 1-week full-refund window, so without the
        // deposit rule the customer cancel below would refund the full price.
        await db.update(schema.photographerServices).set({ status: "live", fullRefundWindow: "1_week" } as any).where(eq(schema.photographerServices.id, depSvcId));
      } else check(T, false, "(a) no deposit service created");

      const r2 = await svcPost({ priceCents: 15000 });
      const fullSvcId: string | undefined = r2.body?.service?.id;
      if (fullSvcId) await db.update(schema.photographerServices).set({ status: "live", fullRefundWindow: "1_week" } as any).where(eq(schema.photographerServices.id, fullSvcId));
      else check(T, false, `no-deposit service create → ${r2.status}`);

      // A spare slot between holds: a canceled pending shoot's hold stays active
      // until it expires and blocks the adjacent slot.
      const photoHold = (serviceId: string) => { nextSlot(); const { date, time } = nextSlot(); return http("POST", "/api/booking/hold", "consumer", { providerType: "photographer", providerId: photographer.id, serviceId, date, startTime: time }); };
      async function bookShoot(serviceId: string) {
        const h = await photoHold(serviceId);
        if (h.status !== 200) return { h };
        const before = createCalls.length;
        const p = await pay(h.body.holdId);
        const call = createCalls.length > before ? lastCreate() : undefined;
        const row = p.body?.shootBookingId ? await shootRowOf(p.body.shootBookingId) : undefined;
        return { h, p, call, row };
      }
      const shootTransfersOf = (t0: number, id: string) => depTransfers.slice(t0).filter(t => t.transfer_group === `shoot_booking_${id}`);

      // (b)–(d) auto-accept deposit booking
      let autoId: string | undefined;
      if (depSvcId) {
        const { h, p, call, row } = await bookShoot(depSvcId);
        const hb = h.body;
        check(T, h.status === 200 && hb.serviceTotalCents === 27500 && hb.depositAmountCents === 3000 && hb.chargeAmountCents === 3000
          && hb.dueNowCents === 3240 && hb.dueAtAppointmentCents === 24500 && hb.depositNonRefundable === true && hb.dueNowFeeBreakdown?.grossChargeAmount === 3240,
          `(b) hold ${h.status} ${JSON.stringify({ s: hb?.serviceTotalCents, d: hb?.depositAmountCents, c: hb?.chargeAmountCents, n: hb?.dueNowCents, r: hb?.dueAtAppointmentCents, nr: hb?.depositNonRefundable })}`);
        check(T, p?.status === 200 && call?.params.amount === 3240 && call?.params.amount === hb?.dueNowCents && call?.params.capture_method === "automatic",
          `(c) PI amount ${call?.params.amount} vs hold dueNowCents ${hb?.dueNowCents} (http ${p?.status})`);
        check(T, row && row.totalPrice === 27500 && row.depositAmountCents === 3000 && row.vendorNet === 2940 && row.platformFee === 60
          && call?.params.metadata?.vendorPayoutCents === "2940" && call?.params.metadata?.type === "shoot_booking",
          `(c) shoot row ${JSON.stringify(row && { t: row.totalPrice, d: row.depositAmountCents, v: row.vendorNet, f: row.platformFee })}, metadata vendorPayoutCents ${call?.params.metadata?.vendorPayoutCents}`);
        if (call && row) {
          autoId = row.id;
          const sentBefore = sent.length;
          const t0 = depTransfers.length;
          const evt = { id: p!.body.paymentIntentId, amount: call.params.amount, metadata: call.params.metadata };
          await WH.handlePaymentIntentSucceeded(evt);
          await WH.handlePaymentIntentSucceeded(evt);
          const tr = shootTransfersOf(t0, row.id);
          const after = await shootRowOf(row.id);
          check(T, after.status === BOOKING_STATES.CONFIRMED && tr.length === 1 && tr[0].amount === 2940 && tr[0].destination === `acct_ph_${dtag}`
            && after.stripeTransferId === tr[0].id && !!after.settledAt,
            `(d) auto-accept: status ${after.status}, transfers ${JSON.stringify(tr.map(t => [t.amount, t.destination]))}`);
          const mail = sent.slice(sentBefore);
          const toConsumer = mail.find(e => e.to === consumerEmail), toPhotog = mail.find(e => e.to === photogEmail), toAdmin = mail.find(e => e.to === ADMIN);
          check(T, !!toConsumer && toConsumer.html.includes("Deposit Paid") && toConsumer.html.includes("$32.40") && toConsumer.html.includes("Due at Appointment") && toConsumer.html.includes("$245.00") && !toConsumer.html.includes("Total Paid"),
            `(d) consumer receipt shows deposit $32.40 paid, $245.00 due`);
          check(T, !!toPhotog && toPhotog.html.includes("Deposit Collected") && toPhotog.html.includes("$29.40") && toPhotog.html.includes("Balance to Collect in Person") && toPhotog.html.includes("$245.00"),
            `(d) photographer receipt shows $29.40 deposit payout, $245.00 to collect`);
          check(T, !!toAdmin && toAdmin.html.includes("Deposit") && toAdmin.html.includes("$275.00") && toAdmin.html.includes("$2.40") && toAdmin.html.includes("$0.60") && mail.length === 3,
            `(d) admin receipt: deposit, 8% $2.40 and 2% $0.60 on D, service total $275.00 (${mail.length} emails)`);
        }
      }

      // (e) manual accept deposit booking
      let manualId: string | undefined;
      if (depSvcId) {
        await db.update(schema.photographers).set({ autoAcceptBookings: false } as any).where(eq(schema.photographers.id, photographer.id));
        const { p, call, row } = await bookShoot(depSvcId);
        if (call && row) {
          manualId = row.id;
          const evt = { id: p!.body.paymentIntentId, amount: call.params.amount, amount_capturable: call.params.amount, status: "requires_capture", metadata: call.params.metadata };
          await WH.handlePaymentIntentCapturableUpdated(evt);
          const pending = await shootRowOf(row.id);
          const t0 = depTransfers.length;
          const acc = await http("POST", `/api/bookings/photographer/${row.id}/accept`, "photog", {});
          await WH.handlePaymentIntentSucceeded({ ...evt, status: "succeeded" });
          const tr = shootTransfersOf(t0, row.id);
          const after = await shootRowOf(row.id);
          check(T, call.params.capture_method === "manual" && call.params.amount === 3240 && pending.status === BOOKING_STATES.PENDING_PROVIDER
            && acc.status === 200 && after.status === BOOKING_STATES.CONFIRMED && tr.length === 1 && tr[0].amount === 2940,
            `(e) manual accept: capture ${call.params.capture_method}, pending ${pending.status}, accept ${acc.status}, status ${after.status}, transfers ${JSON.stringify(tr.map(t => t.amount))}`);
        } else check(T, false, "(e) could not create manual deposit booking");
      }

      // (f) customer cancel preview + cancel on a confirmed deposit shoot
      if (autoId) {
        const pv = await http("GET", `/api/bookings/shoot/${autoId}/cancel-preview`, "consumer");
        const b = pv.body;
        check(T, pv.status === 200 && b.refundTier === "none" && b.refundAmountCents === 0 && b.feeAmountCents === 0 && b.isDepositBooking === true
          && b.depositAmountCents === 3000 && b.depositNonRefundable === true && b.chargedAmountCents === 3240,
          `(f) preview ${JSON.stringify({ t: b.refundTier, r: b.refundAmountCents, f: b.feeAmountCents, i: b.isDepositBooking, d: b.depositAmountCents, c: b.chargedAmountCents })}`);
        const rc0 = refundCreates.length;
        const c = await http("POST", `/api/bookings/shoot/${autoId}/cancel`, "consumer", {});
        const after = await shootRowOf(autoId);
        check(T, c.status === 200 && c.body?.refundAmountCents === 0 && c.body?.feeAmountCents === 0 && c.body?.refundTier === "none"
          && refundCreates.length === rc0 && after.status === BOOKING_STATES.CANCELED && after.refundAmount == null,
          `(f) cancel ${c.status} ${JSON.stringify({ r: c.body?.refundAmountCents, f: c.body?.feeAmountCents })}, refunds ${refundCreates.length - rc0}, status ${after.status}`);
      } else check(T, false, "(f) no confirmed deposit shoot");

      // (g) customer cancel while pending_provider: release the authorization
      for (const [label, svcId] of [["deposit", depSvcId], ["no deposit", fullSvcId]] as const) {
        if (!svcId) { check(T, false, `(g) ${label}: no service`); continue; }
        const { h, p, call, row } = await bookShoot(svcId);
        if (!call || !row) { check(T, false, `(g) ${label}: could not book (hold ${h.status} ${JSON.stringify(h.body ?? null).slice(0, 160)}, PI ${p?.status} ${JSON.stringify(p?.body ?? null).slice(0, 160)})`); continue; }
        await WH.handlePaymentIntentCapturableUpdated({ id: p!.body.paymentIntentId, amount: call.params.amount, amount_capturable: call.params.amount, status: "requires_capture", metadata: call.params.metadata });
        const pending = await shootRowOf(row.id);
        retrieveStatus = "requires_capture";
        const rc0 = refundCreates.length, pc0 = piCancels.length;
        const c = await http("POST", `/api/bookings/shoot/${row.id}/cancel`, "consumer", {});
        retrieveStatus = "requires_payment_method";
        const after = await shootRowOf(row.id);
        check(T, pending.status === BOOKING_STATES.PENDING_PROVIDER && c.status === 200 && c.body?.authorizationReleased === true && c.body?.refundAmountCents === 0
          && piCancels.slice(pc0).length === 1 && piCancels[pc0] === p!.body.paymentIntentId && refundCreates.length === rc0 && after.status === BOOKING_STATES.CANCELED,
          `(g) ${label} pending_provider cancel: ${c.status} released ${c.body?.authorizationReleased}, PI cancels ${JSON.stringify(piCancels.slice(pc0))}, refunds ${refundCreates.length - rc0}, status ${pending.status} → ${after.status}`);
      }
      await db.update(schema.photographers).set({ autoAcceptBookings: true } as any).where(eq(schema.photographers.id, photographer.id));

      // (h) photographer refund with no amount on a deposit shoot
      if (manualId) {
        const rc0 = refundCreates.length;
        const rf = await http("POST", `/api/bookings/photographer/${manualId}/refund`, "photog", {});
        const made = refundCreates.slice(rc0);
        check(T, rf.status === 200 && rf.body?.amount === 3000 && made.length === 1 && made[0].amount === 3000 && (await shootRowOf(manualId)).refundAmount === 3000,
          `(h) refund ${rf.status}, amount ${rf.body?.amount}, Stripe refunds ${JSON.stringify(made.map(m => m.amount))}`);
      } else check(T, false, "(h) no confirmed manual deposit shoot");

      // (i) legacy photographer PI route on a deposit booking
      {
        const { date, time } = nextSlot();
        const [b] = await db.insert(schema.shootBookings).values({
          photographerId: photographer.id, clientId: consumer.id, shootType: "Portrait", date, startTime: time, endTime: time,
          durationHours: 1, totalPrice: 27500, depositAmountCents: 3000, status: BOOKING_STATES.PENDING_PAYMENT,
        } as any).returning();
        const before = createCalls.length;
        const lr = await http("POST", `/api/bookings/photographer/${b.id}/create-payment-intent`, "consumer", {});
        check(T, lr.status === 409 && createCalls.length === before, `(i) legacy PI route on deposit booking → ${lr.status}, PaymentIntents created ${createCalls.length - before}`);
      }

      // (j) no-deposit photographer service: unchanged
      if (fullSvcId) {
        const { h, p, call, row } = await bookShoot(fullSvcId);
        const hb = h.body;
        check(T, h.status === 200 && hb.depositAmountCents === null && hb.dueNowCents === 16200 && hb.dueAtAppointmentCents === 0 && hb.depositNonRefundable === false,
          `(j) hold ${h.status} ${JSON.stringify({ d: hb?.depositAmountCents, n: hb?.dueNowCents, r: hb?.dueAtAppointmentCents })}`);
        check(T, p?.status === 200 && call?.params.amount === 16200 && row?.depositAmountCents === null && row?.totalPrice === 15000 && row?.vendorNet === 14700
          && call?.params.metadata?.vendorPayoutCents === "14700",
          `(j) PI ${call?.params.amount}, row ${JSON.stringify(row && { d: row.depositAmountCents, t: row.totalPrice, v: row.vendorNet })}`);
        if (call && row) {
          const t0 = depTransfers.length;
          await WH.handlePaymentIntentSucceeded({ id: p!.body.paymentIntentId, amount: call.params.amount, metadata: call.params.metadata });
          const tr = shootTransfersOf(t0, row.id);
          check(T, tr.length === 1 && tr[0].amount === 14700 && tr[0].destination === `acct_ph_${dtag}`, `(j) transfers ${JSON.stringify(tr.map(t => [t.amount, t.destination]))}`);
          const pv = await http("GET", `/api/bookings/shoot/${row.id}/cancel-preview`, "consumer");
          check(T, pv.status === 200 && pv.body.isDepositBooking === false && pv.body.depositAmountCents === null && pv.body.chargedAmountCents === 16200
            && pv.body.refundTier === "full" && pv.body.refundAmountCents === 15000,
            `(j) no-deposit preview ${JSON.stringify({ i: pv.body.isDepositBooking, c: pv.body.chargedAmountCents, t: pv.body.refundTier, r: pv.body.refundAmountCents })}`);
        }
      }

      // (k) hourly services: price = rate x min hours, duration = min hours, deposits allowed.
      // Computed in PhotographerController create/update; the payload's own
      // priceCents / estimatedDurationMinutes are ignored when it applies.
      {
        const hourlyBody = (extra: Record<string, unknown> = {}) => ({ pricingModel: "hourly", hourlyRateCents: 10000, packageHours: 3, priceCents: 99999, estimatedDurationMinutes: 45, ...extra });
        let k = await svcPost(hourlyBody());
        const hk0 = k.body?.service;
        check(T, ok(k.status) && hk0?.priceCents === 30000 && hk0?.estimatedDurationMinutes === 180 && hk0?.hourlyRateCents === 10000 && hk0?.packageHours === 3 && hk0?.depositAmountCents === null,
          `(k) POST hourly 10000 x 3 (payload priceCents 99999, duration 45 ignored) → ${k.status} ${JSON.stringify(hk0 && { p: hk0.priceCents, d: hk0.estimatedDurationMinutes, r: hk0.hourlyRateCents, h: hk0.packageHours })}`);
        k = await svcPost(hourlyBody({ depositAmountCents: 600 }));
        check(T, k.status === 400 && k.body?.code === "INVALID_DEPOSIT", `(k) POST hourly D=600 → ${k.status} ${k.body?.code}`);
        k = await svcPost(hourlyBody({ depositAmountCents: 30000 }));
        check(T, k.status === 400 && k.body?.code === "INVALID_DEPOSIT" && k.body?.message === "Deposit must be less than the service price.", `(k) POST hourly D=computed price → ${k.status} ${k.body?.code} ${k.body?.message}`);
        k = await svcPost(hourlyBody({ packageHours: 2.5 }));
        check(T, k.status === 400 && k.body?.error === "Invalid data", `(k) POST hourly packageHours 2.5 → ${k.status} ${k.body?.error}`);
        k = await svcPost(hourlyBody({ depositAmountCents: 5000 }));
        const hSvcId: string | undefined = k.body?.service?.id;
        check(T, ok(k.status) && k.body?.service?.depositAmountCents === 5000 && k.body?.service?.priceCents === 30000, `(k) POST hourly D=5000 → ${k.status}, stored D ${k.body?.service?.depositAmountCents}, price ${k.body?.service?.priceCents}`);

        // Not applicable: package model, contact-for-pricing, or old-app shapes without a rate.
        k = await svcPost({ pricingModel: "package", hourlyRateCents: 10000, packageHours: 3, priceCents: 27500, estimatedDurationMinutes: 60 });
        check(T, ok(k.status) && k.body?.service?.priceCents === 27500 && k.body?.service?.estimatedDurationMinutes === 60, `(k) POST package with rate+hours stores payload as sent → ${k.status} ${k.body?.service?.priceCents}/${k.body?.service?.estimatedDurationMinutes}`);
        k = await svcPost(hourlyBody({ isContactForPricing: true }));
        check(T, ok(k.status) && k.body?.service?.priceCents === null && k.body?.service?.estimatedDurationMinutes === 45, `(k) POST hourly contact-for-pricing stores payload as sent → ${k.status} ${k.body?.service?.priceCents}/${k.body?.service?.estimatedDurationMinutes}`);
        k = await svcPost({ pricingModel: "hourly", priceCents: 10000, estimatedDurationMinutes: 60 });
        check(T, ok(k.status) && k.body?.service?.priceCents === 10000 && k.body?.service?.hourlyRateCents === null && k.body?.service?.estimatedDurationMinutes === 60 && k.body?.service?.packageHours === null,
          `(k) old-app CREATE shape (hourly, priceCents 10000, no rate) stored as today → ${k.status} ${JSON.stringify(k.body?.service && { p: k.body.service.priceCents, r: k.body.service.hourlyRateCents, d: k.body.service.estimatedDurationMinutes })}`);
        k = await svcPost({ pricingModel: "hourly", priceCents: 10000, packageHours: 3, estimatedDurationMinutes: 60 });
        check(T, ok(k.status) && k.body?.service?.priceCents === 10000 && k.body?.service?.hourlyRateCents === null && k.body?.service?.estimatedDurationMinutes === 60 && k.body?.service?.packageHours === 3,
          `(k) old-app CREATE shape with min hours (no rate) stored as today → ${k.status} ${JSON.stringify(k.body?.service && { p: k.body.service.priceCents, r: k.body.service.hourlyRateCents, d: k.body.service.estimatedDurationMinutes, h: k.body.service.packageHours })}`);

        if (hSvcId) {
          const hpatch = (body: Record<string, unknown>) => http("PATCH", `/api/photographers/me/services/${hSvcId}`, "photog", body);
          const snap = async () => { const s = await svcRow(hSvcId); return { p: s.priceCents, d: s.estimatedDurationMinutes, r: s.hourlyRateCents, h: s.packageHours, dep: s.depositAmountCents }; };
          const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
          const base = { p: 30000, d: 180, r: 10000, h: 3, dep: 5000 };

          k = await hpatch({ hourlyRateCents: 12000 });
          check(T, k.status === 200 && same(await snap(), { p: 36000, d: 180, r: 12000, h: 3, dep: 5000 }), `(k) PATCH rate only → ${k.status} ${JSON.stringify(await snap())}`);
          k = await hpatch({ hourlyRateCents: 10000 });
          check(T, k.status === 200 && same(await snap(), base), `(k) PATCH rate back → ${k.status} ${JSON.stringify(await snap())}`);
          k = await hpatch({ packageHours: 4 });
          check(T, k.status === 200 && same(await snap(), { p: 40000, d: 240, r: 10000, h: 4, dep: 5000 }), `(k) PATCH hours only → ${k.status} ${JSON.stringify(await snap())}`);
          k = await hpatch({ hourlyRateCents: 20000, packageHours: 2 });
          check(T, k.status === 200 && same(await snap(), { p: 40000, d: 120, r: 20000, h: 2, dep: 5000 }), `(k) PATCH rate and hours → ${k.status} ${JSON.stringify(await snap())}`);
          k = await hpatch({ hourlyRateCents: 10000, packageHours: 3 });
          check(T, k.status === 200 && same(await snap(), base), `(k) PATCH rate and hours back → ${k.status} ${JSON.stringify(await snap())}`);

          // Lowering hours below the stored deposit is rejected before any write.
          k = await hpatch({ depositAmountCents: 25000 });
          check(T, k.status === 200 && (await snap()).dep === 25000, `(k) PATCH D=25000 (< 30000) → ${k.status}`);
          k = await hpatch({ packageHours: 2 });
          check(T, k.status === 400 && k.body?.code === "INVALID_DEPOSIT" && same(await snap(), { ...base, dep: 25000 }), `(k) PATCH hours 3→2 with stored D 25000 → ${k.status} ${k.body?.code}, row ${JSON.stringify(await snap())}`);
          k = await hpatch({ depositAmountCents: 5000 });
          check(T, k.status === 200 && same(await snap(), base), `(k) PATCH D back to 5000 → ${k.status}`);

          k = await hpatch({ name: "Hourly portrait" });
          check(T, k.status === 200 && same(await snap(), base), `(k) PATCH name only leaves price, rate, hours and deposit → ${k.status} ${JSON.stringify(await snap())}`);

          // An old app edits the same row: its own priceCents / duration are replaced.
          k = await hpatch({ pricingModel: "hourly", priceCents: 99999, estimatedDurationMinutes: 60 });
          check(T, k.status === 200 && same(await snap(), base), `(k) PATCH old-app shape (priceCents 99999, duration 60, no rate) → ${k.status} ${JSON.stringify(await snap())}`);

          // Booking: hold, PaymentIntent, shoot row, settlement, cancel preview, refund.
          await db.update(schema.photographerServices).set({ status: "live", fullRefundWindow: "1_week" } as any).where(eq(schema.photographerServices.id, hSvcId));
          const { h, p, call, row } = await bookShoot(hSvcId);
          const hb = h.body;
          check(T, h.status === 200 && hb.servicePriceCents === 30000 && hb.durationMinutes === 180 && hb.serviceTotalCents === 30000 && hb.depositAmountCents === 5000
            && hb.dueNowCents === 5400 && hb.dueAtAppointmentCents === 25000 && hb.depositNonRefundable === true,
            `(k) hourly hold ${h.status} ${JSON.stringify({ s: hb?.servicePriceCents, dur: hb?.durationMinutes, d: hb?.depositAmountCents, n: hb?.dueNowCents, r: hb?.dueAtAppointmentCents })}`);
          check(T, p?.status === 200 && call?.params.amount === 5400 && call?.params.amount === hb?.dueNowCents && row && row.depositAmountCents === 5000 && row.totalPrice === 30000
            && row.vendorNet === 4900 && row.platformFee === 100 && call?.params.metadata?.vendorPayoutCents === "4900",
            `(k) hourly PI ${call?.params.amount}, row ${JSON.stringify(row && { d: row.depositAmountCents, t: row.totalPrice, v: row.vendorNet, f: row.platformFee })}`);
          if (call && row) {
            const t0 = depTransfers.length;
            await WH.handlePaymentIntentSucceeded({ id: p!.body.paymentIntentId, amount: call.params.amount, metadata: call.params.metadata });
            const tr = shootTransfersOf(t0, row.id);
            check(T, tr.length === 1 && tr[0].amount === 4900 && tr[0].destination === `acct_ph_${dtag}` && (await shootRowOf(row.id)).status === BOOKING_STATES.CONFIRMED,
              `(k) hourly settlement transfers ${JSON.stringify(tr.map(t => [t.amount, t.destination]))}`);
            const pv = await http("GET", `/api/bookings/shoot/${row.id}/cancel-preview`, "consumer");
            check(T, pv.status === 200 && pv.body.isDepositBooking === true && pv.body.chargedAmountCents === 5400 && pv.body.refundAmountCents === 0 && pv.body.refundTier === "none",
              `(k) hourly cancel preview ${JSON.stringify({ i: pv.body.isDepositBooking, c: pv.body.chargedAmountCents, r: pv.body.refundAmountCents, t: pv.body.refundTier })}`);
            const rc0 = refundCreates.length;
            const rf = await http("POST", `/api/bookings/photographer/${row.id}/refund`, "photog", {});
            const made = refundCreates.slice(rc0);
            check(T, rf.status === 200 && rf.body?.amount === 5000 && made.length === 1 && made[0].amount === 5000,
              `(k) hourly photographer refund default ${rf.status}, amount ${rf.body?.amount}, Stripe refunds ${JSON.stringify(made.map(m => m.amount))}`);
          }
        } else check(T, false, "(k) no hourly deposit service created");
      }

      // GET /api/my-shoot-bookings
      {
        const mine = await http("GET", "/api/my-shoot-bookings", "consumer");
        const list: any[] = mine.body?.sessions ?? [];
        const md = list.find(s => s.id === manualId);
        const mf = list.find(s => s.depositAmountCents === null && s.price === 150);
        check(T, mine.status === 200 && md && md.depositAmountCents === 3000 && md.chargedAmountCents === 3240 && md.price === 275
          && mf && mf.chargedAmountCents === 16200,
          `my-shoot-bookings ${JSON.stringify({ d: md && [md.depositAmountCents, md.chargedAmountCents, md.price], f: mf && [mf.depositAmountCents, mf.chargedAmountCents] })}`);
      }

      Object.assign(R.PaymentIntents.prototype, { capture: origCapture, cancel: depCancel });
      R.Refunds.prototype.create = origRefund;
    }

    Object.assign(R.PaymentIntents.prototype, { create: orig.piCreate, retrieve: orig.piRetrieve, cancel: orig.piCancel });
    Object.assign(R.Customers.prototype, { retrieve: orig.custRetrieve, create: orig.custCreate });
    R.Transfers.prototype.create = orig.trCreate;
    server.close();

    const failed: string[] = [];
    for (const id of ["T-2a", "T-2b", "T-2c", "T-2d", "T-2f", "T-2g", "T-2h", "T-2s", "T-2p", "T-2ph"]) {
      const errs = results.get(id) ?? ["no checks ran"];
      if (errs.length) failed.push(id);
      origLog(`${errs.length ? "FAIL" : "PASS"}  ${id}${errs.length ? "\n        - " + errs.join("\n        - ") : ""}`);
    }
    if (seedingFailed) origLog("SEEDING FAILED: real holds could not be created — stop and report.");
    return { failed };
  }

  if (process.env.ONLY === "deposits") {
    const { failed } = await runDepositTests();
    origLog(failed.length ? `\nDeposit tests failing: ${failed.join(", ")}` : "\nAll deposit tests passed.");
    process.exit(failed.length ? 1 : 0);
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
  const cases: Array<{ name: string; run: () => Promise<{ first: () => Promise<void>; again: () => Promise<void>; shootId?: string }> }> = [
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
      // Checkout PaymentIntents get no metadata (only the session does) and are destination charges.
      const checkoutPi = { id: session.payment_intent, amount: 16200, metadata: {}, transfer_data: { destination: "acct_photog_checkout" } };
      return {
        first: async () => { await WebhookHandlers.handleCheckoutCompleted(session); await WebhookHandlers.handlePaymentIntentSucceeded(checkoutPi); },
        again: () => WebhookHandlers.handleCheckoutCompleted(session),
        shootId: b.id,
      };
    } },
  ];

  for (const c of cases) {
    reset();
    const { first, again, shootId } = await c.run();
    await first();
    const isShoot = c.name.includes("shoot");
    const expected = isShoot ? [ADMIN!, consumerEmail, photogEmail].sort() : expect3;
    assert(JSON.stringify(recipients()) === JSON.stringify(expected), `${c.name}: 3 receipts (consumer, vendor, admin)`);
    if (shootId) {
      const calls = transferCalls.filter(c => c.endsWith(`shoot_booking_${shootId}`));
      assert(calls.length === 0, `${c.name}: 0 settlement transfers (got ${JSON.stringify(calls)})`);
    }
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

  // ── Settlement: payout + pending points exactly once per appointment ─────
  // Own vendor/business with a connected account, so transfers actually run
  // (through the Stripe SDK stub above). Reuses the capture stub and the
  // webhook timing switch from the request-then-accept block.
  {
    const [sUser] = await db.insert(schema.users).values({ username: `sv_${tag}`, email: `settle-vendor-${tag}@example.com`, name: "Settle Vendor" } as any).returning();
    const [sBiz] = await db.insert(schema.businesses).values({ ownerId: sUser.id, name: "Settle Braids", category: "beauty", stripeAccountId: `acct_settle_${tag}` } as any).returning();
    const sToken = generateAccessToken({ userId: sUser.id, isVendor: true, businessId: sBiz.id });
    const { and: dAnd } = await import("drizzle-orm");

    const baseCapture = (stripeService as any).capturePaymentIntent;
    let captureCount = 0;
    let afterCapture: ((piId: string) => Promise<void>) | null = null;
    (stripeService as any).capturePaymentIntent = async (piId: string) => {
      captureCount++;
      const r = await baseCapture(piId);
      if (afterCapture) await afterCapture(piId);
      return r;
    };
    const baseRefund = (stripeService as any).createBookingRefund;
    const refundCalls: any[] = [];
    (stripeService as any).createBookingRefund = async (a: any) => { refundCalls.push(a); return { id: `re_${randomUUID().slice(0, 8)}`, amount: a?.amountCents }; };

    async function settleAppt(status: string, capture: "automatic" | "manual", expiresInMs: number | null = null) {
      const { date, time } = nextSlot();
      const piId = `pi_test_${randomUUID()}`;
      const [a] = await db.insert(schema.appointments).values({
        businessId: sBiz.id, clientId: consumer.id, appointmentDate: date, appointmentTime: time,
        totalPrice: 27500, depositAmountCents: 3000, serviceName: "Settlement test", status,
        captureMethod: capture, stripePaymentIntentId: piId,
        pendingProviderExpiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs),
      } as any).returning();
      const pi = { id: piId, amount: 3240, amount_received: 3240, metadata: { type: "appointment", appointmentId: a.id, businessId: sBiz.id, staffMemberId: "" } };
      capturable.set(piId, pi);
      return { id: a.id as string, piId, pi };
    }
    const transfersFor = (id: string) => stripeTransfers.filter(t => t.transfer_group === `appointment_${id}`);
    const pointsFor = async (id: string) => db.select().from(schema.pendingPointTransactions)
      .where(dAnd(eq(schema.pendingPointTransactions.referenceType, "appointment"), eq(schema.pendingPointTransactions.referenceId, id)));
    const apptRow = async (id: string) => (await db.select().from(schema.appointments).where(eq(schema.appointments.id, id)))[0] as any;
    async function acceptS(id: string) {
      const res = await fetch(`http://127.0.0.1:${port}/api/bookings/appointments/${id}/accept`, { method: "POST", headers: { Authorization: `Bearer ${sToken}`, "Content-Type": "application/json" } });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    }

    // (a) auto-accept: webhook confirms and settles.
    {
      reset();
      const { id, pi } = await settleAppt(BOOKING_STATES.PENDING_PAYMENT, "automatic");
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
      const tr = transfersFor(id); const row = await apptRow(id);
      assert(row.status === BOOKING_STATES.CONFIRMED, "settlement (a) auto-accept: confirmed");
      assert(tr.length === 1, `settlement (a) auto-accept: exactly 1 transfer (got ${tr.length})`);
      assert(tr[0].amount === 2940 && tr[0].destination === `acct_settle_${tag}` && tr[0].metadata.recipient === "business", "settlement (a) auto-accept: 2940c to the business account");
      assert(tr[0].idempotencyKey === `transfer_appt_${id}_business`, `settlement (a) auto-accept: deterministic idempotency key (got ${tr[0].idempotencyKey})`);
      assert((await pointsFor(id)).length === 1, "settlement (a) auto-accept: 1 pending points row");
      assert(!!row.settledAt && row.stripeTransferId === tr[0].id, "settlement (a) auto-accept: settled_at and stripe_transfer_id set");
    }

    // (b) manual accept, all four webhook timings.
    for (const timing of ["none", "after", "before", "concurrent"] as const) {
      reset();
      webhookTiming = timing;
      pendingWebhook = null;
      const { id, pi } = await settleAppt(BOOKING_STATES.PENDING_PROVIDER, "manual", 86_400_000);
      const res = await acceptS(id);
      if (timing === "after") await WebhookHandlers.handlePaymentIntentSucceeded({ ...pi, status: "succeeded" });
      if (pendingWebhook) await pendingWebhook;
      const tr = transfersFor(id); const row = await apptRow(id);
      assert(res.status === 200 && res.body?.success === true, `settlement (b) manual accept, webhook ${timing}: HTTP 200 (got ${res.status})`);
      assert(tr.length === 1, `settlement (b) manual accept, webhook ${timing}: exactly 1 transfer (got ${tr.length})`);
      assert((await pointsFor(id)).length === 1, `settlement (b) manual accept, webhook ${timing}: 1 pending points row`);
      assert(!!row.settledAt && row.stripeTransferId === tr[0]?.id, `settlement (b) manual accept, webhook ${timing}: settled_at and stripe_transfer_id set`);
    }
    webhookTiming = "none";
    pendingWebhook = null;

    // (c) duplicate webhook deliveries, sequential and concurrent.
    {
      reset();
      const { id, pi } = await settleAppt(BOOKING_STATES.PENDING_PAYMENT, "automatic");
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
      await Promise.all([WebhookHandlers.handlePaymentIntentSucceeded(pi), WebhookHandlers.handlePaymentIntentSucceeded(pi)]);
      assert(transfersFor(id).length === 1, `settlement (c) duplicate deliveries: still 1 transfer (got ${transfersFor(id).length})`);
      assert((await pointsFor(id)).length === 1, "settlement (c) duplicate deliveries: still 1 pending points row");
      assert(sent.length === 3, `settlement (c) duplicate deliveries: receipts still sent once (got ${sent.length})`);
    }

    // (d) request expired before the vendor accepted: no capture at all.
    {
      reset();
      const { id } = await settleAppt(BOOKING_STATES.PENDING_PROVIDER, "manual", -60_000);
      captureCount = 0;
      const res = await acceptS(id);
      const row = await apptRow(id);
      assert(res.status === 400 && res.body?.error === "This request expired before you accepted it. The customer was not charged.", `settlement (d) expired before Accept: 400 not-charged message (got ${res.status} ${JSON.stringify(res.body)})`);
      assert(captureCount === 0, "settlement (d) expired before Accept: no capture");
      assert(transfersFor(id).length === 0 && !row.settledAt, "settlement (d) expired before Accept: no transfer, not settled");
      assert(row.status === BOOKING_STATES.PENDING_PROVIDER, "settlement (d) expired before Accept: status left for the expiry job");
      // Retire it so the next run's cleanupExpiredPendingProvider scenario does not pick it up.
      await db.update(schema.appointments).set({ status: BOOKING_STATES.EXPIRED } as any).where(eq(schema.appointments.id, id));
    }

    // (e) capture succeeds, then the request turns out expired: refund, no payout.
    {
      reset();
      const { id, piId, pi } = await settleAppt(BOOKING_STATES.PENDING_PROVIDER, "manual", 86_400_000);
      refundCalls.length = 0;
      afterCapture = async () => {
        await db.update(schema.appointments).set({ pendingProviderExpiresAt: new Date(Date.now() - 1000) } as any).where(eq(schema.appointments.id, id));
      };
      const res = await acceptS(id);
      afterCapture = null;
      // The capture's payment_intent.succeeded still arrives later.
      await WebhookHandlers.handlePaymentIntentSucceeded({ ...pi, status: "succeeded" });
      const row = await apptRow(id);
      assert(res.status === 400 && res.body?.error === "This request expired before you accepted it. The customer was refunded.", `settlement (e) capture then expiry: 400 refunded message (got ${res.status} ${JSON.stringify(res.body)})`);
      assert(refundCalls.length === 1 && refundCalls[0].paymentIntentId === piId && refundCalls[0].amountCents === undefined, "settlement (e) capture then expiry: one full refund of the captured PaymentIntent");
      assert(transfersFor(id).length === 0 && !row.settledAt, "settlement (e) capture then expiry: no transfer, not settled (even after the webhook)");
      assert(row.status === BOOKING_STATES.EXPIRED, "settlement (e) capture then expiry: status expired");
    }

    // (f) legacy appointment_booking PaymentIntent: vendor already paid via transfer_data.
    for (const timing of ["none", "after"] as const) {
      reset();
      const { id, piId } = await settleAppt(BOOKING_STATES.PENDING_PROVIDER, "manual", 86_400_000);
      const legacy = { id: piId, amount: 29700, amount_received: 29700, metadata: { type: "appointment_booking", bookingId: id, clientId: consumer.id } };
      capturable.set(piId, legacy);
      const res = await acceptS(id);
      if (timing === "after") await WebhookHandlers.handlePaymentIntentSucceeded({ ...legacy, status: "succeeded" });
      const row = await apptRow(id);
      assert(res.status === 200 && row.status === BOOKING_STATES.CONFIRMED, `settlement (f) legacy accept, webhook ${timing}: HTTP 200, confirmed`);
      assert(transferCalls.filter(c => c.endsWith(`appointment_${id}`)).length === 0, `settlement (f) legacy accept, webhook ${timing}: 0 settlement transfer calls`);
      assert(!row.settledAt && (await pointsFor(id)).length === 0, `settlement (f) legacy accept, webhook ${timing}: not settled, no pending points`);
    }

    // (g) transfer throws: settled_at kept, no transfer id, no second transfer later.
    {
      reset();
      const { id, pi } = await settleAppt(BOOKING_STATES.PENDING_PAYMENT, "automatic");
      transferCreateThrows = "before";
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
      transferCreateThrows = "none";
      let row = await apptRow(id);
      assert(!!row.settledAt && row.stripeTransferId === null, "settlement (g) transfer throws: settled_at set, stripe_transfer_id NULL");
      assert((await pointsFor(id)).length === 1, "settlement (g) transfer throws: points still created");
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
      row = await apptRow(id);
      assert(transfersFor(id).length === 0 && row.stripeTransferId === null, "settlement (g) transfer throws: later webhook creates no transfer");
    }
    // (g2) Stripe created the transfer but the response was lost.
    {
      reset();
      const { id, pi } = await settleAppt(BOOKING_STATES.PENDING_PAYMENT, "automatic");
      transferCreateThrows = "after";
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
      transferCreateThrows = "none";
      const row = await apptRow(id);
      assert(!!row.settledAt && row.stripeTransferId === null && transfersFor(id).length === 1, "settlement (g2) lost transfer response: settled_at set, stripe_transfer_id NULL, 1 transfer at Stripe");
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
      assert(transfersFor(id).length === 1, "settlement (g2) lost transfer response: later webhook creates no second transfer");
      const retried = await stripeService.transferBookingPayout({ amountInCents: 2940, connectedAccountId: `acct_settle_${tag}`, appointmentId: id, recipient: "business" });
      assert(retried.id === transfersFor(id)[0].id && transfersFor(id).length === 1, "settlement (g2) manual payout retry returns the existing transfer (transfers.list), no second create");
    }

    // ── Shoot settlement: photographer payout + points exactly once ──────────
    {
      const [spUser] = await db.insert(schema.users).values({ username: `sp_${tag}`, email: `settle-photog-${tag}@example.com`, name: "Settle Photog" } as any).returning();
      const [sPhoto] = await db.insert(schema.photographers).values({ userId: spUser.id, displayName: "Settle Photog", hourlyRate: 10000, stripeAccountId: `acct_shoot_${tag}`, stripeOnboardingComplete: true } as any).returning();
      const spToken = generateAccessToken({ userId: spUser.id, isVendor: false, isPhotographer: true, photographerId: sPhoto.id });
      const VENDOR_NET = 14700;
      async function settleShoot(status: string, capture: "automatic" | "manual", expiresInMs: number | null = null) {
        const { date, time } = nextSlot();
        const piId = `pi_test_${randomUUID()}`;
        const [b] = await db.insert(schema.shootBookings).values({
          photographerId: sPhoto.id, clientId: consumer.id, shootType: "Portrait", date, startTime: time, endTime: time, durationHours: 1,
          totalPrice: 15000, platformFee: 1500, vendorNet: VENDOR_NET, status, captureMethod: capture, stripePaymentIntentId: piId,
          pendingProviderExpiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs),
        } as any).returning();
        const pi = { id: piId, amount: 16200, amount_received: 16200, metadata: { type: "shoot_booking", bookingId: b.id, clientId: consumer.id, vendorPayoutCents: String(VENDOR_NET) } };
        capturable.set(piId, pi);
        return { id: b.id as string, piId, pi };
      }
      const shootTransfers = (id: string) => stripeTransfers.filter(t => t.transfer_group === `shoot_booking_${id}`);
      // earnPoints uses db.transaction, which the neon-http driver rejects, so
      // it never writes a row here. Count the calls instead; each call still
      // goes through to the real earnPoints.
      const earnCalls: any[] = [];
      const origEarnPoints = storage.earnPoints;
      (storage as any).earnPoints = async function (this: any, data: any) { earnCalls.push(data); return origEarnPoints.call(this, data); };
      const shootPoints = async (id: string) => earnCalls.filter(c => c.referenceType === "shoot_booking" && c.referenceId === id);
      const shootRow = async (id: string) => (await db.select().from(schema.shootBookings).where(eq(schema.shootBookings.id, id)))[0] as any;
      async function acceptShoot(id: string) {
        const res = await fetch(`http://127.0.0.1:${port}/api/bookings/photographer/${id}/accept`, { method: "POST", headers: { Authorization: `Bearer ${spToken}`, "Content-Type": "application/json" } });
        return { status: res.status, body: await res.json().catch(() => ({})) as any };
      }

      // (a) auto-accept: webhook confirms and settles.
      {
        reset();
        const { id, pi } = await settleShoot(BOOKING_STATES.PENDING_PAYMENT, "automatic");
        await WebhookHandlers.handlePaymentIntentSucceeded(pi);
        const tr = shootTransfers(id); const row = await shootRow(id);
        assert(row.status === BOOKING_STATES.CONFIRMED, "shoot settlement (a) auto-accept: confirmed");
        assert(tr.length === 1, `shoot settlement (a) auto-accept: exactly 1 transfer (got ${tr.length})`);
        assert(tr[0].amount === VENDOR_NET && tr[0].amount === row.vendorNet && tr[0].destination === `acct_shoot_${tag}` && tr[0].metadata.recipient === "photographer",
          `shoot settlement (a) auto-accept: vendorNet ${row.vendorNet}c to the photographer account (got ${tr[0]?.amount} → ${tr[0]?.destination})`);
        assert(tr[0].idempotencyKey === `transfer_shoot_${id}_photographer`, `shoot settlement (a) auto-accept: deterministic idempotency key (got ${tr[0].idempotencyKey})`);
        assert(!!row.settledAt && row.stripeTransferId === tr[0].id, "shoot settlement (a) auto-accept: settled_at and stripe_transfer_id set");
        const pts = await shootPoints(id);
        assert(pts.length === 1 && pts[0].dollarAmountCents === 16200 && pts[0].userId === consumer.id && pts[0].transactionType === "photographer_booking",
          `shoot settlement (a) auto-accept: earnPoints called once, 16200 for the client (got ${JSON.stringify(pts.map(p => p.dollarAmountCents))})`);
      }

      // (b) manual accept, all four webhook timings.
      for (const timing of ["none", "after", "before", "concurrent"] as const) {
        reset();
        webhookTiming = timing;
        pendingWebhook = null;
        const { id, pi } = await settleShoot(BOOKING_STATES.PENDING_PROVIDER, "manual", 86_400_000);
        const res = await acceptShoot(id);
        if (timing === "after") await WebhookHandlers.handlePaymentIntentSucceeded({ ...pi, status: "succeeded" });
        if (pendingWebhook) await pendingWebhook;
        const tr = shootTransfers(id); const row = await shootRow(id);
        assert(res.status === 200 && res.body?.success === true, `shoot settlement (b) manual accept, webhook ${timing}: HTTP 200 (got ${res.status})`);
        assert(tr.length === 1 && tr[0].amount === VENDOR_NET, `shoot settlement (b) manual accept, webhook ${timing}: exactly 1 transfer of ${VENDOR_NET} (got ${JSON.stringify(tr.map(t => t.amount))})`);
        assert(!!row.settledAt && row.stripeTransferId === tr[0]?.id, `shoot settlement (b) manual accept, webhook ${timing}: settled_at and stripe_transfer_id set`);
        assert((await shootPoints(id)).length === 1, `shoot settlement (b) manual accept, webhook ${timing}: earnPoints called once (got ${(await shootPoints(id)).length})`);
        assert(receiptSentCount() === 3, `shoot settlement (b) manual accept, webhook ${timing}: receipts still exactly 3 (got ${receiptSentCount()})`);
      }
      webhookTiming = "none";
      pendingWebhook = null;

      // (c) duplicate webhook deliveries, sequential and concurrent.
      {
        reset();
        const { id, pi } = await settleShoot(BOOKING_STATES.PENDING_PAYMENT, "automatic");
        await WebhookHandlers.handlePaymentIntentSucceeded(pi);
        await WebhookHandlers.handlePaymentIntentSucceeded(pi);
        await Promise.all([WebhookHandlers.handlePaymentIntentSucceeded(pi), WebhookHandlers.handlePaymentIntentSucceeded(pi)]);
        assert(shootTransfers(id).length === 1, `shoot settlement (c) duplicate deliveries: still 1 transfer (got ${shootTransfers(id).length})`);
        assert((await shootPoints(id)).length === 1, `shoot settlement (c) duplicate deliveries: earnPoints called once (got ${(await shootPoints(id)).length})`);
        assert(sent.length === 3, `shoot settlement (c) duplicate deliveries: receipts still sent once (got ${sent.length})`);
      }

      // (d) request expired before the photographer accepted: no capture at all.
      {
        reset();
        const { id } = await settleShoot(BOOKING_STATES.PENDING_PROVIDER, "manual", -60_000);
        captureCount = 0;
        const res = await acceptShoot(id);
        const row = await shootRow(id);
        assert(res.status === 400 && res.body?.error === "This request expired before you accepted it. The customer was not charged.", `shoot settlement (d) expired before Accept: 400 not-charged message (got ${res.status} ${JSON.stringify(res.body)})`);
        assert(captureCount === 0, `shoot settlement (d) expired before Accept: no capture (got ${captureCount})`);
        assert(shootTransfers(id).length === 0 && !row.settledAt, "shoot settlement (d) expired before Accept: no transfer, not settled");
        await db.update(schema.shootBookings).set({ status: BOOKING_STATES.EXPIRED } as any).where(eq(schema.shootBookings.id, id));
      }

      // (e) capture succeeds, then the request turns out expired: refund, no payout.
      {
        reset();
        const { id, piId, pi } = await settleShoot(BOOKING_STATES.PENDING_PROVIDER, "manual", 86_400_000);
        refundCalls.length = 0;
        afterCapture = async () => {
          await db.update(schema.shootBookings).set({ pendingProviderExpiresAt: new Date(Date.now() - 1000) } as any).where(eq(schema.shootBookings.id, id));
        };
        const res = await acceptShoot(id);
        afterCapture = null;
        await WebhookHandlers.handlePaymentIntentSucceeded({ ...pi, status: "succeeded" });
        const row = await shootRow(id);
        assert(res.status === 400 && res.body?.error === "This request expired before you accepted it. The customer was refunded.", `shoot settlement (e) capture then expiry: 400 refunded message (got ${res.status} ${JSON.stringify(res.body)})`);
        assert(refundCalls.length === 1 && refundCalls[0].paymentIntentId === piId && refundCalls[0].amountCents === undefined, `shoot settlement (e) capture then expiry: one full refund of the captured PaymentIntent (got ${JSON.stringify(refundCalls)})`);
        assert(shootTransfers(id).length === 0 && !row.settledAt && (await shootPoints(id)).length === 0, "shoot settlement (e) capture then expiry: no transfer, not settled, earnPoints not called (even after the webhook)");
        assert(row.status === BOOKING_STATES.EXPIRED, `shoot settlement (e) capture then expiry: status expired (got ${row.status})`);
      }

      // (f) transfer throws: settled_at kept, no transfer id, no transfer later.
      {
        reset();
        const { id, pi } = await settleShoot(BOOKING_STATES.PENDING_PAYMENT, "automatic");
        transferCreateThrows = "before";
        await WebhookHandlers.handlePaymentIntentSucceeded(pi);
        transferCreateThrows = "none";
        let row = await shootRow(id);
        assert(!!row.settledAt && row.stripeTransferId === null, "shoot settlement (f) transfer throws: settled_at set, stripe_transfer_id NULL");
        assert((await shootPoints(id)).length === 1, "shoot settlement (f) transfer throws: earnPoints still called once");
        await WebhookHandlers.handlePaymentIntentSucceeded(pi);
        row = await shootRow(id);
        assert(shootTransfers(id).length === 0 && row.stripeTransferId === null && (await shootPoints(id)).length === 1, "shoot settlement (f) transfer throws: later webhook creates no transfer, no second earnPoints call");
      }

      // (g) Stripe created the transfer but the response was lost.
      {
        reset();
        const { id, pi } = await settleShoot(BOOKING_STATES.PENDING_PAYMENT, "automatic");
        transferCreateThrows = "after";
        await WebhookHandlers.handlePaymentIntentSucceeded(pi);
        transferCreateThrows = "none";
        const row = await shootRow(id);
        assert(!!row.settledAt && row.stripeTransferId === null && shootTransfers(id).length === 1, "shoot settlement (g) lost transfer response: settled_at set, stripe_transfer_id NULL, 1 transfer at Stripe");
        await WebhookHandlers.handlePaymentIntentSucceeded(pi);
        assert(shootTransfers(id).length === 1, "shoot settlement (g) lost transfer response: later webhook creates no second transfer");
        const retried = await stripeService.transferShootBookingPayout({ amountInCents: VENDOR_NET, connectedAccountId: `acct_shoot_${tag}`, bookingId: id });
        const creates = transferCalls.filter(c => c === `transfers.create:shoot_booking_${id}`).length;
        assert(retried.id === shootTransfers(id)[0].id && shootTransfers(id).length === 1 && creates === 1,
          `shoot settlement (g) manual payout retry returns the existing transfer (transfers.list), no second create (creates ${creates})`);
      }

      // (h2) destination charge (transfer_data): Stripe already paid the photographer.
      {
        reset();
        const { id, pi } = await settleShoot(BOOKING_STATES.PENDING_PAYMENT, "automatic");
        const destPi = { ...pi, transfer_data: { destination: `acct_shoot_${tag}` } };
        await WebhookHandlers.handlePaymentIntentSucceeded(destPi);
        await WebhookHandlers.handlePaymentIntentSucceeded(destPi);
        const row = await shootRow(id);
        const calls = transferCalls.filter(c => c.endsWith(`shoot_booking_${id}`));
        assert(row.status === BOOKING_STATES.CONFIRMED && !!row.settledAt && row.stripeTransferId === null,
          `shoot settlement (h2) destination charge: confirmed, settled_at set, no stripe_transfer_id (got ${row.status}, ${!!row.settledAt}, ${row.stripeTransferId})`);
        assert(shootTransfers(id).length === 0 && calls.length === 0, `shoot settlement (h2) destination charge: 0 settlement transfer calls (got ${JSON.stringify(calls)})`);
        assert(sent.length === 3, `shoot settlement (h2) destination charge: receipts still 3 (got ${sent.length})`);
      }
      (storage as any).earnPoints = origEarnPoints;
    }

    (stripeService as any).capturePaymentIntent = baseCapture;
    (stripeService as any).createBookingRefund = baseRefund;
  }

  await runGuardTests();
  await runCancelTests();
  await runFreeConsultationTests();

  const deposits = await runDepositTests();
  assert(deposits.failed.length === 0, `deposit tests pass (failing: ${deposits.failed.join(", ") || "none"})`);

  server.close();
  origLog(`\nAll ${passed} assertions passed.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    origErr(err);
    process.exit(1);
  });
