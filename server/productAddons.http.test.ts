/**
 * Product add-on groups (migration 075) — HTTP integration tests
 *
 * Run with: npx tsx server/productAddons.http.test.ts
 *
 * SCRATCH ONLY. Same setup as server/productOptions.http.test.ts: a backend booted on localhost
 * against a LOCAL scratch Postgres (full schema, migration 075 applied) with a Stripe stub.
 *
 *   PA_TEST_BASE_URL      e.g. http://localhost:5091         (must be localhost)
 *   PA_TEST_PG_URL        the SAME scratch database (localhost only; seeds + cleans up)
 *   PA_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 *
 * Skips (exit 0) when PA_TEST_BASE_URL is unset and refuses any non-local host.
 *
 * What it proves:
 *  - only the product's owner (or the admin with x-business-id) can read or save add-ons
 *  - saving groups and choices, re-saving keeps ids, removed choices are deleted, bad saves change nothing
 *  - the public product route returns only switched-on groups and choices; the store list gets addonSummary
 *  - checkout prices add-ons from the database: Stripe amount = subtotal + 8%, vendor transfer = subtotal - 2%
 *  - the order line keeps the add-ons and the typed text; customer and vendor order routes return them
 *  - an old app line (no addons key) on a product with a required group is charged as before
 *  - required group, text limit and foreign add-on ids are refused
 *  - the stock message shows no count
 */

import http from 'http';

const BASE = process.env.PA_TEST_BASE_URL;
const PG_URL = process.env.PA_TEST_PG_URL;
const STUB_PORT = Number(process.env.PA_TEST_STRIPE_PORT || '0');

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
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.4.10', ...(o.headers || {}) };
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
    console.log('⏭  skipped: set PA_TEST_BASE_URL (+ PA_TEST_PG_URL, PA_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, PA_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'pa-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub: records every payment intent it creates ─────────────────────
  const pis: Array<{ amount: number; transferAmount: number | null; destination: string | null }> = [];
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === 'POST' && req.url === '/v1/customers') return send(200, { id: `cus_stub_${Date.now()}`, object: 'customer' });
      if (req.method === 'GET' && req.url?.startsWith('/v1/customers/')) return send(200, { id: req.url.split('/')[3], object: 'customer' });
      if (req.method === 'POST' && req.url === '/v1/payment_intents') {
        const piId = `pi_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const amount = Number(form.get('amount') || 0);
        const t = form.get('transfer_data[amount]');
        pis.push({ amount, transferAmount: t === null ? null : Number(t), destination: form.get('transfer_data[destination]') });
        return send(200, { id: piId, object: 'payment_intent', amount, currency: 'usd', status: 'requires_payment_method', client_secret: `${piId}_secret_stub`, metadata: {} });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ─────────────────────────────────────────────────────────────────────
  const P = `pa${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const mkUser = async (key: string, isVendor: boolean) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@pa.test`, isVendor]);
    return uid;
  };
  const vendorA = await mkUser('va', true);
  const vendorB = await mkUser('vb', true);
  const customer = await mkUser('cu', false);
  const bizA = id('bizA');
  const bizB = id('bizB');
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1,$2,'Jazzy Sweet Tooth','food_drink','approved','acct_paA',true),($3,$4,'Other Shop','retail','approved','acct_paB',true)`, [bizA, vendorA, bizB, vendorB]);
  // Active plan so the store list is public (isBusinessVisibleToPublic).
  const [tierRow] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true ORDER BY sort_order, created_at LIMIT 1`);
  if (!tierRow) throw new Error('No active subscription_tiers in DB: boot the server once so it seeds them');
  await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, current_period_end) VALUES ($1,$2,$3,$4,'active',$5)`,
    [id('sub'), vendorA, bizA, tierRow.id, new Date(Date.now() + 30 * 86400000).toISOString()]);
  const cake = id('cake');
  const cookie = id('cookie');
  await q(`INSERT INTO vendor_products (id, business_id, name, price, inventory, track_inventory, is_active, status) VALUES ($1,$3,'Fresh Fruit Cake',8500,3,true,true,'live'),($2,$3,'Apple Pie Cookies',1100,null,true,true,'live')`, [cake, cookie, bizA]);
  const pink = id('pink');
  await q(`INSERT INTO product_variants (id, product_id, label, price_cents, inventory, track_inventory, is_active, sort_order) VALUES ($1,$2,'Pink',null,null,true,true,0)`, [pink, cake]);

  const tA = generateAccessToken({ userId: vendorA, isVendor: true, isAdmin: false } as any);
  const tB = generateAccessToken({ userId: vendorB, isVendor: true, isAdmin: false } as any);
  const tC = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false } as any);
  const tAdmin = generateAccessToken({ userId: vendorB, isVendor: true, isAdmin: true } as any);
  const ship = { line1: '1 Main St', city: 'Uniondale', state: 'NY', zipCode: '11553' };
  const addonsPath = `/api/business/products/${cake}/addons`;

  const groups1 = {
    groups: [
      { name: 'Fruit', minSelect: 1, maxSelect: 3, addons: [{ name: 'Strawberry' }, { name: 'Kiwi' }, { name: 'Mango', priceCents: 200 }] },
      { name: 'Extras', addons: [
        { name: 'Cake topper', priceCents: 1000 },
        { name: 'Sprinkles', priceCents: 300 },
        { name: 'Name frosting', priceCents: 500, acceptsText: true, textLabel: 'Name on the cake', textMaxLength: 12 },
      ] },
    ],
  };

  try {
    console.log('auth');
    assert((await call('GET', addonsPath)).status === 401, 'no token → 401');
    assert((await call('GET', addonsPath, { token: tB })).status === 403, 'another vendor → 403');
    assert((await call('PUT', addonsPath, { token: tB, body: groups1 })).status === 403, 'another vendor cannot save → 403');
    const adminRead = await call('GET', addonsPath, { token: tAdmin, headers: { 'x-business-id': bizA } });
    assert(adminRead.status === 200 && Array.isArray(adminRead.body?.groups), 'admin with x-business-id can read', adminRead.body);

    console.log('save');
    const save1 = await call('PUT', addonsPath, { token: tA, body: groups1 });
    assert(save1.status === 200, 'owner saves add-ons', save1.body);
    const g1 = save1.body?.groups ?? [];
    assert(g1.map((g: any) => g.name).join('|') === 'Fruit|Extras', 'groups in order', g1);
    assert(g1[1]?.addons?.map((a: any) => a.name).join('|') === 'Cake topper|Sprinkles|Name frosting', 'choices in order', g1[1]);
    const byName: Record<string, string> = {};
    for (const g of g1) for (const a of g.addons) byName[a.name] = a.id;
    const nameAddon = g1[1]?.addons?.[2];
    assert(nameAddon?.acceptsText === true && nameAddon?.textMaxLength === 12 && nameAddon?.textLabel === 'Name on the cake', 'text settings saved', nameAddon);

    console.log('public product and store list');
    const pub = await call('GET', `/api/products/${cake}`);
    assert(pub.status === 200 && pub.body?.addonGroups?.length === 2, 'public product has addonGroups', pub.body?.addonGroups);
    assert(pub.body?.addonGroups?.[0]?.required === true && pub.body?.addonGroups?.[1]?.required === false, 'required flag', pub.body?.addonGroups);
    assert(!('isActive' in (pub.body?.addonGroups?.[0]?.addons?.[0] ?? {})), 'no internal fields on public choices');
    assert(Array.isArray(pub.body?.variants) && pub.body.variants.length === 1, 'variants unchanged next to add-ons');
    const pubCookie = await call('GET', `/api/products/${cookie}`);
    assert(Array.isArray(pubCookie.body?.addonGroups) && pubCookie.body.addonGroups.length === 0, 'product without add-ons gets an empty list');
    const list = await call('GET', `/api/businesses/${bizA}/products`);
    const listCake = (list.body?.products ?? []).find((p: any) => p.id === cake);
    const listCookie = (list.body?.products ?? []).find((p: any) => p.id === cookie);
    assert(listCake?.addonSummary?.groupCount === 2 && listCake?.addonSummary?.hasRequired === true, 'store list addonSummary', listCake?.addonSummary);
    assert(listCookie?.addonSummary === null, 'no add-ons → addonSummary null', listCookie?.addonSummary);
    assert(listCake?.variantSummary !== undefined, 'variantSummary still present', listCake);

    console.log('re-save: drop Sprinkles, switch Strawberry off, rename Kiwi');
    const save2 = await call('PUT', addonsPath, {
      token: tA,
      body: {
        groups: [
          { id: g1[0].id, name: 'Fruit', minSelect: 1, maxSelect: 3, addons: [
            { id: byName['Strawberry'], name: 'Strawberry', isActive: false },
            { id: byName['Kiwi'], name: 'Golden kiwi' },
            { id: byName['Mango'], name: 'Mango', priceCents: 200 },
          ] },
          { id: g1[1].id, name: 'Extras', addons: [
            { id: byName['Cake topper'], name: 'Cake topper', priceCents: 1000 },
            { id: byName['Name frosting'], name: 'Name frosting', priceCents: 500, acceptsText: true, textLabel: 'Name on the cake', textMaxLength: 12 },
          ] },
        ],
      },
    });
    assert(save2.status === 200, 're-save 200', save2.body);
    const g2 = save2.body?.groups ?? [];
    assert(g2[0]?.id === g1[0].id && g2[0]?.addons?.[1]?.id === byName['Kiwi'] && g2[0]?.addons?.[1]?.name === 'Golden kiwi', 'ids kept, rename saved', g2[0]);
    const sprinkles = await q(`SELECT count(*)::int n FROM product_addons WHERE id=$1`, [byName['Sprinkles']]);
    assert(sprinkles[0].n === 0, 'removed choice deleted');
    const pub2 = await call('GET', `/api/products/${cake}`);
    assert(!(pub2.body?.addonGroups?.[0]?.addons ?? []).some((a: any) => a.name === 'Strawberry'), 'switched-off choice hidden from customers');

    console.log('bad saves change nothing');
    const countBefore = await q(`SELECT count(*)::int n FROM product_addons WHERE product_id=$1`, [cake]);
    const foreign = await call('PUT', addonsPath, { token: tA, body: { groups: [{ id: 'not-mine', name: 'Fruit', addons: [{ name: 'Kiwi' }] }] } });
    assert(foreign.status === 400 && foreign.body?.error?.code === 'INVALID_ADDON_ID', 'unknown group id → 400', foreign.body);
    const impossible = await call('PUT', addonsPath, { token: tA, body: { groups: [{ name: 'Fruit', minSelect: 3, addons: [{ name: 'Kiwi' }] }] } });
    assert(impossible.status === 400 && impossible.body?.error?.code === 'INVALID_ADDONS', 'min above choices → 400', impossible.body);
    const countAfter = await q(`SELECT count(*)::int n FROM product_addons WHERE product_id=$1`, [cake]);
    assert(countBefore[0].n === countAfter[0].n && countAfter[0].n === 5, 'nothing changed after refused saves', [countBefore, countAfter]);

    console.log('checkout with add-ons');
    // 2 x (8500 Pink + 200 Mango + 1000 topper + 500 name) = 20400. Charge 20400 + 8% = 22032. Vendor 20400 - 2% = 19992.
    const pi = await call('POST', '/api/cart/payment-intent', {
      token: tC,
      body: {
        items: [{
          productId: cake, variantId: pink, vendorId: bizA, priceCents: 1, quantity: 2, name: 'x',
          addons: [{ addonId: byName['Name frosting'], text: 'Mia' }, { addonId: byName['Mango'] }, { addonId: byName['Cake topper'] }],
        }],
        shippingAddress: ship,
      },
    });
    assert(pi.status === 200, 'payment intent created', pi.body);
    const last = pis[pis.length - 1];
    assert(last?.amount === 22032, 'Stripe charge = subtotal + 8% service fee', last);
    assert(last?.transferAmount === 19992 && last?.destination === 'acct_paA', 'vendor transfer = subtotal - 2%', last);
    const order = await q(`SELECT items, total_amount, vendor_net, consumer_service_fee FROM orders WHERE id=$1`, [pi.body?.orderId]);
    const item = order[0]?.items?.[0];
    assert(order[0]?.total_amount === 20400 && order[0]?.vendor_net === 19992 && order[0]?.consumer_service_fee === 1632, 'order totals', order[0]);
    assert(item?.price === 10200 && item?.basePrice === 8500 && item?.variantLabel === 'Pink', 'order line price includes add-ons, base kept', item);
    assert(item?.addons?.map((a: any) => a.name).join('|') === 'Mango|Cake topper|Name frosting' && item?.addons?.[2]?.text === 'Mia', 'order line keeps add-ons and text', item?.addons);
    assert(item?.addonsLabel === 'Mango, Cake topper, Name frosting: "Mia"', 'addonsLabel', item?.addonsLabel);

    const mine = await call('GET', '/api/my-orders', { token: tC });
    const myOrder = (mine.body?.orders ?? mine.body ?? []).find?.((o: any) => o.id === pi.body?.orderId);
    assert(myOrder?.items?.[0]?.addonsLabel === item?.addonsLabel && myOrder?.items?.[0]?.addons?.length === 3, 'my-orders returns add-ons', mine.body);
    const vend = await call('GET', '/api/business/orders?format=snake', { token: tA });
    const vendOrder = (vend.body?.orders ?? []).find((o: any) => o.id === pi.body?.orderId);
    assert(vendOrder?.items?.[0]?.addons_label === item?.addonsLabel && vendOrder?.items?.[0]?.addons?.[2]?.text === 'Mia', 'vendor snake orders return add-ons', vendOrder?.items);

    console.log('old app line');
    const old = await call('POST', '/api/cart/payment-intent', {
      token: tC,
      body: { items: [{ productId: cake, variantId: pink, vendorId: bizA, priceCents: 8500, quantity: 1, name: 'x' }], shippingAddress: ship },
    });
    assert(old.status === 200, 'old app line on a product with a required group is not refused', old.body);
    assert(pis[pis.length - 1]?.amount === 9180, 'charged the plain price + 8% (8500 → 9180)', pis[pis.length - 1]);
    const oldItem = (await q(`SELECT items FROM orders WHERE id=$1`, [old.body?.orderId]))[0]?.items?.[0];
    assert(oldItem && !('addons' in oldItem) && !('basePrice' in oldItem), 'old line stored exactly as before', oldItem);

    console.log('refusals');
    const missing = await call('POST', '/api/cart/payment-intent', {
      token: tC,
      body: { items: [{ productId: cake, variantId: pink, vendorId: bizA, priceCents: 8500, quantity: 1, addons: [{ addonId: byName['Cake topper'] }] }], shippingAddress: ship },
    });
    assert(missing.status === 400 && missing.body?.error?.code === 'ADDON_REQUIRED', 'required group not picked → ADDON_REQUIRED', missing.body);
    const longText = await call('POST', '/api/cart/payment-intent', {
      token: tC,
      body: { items: [{ productId: cake, variantId: pink, vendorId: bizA, priceCents: 8500, quantity: 1, addons: [{ addonId: byName['Mango'] }, { addonId: byName['Name frosting'], text: 'Happy Birthday Mia' }] }], shippingAddress: ship },
    });
    assert(longText.status === 400 && longText.body?.error?.code === 'ADDON_TEXT_TOO_LONG', 'text over the limit → ADDON_TEXT_TOO_LONG', longText.body);
    const crossProduct = await call('POST', '/api/cart/payment-intent', {
      token: tC,
      body: { items: [{ productId: cookie, vendorId: bizA, priceCents: 1100, quantity: 1, addons: [{ addonId: byName['Cake topper'] }] }], shippingAddress: ship },
    });
    assert(crossProduct.status === 400 && crossProduct.body?.error?.code === 'INVALID_ADDON', 'add-on of another product → INVALID_ADDON', crossProduct.body);
    const tooMany = await call('POST', '/api/cart/payment-intent', {
      token: tC,
      body: { items: [{ productId: cake, variantId: pink, vendorId: bizA, priceCents: 8500, quantity: 4, addons: [{ addonId: byName['Mango'] }] }], shippingAddress: ship },
    });
    assert(tooMany.status === 400 && tooMany.body?.error?.code === 'INSUFFICIENT_STOCK' && !/\d/.test(tooMany.body?.error?.message ?? '1'), 'stock message shows no count', tooMany.body);

    console.log('product delete cascades');
    await q(`DELETE FROM orders WHERE business_id=$1`, [bizA]);
    await q(`DELETE FROM product_variants WHERE product_id=$1`, [cake]);
    await q(`DELETE FROM vendor_products WHERE id=$1`, [cake]);
    const leftover = await q(`SELECT (SELECT count(*)::int FROM product_addons WHERE product_id=$1) a, (SELECT count(*)::int FROM product_addon_groups WHERE product_id=$1) g`, [cake]);
    assert(leftover[0].a === 0 && leftover[0].g === 0, 'groups and choices go with the product', leftover);
  } finally {
    await q(`DELETE FROM orders WHERE business_id IN ($1,$2)`, [bizA, bizB]);
    await q(`DELETE FROM product_variants WHERE product_id IN ($1,$2)`, [cake, cookie]);
    await q(`DELETE FROM vendor_products WHERE id IN ($1,$2)`, [cake, cookie]);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id IN ($1,$2)`, [bizA, bizB]);
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
