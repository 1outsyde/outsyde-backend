/**
 * Quotes step 5a (goutsyde.com support): opening a quote from its link, the business look on the quote, and note
 * emails. Legend 2026-11-05 (step 5 calls 1 to 4 and 6, all as recommended).
 * Run with: npx tsx server/quotes/quoteNotes.http.test.ts (QT_TEST_BASE_URL, QT_TEST_PG_URL, same scratch setup as
 * quotes.http.test.ts). Skips when QT_TEST_BASE_URL is unset; refuses any non-local host.
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

  const P = `qn${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, first = 'Ana') => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3)`, [uid, `${uid}@qn.test`, first]);
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
  const cust = await mkUser('cust', 'Ana');
  const other = await mkUser('other', 'Zed');
  const biz = await mkBiz('a', owner.uid, null);
  await q(`UPDATE businesses SET logo_image = 'https://r2.test/logo.png', cover_image = 'https://r2.test/cover.jpg', brand_colors = '{"primary":"#123456"}'::jsonb WHERE id = $1`, [biz]);
  const conv = await mkConv(owner.uid, cust.uid);
  let [adminRow] = await q(`SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com'`);
  if (!adminRow) { [adminRow] = await q(`INSERT INTO users (id, username, email, first_name, last_name, name, is_admin) VALUES ($1::varchar, $1::text, 'info@goutsyde.com', 'Ada', 'Admin', 'Ada', true) RETURNING id`, [id('admin')]); users.push(adminRow.id); }
  const admin = { token: generateAccessToken({ userId: adminRow.id, isVendor: false, isAdmin: true }) };
  const qn = await import('./quoteNotes');
  const sent: { to: string; subject: string; text: string; html: string }[] = [];
  let failNext = 0, tries = 0;
  qn.setQuoteNoteMailerForTest(async (m) => { tries++; if (failNext > 0) { failNext--; return false; } sent.push(m); return true; });

  // Review I1: an unread note from long before the quote is never part of a quote email.
  await call('POST', `/api/conversations/${conv}/messages`, { token: cust.token, body: { content: 'Old note from last month' } });
  await q(`UPDATE messages SET created_at = created_at - interval '5 days' WHERE conversation_id = $1`, [conv]);
  try {
    const made = await call('POST', '/api/quotes', { token: owner.token, body: { conversationId: conv, title: '2 Bedroom Move', details: 'Crew of 3, gate code needed', jobDate: daysFromNow(10), startTime: '09:00', durationMinutes: 180, totalCents: 65000, paymentMode: 'deposit', depositCents: 10000 } });
    const quote = made.body?.quote;
    assert(made.status === 201 && !!quote?.linkCode, 'a quote with its link code', made.body);
    const code = quote.linkCode;
    await q(`UPDATE quotes SET sent_at = sent_at - interval '60 minutes' WHERE id = $1`, [quote.id]); // notes in the tests are backdated a few minutes

    console.log('\n── opening a quote from its link (calls 1, 2) ──');
    let r = await call('GET', `/api/quotes/link/${code}`);
    const pv = r.body?.preview;
    assert(r.status === 200 && r.body?.access === 'preview' && !r.body.quoteId, 'signed out: a preview only, no quote id', r.body);
    assert(pv?.title === '2 Bedroom Move' && pv.amounts?.payNowCents === 10800 && pv.business?.name === 'Movers a' && pv.business?.logoImage === 'https://r2.test/logo.png' && pv.business?.brandColors?.primary === '#123456', 'title, price and the business look', pv);
    const raw = JSON.stringify(r.body);
    assert(!raw.includes(cust.uid) && !raw.includes(conv) && !raw.includes(code) && !raw.includes('gate code'), 'nothing about the customer, the chat, the link or the written details', raw);
    r = await call('GET', `/api/quotes/link/${code}`, { token: cust.token });
    assert(r.status === 200 && r.body?.access === 'customer' && r.body.quoteId === quote.id, 'the customer gets the quote', r.body);
    r = await call('GET', `/api/quotes/link/${code}`, { token: owner.token });
    assert(r.status === 200 && r.body?.access === 'vendor' && r.body.quoteId === quote.id, 'the business gets it as the vendor', r.body);
    r = await call('GET', `/api/quotes/link/${code}`, { token: admin.token });
    assert(r.status === 200 && r.body?.access === 'admin', 'Outsyde admin can open it', r.body);
    r = await call('GET', `/api/quotes/link/${code}`, { token: other.token });
    assert(r.status === 403 && r.body?.code === 'OTHER_ACCOUNT' && r.body.message === 'This quote was sent to another Outsyde account. Sign in with the email it was sent to.' && !JSON.stringify(r.body).includes('Move'), 'another account: no details', r.body);
    r = await call('GET', `/api/quotes/link/nope-not-a-code`);
    assert(r.status === 404, 'an unknown code', r.status);
    r = await call('GET', `/api/quotes/link/${encodeURIComponent("x' OR 1=1 --")}`);
    assert(r.status === 404, 'anything that is not a code', r.status);

    console.log('\n── the business look on the quote (call 4) ──');
    r = await call('GET', `/api/quotes/${quote.id}`, { token: cust.token });
    assert(r.body?.quote?.business?.name === 'Movers a' && r.body.quote.business.coverImage === 'https://r2.test/cover.jpg' && r.body.quote.business.brandColors?.primary === '#123456', 'the quote carries the business look', r.body?.quote?.business);

    console.log('\n── note emails (call 3) ──');
    const send = (token: string, content: string) => call('POST', `/api/conversations/${conv}/messages`, { token, body: { content } });
    const backdate = async (mins: number) => q(`UPDATE messages SET created_at = created_at - make_interval(mins => $2) WHERE conversation_id = $1`, [conv, mins]);
    process.env.QUOTE_EMAILS_ENABLED = 'false';
    await send(owner.token, 'We will call 30 minutes before we arrive.');
    await backdate(3);
    await qn.runQuoteNoteEmails(new Date());
    assert(sent.length === 0, 'off until quote emails are on (step 5 call 6)', sent.length);
    process.env.QUOTE_EMAILS_ENABLED = 'true';
    await send(owner.token, 'And please clear the driveway.');
    await qn.runQuoteNoteEmails(new Date());
    assert(sent.length === 1 && sent[0].to === `${cust.uid}@qn.test`, 'the customer is emailed once', sent.map((m) => m.to));
    assert(sent[0]?.subject === 'New note from Movers a about 2 Bedroom Move' && sent[0].text.includes('We will call 30 minutes before we arrive.') && !sent[0].text.includes('clear the driveway'), 'only notes unread for 2 minutes are in it', sent[0]);
    assert(sent[0]?.text.includes(`/q/${code}`), 'it links to the quote page', sent[0]?.text);
    await backdate(3);
    await qn.runQuoteNoteEmails(new Date());
    assert(sent.length === 1, 'no second email within 10 minutes', sent.length);
    await q(`UPDATE quote_chat_emails SET last_sent_at = last_sent_at - interval '11 minutes' WHERE conversation_id = $1`, [conv]);
    await qn.runQuoteNoteEmails(new Date());
    assert(sent.length === 2 && sent[1].text.includes('clear the driveway') && !sent[1].text.includes('30 minutes before'), 'after 10 minutes the new note, never the old one again', sent[1]?.text);
    await q(`UPDATE quote_chat_emails SET last_sent_at = last_sent_at - interval '11 minutes' WHERE conversation_id = $1`, [conv]);
    await qn.runQuoteNoteEmails(new Date());
    assert(sent.length === 2, 'nothing new: nothing sent', sent.length);

    await send(cust.token, 'Great, the gate code is 4417.');
    await call('GET', `/api/conversations/${conv}/messages`, { token: owner.token }); // the business read it in the app
    await backdate(3);
    await qn.runQuoteNoteEmails(new Date());
    assert(sent.length === 2, 'a note already read is never emailed', sent.length);
    await send(cust.token, 'Also two bikes.');
    await backdate(3);
    await qn.runQuoteNoteEmails(new Date());
    assert(sent.length === 3 && sent[2].to === `${owner.uid}@qn.test` && sent[2].subject === 'New note from Ana about 2 Bedroom Move', 'the business is emailed the customer\'s unread note', sent[2]);
    assert(!sent[2]?.text.includes('Old note from last month'), 'a note from before the quote is never in it (review I1)', sent[2]?.text);

    console.log('\n── a send that fails is tried again after 10 minutes, not every run (review I2) ──');
    await q(`UPDATE quote_chat_emails SET last_sent_at = last_sent_at - interval '11 minutes' WHERE conversation_id = $1`, [conv]);
    await send(cust.token, 'Is 9 AM still good?');
    await backdate(3);
    failNext = 1; tries = 0;
    await qn.runQuoteNoteEmails(new Date());
    let row = (await q(`SELECT * FROM quote_chat_emails WHERE conversation_id = $1 AND recipient_id = $2`, [conv, owner.uid]))[0];
    assert(tries === 1 && sent.length === 3 && row.failed_count === 1, 'the send failed once', { tries, row });
    await qn.runQuoteNoteEmails(new Date());
    assert(tries === 1, 'not tried again on the next run', tries);
    await q(`UPDATE quote_chat_emails SET last_sent_at = last_sent_at - interval '11 minutes' WHERE conversation_id = $1`, [conv]);
    await qn.runQuoteNoteEmails(new Date());
    row = (await q(`SELECT * FROM quote_chat_emails WHERE conversation_id = $1 AND recipient_id = $2`, [conv, owner.uid]))[0];
    assert(tries === 2 && sent.length === 4 && sent[3].text.includes('Is 9 AM still good?') && row.failed_count === 0, 'after 10 minutes the same note goes out', { tries, row, t: sent[3]?.text });
    // A request or quote card is never emailed as a note.
    assert(sent.every((m) => !m.text.includes('Sent a quote')), 'cards are never emailed', sent.map((m) => m.text.slice(0, 40)));

    console.log('\n── chats with no live quote get no emails ──');
    await call('POST', `/api/quotes/${quote.id}/withdraw`, { token: owner.token });
    await send(owner.token, 'Sorry, we have to withdraw.');
    await backdate(3);
    await q(`UPDATE quote_chat_emails SET last_sent_at = last_sent_at - interval '11 minutes' WHERE conversation_id = $1`, [conv]);
    await qn.runQuoteNoteEmails(new Date());
    assert(sent.length === 4, 'a withdrawn quote: the chat is a normal chat again', sent.length);
  } finally {
    qn.setQuoteNoteMailerForTest(null);
    await q(`DELETE FROM quote_chat_emails WHERE recipient_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM quotes WHERE business_id = ANY($1)`, [bizs]);
    const convs = (await q(`SELECT id FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [users])).map((r) => r.id);
    await q(`DELETE FROM messages WHERE conversation_id = ANY($1)`, [convs]);
    await q(`DELETE FROM conversations WHERE id = ANY($1)`, [convs]);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
