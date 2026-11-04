/**
 * Request forms (Quotes in Messages, step 1): HTTP integration tests.
 *
 * Legend 2026-11-04 (all recommended): requests extend estimate_requests; name and email come from the
 * signed in account, phone is always asked; only request only services take requests; 25 questions per
 * form, 5 photos per photo question, 10 per request; Royal Elite's site keeps posting its current fields;
 * the request chat goes to the business owner's account.
 *
 * Run with: npx tsx server/requests/requestForms.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (migration 096 applied):
 *   RF_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   RF_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   RF_TEST_R2         the server's R2_PUBLIC_URL (photo answers must start with it)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when RF_TEST_BASE_URL is unset; refuses any non-local host.
 */
import http from 'http';

const BASE = process.env.RF_TEST_BASE_URL;
const PG_URL = process.env.RF_TEST_PG_URL;
const R2 = process.env.RF_TEST_R2 || '';
const EXPO_FILE = process.env.RF_TEST_EXPO_FILE || '';

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
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.98.1.${Math.floor(Math.random() * 200) + 1}` };
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
    console.log('⏭  skipped: set RF_TEST_BASE_URL (+ RF_TEST_PG_URL, RF_TEST_R2) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !R2) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, RF_TEST_R2 must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'rf-test-jwt-secret';
  const { generateAccessToken } = await import('../auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `rf${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const photo = (n: number) => `${R2}/requests/0000000${n}-1111-2222-3333-444444444444.jpg`;

  const mkUser = async (key: string, o: { first?: string; vendor?: boolean } = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name, is_vendor) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3, $4)`,
      [uid, `${uid}@rf.test`, o.first ?? 'Ana', o.vendor ?? false]);
    users.push(uid);
    return { uid, token: generateAccessToken({ userId: uid, isVendor: !!o.vendor, isAdmin: false }) };
  };
  const mkBiz = async (key: string, ownerId: string, cities: string[] = []) => {
    const bid = id(`b-${key}`);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, service_cities) VALUES ($1, $2, $3, 'home', 'approved', $4)`,
      [bid, ownerId, `Movers ${key}`, cities]);
    bizs.push(bid);
    return bid;
  };
  const mkSvc = async (key: string, bid: string, o: { requestOnly?: boolean; status?: string } = {}) => {
    const sid = id(`s-${key}`);
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status, request_only) VALUES ($1, $2, $3, 30000, 180, true, $4, $5)`,
      [sid, bid, `Plan ${key}`, o.status ?? 'live', o.requestOnly ?? true]);
    return sid;
  };

  const ownerA = await mkUser('oa', { first: 'Benny', vendor: true });
  const ownerB = await mkUser('ob', { first: 'Other', vendor: true });
  const custs = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => mkUser(`c${n}`)));
  const stranger = await mkUser('x');
  const bizA = await mkBiz('a', ownerA.uid);
  const bizB = await mkBiz('b', ownerB.uid);
  const ownerR = await mkUser('or', { first: 'Royal', vendor: true });
  const bizR = await mkBiz('r', ownerR.uid, ['Norfolk', 'Suffolk']);
  const sA = await mkSvc('a', bizA);
  const sA2 = await mkSvc('a2', bizA);
  const sBook = await mkSvc('book', bizA, { requestOnly: false });
  const sDraft = await mkSvc('draft', bizA, { status: 'draft' });
  const sR = await mkSvc('r', bizR);
  const sB = await mkSvc('b', bizB);

  try {
    console.log('\n── form library ──');
    const g0 = await call('GET', '/api/vendor/request-forms', { token: ownerA.token });
    assert(g0.status === 200 && Array.isArray(g0.body?.forms) && g0.body.forms.length === 0 && g0.body.baseFormId === null, 'empty library', g0);

    const baseQs = [
      { type: 'short_text', label: 'Pickup address', required: true },
      { type: 'choice', label: 'Home size', options: ['Studio', '1 Bedroom', '2 Bedroom'], required: true },
    ];
    const cb = await call('POST', '/api/vendor/request-forms', { token: ownerA.token, body: { name: 'Base form', isBase: true, questions: baseQs } });
    assert(cb.status === 201 && cb.body?.form?.isBase === true && cb.body.form.questions.length === 2 && cb.body.form.questions.every((x: any) => /^[a-z0-9]{8}$/.test(x.id)), 'base form created, ids assigned', cb);
    const baseId = cb.body?.form?.id;

    const cb2 = await call('POST', '/api/vendor/request-forms', { token: ownerA.token, body: { name: 'Another base', isBase: true, questions: [] } });
    assert(cb2.status === 409 && cb2.body?.code === 'BASE_EXISTS', 'a second base form is refused', cb2);

    const cs = await call('POST', '/api/vendor/request-forms', { token: ownerA.token, body: { name: 'Packing form', questions: [{ type: 'long_text', label: 'What needs packing?', required: true }] } });
    assert(cs.status === 201 && cs.body?.form?.isBase === false, 'saved form created', cs);
    const savedId = cs.body?.form?.id;

    const ci = await call('POST', '/api/vendor/request-forms', { token: ownerA.token, body: { name: 'Bad', questions: [{ type: 'choice', label: 'Only one', options: ['x'] }] } });
    assert(ci.status === 400 && typeof ci.body?.message === 'string' && ci.body.message.length > 0, 'invalid questions refused with a message', ci);
    const cn = await call('POST', '/api/vendor/request-forms', { token: ownerA.token, body: { name: '   ', questions: [] } });
    assert(cn.status === 400, 'a form needs a name', cn);

    const ps = await call('PATCH', `/api/vendor/request-forms/${savedId}`, { token: ownerA.token, body: { name: 'Packing', questions: [{ type: 'long_text', label: 'What needs packing?', required: true }, { type: 'photos', label: 'Photos', maxPhotos: 2 }] } });
    assert(ps.status === 200 && ps.body?.form?.name === 'Packing' && ps.body.form.questions.length === 2, 'saved form edited', ps);
    const pOther = await call('PATCH', `/api/vendor/request-forms/${savedId}`, { token: ownerB.token, body: { name: 'Hijack' } });
    assert(pOther.status === 404, "another business can't edit the form", pOther);
    const gOther = await call('GET', '/api/vendor/request-forms', { token: ownerB.token });
    assert(gOther.status === 200 && gOther.body.forms.length === 0, "another business doesn't see the form", gOther);

    const g1 = await call('GET', '/api/vendor/request-forms', { token: ownerA.token });
    assert(g1.status === 200 && g1.body.forms.length === 2 && g1.body.forms[0].id === baseId && g1.body.baseFormId === baseId, 'library lists the base form first', g1);
    const custLib = await call('GET', '/api/vendor/request-forms', { token: custs[0].token });
    assert(custLib.status === 404, 'a customer has no library', custLib);

    console.log('\n── service form settings ──');
    const own = [{ type: 'date', label: 'Move date', required: true }, { type: 'photos', label: 'Photos of large items', maxPhotos: 3 }];
    const put1 = await call('PUT', `/api/vendor/services/${sA}/request-form`, { token: ownerA.token, body: { formId: null, useBase: true, questions: own } });
    assert(put1.status === 200 && put1.body?.settings?.useBase === true && put1.body.settings.questions.length === 2, 'service uses base plus its own questions', put1);
    assert(Array.isArray(put1.body?.resolved) && put1.body.resolved.length === 4 && put1.body.resolved[0].id.startsWith('b_') && put1.body.resolved[2].id.startsWith('s_'), 'resolved form: base first, then own', put1.body?.resolved);

    const putB = await call('PUT', `/api/vendor/services/${sA2}/request-form`, { token: ownerA.token, body: { formId: savedId, useBase: false, questions: [] } });
    assert(putB.status === 200 && putB.body?.settings?.formId === savedId && putB.body.resolved.every((x: any) => x.id.startsWith('f_')), 'service uses a saved form', putB);

    const foreignForm = (await call('POST', '/api/vendor/request-forms', { token: ownerB.token, body: { name: 'B form', questions: [] } })).body?.form?.id;
    const bad1 = await call('PUT', `/api/vendor/services/${sA}/request-form`, { token: ownerA.token, body: { formId: foreignForm, useBase: false, questions: [] } });
    assert(bad1.status === 400, "another business's form can't be used", bad1);
    const bad2 = await call('PUT', `/api/vendor/services/${sA}/request-form`, { token: ownerA.token, body: { formId: baseId, useBase: false, questions: [] } });
    assert(bad2.status === 400, 'the base form is chosen with useBase, not as a saved form', bad2);
    const bad3 = await call('PUT', `/api/vendor/services/${sA}/request-form`, { token: ownerA.token, body: { formId: savedId, useBase: false, questions: own } });
    assert(bad3.status === 400, 'a saved form and own questions together are refused', bad3);
    const bad4 = await call('PUT', `/api/vendor/services/${sA}/request-form`, { token: ownerB.token, body: { formId: null, useBase: false, questions: [] } });
    assert(bad4.status === 404, "another business can't change the service", bad4);
    const bad5 = await call('PUT', `/api/vendor/services/${sBook}/request-form`, { token: ownerA.token, body: { formId: null, useBase: true, questions: [] } });
    assert(bad5.status === 400 && bad5.body?.code === 'NOT_REQUEST_ONLY', 'a bookable service has no request form', bad5);
    const gs = await call('GET', `/api/vendor/services/${sA}/request-form`, { token: ownerA.token });
    assert(gs.status === 200 && gs.body?.settings?.useBase === true && gs.body.resolved.length === 4, 'service settings read back', gs);
    const [svcRow] = await q(`SELECT request_form_use_base, jsonb_array_length(request_questions) n, price, status FROM vendor_services WHERE id = $1`, [sA]);
    assert(svcRow.request_form_use_base === true && svcRow.n === 2 && svcRow.price === 30000 && svcRow.status === 'live', 'only the form columns changed on the service', svcRow);

    const delUsed = await call('DELETE', `/api/vendor/request-forms/${savedId}`, { token: ownerA.token });
    assert(delUsed.status === 409 && delUsed.body?.code === 'FORM_IN_USE' && delUsed.body.services?.[0]?.id === sA2, 'a form in use is not deleted, the services are named', delUsed);
    const delBase = await call('DELETE', `/api/vendor/request-forms/${baseId}`, { token: ownerA.token });
    assert(delBase.status === 409 && delBase.body?.code === 'BASE_FORM', 'the base form is not deleted', delBase);
    const spare = (await call('POST', '/api/vendor/request-forms', { token: ownerA.token, body: { name: 'Spare', questions: [] } })).body?.form?.id;
    const delOk = await call('DELETE', `/api/vendor/request-forms/${spare}`, { token: ownerA.token });
    const g2 = await call('GET', '/api/vendor/request-forms', { token: ownerA.token });
    assert(delOk.status === 200 && !g2.body.forms.some((f: any) => f.id === spare), 'an unused form is removed from the library', { delOk, g2 });

    console.log('\n── limits count the whole form a customer sees ──');
    const many = (n: number, t = 'short_text') => Array.from({ length: n }, (_, i) => ({ type: t, label: `Extra ${i}` }));
    const over = await call('PUT', `/api/vendor/services/${sA}/request-form`, { token: ownerA.token, body: { formId: null, useBase: true, questions: many(24) } });
    assert(over.status === 400 && /25 questions/.test(over.body?.message ?? ''), 'base (2) plus 24 own questions is refused', over);
    const fits = await call('PUT', `/api/vendor/services/${sA}/request-form`, { token: ownerA.token, body: { formId: null, useBase: true, questions: many(23) } });
    assert(fits.status === 200 && fits.body.resolved.length === 25, 'base (2) plus 23 own questions fits', fits);
    const baseGrow = await call('PATCH', `/api/vendor/request-forms/${baseId}`, { token: ownerA.token, body: { questions: [...baseQs, { type: 'short_text', label: 'One more' }] } });
    assert(baseGrow.status === 409 && baseGrow.body?.code === 'TOO_MANY_QUESTIONS' && baseGrow.body.services?.[0]?.id === sA, 'growing the base form past the limit for a service that uses it is refused, the service is named', baseGrow);
    const [baseNow] = await q(`SELECT jsonb_array_length(questions) n FROM request_forms WHERE id = $1`, [baseId]);
    assert(baseNow.n === 2, 'the refused base edit saved nothing', baseNow);
    const restore = await call('PUT', `/api/vendor/services/${sA}/request-form`, { token: ownerA.token, body: { formId: null, useBase: true, questions: own } });
    assert(restore.status === 200 && restore.body.resolved.length === 4, 'service form back to base plus 2', restore);

    console.log('\n── the form a customer sees ──');
    const pub = await call('GET', `/api/services/${sA}/request-form`);
    assert(pub.status === 200 && pub.body?.service?.id === sA && pub.body.business?.id === bizA && pub.body.questions?.length === 4 && pub.body.phoneRequired === true, 'public form for a request only service', pub);
    assert(pub.body?.cities && Array.isArray(pub.body.cities) && pub.body.cities.length === 0 && pub.body.cityRequired === false, 'no cities and no city needed for a business without a list', pub.body);
    const pubBook = await call('GET', `/api/services/${sBook}/request-form`);
    const pubDraft = await call('GET', `/api/services/${sDraft}/request-form`);
    assert(pubBook.status === 404 && pubDraft.status === 404, 'no public form for a bookable or draft service', { pubBook, pubDraft });
    const pubR = await call('GET', `/api/services/${sR}/request-form`);
    assert(pubR.status === 200 && pubR.body.questions.length === 0 && JSON.stringify(pubR.body.cities) === '["Norfolk","Suffolk"]' && pubR.body.cityRequired === true, "a service without a form has no questions, the business's cities are listed and required", pubR);

    console.log('\n── sending a request ──');
    const resolvedIds = pub.body.questions.map((x: any) => x.id);
    const [qAddr, qSize, qDate, qPics] = resolvedIds;
    const goodAnswers = { [qAddr]: '12 Main St', [qSize]: '1 Bedroom', [qDate]: '2026-12-12', [qPics]: [photo(1), photo(2)] };
    const send = (cust: { token: string }, body: Record<string, unknown>) =>
      call('POST', '/api/estimate-requests', { token: cust.token, body: { businessId: bizA, name: 'Ana Tester', email: 'ana@rf.test', phone: '757 555 0100', ...body } });

    const pushToken = `ExponentPushToken[rf${P}]`;
    await q(`UPDATE users SET expo_push_token = $1 WHERE id = $2`, [pushToken, ownerA.uid]);
    const fs = await import('fs');
    const pushedBefore = EXPO_FILE && fs.existsSync(EXPO_FILE) ? fs.readFileSync(EXPO_FILE, 'utf8').length : 0;
    const WS: any = (await import('ws')).default;
    const inbox: any[] = [];
    const ws = new WS(BASE.replace(/^http/, 'ws') + '/ws');
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
    ws.on('message', (d: any) => { try { inbox.push(JSON.parse(String(d))); } catch {} });
    ws.send(JSON.stringify({ type: 'auth', payload: { token: ownerA.token } }));
    await new Promise((r) => setTimeout(r, 500));
    const r1 = await send(custs[0], { serviceId: sA, preferredDate: '2026-12-12', answers: goodAnswers });
    assert(r1.status === 201 && r1.body?.success === true && typeof r1.body.request?.conversationId === 'string', 'request saved, chat opened', r1);
    const reqId = r1.body?.request?.id;
    const convId = r1.body?.request?.conversationId;
    const [saved] = await q(`SELECT answers, conversation_id, message_id, city, service_name, details FROM estimate_requests WHERE id = $1`, [reqId]);
    assert(Array.isArray(saved?.answers) && saved.answers.length === 4 && saved.answers[0].label === 'Pickup address' && saved.answers[3].type === 'photos', 'answers saved with labels and types', saved?.answers);
    assert(saved?.city === null && saved.service_name === 'Plan a', 'no city needed when the business has none', saved);
    const [msg] = await q(`SELECT kind, card, content, sender_id FROM messages WHERE id = $1`, [saved?.message_id]);
    assert(msg?.kind === 'request' && msg.card?.requestId === reqId && msg.sender_id === custs[0].uid, 'a request card message from the customer', msg);
    assert(msg?.content === 'Sent a request for Plan a (Dec 12, 2026).', 'card text reads on its own for older app builds', msg?.content);
    const [conv] = await q(`SELECT participant1_id, participant2_id, last_message_preview FROM conversations WHERE id = $1`, [convId]);
    assert(conv && [conv.participant1_id, conv.participant2_id].sort().join() === [custs[0].uid, ownerA.uid].sort().join(), 'the chat is between the customer and the business owner', conv);

    await new Promise((r) => setTimeout(r, 800));
    const live = inbox.find((m) => m.type === 'new_message' && m.payload?.kind === 'request');
    assert(!!live && live.payload.card?.requestId === reqId && live.payload.conversationId === convId && typeof live.payload.senderName === 'string', 'the owner with the app open gets the card live', inbox.map((m) => m.type));
    ws.close();
    if (EXPO_FILE) {
      await new Promise((r) => setTimeout(r, 1500));
      const pushed = fs.readFileSync(EXPO_FILE, 'utf8').slice(pushedBefore);
      assert(pushed.includes(pushToken) && pushed.includes('new_message') && pushed.includes('Sent a request for Plan a (Dec 12, 2026).'), 'the business owner gets a message push for the request', pushed.slice(0, 400));
    } else {
      console.log('  ⏭  push check skipped (set RF_TEST_EXPO_FILE)');
    }

    const ownerMsgs = await call('GET', `/api/conversations/${convId}/messages`, { token: ownerA.token });
    const card = (ownerMsgs.body?.messages ?? ownerMsgs.body ?? []).find?.((m: any) => m.kind === 'request');
    assert(ownerMsgs.status === 200 && card && card.card?.requestId === reqId && card.text === msg?.content, 'owner sees the card in the chat (kind, card, text)', ownerMsgs.body);

    const r2 = await send(custs[0], { serviceId: sA2, answers: { [(await call('GET', `/api/services/${sA2}/request-form`)).body.questions[0].id]: 'Kitchen and closets' } });
    assert(r2.status === 201 && r2.body.request.conversationId === convId, 'a second request reuses the same chat', r2);

    const miss = await send(custs[1], { serviceId: sA, answers: { ...goodAnswers, [qAddr]: '' } });
    assert(miss.status === 400 && miss.body?.field === qAddr, 'a missing required answer is refused and named', miss);
    const badPic = await send(custs[1], { serviceId: sA, answers: { ...goodAnswers, [qPics]: ['https://evil.test/x.jpg'] } });
    assert(badPic.status === 400 && badPic.body?.field === qPics, 'a photo not uploaded through Outsyde is refused', badPic);
    const book = await send(custs[1], { serviceId: sBook, answers: {} });
    assert(book.status === 400 && book.body?.field === 'serviceId', 'a bookable service does not take requests', book);
    const noPhone = await call('POST', '/api/estimate-requests', { token: custs[1].token, body: { businessId: bizA, serviceId: sA, name: 'Ana', email: 'ana@rf.test', answers: goodAnswers } });
    assert(noPhone.status === 400, 'phone is always required', noPhone);

    const emptyCity = await send(custs[4], { serviceId: sA, city: '', answers: goodAnswers });
    assert(emptyCity.status === 201, 'an empty city is the same as no city for a business without a list', emptyCity);
    await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [ownerA.uid, custs[3].uid]);
    const blocked = await send(custs[3], { serviceId: sA, answers: goodAnswers });
    assert(blocked.status === 201 && blocked.body?.request?.conversationId === null, 'blocked: the request is saved, no chat is opened', blocked);
    const [bconv] = await q(`SELECT count(*)::int n FROM conversations WHERE (participant1_id = $1 AND participant2_id = $2) OR (participant1_id = $2 AND participant2_id = $1)`, [ownerA.uid, custs[3].uid]);
    assert(bconv.n === 0, 'blocked: no conversation exists', bconv);

    console.log("\n── Royal Elite's current form keeps working ──");
    const legacy = { businessId: bizR, serviceId: sR, city: 'Norfolk', name: 'Ana Tester', email: 'ana@rf.test', phone: '757 555 0100', preferredDate: '2026-12-20', details: { homeSize: '2 Bedroom', fromAddress: '1 A St', notes: 'Piano' } };
    const lr = await call('POST', '/api/estimate-requests', { token: custs[2].token, body: legacy });
    assert(lr.status === 201 && lr.body?.success === true && lr.body.request?.id, "Royal Elite's payload is still accepted", lr);
    const [lrow] = await q(`SELECT details, answers, city FROM estimate_requests WHERE id = $1`, [lr.body?.request?.id]);
    assert(lrow?.details?.homeSize === '2 Bedroom' && Array.isArray(lrow.answers) && lrow.answers.length === 0 && lrow.city === 'Norfolk', 'details saved as before, no answers', lrow);
    const lrNoCity = await call('POST', '/api/estimate-requests', { token: custs[2].token, body: { ...legacy, city: undefined } });
    assert(lrNoCity.status === 400 && lrNoCity.body?.field === 'city', 'a business with a city list still needs a city', lrNoCity);
    const lrWrongCity = await call('POST', '/api/estimate-requests', { token: custs[2].token, body: { ...legacy, city: 'Richmond' } });
    assert(lrWrongCity.status === 400 && lrWrongCity.body?.field === 'city', 'a city outside the list is still refused', lrWrongCity);

    console.log('\n── who can see a request ──');
    const mine = await call('GET', '/api/me/requests', { token: custs[0].token });
    const mineRow = mine.body?.requests?.find((r: any) => r.id === reqId);
    assert(mine.status === 200 && mine.body.requests.length === 2 && mineRow?.businessName === 'Movers a' && mineRow.conversationId === convId && mineRow.vendorNotes === undefined, "customer's own requests, without the business's notes", mine);
    const other = await call('GET', '/api/me/requests', { token: stranger.token });
    assert(other.status === 200 && other.body.requests.length === 0, "a customer never sees someone else's requests", other);
    const one = await call('GET', `/api/requests/${reqId}`, { token: custs[0].token });
    assert(one.status === 200 && one.body?.request?.answers?.length === 4 && one.body.request.vendorNotes === undefined, 'customer opens their request', one);
    const oneOwner = await call('GET', `/api/requests/${reqId}`, { token: ownerA.token });
    assert(oneOwner.status === 200 && oneOwner.body?.request?.customerPhone === '757 555 0100' && oneOwner.body.request.answers.length === 4, 'business owner opens it with the contact details', oneOwner);
    const oneStranger = await call('GET', `/api/requests/${reqId}`, { token: stranger.token });
    const oneOtherOwner = await call('GET', `/api/requests/${reqId}`, { token: ownerB.token });
    assert(oneStranger.status === 404 && oneOtherOwner.status === 404, 'nobody else can open it', { oneStranger, oneOtherOwner });
    const vendorList = await call('GET', '/api/vendor/estimate-requests', { token: ownerA.token });
    const vrow = vendorList.body?.requests?.find((r: any) => r.id === reqId);
    assert(vendorList.status === 200 && vrow?.answers?.length === 4 && vrow.conversationId === convId && 'details' in vrow, 'vendor list gains answers and the chat, keeps every old field', vrow);

    console.log('\n── owner requesting their own service ──');
    const self = await call('POST', '/api/estimate-requests', { token: ownerA.token, body: { businessId: bizA, serviceId: sA, name: 'Benny', email: 'b@rf.test', phone: '757 555 0199', answers: goodAnswers } });
    assert(self.status === 201 && self.body?.request?.conversationId === null, 'saved, but no chat with yourself', self);

    console.log('\n── photo uploads for requests ──');
    const upload = (mime: string, name: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const boundary = `----rf${Date.now()}`;
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="folder"\r\n\r\nrequests\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`;
      const tail = `\r\n--${boundary}--\r\n`;
      const body = Buffer.concat([Buffer.from(head), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from(tail)]);
      const u = new URL('/api/media/upload-image', BASE!);
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length), Authorization: `Bearer ${custs[5].token}` } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
      });
      req.on('error', reject); req.write(body); req.end();
    });
    const up = await upload('image/jpeg', 'a.jpg');
    const upUrl: string = up.body?.url ?? up.body?.imageUrl ?? '';
    assert(up.status === 200 && upUrl.startsWith(`${R2}/requests/`), 'a photo uploads to the requests folder', up);
    const upPdf = await upload('application/pdf', 'a.pdf');
    assert(upPdf.status === 400, 'the requests folder takes photos only', upPdf);
    if (upUrl) {
      const withUpload = await send(custs[5], { serviceId: sA, answers: { ...goodAnswers, [qPics]: [upUrl] } });
      assert(withUpload.status === 201, 'an uploaded photo is accepted as an answer', withUpload);
    }

    console.log('\n── message routes stay as they were ──');
    const plain = await call('POST', `/api/conversations/${convId}/messages`, { token: ownerA.token, body: { content: 'Thanks, I will call you today.', kind: 'request', card: { requestId: 'fake' } } });
    assert(plain.status === 200 && plain.body?.message?.kind === 'text' && (plain.body.message.card ?? null) === null, 'a client cannot send a request card through the message route', plain);
  } finally {
    await q(`DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM estimate_requests WHERE business_id = ANY($1)`, [bizs]);
    const convs = (await q(`SELECT id FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [users])).map((r) => r.id);
    await q(`DELETE FROM messages WHERE conversation_id = ANY($1)`, [convs]);
    await q(`DELETE FROM conversations WHERE id = ANY($1)`, [convs]);
    await q(`UPDATE vendor_services SET request_form_id = NULL WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM request_forms WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
