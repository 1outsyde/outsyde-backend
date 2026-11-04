/**
 * Quotes (Quotes in Messages, step 2): HTTP integration tests.
 *
 * Legend 2026-11-04 (all recommended): expires after 7 days or when the job starts if sooner; edits allowed until
 * paid (new "Updated quote" card, every card reads the current version); staff with a login send from their own
 * chat and the quote records the staff member; title, date, start time, length, total and deposit or full are
 * required; quote email built but off; several open quotes allowed; quotes don't block the calendar.
 *
 * Run with: npx tsx server/quotes/quotes.http.test.ts
 *
 * SCRATCH ONLY. Backend booted on localhost against a LOCAL scratch Postgres (migrations 096 + 097 applied):
 *   QT_TEST_BASE_URL   e.g. http://localhost:5062 (must be localhost)
 *   QT_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   QT_TEST_EXPO_FILE  optional: file the local Expo stub appends push bodies to
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when QT_TEST_BASE_URL is unset; refuses any non-local host.
 */
import http from 'http';

const BASE = process.env.QT_TEST_BASE_URL;
const PG_URL = process.env.QT_TEST_PG_URL;
const EXPO_FILE = process.env.QT_TEST_EXPO_FILE || '';

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
  if (!BASE) { console.log('⏭  skipped: set QT_TEST_BASE_URL (+ QT_TEST_PG_URL) to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: BASE and PG_URL must both be localhost');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'qt-test-jwt-secret';
  const { generateAccessToken } = await import('../auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `qt${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, first = 'Ana') => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3)`, [uid, `${uid}@qt.test`, first]);
    users.push(uid);
    return { uid, token: generateAccessToken({ userId: uid, isVendor: false, isAdmin: false }) };
  };
  const mkBiz = async (key: string, ownerId: string, tz: string | null) => {
    const bid = id(`b-${key}`);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, time_zone) VALUES ($1, $2, $3, 'home', 'approved', $4)`, [bid, ownerId, `Movers ${key}`, tz]);
    bizs.push(bid);
    return bid;
  };
  const mkConv = async (a: string, b: string) => {
    const [p1, p2] = a < b ? [a, b] : [b, a];
    const cid = id(`c-${a.slice(-4)}-${b.slice(-4)}`);
    await q(`INSERT INTO conversations (id, participant1_id, participant2_id) VALUES ($1, $2, $3)`, [cid, p1, p2]);
    return cid;
  };

  const owner = await mkUser('owner', 'Benny');
  const owner2 = await mkUser('owner2', 'Other');
  const staffUser = await mkUser('staff', 'Jay');
  const cust = await mkUser('cust');
  const cust2 = await mkUser('cust2');
  const stranger = await mkUser('x');
  const biz = await mkBiz('a', owner.uid, null); // no time zone saved: New York
  const biz2 = await mkBiz('b', owner2.uid, 'America/Los_Angeles');
  const staffId = id('staff');
  await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, role, status) VALUES ($1, $2, $3, 'Jay', 'staff', 'active')`, [staffId, biz, staffUser.uid]);
  const svc = id('svc');
  await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status, request_only) VALUES ($1, $2, 'Standard Move', 30000, 180, true, 'live', true)`, [svc, biz]);
  const svcOther = id('svc2');
  await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status) VALUES ($1, $2, 'Other plan', 30000, 180, true, 'live')`, [svcOther, biz2]);
  const conv = await mkConv(owner.uid, cust.uid);
  const convStaff = await mkConv(staffUser.uid, cust2.uid);
  const convOther = await mkConv(owner2.uid, cust.uid);
  const reqId = id('req');
  await q(`INSERT INTO estimate_requests (id, business_id, customer_id, service_id, service_name, customer_name, customer_email, customer_phone, status, conversation_id) VALUES ($1, $2, $3, $4, 'Standard Move', 'Ana', 'ana@qt.test', '757 555 0100', 'new', $5)`, [reqId, biz, cust.uid, svc, conv]);

  const jobDate = daysFromNow(10);
  const quoteBody = (o: Record<string, unknown> = {}) => ({
    conversationId: conv, requestId: reqId, serviceId: svc,
    title: '2 Bedroom Move', details: 'Crew of 3, truck, up to 5 hours', extrasNote: 'Extra hours $50 each, only if you approve',
    jobDate, startTime: '09:00', durationMinutes: 300, totalCents: 65000, paymentMode: 'deposit', depositCents: 10000, ...o,
  });
  const fs = await import('fs');
  const pushMark = () => (EXPO_FILE && fs.existsSync(EXPO_FILE) ? fs.readFileSync(EXPO_FILE, 'utf8').length : 0);

  try {
    console.log('\n── sending a quote ──');
    await q(`UPDATE users SET expo_push_token = $1 WHERE id = $2`, [`ExponentPushToken[${P}c]`, cust.uid]);
    const mark = pushMark();
    const s1 = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody() });
    const qa = s1.body?.quote;
    assert(s1.status === 201 && qa?.status === 'sent' && qa.version === 1 && qa.title === '2 Bedroom Move', 'owner sends a quote', s1);
    assert(qa?.amounts?.depositOrTotalCents === 10000 && qa.amounts.balanceCents === 55000 && qa.amounts.payNowCents === 10000 + qa.amounts.serviceFeeCents && qa.amounts.serviceFeeCents > 0, 'amounts: deposit now plus the fee, balance later', qa?.amounts);
    assert(qa?.timeZone === 'America/New_York' && qa.staffMemberId === null && qa.customerId === cust.uid && qa.businessId === biz, 'New York when the business has no time zone; no staff; customer is the other person in the chat', qa);
    const sevenDays = Date.now() + 7 * 86400000;
    assert(Math.abs(new Date(qa?.expiresAt).getTime() - sevenDays) < 60000, 'expires 7 days after sending (job is later)', qa?.expiresAt);
    assert(typeof qa?.linkCode === 'string' && qa.linkCode.length >= 12, 'link code for goutsyde.com/q/', qa?.linkCode);
    const [card] = await q(`SELECT kind, card, content, sender_id FROM messages WHERE id = $1`, [qa?.messageId]);
    assert(card?.kind === 'quote' && card.card?.quoteId === qa.id && card.card.event === 'sent' && card.sender_id === owner.uid, 'quote card in the chat from the owner', card);
    assert(card?.content === 'Sent a quote for 2 Bedroom Move, $650.00 total.', 'card text reads on its own', card?.content);
    const [reqRow] = await q(`SELECT status FROM estimate_requests WHERE id = $1`, [reqId]);
    assert(reqRow.status === 'quoted', 'the request moves to Quoted', reqRow);
    if (EXPO_FILE) {
      await new Promise((r) => setTimeout(r, 1500));
      const pushed = fs.readFileSync(EXPO_FILE, 'utf8').slice(mark);
      assert(pushed.includes(`ExponentPushToken[${P}c]`) && pushed.includes('Sent a quote for 2 Bedroom Move'), 'the customer gets a push', pushed.slice(0, 300));
    }

    const s2 = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ title: 'Weekend option', totalCents: 70000, paymentMode: 'full', depositCents: null, requestId: null }) });
    assert(s2.status === 201 && s2.body.quote.amounts.balanceCents === 0 && s2.body.quote.paymentMode === 'full', 'a second open quote (full payment) is allowed', s2);

    console.log('\n── who can send, and to whom ──');
    const notMine = await call('POST', '/api/quotes', { token: owner2.token, body: quoteBody() });
    assert(notMine.status === 403 || notMine.status === 404, "a business can't send into someone else's chat", notMine);
    const custSends = await call('POST', '/api/quotes', { token: cust.token, body: quoteBody() });
    assert(custSends.status === 403, 'a customer with no business cannot send quotes', custSends);
    const otherSvc = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ serviceId: svcOther, requestId: null }) });
    assert(otherSvc.status === 400 && otherSvc.body?.field === 'serviceId', "another business's service is refused", otherSvc);
    const otherReq = await call('POST', '/api/quotes', { token: owner2.token, body: quoteBody({ conversationId: convOther, serviceId: null }) });
    assert(otherReq.status === 400 && otherReq.body?.field === 'requestId', "another business's request is refused", otherReq);
    const badInput = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ depositCents: 65000 }) });
    assert(badInput.status === 400 && badInput.body?.field === 'depositCents' && typeof badInput.body.message === 'string', 'input errors name the field', badInput);
    const past = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ jobDate: daysFromNow(-1) }) });
    assert(past.status === 400 && past.body?.field === 'startTime', 'a job in the past is refused', past);
    const noConv = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ conversationId: id('nope') }) });
    assert(noConv.status === 404, 'an unknown chat is 404', noConv);
    await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [cust2.uid, owner.uid]);
    const convBlocked = await mkConv(owner.uid, cust2.uid);
    const blocked = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ conversationId: convBlocked, requestId: null }) });
    assert(blocked.status === 403, 'no quote to someone who blocked you', blocked);

    console.log('\n── staff quotes ──');
    const st = await call('POST', '/api/quotes', { token: staffUser.token, body: quoteBody({ conversationId: convStaff, requestId: null, serviceId: null }) });
    assert(st.status === 201 && st.body.quote.staffMemberId === staffId && st.body.quote.businessId === biz && st.body.quote.senderId === staffUser.uid, 'a staff member with a login sends from their own chat; the quote records them', st);
    await q(`UPDATE staff_members SET status = 'inactive' WHERE id = $1`, [staffId]);
    const stOff = await call('POST', '/api/quotes', { token: staffUser.token, body: quoteBody({ conversationId: convStaff, requestId: null, serviceId: null }) });
    assert(stOff.status === 403, 'an inactive staff member cannot send quotes', stOff);
    await q(`UPDATE staff_members SET status = 'active' WHERE id = $1`, [staffId]);
    const ownerSeesStaff = await call('GET', `/api/quotes/${st.body?.quote?.id}`, { token: owner.token });
    assert(ownerSeesStaff.status === 200, "the owner can open a staff member's quote", ownerSeesStaff);
    const stEditOwner = await call('POST', `/api/quotes/${qa.id}/withdraw`, { token: staffUser.token });
    assert(stEditOwner.status === 404, "a staff member cannot change the owner's quote", stEditOwner);
    const stQ = st.body?.quote;
    const stEdit = await call('PATCH', `/api/quotes/${stQ?.id}`, { token: staffUser.token, body: { ...quoteBody({ conversationId: convStaff, requestId: null, serviceId: null, totalCents: 66000 }), version: 1 } });
    assert(stEdit.status === 200 && stEdit.body.quote.version === 2, 'the staff member who sent it can edit it', stEdit);
    const otherStaff = await mkUser('staff2', 'Kim');
    await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, role, status) VALUES ($1, $2, $3, 'Kim', 'staff', 'active')`, [id('staff2'), biz, otherStaff.uid]);
    const osEdit = await call('PATCH', `/api/quotes/${stQ?.id}`, { token: otherStaff.token, body: { ...quoteBody({ conversationId: convStaff, requestId: null, serviceId: null }), version: 2 } });
    const osRead = await call('GET', `/api/quotes/${stQ?.id}`, { token: otherStaff.token });
    assert(osEdit.status === 404 && osRead.status === 404, 'another staff member of the same business cannot edit or read it', { osEdit, osRead });
    await q(`UPDATE staff_members SET status = 'archived' WHERE id = $1`, [staffId]);
    const exEdit = await call('PATCH', `/api/quotes/${stQ?.id}`, { token: staffUser.token, body: { ...quoteBody({ conversationId: convStaff, requestId: null, serviceId: null }), version: 2 } });
    const exWithdraw = await call('POST', `/api/quotes/${stQ?.id}/withdraw`, { token: staffUser.token });
    const exRead = await call('GET', `/api/quotes/${stQ?.id}`, { token: staffUser.token });
    assert(exEdit.status === 404 && exWithdraw.status === 404 && exRead.status === 404, 'a removed staff member loses access to the quotes they sent', { exEdit, exWithdraw, exRead });
    const ownerStill = await call('GET', `/api/quotes/${stQ?.id}`, { token: owner.token });
    assert(ownerStill.status === 200, 'the owner still has it', ownerStill);
    await q(`UPDATE staff_members SET status = 'active' WHERE id = $1`, [staffId]);

    console.log('\n── blocks after sending ──');
    const bq = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ requestId: null, title: 'Block test' }) });
    await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [cust.uid, owner.uid]);
    const bEdit = await call('PATCH', `/api/quotes/${bq.body?.quote?.id}`, { token: owner.token, body: { ...quoteBody({ requestId: null, title: 'Block test' }), version: 1 } });
    assert(bEdit.status === 403, 'no edits to someone who blocked you', bEdit);
    const [cardsBefore] = await q(`SELECT count(*)::int n FROM messages WHERE conversation_id = $1`, [conv]);
    const bWithdraw = await call('POST', `/api/quotes/${bq.body?.quote?.id}/withdraw`, { token: owner.token });
    const [cardsAfter] = await q(`SELECT count(*)::int n FROM messages WHERE conversation_id = $1`, [conv]);
    assert(bWithdraw.status === 200 && bWithdraw.body.quote.status === 'withdrawn' && cardsAfter.n === cardsBefore.n, 'withdraw still works but posts nothing to someone who blocked you', { bWithdraw, cardsBefore, cardsAfter });
    await q(`DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [cust.uid, owner.uid]);

    console.log('\n── reading quotes ──');
    const asCust = await call('GET', `/api/quotes/${qa.id}`, { token: cust.token });
    assert(asCust.status === 200 && asCust.body.quote.status === 'sent' && asCust.body.quote.businessName === 'Movers a', 'customer opens the quote', asCust);
    const asStranger = await call('GET', `/api/quotes/${qa.id}`, { token: stranger.token });
    const asOtherBiz = await call('GET', `/api/quotes/${qa.id}`, { token: owner2.token });
    assert(asStranger.status === 404 && asOtherBiz.status === 404, 'nobody else can open it', { asStranger, asOtherBiz });
    const inChat = await call('GET', `/api/conversations/${conv}/quotes`, { token: cust.token });
    assert(inChat.status === 200 && inChat.body.quotes.length === 3, 'quotes in a chat, for its participants', inChat);
    const inChatStranger = await call('GET', `/api/conversations/${conv}/quotes`, { token: stranger.token });
    assert(inChatStranger.status === 404, 'not for anyone outside the chat', inChatStranger);
    const mine = await call('GET', '/api/me/quotes', { token: cust.token });
    assert(mine.status === 200 && mine.body.quotes.length === 3, "customer's quotes", mine);
    const vendor = await call('GET', '/api/vendor/quotes', { token: owner.token });
    assert(vendor.status === 200 && vendor.body.quotes.length === 4, "business's quotes, staff ones included", vendor);
    const vendorOther = await call('GET', '/api/vendor/quotes', { token: owner2.token });
    assert(vendorOther.status === 200 && vendorOther.body.quotes.length === 0, "another business sees none of them", vendorOther);
    const msgs = await call('GET', `/api/conversations/${conv}/messages`, { token: cust.token });
    const cards = (msgs.body?.messages ?? []).filter((m: any) => m.kind === 'quote');
    assert(msgs.status === 200 && cards.length === 3 && cards.every((m: any) => m.card?.quoteId), 'the customer sees every card in the chat (none for the blocked withdraw)', msgs.body);

    console.log('\n── editing ──');
    const noVersion = await call('PATCH', `/api/quotes/${qa.id}`, { token: owner.token, body: quoteBody({ totalCents: 70050, requestId: undefined }) });
    assert(noVersion.status === 400 && noVersion.body?.field === 'version', 'an edit must say which version it changes', noVersion);
    const e1 = await call('PATCH', `/api/quotes/${qa.id}`, { token: owner.token, body: { ...quoteBody({ totalCents: 70050, requestId: undefined }), version: 1 } });
    assert(e1.status === 200 && e1.body.quote.version === 2 && e1.body.quote.totalCents === 70050 && e1.body.quote.messageId !== qa.messageId, 'edit makes version 2 with a new card', e1);
    const [card2] = await q(`SELECT content, card FROM messages WHERE id = $1`, [e1.body?.quote?.messageId]);
    assert(card2?.content === 'Updated the quote for 2 Bedroom Move, $700.50 total.' && card2.card?.event === 'updated' && card2.card.version === 2, 'Updated quote card', card2);
    const reread = await call('GET', `/api/quotes/${qa.id}`, { token: cust.token });
    assert(reread.body?.quote?.totalCents === 70050, 'the quote (and so every card) shows the current version', reread.body?.quote);
    const eStale = await call('PATCH', `/api/quotes/${qa.id}`, { token: owner.token, body: { ...quoteBody({ totalCents: 1000, paymentMode: 'full', depositCents: null }), version: 1 } });
    assert(eStale.status === 409 && eStale.body?.code === 'QUOTE_CHANGED', 'an edit based on an old version is refused', eStale);
    const eCust = await call('PATCH', `/api/quotes/${qa.id}`, { token: cust.token, body: { ...quoteBody(), version: 2 } });
    assert(eCust.status === 404, 'the customer cannot edit', eCust);
    const eBad = await call('PATCH', `/api/quotes/${qa.id}`, { token: owner.token, body: { ...quoteBody({ title: '' }), version: 2 } });
    assert(eBad.status === 400 && eBad.body?.field === 'title', 'edit input checked like send', eBad);

    console.log('\n── decline and withdraw ──');
    const dCust2 = await call('POST', `/api/quotes/${qa.id}/decline`, { token: cust2.token, body: {} });
    assert(dCust2.status === 404, "only the quote's customer can decline", dCust2);
    const dec = await call('POST', `/api/quotes/${qa.id}/decline`, { token: cust.token, body: { reason: 'Found another mover' } });
    assert(dec.status === 200 && dec.body.quote.status === 'declined' && dec.body.quote.declineReason === 'Found another mover', 'customer declines with a reason', dec);
    const [decCard] = await q(`SELECT content, sender_id, card FROM messages WHERE conversation_id = $1 AND kind = 'quote' ORDER BY created_at DESC LIMIT 1`, [conv]);
    assert(decCard?.content === 'Declined the quote for 2 Bedroom Move.' && decCard.sender_id === cust.uid && decCard.card?.event === 'declined', 'decline card from the customer', decCard);
    const eAfter = await call('PATCH', `/api/quotes/${qa.id}`, { token: owner.token, body: { ...quoteBody(), version: 2 } });
    assert(eAfter.status === 409 && eAfter.body?.code === 'QUOTE_CLOSED', 'a declined quote cannot be edited', eAfter);
    const wAfter = await call('POST', `/api/quotes/${qa.id}/withdraw`, { token: owner.token });
    assert(wAfter.status === 409, 'a declined quote cannot be withdrawn', wAfter);
    const w = await call('POST', `/api/quotes/${s2.body?.quote?.id}/withdraw`, { token: owner.token });
    assert(w.status === 200 && w.body.quote.status === 'withdrawn', 'owner withdraws the second quote', w);
    const dAfterW = await call('POST', `/api/quotes/${s2.body?.quote?.id}/decline`, { token: cust.token, body: {} });
    assert(dAfterW.status === 409, 'a withdrawn quote cannot be declined', dAfterW);
    const longReason = await call('POST', `/api/quotes/${st.body?.quote?.id}/decline`, { token: cust2.token, body: { reason: 'x'.repeat(501) } });
    assert(longReason.status === 400, 'decline reason up to 500 characters', longReason);

    console.log('\n── expiry ──');
    const soonDate = new Date(Date.now() + 26 * 3600000);
    const nySoon = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(soonDate);
    const nyTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(soonDate);
    const sSoon = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ requestId: null, jobDate: nySoon, startTime: nyTime }) });
    // Step 3 (call 12): the day before the job, so a job 26 hours away expires 24 hours before it starts.
    assert(sSoon.status === 201 && Math.abs(new Date(sSoon.body.quote.startsAt).getTime() - new Date(sSoon.body.quote.expiresAt).getTime() - 24 * 3600000) < 1000, 'a job sooner than 7 days expires 24 hours before it starts', sSoon.body?.quote);
    await q(`UPDATE quotes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [sSoon.body?.quote?.id]);
    const lazy = await call('GET', `/api/quotes/${sSoon.body?.quote?.id}`, { token: cust.token });
    assert(lazy.body?.quote?.status === 'expired', 'a quote past its expiry reads expired right away', lazy.body?.quote);
    const dExpired = await call('POST', `/api/quotes/${sSoon.body?.quote?.id}/decline`, { token: cust.token, body: {} });
    const eExpired = await call('PATCH', `/api/quotes/${sSoon.body?.quote?.id}`, { token: owner.token, body: { ...quoteBody({ requestId: null }), version: 1 } });
    assert(dExpired.status === 409 && eExpired.status === 409, 'an expired quote cannot be declined or edited', { dExpired, eExpired });
    const run = await call('POST', '/api/quotes/_run-expiry-for-tests', { token: owner.token });
    // Unknown routes: 404 in production; in development the web app answers with its HTML page (no JSON).
    assert(run.status === 404 || run.body === null, 'there is no public route to run the expiry job', run);
    const { expireDueQuotes } = await import('./quoteExpiry');
    const expired = await expireDueQuotes();
    const [exRow] = await q(`SELECT status, expired_at FROM quotes WHERE id = $1`, [sSoon.body?.quote?.id]);
    const [exCard] = await q(`SELECT content, card FROM messages WHERE conversation_id = $1 AND kind = 'quote' ORDER BY created_at DESC LIMIT 1`, [conv]);
    assert(expired >= 1 && exRow.status === 'expired' && exRow.expired_at && exCard?.content === 'The quote for 2 Bedroom Move expired.' && exCard.card?.event === 'expired', 'the expiry job marks it expired and says so in the chat', { expired, exRow, exCard });
    const again = await expireDueQuotes();
    const [n] = await q(`SELECT count(*)::int n FROM messages WHERE conversation_id = $1 AND content = 'The quote for 2 Bedroom Move expired.'`, [conv]);
    assert(n.n === 1, 'running the job again posts nothing new', { again, n });

    console.log('\n── the calendar is not blocked ──');
    const [appts] = await q(`SELECT count(*)::int n FROM appointments WHERE business_id = $1`, [biz]);
    const [holds] = await q(`SELECT count(*)::int n FROM booking_holds WHERE provider_id = $1`, [biz]).catch(() => [{ n: 0 }]);
    assert(appts.n === 0 && holds.n === 0, 'quotes create no booking and no hold', { appts, holds });
    console.log('\n── service or product (step 3) ──');
    {
      const prod = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ requestId: null, kind: 'product', jobDate: undefined, startTime: undefined, durationMinutes: undefined, dueDate: daysFromNow(30), title: 'Custom wedding cake' }) });
      assert(prod.status === 201 && prod.body?.quote?.kind === 'product' && prod.body.quote.dueDate === daysFromNow(30) && prod.body.quote.jobDate === null && prod.body.quote.startsAt === null, 'a product quote with a due date and no job time', prod.body);
      const noDue = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ requestId: null, kind: 'product', jobDate: undefined, startTime: undefined, durationMinutes: undefined, title: 'Custom dress' }) });
      assert(noDue.status === 201 && noDue.body?.quote?.dueDate === null, 'a product quote without a due date', noDue.body);
      const svcNoTime = await call('POST', '/api/quotes', { token: owner.token, body: quoteBody({ requestId: null, kind: 'service', startTime: undefined }) });
      assert(svcNoTime.status === 400 && svcNoTime.body?.field === 'startTime', 'a service quote still needs its start time', svcNoTime.body);
      const card = (await q(`SELECT card FROM messages WHERE id = $1`, [prod.body?.quote?.messageId]))[0]?.card;
      assert(card?.kind === 'product' && card?.dueDate === daysFromNow(30), 'the card says product and its due date', card);
      for (const r of [prod, noDue]) if (r.body?.quote?.id) await call('POST', `/api/quotes/${r.body.quote.id}/withdraw`, { token: owner.token });
    }

  } finally {
    await q(`DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM quotes WHERE business_id = ANY($1)`, [bizs]);
    const convs = (await q(`SELECT id FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [users])).map((r) => r.id);
    await q(`DELETE FROM estimate_requests WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM messages WHERE conversation_id = ANY($1)`, [convs]);
    await q(`DELETE FROM conversations WHERE id = ANY($1)`, [convs]);
    await q(`DELETE FROM staff_members WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
