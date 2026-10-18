/**
 * Manual-accept requests (Part C) — tests
 *
 * Run (LOCAL scratch Postgres only, full schema incl. migration 054):
 *   Job + rules:   MR_TEST_PG_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *                  DATABASE_URL=$MR_TEST_PG_URL NODE_OPTIONS="--import ./.dev/neon-preload.mjs" \
 *                  npx tsx server/manualRequests.http.test.ts
 *                  (stop any local backend first: its own cleanup job would race these rows)
 *   HTTP endpoint: add MR_TEST_BASE_URL=http://localhost:5072 (backend booted on the same DB with the
 *                  same JWT_SECRET); then only the /api/me/time-zone section runs.
 *
 * Pure rules always run. Refuses any non-local host.
 *
 * What it proves:
 *  - time zone math (EDT/EST, Los Angeles, daylight saving), deadline = 48h or appointment start,
 *    reminder timing (24h before; halfway when the window is short; never in the first hour)
 *  - a manual checkout becomes a request only when its card is on hold, exactly once, whether the
 *    webhook or the job gets there first; unpaid, too young, or automatic-capture rows are left alone
 *  - the deadline uses the business's own time zone
 *  - the reminder goes once, only for a request whose card is really on hold
 *  - expiry releases the card hold first, tells both sides once, retries when Stripe fails, never
 *    touches money already taken, ends old unpaid requests quietly, frees the photographer's slot
 *  - the state machine no longer expires a past-due request on the spot (no silent expiry)
 *  - POST /api/me/time-zone: auth, validation, fill-only-when-empty, overwrite
 */
import http from 'http';

const PG_URL = process.env.MR_TEST_PG_URL;
const BASE = process.env.MR_TEST_BASE_URL;

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
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.7.10' };
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
  const mr = await import('./manualRequests');

  // ── Pure rules ──
  console.log('Time zone math');
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  eq(iso(mr.wallClockToUtc('2026-10-18', '10:00', 'America/New_York')), '2026-10-18T14:00:00.000Z', 'New York in October (EDT) is UTC−4');
  eq(iso(mr.wallClockToUtc('2026-12-01', '10:00', 'America/New_York')), '2026-12-01T15:00:00.000Z', 'New York in December (EST) is UTC−5');
  eq(iso(mr.wallClockToUtc('2026-10-18', '10:00', 'America/Los_Angeles')), '2026-10-18T17:00:00.000Z', 'Los Angeles in October is UTC−7');
  eq(iso(mr.wallClockToUtc('2026-11-01', '01:30:00', 'America/New_York')) !== null, true, 'the repeated hour on the fall-back night still resolves');
  eq(iso(mr.wallClockToUtc('2026-03-08', '10:00', 'America/New_York')), '2026-03-08T14:00:00.000Z', 'spring-forward day, after the jump, is EDT');
  eq(mr.wallClockToUtc('not a date', '10:00', 'America/New_York'), null, 'bad text → null');
  eq([mr.isValidTimeZone('America/Chicago'), mr.isValidTimeZone('UTC'), mr.isValidTimeZone('Mars/Base'), mr.isValidTimeZone(''), mr.isValidTimeZone(42)], [true, true, false, false, false], 'IANA zone validation');
  eq(mr.resolveTimeZone(null), 'America/New_York', 'no zone → New York');

  console.log('Deadline and reminder timing');
  const H = 3600_000;
  const t0 = new Date('2026-10-18T12:00:00.000Z');
  eq(iso(mr.requestDeadline(new Date(t0.getTime() + 5 * H), t0)), new Date(t0.getTime() + 5 * H).toISOString(), 'appointment in 5h → deadline is the appointment start');
  eq(iso(mr.requestDeadline(new Date(t0.getTime() + 5 * 24 * H), t0)), new Date(t0.getTime() + 48 * H).toISOString(), 'appointment in 5 days → 48h');
  eq(iso(mr.requestDeadline(null, t0)), new Date(t0.getTime() + 48 * H).toISOString(), 'unknown start → 48h');
  eq(iso(mr.reminderDueAt(t0, new Date(t0.getTime() + 48 * H))), new Date(t0.getTime() + 24 * H).toISOString(), '48h window → reminder 24h before the deadline');
  eq(iso(mr.reminderDueAt(t0, new Date(t0.getTime() + 10 * H))), new Date(t0.getTime() + 5 * H).toISOString(), '10h window → halfway');
  eq(iso(mr.reminderDueAt(t0, new Date(t0.getTime() + 90 * 60_000))), new Date(t0.getTime() + H).toISOString(), '90 min window → not in the first hour, so at 1h');
  eq(mr.reminderDueAt(t0, new Date(t0.getTime() + 30 * 60_000)), null, '30 min window → no reminder');

  console.log('Expiry decisions');
  eq(mr.decideExpiry(null), { decision: 'expire_quietly', authorized: false }, 'no PaymentIntent → quiet');
  eq(mr.decideExpiry({ status: 'requires_capture' }), { decision: 'cancel_then_expire', authorized: true }, 'card on hold → release, expire, tell both sides');
  eq(mr.decideExpiry({ status: 'requires_payment_method' }), { decision: 'cancel_then_expire', authorized: false }, 'never paid → release, expire quietly');
  eq(mr.decideExpiry({ status: 'canceled', latest_charge: 'ch_1' }), { decision: 'expire_notify', authorized: true }, 'hold already released → expire, tell both sides');
  eq(mr.decideExpiry({ status: 'canceled', latest_charge: null }), { decision: 'expire_quietly', authorized: false }, 'canceled, never paid → quiet');
  eq(mr.decideExpiry({ status: 'succeeded' }).decision, 'flag_money_taken', 'money taken → never expired');
  eq(mr.decideExpiry({ status: 'processing' }).decision, 'flag_money_taken', 'money moving → never expired');

  console.log('Labels');
  eq([mr.formatDateLabel('2026-10-18'), mr.formatTimeLabel('14:30'), mr.formatTimeLabel('00:05'), mr.formatTimeLabel('12:00')], ['Sun, Oct 18', '2:30 PM', '12:05 AM', '12:00 PM'], 'date and time labels');
  eq(mr.formatDeadlineLabel(new Date('2026-10-20T14:30:00Z'), 'America/New_York'), 'Tue, Oct 20, 10:30 AM EDT', 'deadline label in the business time zone');

  if (!PG_URL) {
    console.log('\n⏭  DB sections skipped: set MR_TEST_PG_URL (localhost) to run them');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
  if (!isLocal(PG_URL) || (BASE && !isLocal(BASE))) throw new Error('refusing to run: localhost only');

  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `mr${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users = [id('owner'), id('client'), id('photog')];
  const bizId = id('biz');
  const photogId = id('ph');
  const svcId = id('svc');
  const dayOffset = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  try {
    await q(`INSERT INTO users (id, username, email, name, is_vendor) VALUES ($1::varchar, $1::text, $2, 'Owner', true)`, [users[0], `${users[0]}@mr.test`]);
    await q(`INSERT INTO users (id, username, email, name) VALUES ($1::varchar, $1::text, $2, 'Casey Client')`, [users[1], `${users[1]}@mr.test`]);
    await q(`INSERT INTO users (id, username, email, name, is_photographer) VALUES ($1::varchar, $1::text, $2, 'Pat Photog', true)`, [users[2], `${users[2]}@mr.test`]);

    if (BASE) {
      // ── HTTP: POST /api/me/time-zone ──
      process.env.JWT_SECRET = process.env.JWT_SECRET || 'ab-test-jwt-secret';
      const { generateAccessToken } = await import('./auth');
      await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'MR Biz', 'beauty', 'approved')`, [bizId, users[0]]);
      const token = generateAccessToken({ userId: users[0], isVendor: true, isAdmin: false });
      const tz = async () => (await q(`SELECT time_zone FROM businesses WHERE id = $1`, [bizId]))[0]?.time_zone ?? null;
      console.log('POST /api/me/time-zone');
      eq((await call('POST', '/api/me/time-zone', { body: { timeZone: 'America/Chicago' } })).status, 401, 'needs sign-in');
      eq((await call('POST', '/api/me/time-zone', { token, body: { timeZone: 'Mars/Base' } })).status, 400, 'rejects a zone that does not exist');
      let r = await call('POST', '/api/me/time-zone', { token, body: { timeZone: 'America/Chicago' } });
      eq([r.status, r.body?.businessesUpdated, await tz()], [200, 1, 'America/Chicago'], 'fills an empty zone');
      r = await call('POST', '/api/me/time-zone', { token, body: { timeZone: 'Europe/London' } });
      eq([r.status, r.body?.businessesUpdated, await tz()], [200, 0, 'America/Chicago'], 'without overwrite, an existing zone is kept (travel never moves deadlines)');
      r = await call('POST', '/api/me/time-zone', { token, body: { timeZone: 'America/Los_Angeles', overwrite: true } });
      eq([r.status, r.body?.businessesUpdated, await tz()], [200, 1, 'America/Los_Angeles'], 'overwrite (settings) changes it');
    } else {
    // ── Job sections (in-process, Stripe controlled here) ──
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, auto_accept_bookings, time_zone) VALUES ($1, $2, 'MR Biz', 'beauty', 'approved', false, 'America/Los_Angeles')`, [bizId, users[0]]);
    const allDays = JSON.stringify(Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map((d) => [d, { open: '08:00', close: '20:00' }])));
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, hours_of_operation, stripe_account_id, stripe_onboarding_complete, is_demo, auto_accept_bookings, visibility_status, created_at, updated_at)
             VALUES ($1, $2, 'MR Photog', 10000, 'Austin', 'TX', $3::jsonb, $4, true, false, false, 'public', now(), now())`, [photogId, users[2], allDays, `acct_${P}`]);
    await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at)
             VALUES ($1, $2, 'MR Shoot', 7000, 60, true, 'live', 'package', false, now())`, [svcId, photogId]);

    const piStore: Record<string, any> = {};
    const failCancel = new Set<string>();
    const cancelled: string[] = [];
    const pi = (status: string, extra: Record<string, any> = {}) => {
      const p = `pi_mr_${Math.random().toString(36).slice(2, 10)}`;
      piStore[p] = { id: p, status, capture_method: 'manual', amount: 5400, latest_charge: status === 'requires_capture' ? `ch_${p}` : null, ...extra };
      return p;
    };
    const notices = { newRequest: [] as string[], reminder: [] as string[], expired: [] as string[] };
    const real = await mr.manualRequestDefaultDeps();
    const deps = {
      ...real,
      getPaymentIntent: async (p: string) => { if (!piStore[p]) throw new Error('no such payment_intent'); return { ...piStore[p] }; },
      cancelPaymentIntent: async (p: string) => { if (failCancel.has(p)) throw new Error('stripe down'); cancelled.push(p); piStore[p].status = 'canceled'; return piStore[p]; },
      releasePhotographerSlot: async (sid: string) => q(`DELETE FROM photographer_availability WHERE shoot_booking_id = $1`, [sid]),
      notify: {
        newRequest: async (r: any) => { notices.newRequest.push(r.id); },
        reminder: async (r: any) => { notices.reminder.push(r.id); },
        expired: async (r: any) => { notices.expired.push(r.id); },
      },
    };
    const count = (list: string[], k: string) => list.filter((x) => x === id(k)).length;
    const st = async (k: string) => (await q(`SELECT status FROM appointments WHERE id = $1`, [id(k)]))[0]?.status;
    let slotMinute = 0;
    const mkAppt = async (k: string, o: { status: string; pi: string | null; date?: string; time?: string; age?: string; since?: string; deadline?: string | null; capture?: string }) => {
      const time = o.time ?? `${String(8 + Math.floor(slotMinute / 60)).padStart(2, '0')}:${String(slotMinute++ % 60).padStart(2, '0')}`;
      await q(`INSERT INTO appointments (id, business_id, client_id, appointment_date, appointment_time, total_price, service_name, status, stripe_payment_intent_id, capture_method,
                 created_at, updated_at, state_changed_at, pending_provider_expires_at)
               VALUES ($1, $2, $3, $4, $5, 5000, 'Silk press', $6, $7, $8, ${o.age ?? 'now()'}, ${o.age ?? 'now()'}, ${o.since ?? 'now()'}, ${o.deadline ?? 'NULL'})`,
        [id(k), bizId, users[1], o.date ?? dayOffset(5), time, o.status, o.pi, o.capture ?? 'manual']);
    };
    const twoMinAgo = `now() - interval '2 minutes'`;

    // ── 1. Paid checkout → request ──
    console.log('A paid checkout becomes a request (job path)');
    const tomorrow = dayOffset(1);
    await mkAppt('paid', { status: 'pending_payment', pi: pi('requires_capture'), date: tomorrow, time: '10:00', age: twoMinAgo });
    await mkAppt('unpaid', { status: 'pending_payment', pi: pi('requires_payment_method'), age: twoMinAgo });
    await mkAppt('young', { status: 'pending_payment', pi: pi('requires_capture') });
    await mkAppt('auto', { status: 'pending_payment', pi: pi('requires_capture', { capture_method: 'automatic' }), capture: 'automatic', age: twoMinAgo });
    await mr.runManualRequestJob(new Date(), deps as any);
    eq(await st('paid'), 'pending_provider', 'card on hold → pending_provider');
    // pending_provider_expires_at is timestamp without time zone holding UTC: epoch reads it as UTC.
    const [paidRow] = await q(`SELECT extract(epoch FROM pending_provider_expires_at)::float8 AS e FROM appointments WHERE id = $1`, [id('paid')]);
    const laStart = mr.wallClockToUtc(tomorrow, '10:00', 'America/Los_Angeles')!;
    eq(Math.abs(Number(paidRow.e) * 1000 - laStart.getTime()) < 1000, true,
      'deadline = appointment start in the business time zone (Los Angeles), since it is under 48h away');
    eq(count(notices.newRequest, 'paid'), 1, 'business and customer told once');
    eq([await st('unpaid'), await st('young'), await st('auto')], ['pending_payment', 'pending_payment', 'pending_payment'], 'unpaid, too new, and automatic-capture checkouts are left alone');
    eq(notices.newRequest.length, 1, 'nobody else was told anything');
    await mr.runManualRequestJob(new Date(), deps as any);
    eq(count(notices.newRequest, 'paid'), 1, 'second run sends nothing more');

    console.log('Webhook first, then the job');
    await mkAppt('hook', { status: 'pending_payment', pi: pi('requires_capture'), age: twoMinAgo });
    const hookPi = (await q(`SELECT stripe_payment_intent_id AS p FROM appointments WHERE id = $1`, [id('hook')]))[0].p;
    eq(await mr.promoteAuthorizedRequest('appointment', id('hook'), piStore[hookPi], 'webhook', deps as any), 'promoted', 'webhook promotes it');
    eq(await mr.promoteAuthorizedRequest('appointment', id('hook'), piStore[hookPi], 'webhook', deps as any), 'not_pending_payment', 'duplicate webhook does nothing');
    await mr.runManualRequestJob(new Date(), deps as any);
    eq(count(notices.newRequest, 'hook'), 1, 'told exactly once across webhook, duplicate webhook and job');
    eq(await mr.promoteAuthorizedRequest('appointment', id('hook'), { id: 'x', amount_capturable: 5400 }, 'webhook', deps as any), 'not_pending_payment',
      'an event without status still counts as a card hold (amount waiting to be captured)');
    const audit = await q(`SELECT from_state, to_state, trigger_source FROM booking_audit_log WHERE booking_id = $1 ORDER BY created_at`, [id('hook')]);
    eq(audit.map((a) => [a.from_state, a.to_state, a.trigger_source]), [['pending_payment', 'pending_provider', 'webhook']], 'one transition, through the state machine');

    // ── 2. Reminder ──
    console.log('Reminder');
    await mkAppt('remind', { status: 'pending_provider', pi: pi('requires_capture'), since: `now() - interval '30 hours'`, deadline: `now() + interval '18 hours'` });
    await mkAppt('remind-short', { status: 'pending_provider', pi: pi('requires_capture'), since: `now() - interval '3 hours'`, deadline: `now() + interval '1 hour'` });
    await mkAppt('remind-early', { status: 'pending_provider', pi: pi('requires_capture'), since: `now() - interval '1 hour'`, deadline: `now() + interval '47 hours'` });
    await mkAppt('remind-ghost', { status: 'pending_provider', pi: pi('requires_payment_method'), since: `now() - interval '30 hours'`, deadline: `now() + interval '18 hours'` });
    await mr.runManualRequestJob(new Date(), deps as any);
    eq([count(notices.reminder, 'remind'), count(notices.reminder, 'remind-short'), count(notices.reminder, 'remind-early'), count(notices.reminder, 'remind-ghost')], [1, 1, 0, 0],
      'due reminders go (24h before; halfway on a short window); not yet due and never-paid requests get none');
    const [rr] = await q(`SELECT provider_reminder_sent_at AS s, status FROM appointments WHERE id = $1`, [id('remind')]);
    eq([!!rr.s, rr.status], [true, 'pending_provider'], 'reminder recorded, request still open');
    await mr.runManualRequestJob(new Date(), deps as any);
    eq([count(notices.reminder, 'remind'), count(notices.reminder, 'remind-short')], [1, 1], 'reminder is never sent twice');

    // ── 3. Expiry ──
    console.log('Expiry');
    const past = `now() - interval '1 minute'`;
    const mk = async (k: string, p: string | null) => mkAppt(k, { status: 'pending_provider', pi: p, since: `now() - interval '48 hours'`, deadline: past });
    const piHeld = pi('requires_capture'); await mk('exp-held', piHeld);
    const piDown = pi('requires_capture'); failCancel.add(piDown); await mk('exp-stripedown', piDown);
    const piTaken = pi('succeeded'); await mk('exp-taken', piTaken);
    const piGhost = pi('requires_payment_method'); await mk('exp-ghost', piGhost);
    await mk('exp-nopi', null);
    await mk('exp-released', pi('canceled', { latest_charge: 'ch_x' }));
    await mk('exp-never', pi('canceled', { latest_charge: null }));
    await mr.runManualRequestJob(new Date(), deps as any);
    eq([await st('exp-held'), piStore[piHeld].status, count(notices.expired, 'exp-held')], ['expired', 'canceled', 1], 'card on hold → hold released, expired, both sides told');
    eq([await st('exp-stripedown'), count(notices.expired, 'exp-stripedown')], ['pending_provider', 0], 'Stripe could not release the hold → nothing changes, nobody told yet');
    eq([await st('exp-taken'), piStore[piTaken].status, cancelled.includes(piTaken)], ['pending_provider', 'succeeded', false], 'money already taken → never expired or touched (flagged in logs)');
    eq([await st('exp-ghost'), piStore[piGhost].status, count(notices.expired, 'exp-ghost')], ['expired', 'canceled', 0], 'old request never paid → ended quietly');
    eq([await st('exp-nopi'), count(notices.expired, 'exp-nopi')], ['expired', 0], 'no PaymentIntent → ended quietly');
    eq([await st('exp-released'), count(notices.expired, 'exp-released')], ['expired', 1], 'hold released earlier (crash mid-way) → expired and told');
    eq([await st('exp-never'), count(notices.expired, 'exp-never')], ['expired', 0], 'canceled and never paid → quiet');
    const expAudit = await q(`SELECT to_state, trigger_source FROM booking_audit_log WHERE booking_id = $1`, [id('exp-held')]);
    eq(expAudit.map((a) => [a.to_state, a.trigger_source]), [['expired', 'cron']], 'expiry goes through the state machine');

    failCancel.delete(piDown);
    await mr.runManualRequestJob(new Date(), deps as any);
    eq([await st('exp-stripedown'), piStore[piDown].status, count(notices.expired, 'exp-stripedown')], ['expired', 'canceled', 1], 'next run: hold released, expired, told once');
    eq(count(notices.expired, 'exp-held'), 1, 'no duplicate notice on a later run');

    console.log('Shoot request expiry frees the slot');
    const piShoot = pi('requires_capture');
    await q(`INSERT INTO shoot_bookings (id, duration_hours, shoot_type, photographer_id, client_id, service_id, date, start_time, end_time, total_price, status, stripe_payment_intent_id, capture_method, state_changed_at, pending_provider_expires_at, created_at, updated_at)
             VALUES ($1, 1, 'portrait', $2, $3, $4, $5, '17:00', '18:00', 7000, 'pending_provider', $6, 'manual', now() - interval '48 hours', ${past}, now() - interval '48 hours', now() - interval '48 hours')`,
      [id('s1'), photogId, users[1], svcId, dayOffset(3), piShoot]);
    await q(`INSERT INTO photographer_availability (photographer_id, date, start_time, end_time, slot_type, shoot_booking_id) VALUES ($1, $2, '17:00', '18:00', 'booked', $3)`, [photogId, dayOffset(3), id('s1')]);
    await mr.runManualRequestJob(new Date(), deps as any);
    const [s1] = await q(`SELECT status FROM shoot_bookings WHERE id = $1`, [id('s1')]);
    const slot = await q(`SELECT 1 FROM photographer_availability WHERE shoot_booking_id = $1`, [id('s1')]);
    eq([s1.status, slot.length, piStore[piShoot].status, count(notices.expired, 's1')], ['expired', 0, 'canceled', 1], 'shoot: expired, slot freed, hold released, both sides told');

    console.log('No silent expiry in the state machine');
    const { transitionAppointmentState } = await import('./bookingStateMachine');
    const { BOOKING_STATES } = await import('@shared/schema');
    await mk('lazy', pi('requires_capture'));
    const lr = await transitionAppointmentState(id('lazy'), BOOKING_STATES.CONFIRMED, { triggeredBy: 'test', triggerSource: 'api' });
    eq([lr.success, lr.code, await st('lazy')], [false, 'PENDING_PROVIDER_EXPIRED', 'pending_provider'], 'accepting a past-due request is refused and the row is left for the job');
    const le = await transitionAppointmentState(id('lazy'), BOOKING_STATES.EXPIRED, { triggeredBy: 'test', triggerSource: 'cron' });
    eq([le.success, await st('lazy')], [true, 'expired'], 'expiring it is still allowed');
    }
  } finally {
    const apptIds = (await q(`SELECT id FROM appointments WHERE business_id = $1`, [bizId])).map((r) => r.id);
    const shootIds = (await q(`SELECT id FROM shoot_bookings WHERE photographer_id = $1`, [photogId])).map((r) => r.id);
    await q(`DELETE FROM booking_audit_log WHERE booking_id = ANY($1)`, [[...apptIds, ...shootIds]]).catch(() => {});
    await q(`DELETE FROM photographer_availability WHERE photographer_id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM shoot_bookings WHERE photographer_id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM appointments WHERE business_id = $1`, [bizId]).catch(() => {});
    await q(`DELETE FROM photographer_services WHERE id = $1`, [svcId]).catch(() => {});
    await q(`DELETE FROM photographers WHERE id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = $1`, [bizId]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
