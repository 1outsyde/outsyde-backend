/**
 * R24 — the old checkout "continue" route can't mark an order paid — HTTP + webhook test
 *
 * Run with: npx tsx server/checkoutContinueRemoved.http.test.ts
 *
 * SCRATCH ONLY. Same setup as server/orderCancel.http.test.ts: a backend booted on localhost
 * against a LOCAL scratch Postgres. This file also calls the webhook handler in process, so run
 * it with the server's DATABASE_URL and NODE_OPTIONS="--import ./.dev/neon-preload.mjs".
 *   CC_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   CC_TEST_PG_URL     the SAME scratch database (localhost only)
 * Skips (exit 0) when CC_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Checked (vault R24, 2026-10-30):
 *   - a signed in customer (session cookie, the only check the route had) calling
 *     GET /api/cart/checkout/continue/:orderGroupId?completedOrderId=<own unpaid order>
 *     does NOT make the order paid, and the group count is unchanged
 *   - the real payment path still works: checkout.session.completed (cart_checkout) marks the
 *     order paid and stores the real PaymentIntent id
 */
import http from 'http';
import crypto from 'crypto';

const BASE = process.env.CC_TEST_BASE_URL;
const PG_URL = process.env.CC_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u?: string) => !!u && ['localhost', '127.0.0.1'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { cookie?: string; body?: unknown } = {}): Promise<{ status: number; body: any; setCookie: string[]; contentType: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.96.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.cookie) headers['Cookie'] = o.cookie;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json: any = null; try { json = JSON.parse(b); } catch {}
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode || 0, body: json, setCookie: Array.isArray(sc) ? sc : sc ? [sc] : [], contentType: String(res.headers['content-type'] || '') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log('⏭  skipped: set CC_TEST_BASE_URL (+ CC_TEST_PG_URL)'); process.exit(0); }
  if (!isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: base URL and database must both be local');

  const { hashPassword } = await import('./auth');
  const { WebhookHandlers } = await import('./stripe/webhookHandlers');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `cc${Date.now().toString(36)}`;
  const userIds: string[] = [];
  const bizIds: string[] = [];
  const orderIds: string[] = [];
  let groupId = '';
  try {
    // ── seed: one customer with a password, two shops, a multi-vendor group, two unpaid orders ──
    const password = `Pw-${P}-123456`;
    const customer = crypto.randomUUID();
    const email = `${P}-cust@x.test`;
    await q(`INSERT INTO users (id, username, email, password, is_active) VALUES ($1, $2, $3, $4, true)`, [customer, `${P}cust`, email, await hashPassword(password)]);
    userIds.push(customer);
    for (const n of ['A', 'B']) {
      const owner = crypto.randomUUID();
      await q(`INSERT INTO users (id, username, email, is_active) VALUES ($1, $2, $3, true)`, [owner, `${P}own${n}`, `${P}-own${n}@x.test`]);
      userIds.push(owner);
      const biz = crypto.randomUUID();
      await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, $3, 'beauty', 'approved', $4, true)`, [biz, owner, `${P} ${n}`, `acct_${P}_${n}`]);
      bizIds.push(biz);
    }
    groupId = crypto.randomUUID();
    await q(`INSERT INTO order_groups (id, customer_id, total_vendors) VALUES ($1, $2, 2)`, [groupId, customer]);
    for (const biz of bizIds) {
      const id = crypto.randomUUID();
      await q(`INSERT INTO orders (id, business_id, customer_id, items, total_amount, vendor_net, status, order_group_id, stripe_payment_intent_id)
               VALUES ($1, $2, $3, '[]'::jsonb, 5000, 4900, 'pending', $4, $5)`, [id, biz, customer, groupId, `cs_test_${P}_${orderIds.length}`]);
      orderIds.push(id);
    }
    const [orderA] = orderIds;
    const statusOf = async (id: string) => (await q(`SELECT status, stripe_payment_intent_id FROM orders WHERE id = $1`, [id]))[0];

    // ── 1. the exploit: signed in customer, own unpaid order ─────────────
    console.log('\n── 1. continue link with completedOrderId ──');
    const login = await call('POST', '/api/auth/login', { body: { email, password } });
    const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
    assert(login.status === 200 && cookie.length > 0, 'customer signed in with a session cookie (what the route checked)', { s: login.status, cookie: !!cookie });
    const r = await call('GET', `/api/cart/checkout/continue/${groupId}?completedOrderId=${orderA}`, { cookie });
    assert(!(r.body && typeof r.body === 'object' && ('completed' in r.body || 'url' in r.body)), 'the continue route no longer answers', { s: r.status, ct: r.contentType, body: r.body });
    assert((await statusOf(orderA)).status === 'pending', 'the unpaid order stays pending (not paid)', await statusOf(orderA));
    const g = (await q(`SELECT completed_vendors, status FROM order_groups WHERE id = $1`, [groupId]))[0];
    assert((g.completed_vendors ?? 0) === 0 && g.status !== 'completed', 'order group count and status unchanged', g);

    // ── 2. the real payment path still marks it paid ─────────────────────
    console.log('\n── 2. checkout.session.completed (cart_checkout) ──');
    const realPi = `pi_${P}_real`;
    await WebhookHandlers.handleCartCheckoutCompleted({
      id: `cs_test_${P}_0`,
      payment_intent: realPi,
      metadata: { type: 'cart_checkout', orderId: orderA, orderGroupId: groupId, userId: customer, businessId: bizIds[0], isMultiVendor: 'true' },
    });
    const after = await statusOf(orderA);
    assert(after.status === 'paid', 'the webhook marks the order paid', after);
    assert(after.stripe_payment_intent_id === realPi, 'the real PaymentIntent id is stored (cancel refunds need it)', after);
    assert((await statusOf(orderIds[1])).status === 'pending', 'the other vendor order is untouched');
  } finally {
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [userIds]).catch(() => {});
    await q(`DELETE FROM point_transactions WHERE user_id = ANY($1)`, [userIds]).catch(() => {});
    await q(`DELETE FROM pending_points_transactions WHERE user_id = ANY($1)`, [userIds]).catch(() => {});
    await q(`DELETE FROM orders WHERE id = ANY($1)`, [orderIds]).catch(() => {});
    if (groupId) await q(`DELETE FROM order_groups WHERE id = $1`, [groupId]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizIds]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [userIds]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
