/**
 * Base form on requests with no plan (Royal Elite step 6) — HTTP integration tests.
 *
 * Run with: npx tsx server/baseFormRequests.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema), like
 * server/estimateRequests.http.test.ts:
 *   BF_TEST_BASE_URL   e.g. http://localhost:5063   (must be localhost)
 *   BF_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when BF_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * What it proves:
 *  - GET /api/businesses/:id/request-form: the base form's questions (b_ ids), 404 for unknown / not approved
 *  - POST /api/estimate-requests with no plan or product: answers checked against the base form and saved;
 *    a missing required answer is refused with field "answers"-style errors; answers to unknown ids dropped
 *  - a business with no base form: no plan requests work exactly as before (no questions, 201)
 *  - a request naming a plan still uses that plan's own form, not the base form
 */

import http from 'http';

const BASE = process.env.BF_TEST_BASE_URL;
const PG_URL = process.env.BF_TEST_PG_URL;

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
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.98.6.${Math.floor(Math.random() * 200) + 1}` };
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
    console.log('⏭  skipped: set BF_TEST_BASE_URL (+ BF_TEST_PG_URL) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: BASE and PG_URL must both be localhost');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'bf-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `bf${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, isVendor = false) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@bf.test`, isVendor]);
    users.push(uid);
    return uid;
  };
  const mkBiz = async (key: string, ownerId: string, approval = 'approved') => {
    const bid = id(key);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, service_cities) VALUES ($1, $2, $3, 'moving', $4, $5)`,
      [bid, ownerId, ` Biz ${key} `, approval, ['Norfolk', 'Suffolk']]);
    bizs.push(bid);
    return bid;
  };
  const owner = await mkUser('own', true);
  const biz = await mkBiz('b', owner);
  const plainOwner = await mkUser('pown', true);
  const plainBiz = await mkBiz('pb', plainOwner);
  const pendingOwner = await mkUser('pend', true);
  const pendingBiz = await mkBiz('pe', pendingOwner, 'pending');
  const customer = await mkUser('c');
  const tOwn = generateAccessToken({ userId: owner, isVendor: true, isAdmin: false });
  const tCust = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false });

  const form = (businessId: string, answers?: unknown, extra: Record<string, unknown> = {}) => ({
    businessId, city: 'Norfolk', name: 'Test Customer', email: `customer.${P}@bf.test`, phone: '757 555 0100',
    preferredDate: '2026-12-01', details: { moveType: 'Standard Move' }, source: 'royal-elite-site',
    ...(answers !== undefined ? { answers } : {}), ...extra,
  });

  try {
    console.log('\n── 1. owner builds a base form (existing route) ──');
    let r = await call('POST', '/api/vendor/request-forms', { token: tOwn, body: {
      name: 'Move details', isBase: true,
      questions: [
        { type: 'short_text', label: 'How many boxes?', required: true },
        { type: 'choice', label: 'Heavy items?', required: false, options: ['Piano', 'Safe', 'None'], multiple: true },
      ],
    } });
    assert(r.status === 201 && r.body?.form?.isBase === true, 'base form created', r);
    const raw = r.body?.form?.questions ?? [];

    console.log('\n── 2. public base form ──');
    r = await call('GET', `/api/businesses/${biz}/request-form`);
    const qs = r.body?.questions ?? [];
    assert(r.status === 200 && qs.length === 2, 'returns the 2 base questions', r.body);
    assert(qs[0]?.id === `b_${raw[0]?.id}` && qs[1]?.id === `b_${raw[1]?.id}`, 'question ids are the b_ ids the request checks', qs.map((x: any) => x.id));
    assert(r.body?.business?.name === `Biz b` && JSON.stringify(r.body?.cities) === '["Norfolk","Suffolk"]' && r.body?.cityRequired === true && r.body?.phoneRequired === true, 'business name trimmed, cities, city + phone required', r.body);
    assert(JSON.stringify(Object.keys(r.body ?? {}).sort()) === JSON.stringify(['business', 'cities', 'cityRequired', 'phoneRequired', 'questions']), 'nothing else about the business is sent', Object.keys(r.body ?? {}));
    r = await call('GET', `/api/businesses/${pendingBiz}/request-form`);
    assert(r.status === 404, 'not approved business → 404', r.status);
    r = await call('GET', `/api/businesses/${id('nope')}/request-form`);
    assert(r.status === 404, 'unknown business → 404', r.status);
    r = await call('GET', `/api/businesses/${plainBiz}/request-form`);
    assert(r.status === 200 && JSON.stringify(r.body?.questions) === '[]', 'business with no base form → empty questions', r.body);

    console.log('\n── 3. no plan request answers the base form ──');
    const [qBoxes, qHeavy] = qs;
    r = await call('POST', '/api/estimate-requests', { token: tCust, body: form(biz, { [qBoxes.id]: '  40 boxes ', [qHeavy.id]: ['Piano', 'Safe'], b_unknown: 'x' }) });
    assert(r.status === 201, 'valid answers → 201', r);
    const [row] = await q(`SELECT answers, service_id, product_id FROM estimate_requests WHERE id = $1`, [r.body?.request?.id]);
    const ans = row?.answers ?? [];
    assert(ans.length === 2 && ans[0].label === 'How many boxes?' && ans[0].value === '40 boxes' && JSON.stringify(ans[1].value) === '["Piano","Safe"]', 'answers saved in form order, trimmed, unknown id dropped', ans);
    assert(row?.service_id === null && row?.product_id === null, 'still a no plan request', row);
    r = await call('POST', '/api/estimate-requests', { token: tCust, body: form(biz, { [qHeavy.id]: ['None'] }) });
    assert(r.status === 400 && typeof r.body?.message === 'string' && r.body.message.length > 0, 'missing required answer → 400 with a message', r.body);
    r = await call('POST', '/api/estimate-requests', { token: tCust, body: form(biz) });
    assert(r.status === 400, 'old site sending no answers to a business with a required question → 400 (site must ship first)', r.status);
    r = await call('POST', '/api/estimate-requests', { token: tCust, body: form(biz, { [qBoxes.id]: '12', [qHeavy.id]: ['Car'] }) });
    assert(r.status === 400, 'a choice that is not an option → 400', r.body);

    console.log('\n── 4. no base form = as before ──');
    r = await call('POST', '/api/estimate-requests', { token: tCust, body: form(plainBiz) });
    assert(r.status === 201, 'no plan request to a business with no base form → 201', r);
    const [row2] = await q(`SELECT answers FROM estimate_requests WHERE id = $1`, [r.body?.request?.id]);
    assert(JSON.stringify(row2?.answers ?? []) === '[]', 'no answers saved', row2);
    r = await call('POST', '/api/estimate-requests', { token: tCust, body: form(plainBiz, { whatever: 'x' }) });
    assert(r.status === 201, 'stray answers to a business with no form are ignored, as before', r.status);

    console.log('\n── 5. a request naming a plan keeps the plan form ──');
    const [svc] = await q(`INSERT INTO vendor_services (business_id, name, price, duration_minutes, status, is_active, request_only, request_questions)
      VALUES ($1, 'Request only plan', '0', 60, 'live', true, true, '[{"id":"q1","type":"short_text","label":"Plan question","required":true}]'::jsonb) RETURNING id`, [biz]);
    r = await call('POST', '/api/estimate-requests', { token: tCust, body: form(biz, { s_q1: 'plan answer' }, { serviceId: svc.id }) });
    assert(r.status === 201, 'plan request with the plan answer → 201 (base question not asked)', r);
    const [row3] = await q(`SELECT answers FROM estimate_requests WHERE id = $1`, [r.body?.request?.id]);
    assert((row3?.answers ?? []).length === 1 && row3.answers[0].label === 'Plan question', 'only the plan question saved', row3);
  } finally {
    const convs = (await q(`SELECT id FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [users]).catch(() => [])).map((x: any) => x.id);
    await q(`DELETE FROM messages WHERE conversation_id = ANY($1)`, [convs]).catch(() => {});
    await q(`DELETE FROM conversations WHERE id = ANY($1)`, [convs]).catch(() => {});
    await q(`DELETE FROM estimate_requests WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM request_forms WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
