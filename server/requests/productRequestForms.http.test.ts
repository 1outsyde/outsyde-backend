/**
 * Request forms step P (products, migration 109): HTTP integration tests.
 *
 * Legend 2026-11-09, calls P1 to P8 as recommended: a product takes a form exactly like a service (request_only plus
 * the three form columns, from the business's own library); requests carry product_id and service_name holds the
 * product's name; the public product list and search hide request only products unless the client asks
 * (includeRequestOnly=1); the three buying gates refuse them with "This is priced on request. Send a request
 * instead."; the email row reads Product (estimates.test.ts).
 *
 * Run with: npx tsx server/requests/productRequestForms.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (migrations 096, 108 and 109):
 *   PDRF_TEST_BASE_URL  e.g. http://localhost:5062   (must be localhost)
 *   PDRF_TEST_PG_URL    the SAME scratch database (localhost only; seeds + cleans up)
 *   PDRF_TEST_STRIPE_PORT  the port the server's Stripe stub points at (the payment intent gate never reaches it)
 *   JWT_SECRET          identical to the server's
 * Skips (exit 0) when PDRF_TEST_BASE_URL is unset; refuses any non-local host. RESEND_API_KEY must be unset.
 */
import http from 'http';

const BASE = process.env.PDRF_TEST_BASE_URL;
const PG_URL = process.env.PDRF_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; body: any; setCookie?: string[] }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.98.1.${Math.floor(Math.random() * 200) + 1}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    if (o.cookie) headers['Cookie'] = o.cookie;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        let json: any = null; try { json = JSON.parse(b); } catch {}
        resolve({ status: res.statusCode || 0, body: json, setCookie: res.headers['set-cookie'] as string[] | undefined });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const PRICE_ON_REQUEST = 'This is priced on request. Send a request instead.';

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set PDRF_TEST_BASE_URL (+ PDRF_TEST_PG_URL) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'pdrf-test-jwt-secret';
  const { generateAccessToken } = await import('../auth');
  const bcryptMod: any = await import('bcrypt');
  const bcrypt = bcryptMod.default ?? bcryptMod;
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `pdrf${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const PASSWORD = 'Pdrf-test-pass-1';
  const hash = await bcrypt.hash(PASSWORD, 4);

  const mkUser = async (key: string, o: { first?: string; vendor?: boolean } = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name, is_vendor, password) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3, $4, $5)`,
      [uid, `${uid}@pdrf.test`, o.first ?? 'Tasha', o.vendor ?? false, hash]);
    users.push(uid);
    return { uid, email: `${uid}@pdrf.test`, token: generateAccessToken({ userId: uid, isVendor: !!o.vendor, isAdmin: false }) };
  };
  const mkBiz = async (key: string, ownerId: string, cities: string[] = []) => {
    const bid = id(`b-${key}`);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, service_cities, stripe_account_id, stripe_onboarding_complete, has_products, subscription_active)
             VALUES ($1, $2, $3, 'food', 'approved', $4, $5, true, true, true)`, [bid, ownerId, `Cakes ${key}`, cities, `acct_${bid}`]);
    // Open for sales and visible to the public: an active plan (same seed as productStockOptional.http.test.ts).
    await q(`INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, stripe_subscription_id, status, current_period_end) VALUES ($1, $2, $3, $4, 'active', now() + interval '30 days')`,
      [ownerId, bid, tier, `sub_${bid}`]);
    bizs.push(bid);
    return bid;
  };
  const mkProduct = async (key: string, bid: string, o: { requestOnly?: boolean; status?: string; active?: boolean; name?: string } = {}) => {
    const pid = id(`p-${key}`);
    await q(`INSERT INTO vendor_products (id, business_id, name, description, price, inventory, track_inventory, is_active, status, request_only, stripe_price_id)
             VALUES ($1, $2, $3, 'Made to order', 4500, 10, false, $4, $5, $6, 'price_stub_pdrf')`,
      [pid, bid, o.name ?? `${P} Cake ${key}`, o.active ?? true, o.status ?? 'live', o.requestOnly ?? true]);
    return pid;
  };
  const mkSvc = async (key: string, bid: string) => {
    const sid = id(`s-${key}`);
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status, request_only) VALUES ($1, $2, $3, 30000, 60, true, 'live', true)`,
      [sid, bid, `Tasting ${key}`]);
    return sid;
  };

  const tier = id('tier');
  await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps) VALUES ($1, $2, 'T', 2900, 200)`, [tier, tier]);
  const ownerU = await mkUser('ou', { first: 'Benny', vendor: true });
  const owner2U = await mkUser('ou2', { first: 'Other', vendor: true });
  const cust = await mkUser('c1');
  const biz = await mkBiz('a', ownerU.uid, ['Freeport']);
  const biz2 = await mkBiz('b', owner2U.uid);
  const pReq = await mkProduct('req', biz);
  const pReq2 = await mkProduct('req2', biz);
  const pSell = await mkProduct('sell', biz, { requestOnly: false });
  const pDraft = await mkProduct('draft', biz, { status: 'draft' });
  const pOff = await mkProduct('off', biz, { active: false });
  const pOther = await mkProduct('other', biz2);
  const sA = await mkSvc('a', biz);

  try {
    console.log('\n── product form settings (owner) ──');
    const cb = await call('POST', '/api/vendor/request-forms', { token: ownerU.token, body: { name: 'Base form', isBase: true, questions: [
      { type: 'short_text', label: 'What is the occasion?', required: true },
    ] } });
    assert(cb.status === 201 || cb.status === 200, 'business base form created', cb);
    const baseId = cb.body?.form?.id;
    const cs = await call('POST', '/api/vendor/request-forms', { token: ownerU.token, body: { name: 'Cake form', questions: [
      { type: 'choice', label: 'How many tiers?', options: ['One', 'Two', 'Three'], required: true },
    ] } });
    const savedId = cs.body?.form?.id;
    assert(!!savedId, 'saved form created', cs);

    const g0 = await call('GET', `/api/vendor/products/${pReq}/request-form`, { token: ownerU.token });
    assert(g0.status === 200 && g0.body.settings.formId === null && g0.body.settings.useBase === false && g0.body.resolved.length === 1
      && g0.body.resolved[0].label === 'What is the occasion?', 'nothing set: the base form (call 9 holds for products)', g0.body);
    const notMine = await call('GET', `/api/vendor/products/${pOther}/request-form`, { token: ownerU.token });
    assert(notMine.status === 404 && notMine.body?.error === 'Product not found', "another business's product is not found", notMine);
    const noAuth = await call('GET', `/api/vendor/products/${pReq}/request-form`);
    assert(noAuth.status === 401 || noAuth.status === 403, 'signed out is refused', noAuth.status);
    const sellPut = await call('PUT', `/api/vendor/products/${pSell}/request-form`, { token: ownerU.token, body: { formId: savedId } });
    assert(sellPut.status === 400 && sellPut.body?.code === 'NOT_REQUEST_ONLY' && sellPut.body.message === 'Only contact for pricing products use a request form.', 'a product sold as is takes no form', sellPut);

    const put1 = await call('PUT', `/api/vendor/products/${pReq}/request-form`, { token: ownerU.token, body: { formId: savedId } });
    assert(put1.status === 200 && put1.body.settings.formId === savedId && put1.body.resolved[0].label === 'How many tiers?', 'product uses a saved form', put1);
    const [row1] = await q(`SELECT request_form_id, request_form_use_base, request_questions FROM vendor_products WHERE id = $1`, [pReq]);
    assert(row1.request_form_id === savedId && row1.request_form_use_base === false && Array.isArray(row1.request_questions) && row1.request_questions.length === 0, 'saved on the product row', row1);
    const otherForm = await call('POST', '/api/vendor/request-forms', { token: owner2U.token, body: { name: 'Theirs', questions: [{ type: 'short_text', label: 'x', required: false }] } });
    const stolen = await call('PUT', `/api/vendor/products/${pReq2}/request-form`, { token: ownerU.token, body: { formId: otherForm.body?.form?.id } });
    assert(stolen.status === 400 && stolen.body?.field === 'formId', "another business's form is refused", stolen);
    const put2 = await call('PUT', `/api/vendor/products/${pReq2}/request-form`, { token: ownerU.token, body: { useBase: true, questions: [{ type: 'long_text', label: 'Describe the design', required: false }] } });
    assert(put2.status === 200 && put2.body.resolved.length === 2 && put2.body.resolved[0].label === 'What is the occasion?' && put2.body.resolved[1].label === 'Describe the design', 'base form then the product\'s own question', put2.body);

    console.log('\n── the library counts products ──');
    const del = await call('DELETE', `/api/vendor/request-forms/${savedId}`, { token: ownerU.token });
    assert(del.status === 409 && del.body?.code === 'FORM_IN_USE' && del.body.services?.some((s: any) => s.id === pReq), 'a form a product uses can\'t be removed (the product is listed)', del);
    // 25 base questions + the product's own one = 26, over the 25 question limit.
    const big = Array.from({ length: 25 }, (_, i) => ({ type: 'short_text', label: `Base q ${i}`, required: false }));
    const baseGrow = await call('PATCH', `/api/vendor/request-forms/${baseId}`, { token: ownerU.token, body: { questions: big } });
    assert(baseGrow.status === 409 && baseGrow.body?.code === 'TOO_MANY_QUESTIONS' && baseGrow.body.services?.some((s: any) => s.id === pReq2),
      "the base form can't grow past a product's question limit (the product is listed)", baseGrow.body);
    const [baseAfter] = await q(`SELECT jsonb_array_length(questions) n FROM request_forms WHERE id = $1`, [baseId]);
    assert(baseAfter.n === 1, 'the base form is unchanged', baseAfter);

    console.log('\n── public product form ──');
    const pub = await call('GET', `/api/products/${pReq2}/request-form`);
    assert(pub.status === 200 && pub.body.itemType === 'product' && pub.body.product?.id === pReq2 && pub.body.service?.id === pReq2 && pub.body.service.price === null
      && pub.body.business?.id === biz && pub.body.cityRequired === true && pub.body.cities?.[0] === 'Freeport' && pub.body.phoneRequired === true && pub.body.questions.length === 2,
      'public form: product, business, cities, questions, no price', pub.body);
    for (const [label, pid] of [['sold as is', pSell], ['draft', pDraft], ['inactive', pOff], ['unknown', id('nope')]] as const) {
      const r = await call('GET', `/api/products/${pid}/request-form`);
      assert(r.status === 404, `a ${label} product has no public form`, r);
    }
    const svcRoute = await call('GET', `/api/services/${pReq2}/request-form`);
    assert(svcRoute.status === 404, 'a product id is not a service', svcRoute.status);

    console.log('\n── sending a product request ──');
    const qs = pub.body.questions;
    const answers = { [qs[0].id]: 'Birthday' };
    const body = (o: Record<string, unknown> = {}) => ({ businessId: biz, productId: pReq2, city: 'Freeport', name: 'Tasha M.', email: 'tasha@pdrf.test', phone: '516 555 0142', answers, ...o });
    const both = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ serviceId: sA }) });
    assert(both.status === 400, 'a service and a product together are refused', both);
    const noBiz = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ businessId: undefined, photographerId: id('ph') }) });
    assert(noBiz.status === 400 && noBiz.body?.message === 'Please check the form and try again.', 'a product needs its business', noBiz);
    for (const [label, pid] of [['sold as is', pSell], ['draft', pDraft], ['inactive', pOff], ["another business's", pOther], ['unknown', id('nope')]] as const) {
      const r = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ productId: pid }) });
      assert(r.status === 400 && r.body?.field === 'productId' && r.body.message === "That product isn't taking requests. Please choose another.", `a ${label} product is refused`, r);
    }
    const noCity = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ city: undefined }) });
    assert(noCity.status === 400 && noCity.body?.field === 'city', 'the business city list applies to products', noCity);
    const miss = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ answers: {} }) });
    assert(miss.status === 400 && miss.body?.field === qs[0].id, "the product's form is checked", miss);
    const unauth = await call('POST', '/api/estimate-requests', { body: body() });
    assert(unauth.status === 401, 'signed out is refused', unauth.status);

    const ok = await call('POST', '/api/estimate-requests', { token: cust.token, body: body() });
    assert(ok.status === 201 && ok.body?.request?.id, 'a product request is saved', ok);
    const reqId = ok.body?.request?.id;
    const [saved] = await q(`SELECT business_id, photographer_id, service_id, product_id, service_name, answers, conversation_id FROM estimate_requests WHERE id = $1`, [reqId]);
    assert(saved && saved.business_id === biz && saved.product_id === pReq2 && saved.service_id === null && saved.photographer_id === null && saved.service_name === `${P} Cake req2`,
      'row: product_id set, service_id empty, service_name is the product name', saved);
    assert(Array.isArray(saved?.answers) && saved.answers.some((a: any) => a.value === 'Birthday'), 'answers saved', saved?.answers);
    assert(!!saved?.conversation_id, 'the request lands in Messages', saved);
    const [msg] = await q(`SELECT kind, card FROM messages WHERE conversation_id = $1 AND kind = 'request' ORDER BY created_at DESC LIMIT 1`, [saved?.conversation_id]);
    const card = typeof msg?.card === 'string' ? JSON.parse(msg.card) : msg?.card;
    assert(!!msg && card?.productId === pReq2 && card?.requestId === reqId && card?.serviceName === `${P} Cake req2`, 'the chat card carries productId (Send a quote starts a deliverable)', card);

    const vend = await call('GET', '/api/vendor/estimate-requests', { token: ownerU.token });
    const vr = (vend.body?.requests ?? []).find((r: any) => r.id === reqId);
    assert(vend.status === 200 && vr?.productId === pReq2 && vr.itemType === 'product' && vr.serviceId === null && vr.serviceName === `${P} Cake req2`, 'the business dashboard shows it as a product request', vr ?? vend.body);
    const mine = await call('GET', '/api/me/requests', { token: cust.token });
    const mr = (mine.body?.requests ?? []).find((r: any) => r.id === reqId);
    assert(mine.status === 200 && mr?.productId === pReq2 && mr.itemType === 'product' && mr.businessName === 'Cakes a', "the customer's list shows the product request", mr ?? mine.body);
    const det = await call('GET', `/api/requests/${reqId}`, { token: ownerU.token });
    assert(det.status === 200 && (det.body?.request?.productId ?? det.body?.productId) === pReq2, 'the request detail has the product', det.body);

    const svcSend = await call('POST', '/api/estimate-requests', { token: cust.token, body: body({ productId: undefined, serviceId: sA, answers: { [(await call('GET', `/api/services/${sA}/request-form`)).body.questions[0].id]: 'x' } }) });
    const [svcRow] = await q(`SELECT product_id, service_id FROM estimate_requests WHERE id = $1`, [svcSend.body?.request?.id]);
    assert(svcSend.status === 201 && svcRow?.product_id === null && svcRow?.service_id === sA, 'service requests are unchanged', svcSend);
    let bothErr: any = null;
    try { await q(`UPDATE estimate_requests SET product_id = $1 WHERE id = $2`, [pReq2, svcSend.body?.request?.id]); } catch (e) { bothErr = e; }
    assert(bothErr?.code === '23514' && bothErr?.constraint === 'estimate_requests_service_or_product', 'the database refuses a request for a service and a product (the CHECK)', bothErr?.message);

    console.log('\n── public list and search hide them unless asked ──');
    const list = await call('GET', `/api/businesses/${biz}/products`);
    const listIds = (Array.isArray(list.body) ? list.body : list.body?.products ?? []).map((p: any) => p.id);
    assert(list.status === 200 && listIds.includes(pSell) && !listIds.includes(pReq) && !listIds.includes(pReq2), 'old clients: sold products only', listIds);
    const listNew = await call('GET', `/api/businesses/${biz}/products?includeRequestOnly=1`);
    const newRows = Array.isArray(listNew.body) ? listNew.body : listNew.body?.products ?? [];
    const newIds = newRows.map((p: any) => p.id);
    assert(listNew.status === 200 && newIds.includes(pSell) && newIds.includes(pReq) && newIds.includes(pReq2) && !newIds.includes(pDraft) && !newIds.includes(pOff),
      'includeRequestOnly=1: request only products too (still live and active only)', newIds);
    assert(newRows.find((p: any) => p.id === pReq)?.requestOnly === true && newRows.find((p: any) => p.id === pSell)?.requestOnly === false, 'each row says requestOnly', newRows.map((p: any) => [p.id, p.requestOnly]));
    const listTrue = await call('GET', `/api/businesses/${biz}/products?includeRequestOnly=true`);
    const listJunk = await call('GET', `/api/businesses/${biz}/products?includeRequestOnly=yes`);
    const ids = (r: any) => (Array.isArray(r.body) ? r.body : r.body?.products ?? []).map((p: any) => p.id);
    assert(ids(listTrue).includes(pReq) && !ids(listJunk).includes(pReq), 'true also asks; anything else does not');

    const search = await call('GET', `/api/search?q=${encodeURIComponent(P)}&scope=products`);
    const sIds = (search.body?.results ?? []).map((r: any) => r.id);
    assert(search.status === 200 && sIds.includes(pSell) && !sIds.includes(pReq), 'search: sold products only for old clients', search.body?.results?.map((r: any) => [r.id, r.type]));
    const searchNew = await call('GET', `/api/search?q=${encodeURIComponent(P)}&scope=products&includeRequestOnly=1`);
    const snRows = searchNew.body?.results ?? [];
    assert(searchNew.status === 200 && snRows.some((r: any) => r.id === pReq && r.requestOnly === true) && snRows.find((r: any) => r.id === pSell)?.requestOnly === undefined,
      'search with includeRequestOnly=1: marked requestOnly, sold rows unchanged', snRows.map((r: any) => [r.id, r.requestOnly]));
    // The older unified search reads search_index, rebuilt only by an admin: a product indexed while sold and
    // switched on afterwards is left out at read time.
    await q(`INSERT INTO search_index (entity_type, entity_id, name, is_active) VALUES ('product', $1, $2, true), ('product', $3, $4, true)`,
      [pReq, `${P} Cake req`, pSell, `${P} Cake sell`]);
    const us = await call('GET', `/api/unified-search?q=${encodeURIComponent(P)}&types=product`);
    const usIds = (us.body?.results ?? []).map((r: any) => r.entityId ?? r.id);
    assert(us.status === 200 && usIds.includes(pSell) && !usIds.includes(pReq), 'unified search leaves out a product switched on after it was indexed', us.body);
    // Follow up: contact for pricing services say so in search (no starting price shown by clients).
    await q(`UPDATE vendor_services SET name = $1 WHERE id = $2`, [`${P} Tasting`, sA]);
    const ss = await call('GET', `/api/search?q=${encodeURIComponent(P)}&scope=services`);
    const sRow = (ss.body?.results ?? []).find((r: any) => r.id === sA);
    assert(ss.status === 200 && sRow?.type === 'service' && sRow.requestOnly === true, 'search: a contact for pricing service is marked requestOnly', ss.body?.results?.map((r: any) => [r.id, r.type, r.requestOnly]));
    await q(`UPDATE vendor_services SET request_only = false WHERE id = $1`, [sA]);
    const ss2 = await call('GET', `/api/search?q=${encodeURIComponent(P)}&scope=services`);
    const sRow2 = (ss2.body?.results ?? []).find((r: any) => r.id === sA);
    assert(!!sRow2 && sRow2.requestOnly === undefined && typeof sRow2.price === 'number', 'search: a bookable service is unchanged', sRow2);
    await q(`UPDATE vendor_services SET request_only = true WHERE id = $1`, [sA]);

    // Follow up: Saved never carries a contact for pricing product's starting price.
    const fav1 = await call('POST', '/api/favorites', { token: cust.token, body: { type: 'product', id: pReq } });
    const fav2 = await call('POST', '/api/favorites', { token: cust.token, body: { type: 'product', id: pSell } });
    const favs = await call('GET', '/api/users/me/favorites', { token: cust.token });
    const fReq = (favs.body?.favorites ?? []).find((f: any) => f.id === pReq);
    const fSell = (favs.body?.favorites ?? []).find((f: any) => f.id === pSell);
    assert(fav1.status === 200 && fav2.status === 200 && fReq?.requestOnly === true && !('priceCents' in fReq) && fReq.businessId === biz, 'Saved: requestOnly, no priceCents', fReq);
    assert(fSell?.priceCents === 4500 && fSell.requestOnly === undefined, 'Saved: a sold product keeps its price', fSell);

    const detail = await call('GET', `/api/products/${pReq}`);
    assert(detail.status === 200 && detail.body?.requestOnly === true, 'the product page sees requestOnly', detail.body?.requestOnly);

    console.log('\n── buying gates refuse them (call P4) ──');
    const login = await call('POST', '/api/auth/login', { body: { email: cust.email, password: PASSWORD } });
    const cookie = (login.setCookie ?? []).map((c) => c.split(';')[0]).join('; ');
    assert(login.status === 200 && !!cookie, 'customer signed in for the cart routes', login.status);
    const addReq = await call('POST', '/api/cart/add', { cookie, body: { productId: pReq, productName: 'Cake', priceInCents: 4500, quantity: 1, businessId: biz } });
    assert(addReq.status === 400 && addReq.body?.error?.code === 'PRICE_ON_REQUEST' && addReq.body.error.message === PRICE_ON_REQUEST, 'cart add refuses a request only product', addReq);
    // Variations are kept while it's on (call P7): the answer is still PRICE_ON_REQUEST, not a variant error.
    await q(`INSERT INTO product_variants (id, product_id, label, is_active) VALUES ($1, $2, 'Two tiers', true)`, [id('v1'), pReq]);
    const addVarNone = await call('POST', '/api/cart/add', { cookie, body: { productId: pReq, productName: 'Cake', priceInCents: 4500, quantity: 1, businessId: biz } });
    const addVarBad = await call('POST', '/api/cart/add', { cookie, body: { productId: pReq, productName: 'Cake', priceInCents: 4500, quantity: 1, businessId: biz, variantId: id('nope') } });
    assert(addVarNone.body?.error?.code === 'PRICE_ON_REQUEST' && addVarBad.body?.error?.code === 'PRICE_ON_REQUEST', 'with kept variations it still says priced on request', { addVarNone, addVarBad });
    const addSell = await call('POST', '/api/cart/add', { cookie, body: { productId: pSell, productName: 'Cake', priceInCents: 4500, quantity: 1, businessId: biz } });
    assert(addSell.status === 200 || addSell.status === 201, 'cart add still takes a sold product', addSell);
    const pi = await call('POST', '/api/cart/payment-intent', { token: cust.token, body: {
      items: [{ productId: pReq, vendorId: biz, priceCents: 4500, quantity: 1, name: 'Cake' }],
      shippingAddress: { line1: '1 Main St', city: 'Freeport', state: 'NY', zipCode: '11520' },
    } });
    assert(pi.status === 400 && pi.body?.error?.code === 'PRICE_ON_REQUEST' && pi.body.error.message === PRICE_ON_REQUEST, 'checkout refuses it', pi);
    const pv = await call('POST', '/api/cart/price-preview', { token: cust.token, body: { items: [{ productId: pReq, vendorId: biz, priceCents: 4500, quantity: 1, name: 'Cake' }] } });
    assert(pv.status === 400 && pv.body?.error?.code === 'PRICE_ON_REQUEST', 'the price preview refuses it the same way', pv);
    // An older cart row (added before the business switched it on) is refused at the legacy checkout.
    await q(`DELETE FROM cart_items WHERE user_id = $1`, [cust.uid]);
    await q(`INSERT INTO cart_items (user_id, product_id, product_name, price_in_cents, quantity, business_id) VALUES ($1, $2, 'Cake', 4500, 1, $3)`, [cust.uid, pReq, biz]);
    const legacy = await call('POST', '/api/cart/checkout', { cookie, body: { shippingAddress: { line1: '1 Main St', city: 'Freeport', state: 'NY', zipCode: '11520' } } });
    assert(legacy.status === 400 && legacy.body?.error?.code === 'PRICE_ON_REQUEST' && legacy.body.error.message === PRICE_ON_REQUEST, 'the legacy cart checkout refuses it', legacy);
    const orders = await q(`SELECT count(*)::int n FROM orders WHERE customer_id = $1`, [cust.uid]);
    assert(orders[0].n === 0, 'no order was made', orders);

    console.log('\n── owner create and edit ──');
    const createdNo = await call('POST', '/api/vendor/products', { token: ownerU.token, body: { name: `${P} plain`, price: 1500 } });
    const createdYes = await call('POST', '/api/vendor/products', { token: ownerU.token, body: { name: `${P} custom dress`, price: 900, requestOnly: true } });
    const cNo = createdNo.body?.product ?? createdNo.body;
    const cYes = createdYes.body?.product ?? createdYes.body;
    assert((createdNo.status === 200 || createdNo.status === 201) && cNo?.requestOnly === false, 'a new product is sold as is by default', createdNo);
    assert((createdYes.status === 200 || createdYes.status === 201) && cYes?.requestOnly === true, 'a new product can start as contact for pricing', createdYes);
    const lowPrice = await call('POST', '/api/vendor/products', { token: ownerU.token, body: { name: `${P} free`, price: 0, requestOnly: true } });
    assert(lowPrice.status === 400, 'a starting price of at least $7 is still required (call P2)', lowPrice.status);
    const flip = await call('PATCH', `/api/vendor/products/${pSell}`, { token: ownerU.token, body: { requestOnly: true } });
    const [flipped] = await q(`SELECT request_only, price, status FROM vendor_products WHERE id = $1`, [pSell]);
    assert(flip.status === 200 && flipped.request_only === true && flipped.price === 4500 && flipped.status === 'live', 'switching it on keeps price and status', { flip: flip.status, flipped });
    const flipBack = await call('PATCH', `/api/vendor/products/${pSell}`, { token: ownerU.token, body: { requestOnly: false } });
    const [back] = await q(`SELECT request_only FROM vendor_products WHERE id = $1`, [pSell]);
    assert(flipBack.status === 200 && back.request_only === false, 'and off again', flipBack.status);
    const otherFlip = await call('PATCH', `/api/vendor/products/${pOther}`, { token: ownerU.token, body: { requestOnly: false } });
    const [still] = await q(`SELECT request_only FROM vendor_products WHERE id = $1`, [pOther]);
    assert(otherFlip.status >= 400 && still.request_only === true, "another business's product can't be switched", otherFlip.status);
    if (cNo?.id) await q(`DELETE FROM vendor_products WHERE id = $1`, [cNo.id]).catch(() => undefined);
    if (cYes?.id) await q(`DELETE FROM vendor_products WHERE id = $1`, [cYes.id]).catch(() => undefined);
  } finally {
    const all = [...users];
    await q(`DELETE FROM cart_items WHERE user_id = ANY($1)`, [all]).catch(() => undefined);
    await q(`DELETE FROM user_favorites WHERE user_id = ANY($1)`, [all]).catch(() => undefined);
    await q(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1))`, [all]).catch(() => undefined);
    await q(`DELETE FROM estimate_requests WHERE customer_id = ANY($1)`, [all]).catch(() => undefined);
    await q(`DELETE FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [all]).catch(() => undefined);
    await q(`UPDATE vendor_products SET request_form_id = NULL WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`UPDATE vendor_services SET request_form_id = NULL WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM request_forms WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM search_index WHERE entity_id IN (SELECT id FROM vendor_products WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM product_variants WHERE product_id IN (SELECT id FROM vendor_products WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM vendor_products WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM subscription_tiers WHERE id = $1`, [tier]).catch(() => undefined);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [all]).catch(() => undefined);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
