/**
 * Payment sheet customer session on booking and ticket payments (p4-applepay step 1).
 * The app asks with `paymentSheet: true`; nobody else gets the new fields.
 *
 * Run with: npx tsx server/payments/paymentSheet.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres with the Stripe stub
 * preload, and this process must reach the same DB:
 *   EV_TEST_BASE_URL     e.g. http://localhost:5071   (must be localhost)
 *   EV_TEST_PG_URL       the SAME scratch database     (localhost only; seeds + cleans up)
 *   EV_TEST_STRIPE_PORT  port for the Stripe stub started here (server booted with STRIPE_STUB_PORT=<same>)
 *   JWT_SECRET           identical to the server's
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host. Nothing reaches real Stripe.
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.EV_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL + EV_TEST_STRIPE_PORT to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error("refusing to run: BASE and PG_URL must be localhost and EV_TEST_STRIPE_PORT set");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub: customers, PaymentIntents (keep customer + setup_future_usage), customer sessions ──
  const piStore: Record<string, any> = {};
  const customers: Record<string, any> = {};
  const sessions: Record<string, string>[] = [];
  let failSessions = false;
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const url = req.url || "";
      if (req.method === "POST" && url === "/v1/customers") {
        const cid = `cus_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        customers[cid] = { id: cid, object: "customer", email: form.get("email") || "" };
        return send(200, customers[cid]);
      }
      const custM = url.match(/^\/v1\/customers\/([^/?]+)/);
      if (req.method === "GET" && custM) return customers[custM[1]] ? send(200, customers[custM[1]]) : send(404, { error: { message: "No such customer" } });
      if (req.method === "POST" && url === "/v1/payment_intents") {
        const piId = `pi_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        piStore[piId] = {
          id: piId, object: "payment_intent", amount: Number(form.get("amount") || 0), currency: "usd", status: "requires_payment_method",
          client_secret: `${piId}_secret_stub`, metadata: {}, capture_method: form.get("capture_method") || "automatic",
          customer: form.get("customer"), setup_future_usage: form.get("setup_future_usage"),
        };
        return send(200, piStore[piId]);
      }
      const piM = url.match(/^\/v1\/payment_intents\/([^/?]+)/);
      if (piM) return piStore[piM[1]] ? send(200, piStore[piM[1]]) : send(404, { error: { message: "No such payment_intent" } });
      if (req.method === "POST" && url === "/v1/customer_sessions") {
        if (failSessions) return send(500, { error: { type: "api_error", message: "stub outage" } });
        const body: Record<string, string> = {};
        for (const [k, v] of form) body[k] = v;
        sessions.push(body);
        return send(200, { object: "customer_session", client_secret: `cuss_secret_${body.customer}`, customer: body.customer });
      }
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  // ── seed ──
  const P = `ps${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const mkUser = async (key: string, o: { isVendor?: boolean; isPhotographer?: boolean; email?: boolean } = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, name, first_name, is_vendor, is_photographer) VALUES ($1::varchar, $2::text, $3, $4, $4, $5, $6)`,
      [uid, uid.slice(0, 20), o.email === false ? null : `${uid}@ps.test`, `User ${key}`, o.isVendor ?? false, o.isPhotographer ?? false]);
    users.push(uid);
    return uid;
  };
  const vendor = await mkUser("v", { isVendor: true });
  const biz = id("b");
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 'Sheet Biz', 'beauty', 'approved', $3, true)`,
    [biz, vendor, `acct_${P}`]);
  for (let dow = 0; dow <= 6; dow++) {
    await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, '08:00', '20:00', true)`, [id(`wa-${dow}`), biz, dow]);
  }
  const svc = id("svc");
  await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status) VALUES ($1, $2, 'Sheet Svc', 7000, 30, true, 'live')`, [svc, biz]);
  const tier = id("tier");
  await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps) VALUES ($1, $2, 'T', 2900, 200)`, [tier, tier]);
  await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, stripe_subscription_id, current_period_end) VALUES ($1, $2, $3, $4, 'active', $5, now() + interval '30 days')`,
    [id("sub"), vendor, biz, tier, `sub_${P}`]);

  const allDaysOpen = JSON.stringify(Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [d, { open: "08:00", close: "20:00" }])));
  const phUser = await mkUser("phu", { isPhotographer: true });
  const ph = id("ph");
  await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, hours_of_operation, stripe_account_id, stripe_onboarding_complete, is_demo, auto_accept_bookings, visibility_status, created_at, updated_at)
           VALUES ($1, $2, 'Sheet Photographer', 10000, 'Austin', 'TX', $3::jsonb, $4, true, false, true, 'public', now(), now())`, [ph, phUser, allDaysOpen, `acct_${P}ph`]);
  for (let day = 0; day <= 6; day++) {
    await q(`INSERT INTO weekly_availability (provider_id, provider_type, day_of_week, start_time, end_time, is_active) VALUES ($1, 'photographer', $2, '08:00', '20:00', true)`, [ph, day]);
  }
  const phSvc = id("phsvc");
  await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at)
           VALUES ($1, $2, 'Sheet Shoot', 7000, 30, true, 'live', 'package', false, now())`, [phSvc, ph]);

  const customer = await mkUser("c");
  const token = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false } as any);
  let dayOffset = 3;
  const nextSlot = () => { dayOffset += 1; const d = new Date(); d.setDate(d.getDate() + dayOffset); return { date: d.toISOString().slice(0, 10), startTime: "10:00" }; };
  const hold = async (body: Record<string, unknown>) => {
    const r = await call("POST", "/api/booking/hold", { token, body: { ...nextSlot(), ...body } });
    return r.body?.holdId ?? r.body?.hold?.id ?? r.body?.id;
  };
  const pay = (holdId: string, body: Record<string, unknown>) => call("POST", `/api/booking/${holdId}/create-payment-intent`, { token, body });
  const sessionFor = (r: { body: any }) => {
    const pi = piStore[r.body?.paymentIntentId];
    return { pi, customerId: r.body?.customerId, secret: r.body?.customerSessionClientSecret };
  };

  const eventIds: string[] = [];
  try {
    console.log("Booking payments");
    let h = await hold({ providerType: "business", providerId: biz, serviceId: svc });
    let r = await pay(h, {});
    assert(r.status === 200 && !!r.body?.clientSecret, "appointment payment answers as before", r);
    assert(!("customerId" in (r.body || {})) && !("customerSessionClientSecret" in (r.body || {})), "hold payment without paymentSheet has no session fields", r.body);
    assert(piStore[r.body?.paymentIntentId]?.setup_future_usage === "off_session", "booking PaymentIntent keeps setup_future_usage", piStore[r.body?.paymentIntentId]);

    h = await hold({ providerType: "business", providerId: biz, serviceId: svc });
    const before = sessions.length;
    r = await pay(h, { paymentSheet: true });
    let s = sessionFor(r);
    assert(r.status === 200 && !!s.pi?.customer && s.customerId === s.pi.customer && s.secret === `cuss_secret_${s.pi.customer}`, "hold payment with paymentSheet returns session for the PaymentIntent's customer", { body: r.body, pi: s.pi });
    const made = sessions[before] || {};
    assert(made["components[mobile_payment_element][enabled]"] === "true"
      && made["components[mobile_payment_element][features][payment_method_save]"] === "enabled"
      && made["components[mobile_payment_element][features][payment_method_redisplay]"] === "enabled"
      && made["components[mobile_payment_element][features][payment_method_remove]"] === "disabled"
      && made["components[mobile_payment_element][features][payment_method_allow_redisplay_filters][0]"] === "always"
      && !("components[mobile_payment_element][features][payment_method_allow_redisplay_filters][1]" in made),
      "session shows chosen cards and the Save box only", made);

    r = await pay(h, { paymentSheet: true });
    s = sessionFor(r);
    assert(r.status === 200 && s.customerId === s.pi?.customer && !!s.secret, "repeat hold payment returns session for the same PaymentIntent", r.body);

    failSessions = true;
    h = await hold({ providerType: "business", providerId: biz, serviceId: svc });
    r = await pay(h, { paymentSheet: true });
    failSessions = false;
    assert(r.status === 200 && !!r.body?.clientSecret && !("customerSessionClientSecret" in (r.body || {})), "session outage still returns clientSecret", r);

    h = await hold({ providerType: "photographer", providerId: ph, serviceId: phSvc });
    r = await pay(h, { paymentSheet: true });
    s = sessionFor(r);
    assert(r.status === 200 && !!r.body?.shootBookingId && s.customerId === s.pi?.customer && !!s.secret, "photographer hold payment with paymentSheet returns session", r.body);

    console.log("Ticket checkout");
    const host = await mkUser("host");
    const hostTok = generateAccessToken({ userId: host, isVendor: false } as any);
    const inDays = (d: number, hh = 0) => new Date(Date.now() + d * 86400000 + hh * 3600000).toISOString();
    const ev = (await call("POST", "/api/events", { token: hostTok, body: { title: "Sheet Night", startsAt: inDays(7), endsAt: inDays(7, 5), timezone: "America/New_York" } })).body?.event;
    eventIds.push(ev?.id);
    const tt = (await call("POST", `/api/events/${ev?.id}/ticket-types`, { token: hostTok, body: { name: "GA", priceCents: 2500, quantity: 50 } })).body?.ticketType;
    await q(`UPDATE events SET status = 'published', published_at = now() WHERE id = $1`, [ev?.id]);
    const buy = (user: string, body: Record<string, unknown>) =>
      call("POST", `/api/events/${ev?.id}/checkout`, { token: generateAccessToken({ userId: user, isVendor: false } as any), body: { ticketTypeId: tt?.id, quantity: 1, idempotencyKey: `${P}-${Math.random().toString(36).slice(2)}`, ...body } });

    const b1 = await mkUser("b1");
    r = await buy(b1, {});
    assert(r.status === 201 && !!r.body?.clientSecret && !("customerSessionClientSecret" in (r.body || {})), "ticket checkout without paymentSheet has no session fields", r);
    const b2 = await mkUser("b2");
    r = await buy(b2, { paymentSheet: true });
    const tpi = Object.values(piStore).find((p: any) => p.client_secret === r.body?.clientSecret);
    assert(r.status === 201 && !!tpi?.customer && r.body?.customerId === tpi.customer && r.body?.customerSessionClientSecret === `cuss_secret_${tpi.customer}`, "ticket checkout with paymentSheet returns session", { body: r.body, tpi });
    const b3 = await mkUser("b3", { email: false });
    r = await buy(b3, { paymentSheet: true });
    assert(r.status === 201 && !("customerSessionClientSecret" in (r.body || {})), "ticket checkout without email customer returns no session", r);
  } finally {
    const clean = async (sql: string, p: unknown[]) => q(sql, p).catch((e: any) => console.error("cleanup", e.message));
    await clean(`DELETE FROM tickets WHERE event_id = ANY($1)`, [eventIds]);
    await clean(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [eventIds]);
    await clean(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [eventIds]);
    await clean(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    await clean(`DELETE FROM appointments WHERE business_id = $1`, [biz]);
    await clean(`DELETE FROM shoot_bookings WHERE photographer_id = $1`, [ph]);
    await clean(`DELETE FROM booking_holds WHERE provider_id = ANY($1)`, [[biz, ph]]);
    await clean(`DELETE FROM weekly_availability WHERE provider_id = ANY($1)`, [[biz, ph]]);
    await clean(`DELETE FROM photographer_services WHERE photographer_id = $1`, [ph]);
    await clean(`DELETE FROM photographers WHERE id = $1`, [ph]);
    await clean(`DELETE FROM vendor_services WHERE business_id = $1`, [biz]);
    await clean(`DELETE FROM vendor_subscriptions WHERE business_id = $1`, [biz]);
    await clean(`DELETE FROM businesses WHERE id = $1`, [biz]);
    await clean(`DELETE FROM subscription_tiers WHERE id = $1`, [tier]);
    await clean(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
