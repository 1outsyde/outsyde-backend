/**
 * Business order cancel — HTTP integration tests (PATCH /api/business/orders/:id)
 *
 * Run with: npx tsx server/orderCancel.http.test.ts
 *
 * SCRATCH ONLY. Same setup as server/pointsRedeem.http.test.ts: a backend booted on localhost
 * against a LOCAL scratch Postgres, with STRIPE_STUB_PORT pointing at the stub started here.
 *   OC_TEST_BASE_URL     e.g. http://localhost:5062   (must be localhost)
 *   OC_TEST_PG_URL       the SAME scratch database (localhost only)
 *   OC_TEST_STRIPE_PORT  port for the Stripe stub started here (server booted with the same
 *                        STRIPE_STUB_PORT and NODE_OPTIONS="--import ./.dev/neon-preload.mjs
 *                        --import ./.dev/stripe-stub-preload.mjs")
 *   JWT_SECRET           identical to the server's
 * Skips (exit 0) when OC_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Rules checked (decided 2026-10-30):
 *   - a pending order (unpaid checkout) can't be cancelled: 409 ORDER_NOT_PAID, nothing changes
 *   - single shop (destination charge): refund + reversal of the charge's own transfer, as before
 *   - multi-vendor cart: the vendor's own transfer in the cart's group is reversed, found by
 *     orderId AND destination; an influencer transfer on the same order is never touched
 *   - no transfer found: the customer is still refunded, no reversal (manual reconciliation)
 *   - the reversal never asks for more than is left on the transfer
 *   - a repeated cancel request never refunds or reverses twice (fixed idempotency keys)
 */
import http from 'http';
import crypto from 'crypto';

const BASE = process.env.OC_TEST_BASE_URL;
const PG_URL = process.env.OC_TEST_PG_URL;
const STUB_PORT = Number(process.env.OC_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u?: string) => !!u && ['localhost', '127.0.0.1'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.97.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` };
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
  if (!BASE) { console.log('⏭  skipped: set OC_TEST_BASE_URL (+ OC_TEST_PG_URL, OC_TEST_STRIPE_PORT)'); process.exit(0); }
  if (!isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error('refusing to run: base URL and database must both be local, stub port required');

  const { generateAccessToken } = await import('./auth');
  const { findVendorOrderTransfer } = await import('./stripe/stripeService');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub ───────────────────────────────────────────────────────
  // pis: PaymentIntents by id. multi: true = separate charge and transfers (no transfer on the charge).
  const pis: Record<string, { id: string; amount: number; refunded: number; multi: boolean }> = {};
  const transfers: Array<{ id: string; amount: number; amount_reversed: number; destination: string; transfer_group: string; metadata: Record<string, string> }> = [];
  const refunds: Array<{ id: string; amount: number; payment_intent: string; key: string }> = [];
  const reversals: Array<{ id: string; transfer: string; amount: number; key: string }> = [];
  const idem: Record<string, unknown> = {};
  let seq = 0;
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const [url, qs] = (req.url || '').split('?');
      const query = new URLSearchParams(qs || '');
      const key = String(req.headers['idempotency-key'] || '');
      // Same idempotency key = Stripe returns the first result again.
      if (req.method === 'POST' && key && idem[key]) return send(200, idem[key]);
      const view = (pi: any) => ({
        id: pi.id, object: 'payment_intent', status: 'succeeded', amount: pi.amount, amount_received: pi.amount,
        latest_charge: { id: `ch_${pi.id}`, amount_refunded: pi.refunded, transfer: pi.multi ? null : `tr_charge_${pi.id}` },
      });
      let m = url.match(/^\/v1\/payment_intents\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const pi = pis[m[1]];
        return pi ? send(200, view(pi)) : send(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'no pi' } });
      }
      if (req.method === 'POST' && url === '/v1/refunds') {
        const pi = pis[form.get('payment_intent') || ''];
        const amount = Number(form.get('amount') || 0);
        if (!pi || amount > pi.amount - pi.refunded) return send(400, { error: { type: 'invalid_request_error', message: 'Refund amount is greater than charge' } });
        pi.refunded += amount;
        const r = { id: `re_${++seq}`, object: 'refund', amount, payment_intent: pi.id, key };
        refunds.push(r);
        if (key) idem[key] = r;
        return send(200, r);
      }
      if (req.method === 'GET' && url === '/v1/transfers') {
        const g = query.get('transfer_group');
        return send(200, { object: 'list', has_more: false, data: transfers.filter((t) => !g || t.transfer_group === g) });
      }
      m = url.match(/^\/v1\/transfers\/([^/]+)\/reversals$/);
      if (req.method === 'POST' && m) {
        const amount = Number(form.get('amount') || 0);
        const t = transfers.find((x) => x.id === m![1]);
        if (t) {
          if (amount > t.amount - t.amount_reversed) return send(400, { error: { type: 'invalid_request_error', message: 'Reversal is greater than the transfer' } });
          t.amount_reversed += amount;
        }
        const r = { id: `trr_${++seq}`, object: 'transfer_reversal', amount, transfer: m[1], key };
        reversals.push(r);
        if (key) idem[key] = r;
        return send(200, r);
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ──────────────────────────────────────────────────────────────
  const P = `oc${Date.now().toString(36)}`;
  const userIds: string[] = [];
  const bizIds: string[] = [];
  const orderIds: string[] = [];
  const groupIds: string[] = [];
  const mkUser = async (name: string) => {
    const id = crypto.randomUUID();
    await q(`INSERT INTO users (id, username, email, is_active) VALUES ($1, $2, $3, true)`, [id, `${P}${name}`, `${P}-${name}@x.test`]);
    userIds.push(id);
    return id;
  };
  const mkBiz = async (owner: string, acct: string) => {
    const id = crypto.randomUUID();
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, $3, 'beauty', 'approved', $4, true)`, [id, owner, `${P} ${acct}`, acct]);
    bizIds.push(id);
    return id;
  };
  const ownerA = await mkUser('ownerA');
  const ownerB = await mkUser('ownerB');
  const customer = await mkUser('cust');
  const acctA = `acct_${P}_A`;
  const acctB = `acct_${P}_B`;
  const acctInfluencer = `acct_${P}_inf`;
  const bizA = await mkBiz(ownerA, acctA);
  const bizB = await mkBiz(ownerB, acctB);
  const tokenA = generateAccessToken({ userId: ownerA, isVendor: true, isAdmin: false });
  const tokenB = generateAccessToken({ userId: ownerB, isVendor: true, isAdmin: false });

  const mkGroup = async () => {
    const id = crypto.randomUUID();
    await q(`INSERT INTO order_groups (id, customer_id, total_vendors) VALUES ($1, $2, 2)`, [id, customer]);
    groupIds.push(id);
    return id;
  };
  const mkOrder = async (o: { biz: string; status: string; total: number; vendorNet: number; pi?: string; group?: string }) => {
    const id = crypto.randomUUID();
    await q(`INSERT INTO orders (id, business_id, customer_id, items, total_amount, vendor_net, status, stripe_payment_intent_id, order_group_id)
             VALUES ($1, $2, $3, '[]'::jsonb, $4, $5, $6, $7, $8)`,
      [id, o.biz, customer, o.total, o.vendorNet, o.status, o.pi ?? null, o.group ?? null]);
    orderIds.push(id);
    return id;
  };
  const statusOf = async (id: string) => (await q(`SELECT status FROM orders WHERE id = $1`, [id]))[0]?.status;
  const auditOf = async (id: string) => (await q(`SELECT metadata FROM audit_logs WHERE target_id = $1 AND action = 'order_refund_issued'`, [id]))[0]?.metadata;
  const cancel = (id: string, token: string) => call('PATCH', `/api/business/orders/${id}`, { token, body: { status: 'cancelled' } });

  try {
    // ── 1. pending order: refused ─────────────────────────────────────
    console.log('\n── 1. pending order (unpaid checkout) ──');
    const piPending = `pi_${P}_pending`;
    pis[piPending] = { id: piPending, amount: 5400, refunded: 0, multi: false };
    const oPending = await mkOrder({ biz: bizA, status: 'pending', total: 5000, vendorNet: 4900, pi: piPending });
    let r = await cancel(oPending, tokenA);
    assert(r.status === 409 && r.body?.code === 'ORDER_NOT_PAID', 'pending cancel refused with 409 ORDER_NOT_PAID', r);
    assert(typeof r.body?.error === 'string' && !/[—–]| - |%/.test(r.body.error), 'error text: no dashes, no percentages', r.body?.error);
    assert(await statusOf(oPending) === 'pending', 'order stays pending');
    assert(!refunds.some((x) => x.payment_intent === piPending) && reversals.length === 0, 'no refund, no reversal');
    r = await call('PATCH', `/api/business/orders/${oPending}`, { token: tokenA, body: { status: 'paid' } });
    assert(r.status === 200 && await statusOf(oPending) === 'paid', 'other changes on a pending order still work (pending to paid)', r);

    // ── 2. single shop: unchanged path ────────────────────────────────
    console.log('\n── 2. single shop (destination charge) ──');
    const piSingle = `pi_${P}_single`;
    pis[piSingle] = { id: piSingle, amount: 5400, refunded: 0, multi: false };
    const oSingle = await mkOrder({ biz: bizA, status: 'paid', total: 5000, vendorNet: 4900, pi: piSingle });
    r = await cancel(oSingle, tokenA);
    assert(r.status === 200 && await statusOf(oSingle) === 'cancelled', 'paid order cancelled', r);
    const refSingle = refunds.filter((x) => x.payment_intent === piSingle);
    assert(refSingle.length === 1 && refSingle[0].amount === 5000, 'customer refunded the order amount once', refSingle);
    assert(refSingle[0]?.key === `order_cancel_refund_${oSingle}`, 'refund sent with the fixed idempotency key', refSingle[0]?.key);
    const revSingle = reversals.filter((x) => x.transfer === `tr_charge_${piSingle}`);
    assert(revSingle.length === 1 && revSingle[0].amount === 4900, 'reversal on the charge transfer for the vendor amount', revSingle);
    assert(revSingle[0]?.key === `order_cancel_reversal_${oSingle}`, 'reversal sent with the fixed idempotency key', revSingle[0]?.key);
    const audSingle = await auditOf(oSingle);
    assert(!!audSingle?.stripeRefundId && audSingle?.stripeTransferReversalId === revSingle[0]?.id, 'audit log has refund and reversal ids', audSingle);

    // ── 3. multi-vendor cart: the vendor's own transfer ───────────────
    console.log('\n── 3. multi-vendor cart ──');
    const group = await mkGroup();
    const piMulti = `pi_${P}_multi`;
    pis[piMulti] = { id: piMulti, amount: 8640, refunded: 0, multi: true };
    const oMultiA = await mkOrder({ biz: bizA, status: 'paid', total: 5000, vendorNet: 4900, pi: piMulti, group });
    const oMultiB = await mkOrder({ biz: bizB, status: 'paid', total: 3000, vendorNet: 2940, pi: piMulti, group });
    const tg = `order_group_${group}`;
    transfers.push(
      { id: `tr_${P}_infA`, amount: 250, amount_reversed: 0, destination: acctInfluencer, transfer_group: tg, metadata: { orderId: oMultiA, type: 'multi_vendor_cart_transfer' } },
      { id: `tr_${P}_A`, amount: 4900, amount_reversed: 0, destination: acctA, transfer_group: tg, metadata: { orderId: oMultiA, type: 'multi_vendor_cart_transfer' } },
      { id: `tr_${P}_B`, amount: 2940, amount_reversed: 0, destination: acctB, transfer_group: tg, metadata: { orderId: oMultiB, type: 'multi_vendor_cart_transfer' } },
    );
    r = await cancel(oMultiA, tokenA);
    assert(r.status === 200 && await statusOf(oMultiA) === 'cancelled', 'vendor A cancels their order in the cart', r);
    assert(refunds.filter((x) => x.payment_intent === piMulti).reduce((s, x) => s + x.amount, 0) === 5000, 'customer refunded vendor A order amount', refunds);
    const revA = reversals.filter((x) => x.transfer === `tr_${P}_A`);
    assert(revA.length === 1 && revA[0].amount === 4900, "vendor A's own transfer reversed for the vendor amount", reversals);
    assert(!reversals.some((x) => x.transfer === `tr_${P}_infA`), 'influencer transfer on the same order not touched');
    assert(!reversals.some((x) => x.transfer === `tr_${P}_B`) && await statusOf(oMultiB) === 'paid', "vendor B's transfer and order not touched");
    assert((await auditOf(oMultiA))?.stripeTransferReversalId === revA[0]?.id, 'audit log has the reversal id');

    // ── 4. partly reversed transfer: capped ───────────────────────────
    console.log('\n── 4. transfer already partly reversed ──');
    transfers.find((t) => t.id === `tr_${P}_B`)!.amount_reversed = 2000;
    r = await cancel(oMultiB, tokenB);
    assert(r.status === 200, 'vendor B cancels', r);
    const revB = reversals.filter((x) => x.transfer === `tr_${P}_B`);
    assert(revB.length === 1 && revB[0].amount === 940, 'reversal capped at what is left on the transfer (2940 - 2000)', revB);

    // ── 5. no transfer found: refund still goes out ───────────────────
    console.log('\n── 5. multi-vendor, transfer missing ──');
    const group2 = await mkGroup();
    const piLost = `pi_${P}_lost`;
    pis[piLost] = { id: piLost, amount: 3240, refunded: 0, multi: true };
    const oLost = await mkOrder({ biz: bizA, status: 'paid', total: 3000, vendorNet: 2940, pi: piLost, group: group2 });
    const revBefore = reversals.length;
    r = await cancel(oLost, tokenA);
    assert(r.status === 200 && await statusOf(oLost) === 'cancelled', 'cancel still succeeds', r);
    assert(refunds.some((x) => x.payment_intent === piLost && x.amount === 3000), 'customer still refunded');
    assert(reversals.length === revBefore && (await auditOf(oLost))?.stripeTransferReversalId == null, 'no reversal (left for manual reconciliation, as before)');

    // ── 6. lookup helper: ambiguous matches are never guessed ─────────
    console.log('\n── 6. lookup helper ──');
    const fake = (data: any[]) => ({ transfers: { list: async () => ({ data }) } });
    const one = await findVendorOrderTransfer(fake([{ id: 't1', amount: 100, amount_reversed: 0, destination: 'acct_x', metadata: { orderId: 'o1' } }]), { transferGroup: 'g', orderId: 'o1', vendorAccountId: 'acct_x' });
    assert(one?.id === 't1' && one.reversibleCents === 100, 'one match is used');
    const two = await findVendorOrderTransfer(fake([
      { id: 't1', amount: 100, destination: 'acct_x', metadata: { orderId: 'o1' } },
      { id: 't2', amount: 100, destination: { id: 'acct_x' }, metadata: { orderId: 'o1' } },
    ]), { transferGroup: 'g', orderId: 'o1', vendorAccountId: 'acct_x' });
    assert(two === null, 'two matches: none used (manual reconciliation)');
    const otherDest = await findVendorOrderTransfer(fake([{ id: 't3', amount: 100, destination: 'acct_inf', metadata: { orderId: 'o1' } }]), { transferGroup: 'g', orderId: 'o1', vendorAccountId: 'acct_x' });
    assert(otherDest === null, 'same order, other destination: not used');

    // ── 7. double request: one refund, one reversal ──────────────────
    console.log('\n── 7. double request ──');
    const piTwice = `pi_${P}_twice`;
    pis[piTwice] = { id: piTwice, amount: 5400, refunded: 0, multi: false };
    const oTwice = await mkOrder({ biz: bizA, status: 'paid', total: 5000, vendorNet: 4900, pi: piTwice });
    const [r1, r2] = await Promise.all([cancel(oTwice, tokenA), cancel(oTwice, tokenA)]);
    assert([r1.status, r2.status].includes(200), 'one of the two requests cancels the order', [r1, r2]);
    assert(await statusOf(oTwice) === 'cancelled', 'order cancelled');
    assert(pis[piTwice].refunded === 5000, 'customer refunded exactly once (5000, not 10000)', pis[piTwice]);
    assert(reversals.filter((x) => x.transfer === `tr_charge_${piTwice}`).length === 1, 'vendor transfer reversed exactly once');

    // ── 8. double request on a small slice of a multi-vendor charge ──
    // Two $30 refunds both fit under an $86.40 cart charge, so Stripe's own limit
    // would not stop a second one. The fixed idempotency key must.
    console.log('\n── 8. double request, multi-vendor slice ──');
    const group3 = await mkGroup();
    const piSlice = `pi_${P}_slice`;
    pis[piSlice] = { id: piSlice, amount: 8640, refunded: 0, multi: true };
    const oSlice = await mkOrder({ biz: bizB, status: 'paid', total: 3000, vendorNet: 2940, pi: piSlice, group: group3 });
    transfers.push({ id: `tr_${P}_slice`, amount: 5000, amount_reversed: 0, destination: acctB, transfer_group: `order_group_${group3}`, metadata: { orderId: oSlice } });
    const [s1, s2] = await Promise.all([cancel(oSlice, tokenB), cancel(oSlice, tokenB)]);
    assert([s1.status, s2.status].includes(200), 'one of the two requests cancels the order', [s1.status, s2.status]);
    assert(pis[piSlice].refunded === 3000, 'customer refunded exactly once (3000, not 6000)', pis[piSlice]);
    assert(transfers.find((t) => t.id === `tr_${P}_slice`)!.amount_reversed <= 2940, 'vendor transfer reversed at most once');
  } finally {
    // ── cleanup ───────────────────────────────────────────────────────
    await q(`DELETE FROM audit_logs WHERE target_id = ANY($1)`, [orderIds]).catch(() => {});
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [userIds]).catch(() => {});
    await q(`DELETE FROM orders WHERE id = ANY($1)`, [orderIds]).catch(() => {});
    await q(`DELETE FROM order_groups WHERE id = ANY($1)`, [groupIds]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizIds]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [userIds]).catch(() => {});
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
