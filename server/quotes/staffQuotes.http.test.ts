/**
 * Quotes step 6d-2a: HTTP integration tests.
 *   GET /api/staff/quotes?businessId=  only the quotes this staff member sent, only while they are active staff.
 *   bookingStatus on the quote detail (GET /api/quotes/:id, GET /api/me/quotes): the paid quote's booking status,
 *   null before it is paid. Additive. Step 6d-2c: on GET /api/vendor/quotes too.
 * Legend 2026-11-05 (6d-2 calls 5 and 6, as recommended).
 *
 * Run with: npx tsx server/quotes/staffQuotes.http.test.ts
 *
 * SCRATCH ONLY. Backend booted on localhost against a LOCAL scratch Postgres (migrations up to 103 applied):
 *   SQ_TEST_BASE_URL   e.g. http://localhost:5062 (must be localhost)
 *   SQ_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when SQ_TEST_BASE_URL is unset; refuses any non-local host.
 */
import http from "http";

const BASE = process.env.SQ_TEST_BASE_URL;
const PG_URL = process.env.SQ_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const daysFromNow = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  if (!BASE) { console.log("⏭  skipped: set SQ_TEST_BASE_URL (+ SQ_TEST_PG_URL) to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "qt-test-jwt-secret";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `sq${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const mkUser = async (key: string) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name) VALUES ($1::varchar, $1::text, $2, 'A', 'T', 'A')`, [uid, `${uid}@sq.test`]);
    return { uid, token: generateAccessToken({ userId: uid, isVendor: false, isAdmin: false }) };
  };
  const owner = await mkUser("owner"), owner2 = await mkUser("owner2");
  const staff = await mkUser("staff"), multi = await mkUser("multi"), gone = await mkUser("gone");
  const cust = await mkUser("cust"), cust2 = await mkUser("cust2"), nobody = await mkUser("nobody");
  const biz = id("biz"), biz2 = id("biz2");
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'Movers A', 'home', 'approved'), ($3, $4, 'Movers B', 'home', 'approved')`, [biz, owner.uid, biz2, owner2.uid]);
  const stA = id("stA"), multiA = id("mA"), multiB = id("mB"), goneA = id("gA");
  await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, status) VALUES
    ($1, $5, $6, 'Sam', 'active'), ($2, $5, $7, 'Mo', 'active'), ($3, $8, $7, 'Mo', 'active'), ($4, $5, $9, 'Gus', 'active')`,
    [stA, multiA, multiB, goneA, biz, staff.uid, multi.uid, biz2, gone.uid]);
  const mkConv = async (a: string, b: string) => { const c = id(`c${a.slice(-4)}${b.slice(-4)}`); await q(`INSERT INTO conversations (id, participant1_id, participant2_id) VALUES ($1, $2, $3)`, [c, a, b]); return c; };
  const convStaff = await mkConv(staff.uid, cust.uid), convOwner = await mkConv(owner.uid, cust.uid);
  const convMultiA = await mkConv(multi.uid, cust.uid), convMultiB = await mkConv(multi.uid, cust2.uid);
  const convGone = await mkConv(gone.uid, cust2.uid);
  const body = (conversationId: string, o: Record<string, unknown> = {}) => ({
    conversationId, title: "Local move", jobDate: daysFromNow(10), startTime: "09:00", durationMinutes: 180,
    totalCents: 65000, paymentMode: "deposit", depositCents: 10000, ...o,
  });

  try {
    console.log("\n── sending ──");
    const s1 = await call("POST", "/api/quotes", { token: staff.token, body: body(convStaff, { title: "Staff one" }) });
    const s2 = await call("POST", "/api/quotes", { token: staff.token, body: body(convStaff, { title: "Staff two" }) });
    const o1 = await call("POST", "/api/quotes", { token: owner.token, body: body(convOwner, { title: "Owner one" }) });
    const mA = await call("POST", "/api/quotes", { token: multi.token, body: body(convMultiA, { title: "Multi A", businessId: biz }) });
    const mB = await call("POST", "/api/quotes", { token: multi.token, body: body(convMultiB, { title: "Multi B", businessId: biz2 }) });
    const g1 = await call("POST", "/api/quotes", { token: gone.token, body: body(convGone, { title: "Gone one" }) });
    assert([s1, s2, o1, mA, mB, g1].every((r) => r.status === 201), "six quotes sent", [s1, s2, o1, mA, mB, g1].map((r) => r.status));

    console.log("\n── GET /api/staff/quotes ──");
    const l1 = await call("GET", "/api/staff/quotes", { token: staff.token });
    const titles = (r: any) => (r.body?.quotes ?? []).map((x: any) => x.title);
    assert(l1.status === 200 && JSON.stringify(titles(l1)) === JSON.stringify(["Staff two", "Staff one"]), "staff sees only their own quotes, newest first (not the owner's)", l1.body);
    assert(l1.body.quotes.every((x: any) => x.staffMemberId === stA && x.businessId === biz && x.senderId === staff.uid && x.status === "sent"), "each row is the plain quote JSON for this staff member", l1.body.quotes?.[0]);
    assert("bookingStatus" in l1.body.quotes[0] && l1.body.quotes[0].bookingStatus === null, "bookingStatus null before payment on the list", l1.body.quotes[0]);
    const l2 = await call("GET", `/api/staff/quotes?businessId=${encodeURIComponent(biz)}`, { token: staff.token });
    assert(l2.status === 200 && l2.body.quotes.length === 2, "with businessId too", l2.body);

    const mm = await call("GET", "/api/staff/quotes", { token: multi.token });
    assert(mm.status === 409 && Array.isArray(mm.body?.businesses) && mm.body.businesses.length === 2, "staff at two businesses without businessId: 409 with the list", mm.body);
    const ma = await call("GET", `/api/staff/quotes?businessId=${encodeURIComponent(biz)}`, { token: multi.token });
    const mb = await call("GET", `/api/staff/quotes?businessId=${encodeURIComponent(biz2)}`, { token: multi.token });
    assert(ma.status === 200 && JSON.stringify(titles(ma)) === '["Multi A"]' && JSON.stringify(titles(mb)) === '["Multi B"]', "each business shows only its own quotes", [ma.body, mb.body]);

    const ow = await call("GET", "/api/staff/quotes", { token: owner.token });
    assert(ow.status === 404, "an owner who isn't staff gets 404", ow);
    const nb = await call("GET", "/api/staff/quotes", { token: nobody.token });
    assert(nb.status === 404, "not staff: 404", nb);
    const wrong = await call("GET", `/api/staff/quotes?businessId=${encodeURIComponent(biz2)}`, { token: staff.token });
    assert(wrong.status === 404, "another business's id: 404, nothing leaks", wrong);
    const un = await call("GET", "/api/staff/quotes");
    assert(un.status === 401, "signed out: 401", un);

    await q(`UPDATE staff_members SET status = 'removed' WHERE id = $1`, [goneA]);
    const gl = await call("GET", "/api/staff/quotes", { token: gone.token });
    assert(gl.status === 403 && (gl.body?.quotes === undefined), "removed staff: 403 and no quotes (they lost access to them)", gl.body);
    const glb = await call("GET", `/api/staff/quotes?businessId=${encodeURIComponent(biz)}`, { token: gone.token });
    assert(glb.status === 403 && glb.body?.quotes === undefined, "removed staff naming the business: 403 too", glb.body);
    // A row carrying this staff member but sent by someone else (the owner) never shows on their list.
    await q(`UPDATE quotes SET sender_id = $1 WHERE id = $2`, [owner.uid, s2.body.quote.id]);
    const l4 = await call("GET", "/api/staff/quotes", { token: staff.token });
    assert(l4.status === 200 && JSON.stringify(titles(l4)) === '["Staff one"]', "only quotes this person sent", l4.body);
    await q(`UPDATE quotes SET sender_id = $1 WHERE id = $2`, [staff.uid, s2.body.quote.id]);

    console.log("\n── bookingStatus on the quote detail ──");
    const qid = s1.body.quote.id;
    const d0 = await call("GET", `/api/quotes/${qid}`, { token: staff.token });
    assert(d0.status === 200 && d0.body.quote.bookingStatus === null, "not paid: bookingStatus null", d0.body.quote?.bookingStatus);
    // A paid quote whose booking is then canceled (set directly; the paying flow has its own suites).
    const appt = id("appt");
    await q(`INSERT INTO appointments (id, business_id, client_id, appointment_date, appointment_time, total_price, status, quote_id)
             VALUES ($1, $2, $3, $4, '09:00', 65000, 'confirmed', $5)`, [appt, biz, cust.uid, daysFromNow(10), qid]);
    await q(`UPDATE quotes SET status = 'paid', appointment_id = $1, paid_at = now() WHERE id = $2`, [appt, qid]);
    const d1 = await call("GET", `/api/quotes/${qid}`, { token: staff.token });
    assert(d1.body?.quote?.bookingStatus === "confirmed", "paid: bookingStatus confirmed (business view)", d1.body?.quote?.bookingStatus);
    await q(`UPDATE appointments SET status = 'canceled' WHERE id = $1`, [appt]);
    const d2 = await call("GET", `/api/quotes/${qid}`, { token: cust.token });
    assert(d2.body?.quote?.bookingStatus === "canceled", "canceled: bookingStatus canceled (customer view)", d2.body?.quote?.bookingStatus);
    const me = await call("GET", "/api/me/quotes", { token: cust.token });
    const row = (me.body?.quotes ?? []).find((x: any) => x.id === qid);
    assert(me.status === 200 && row?.bookingStatus === "canceled", "GET /api/me/quotes carries it too", row);
    const unpaidRow = (me.body?.quotes ?? []).find((x: any) => x.id === s2.body.quote.id);
    assert(unpaidRow && unpaidRow.bookingStatus === null, "an unpaid quote in /api/me/quotes: null", unpaidRow);
    const l3 = await call("GET", "/api/staff/quotes", { token: staff.token });
    assert(l3.body.quotes.find((x: any) => x.id === qid)?.bookingStatus === "canceled" && l3.body.quotes.find((x: any) => x.id === qid)?.status === "paid", "staff list shows paid with the canceled booking", l3.body.quotes);
    // Step 6d-2c: the owner list carries it too (the app's owner Open tab and chips).
    const vl = await call("GET", "/api/vendor/quotes", { token: owner.token });
    const vrow = (vl.body?.quotes ?? []).find((x: any) => x.id === qid);
    assert(vl.status === 200 && vrow?.bookingStatus === "canceled" && vrow.status === "paid", "owner list: paid with the canceled booking", vrow);
    const vunpaid = (vl.body?.quotes ?? []).find((x: any) => x.id === o1.body.quote.id);
    assert(vunpaid && "bookingStatus" in vunpaid && vunpaid.bookingStatus === null, "owner list: null before payment", vunpaid);
    assert((vl.body?.quotes ?? []).every((x: any) => x.businessId === biz), "owner list: only this business", vl.body?.quotes?.length);
    const keys = Object.keys(d2.body.quote);
    for (const k of ["id", "status", "version", "amounts", "balance", "window", "report", "extras", "extrasPayment", "business"]) {
      assert(keys.includes(k), `detail still has ${k}`);
    }
  } finally {
    await q(`DELETE FROM messages WHERE conversation_id LIKE $1`, [`${P}%`]);
    await q(`UPDATE quotes SET appointment_id = NULL WHERE business_id IN ($1, $2)`, [biz, biz2]);
    await q(`DELETE FROM appointments WHERE business_id IN ($1, $2)`, [biz, biz2]);
    await q(`DELETE FROM quotes WHERE business_id IN ($1, $2)`, [biz, biz2]);
    await q(`DELETE FROM conversations WHERE id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM staff_members WHERE business_id IN ($1, $2)`, [biz, biz2]);
    await q(`DELETE FROM businesses WHERE id IN ($1, $2)`, [biz, biz2]);
    await q(`DELETE FROM notifications WHERE user_id LIKE $1`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
