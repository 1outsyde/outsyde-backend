/**
 * Shared add-on library on products (step 2b) — HTTP integration tests
 *
 * Run with: npx tsx server/productAddonLibrary.http.test.ts
 *
 * SCRATCH ONLY. Same setup as server/productAddons.http.test.ts (localhost backend, LOCAL scratch
 * Postgres with migrations 046, 049 and 075, Stripe stub):
 *   AP_TEST_BASE_URL, AP_TEST_PG_URL, AP_TEST_STRIPE_PORT, JWT_SECRET
 * Skips (exit 0) when AP_TEST_BASE_URL is unset and refuses any non-local host.
 *
 * What it proves:
 *  - a choice typed in a product's editor lands in the library (by name) and stays on that product
 *  - a typed choice with a library name links to it; a different price counts as already asked
 *  - the library list shows where each add-on is used on products
 *  - a library price change moves synced product choices (and services) only; custom prices are
 *    listed and get the prompt once; keep / sync answers work like services
 *  - checkout charges the new library price on a synced choice
 *  - rename reaches product choices; a name clash inside a product group is refused
 *  - library on/off with productIds; a required group stays possible to fill
 *  - "apply to products": into the product's Add-ons group (created) or a picked group, with skips
 *  - delete refuses while the add-on is on products unless includeProducts=true; then the choice
 *    and any group left empty go, past orders keep their copy
 *  - another vendor can't use or touch the library add-on
 */

import http from 'http';

const BASE = process.env.AP_TEST_BASE_URL;
const PG_URL = process.env.AP_TEST_PG_URL;
const STUB_PORT = Number(process.env.AP_TEST_STRIPE_PORT || '0');

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
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.4.11' };
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
    console.log('⏭  skipped: set AP_TEST_BASE_URL (+ AP_TEST_PG_URL, AP_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, AP_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'pa-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const pis: Array<{ amount: number; transferAmount: number | null }> = [];
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
        pis.push({ amount, transferAmount: t === null ? null : Number(t) });
        return send(200, { id: piId, object: 'payment_intent', amount, currency: 'usd', status: 'requires_payment_method', client_secret: `${piId}_secret_stub`, metadata: {} });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ─────────────────────────────────────────────────────────────────────
  const P = `ap${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const mkUser = async (key: string, isVendor: boolean) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@ap.test`, isVendor]);
    return uid;
  };
  const vendorA = await mkUser('va', true);
  const vendorB = await mkUser('vb', true);
  const customer = await mkUser('cu', false);
  const bizA = id('bizA');
  const bizB = id('bizB');
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1,$2,'Jazzy Sweet Tooth','food_drink','approved','acct_apA',true),($3,$4,'Other Shop','retail','approved','acct_apB',true)`, [bizA, vendorA, bizB, vendorB]);
  const cake = id('cake');
  const cupcake = id('cupcake');
  const cookie = id('cookie');
  const oldItem = id('old');
  const otherProduct = id('bprod');
  await q(`INSERT INTO vendor_products (id, business_id, name, price, inventory, track_inventory, is_active, status) VALUES
    ($1,$6,'Fresh Fruit Cake',8500,null,true,true,'live'),
    ($2,$6,'Cupcakes',2400,null,true,true,'live'),
    ($3,$6,'Apple Pie Cookies',1100,null,true,true,'live'),
    ($4,$6,'Old Item',1000,null,true,true,'archived'),
    ($5,$7,'Other Shop Item',1000,null,true,true,'live')`, [cake, cupcake, cookie, oldItem, otherProduct, bizA, bizB]);
  const tasting = id('svc');
  await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, deposit_amount_cents, is_active, status) VALUES ($1,$2,'Cake tasting',4000,30,null,true,'live')`, [tasting, bizA]);

  const tA = generateAccessToken({ userId: vendorA, isVendor: true, isAdmin: false } as any);
  const tB = generateAccessToken({ userId: vendorB, isVendor: true, isAdmin: false } as any);
  const tC = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false } as any);
  const ship = { line1: '1 Main St', city: 'Uniondale', state: 'NY', zipCode: '11553' };
  const libGet = async () => (await call('GET', '/api/vendor/addon-library', { token: tA })).body?.addons ?? [];
  const byName = (list: any[], n: string) => list.find((x: any) => x.name === n);

  try {
    console.log('library add-on created first, then a product save');
    const topper = await call('POST', '/api/vendor/addon-library', { token: tA, body: { name: 'Cake topper', priceCents: 1000, durationMinutes: 0 } });
    assert(topper.status === 201, 'library add-on created', topper.body);
    const topperId = topper.body?.addon?.id;
    // The same add-on on a service, so one library change reaches both.
    const svcAttach = await call('POST', `/api/vendor/addon-library/${topperId}/services`, { token: tA, body: { serviceIds: [tasting] } });
    assert(svcAttach.status === 200 && svcAttach.body?.added?.length === 1, 'attached to a service as before', svcAttach.body);

    const save = await call('PUT', `/api/business/products/${cake}/addons`, { token: tA, body: { groups: [
      { name: 'Fruit', minSelect: 1, maxSelect: 3, addons: [{ name: 'Kiwi' }, { name: 'Mango', priceCents: 200 }] },
      { name: 'Extras', addons: [
        { name: 'Sprinkles', priceCents: 300 },
        { name: 'cake topper', priceCents: 1200 },
      ] },
    ] } });
    assert(save.status === 200, 'product save 200', save.body);
    const ex = save.body?.groups?.[1]?.addons ?? [];
    const sprinkles = ex.find((a: any) => a.name === 'Sprinkles');
    const cakeTopper = ex.find((a: any) => a.name === 'cake topper');
    assert(!!sprinkles?.businessAddonId && sprinkles.priceSynced === true && sprinkles.needsPriceReview === false, 'typed choice linked to a new library entry, synced', sprinkles);
    assert(cakeTopper?.businessAddonId === topperId && cakeTopper.priceSynced === false && cakeTopper.libraryPriceCents === 1000 && cakeTopper.needsPriceReview === false, 'typed choice with a library name links to it; own price, no prompt yet', cakeTopper);

    const lib1 = await libGet();
    assert(byName(lib1, 'Sprinkles')?.priceCents === 300 && byName(lib1, 'Kiwi') && byName(lib1, 'Mango'), 'new choices landed in the library', lib1.map((x: any) => x.name));
    const sprLib = byName(lib1, 'Sprinkles');
    assert(sprLib?.services?.length === 0 && sprLib?.products?.length === 1 && sprLib.products[0].productName === 'Fresh Fruit Cake' && sprLib.products[0].groupName === 'Extras', 'library shows it on the cake only', sprLib);
    const topLib = byName(lib1, 'Cake topper');
    assert(topLib?.services?.length === 1 && topLib?.products?.length === 1 && topLib.products[0].priceSynced === false, 'shared add-on shows its service and its product', topLib);
    const cupcakeNow = await call('GET', `/api/business/products/${cupcake}/addons`, { token: tA });
    assert(cupcakeNow.body?.groups?.length === 0, 'other products did not get it');

    console.log('picking from the library by id');
    const cookieSave = await call('PUT', `/api/business/products/${cookie}/addons`, { token: tA, body: { groups: [
      { name: 'Extras', addons: [{ name: 'Sprinkles', priceCents: 300, businessAddonId: sprLib.id }] },
    ] } });
    assert(cookieSave.status === 200 && cookieSave.body?.groups?.[0]?.addons?.[0]?.businessAddonId === sprLib.id, 'linked by library id', cookieSave.body);
    const foreignPick = await call('PUT', `/api/business/products/${otherProduct}/addons`, { token: tB, body: { groups: [
      { name: 'Extras', addons: [{ name: 'Sprinkles', priceCents: 300, businessAddonId: sprLib.id }] },
    ] } });
    assert(foreignPick.status === 400 && foreignPick.body?.error?.code === 'INVALID_ADDON_ID', "another vendor can't use this library add-on", foreignPick.body);

    console.log('library price change');
    const priceUp = await call('PATCH', `/api/vendor/addon-library/${topperId}`, { token: tA, body: { priceCents: 1500 } });
    assert(priceUp.status === 200, 'library price saved', priceUp.body);
    assert(priceUp.body?.customPriceProducts?.length === 1 && priceUp.body.customPriceProducts[0].productName === 'Fresh Fruit Cake', 'custom-price product listed', priceUp.body?.customPriceProducts);
    assert((priceUp.body?.updatedServiceIds ?? []).includes(tasting), 'synced service moved as before', priceUp.body);
    const svcAddon = (await q(`SELECT price_cents FROM service_addons WHERE service_id=$1`, [tasting]))[0];
    assert(svcAddon?.price_cents === 1500, 'service copy follows the library', svcAddon);
    let cakeAddons = (await call('GET', `/api/business/products/${cake}/addons`, { token: tA })).body?.groups?.[1]?.addons ?? [];
    let ct = cakeAddons.find((a: any) => a.name === 'cake topper');
    assert(ct?.priceCents === 1200 && ct?.needsPriceReview === true && ct?.libraryPriceCents === 1500, 'custom product price kept, prompt shown', ct);

    const sprUp = await call('PATCH', `/api/vendor/addon-library/${sprLib.id}`, { token: tA, body: { priceCents: 400 } });
    assert(sprUp.status === 200 && (sprUp.body?.updatedProductIds ?? []).length === 2, 'synced choices on both products moved', sprUp.body);
    const pub = await call('GET', `/api/products/${cake}`);
    const pubSpr = pub.body?.addonGroups?.[1]?.addons?.find((a: any) => a.name === 'Sprinkles');
    assert(pubSpr?.priceCents === 400, 'customers see the new price', pubSpr);

    console.log('checkout uses the new library price');
    // 1 x (8500 + 0 Kiwi + 400 Sprinkles) = 8900 → charge 9612, vendor 8722
    const pi = await call('POST', '/api/cart/payment-intent', { token: tC, body: {
      items: [{ productId: cake, vendorId: bizA, priceCents: 1, quantity: 1, addons: [{ addonId: cakeAddons.find((a: any) => a.name === 'Sprinkles')?.id }, { addonId: (await call('GET', `/api/business/products/${cake}/addons`, { token: tA })).body?.groups?.[0]?.addons?.[0]?.id }] }],
      shippingAddress: ship,
    } });
    assert(pi.status === 200, 'payment intent created', pi.body);
    assert(pis[pis.length - 1]?.amount === 9612 && pis[pis.length - 1]?.transferAmount === 8722, 'charge 9612, vendor 8722', pis[pis.length - 1]);

    console.log('keep, then sync');
    const keep = await call('POST', `/api/business/products/${cake}/addons/${ct.id}/price-review`, { token: tA, body: { action: 'keep' } });
    ct = keep.body?.groups?.[1]?.addons?.find((a: any) => a.id === ct.id);
    assert(keep.status === 200 && ct?.needsPriceReview === false && ct?.priceCents === 1200, 'keep: no prompt, own price stays', ct);
    await call('PATCH', `/api/vendor/addon-library/${topperId}`, { token: tA, body: { priceCents: 1600 } });
    cakeAddons = (await call('GET', `/api/business/products/${cake}/addons`, { token: tA })).body?.groups?.[1]?.addons ?? [];
    ct = cakeAddons.find((a: any) => a.id === ct.id);
    assert(ct?.needsPriceReview === true, 'asked again after the next library change', ct);
    const sync = await call('POST', `/api/business/products/${cake}/addons/${ct.id}/price-review`, { token: tA, body: { action: 'sync' } });
    ct = sync.body?.groups?.[1]?.addons?.find((a: any) => a.id === ct.id);
    assert(ct?.priceCents === 1600 && ct?.priceSynced === true && ct?.needsPriceReview === false, 'sync: takes the library price', ct);
    await call('PATCH', `/api/vendor/addon-library/${topperId}`, { token: tA, body: { priceCents: 1700 } });
    const ctRow = (await q(`SELECT price_cents FROM product_addons WHERE id=$1`, [ct.id]))[0];
    assert(ctRow?.price_cents === 1700, 'after sync it follows the library automatically', ctRow);
    const reviewB = await call('POST', `/api/business/products/${cake}/addons/${ct.id}/price-review`, { token: tB, body: { action: 'sync' } });
    assert(reviewB.status === 403, "another vendor can't answer the prompt", reviewB.status);

    console.log('rename');
    const rename = await call('PATCH', `/api/vendor/addon-library/${sprLib.id}`, { token: tA, body: { name: 'Rainbow sprinkles' } });
    assert(rename.status === 200, 'rename 200', rename.body);
    const renamed = await q(`SELECT DISTINCT name FROM product_addons WHERE business_addon_id=$1`, [sprLib.id]);
    assert(renamed.length === 1 && renamed[0].name === 'Rainbow sprinkles', 'name reached both products', renamed);
    const clash = await call('PATCH', `/api/vendor/addon-library/${sprLib.id}`, { token: tA, body: { name: 'cake topper' } });
    assert(clash.status === 409, 'name used by another library add-on → 409', clash.body);
    await call('PUT', `/api/business/products/${cookie}/addons`, { token: tA, body: { groups: [
      { id: cookieSave.body.groups[0].id, name: 'Extras', addons: [
        { id: cookieSave.body.groups[0].addons[0].id, name: 'Rainbow sprinkles', priceCents: 400 },
        { name: 'Glitter', priceCents: 100 },
      ] },
    ] } });
    const glitterLib = byName(await libGet(), 'Glitter');
    await call('DELETE', `/api/vendor/addon-library/${glitterLib.id}?includeProducts=true`, { token: tA });
    // Glitter's library entry is gone but a plain choice with that name can be typed back in a group.
    const cookieNow = (await call('GET', `/api/business/products/${cookie}/addons`, { token: tA })).body?.groups?.[0];
    await q(`INSERT INTO product_addons (group_id, product_id, name, price_cents) VALUES ($1,$2,'Edible glitter',100)`, [cookieNow.id, cookie]);
    const clash2 = await call('PATCH', `/api/vendor/addon-library/${sprLib.id}`, { token: tA, body: { name: 'Edible glitter' } });
    assert(clash2.status === 409 && clash2.body?.code === 'NAME_TAKEN_ON_PRODUCT', 'name already in that product group → 409', clash2.body);

    console.log('on/off with products');
    const kiwiLib = byName(await libGet(), 'Kiwi');
    // Make Fruit require 2 of Kiwi/Mango, then switch Kiwi off from the library.
    const cakeGroups = (await call('GET', `/api/business/products/${cake}/addons`, { token: tA })).body?.groups;
    const req2 = await call('PUT', `/api/business/products/${cake}/addons`, { token: tA, body: { groups: cakeGroups.map((g: any, i: number) => ({ ...g, minSelect: i === 0 ? 2 : g.minSelect })) } });
    assert(req2.status === 200, 'Fruit now needs 2', req2.body);
    const off = await call('POST', `/api/vendor/addon-library/${kiwiLib.id}/active`, { token: tA, body: { isActive: false, serviceIds: [], productIds: [cake] } });
    assert(off.status === 200 && off.body?.updatedProductIds?.[0] === cake, 'switched off on the cake', off.body);
    const pubOff = await call('GET', `/api/products/${cake}`);
    assert(!(pubOff.body?.addonGroups?.[0]?.addons ?? []).some((a: any) => a.name === 'Kiwi') && pubOff.body?.addonGroups?.[0]?.minSelect === 1, 'hidden from customers; Fruit now asks for 1', pubOff.body?.addonGroups?.[0]);
    const mangoId = pubOff.body?.addonGroups?.[0]?.addons?.[0]?.id;
    const pi2 = await call('POST', '/api/cart/payment-intent', { token: tC, body: { items: [{ productId: cake, vendorId: bizA, priceCents: 1, quantity: 1, addons: [{ addonId: mangoId }] }], shippingAddress: ship } });
    assert(pi2.status === 200, 'checkout still possible with one choice on', pi2.body);
    const notOn = await call('POST', `/api/vendor/addon-library/${kiwiLib.id}/active`, { token: tA, body: { isActive: true, serviceIds: [], productIds: [cookie] } });
    assert(notOn.status === 400 && notOn.body?.code === 'NOT_ATTACHED', 'product without it → 400', notOn.body);
    const oldClient = await call('POST', `/api/vendor/addon-library/${kiwiLib.id}/active`, { token: tA, body: { isActive: true, serviceIds: [] } });
    assert(oldClient.status === 200 && (await q(`SELECT is_active FROM product_addons WHERE business_addon_id=$1`, [kiwiLib.id]))[0]?.is_active === false, 'old clients (no productIds) leave products alone');

    console.log('apply to products');
    const apply = await call('POST', `/api/vendor/addon-library/${topperId}/products`, { token: tA, body: { targets: [
      { productId: cupcake }, { productId: cake }, { productId: oldItem },
    ] } });
    assert(apply.status === 200, 'apply 200', apply.body);
    assert(apply.body?.added?.length === 1 && apply.body.added[0].productId === cupcake, 'added to cupcakes', apply.body);
    const reasons = Object.fromEntries((apply.body?.skipped ?? []).map((s: any) => [s.productId, s.reason]));
    assert(reasons[cake] === 'already_added' && reasons[oldItem] === 'archived', 'skips: already on it, archived', reasons);
    const cup = (await call('GET', `/api/business/products/${cupcake}/addons`, { token: tA })).body?.groups ?? [];
    assert(cup.length === 1 && cup[0].name === 'Add-ons' && cup[0].minSelect === 0 && cup[0].maxSelect === null && cup[0].addons[0].priceCents === 1700 && cup[0].addons[0].priceSynced === true, 'new optional "Add-ons" group with the library price', cup);
    const into = await call('POST', `/api/vendor/addon-library/${kiwiLib.id}/products`, { token: tA, body: { targets: [{ productId: cupcake, groupId: cup[0].id }] } });
    assert(into.status === 200 && into.body?.added?.[0]?.groupId === cup[0].id, 'into a picked group', into.body);
    const badGroup = await call('POST', `/api/vendor/addon-library/${kiwiLib.id}/products`, { token: tA, body: { targets: [{ productId: cookie, groupId: cup[0].id }] } });
    assert(badGroup.status === 404, 'group of another product → 404', badGroup.status);
    const foreign = await call('POST', `/api/vendor/addon-library/${topperId}/products`, { token: tA, body: { targets: [{ productId: otherProduct }] } });
    assert(foreign.status === 404, "another vendor's product → 404", foreign.status);
    const foreignLib = await call('POST', `/api/vendor/addon-library/${topperId}/products`, { token: tB, body: { targets: [{ productId: otherProduct }] } });
    assert(foreignLib.status === 404, "another vendor can't use this library add-on", foreignLib.status);
    const pubCup = await call('GET', `/api/products/${cupcake}`);
    // The library Kiwi was switched back on above (old-client call), so the new copy is on too.
    assert(pubCup.body?.addonGroups?.[0]?.addons?.map((a: any) => a.name).join('|') === 'Cake topper|Kiwi', 'customers see both, in order', pubCup.body?.addonGroups);

    console.log('delete');
    const orderBefore = (await q(`SELECT items FROM orders WHERE id=$1`, [pi.body?.orderId]))[0]?.items?.[0];
    const refused = await call('DELETE', `/api/vendor/addon-library/${topperId}`, { token: tA });
    assert(refused.status === 409 && refused.body?.code === 'USED_ON_PRODUCTS' && /Cake|Cupcakes|products/.test(refused.body?.error ?? ''), 'old clients get a readable refusal', refused.body);
    const still = await q(`SELECT count(*)::int n FROM product_addons WHERE business_addon_id=$1`, [topperId]);
    assert(still[0].n === 2, 'nothing deleted', still);
    const del = await call('DELETE', `/api/vendor/addon-library/${topperId}?includeProducts=true`, { token: tA });
    assert(del.status === 200 && del.body?.removedFromProductIds?.length === 2 && del.body?.removedFromServiceIds?.[0] === tasting, 'deleted from products and the service', del.body);
    const cupAfter = (await call('GET', `/api/business/products/${cupcake}/addons`, { token: tA })).body?.groups ?? [];
    assert(cupAfter.length === 1 && cupAfter[0].addons.length === 1 && cupAfter[0].addons[0].name === 'Kiwi', 'group with Kiwi left kept', cupAfter);
    await call('DELETE', `/api/vendor/addon-library/${kiwiLib.id}?includeProducts=true`, { token: tA });
    const cupGone = (await call('GET', `/api/business/products/${cupcake}/addons`, { token: tA })).body?.groups ?? [];
    assert(cupGone.length === 0, 'group left empty is removed', cupGone);
    const orderAfter = (await q(`SELECT items FROM orders WHERE id=$1`, [pi.body?.orderId]))[0]?.items?.[0];
    assert(JSON.stringify(orderBefore) === JSON.stringify(orderAfter) && orderAfter?.addons?.length === 2, 'past order keeps its add-ons', orderAfter);
    const svcGone = await q(`SELECT count(*)::int n FROM service_addons WHERE service_id=$1`, [tasting]);
    assert(svcGone[0].n === 0, 'service copy removed as before');
    const libLeft = await libGet();
    assert(!byName(libLeft, 'Cake topper') && !byName(libLeft, 'Kiwi') && !!byName(libLeft, 'Rainbow sprinkles'), 'library updated', libLeft.map((x: any) => x.name));
  } finally {
    await q(`DELETE FROM orders WHERE business_id IN ($1,$2)`, [bizA, bizB]);
    await q(`DELETE FROM vendor_products WHERE business_id IN ($1,$2)`, [bizA, bizB]);
    await q(`DELETE FROM service_addons WHERE service_id=$1`, [tasting]);
    await q(`DELETE FROM vendor_services WHERE business_id IN ($1,$2)`, [bizA, bizB]);
    await q(`DELETE FROM business_addons WHERE business_id IN ($1,$2)`, [bizA, bizB]);
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
