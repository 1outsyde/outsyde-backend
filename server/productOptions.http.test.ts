/**
 * Product options (migration 049) — HTTP integration tests
 *
 * Run with: npx tsx server/productOptions.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema,
 * migration 049 applied) with a Stripe stub. Environment variables:
 *
 *   PO_TEST_BASE_URL      e.g. http://localhost:5091         (must be localhost)
 *   PO_TEST_PG_URL        the SAME scratch database (localhost only; seeds + cleans up)
 *   PO_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 *
 * Skips (exit 0) when PO_TEST_BASE_URL is unset and refuses any non-local host, so it can never
 * touch Neon or production.
 *
 * What it proves:
 *  - only the product's owner (or the admin with x-business-id) can read or save options
 *  - saving Color x Size creates the variations with labels, blank price = product price
 *  - the public product route returns options and a numeric priceCents on every variation
 *  - re-saving re-uses rows by combination and switches removed ones off (never deletes)
 *  - an invalid save changes nothing
 *  - the existing label-only routes still work; PATCH priceCents null makes a variation follow the product price
 *  - checkout charges an inheriting variation the product price and keeps the variation on the order
 */

import http from 'http';

const BASE = process.env.PO_TEST_BASE_URL;
const PG_URL = process.env.PO_TEST_PG_URL;
const STUB_PORT = Number(process.env.PO_TEST_STRIPE_PORT || '0');

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
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.4.9', ...(o.headers || {}) };
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
    console.log('⏭  skipped: set PO_TEST_BASE_URL (+ PO_TEST_PG_URL, PO_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, PO_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'po-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub ──────────────────────────────────────────────────────────────
  const piStore: Record<string, any> = {};
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === 'POST' && req.url === '/v1/customers') return send(200, { id: `cus_stub_${Date.now()}`, object: 'customer' });
      if (req.method === 'GET' && req.url?.startsWith('/v1/customers/')) return send(200, { id: req.url.split('/')[3], object: 'customer' });
      if (req.method === 'POST' && req.url === '/v1/payment_intents') {
        const piId = `pi_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const pi = { id: piId, object: 'payment_intent', amount: Number(form.get('amount') || 0), currency: 'usd', status: 'requires_payment_method', client_secret: `${piId}_secret_stub`, metadata: {} };
        piStore[piId] = pi;
        return send(200, pi);
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ─────────────────────────────────────────────────────────────────────
  const P = `po${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const mkUser = async (key: string, isVendor: boolean) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@po.test`, isVendor]);
    return uid;
  };
  const vendorA = await mkUser('va', true);
  const vendorB = await mkUser('vb', true);
  const customer = await mkUser('cu', false);
  const bizA = id('bizA');
  const bizB = id('bizB');
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1,$2,'Tee Shop','retail','approved','acct_poA',true),($3,$4,'Other Shop','retail','approved','acct_poB',true)`, [bizA, vendorA, bizB, vendorB]);
  const tee = id('tee');
  await q(`INSERT INTO vendor_products (id, business_id, name, price, inventory, track_inventory, is_active, status) VALUES ($1,$2,'Classic Tee',3500,100,true,true,'live')`, [tee, bizA]);

  const tA = generateAccessToken({ userId: vendorA, isVendor: true, isAdmin: false } as any);
  const tB = generateAccessToken({ userId: vendorB, isVendor: true, isAdmin: false } as any);
  const tC = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false } as any);
  const tAdmin = generateAccessToken({ userId: vendorB, isVendor: true, isAdmin: true } as any);

  const optionsPath = `/api/business/products/${tee}/options`;
  const color = { name: 'Color', values: [{ value: 'Black', swatchHex: '#0A0A0A' }, { value: 'Cream' }] };
  const size = { name: 'Size', values: [{ value: 'M' }, { value: 'XL' }] };

  try {
    console.log('auth');
    assert((await call('GET', optionsPath)).status === 401, 'no token → 401');
    assert((await call('GET', optionsPath, { token: tB })).status === 403, 'another vendor → 403');
    assert((await call('PUT', optionsPath, { token: tB, body: { options: [], variants: [] } })).status === 403, 'another vendor cannot save → 403');
    const adminRead = await call('GET', optionsPath, { token: tAdmin, headers: { 'x-business-id': bizA } });
    assert(adminRead.status === 200, 'admin with x-business-id can read', adminRead.body);

    console.log('save Color x Size');
    const save1 = await call('PUT', optionsPath, {
      token: tA,
      body: {
        options: [color, size],
        variants: [
          { option1: 'Black', option2: 'M', priceCents: null, inventory: 10 },
          { option1: 'Black', option2: 'XL', priceCents: 4000, inventory: 5 },
          { option1: 'Cream', option2: 'M', priceCents: null, inventory: 10 },
          { option1: 'Cream', option2: 'XL', priceCents: 4000, inventory: 0 },
        ],
      },
    });
    assert(save1.status === 200, 'owner saves options', save1.body);
    const v1 = save1.body?.variants ?? [];
    assert(v1.length === 4, '4 variations created', v1.length);
    assert(v1.map((v: any) => v.label).join('|') === 'Black / M|Black / XL|Cream / M|Cream / XL', 'labels in order', v1.map((v: any) => v.label));
    assert(v1[0].priceCents === 3500 && v1[0].hasOwnPrice === false, 'blank price shows product price', v1[0]);
    assert(v1[1].priceCents === 4000 && v1[1].hasOwnPrice === true, 'own price kept', v1[1]);
    const rawNull = await q(`SELECT price_cents FROM product_variants WHERE product_id=$1 AND option1='Black' AND option2='M'`, [tee]);
    assert(rawNull[0]?.price_cents === null, 'database stores blank price as NULL', rawNull);

    console.log('public product route');
    const pub = await call('GET', `/api/products/${tee}`);
    assert(pub.status === 200, 'public product 200');
    assert(Array.isArray(pub.body?.options) && pub.body.options.length === 2 && pub.body.options[0].name === 'Color', 'options returned in order', pub.body?.options);
    assert((pub.body?.variants ?? []).every((v: any) => typeof v.priceCents === 'number'), 'every public variation has a numeric price');
    const pubVar = await call('GET', `/api/products/${tee}/variants`);
    assert(pubVar.body?.variants?.[0]?.priceCents === 3500, 'variants route returns effective price', pubVar.body?.variants?.[0]);

    console.log('re-save: remove Cream / XL, add Forest / M');
    const ids1 = Object.fromEntries(v1.map((v: any) => [v.label, v.id]));
    const color2 = { name: 'Color', values: [...color.values, { value: 'Forest' }] };
    const save2 = await call('PUT', optionsPath, {
      token: tA,
      body: {
        options: [color2, size],
        variants: [
          { option1: 'Black', option2: 'M', priceCents: null, inventory: 9 },
          { option1: 'Black', option2: 'XL', priceCents: 4500, inventory: 5 },
          { option1: 'Cream', option2: 'M', priceCents: null, inventory: 10 },
          { option1: 'Forest', option2: 'M', priceCents: null, inventory: 3 },
        ],
      },
    });
    assert(save2.status === 200, 're-save 200', save2.body);
    const v2 = save2.body?.variants ?? [];
    const by2 = Object.fromEntries(v2.map((v: any) => [v.label, v]));
    assert(by2['Black / M']?.id === ids1['Black / M'] && by2['Black / M'].inventory === 9, 'Black / M kept its row and got the new stock');
    assert(by2['Black / XL']?.priceCents === 4500, 'price change saved');
    assert(by2['Cream / XL']?.isActive === false, 'removed variation switched off, not deleted', by2['Cream / XL']);
    assert(!!by2['Forest / M']?.id && by2['Forest / M'].isActive === true, 'new variation added');
    const pub2 = await call('GET', `/api/products/${tee}`);
    assert(!(pub2.body?.variants ?? []).some((v: any) => v.label === 'Cream / XL'), 'switched-off variation hidden from customers');

    console.log('invalid save changes nothing');
    const before = await q(`SELECT count(*)::int n FROM product_variants WHERE product_id=$1 AND is_active`, [tee]);
    const bad = await call('PUT', optionsPath, { token: tA, body: { options: [color2, size], variants: [{ option1: 'Purple', option2: 'M', priceCents: null }] } });
    assert(bad.status === 400 && bad.body?.error?.code === 'INVALID_VARIANTS', 'value not in list → 400', bad.body);
    const after = await q(`SELECT count(*)::int n FROM product_variants WHERE product_id=$1 AND is_active`, [tee]);
    assert(before[0].n === after[0].n, 'nothing changed after a refused save');

    console.log('existing label-only routes');
    const created = await call('POST', `/api/business/products/${tee}/variants`, { token: tA, body: { label: 'Gift Box', priceCents: 6000 } });
    assert(created.status === 201 && created.body?.variant?.priceCents === 6000, 'POST still creates a label-only variation', created.body);
    const patched = await call('PATCH', `/api/business/products/${tee}/variants/${created.body?.variant?.id}`, { token: tA, body: { priceCents: null, sku: 'GB-1' } });
    assert(patched.status === 200 && patched.body?.variant?.priceCents === 3500 && patched.body?.variant?.hasOwnPrice === false && patched.body?.variant?.sku === 'GB-1', 'PATCH priceCents null follows product price, sku saved', patched.body);
    const patchB = await call('PATCH', `/api/business/products/${tee}/variants/${created.body?.variant?.id}`, { token: tB, body: { priceCents: 1 } });
    assert(patchB.status === 403, 'another vendor cannot PATCH → 403');
    const del = await call('DELETE', `/api/business/products/${tee}/variants/${created.body?.variant?.id}`, { token: tA });
    assert(del.status === 200, 'DELETE still soft-deletes');

    console.log('checkout');
    const pi = await call('POST', '/api/cart/payment-intent', {
      token: tC,
      body: {
        items: [{ productId: tee, variantId: by2['Forest / M'].id, vendorId: bizA, priceCents: 1, quantity: 2, name: 'x' }],
        shippingAddress: { line1: '1 Main St', city: 'Freeport', state: 'NY', zipCode: '11520' },
      },
    });
    assert(pi.status === 200, 'payment intent created', pi.body);
    assert(pi.body?.feeBreakdown?.basePriceCents === 7000, 'inheriting variation charged the product price (2 x $35)', pi.body?.feeBreakdown);
    const order = await q(`SELECT items FROM orders WHERE id=$1`, [pi.body?.orderId]);
    const item = order[0]?.items?.[0];
    assert(item?.price === 3500 && item?.variantId === by2['Forest / M'].id && item?.variantLabel === 'Forest / M', 'order keeps variation and price', item);
    const tooMany = await call('POST', '/api/cart/payment-intent', {
      token: tC,
      body: {
        items: [{ productId: tee, variantId: by2['Forest / M'].id, vendorId: bizA, priceCents: 3500, quantity: 4, name: 'x' }],
        shippingAddress: { line1: '1 Main St', city: 'Freeport', state: 'NY', zipCode: '11520' },
      },
    });
    assert(tooMany.status === 400 && tooMany.body?.error?.code === 'INSUFFICIENT_STOCK', 'over variation stock → INSUFFICIENT_STOCK', tooMany.body);
  } finally {
    await q(`DELETE FROM orders WHERE business_id IN ($1,$2)`, [bizA, bizB]);
    await q(`DELETE FROM product_variants WHERE product_id=$1`, [tee]);
    await q(`DELETE FROM product_options WHERE product_id=$1`, [tee]);
    await q(`DELETE FROM vendor_products WHERE id=$1`, [tee]);
    await q(`DELETE FROM businesses WHERE id IN ($1,$2)`, [bizA, bizB]);
    await q(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [vendorA, vendorB, customer]);
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
