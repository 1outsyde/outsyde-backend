/**
 * Subscription webhooks across Stripe API versions (step 1.0). Run with:
 *   LIFECYCLE_LOCAL_PG=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   STRIPE_SECRET_KEY=sk_test_stub STRIPE_PUBLISHABLE_KEY=pk_test_stub STRIPE_STUB_PORT=5098 \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" \
 *   npx tsx server/subscriptionLifecycle.test.ts
 * with `node .dev/neon-local-proxy.mjs` running against the same local database.
 *
 * SCRATCH ONLY: a LOCAL Postgres (full schema) and the in-process Stripe stub below; nothing reaches
 * Neon or Stripe. Skips when LIFECYCLE_LOCAL_PG is unset; refuses any non-local database.
 *
 * Covers: the live endpoint's basil payloads (period on items, invoice.parent), the SDK's clover
 * retrieve shape, older payloads, payloads with no period at all, one-off invoices, and replays.
 */
import http from 'node:http';
import pg from 'pg';
import { getSubscriptionPeriod, getInvoiceSubscriptionId } from './stripe/subscriptionFields';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const iso = (unix: number) => new Date(unix * 1000).toISOString();

// Fixed instants (seconds). P1 = an older period, P2 = the renewed period.
const P1_START = 1757980800; // 2025-09-16T00:00:00Z
const P1_END = 1760572800;   // 2025-10-16T00:00:00Z
const P2_START = 1760572800; // 2025-10-16T00:00:00Z
const P2_END = 1763251200;   // 2025-11-16T00:00:00Z

function unitTests() {
  console.log('\nHelpers');
  const basilSub = { id: 'sub_x', status: 'active', items: { data: [{ id: 'si_1', current_period_start: P2_START, current_period_end: P2_END, price: { id: 'price_gf' } }] } };
  const p = getSubscriptionPeriod(basilSub);
  assert(!!p && p.start.toISOString() === iso(P2_START) && p.end.toISOString() === iso(P2_END), 'basil/clover subscription: period read from items');

  const legacySub = { id: 'sub_x', current_period_start: P1_START, current_period_end: P1_END, items: { data: [{ id: 'si_1' }] } };
  const lp = getSubscriptionPeriod(legacySub);
  assert(!!lp && lp.start.toISOString() === iso(P1_START) && lp.end.toISOString() === iso(P1_END), 'older subscription: period read from top-level fields');

  const both = { ...legacySub, items: { data: [{ id: 'si_1', current_period_start: P2_START, current_period_end: P2_END }] } };
  const bp = getSubscriptionPeriod(both);
  assert(!!bp && bp.end.toISOString() === iso(P2_END), 'items period wins when both are present');

  assert(getSubscriptionPeriod({ id: 'sub_x', items: { data: [] } }) === null, 'no period anywhere: null (no Invalid Date)');
  assert(getSubscriptionPeriod({ id: 'sub_x', current_period_start: 0, current_period_end: 'x' }) === null, 'unusable values: null');
  assert(getSubscriptionPeriod(null) === null && getSubscriptionPeriod(undefined) === null, 'null/undefined subscription: null');

  assert(getInvoiceSubscriptionId({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_basil' } } }) === 'sub_basil', 'basil invoice: id from parent.subscription_details');
  assert(getInvoiceSubscriptionId({ parent: { subscription_details: { subscription: { id: 'sub_exp' } } } }) === 'sub_exp', 'expanded parent subscription object: id read');
  assert(getInvoiceSubscriptionId({ subscription: 'sub_legacy' }) === 'sub_legacy', 'older invoice: id from invoice.subscription');
  assert(getInvoiceSubscriptionId({ lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_line' } } }] } }) === 'sub_line', 'id from a line item when the invoice has no parent');
  assert(getInvoiceSubscriptionId({ parent: null, lines: { data: [] } }) === null, 'one-off invoice: null');
  assert(getInvoiceSubscriptionId(null) === null, 'null invoice: null');
}

(async () => {
  unitTests();

  const PG = process.env.LIFECYCLE_LOCAL_PG;
  const STUB_PORT = Number(process.env.STRIPE_STUB_PORT || 0);
  if (!PG) {
    console.log('\n⏭  DB tests skipped: set LIFECYCLE_LOCAL_PG');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
  if (!['localhost', '127.0.0.1'].includes(new URL(PG).hostname) || !STUB_PORT) throw new Error('refusing: local DB and STRIPE_STUB_PORT required');
  if (!process.env.DATABASE_URL || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('refusing: DATABASE_URL must be local');

  // ── Stripe stub: GET /v1/subscriptions/:id returns the clover shape (period on items only) ──
  const stubSubs: Record<string, any> = {};
  const stubCalls: string[] = [];
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = (req.url || '').split('?')[0];
      stubCalls.push(`${req.method} ${url}`);
      const m = url.match(/^\/v1\/subscriptions\/([^/]+)$/);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && m && stubSubs[m[1]]) { res.writeHead(200); res.end(JSON.stringify(stubSubs[m[1]])); return; }
      res.writeHead(404); res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such subscription' } }));
    });
  });
  await new Promise<void>(r => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  const db = new pg.Client({ connectionString: PG });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const { WebhookHandlers } = await import('./stripe/webhookHandlers');

  const P = `sl${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`.slice(0, 36);
  const GF_PRICE = `price_${P}_gf`;
  const GR_PRICE = `price_${P}_gr`;
  const tierGf = id('t-gf');
  const tierGr = id('t-gr');
  const createdUsers: string[] = [];
  const createdBiz: string[] = [];

  try {
    await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps, stripe_price_id, sort_order, max_staff)
             VALUES ($1, $2, 'Test Grandfathered', 4099, 800, $3, -1, 8), ($4, $5, 'Test Growth', 5900, 800, $6, 1, 8)`,
      [tierGf, `${P}-gf`, GF_PRICE, tierGr, `${P}-gr`, GR_PRICE]);

    async function seed(key: string, opts: { status?: string; subId: string; periodEnd?: string; tierId?: string; liveItems?: number }) {
      const u = id(`u-${key}`), b = id(`b-${key}`), v = id(`v-${key}`);
      await q(`INSERT INTO users (id, username, email, password, is_vendor, first_name) VALUES ($1::varchar, $1::text, $2, 'x', true, 'T')`, [u, `${u}@sl.test`]);
      await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, subscription_active) VALUES ($1::varchar, $2, $1::text, 'beauty', 'approved', true)`, [b, u]);
      await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, stripe_subscription_id, stripe_customer_id, status, current_period_start, current_period_end, updated_at)
               VALUES ($1, $2, $3, $4, $5, 'cus_test', $6, $7, $8, now() - interval '30 days')`,
        [v, u, b, opts.tierId ?? tierGf, opts.subId, opts.status ?? 'active', iso(P1_START), opts.periodEnd ?? iso(P1_END)]);
      for (let i = 0; i < (opts.liveItems ?? 0); i++) {
        await q(`INSERT INTO vendor_services (id, business_id, vendor_id, name, price, duration_minutes, status, is_active) VALUES ($1, $2, $3, 'svc', 1000, 30, 'live', true)`, [id(`s-${key}-${i}`), b, u]).catch(async () => {
          await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, status, is_active) VALUES ($1, $2, 'svc', 1000, 30, 'live', true)`, [id(`s-${key}-${i}`), b]);
        });
      }
      createdUsers.push(u); createdBiz.push(b);
      return { u, b, v };
    }
    const row = async (v: string) => (await q(`SELECT status, tier_id, to_char(current_period_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS') AS ps, to_char(current_period_end,'YYYY-MM-DD"T"HH24:MI:SS') AS pe FROM vendor_subscriptions WHERE id = $1`, [v]))[0];
    const stamp = (unix: number) => iso(unix).slice(0, 19);
    const basilSub = (subId: string, status: string, price: string, start: number, end: number) =>
      ({ id: subId, object: 'subscription', status, metadata: {}, cancel_at_period_end: false, items: { object: 'list', data: [{ id: `si_${subId}`, current_period_start: start, current_period_end: end, price: { id: price } }] } });

    // ── customer.subscription.updated ──
    console.log('\ncustomer.subscription.updated');
    {
      const s = await seed('upd-basil', { subId: `sub_${P}_a` });
      let threw: unknown = null;
      try { await WebhookHandlers.handleSubscriptionChange(basilSub(`sub_${P}_a`, 'active', GF_PRICE, P2_START, P2_END)); } catch (e) { threw = e; }
      assert(threw === null, 'basil payload (period only on items) does not throw', String(threw));
      const r = await row(s.v);
      assert(r.ps === stamp(P2_START) && r.pe === stamp(P2_END), 'basil payload: period saved from items', r);
      assert(r.status === 'active' && r.tier_id === tierGf, 'basil payload: status and tier kept', r);
    }
    {
      const s = await seed('upd-legacy', { subId: `sub_${P}_b` });
      await WebhookHandlers.handleSubscriptionChange({ id: `sub_${P}_b`, status: 'active', current_period_start: P2_START, current_period_end: P2_END, items: { data: [{ id: 'si_b', price: { id: GF_PRICE } }] } });
      const r = await row(s.v);
      assert(r.pe === stamp(P2_END), 'older payload (top-level period) still saved', r);
    }
    {
      const s = await seed('upd-noperiod', { subId: `sub_${P}_c` });
      let threw: unknown = null;
      try { await WebhookHandlers.handleSubscriptionChange({ id: `sub_${P}_c`, status: 'past_due', items: { data: [{ id: 'si_c', price: { id: GF_PRICE } }] } }); } catch (e) { threw = e; }
      const r = await row(s.v);
      assert(threw === null, 'payload with no period at all does not throw', String(threw));
      assert(r.status === 'past_due' && r.pe === stamp(P1_END), 'no period: status saved, stored period left as is', r);
    }
    {
      const s = await seed('upd-tier', { subId: `sub_${P}_d` });
      await WebhookHandlers.handleSubscriptionChange(basilSub(`sub_${P}_d`, 'active', GR_PRICE, P2_START, P2_END));
      const r = await row(s.v);
      assert(r.tier_id === tierGr && r.pe === stamp(P2_END), 'basil payload with a new price: tier switched and period saved', r);
    }
    {
      // Replay: the same canceled-and-ended event twice. Pause runs once; the row ends the same.
      const s = await seed('upd-replay', { subId: `sub_${P}_e`, liveItems: 2 });
      const ev = basilSub(`sub_${P}_e`, 'canceled', GF_PRICE, P1_START - 2592000, P1_START);
      await WebhookHandlers.handleSubscriptionChange(ev);
      const r1 = await row(s.v);
      await WebhookHandlers.handleSubscriptionChange(ev);
      const r2 = await row(s.v);
      const audits = await q(`SELECT count(*)::int AS n FROM audit_logs WHERE target_id = $1 AND action = 'items_auto_paused'`, [s.b]);
      assert(JSON.stringify(r1) === JSON.stringify(r2), 'replayed event leaves the row unchanged', { r1, r2 });
      assert(audits[0].n === 1, 'replayed event pauses once (one items_auto_paused audit)', audits[0]);
      assert(r2.pe === stamp(P1_START), 'canceled event: period end saved from items, so the ended period is respected', r2);
    }
    {
      // An unknown subscription (no row) is ignored without error.
      let threw: unknown = null;
      try { await WebhookHandlers.handleSubscriptionChange(basilSub(`sub_${P}_unknown`, 'active', GF_PRICE, P2_START, P2_END)); } catch (e) { threw = e; }
      assert(threw === null, 'subscription with no row: ignored, no throw', String(threw));
    }

    // ── invoice.paid ──
    console.log('\ninvoice.paid');
    {
      const subId = `sub_${P}_f`;
      const s = await seed('inv-basil', { subId });
      stubSubs[subId] = basilSub(subId, 'active', GF_PRICE, P2_START, P2_END);
      const before = stubCalls.length;
      await WebhookHandlers.handleInvoicePaid({ id: 'in_f', object: 'invoice', parent: { type: 'subscription_details', subscription_details: { subscription: subId, metadata: {} } }, lines: { data: [] } });
      const r = await row(s.v);
      assert(stubCalls.slice(before).includes(`GET /v1/subscriptions/${subId}`), 'basil invoice: subscription looked up in Stripe', stubCalls.slice(before));
      assert(r.ps === stamp(P2_START) && r.pe === stamp(P2_END), 'basil invoice + clover retrieve: renewed period saved', r);
      assert(r.status === 'active', 'basil invoice: status active', r);
      const biz = (await q(`SELECT subscription_active FROM businesses WHERE id = $1`, [s.b]))[0];
      assert(biz.subscription_active === true, 'basil invoice: businesses.subscription_active true', biz);

      // Replay the same invoice.
      await WebhookHandlers.handleInvoicePaid({ id: 'in_f', object: 'invoice', parent: { type: 'subscription_details', subscription_details: { subscription: subId } } });
      const r2 = await row(s.v);
      assert(JSON.stringify(r) === JSON.stringify(r2), 'replayed invoice leaves the row unchanged', { r, r2 });
    }
    {
      const subId = `sub_${P}_g`;
      const s = await seed('inv-legacy', { subId });
      stubSubs[subId] = basilSub(subId, 'active', GF_PRICE, P2_START, P2_END);
      await WebhookHandlers.handleInvoicePaid({ id: 'in_g', subscription: subId });
      const r = await row(s.v);
      assert(r.pe === stamp(P2_END), 'older invoice (invoice.subscription) still handled', r);
    }
    {
      const subId = `sub_${P}_h`;
      const s = await seed('inv-noperiod', { subId });
      stubSubs[subId] = { id: subId, status: 'active', items: { data: [{ id: 'si_h', price: { id: GF_PRICE } }] } };
      let threw: unknown = null;
      try { await WebhookHandlers.handleInvoicePaid({ id: 'in_h', parent: { subscription_details: { subscription: subId } } }); } catch (e) { threw = e; }
      const r = await row(s.v);
      assert(threw === null && r.status === 'active' && r.pe === stamp(P1_END), 'retrieved subscription with no period: status saved, period left as is', r);
    }
    {
      // One-off invoice: nothing is looked up or written.
      const before = stubCalls.length;
      await WebhookHandlers.handleInvoicePaid({ id: 'in_oneoff', parent: null, lines: { data: [] } });
      assert(stubCalls.length === before, 'one-off invoice: no Stripe call, ignored');
    }

    // ── dispatch through handleEvent (what the live webhook calls) ──
    console.log('\nhandleEvent');
    {
      const subId = `sub_${P}_i`;
      const s = await seed('evt', { subId });
      stubSubs[subId] = basilSub(subId, 'active', GF_PRICE, P2_START, P2_END);
      await WebhookHandlers.handleEvent({ type: 'invoice.paid', data: { object: { id: 'in_i', parent: { subscription_details: { subscription: subId } } } } });
      const r = await row(s.v);
      assert(r.pe === stamp(P2_END), 'invoice.paid (basil) through handleEvent: period renewed', r);

      const s2 = await seed('evt2', { subId: `sub_${P}_j` });
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.updated', data: { object: basilSub(`sub_${P}_j`, 'active', GF_PRICE, P2_START, P2_END) } });
      const r2 = await row(s2.v);
      assert(r2.pe === stamp(P2_END), 'customer.subscription.updated (basil) through handleEvent: period saved', r2);
    }
  } finally {
    // Clean up everything this run created.
    for (const b of createdBiz) {
      await q(`DELETE FROM audit_logs WHERE target_id = $1`, [b]).catch(() => {});
      await q(`DELETE FROM vendor_services WHERE business_id = $1`, [b]).catch(() => {});
      const vs = await q(`SELECT id FROM vendor_subscriptions WHERE business_id = $1`, [b]).catch(() => [] as any[]);
      for (const v of vs) {
        await q(`DELETE FROM benefit_allowances WHERE subscription_id = $1`, [v.id]).catch(() => {});
        await q(`DELETE FROM audit_logs WHERE target_id = $1`, [v.id]).catch(() => {});
      }
      await q(`DELETE FROM vendor_subscriptions WHERE business_id = $1`, [b]).catch(() => {});
      await q(`DELETE FROM businesses WHERE id = $1`, [b]).catch(() => {});
    }
    for (const u of createdUsers) {
      await q(`DELETE FROM notifications WHERE user_id = $1`, [u]).catch(() => {});
      await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => {});
    }
    await q(`DELETE FROM subscription_tiers WHERE id IN ($1, $2)`, [tierGf, tierGr]).catch(() => {});
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
