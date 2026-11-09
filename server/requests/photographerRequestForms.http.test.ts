/**
 * Request forms F2 (photographers, migration 108): HTTP integration tests.
 *
 * Legend 2026-11-09, calls 1 to 12 as recommended: photographer forms and requests live in the same tables with
 * photographer_id (exactly one owner); new photographer routes, business routes unchanged; requests go through
 * POST /api/estimate-requests with photographerId; customers' lists show the photographer's name; a service with
 * nothing set uses the base form (call 9, businesses too); contact for pricing photographer services can't be held
 * (call 6, see holdBookable.http.test.ts); one request email wording (call 12, estimates.test.ts).
 *
 * Run with: npx tsx server/requests/photographerRequestForms.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (migrations 096 and 108):
 *   PRF_TEST_BASE_URL  e.g. http://localhost:5062   (must be localhost)
 *   PRF_TEST_PG_URL    the SAME scratch database (localhost only; seeds + cleans up)
 *   PRF_TEST_R2        the server's R2_PUBLIC_URL (photo answers must start with it)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when PRF_TEST_BASE_URL is unset; refuses any non-local host. RESEND_API_KEY must be unset.
 */
import http from 'http';

const BASE = process.env.PRF_TEST_BASE_URL;
const PG_URL = process.env.PRF_TEST_PG_URL;
const R2 = process.env.PRF_TEST_R2 || '';

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

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set PRF_TEST_BASE_URL (+ PRF_TEST_PG_URL, PRF_TEST_R2) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !R2) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, PRF_TEST_R2 must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'prf-test-jwt-secret';
  const { generateAccessToken } = await import('../auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `prf${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const phs: string[] = [];
  const photo = (n: number) => `${R2}/requests/0000000${n}-1111-2222-3333-444444444444.jpg`;

  const mkUser = async (key: string, o: { first?: string; vendor?: boolean; photographer?: boolean } = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name, is_vendor, is_photographer) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3, $4, $5)`,
      [uid, `${uid}@prf.test`, o.first ?? 'Tasha', o.vendor ?? false, o.photographer ?? false]);
    users.push(uid);
    return { uid, token: generateAccessToken({ userId: uid, isVendor: !!o.vendor, isAdmin: false }) };
  };
  const mkPhotog = async (key: string, userId: string, o: { visibility?: string } = {}) => {
    const pid = id(`p-${key}`);
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, visibility_status, created_at, updated_at)
             VALUES ($1, $2, $3, 10000, 'Freeport', 'NY', $4, now(), now())`, [pid, userId, `Lens ${key}`, o.visibility ?? 'public']);
    phs.push(pid);
    return pid;
  };
  const mkPSvc = async (key: string, pid: string, o: { cfp?: boolean; status?: string } = {}) => {
    const sid = id(`ps-${key}`);
    await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at)
             VALUES ($1, $2, $3, $4, 60, true, $5, 'package', $6, now())`,
      [sid, pid, `Shoot ${key}`, (o.cfp ?? true) ? null : 25000, o.status ?? 'live', o.cfp ?? true]);
    return sid;
  };
  const mkBiz = async (key: string, ownerId: string) => {
    const bid = id(`b-${key}`);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, $3, 'home', 'approved')`, [bid, ownerId, `Biz ${key}`]);
    bizs.push(bid);
    return bid;
  };
  const mkSvc = async (key: string, bid: string) => {
    const sid = id(`s-${key}`);
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status, request_only) VALUES ($1, $2, $3, 30000, 180, true, 'live', true)`,
      [sid, bid, `Plan ${key}`]);
    return sid;
  };

  const phU = await mkUser('pu', { first: 'Gio', photographer: true });
  const ph2U = await mkUser('pu2', { first: 'Other', photographer: true });
  const hidU = await mkUser('pu3', { first: 'Hidden', photographer: true });
  const flagU = await mkUser('pu4', { first: 'Flagged', photographer: true });
  const ownerU = await mkUser('ou', { first: 'Benny', vendor: true });
  const owner2U = await mkUser('ou2', { first: 'Nobase', vendor: true });
  const cust = await mkUser('c1');
  const cust2 = await mkUser('c2');
  const stranger = await mkUser('x');
  const ph = await mkPhotog('a', phU.uid);
  const ph2 = await mkPhotog('b', ph2U.uid);
  const phHidden = await mkPhotog('h', hidU.uid, { visibility: 'hidden' });
  const phFlagged = await mkPhotog('f', flagU.uid, { visibility: 'flagged' });
  const pCfp = await mkPSvc('cfp', ph);
  const pCfp2 = await mkPSvc('cfp2', ph);
  const pBook = await mkPSvc('book', ph, { cfp: false });
  const pDraft = await mkPSvc('draft', ph, { status: 'draft' });
  const pOther = await mkPSvc('other', ph2);
  const pHidden = await mkPSvc('hid', phHidden);
  const pFlagged = await mkPSvc('flag', phFlagged);
  const biz = await mkBiz('a', ownerU.uid);
  const biz2 = await mkBiz('b', owner2U.uid);
  const sBiz = await mkSvc('a', biz);
  const sBiz2 = await mkSvc('b', biz2);

  try {
    console.log('\n── photographer form library ──');
    const g0 = await call('GET', '/api/photographers/me/request-forms', { token: phU.token });
    assert(g0.status === 200 && g0.body?.forms?.length === 0 && g0.body.baseFormId === null, 'empty library', g0);
    const baseQs = [
      { type: 'choice', label: 'What kind of day is it?', options: ['Wedding', 'Engagement'], required: true },
      { type: 'date', label: 'Wedding date', required: true },
    ];
    const cb = await call('POST', '/api/photographers/me/request-forms', { token: phU.token, body: { name: 'Base form', isBase: true, questions: baseQs } });
    assert(cb.status === 201 && cb.body?.form?.isBase === true && cb.body.form.questions.length === 2, 'base form created', cb);
    const baseId = cb.body?.form?.id;
    const row = (await q(`SELECT business_id, photographer_id FROM request_forms WHERE id = $1`, [baseId]))[0];
    assert(row && row.business_id === null && row.photographer_id === ph, 'stored with photographer_id only', row);
    const cb2 = await call('POST', '/api/photographers/me/request-forms', { token: phU.token, body: { name: 'Second base', isBase: true, questions: [] } });
    assert(cb2.status === 409 && cb2.body?.code === 'BASE_EXISTS' && /^You already have a base form/.test(cb2.body.message), 'a second base form is refused, photographer wording', cb2);
    const cs = await call('POST', '/api/photographers/me/request-forms', { token: phU.token, body: { name: 'Events', questions: [{ type: 'long_text', label: 'Tell us about the event', required: true }] } });
    assert(cs.status === 201 && cs.body?.form?.isBase === false, 'saved form created', cs);
    const savedId = cs.body?.form?.id;
    const pe = await call('PATCH', `/api/photographers/me/request-forms/${savedId}`, { token: phU.token, body: { name: 'Events and parties' } });
    assert(pe.status === 200 && pe.body?.form?.name === 'Events and parties', 'saved form renamed', pe);
    const pOtherEdit = await call('PATCH', `/api/photographers/me/request-forms/${savedId}`, { token: ph2U.token, body: { name: 'Hijack' } });
    assert(pOtherEdit.status === 404, "another photographer can't edit it", pOtherEdit);
    const g2 = await call('GET', '/api/photographers/me/request-forms', { token: ph2U.token });
    assert(g2.status === 200 && g2.body.forms.length === 0, "another photographer doesn't see it", g2);
    const g1 = await call('GET', '/api/photographers/me/request-forms', { token: phU.token });
    assert(g1.status === 200 && g1.body.forms.length === 2 && g1.body.forms[0].id === baseId && g1.body.baseFormId === baseId, 'base form listed first', g1);

    console.log('\n── who can use which routes ──');
    const r1 = await call('GET', '/api/photographers/me/request-forms', { token: ownerU.token });
    assert(r1.status === 404, 'a business owner has no photographer library', r1);
    const r2 = await call('GET', '/api/photographers/me/request-forms', { token: cust.token });
    assert(r2.status === 404, 'a customer has no photographer library', r2);
    const r3 = await call('GET', '/api/photographers/me/request-forms');
    assert(r3.status === 401, 'signed out → 401', r3);
    const r4 = await call('GET', '/api/vendor/request-forms', { token: phU.token });
    assert(r4.status === 404, 'a photographer has no business library', r4);

    console.log('\n── businesses and photographers never mix ──');
    const bb = await call('POST', '/api/vendor/request-forms', { token: ownerU.token, body: { name: 'Biz base', isBase: true, questions: [{ type: 'short_text', label: 'Pickup address', required: true }] } });
    assert(bb.status === 201, 'business still makes its own base form (a photographer base form exists too)', bb);
    const bizBaseId = bb.body?.form?.id;
    const bl = await call('GET', '/api/vendor/request-forms', { token: ownerU.token });
    assert(bl.status === 200 && bl.body.forms.length === 1 && bl.body.forms[0].id === bizBaseId, "the business library shows only the business's form", bl);
    const bs = await call('POST', '/api/vendor/request-forms', { token: ownerU.token, body: { name: 'Biz saved', questions: [{ type: 'short_text', label: 'Item', required: false }] } });
    const bizSavedId = bs.body?.form?.id;
    const x1 = await call('PUT', `/api/photographers/me/services/${pCfp2}/request-form`, { token: phU.token, body: { formId: bizSavedId, useBase: false, questions: [] } });
    assert(x1.status === 400 && x1.body?.field === 'formId', "a photographer can't pick a business's form", x1);
    const x2 = await call('PUT', `/api/vendor/services/${sBiz}/request-form`, { token: ownerU.token, body: { formId: savedId, useBase: false, questions: [] } });
    assert(x2.status === 400 && x2.body?.field === 'formId', "a business can't pick a photographer's form", x2);
    const x3 = await call('PATCH', `/api/vendor/request-forms/${savedId}`, { token: ownerU.token, body: { name: 'Hijack' } });
    assert(x3.status === 404, "a business can't edit a photographer's form", x3);
    const x4 = await call('PATCH', `/api/photographers/me/request-forms/${bizSavedId}`, { token: phU.token, body: { name: 'Hijack' } });
    assert(x4.status === 404, "a photographer can't edit a business's form", x4);

    console.log("\n── a photographer service's form ──");
    const s0 = await call('GET', `/api/photographers/me/services/${pCfp}/request-form`, { token: phU.token });
    assert(s0.status === 200 && s0.body?.settings?.formId === null && s0.body.settings.useBase === false && s0.body.settings.questions.length === 0, 'nothing set yet', s0);
    assert(Array.isArray(s0.body?.resolved) && s0.body.resolved.length === 2 && s0.body.resolved.every((x: any) => x.id.startsWith('b_')), 'call 9: nothing set uses the base form', s0.body?.resolved);
    const s1 = await call('PUT', `/api/photographers/me/services/${pBook}/request-form`, { token: phU.token, body: { formId: null, useBase: true, questions: [] } });
    assert(s1.status === 400 && s1.body?.code === 'NOT_REQUEST_ONLY', 'a bookable service takes no form', s1);
    const s2 = await call('PUT', `/api/photographers/me/services/${pOther}/request-form`, { token: phU.token, body: { formId: null, useBase: true, questions: [] } });
    assert(s2.status === 404, "another photographer's service → 404", s2);
    const s3 = await call('PUT', `/api/photographers/me/services/${pCfp2}/request-form`, { token: phU.token, body: { formId: savedId, useBase: false, questions: [] } });
    assert(s3.status === 200 && s3.body?.settings?.formId === savedId && s3.body.resolved.length === 1 && s3.body.resolved[0].id.startsWith('f_'), 'service uses a saved form', s3);
    const own = [{ type: 'photos', label: 'Looks you love', maxPhotos: 3, required: false }];
    const s4 = await call('PUT', `/api/photographers/me/services/${pCfp}/request-form`, { token: phU.token, body: { formId: null, useBase: true, questions: own } });
    assert(s4.status === 200 && s4.body.resolved.length === 3 && s4.body.resolved[2].id.startsWith('s_'), 'base form plus its own question', s4);
    const sRow = (await q(`SELECT request_form_use_base, request_questions FROM photographer_services WHERE id = $1`, [pCfp]))[0];
    assert(sRow?.request_form_use_base === true && Array.isArray(sRow.request_questions) && sRow.request_questions.length === 1, 'saved on photographer_services', sRow);

    console.log('\n── removing forms ──');
    const d1 = await call('DELETE', `/api/photographers/me/request-forms/${savedId}`, { token: phU.token });
    assert(d1.status === 409 && d1.body?.code === 'FORM_IN_USE' && d1.body.services?.[0]?.id === pCfp2, 'a form in use is kept and lists the service', d1);
    const d2 = await call('DELETE', `/api/photographers/me/request-forms/${baseId}`, { token: phU.token });
    assert(d2.status === 409 && d2.body?.code === 'BASE_FORM', "the base form can't be removed", d2);
    const tmp = await call('POST', '/api/photographers/me/request-forms', { token: phU.token, body: { name: 'Temp', questions: [] } });
    const d3 = await call('DELETE', `/api/photographers/me/request-forms/${tmp.body?.form?.id}`, { token: ph2U.token });
    assert(d3.status === 404, "another photographer can't remove it", d3);
    const d4 = await call('DELETE', `/api/photographers/me/request-forms/${tmp.body?.form?.id}`, { token: phU.token });
    assert(d4.status === 200, 'an unused saved form is removed', d4);

    console.log('\n── the public form ──');
    const f1 = await call('GET', `/api/photographer-services/${pCfp}/request-form`);
    assert(f1.status === 200 && f1.body?.photographer?.id === ph && f1.body.photographer.name === 'Lens a' && f1.body.business === null && f1.body.vendor?.type === 'photographer', 'names the photographer', f1);
    assert(f1.body?.questions?.length === 3 && f1.body.cityRequired === false && f1.body.cities.length === 0 && f1.body.phoneRequired === true && f1.body.service?.price === null, 'questions, no city, phone asked, no price', f1.body);
    for (const [sid, why] of [[pBook, 'a bookable service'], [pDraft, 'a draft'], [pHidden, 'a hidden photographer'], [pFlagged, 'a flagged photographer'], [sBiz, 'a business service id']] as const) {
      const r = await call('GET', `/api/photographer-services/${sid}/request-form`);
      assert(r.status === 404, `${why} → 404`, r);
    }

    console.log('\n── sending a request to a photographer ──');
    const body = (o: Record<string, unknown> = {}) => ({
      photographerId: ph, serviceId: pCfp, name: 'Tasha M.', email: 'tasha@prf.test', phone: '516 555 0142', source: 'app',
      answers: { [f1.body.questions[0].id]: 'Wedding', [f1.body.questions[1].id]: '2027-06-13', [f1.body.questions[2].id]: [photo(1), photo(2)] },
      ...o,
    });
    const both = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ businessId: biz }) });
    assert(both.status === 400, 'businessId and photographerId together → refused', both);
    const neither = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ photographerId: undefined }) });
    assert(neither.status === 400, 'neither → refused', neither);
    const miss = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ answers: {} }) });
    assert(miss.status === 400 && miss.body?.field === f1.body.questions[0].id, 'a required answer missing → 400 on that question', miss);
    const wrongSvc = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ serviceId: pOther }) });
    assert(wrongSvc.status === 400 && wrongSvc.body?.field === 'serviceId', "another photographer's service → 400", wrongSvc);
    const bookSvc = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ serviceId: pBook }) });
    assert(bookSvc.status === 400 && bookSvc.body?.field === 'serviceId', 'a bookable photographer service → 400', bookSvc);
    const bizSvc = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ serviceId: sBiz }) });
    assert(bizSvc.status === 400 && bizSvc.body?.field === 'serviceId', 'a business service with photographerId → 400', bizSvc);
    const hidden = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ photographerId: phHidden, serviceId: pHidden }) });
    assert(hidden.status === 404, 'a hidden photographer → 404', hidden);
    const flagged = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ photographerId: phFlagged, serviceId: pFlagged }) });
    assert(flagged.status === 404, 'a flagged photographer → 404 (same as the public listing)', flagged);
    const out = await call('POST', '/api/estimate-requests', { token: cust.token, body: body() });
    assert(out.status === 201 && out.body?.success === true && typeof out.body.request?.conversationId === 'string', 'request sent, chat opened', out);
    const reqId = out.body?.request?.id;
    const saved = (await q(`SELECT * FROM estimate_requests WHERE id = $1`, [reqId]))[0];
    assert(saved && saved.business_id === null && saved.photographer_id === ph && saved.service_id === pCfp && saved.service_name === 'Shoot cfp', 'saved to the photographer, with the service', saved);
    assert(Array.isArray(saved?.answers) && saved.answers.length === 3 && saved.answers[2].value.length === 2, 'answers saved as sent', saved?.answers);
    const conv = (await q(`SELECT * FROM conversations WHERE id = $1`, [out.body?.request?.conversationId]))[0];
    const parts = conv ? [conv.participant1_id ?? conv.participant_1_id, conv.participant2_id ?? conv.participant_2_id].filter(Boolean).sort() : [];
    assert(parts.length === 2 && parts.includes(cust.uid) && parts.includes(phU.uid), "the chat is with the photographer's own login", conv);
    const msg = (await q(`SELECT * FROM messages WHERE id = $1`, [saved?.message_id]))[0];
    assert(msg && msg.kind === 'request' && msg.card?.photographerId === ph && msg.card.businessId === null && msg.card.requestId === reqId && msg.card.answerCount === 3, 'request card posted with photographerId', msg?.card);
    assert(msg?.sender_id === cust.uid && /Sent a request for Shoot cfp/.test(msg?.content ?? ''), 'from the customer, readable as text in old apps', msg?.content);
    const noSvc = await call('POST', '/api/estimate-requests', { token: cust2.token, body: body({ serviceId: undefined, answers: undefined }) });
    assert(noSvc.status === 201, 'a request with no service still works (contact details only)', noSvc);

    console.log('\n── the photographer sees it ──');
    const l1 = await call('GET', '/api/photographers/me/requests', { token: phU.token });
    assert(l1.status === 200 && l1.body.requests.length === 2 && l1.body.requests.some((r: any) => r.id === reqId && r.answers.length === 3 && r.conversationId && r.customerPhone === '516 555 0142'), 'in their Requests list, with answers and phone', l1);
    const l2 = await call('GET', '/api/photographers/me/requests', { token: ph2U.token });
    assert(l2.status === 200 && l2.body.requests.length === 0, "another photographer doesn't see it", l2);
    const lb = await call('GET', '/api/vendor/estimate-requests', { token: ownerU.token });
    assert(lb.status === 200 && !lb.body.requests.some((r: any) => r.id === reqId), "a business list never shows a photographer's request", lb);
    const lf = await call('GET', '/api/photographers/me/requests?status=nope', { token: phU.token });
    assert(lf.status === 400, 'an unknown status filter → 400', lf);
    const up0 = await call('PATCH', `/api/photographers/me/requests/${reqId}`, { token: ph2U.token, body: { status: 'closed' } });
    assert(up0.status === 404, "another photographer can't change it", up0);
    const upB = await call('PATCH', `/api/vendor/estimate-requests/${reqId}`, { token: ownerU.token, body: { status: 'closed' } });
    assert(upB.status === 404, "a business can't change it", upB);
    const up1 = await call('PATCH', `/api/photographers/me/requests/${reqId}`, { token: phU.token, body: { status: 'called', vendorNotes: ' Call Tuesday ' } });
    assert(up1.status === 200 && up1.body?.request?.status === 'called' && up1.body.request.vendorNotes === 'Call Tuesday', 'status and notes changed', up1);
    const d0 = await call('GET', `/api/requests/${reqId}`, { token: phU.token });
    assert(d0.status === 200 && d0.body?.request?.customerPhone === '516 555 0142' && d0.body.request.vendorNotes === 'Call Tuesday' && d0.body.request.businessName === 'Lens a', 'the photographer opens it with the contact details', d0);
    const dOther = await call('GET', `/api/requests/${reqId}`, { token: ph2U.token });
    assert(dOther.status === 404, 'another photographer gets 404', dOther);
    const dX = await call('GET', `/api/requests/${reqId}`, { token: stranger.token });
    assert(dX.status === 404, 'a stranger gets 404', dX);

    console.log("\n── the customer's lists (call 8) ──");
    const m1 = await call('GET', '/api/me/requests', { token: cust.token });
    const mine = m1.body?.requests?.find((r: any) => r.id === reqId);
    assert(m1.status === 200 && mine && mine.businessName === 'Lens a' && mine.businessId === null && mine.photographerId === ph && mine.vendorType === 'photographer', "shows the photographer's name, old field filled", mine);
    assert(mine && !('vendorNotes' in mine) && !('customerPhone' in mine), "the customer never sees the photographer's notes", mine);
    const dc = await call('GET', `/api/requests/${reqId}`, { token: cust.token });
    assert(dc.status === 200 && dc.body?.request?.businessName === 'Lens a' && !('vendorNotes' in dc.body.request), 'the customer opens it, without notes', dc);

    console.log('\n── a business can never quote a photographer request ──');
    const qb = await call('POST', '/api/quotes', { token: ownerU.token, body: { conversationId: out.body.request.conversationId, requestId: reqId, title: 'x', jobDate: '2027-06-13', startTime: '10:00', durationMinutes: 60, totalCents: 10000, paymentMode: 'full' } });
    assert(qb.status >= 400 && qb.status < 500, 'refused', qb);

    console.log('\n── call 9 for businesses ──');
    const bf = await call('GET', `/api/services/${sBiz}/request-form`);
    assert(bf.status === 200 && bf.body?.questions?.length === 1 && bf.body.questions[0].id.startsWith('b_') && bf.body.questions[0].label === 'Pickup address', 'a business service with nothing set asks the base form', bf.body?.questions);
    const bfNo = await call('GET', `/api/services/${sBiz2}/request-form`);
    assert(bfNo.status === 200 && Array.isArray(bfNo.body?.questions) && bfNo.body.questions.length === 0, 'with no base form it still asks nothing', bfNo.body?.questions);
    const bSend = await call('POST', '/api/estimate-requests', { token: cust2.token, body: { businessId: biz, serviceId: sBiz, name: 'Tasha M.', email: 'tasha@prf.test', phone: '516 555 0142', answers: {} } });
    assert(bSend.status === 400 && bSend.body?.field === bf.body?.questions?.[0]?.id, 'and its required base question is checked on send', bSend);
    const bOk = await call('POST', '/api/estimate-requests', { token: cust2.token, body: { businessId: biz, serviceId: sBiz, name: 'Tasha M.', email: 'tasha@prf.test', phone: '516 555 0142', answers: { [bf.body?.questions?.[0]?.id ?? 'x']: '1 Main St' } } });
    const bRow = (await q(`SELECT business_id, photographer_id FROM estimate_requests WHERE id = $1`, [bOk.body?.request?.id]))[0];
    assert(bOk.status === 201 && bRow?.business_id === biz && bRow.photographer_id === null, 'a business request is stored as before', bRow);

    console.log('\n── the database rules ──');
    let refused = false;
    try { await q(`INSERT INTO request_forms (business_id, photographer_id, name) VALUES ($1, $2, 'both')`, [biz, ph]); } catch { refused = true; }
    assert(refused, 'a form with both owners is refused');
    refused = false;
    try { await q(`INSERT INTO estimate_requests (customer_name, customer_email, customer_phone) VALUES ('a', 'b', 'c')`); } catch { refused = true; }
    assert(refused, 'a request with no owner is refused');
    refused = false;
    try { await q(`INSERT INTO request_forms (photographer_id, name, is_base) VALUES ($1, 'base 2', true)`, [ph]); } catch { refused = true; }
    assert(refused, 'a second photographer base form is refused by the database');
  } finally {
    const all = [...users];
    await q(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1))`, [all]).catch(() => undefined);
    await q(`DELETE FROM estimate_requests WHERE customer_id = ANY($1)`, [all]).catch(() => undefined);
    await q(`DELETE FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [all]).catch(() => undefined);
    await q(`UPDATE photographer_services SET request_form_id = NULL WHERE photographer_id = ANY($1)`, [phs]).catch(() => undefined);
    await q(`UPDATE vendor_services SET request_form_id = NULL WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM request_forms WHERE photographer_id = ANY($1) OR business_id = ANY($2)`, [phs, bizs]).catch(() => undefined);
    await q(`DELETE FROM photographer_services WHERE photographer_id = ANY($1)`, [phs]).catch(() => undefined);
    await q(`DELETE FROM photographers WHERE id = ANY($1)`, [phs]).catch(() => undefined);
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [all]).catch(() => undefined);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
