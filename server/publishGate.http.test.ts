/**
 * R34: an edit can't put a service or product live without the Publish checks — HTTP integration tests.
 *
 * Before the fix, PATCH /api/vendor/services/:id and PATCH /api/vendor/products/:id saved any `status`, so
 * `{ status: "live" }` made an item live without the three checks POST /:id/go-live makes: business approved,
 * Stripe Connect finished, active plan (vault R34, found 2026-10-23, confirmed 2026-11-03 @ e78b8b8).
 *
 * Legend 2026-11-03: services and products in one PR (A1); re-publishing an item that already has a Stripe
 * product runs the checks only, no Stripe call (B1); an edit to live on an item never published is treated as
 * Publish, checks then the Stripe product (C1); items already live are left as they are (D1). Only a move INTO
 * live from another status is checked. Live edits, unpublish (draft), pause and archive are unchanged.
 *
 * Request bodies used here are the ones the clients send today:
 *   vendor sites re-publish   { status: 'live', isActive: true }   (Nail Sniper, BWL, Lana, Royal Elite, Lotus, Dia Lux)
 *   vendor sites unpublish    { status: 'draft', isActive: false } (products: Nail Sniper, BWL, Lana, Lotus)
 *   app edits                 no status key (OutsydeCapture api.ts deletes it)
 *
 * Run with: npx tsx server/publishGate.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres with a Stripe stub:
 *   PUB_TEST_BASE_URL      e.g. http://localhost:5062   (must be localhost)
 *   PUB_TEST_PG_URL        the SAME scratch database (localhost only; seeds + cleans up)
 *   PUB_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                          STRIPE_STUB_PORT=<same> and
 *                          NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET             identical to the server's
 * Skips (exit 0) when PUB_TEST_BASE_URL is unset; refuses any non-local host.
 */

import http from 'http';

const BASE = process.env.PUB_TEST_BASE_URL;
const PG_URL = process.env.PUB_TEST_PG_URL;
const STUB_PORT = Number(process.env.PUB_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.99.34.${Math.floor(Math.random() * 200) + 1}` };
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
  if (!BASE) {
    console.log('⏭  skipped: set PUB_TEST_BASE_URL (+ PUB_TEST_PG_URL, PUB_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, PUB_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'pub-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub: counts every call, answers the catalog + account calls the Publish path makes ──────────
  const calls: string[] = [];
  let seq = 0;
  const prices: Record<string, number> = {};
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const url = (req.url || '').split('?')[0];
      calls.push(`${req.method} ${url}`);
      const form = new URLSearchParams(raw);
      const acctM = url.match(/^\/v1\/accounts\/([^/]+)$/);
      if (req.method === 'GET' && acctM) {
        // Every stub account reads as not finished: only the DB flag can make Connect "done" here.
        return send(200, { id: acctM[1], object: 'account', charges_enabled: false, details_submitted: false, payouts_enabled: false, requirements: { currently_due: ['x'] } });
      }
      if (req.method === 'POST' && url === '/v1/products') return send(200, { id: `prod_pub_${++seq}`, object: 'product', active: true });
      if (req.method === 'POST' && url.startsWith('/v1/products/')) return send(200, { id: url.split('/')[3], object: 'product', active: true });
      if (req.method === 'POST' && url === '/v1/prices') {
        const pid = `price_pub_${++seq}`;
        prices[pid] = Number(form.get('unit_amount') || 0);
        return send(200, { id: pid, object: 'price', unit_amount: prices[pid], active: true });
      }
      const priceM = url.match(/^\/v1\/prices\/([^/]+)$/);
      if (priceM) return send(200, { id: priceM[1], object: 'price', unit_amount: prices[priceM[1]] ?? 7000, active: true });
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ─────────────────────────────────────────────────────────────────────────────────────────────────
  const P = `pub${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  let tierId: string | null = null;
  let createdTier = false;

  const [tier] = await q(`SELECT id FROM subscription_tiers ORDER BY created_at LIMIT 1`);
  if (tier) tierId = tier.id;
  else {
    tierId = id('tier');
    createdTier = true;
    await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps) VALUES ($1, $1, 'Test tier', 2900, 500)`, [tierId]);
  }

  type BizOpts = { approval?: string; connect?: boolean; plan?: 'active' | 'none' | 'lapsed' };
  const mkBiz = async (key: string, o: BizOpts = {}) => {
    const uid = id(`u-${key}`);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, true)`, [uid, `${uid}@pub.test`]);
    users.push(uid);
    const bid = id(`b-${key}`);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete, has_services, has_products)
             VALUES ($1, $2, $3, 'beauty', $4, $5, $6, true, true)`,
      [bid, uid, `Biz ${key}`, o.approval ?? 'approved', `acct_${bid.replace(/-/g, '')}`, o.connect ?? true]);
    bizs.push(bid);
    const plan = o.plan ?? 'active';
    if (plan !== 'none') {
      await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, stripe_subscription_id, past_due_since, current_period_end)
               VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 days')`,
        [id(`sub-${key}`), uid, bid, tierId, plan === 'lapsed' ? 'past_due' : 'active', `sub_pub_${key}`,
         plan === 'lapsed' ? new Date(Date.now() - 10 * 86400000).toISOString() : null]);
    }
    return { bid, token: generateAccessToken({ userId: uid, isVendor: true, isAdmin: false }) };
  };
  type ItemOpts = { status?: string; isActive?: boolean; product?: boolean; price?: boolean };
  const mkSvc = async (key: string, bid: string, o: ItemOpts = {}) => {
    const sid = id(`s-${key}`);
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status, stripe_product_id, stripe_price_id) VALUES ($1, $2, $3, 7000, 30, $4, $5, $6, $7)`,
      [sid, bid, `Svc ${key}`, o.isActive ?? true, o.status ?? 'draft', o.product ? `prod_seed_${sid}` : null, o.product && o.price !== false ? `price_seed_${sid}` : null]);
    return sid;
  };
  const mkProd = async (key: string, bid: string, o: ItemOpts = {}) => {
    const pid = id(`p-${key}`);
    await q(`INSERT INTO vendor_products (id, business_id, name, price, is_active, status, stripe_product_id, stripe_price_id) VALUES ($1, $2, $3, 7000, $4, $5, $6, $7)`,
      [pid, bid, `Prod ${key}`, o.isActive ?? true, o.status ?? 'draft', o.product ? `prod_seed_${pid}` : null, o.product && o.price !== false ? `price_seed_${pid}` : null]);
    return pid;
  };
  const svcRow = async (sid: string) => (await q(`SELECT status, is_active, stripe_product_id, stripe_price_id, name FROM vendor_services WHERE id = $1`, [sid]))[0];
  const prodRow = async (pid: string) => (await q(`SELECT status, is_active, stripe_product_id, stripe_price_id, name FROM vendor_products WHERE id = $1`, [pid]))[0];

  const ready = await mkBiz('ready');
  const notApproved = await mkBiz('pending', { approval: 'pending' });
  const noConnect = await mkBiz('noconnect', { connect: false });
  const noPlan = await mkBiz('noplan', { plan: 'none' });
  const lapsed = await mkBiz('lapsed', { plan: 'lapsed' });

  // Platform admin acting for a business (x-business-id). Services check the admin email list, products the
  // token's isAdmin flag, so this user has both. Skipped if the local DB already has a user with that email.
  const ADMIN_EMAIL = 'info@goutsyde.com';
  const [adminTaken] = await q(`SELECT id FROM users WHERE lower(email) = $1`, [ADMIN_EMAIL]);
  let adminToken: string | null = null;
  if (!adminTaken) {
    const aid = id('admin');
    await q(`INSERT INTO users (id, username, email, is_admin) VALUES ($1::varchar, $1::text, $2, true)`, [aid, ADMIN_EMAIL]);
    users.push(aid);
    adminToken = generateAccessToken({ userId: aid, isVendor: false, isAdmin: true });
  }
  const adminPatch = (path: string, bizId: string, body: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'PATCH', headers: {
      'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)),
      'Authorization': `Bearer ${adminToken}`, 'x-business-id': bizId, 'X-Forwarded-For': '10.99.34.250' } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on('error', reject); req.write(data); req.end();
  });

  const REPUBLISH = { status: 'live', isActive: true };
  const UNPUBLISH = { status: 'draft', isActive: false };

  const kinds = [
    { kind: 'service', path: '/api/vendor/services', mk: mkSvc, row: svcRow, key: 'service', paused: 'This service was paused because your plan payment is late. Pay your plan and it goes live again on its own.' },
    { kind: 'product', path: '/api/vendor/products', mk: mkProd, row: prodRow, key: 'product', paused: 'This product was paused because your plan payment is late. Pay your plan and it goes live again on its own.' },
  ] as const;

  try {
    for (const K of kinds) {
      console.log(`\n── ${K.kind}s ──`);
      const patch = (itemId: string, token: string, body: unknown) => call('PATCH', `${K.path}/${itemId}`, { token, body });

      // 1. Not approved: same 403 body as Publish, nothing saved.
      {
        const it = await K.mk('na', notApproved.bid, { status: 'paused', product: true });
        const r = await patch(it, notApproved.token, REPUBLISH);
        assert(r.status === 403 && r.body?.requiresApproval === true && typeof r.body?.message === 'string' && r.body.message.length > 0,
          `${K.kind}: re-publish refused when business not approved (403, message)`, r);
        const naRow = await K.row(it);
        assert(naRow.status === 'paused' && naRow.is_active === true, `${K.kind}: not approved item stays paused and keeps isActive`, naRow);
      }
      // 2. Connect unfinished (and Stripe says unfinished): 409 connect_incomplete, nothing saved.
      {
        const it = await K.mk('nc', noConnect.bid, { status: 'draft', product: true });
        const r = await patch(it, noConnect.token, REPUBLISH);
        assert(r.status === 409 && r.body?.code === 'connect_incomplete' && typeof r.body?.message === 'string',
          `${K.kind}: re-publish refused when Connect unfinished (409 connect_incomplete)`, r);
        assert((await K.row(it)).status === 'draft', `${K.kind}: Connect unfinished item stays draft`);
      }
      // 3. No plan: 409 subscription_inactive, nothing saved.
      {
        const it = await K.mk('np', noPlan.bid, { status: 'draft', product: true });
        const r = await patch(it, noPlan.token, REPUBLISH);
        assert(r.status === 409 && r.body?.code === 'subscription_inactive' && typeof r.body?.message === 'string',
          `${K.kind}: re-publish refused with no plan (409 subscription_inactive)`, r);
        assert((await K.row(it)).status === 'draft', `${K.kind}: no plan item stays draft`);
      }
      // 4. Never published + no plan: refused, no Stripe product created.
      {
        const it = await K.mk('npfirst', noPlan.bid, { status: 'draft' });
        const before = calls.length;
        const r = await patch(it, noPlan.token, REPUBLISH);
        assert(r.status === 409 && r.body?.code === 'subscription_inactive', `${K.kind}: first publish by edit refused with no plan`, r);
        const row = await K.row(it);
        assert(row.status === 'draft' && row.stripe_product_id === null, `${K.kind}: refused first publish leaves no Stripe product`, row);
        assert(!calls.slice(before).some((c) => c.startsWith('POST /v1/products')), `${K.kind}: refused first publish makes no Stripe product call`, calls.slice(before));
      }
      // 5. Ready vendor re-publish of a paused item that has a Stripe product: live, zero Stripe calls (B1).
      {
        const it = await K.mk('rp', ready.bid, { status: 'paused', product: true });
        const before = calls.length;
        const r = await patch(it, ready.token, REPUBLISH);
        const row = await K.row(it);
        assert(r.status === 200 && row.status === 'live' && row.is_active === true, `${K.kind}: ready vendor re-publish goes live`, { status: r.status, row });
        assert(calls.length === before, `${K.kind}: re-publish makes no Stripe call`, calls.slice(before));
        assert(row.stripe_product_id === `prod_seed_${it}` && row.stripe_price_id === `price_seed_${it}`, `${K.kind}: re-publish keeps the Stripe ids`, row);
        assert(r.body?.[K.key]?.status === 'live', `${K.kind}: response body still { ${K.key}: { status: 'live' } }`, r.body);
      }
      // 6. Ready vendor re-publish of an archived item (price cleared by Archive): live, zero Stripe calls (B1).
      {
        const it = await K.mk('ra', ready.bid, { status: 'archived', product: true, price: false });
        const before = calls.length;
        const r = await patch(it, ready.token, REPUBLISH);
        const row = await K.row(it);
        assert(r.status === 200 && row.status === 'live', `${K.kind}: ready vendor re-publish of an archived item goes live`, { status: r.status, row });
        assert(calls.length === before, `${K.kind}: archived re-publish makes no Stripe call`, calls.slice(before));
      }
      // 7. Ready vendor, never published, edit to live: treated as Publish (C1), Stripe product + price created.
      {
        const it = await K.mk('rf', ready.bid, { status: 'draft' });
        const before = calls.length;
        const r = await patch(it, ready.token, REPUBLISH);
        const row = await K.row(it);
        const made = calls.slice(before);
        assert(r.status === 200 && row.status === 'live', `${K.kind}: first publish by edit goes live for a ready vendor`, { status: r.status, row });
        assert(typeof row.stripe_product_id === 'string' && row.stripe_product_id.startsWith('prod_pub_')
          && typeof row.stripe_price_id === 'string' && row.stripe_price_id.startsWith('price_pub_'),
          `${K.kind}: first publish by edit saves the new Stripe ids`, row);
        assert(made.includes('POST /v1/products') && made.includes('POST /v1/prices'), `${K.kind}: first publish by edit creates the Stripe product and price`, made);
      }
      // 8. Ready vendor, first publish by edit with a new price in the same edit: the Stripe price is the new price.
      {
        const it = await K.mk('rfp', ready.bid, { status: 'draft' });
        const r = await patch(it, ready.token, { ...REPUBLISH, price: 9500 });
        const row = await K.row(it);
        assert(r.status === 200 && row.status === 'live' && prices[row.stripe_price_id] === 9500, `${K.kind}: first publish by edit uses the price from the same edit`, { row, amount: prices[row.stripe_price_id] });
      }
      // 9. Already live on a business that would fail the checks (like XO): edits keep working (D1).
      {
        const it = await K.mk('live-np', noPlan.bid, { status: 'live' });
        const r1 = await patch(it, noPlan.token, { name: 'Renamed by app' });
        assert(r1.status === 200 && (await K.row(it)).name === 'Renamed by app' && (await K.row(it)).status === 'live', `${K.kind}: edit on an already live item still saves`, r1);
        const r2 = await patch(it, noPlan.token, REPUBLISH);
        assert(r2.status === 200 && (await K.row(it)).status === 'live', `${K.kind}: live to live is not re-checked`, r2);
      }
      // 10. Unpublish is never blocked, even when the business would fail the checks.
      {
        const it = await K.mk('unpub', noPlan.bid, { status: 'live', product: true });
        const r = await patch(it, noPlan.token, UNPUBLISH);
        const row = await K.row(it);
        assert(r.status === 200 && row.status === 'draft' && row.is_active === false, `${K.kind}: unpublish still works on a business without a plan`, { status: r.status, row });
      }
      // 11. Pause by edit is never blocked.
      {
        const it = await K.mk('pause', noPlan.bid, { status: 'live', product: true });
        const r = await patch(it, noPlan.token, { status: 'paused' });
        assert(r.status === 200 && (await K.row(it)).status === 'paused', `${K.kind}: pause by edit still works`, r);
      }
      // 12. App style edit on a draft (no status key): saved, stays draft, no checks, no Stripe call.
      {
        const it = await K.mk('app', noPlan.bid, { status: 'draft' });
        const before = calls.length;
        const r = await patch(it, noPlan.token, { name: 'App edit' });
        const row = await K.row(it);
        assert(r.status === 200 && row.status === 'draft' && row.name === 'App edit', `${K.kind}: edit without status on a draft saves as before`, { status: r.status, row });
        assert(calls.length === before, `${K.kind}: edit without status makes no Stripe call`, calls.slice(before));
      }
      // 13. System paused for a late plan: the existing message, word for word.
      {
        const it = await K.mk('sys', lapsed.bid, { status: 'paused', product: true });
        await q(`INSERT INTO subscription_paused_items (business_id, item_type, item_id) VALUES ($1, $2, $3)`, [lapsed.bid, K.kind, it]);
        const r = await patch(it, lapsed.token, REPUBLISH);
        assert(r.status === 409 && r.body?.code === 'subscription_inactive' && r.body?.message === K.paused, `${K.kind}: system paused message unchanged`, r);
        assert((await K.row(it)).status === 'paused', `${K.kind}: system paused item stays paused`);
      }
      // 14. Another business's item: still 404 before any check.
      {
        const it = await K.mk('other', ready.bid, { status: 'draft', product: true });
        const r = await patch(it, noPlan.token, REPUBLISH);
        assert(r.status === 404, `${K.kind}: another business's item is still 404`, r);
      }

      // ── Unchanged paths (code review: prove these by test, not only by reading the diff) ─────────────────
      // 15. Publish route, ready vendor: live, Stripe product + price created and saved.
      {
        const it = await K.mk('gl', ready.bid, { status: 'draft' });
        const before = calls.length;
        const r = await call('POST', `${K.path}/${it}/go-live`, { token: ready.token });
        const row = await K.row(it);
        const made = calls.slice(before);
        assert(r.status === 200 && row.status === 'live' && String(row.stripe_product_id).startsWith('prod_pub_') && String(row.stripe_price_id).startsWith('price_pub_'),
          `${K.kind}: Publish route still publishes and saves Stripe ids`, { status: r.status, row });
        assert(made.includes('POST /v1/products') && made.includes('POST /v1/prices'), `${K.kind}: Publish route still creates the Stripe product and price`, made);
      }
      // 16. Publish route refusals unchanged.
      {
        const a = await K.mk('gl-np', noPlan.bid, { status: 'draft' });
        const r1 = await call('POST', `${K.path}/${a}/go-live`, { token: noPlan.token });
        assert(r1.status === 409 && r1.body?.code === 'subscription_inactive', `${K.kind}: Publish route still refuses with no plan`, r1);
        const b = await K.mk('gl-na', notApproved.bid, { status: 'draft' });
        const r2 = await call('POST', `${K.path}/${b}/go-live`, { token: notApproved.token });
        assert(r2.status === 403 && r2.body?.requiresApproval === true, `${K.kind}: Publish route still refuses a business not approved`, r2);
        assert((await K.row(a)).status === 'draft' && (await K.row(b)).status === 'draft', `${K.kind}: refused Publish leaves items draft`);
      }
      // 17. Price change on a live item with a Stripe product: new Stripe price at the new amount.
      {
        const it = await K.mk('pc', ready.bid, { status: 'live', product: true });
        const before = calls.length;
        const r = await patch(it, ready.token, { price: 9900 });
        const row = await K.row(it);
        assert(r.status === 200 && String(row.stripe_price_id).startsWith('price_pub_') && prices[row.stripe_price_id] === 9900 && calls.slice(before).includes('POST /v1/prices'),
          `${K.kind}: price change on a live item still rotates the Stripe price`, { status: r.status, row, made: calls.slice(before) });
      }
      // 18. Price change on a live item when the plan is gone: still refused, nothing saved.
      {
        const it = await K.mk('pc-np', noPlan.bid, { status: 'live', product: true });
        const r = await patch(it, noPlan.token, { price: 9900 });
        assert(r.status === 409 && r.body?.code === 'subscription_inactive', `${K.kind}: price change with no plan still refused`, r);
        const [pr] = await q(`SELECT price FROM ${K.kind === 'service' ? 'vendor_services' : 'vendor_products'} WHERE id = $1`, [it]);
        assert(pr.price === 7000, `${K.kind}: refused price change saves nothing`, pr);
      }
      // 19. Admin acting for a business gets the same checks.
      if (adminToken) {
        const a = await K.mk('adm-na', notApproved.bid, { status: 'paused', product: true });
        const r1 = await adminPatch(`${K.path}/${a}`, notApproved.bid, REPUBLISH);
        assert(r1.status === 403 && r1.body?.requiresApproval === true && (await K.row(a)).status === 'paused', `${K.kind}: admin re-publish for a business not approved is refused`, r1);
        const b = await K.mk('adm-ok', ready.bid, { status: 'paused', product: true });
        const r2 = await adminPatch(`${K.path}/${b}`, ready.bid, REPUBLISH);
        assert(r2.status === 200 && (await K.row(b)).status === 'live', `${K.kind}: admin re-publish for a ready business works`, r2);
      } else {
        console.log(`  ⏭  ${K.kind}: admin cases skipped (a user with ${ADMIN_EMAIL} already exists locally)`);
      }
    }
  } finally {
    await q(`DELETE FROM subscription_paused_items WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM vendor_products WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM business_referrals WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    if (createdTier) await q(`DELETE FROM subscription_tiers WHERE id = $1`, [tierId]);
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
