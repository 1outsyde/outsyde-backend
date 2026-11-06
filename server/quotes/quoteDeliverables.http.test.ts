/**
 * Deliverable quotes, step D1a (Legend 2026-11-06, plan calls 1 to 12 as recommended, call 5 revised): sending and
 * editing a deliverable with Pickup or Delivery, the delivery fee line, the business's own product, and the delivery
 * address the customer adds before paying. Paying a deliverable is still refused (D1b).
 *
 * Run with: npx tsx server/quotes/quoteDeliverables.http.test.ts
 *
 * SCRATCH ONLY. Backend booted on localhost against a LOCAL scratch Postgres (migrations through 106 applied):
 *   QD_TEST_BASE_URL   e.g. http://localhost:5062 (must be localhost)
 *   QD_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when QD_TEST_BASE_URL is unset; refuses any non-local host.
 */
import http from 'http';

const BASE = process.env.QD_TEST_BASE_URL;
const PG_URL = process.env.QD_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.97.1.${Math.floor(Math.random() * 200) + 1}` };
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

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

(async () => {
  if (!BASE) { console.log('⏭  skipped: set QD_TEST_BASE_URL (+ QD_TEST_PG_URL) to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: BASE and PG_URL must both be localhost');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'qt-test-jwt-secret';
  const { generateAccessToken } = await import('../auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `qd${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, first = 'Ana') => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3)`, [uid, `${uid}@qd.test`, first]);
    users.push(uid);
    return { uid, token: generateAccessToken({ userId: uid, isVendor: false, isAdmin: false }) };
  };
  const mkBiz = async (key: string, ownerId: string) => {
    const bid = id(`b-${key}`);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, time_zone) VALUES ($1, $2, $3, 'food', 'approved', 'America/New_York')`, [bid, ownerId, `Sweets ${key}`]);
    bizs.push(bid);
    return bid;
  };
  const mkConv = async (a: string, b: string) => {
    const [p1, p2] = a < b ? [a, b] : [b, a];
    const cid = id(`c-${a.slice(-5)}-${b.slice(-5)}`);
    await q(`INSERT INTO conversations (id, participant1_id, participant2_id) VALUES ($1, $2, $3)`, [cid, p1, p2]);
    return cid;
  };

  const owner = await mkUser('owner', 'Jazzy');
  const owner2 = await mkUser('owner2', 'Other');
  const staffUser = await mkUser('staff', 'Kim');
  const cust = await mkUser('cust');
  const cust2 = await mkUser('cust2', 'Bo');
  const stranger = await mkUser('x');
  const biz = await mkBiz('a', owner.uid);
  const biz2 = await mkBiz('b', owner2.uid);
  const staffId = id('staff');
  await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, role, status) VALUES ($1, $2, $3, 'Kim', 'staff', 'active')`, [staffId, biz, staffUser.uid]);
  const prod = id('p1'); const prodDraft = id('p2'); const prodArchived = id('p3'); const prodOther = id('p4'); const prodOff = id('p5');
  await q(`INSERT INTO vendor_products (id, business_id, name, price, status, is_active) VALUES ($1, $2, 'Custom cakes', 5000, 'live', true), ($3, $2, 'Wedding cakes', 9000, 'draft', true), ($4, $2, 'Old cake', 4000, 'archived', true), ($5, $6, 'Their cake', 4000, 'live', true), ($7, $2, 'Hidden cake', 4000, 'live', false)`, [prod, biz, prodDraft, prodArchived, prodOther, biz2, prodOff]);
  const svc = id('svc');
  await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status) VALUES ($1, $2, 'Cake tasting', 3000, 60, true, 'live')`, [svc, biz]);
  const conv = await mkConv(owner.uid, cust.uid);
  const convStaff = await mkConv(staffUser.uid, cust2.uid);

  const cake = (o: Record<string, unknown> = {}) => ({
    conversationId: conv, kind: 'product', title: 'Two tier birthday cake', details: 'Vanilla, strawberry filling',
    dueDate: daysFromNow(14), totalCents: 20000, paymentMode: 'full', ...o,
  });
  const svcBody = (o: Record<string, unknown> = {}) => ({
    conversationId: conv, title: 'Cake tasting', jobDate: daysFromNow(10), startTime: '15:00', durationMinutes: 60, totalCents: 3000, paymentMode: 'full', ...o,
  });
  const send = async (body: Record<string, unknown>, token = owner.token) => call('POST', '/api/quotes', { token, body });
  const edit = async (quoteId: string, version: number, body: Record<string, unknown>) => call('PATCH', `/api/quotes/${quoteId}`, { token: owner.token, body: { ...body, version } });
  const addr = async (quoteId: string, address: unknown, token = cust.token) => call('POST', `/api/quotes/${quoteId}/delivery-address`, { token, body: { address } });
  const msgs = async (cid: string) => q(`SELECT kind, card, content, sender_id FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [cid]);

  try {
    console.log('\n── sending a deliverable ──');
    const pick = await send(cake({ productId: prod }));
    const qp = pick.body?.quote;
    assert(pick.status === 201 && qp?.kind === 'product' && qp.fulfillment === 'pickup' && qp.deliveryFeeCents === null && qp.deliveryAddress === null && qp.productId === prod, 'no choice sent: Pickup, with the product', pick.body);
    assert(qp?.startsAt === null && qp.jobDate === null && qp.dueDate === daysFromNow(14), 'no job time, a ready by date', qp);
    const pc = (await q(`SELECT card FROM messages WHERE id = $1`, [qp?.messageId]))[0]?.card;
    assert(pc?.fulfillment === 'pickup' && pc.deliveryFeeCents === null && !('deliveryAddress' in pc), 'the chat card says Pickup and never carries an address', pc);

    const del = await send(cake({ fulfillment: 'delivery', deliveryFeeCents: 2000 }));
    const qd = del.body?.quote;
    assert(del.status === 201 && qd?.fulfillment === 'delivery' && qd.deliveryFeeCents === 2000 && qd.totalCents === 20000 && qd.productId === null, 'Delivery with a $20 fee line inside the $200 total', del.body);
    assert(qd?.amounts?.depositOrTotalCents === 20000, 'the fee line is inside the total, the amounts are unchanged', qd?.amounts);

    const r1 = await send(cake({ fulfillment: 'pickup', deliveryFeeCents: 500 }));
    assert(r1.status === 400 && r1.body?.field === 'deliveryFeeCents', 'no delivery fee on Pickup', r1.body);
    const r2 = await send(cake({ fulfillment: 'delivery', deliveryFeeCents: 20000 }));
    assert(r2.status === 400 && r2.body?.field === 'deliveryFeeCents', 'the fee must be less than the total', r2.body);
    const r3 = await send(cake({ paymentMode: 'deposit', depositCents: 5000 }));
    assert(r3.status === 400 && r3.body?.field === 'restPaid', 'a deposit with the rest through Outsyde is refused for now', r3.body);
    const r4 = await send(cake({ paymentMode: 'deposit', depositCents: 5000, restPaid: 'outside' }));
    assert(r4.status === 201 && r4.body?.quote?.restPaid === 'outside' && r4.body.quote.amounts.depositOrTotalCents === 5000, 'a deposit with the rest paid directly to the business', r4.body);

    console.log('\n── the product it is for ──');
    const p2 = await send(cake({ productId: prodDraft }));
    assert(p2.status === 201 && p2.body?.quote?.productId === prodDraft, 'a draft product of your own is fine (custom work is often unlisted)', p2.body);
    for (const [pid, name] of [[prodArchived, 'an archived product'], [prodOther, "another business's product"], [prodOff, 'a turned off product'], ['nope', 'a product that does not exist']] as const) {
      const r = await send(cake({ productId: pid }));
      assert(r.status === 400 && r.body?.field === 'productId', `refuses ${name}`, r.body);
    }
    const r5 = await send(svcBody({ productId: prod }));
    assert(r5.status === 400 && r5.body?.field === 'productId', 'a service quote takes no product', r5.body);

    console.log('\n── services and older apps are unchanged ──');
    const s1 = await send(svcBody({ serviceId: svc }));
    assert(s1.status === 201 && s1.body?.quote?.kind === 'service' && s1.body.quote.fulfillment === null && s1.body.quote.deliveryFeeCents === null && s1.body.quote.productId === null && s1.body.quote.deliveryAddress === null, 'a service quote sent as today (no new fields) gets nulls', s1.body);
    const r6 = await send(svcBody({ fulfillment: 'delivery' }));
    assert(r6.status === 400 && r6.body?.field === 'fulfillment', 'a service quote refuses Delivery', r6.body);
    const svcAddr = await addr(s1.body?.quote?.id, '12 Main St, Uniondale, NY');
    assert(svcAddr.status === 409 && svcAddr.body?.code === 'NOT_DELIVERY', 'a service quote takes no address', svcAddr.body);

    console.log('\n── the customer adds the delivery address ──');
    const before = (await msgs(conv)).length;
    const a0 = await addr(qd.id, '12 Main St');
    assert(a0.status === 200 && a0.body?.quote?.deliveryAddress === '12 Main St', 'a first address is saved', a0.body);
    const bad = await addr(qd.id, '12');
    assert(bad.status === 400 && bad.body?.field === 'address', 'too short is refused', bad.body);
    const a1 = await addr(qd.id, '  14 Oak Ave,\n Uniondale, NY 11553 ');
    assert(a1.status === 200 && a1.body?.quote?.deliveryAddress === '14 Oak Ave, Uniondale, NY 11553' && a1.body.quote.version === qd.version, 'saved on one line, the version stays (the terms did not change)', a1.body?.quote);
    const after = await msgs(conv);
    const textMsgs = after.slice(before).filter((m) => m.kind === 'text');
    assert(textMsgs.length >= 1 && textMsgs[textMsgs.length - 1].sender_id === cust.uid && textMsgs[textMsgs.length - 1].content === 'Delivery address for Two tier birthday cake: 14 Oak Ave, Uniondale, NY 11553' && textMsgs[textMsgs.length - 1].card === null, 'a plain message from the customer tells the business', textMsgs);
    const n1 = (await msgs(conv)).length;
    const same = await addr(qd.id, '14 Oak Ave, Uniondale, NY 11553');
    assert(same.status === 200 && (await msgs(conv)).length === n1, 'the same address again posts nothing new', same.status);
    for (const [tok, who] of [[owner.token, 'the business'], [stranger.token, 'a stranger'], [cust2.token, 'another customer']] as const) {
      const r = await addr(qd.id, '1 Other Rd, Hempstead, NY', tok);
      assert(r.status === 404, `${who} can't set the address`, r.body);
    }
    const pa = await addr(qp.id, '14 Oak Ave, Uniondale, NY');
    assert(pa.status === 409 && pa.body?.code === 'NOT_DELIVERY', 'a Pickup quote takes no address', pa.body);
    const read = await call('GET', `/api/quotes/${qd.id}`, { token: owner.token });
    assert(read.status === 200 && read.body?.quote?.deliveryAddress === '14 Oak Ave, Uniondale, NY 11553', 'the business reads the address on the quote', read.body?.quote?.deliveryAddress);
    const code = (await q(`SELECT link_code FROM quotes WHERE id = $1`, [qd.id]))[0].link_code;
    const prev = await call('GET', `/api/quotes/link/${code}`);
    assert(prev.status === 200 && prev.body?.access === 'preview' && prev.body.preview.fulfillment === 'delivery' && prev.body.preview.deliveryFeeCents === 2000 && !JSON.stringify(prev.body).includes('Oak Ave'), 'signed out: Delivery and the fee, never the address', prev.body);

    console.log('\n── paying, closed and blocked ──');
    await q(`UPDATE quotes SET paying_until = now() + interval '10 minutes' WHERE id = $1`, [qd.id]);
    const busy = await addr(qd.id, '20 Elm St, Uniondale, NY');
    assert(busy.status === 409 && busy.body?.code === 'QUOTE_PAYING', 'no change while the customer is paying', busy.body);
    await q(`UPDATE quotes SET paying_until = NULL WHERE id = $1`, [qd.id]);
    const pay = await call('POST', `/api/quotes/${qd.id}/pay`, { token: cust.token, body: { version: qd.version } });
    // D1b: deliverables are paid as product orders (quoteOrders.http.test.ts); this business has no payouts set up.
    assert(pay.status === 400 && pay.body?.code === 'PAYOUTS_NOT_READY', 'paying goes through the payment checks (no payouts here)', pay.body);

    console.log('\n── editing a deliverable ──');
    const e1 = await edit(qd.id, qd.version, { kind: 'product', title: 'Two tier birthday cake', dueDate: daysFromNow(15), totalCents: 22000, paymentMode: 'full', deliveryFeeCents: 2500 });
    assert(e1.status === 200 && e1.body?.quote?.fulfillment === 'delivery' && e1.body.quote.deliveryFeeCents === 2500 && e1.body.quote.deliveryAddress === '14 Oak Ave, Uniondale, NY 11553' && e1.body.quote.version === qd.version + 1, 'left out Pickup or Delivery: kept, with the address', e1.body);
    const e2 = await edit(qd.id, e1.body?.quote?.version, { kind: 'product', title: 'Two tier birthday cake', totalCents: 22000, paymentMode: 'full', fulfillment: 'pickup' });
    assert(e2.status === 200 && e2.body?.quote?.fulfillment === 'pickup' && e2.body.quote.deliveryAddress === null && e2.body.quote.deliveryFeeCents === null, 'changed to Pickup: no address, no delivery fee', e2.body);
    const e3 = await edit(qp.id, qp.version, { kind: 'product', title: 'Cake', totalCents: 20000, paymentMode: 'full' });
    assert(e3.status === 200 && e3.body?.quote?.productId === prod, 'product left out: kept', e3.body);
    const e4 = await edit(qp.id, e3.body?.quote?.version, { kind: 'product', title: 'Cake', totalCents: 20000, paymentMode: 'full', productId: null });
    assert(e4.status === 200 && e4.body?.quote?.productId === null, 'product sent as null: removed', e4.body);
    const e5 = await edit(qp.id, e4.body?.quote?.version, { ...svcBody(), conversationId: undefined });
    assert(e5.status === 200 && e5.body?.quote?.kind === 'service' && e5.body.quote.fulfillment === null && e5.body.quote.productId === null, 'changed to a service: no pickup, delivery or product', e5.body);

    console.log('\n── staff send deliverables too ──');
    const st = await send({ ...cake({ fulfillment: 'delivery' }), conversationId: convStaff }, staffUser.token);
    assert(st.status === 201 && st.body?.quote?.staffMemberId === staffId && st.body.quote.fulfillment === 'delivery', 'a staff member sends a Delivery quote', st.body);
    const before2 = (await msgs(convStaff)).length;
    const sa = await addr(st.body?.quote?.id, '9 Pine St, Freeport, NY', cust2.token);
    const m2 = (await msgs(convStaff)).slice(before2);
    assert(sa.status === 200 && m2.some((m) => m.kind === 'text' && m.sender_id === cust2.uid && m.content.includes('9 Pine St')), 'the address message lands in the staff member\'s chat', m2);

    console.log('\n── review fixes ──');
    {
      // Two identical saves at once post one message (review 8).
      const sid = st.body?.quote?.id;
      const n0 = (await msgs(convStaff)).length;
      const [x1, x2] = await Promise.all([addr(sid, '30 Bay Rd, Freeport, NY', cust2.token), addr(sid, '30 Bay Rd, Freeport, NY', cust2.token)]);
      const added = (await msgs(convStaff)).slice(n0).filter((m) => m.content.includes('30 Bay Rd'));
      assert(x1.status === 200 && x2.status === 200 && added.length === 1, 'two identical saves at once: both fine, one message', { s: [x1.status, x2.status], n: added.length });
      // A removed staff member gets no message and no address (review 2).
      await q(`UPDATE staff_members SET status = 'removed' WHERE id = $1`, [staffId]);
      const n1 = (await msgs(convStaff)).length;
      const moved = await addr(sid, '31 Bay Rd, Freeport, NY', cust2.token);
      assert(moved.status === 200 && (await msgs(convStaff)).length === n1, 'the customer can still change it, but no message goes to a removed staff member', moved.body);
      const staffList = await call('GET', `/api/conversations/${convStaff}/quotes`, { token: staffUser.token });
      const custList = await call('GET', `/api/conversations/${convStaff}/quotes`, { token: cust2.token });
      const sq = staffList.body?.quotes?.find((x: any) => x.id === sid);
      const cq = custList.body?.quotes?.find((x: any) => x.id === sid);
      assert(staffList.status === 200 && sq && sq.deliveryAddress === null, 'the removed staff member no longer sees the address in the chat list', sq);
      assert(cq?.deliveryAddress === '31 Bay Rd, Freeport, NY', 'the customer still does', cq);
      const ownerRead = await call('GET', `/api/quotes/${sid}`, { token: owner.token });
      assert(ownerRead.body?.quote?.deliveryAddress === '31 Bay Rd, Freeport, NY', 'the owner reads it on the quote', ownerRead.body?.quote);
      await q(`UPDATE staff_members SET status = 'active' WHERE id = $1`, [staffId]);
      // An address left on the quote is never overwritten by an edit that keeps Delivery (review 1).
      const v = (await q(`SELECT version FROM quotes WHERE id = $1`, [sid]))[0].version;
      await q(`UPDATE quotes SET delivery_address = '99 Late Ln, Freeport, NY' WHERE id = $1`, [sid]);
      const keep = await call('PATCH', `/api/quotes/${sid}`, { token: staffUser.token, body: { kind: 'product', title: 'Cake', totalCents: 20000, paymentMode: 'full', fulfillment: 'delivery', version: v } });
      assert(keep.status === 200 && keep.body?.quote?.deliveryAddress === '99 Late Ln, Freeport, NY', 'an edit that keeps Delivery leaves the stored address alone', keep.body?.quote);
    }

    console.log('\n── the database guards the rules ──');
    const tryInsert = async (cols: string, vals: string) => {
      try { await q(`INSERT INTO quotes (id, business_id, sender_id, customer_id, conversation_id, title, kind, time_zone, total_cents, payment_mode, expires_at, link_code${cols}) VALUES ('${id('raw')}${Math.random().toString(36).slice(2, 6)}', $1, $2, $3, $4, 'Raw', 'product', 'America/New_York', 20000, 'full', now() + interval '1 day', '${P}raw${Math.random().toString(36).slice(2, 8)}'${vals})`, [biz, owner.uid, cust.uid, conv]); return true; } catch { return false; }
    };
    assert(!(await tryInsert(', fulfillment, delivery_fee_cents', ", 'pickup', 500")), 'no delivery fee on Pickup');
    assert(!(await tryInsert(', fulfillment, delivery_address', ", 'pickup', '12 Main St'")), 'no address on Pickup');
    assert(!(await tryInsert(', fulfillment', ", 'ship'")), 'only pickup or delivery');
    assert(!(await tryInsert(', fulfillment, delivery_fee_cents', ", 'delivery', 20000")), 'the fee is less than the total');
    assert(await tryInsert(', fulfillment, delivery_fee_cents, delivery_address', ", 'delivery', 2000, '12 Main St, Uniondale'"), 'a valid Delivery row');
    assert(await tryInsert('', ''), 'an older product row with none of the new columns');
  } finally {
    await q(`DELETE FROM quotes WHERE business_id = ANY($1)`, [bizs]);
    const convs = (await q(`SELECT id FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [users])).map((r) => r.id);
    await q(`DELETE FROM messages WHERE conversation_id = ANY($1)`, [convs]);
    await q(`DELETE FROM conversations WHERE id = ANY($1)`, [convs]);
    await q(`DELETE FROM staff_members WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM vendor_products WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
