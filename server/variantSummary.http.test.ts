/**
 * variantSummary on the public storefront list — HTTP integration test
 *
 * Run with: npx tsx server/variantSummary.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema,
 * migration 049 applied). Environment variables:
 *   VS_TEST_BASE_URL   e.g. http://localhost:5091   (must be localhost)
 *   VS_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 * Skips (exit 0) when VS_TEST_BASE_URL is unset and refuses any non-local host.
 *
 * What it proves (GET /api/businesses/:id/products):
 *  - Dia Lux style product: count, From/To price (blank variation price = product price), "11 Length"
 *  - switched-off variations are left out
 *  - a product without variations gets variantSummary null and is otherwise unchanged
 *  - older label-only variations count with no option names
 *  - draft products are still not listed
 *  - every field the list returned before is still there with the same value
 */

import http from 'http';

const BASE = process.env.VS_TEST_BASE_URL;
const PG_URL = process.env.VS_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, headers: { 'X-Forwarded-For': '10.99.4.10' } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    }).on('error', reject);
  });
}

(async () => {
  if (!BASE || !PG_URL) {
    console.log('skipped: set VS_TEST_BASE_URL and VS_TEST_PG_URL to a local backend and scratch database');
    process.exit(0);
  }
  if (!isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run against a non-local host');

  const pg = (await import('pg')).default;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

  const P = `vs${Date.now().toString(36)}`;
  const vendor = `${P}-v`, biz = `${P}-b`;
  const dialux = `${P}-dl`, plain = `${P}-plain`, legacy = `${P}-legacy`, draft = `${P}-draft`;
  try {
    const tier = (await q(`SELECT id FROM subscription_tiers LIMIT 1`)).rows[0]?.id;
    if (!tier) throw new Error('scratch database has no subscription_tiers row');
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar,$1::text,$2,true)`, [vendor, `${vendor}@t.test`]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_onboarding_complete) VALUES ($1,$2,'Summary Test','retail','approved',true)`, [biz, vendor]);
    await q(`INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, status, stripe_subscription_id, current_period_end) VALUES ($1,$2,$3,'active','sub_vs_test', now() + interval '30 days')`, [vendor, biz, tier]);
    const product = (id: string, name: string, price: number, status = 'live') =>
      q(`INSERT INTO vendor_products (id, business_id, name, price, inventory, track_inventory, is_active, status) VALUES ($1,$2,$3,$4,10,true,true,$5)`, [id, biz, name, price, status]);
    await product(dialux, 'Raw Straight', 12500);
    await product(plain, 'Edge Control', 1500);
    await product(legacy, 'Wig Cap', 800);
    await product(draft, 'Unreleased', 9900, 'draft');

    await q(`INSERT INTO product_options (product_id, position, name, values) VALUES ($1,1,'Length',$2::jsonb)`,
      [dialux, JSON.stringify([12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34].map((n) => ({ value: `${n}"` })))]);
    const lengths = [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];
    for (const [i, n] of lengths.entries()) {
      await q(`INSERT INTO product_variants (product_id, label, price_cents, inventory, track_inventory, sort_order, is_active, option1) VALUES ($1,$2,$3,5,true,$4,true,$2)`,
        [dialux, `${n}"`, i === 0 ? null : [0, 13500, 14500, 15500, 16500, 17500, 18500, 19500, 20500, 22500, 23500][i], i]);
    }
    // switched off: must not count (would raise the max to $300 and add a 12th length)
    await q(`INSERT INTO product_variants (product_id, label, price_cents, inventory, track_inventory, sort_order, is_active, option1) VALUES ($1,'34"',30000,5,true,11,false,'34"')`, [dialux]);
    await q(`INSERT INTO product_variants (product_id, label, price_cents, inventory, track_inventory, sort_order, is_active) VALUES ($1,'Black',NULL,5,true,0,true),($1,'Nude',1000,5,true,1,true)`, [legacy]);
    await q(`INSERT INTO product_variants (product_id, label, price_cents, inventory, track_inventory, sort_order, is_active) VALUES ($1,'Only',NULL,5,true,0,true)`, [draft]);

    const res = await get(`/api/businesses/${biz}/products`);
    assert(res.status === 200, 'list returns 200', res.status);
    const list: any[] = res.body?.products ?? [];
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));

    assert(list.length === 3 && !byId[draft], 'draft product still not listed', list.map((p) => p.name));
    assert(JSON.stringify(byId[dialux]?.variantSummary) === JSON.stringify({ count: 11, minPriceCents: 12500, maxPriceCents: 23500, options: [{ name: 'Length', valueCount: 11 }] }),
      'Dia Lux: 11 lengths, From $125 to $235, switched-off 34" left out', byId[dialux]?.variantSummary);
    assert(byId[plain]?.variantSummary === null, 'product without variations: variantSummary null', byId[plain]?.variantSummary);
    assert(JSON.stringify(byId[legacy]?.variantSummary) === JSON.stringify({ count: 2, minPriceCents: 800, maxPriceCents: 1000, options: [] }),
      'label-only variations: count 2, $8 to $10, no option names', byId[legacy]?.variantSummary);

    // Every field the list returned before is unchanged.
    const before = (await q(`SELECT id FROM vendor_products WHERE business_id=$1`, [biz])).rows.length;
    assert(before === 4, 'seed has 4 products');
    const p = byId[plain];
    assert(p && p.name === 'Edge Control' && p.price === 1500 && p.status === 'live' && p.isActive === true && p.businessId === biz && p.inventory === 10,
      'existing fields (name, price, status, isActive, businessId, inventory) unchanged', p);
    const expectedKeys = Object.keys(byId[dialux]).filter((k) => k !== 'variantSummary').sort();
    const plainKeys = Object.keys(p).filter((k) => k !== 'variantSummary').sort();
    assert(JSON.stringify(expectedKeys) === JSON.stringify(plainKeys) && expectedKeys.includes('price') && expectedKeys.includes('imageUrl'),
      'only variantSummary was added; product keys are the same as before', plainKeys);
  } finally {
    await q(`DELETE FROM product_variants WHERE product_id IN ($1,$2,$3,$4)`, [dialux, plain, legacy, draft]);
    await q(`DELETE FROM product_options WHERE product_id IN ($1,$2,$3,$4)`, [dialux, plain, legacy, draft]);
    await q(`DELETE FROM vendor_products WHERE business_id=$1`, [biz]);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id=$1`, [biz]);
    await q(`DELETE FROM businesses WHERE id=$1`, [biz]);
    await q(`DELETE FROM users WHERE id=$1`, [vendor]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
