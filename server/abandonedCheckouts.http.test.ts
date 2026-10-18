/**
 * Abandoned checkouts (Part B) — integration tests
 *
 * Run with: npx tsx server/abandonedCheckouts.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema,
 * migration 050 applied) with the Stripe stub preload, and this process must reach the same DB:
 *
 *   AB_TEST_BASE_URL     e.g. http://localhost:5072   (must be localhost)
 *   AB_TEST_PG_URL       the SAME scratch database     (localhost only; seeds + cleans up)
 *   AB_TEST_STRIPE_PORT  port for the Stripe stub started here (server booted with STRIPE_STUB_PORT=<same>)
 *   JWT_SECRET           identical to the server's
 *   DATABASE_URL + NODE_OPTIONS="--import ./.dev/neon-preload.mjs" so the job runs in-process
 *
 * Skips (exit 0) when AB_TEST_BASE_URL is unset and refuses any non-local host.
 *
 * What it proves:
 *  - the job expires pending_payment rows older than 15 minutes with no PaymentIntent, or whose
 *    PaymentIntent is canceled, or after cancelling an unpaid one (requires_payment_method)
 *  - it never touches succeeded / processing / requires_capture PaymentIntents, never touches a row
 *    when Stripe errors, and never touches rows younger than 15 minutes or in another status
 *  - shoot bookings: the photographer's reserved slot is released when the booking ends
 *  - a customer can book the same photographer slot again after their earlier attempt expired
 *    (no 409), create-payment-intent returns holdExpiresAt, and holds are capped at 10 minutes
 *  - the slot rule: an expired booking no longer blocks the slot, two active ones still can't coexist
 */
import http from 'http';

const BASE = process.env.AB_TEST_BASE_URL;
const PG_URL = process.env.AB_TEST_PG_URL;
const STUB_PORT = Number(process.env.AB_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.7.9' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log('⏭  skipped: set AB_TEST_BASE_URL (+ AB_TEST_PG_URL, AB_TEST_STRIPE_PORT) to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error('refusing to run: localhost only, and AB_TEST_STRIPE_PORT required');

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ab-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const { cleanupAbandonedPendingPayment, decideAbandoned } = await import('./abandonedCheckouts');
  const { transitionAppointmentState, transitionShootBookingState } = await import('./bookingStateMachine');
  const { BOOKING_STATES } = await import('@shared/schema');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub: PaymentIntents with a status we control ──
  const piStore: Record<string, any> = {};
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === 'POST' && req.url === '/v1/customers') return send(200, { id: `cus_stub_${Date.now()}`, object: 'customer' });
      const custM = req.url?.match(/^\/v1\/customers\/([^/?]+)/);
      if (req.method === 'GET' && custM) return send(200, { id: custM[1], object: 'customer' });
      if (req.method === 'POST' && req.url?.includes('/attach')) return send(200, { id: 'pm_stub', object: 'payment_method' });
      if (req.method === 'POST' && req.url === '/v1/payment_intents') {
        const id = `pi_ab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        piStore[id] = { id, object: 'payment_intent', amount: Number(form.get('amount') || 0), status: 'requires_payment_method', client_secret: `${id}_secret`, capture_method: form.get('capture_method') || 'automatic', metadata: {} };
        return send(200, piStore[id]);
      }
      const cancelM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)\/cancel/);
      if (req.method === 'POST' && cancelM) {
        const pi = piStore[cancelM[1]];
        if (!pi) return send(404, { error: { message: 'No such payment_intent' } });
        pi.status = 'canceled';
        return send(200, pi);
      }
      const piM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)$/);
      if (req.method === 'GET' && piM) {
        const pi = piStore[piM[1]];
        return pi ? send(200, pi) : send(404, { error: { message: 'No such payment_intent' } });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // Test-controlled Stripe for the in-process job (same PaymentIntent store as the stub).
  const cancelled: string[] = [];
  const failOn = new Set<string>();
  const deps = {
    getPaymentIntentStatus: async (pi: string) => { if (failOn.has(pi)) throw new Error('stripe down'); if (!piStore[pi]) throw new Error('no such pi'); return piStore[pi].status; },
    cancelPaymentIntent: async (pi: string) => { cancelled.push(pi); piStore[pi].status = 'canceled'; return piStore[pi]; },
    transitionAppointment: (id: string) => transitionAppointmentState(id, BOOKING_STATES.EXPIRED, { triggeredBy: 'system', triggerSource: 'cron' as const }),
    transitionShoot: (id: string) => transitionShootBookingState(id, BOOKING_STATES.EXPIRED, { triggeredBy: 'system', triggerSource: 'cron' as const }),
    getShootStatus: async (id: string) => (await q(`SELECT status FROM shoot_bookings WHERE id = $1`, [id]))[0]?.status ?? null,
    releasePhotographerSlot: async (id: string) => q(`DELETE FROM photographer_availability WHERE shoot_booking_id = $1`, [id]),
  };

  const P = `ab${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users = [id('vendor'), id('client'), id('photog')];
  const bizId = id('biz');
  const photogId = id('ph');
  const svcId = id('svc');
  const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const allDays = JSON.stringify(Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map((d) => [d, { open: '08:00', close: '20:00' }])));

  try {
    console.log('decideAbandoned');
    eq(decideAbandoned(null), 'expire', 'no PaymentIntent → expire');
    eq(decideAbandoned('canceled'), 'expire', 'already canceled → expire');
    for (const s of ['succeeded', 'processing', 'requires_capture']) eq(decideAbandoned(s), 'skip', `${s} → never touched`);
    for (const s of ['requires_payment_method', 'requires_confirmation', 'requires_action']) eq(decideAbandoned(s), 'cancel_then_expire', `${s} → cancel, then expire`);

    // ── seed ──
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, true)`, [users[0], `${users[0]}@ab.test`]);
    await q(`INSERT INTO users (id, username, email) VALUES ($1::varchar, $1::text, $2)`, [users[1], `${users[1]}@ab.test`]);
    await q(`INSERT INTO users (id, username, email, is_photographer) VALUES ($1::varchar, $1::text, $2, true)`, [users[2], `${users[2]}@ab.test`]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'AB Biz', 'beauty', 'approved')`, [bizId, users[0]]);
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, hours_of_operation, stripe_account_id, stripe_onboarding_complete, is_demo, auto_accept_bookings, visibility_status, created_at, updated_at)
             VALUES ($1, $2, 'AB Photog', 10000, 'Austin', 'TX', $3::jsonb, $4, true, false, true, 'public', now(), now())`, [photogId, users[2], allDays, `acct_${P}`]);
    for (let day = 0; day <= 6; day++) await q(`INSERT INTO weekly_availability (provider_id, provider_type, day_of_week, start_time, end_time, is_active) VALUES ($1, 'photographer', $2, '08:00', '20:00', true)`, [photogId, day]);
    await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at)
             VALUES ($1, $2, 'AB Shoot', 7000, 60, true, 'live', 'package', false, now())`, [svcId, photogId]);

    const pi = (status: string) => { const p = `pi_ab_${Math.random().toString(36).slice(2, 10)}`; piStore[p] = { id: p, status }; return p; };
    const old = `now() - interval '20 minutes'`;
    const mkAppt = async (k: string, status: string, piId: string | null, age = old, time = '09:00') => {
      await q(`INSERT INTO appointments (id, business_id, client_id, appointment_date, appointment_time, total_price, status, stripe_payment_intent_id, capture_method, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, 10000, $6, $7, 'automatic', ${age}, ${age})`, [id(k), bizId, users[1], TOMORROW, time, status, piId]);
    };
    const piUnpaid = pi('requires_payment_method');
    const piCanceled = pi('canceled');
    const piPaid = pi('succeeded');
    const piProcessing = pi('processing');
    const piAuthorized = pi('requires_capture');
    const piStripeDown = pi('requires_payment_method'); failOn.add(piStripeDown);
    const piYoung = pi('requires_payment_method');
    await mkAppt('a-nopi', 'pending_payment', null, old, '08:00');
    await mkAppt('a-unpaid', 'pending_payment', piUnpaid, old, '09:00');
    await mkAppt('a-canceled', 'pending_payment', piCanceled, old, '10:00');
    await mkAppt('a-paid', 'pending_payment', piPaid, old, '11:00');
    await mkAppt('a-processing', 'pending_payment', piProcessing, old, '12:00');
    await mkAppt('a-authorized', 'pending_payment', piAuthorized, old, '13:00');
    await mkAppt('a-stripedown', 'pending_payment', piStripeDown, old, '14:00');
    await mkAppt('a-young', 'pending_payment', piYoung, `now() - interval '5 minutes'`, '15:00');
    await mkAppt('a-confirmed', 'confirmed', pi('succeeded'), old, '16:00');

    // A shoot with a reserved slot, abandoned.
    const piShoot = pi('requires_payment_method');
    await q(`INSERT INTO shoot_bookings (id, duration_hours, shoot_type, photographer_id, client_id, service_id, date, start_time, end_time, total_price, status, stripe_payment_intent_id, created_at, updated_at)
             VALUES ($1, 1, 'portrait', $2, $3, $4, $5, '17:00', '18:00', 7000, 'pending_payment', $6, ${old}, ${old})`, [id('s1'), photogId, users[1], svcId, TOMORROW, piShoot]);
    await q(`INSERT INTO photographer_availability (photographer_id, date, start_time, end_time, slot_type, shoot_booking_id) VALUES ($1, $2, '17:00', '18:00', 'booked', $3)`, [photogId, TOMORROW, id('s1')]);

    console.log('Cleanup job');
    await cleanupAbandonedPendingPayment(new Date(), deps);
    const st = async (k: string) => (await q(`SELECT status FROM appointments WHERE id = $1`, [id(k)]))[0]?.status;
    eq(await st('a-nopi'), 'expired', 'no PaymentIntent → expired');
    eq([await st('a-unpaid'), piStore[piUnpaid].status], ['expired', 'canceled'], 'unpaid → PaymentIntent cancelled, then expired');
    eq(await st('a-canceled'), 'expired', 'already-canceled PaymentIntent → expired, no second cancel');
    eq(cancelled.includes(piCanceled), false, 'never cancels an already-canceled PaymentIntent');
    eq(await st('a-paid'), 'pending_payment', 'succeeded payment → untouched (webhook confirms it)');
    eq(await st('a-processing'), 'pending_payment', 'processing payment → untouched');
    eq(await st('a-authorized'), 'pending_payment', 'authorized card → untouched');
    eq([piStore[piPaid].status, piStore[piProcessing].status, piStore[piAuthorized].status], ['succeeded', 'processing', 'requires_capture'], 'moving money is never cancelled');
    eq(await st('a-stripedown'), 'pending_payment', 'Stripe error → left for the next run');
    eq(await st('a-young'), 'pending_payment', 'younger than 15 minutes → untouched');
    eq(await st('a-confirmed'), 'confirmed', 'other statuses → untouched');
    const audit = await q(`SELECT to_state, trigger_source FROM booking_audit_log WHERE booking_id = $1`, [id('a-unpaid')]);
    eq(audit.map((a) => [a.to_state, a.trigger_source]), [['expired', 'cron']], 'expiry goes through the state machine (audit row)');
    const [s1] = await q(`SELECT status FROM shoot_bookings WHERE id = $1`, [id('s1')]);
    const slotRows = await q(`SELECT 1 FROM photographer_availability WHERE shoot_booking_id = $1`, [id('s1')]);
    eq([s1.status, slotRows.length, piStore[piShoot].status], ['expired', 0, 'canceled'], 'abandoned shoot → expired, slot released, PaymentIntent cancelled');

    console.log('Second run');
    failOn.delete(piStripeDown);
    await cleanupAbandonedPendingPayment(new Date(), deps);
    eq(await st('a-stripedown'), 'expired', 'row skipped on a Stripe error is expired on the next run');
    eq(await st('a-paid'), 'pending_payment', 'paid row still untouched');

    console.log('Slot rule (migration 050)');
    let blocked = false;
    try {
      await q(`INSERT INTO shoot_bookings (id, duration_hours, shoot_type, photographer_id, client_id, service_id, date, start_time, end_time, total_price, status) VALUES ($1, 1, 'portrait', $2, $3, $4, $5, '17:00', '18:00', 7000, 'pending_payment')`, [id('s2'), photogId, users[1], svcId, TOMORROW]);
    } catch { blocked = true; }
    eq(blocked, false, 'expired shoot no longer blocks its start time');
    let dup = false;
    try {
      await q(`INSERT INTO shoot_bookings (id, duration_hours, shoot_type, photographer_id, client_id, service_id, date, start_time, end_time, total_price, status) VALUES ($1, 1, 'portrait', $2, $3, $4, $5, '17:00', '18:00', 7000, 'confirmed')`, [id('s3'), photogId, users[1], svcId, TOMORROW]);
    } catch (e: any) { dup = e?.code === '23505'; }
    eq(dup, true, 'two active bookings for the same photographer slot are still impossible');
    await q(`DELETE FROM shoot_bookings WHERE id = $1`, [id('s2')]);

    console.log('Rebook after expiry + hold cap + holdExpiresAt (HTTP)');
    const token = generateAccessToken({ userId: users[1], isVendor: false, isAdmin: false });
    const holdBody = { providerType: 'photographer', providerId: photogId, serviceId: svcId, date: TOMORROW, startTime: '10:00', holdDurationMinutes: 60 };
    let r = await call('POST', '/api/booking/hold', { token, body: holdBody });
    eq(r.status, 200, 'hold 1 created');
    const minutes = (new Date(r.body?.expiresAt).getTime() - Date.now()) / 60000;
    eq(minutes > 9 && minutes <= 10.1, true, 'hold asked for 60 minutes is capped at 10');
    const hold1 = r.body?.holdId;
    r = await call('POST', `/api/booking/${hold1}/create-payment-intent`, { token, body: {} });
    eq(r.status, 200, 'payment started on hold 1');
    eq(typeof r.body?.holdExpiresAt === 'string' && !Number.isNaN(Date.parse(r.body.holdExpiresAt)), true, 'create-payment-intent returns holdExpiresAt');
    const shoot1 = r.body?.shootBookingId;
    // Customer walks away: hold lapses, the job expires the booking.
    await q(`UPDATE booking_holds SET expires_at = now() - interval '1 minute' WHERE id = $1`, [hold1]);
    await q(`UPDATE shoot_bookings SET updated_at = now() - interval '20 minutes' WHERE id = $1`, [shoot1]);
    await cleanupAbandonedPendingPayment(new Date(), deps);
    eq((await q(`SELECT status FROM shoot_bookings WHERE id = $1`, [shoot1]))[0]?.status, 'expired', 'first attempt expired');
    await q(`UPDATE booking_holds SET status = 'expired' WHERE id = $1`, [hold1]);
    r = await call('POST', '/api/booking/hold', { token, body: { ...holdBody, holdDurationMinutes: undefined } });
    eq(r.status, 200, 'same customer can hold the same slot again');
    r = await call('POST', `/api/booking/${r.body?.holdId}/create-payment-intent`, { token, body: {} });
    eq(r.status, 200, 'same customer can pay for the same slot again (no 409)');
    eq(!!r.body?.shootBookingId && r.body.shootBookingId !== shoot1, true, 'a new booking is created');
  } finally {
    const shootIds = (await q(`SELECT id FROM shoot_bookings WHERE photographer_id = $1`, [photogId])).map((r) => r.id);
    await q(`DELETE FROM booking_audit_log WHERE booking_id = ANY($1)`, [[...shootIds, ...['a-nopi','a-unpaid','a-canceled','a-paid','a-processing','a-authorized','a-stripedown','a-young','a-confirmed'].map(id)]]).catch(() => {});
    await q(`DELETE FROM photographer_availability WHERE photographer_id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM shoot_bookings WHERE photographer_id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM booking_holds WHERE provider_id = $1 OR user_id = $2`, [photogId, users[1]]).catch(() => {});
    await q(`DELETE FROM appointments WHERE business_id = $1`, [bizId]).catch(() => {});
    await q(`DELETE FROM photographer_services WHERE id = $1`, [svcId]).catch(() => {});
    await q(`DELETE FROM weekly_availability WHERE provider_id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM photographers WHERE id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = $1`, [bizId]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
