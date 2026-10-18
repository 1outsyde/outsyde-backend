/**
 * Vendor-site order routes (Dia Lux site prep) — HTTP integration tests
 *
 * Run with: npx tsx server/vendorSiteOrders.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema)
 * with a Stripe stub. Environment variables:
 *
 *   VSO_TEST_BASE_URL      e.g. http://localhost:5093   (must be localhost)
 *   VSO_TEST_PG_URL        the SAME scratch database (localhost only; seeds + cleans up)
 *   VSO_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                          STRIPE_STUB_PORT=<same> and
 *                          NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET             identical to the server's
 *
 * Skips (exit 0) when VSO_TEST_BASE_URL is unset and refuses any non-local host, so it can never
 * touch Neon or production.
 *
 * What it proves:
 *  - PATCH /api/business/orders/:id: owner unchanged; another vendor is refused even with
 *    x-business-id; the platform admin can update any business's order with x-business-id or
 *    ?businessId; an admin naming nothing gets their own business as before
 *  - GET /api/vendor/customers now accepts Bearer, keeps refusing no auth, and only the admin
 *    can name another business
 *  - GET /api/my-orders items carry variantId/variantLabel when the line has them, and no new
 *    keys when it doesn't
 *  - POST /api/cart/payment-intent (single shop) returns the order's orderNumber
 */

import http from 'http';

const BASE = process.env.VSO_TEST_BASE_URL;
const PG_URL = process.env.VSO_TEST_PG_URL;
const STUB_PORT = Number(process.env.VSO_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.5.9', ...(o.headers || {}) };
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
    console.log('⏭  skipped: set VSO_TEST_BASE_URL (+ VSO_TEST_PG_URL, VSO_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, VSO_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'vso-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub ──────────────────────────────────────────────────────────────
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === 'POST' && req.url === '/v1/customers') return send(200, { id: `cus_stub_${Date.now()}`, object: 'customer' });
      if (req.method === 'GET' && req.url?.startsWith('/v1/customers/')) return send(200, { id: req.url.split('/')[3], object: 'customer' });
      if (req.method === 'POST' && req.url === '/v1/payment_intents') {
        const piId = `pi_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        return send(200, { id: piId, object: 'payment_intent', amount: Number(form.get('amount') || 0), currency: 'usd', status: 'requires_payment_method', client_secret: `${piId}_secret_stub`, metadata: {} });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ─────────────────────────────────────────────────────────────────────
  const P = `vso${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const mkUser = async (key: string, isVendor: boolean) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@vso.test`, isVendor]);
    return uid;
  };
  const vendorA = await mkUser('va', true);   // owns bizA (the Dia Lux stand-in)
  const vendorB = await mkUser('vb', true);   // owns bizB
  const adminU = await mkUser('ad', false);   // platform admin, owns no business
  const customer = await mkUser('cu', false);
  const bizA = id('bizA');
  const bizB = id('bizB');
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1,$2,'Hair Shop','retail','approved','acct_vsoA',true),($3,$4,'Other Shop','retail','approved','acct_vsoB',true)`, [bizA, vendorA, bizB, vendorB]);
  const bundle = id('bundle');
  await q(`INSERT INTO vendor_products (id, business_id, name, price, inventory, track_inventory, is_active, status) VALUES ($1,$2,'Raw Straight Bundle',12500,0,false,true,'live')`, [bundle, bizA]);

  const lineWithVariant = { productId: bundle, name: 'Raw Straight Bundle', quantity: 1, price: 15500, variantId: id('v18'), variantLabel: '18"' };
  const linePlain = { productId: bundle, name: 'Raw Straight Bundle', quantity: 2, price: 12500 };
  const mkOrder = async (key: string, biz: string, status: string, items: unknown[]) => {
    const oid = id(key);
    await q(`INSERT INTO orders (id, customer_id, business_id, total_amount, status, items) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [oid, customer, biz, 15500, status, JSON.stringify(items)]);
    return oid;
  };
  const oA1 = await mkOrder('oA1', bizA, 'paid', [lineWithVariant]);
  const oA2 = await mkOrder('oA2', bizA, 'paid', [linePlain]);
  const oB1 = await mkOrder('oB1', bizB, 'paid', [linePlain]);

  const tA = generateAccessToken({ userId: vendorA, isVendor: true, isAdmin: false } as any);
  const tB = generateAccessToken({ userId: vendorB, isVendor: true, isAdmin: false } as any);
  const tAdmin = generateAccessToken({ userId: adminU, isVendor: false, isAdmin: true } as any);
  const tC = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false } as any);
  const ship = { status: 'shipped', trackingNumber: '1Z999AA10123456784', carrier: 'UPS' };

  try {
    console.log('PATCH /api/business/orders/:id');
    assert((await call('PATCH', `/api/business/orders/${oA1}`, { body: ship })).status === 401, 'no token → 401');
    const bNoHeader = await call('PATCH', `/api/business/orders/${oA1}`, { token: tB, body: ship });
    assert(bNoHeader.status === 403, 'another vendor → 403', bNoHeader.body);
    const bHeader = await call('PATCH', `/api/business/orders/${oA1}`, { token: tB, body: ship, headers: { 'x-business-id': bizA } });
    assert(bHeader.status === 403, 'another vendor with x-business-id is still refused (not admin)', bHeader.body);
    const bQuery = await call('PATCH', `/api/business/orders/${oA1}?businessId=${bizA}`, { token: tB, body: ship });
    assert(bQuery.status === 403, 'another vendor with ?businessId is still refused', bQuery.body);
    const adminNoBiz = await call('PATCH', `/api/business/orders/${oA1}`, { token: tAdmin, body: ship });
    assert(adminNoBiz.status === 404, 'admin naming no business → own business (none) → 404 as before', adminNoBiz.body);
    const unchanged = await q(`SELECT status FROM orders WHERE id=$1`, [oA1]);
    assert(unchanged[0]?.status === 'paid', 'refused attempts changed nothing', unchanged);

    const adminShip = await call('PATCH', `/api/business/orders/${oA1}`, { token: tAdmin, body: ship, headers: { 'x-business-id': bizA } });
    assert(adminShip.status === 200 && adminShip.body?.order?.status === 'shipped', 'admin with x-business-id ships the order', adminShip.body);
    const shipRows = await q(`SELECT business_id, carrier, tracking_number FROM shipments WHERE order_id=$1`, [oA1]);
    assert(shipRows.length === 1 && shipRows[0].business_id === bizA && shipRows[0].carrier === 'UPS', 'shipment saved under the order\'s business', shipRows);
    const adminWrongBiz = await call('PATCH', `/api/business/orders/${oB1}`, { token: tAdmin, body: ship, headers: { 'x-business-id': bizA } });
    assert(adminWrongBiz.status === 403, 'admin naming bizA cannot touch a bizB order', adminWrongBiz.body);
    const adminQuery = await call('PATCH', `/api/business/orders/${oA2}?businessId=${bizA}`, { token: tAdmin, body: ship });
    assert(adminQuery.status === 200 && adminQuery.body?.order?.status === 'shipped', 'admin with ?businessId ships the order', adminQuery.body);
    const ownerDeliver = await call('PATCH', `/api/business/orders/${oA1}`, { token: tA, body: { status: 'delivered' } });
    assert(ownerDeliver.status === 200 && ownerDeliver.body?.order?.status === 'delivered', 'owner still updates their own order', ownerDeliver.body);
    const ownerBad = await call('PATCH', `/api/business/orders/${oA1}`, { token: tA, body: { status: 'paid' } });
    assert(ownerBad.status === 400, 'status rules still apply (delivered → paid refused)', ownerBad.body);

    console.log('GET /api/vendor/customers');
    assert((await call('GET', '/api/vendor/customers')).status === 401, 'no auth → 401');
    const ownerCust = await call('GET', '/api/vendor/customers', { token: tA });
    const ownerIds = (ownerCust.body?.records ?? []).map((r: any) => r.recordId);
    assert(ownerCust.status === 200 && ownerIds.includes(oA1) && ownerIds.includes(oA2) && !ownerIds.includes(oB1), 'owner with Bearer gets their own records only', ownerCust.body);
    const bCust = await call('GET', '/api/vendor/customers', { token: tB, headers: { 'x-business-id': bizA } });
    const bIds = (bCust.body?.records ?? []).map((r: any) => r.recordId);
    assert(bCust.status === 200 && bIds.includes(oB1) && !bIds.includes(oA1), 'non-admin x-business-id is ignored (own records)', bCust.body);
    const adminCust = await call('GET', '/api/vendor/customers', { token: tAdmin, headers: { 'x-business-id': bizA } });
    const adminIds = (adminCust.body?.records ?? []).map((r: any) => r.recordId);
    assert(adminCust.status === 200 && adminIds.includes(oA1) && !adminIds.includes(oB1), 'admin with x-business-id gets that business', adminCust.body);
    assert((await call('GET', '/api/vendor/customers', { token: tAdmin })).status === 404, 'admin naming nothing, owns nothing → 404');

    console.log('GET /api/my-orders');
    const mine = await call('GET', '/api/my-orders', { token: tC });
    const byId = Object.fromEntries((mine.body?.orders ?? []).map((o: any) => [o.id, o]));
    const withV = byId[oA1]?.items?.[0];
    assert(mine.status === 200 && withV?.variantLabel === '18"' && withV?.variantId === id('v18'), 'line with a variant returns variantId + variantLabel', withV);
    const plain = byId[oA2]?.items?.[0];
    assert(!!plain && !('variantLabel' in plain) && !('variantId' in plain), 'line without a variant gets no new keys', plain);
    assert(Object.keys(plain ?? {}).sort().join(',') === 'imageUrl,name,price,productId,quantity', 'plain line keeps exactly the old keys', Object.keys(plain ?? {}));

    console.log('POST /api/cart/payment-intent');
    const pi = await call('POST', '/api/cart/payment-intent', {
      token: tC,
      body: { items: [{ vendorId: bizA, productId: bundle, priceCents: 1, quantity: 1, name: 'Raw Straight Bundle' }], shippingAddress: { line1: '1 Main St', city: 'Freeport', state: 'NY', zipCode: '11520' } },
    });
    assert(pi.status === 200 && pi.body?.success === true, 'checkout succeeds', pi.body);
    const dbOrder = await q(`SELECT order_number, total_amount FROM orders WHERE id=$1`, [pi.body?.orderId]);
    assert(typeof pi.body?.orderNumber === 'number' && pi.body.orderNumber === dbOrder[0]?.order_number, 'response orderNumber matches the order row', { got: pi.body?.orderNumber, db: dbOrder[0] });
    assert(dbOrder[0]?.total_amount === 12500, 'price still comes from the database, not the client (1¢ sent)', dbOrder[0]);
    assert(typeof pi.body?.clientSecret === 'string' && typeof pi.body?.orderId === 'string' && !!pi.body?.feeBreakdown, 'existing response fields unchanged');
  } finally {
    await q(`DELETE FROM shipments WHERE order_id IN (SELECT id FROM orders WHERE business_id IN ($1,$2))`, [bizA, bizB]);
    await q(`DELETE FROM orders WHERE business_id IN ($1,$2)`, [bizA, bizB]);
    await q(`DELETE FROM vendor_products WHERE business_id IN ($1,$2)`, [bizA, bizB]);
    await q(`DELETE FROM businesses WHERE id IN ($1,$2)`, [bizA, bizB]);
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}-%`]).catch(() => {});
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
