/**
 * Extra estimate request recipients (migration 111, Royal Elite step 4) — HTTP integration tests.
 *
 * Run with: npx tsx server/requestRecipients.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema + migration 111)
 * like server/estimateRequests.http.test.ts, plus a Resend stand-in started here:
 *   RR_TEST_BASE_URL     e.g. http://localhost:5063   (must be localhost)
 *   RR_TEST_PG_URL       the SAME scratch database (localhost only; seeds + cleans up)
 *   RR_TEST_RESEND_PORT  port for the Resend stand-in; boot the server with RESEND_API_KEY=re_stub and
 *                        RESEND_BASE_URL=http://127.0.0.1:<same port> so no email ever leaves
 *   JWT_SECRET           identical to the server's
 * Skips (exit 0) when RR_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * What it proves:
 *  - GET/PUT /api/vendor/request-recipients: owner only (or admin with x-business-id); cleaned list saved;
 *    bad input refused with a clear message and nothing changed; another vendor never sees or changes it
 *  - every request emails the owner, Outsyde and each extra address (4 sends for 2 extras), reply to the customer
 *  - one extra address failing still saves the request (201) and still sends the others
 *  - a business with no list sends exactly what it did before (owner + Outsyde)
 */

import http from 'http';

const BASE = process.env.RR_TEST_BASE_URL;
const PG_URL = process.env.RR_TEST_PG_URL;
const RESEND_PORT = Number(process.env.RR_TEST_RESEND_PORT || '0');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.97.6.${Math.floor(Math.random() * 200) + 1}`, ...(o.headers ?? {}) };
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
    console.log('⏭  skipped: set RR_TEST_BASE_URL (+ RR_TEST_PG_URL, RR_TEST_RESEND_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !RESEND_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, RR_TEST_RESEND_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'rr-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // Resend stand-in: records every send; addresses in failTo get a Resend style error.
  const sent: { to: string; subject: string; reply_to?: string }[] = [];
  const failTo = new Set<string>();
  const resend = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      let body: any = {}; try { body = JSON.parse(b); } catch {}
      const to = Array.isArray(body.to) ? body.to[0] : body.to;
      sent.push({ to, subject: body.subject, reply_to: Array.isArray(body.reply_to) ? body.reply_to[0] : body.reply_to });
      if (failTo.has(to)) { res.writeHead(422, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'validation_error', message: 'stub refused', statusCode: 422 })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: `stub_${sent.length}` }));
    });
  });
  await new Promise<void>((r) => resend.listen(RESEND_PORT, '127.0.0.1', () => r()));

  const P = `rr${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, o: { isVendor?: boolean; email?: string } = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, o.email ?? `${uid}@rr.test`, o.isVendor ?? false]);
    users.push(uid);
    return uid;
  };
  const mkBiz = async (key: string, ownerId: string) => {
    const bid = id(key);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, service_cities) VALUES ($1, $2, $3, 'moving', 'approved', $4)`,
      [bid, ownerId, `Biz ${key}`, ['Norfolk']]);
    bizs.push(bid);
    return bid;
  };

  const owner = await mkUser('own', { isVendor: true, email: `Owner.${P}@RR.test` });
  const biz = await mkBiz('b', owner);
  const otherVendor = await mkUser('ov', { isVendor: true });
  const otherBiz = await mkBiz('ob', otherVendor);
  const customer = await mkUser('c');
  const [existingAdmin] = await q(`SELECT id FROM users WHERE email = 'info@goutsyde.com'`);
  const admin = existingAdmin?.id ?? await mkUser('adm', { email: 'info@goutsyde.com' });
  const tok = (u: string, v = false) => generateAccessToken({ userId: u, isVendor: v, isAdmin: false });
  const tOwn = tok(owner, true), tOther = tok(otherVendor, true), tCust = tok(customer), tAdm = tok(admin);
  const ownerEmail = `owner.${P}@rr.test`;
  const extra1 = `jeremiah.${P}@rr.test`, extra2 = `second.${P}@rr.test`;

  const form = (businessId: string) => ({
    businessId, city: 'Norfolk', name: 'Test Customer', email: `customer.${P}@rr.test`, phone: '757 555 0100',
    preferredDate: '2026-12-01', details: { moveType: 'Standard Move' }, source: 'royal-elite-site',
  });
  const sendsAfter = async (fn: () => Promise<unknown>) => { const before = sent.length; await fn(); await sleep(600); return sent.slice(before); };

  try {
    console.log('\n── 1. who can read and change the list ──');
    let r = await call('GET', '/api/vendor/request-recipients');
    assert(r.status === 401, 'signed out → 401', r.status);
    r = await call('GET', '/api/vendor/request-recipients', { token: tOwn });
    assert(r.status === 200 && JSON.stringify(r.body?.emails) === '[]' && r.body?.ownerEmail?.toLowerCase() === ownerEmail && r.body?.outsydeEmail === 'info@goutsyde.com', 'owner sees an empty list plus the always included addresses', r.body);
    r = await call('PUT', '/api/vendor/request-recipients', { token: tOwn, body: { emails: [`  ${extra1.toUpperCase()} `, extra1, ownerEmail, 'info@goutsyde.com', extra2, ''] } });
    assert(r.status === 200 && JSON.stringify(r.body?.emails) === JSON.stringify([extra1, extra2]), 'owner saves: trimmed, lowercased, duplicates, own and Outsyde address dropped', r.body);
    const [row] = await q(`SELECT request_notify_emails FROM businesses WHERE id = $1`, [biz]);
    assert(JSON.stringify(row?.request_notify_emails) === JSON.stringify([extra1, extra2]), 'saved in businesses.request_notify_emails', row);
    r = await call('PUT', '/api/vendor/request-recipients', { token: tOwn, body: { emails: ['bob'] } });
    assert(r.status === 400 && r.body?.error === '"bob" is not an email address.' && r.body?.field === 'emails', 'a non email → 400 with a clear message', r.body);
    r = await call('PUT', '/api/vendor/request-recipients', { token: tOwn, body: { emails: ['a@b.co', 'c@d.co', 'e@f.co', 'g@h.co', 'i@j.co', 'k@l.co'] } });
    assert(r.status === 400 && r.body?.error === 'You can add up to 5 emails.', '6 addresses → 400', r.body);
    r = await call('PUT', '/api/vendor/request-recipients', { token: tOwn, body: {} });
    assert(r.status === 400 && r.body?.error === 'Send a list of emails.', 'no list → 400', r.body);
    const [row2] = await q(`SELECT request_notify_emails FROM businesses WHERE id = $1`, [biz]);
    assert(JSON.stringify(row2?.request_notify_emails) === JSON.stringify([extra1, extra2]), 'refused saves change nothing', row2);
    r = await call('GET', '/api/vendor/request-recipients', { token: tOther });
    assert(r.status === 200 && JSON.stringify(r.body?.emails) === '[]', "another vendor only ever sees their own business's list", r.body);
    r = await call('GET', '/api/vendor/request-recipients', { token: tOther, headers: { 'x-business-id': biz } });
    assert(r.status === 403, 'another vendor naming this business → 403', r.status);
    r = await call('PUT', '/api/vendor/request-recipients', { token: tOther, headers: { 'x-business-id': biz }, body: { emails: ['evil@x.co'] } });
    assert(r.status === 403, 'another vendor cannot change it', r.status);
    r = await call('GET', '/api/vendor/request-recipients', { token: tAdm, headers: { 'x-business-id': biz } });
    assert(r.status === 200 && JSON.stringify(r.body?.emails) === JSON.stringify([extra1, extra2]) && r.body?.ownerEmail?.toLowerCase() === ownerEmail, "admin with x-business-id sees this business's list and its owner", r.body);

    console.log('\n── 2. every request emails the list ──');
    let s = await sendsAfter(async () => {
      const res = await call('POST', '/api/estimate-requests', { token: tCust, body: form(biz) });
      assert(res.status === 201, 'request saved', res);
    });
    const tos = s.map((x) => (x.to || '').toLowerCase()).sort();
    assert(JSON.stringify(tos) === JSON.stringify([extra1, 'info@goutsyde.com', ownerEmail, extra2].sort()), '4 emails: owner, Outsyde, both extras', tos);
    assert(s.every((x) => x.reply_to === `customer.${P}@rr.test`), 'every email replies to the customer', s);
    const ownerSubject = s.find((x) => x.to.toLowerCase() === ownerEmail)?.subject;
    assert(!!ownerSubject && s.find((x) => x.to === extra1)?.subject === ownerSubject, 'extras get the same email as the owner', s);

    console.log('\n── 3. one failing extra never blocks the rest ──');
    failTo.add(extra1);
    s = await sendsAfter(async () => {
      const res = await call('POST', '/api/estimate-requests', { token: tCust, body: form(biz) });
      assert(res.status === 201, 'request still saved when one extra email fails', res.status);
    });
    assert(s.length === 4 && s.some((x) => x.to === extra2) && s.some((x) => x.to.toLowerCase() === ownerEmail), 'the other 3 still sent', s.map((x) => x.to));
    failTo.clear();

    console.log('\n── 4. no list = unchanged ──');
    s = await sendsAfter(async () => {
      const res = await call('POST', '/api/estimate-requests', { token: tCust, body: form(otherBiz) });
      assert(res.status === 201, 'request to a business with no list saved', res.status);
    });
    assert(JSON.stringify(s.map((x) => x.to.toLowerCase()).sort()) === JSON.stringify([`${otherVendor}@rr.test`, 'info@goutsyde.com'].sort()), 'only owner + Outsyde, as before', s.map((x) => x.to));

    console.log('\n── 5. clearing the list ──');
    r = await call('PUT', '/api/vendor/request-recipients', { token: tOwn, body: { emails: [] } });
    assert(r.status === 200 && JSON.stringify(r.body?.emails) === '[]', 'empty list clears it', r.body);
    s = await sendsAfter(async () => { await call('POST', '/api/estimate-requests', { token: tCust, body: form(biz) }); });
    assert(s.length === 2, 'back to owner + Outsyde only', s.map((x) => x.to));
  } finally {
    const convs = (await q(`SELECT id FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [users]).catch(() => [])).map((x: any) => x.id);
    await q(`DELETE FROM messages WHERE conversation_id = ANY($1)`, [convs]).catch(() => {});
    await q(`DELETE FROM conversations WHERE id = ANY($1)`, [convs]).catch(() => {});
    await q(`DELETE FROM estimate_requests WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
    resend.close();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
