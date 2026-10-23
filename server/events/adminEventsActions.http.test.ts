/**
 * Admin events money actions: retry a payout in review, resolve an owed recovery, email the host.
 * Also the two B2 carry overs: the "moved to review" activity text, and impossible dates in from/to.
 *
 * Run with (backend on localhost started with RESEND_BASE_URL=http://127.0.0.1:<EV_TEST_RESEND_PORT>):
 *   EV_TEST_BASE_URL=http://localhost:5071 EV_TEST_PG_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde_test \
 *   EV_TEST_RESEND_PORT=5098 JWT_SECRET=test DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde_test \
 *   NEON_PROXY_PORT=4444 NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/events/adminEventsActions.http.test.ts
 * Optional EV_TEST_BACKEND_LOG=<the backend's log file> also checks that a failed send never logs the address.
 * SCRATCH ONLY. Local Postgres and backend only; skips (exit 0) when EV_TEST_BASE_URL is unset.
 * This test runs the Resend stub itself, so no email leaves the machine (addresses containing "+fail" get a Resend
 * error). The payout job is called in process with a fake Stripe (same shape as eventPayouts.http.test.ts), so
 * nothing reaches real Stripe. Admin alerts go to a recording fake. The admin user info@goutsyde.com is created for
 * the run and removed after (the run refuses to start if it already exists).
 *
 * Note: the backend runs the payout job every minute too. Assertions that follow a job step read the row's final
 * state, so they hold whichever run created the payout.
 *
 * Mutation checks:
 *  - drop `AND p.status = 'review'` from the retry update: "retry a held payout: 409" fails.
 *  - drop the events.status = 'published' guard: "retry on a cancelled event: 409" fails.
 *  - insert the audit row without `FROM upd`: "no audit row on a refused retry" fails.
 *  - drop `AND status = 'owed'` from resolve: "double resolve: one 200, one 409" fails.
 *  - build the email claim id with gen_random_uuid(): "double click: one email" can fail (race dependent).
 *  - keep last_error on retry: "bank payout gate not raised by the retried row" fails.
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
const RESEND_PORT = Number(process.env.EV_TEST_RESEND_PORT || "0");
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 1200)); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json, raw: b }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const ADMIN_EMAIL = "info@goutsyde.com";

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL + EV_TEST_RESEND_PORT to run"); process.exit(0); }
  if (!PG_URL || !RESEND_PORT || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must be localhost, and a Resend stub port is required");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test";

  // Resend stub: POST /emails records the email and answers with an id; "+fail" addresses get a Resend error.
  const sent: any[] = [];
  const other: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      const j = body ? JSON.parse(body) : {};
      if (String(j.to).includes("+fail")) { res.statusCode = 422; return res.end(JSON.stringify({ name: "validation_error", message: "stub rejected this address" })); }
      // Only emails to the test hosts are counted: the backend's own jobs may email the admin through this stub too.
      if (String(j.to).includes("@test.local")) sent.push({ path: req.url, ...j });
      else other.push(j.subject);
      res.end(JSON.stringify({ id: `stub_${sent.length}` }));
    });
  });
  await new Promise<void>((ok) => stub.listen(RESEND_PORT, "127.0.0.1", () => ok()));

  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const existing = await q(`SELECT id FROM users WHERE lower(email) = $1`, [ADMIN_EMAIL]);
  if (existing.length) { await db.end(); stub.close(); throw new Error(`refusing to run: ${ADMIN_EMAIL} already exists in this database`); }

  const P = `aa${Date.now().toString(36)}`;
  let adminId: string | null = null;
  const mkUser = async (s: string, o: { email?: string; admin?: boolean } = {}) => (await q(
    `INSERT INTO users (id, email, name, first_name, username, is_admin) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
    [o.email ?? `${P}-${s}@test.local`, `Shown ${s}`, `Realfirst${s}`, `${P}${s}`.slice(0, 24), o.admin ?? false],
  ))[0].id as string;
  const tok = (id: string, isAdmin: boolean) => generateAccessToken({ userId: id, isVendor: false, isAdmin });

  const eventIds: string[] = [];
  /** Ended `endedDaysAgo` days ago, published unless said otherwise. */
  const mkEvent = async (o: { host: string; type?: string; bizId?: string; photoId?: string; status?: string; endedDaysAgo: number; title: string }) => {
    const [e] = await q(
      `INSERT INTO events (host_user_id, host_type, host_business_id, host_photographer_id, slug, title, status, starts_at, ends_at, timezone, city, state,
         published_at, cancelled_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(days => $8::int) - interval '3 hours', now() - make_interval(days => $8::int),
         'America/New_York', 'Freeport', 'NY', now() - interval '60 days', ${o.status === "cancelled" ? "now() - interval '1 day'" : "NULL"}, now() - interval '61 days')
       RETURNING id`,
      [o.host, o.type ?? "user", o.bizId ?? null, o.photoId ?? null, `${P}-${Math.random().toString(36).slice(2, 8)}`, `${P} ${o.title}`, o.status ?? "published", o.endedDaysAgo],
    );
    eventIds.push(e.id);
    return e.id as string;
  };
  /** One completed order of `count` paid tickets (price 3000, host fee 77, host net 2923), stamped with `payoutId`. */
  const mkTickets = async (eventId: string, buyer: string, count: number, o: { payoutId?: string | null; ticket?: string; order?: string } = {}) => {
    const [tt] = await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, 'General', 3000, 100) RETURNING id`, [eventId]);
    const orderStatus = o.order ?? "completed";
    const total = count * (3000 + 111 + 99);
    const [ord] = await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents,
         host_net_cents, total_cents, refunded_cents, refund_reason, refunded_at, completed_at, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${orderStatus === "refunded" ? "now() - interval '1 day'" : "NULL"}, now() - interval '9 days', now() - interval '9 days') RETURNING id`,
      [eventId, buyer, orderStatus, count, 3000 * count, 111 * count, 99 * count, 77 * count, 2923 * count, total,
        orderStatus === "refunded" ? 3000 * count : 0, orderStatus === "refunded" ? "host" : null]);
    const [item] = await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 3000, 'issued', now() + interval '1 day') RETURNING id`, [ord.id, eventId, tt.id, buyer, count]);
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) {
      const [t] = await q(
        `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents,
           service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents, refunded_at, payout_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 3000, 111, 99, 77, 2923, ${o.ticket === "refunded" ? "now() - interval '1 day'" : "NULL"}, $9) RETURNING id`,
        [ord.id, item.id, eventId, tt.id, buyer, i, `${P}${Math.random().toString(36).slice(2, 12)}`, o.ticket ?? "valid", o.payoutId ?? null]);
      ids.push(t.id);
    }
    return ids;
  };
  const mkPayout = async (eventId: string, o: { status: string; dest?: string; acct?: string | null; gross: number; attempts?: number; lastError?: string | null;
    hold?: string | null; alerted?: boolean }) => (await q(
    `INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, amount_cents, status, hold_reason, attempts,
       last_error, next_attempt_at, alerted_at, paid_at, transfer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, $4, $5, $6, $7, $8, ${o.status === "held" ? "now() + interval '1 hour'" : "NULL"}, ${o.alerted ? "now() - interval '2 hours'" : "NULL"},
       ${o.status === "paid" ? "now() - interval '20 days'" : "NULL"}, $9, now() - interval '2 days', now() - interval '1 day')
     RETURNING id`,
    [eventId, o.dest ?? "user", o.acct ?? null, o.gross, o.status, o.hold ?? null, o.attempts ?? 0, o.lastError ?? null, o.status === "paid" ? `tr_${P}_${Math.random().toString(36).slice(2, 6)}` : null],
  ))[0].id as string;
  const auditFor = (targetId: string) => q(`SELECT action, actor_id, actor_type, target_type, before_state, after_state FROM audit_logs WHERE target_id = $1 ORDER BY created_at`, [targetId]);
  const payoutRow = async (id: string) => (await q(`SELECT * FROM event_payouts WHERE id = $1`, [id]))[0];

  const { setAdminAlertForTest } = await import("./ticketCheckout");
  const adminAlerts: string[] = [];
  setAdminAlertForTest(async (subject: string) => { adminAlerts.push(subject); });
  const { sendPayout, createDuePayouts } = await import("./eventPayouts");
  const { computeHeld } = await import("../bankPayout");
  const created: Array<{ amountCents: number; destination: string; payoutId: string }> = [];
  const stripeFake = {
    getPayoutReadiness: async (_id: string) => ({ ready: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }),
    findEventPayoutTransfer: async (_e: string, _p: string) => null,
    createEventPayoutTransfer: async (p: { payoutId: string; destination: string; amountCents: number }) => {
      created.push({ amountCents: p.amountCents, destination: p.destination, payoutId: p.payoutId });
      return { id: `tr_fake_${created.length}_${P}` };
    },
  } as any;

  try {
    adminId = await mkUser("adm", { email: ADMIN_EMAIL, admin: true });
    const plain = await mkUser("plain");
    const buyer = await mkUser("buy");
    const adminTok = tok(adminId, true);
    const plainTok = tok(plain, false);

    // Hosts: a user host with a ready payout account; a business; a photographer; a user host whose email fails.
    const hostU = await mkUser("hostu");
    const acctU = `acct_1AA${P}`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [hostU, acctU]);
    const hostB = await mkUser("hostb");
    const [biz] = await q(`INSERT INTO businesses (owner_id, name, category, approval_status, contact_email) VALUES ($1, $2, 'Events', 'approved', $3) RETURNING id`,
      [hostB, `${P} Lounge`, `${P}-bizcontact@test.local`]);
    const hostPh = await mkUser("hostph");
    const [ph] = await q(`INSERT INTO photographers (user_id, display_name, hourly_rate) VALUES ($1, $2, 100) RETURNING id`, [hostPh, `${P} Shots`]);
    const hostF = await mkUser("hostf", { email: `${P}-hostf+fail@test.local` });

    // Retry targets.
    const evRetry = await mkEvent({ host: hostU, endedDaysAgo: 6, title: "Retry me" });
    const payRetry = await mkPayout(evRetry, { status: "review", acct: acctU, gross: 2 * 2923, attempts: 5, alerted: true, hold: "stripe_not_ready",
      lastError: "the transfer failed 5 times, last error: insufficient capabilities on acct_1AA" });
    // (The text contains "insufficient": left on a pending row it would hold back the daily bank payout.)
    await mkTickets(evRetry, buyer, 2, { payoutId: payRetry });
    const evHeld = await mkEvent({ host: hostU, endedDaysAgo: 6, title: "Held" });
    const payHeld = await mkPayout(evHeld, { status: "held", gross: 2923, hold: "no_account" });
    await mkTickets(evHeld, buyer, 1, { payoutId: payHeld });
    const evCan = await mkEvent({ host: hostU, status: "cancelled", endedDaysAgo: 6, title: "Cancelled" });
    const payCan = await mkPayout(evCan, { status: "review", acct: acctU, gross: 2923, attempts: 1,
      lastError: "the event was cancelled after its payout was created, so it was not sent" });
    await mkTickets(evCan, buyer, 1, { payoutId: payCan });

    // Recoveries: a paid event for acctU with three owed recoveries and one reversed.
    const evPaid = await mkEvent({ host: hostU, endedDaysAgo: 30, title: "Paid fest" });
    const payPaid = await mkPayout(evPaid, { status: "paid", acct: acctU, gross: 6 * 2923 });
    await mkTickets(evPaid, buyer, 2, { payoutId: payPaid });
    const refunded = await mkTickets(evPaid, buyer, 4, { payoutId: payPaid, ticket: "refunded", order: "refunded" });
    const mkRec = async (ticketId: string, status: string, daysAgo: number, amount = 2923) => (await q(
      `INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6::int), now() - make_interval(days => $6::int)) RETURNING id`,
      [ticketId, payPaid, acctU, amount, status, daysAgo]))[0].id as string;
    const recA = await mkRec(refunded[0], "owed", 20); // resolved: collected
    const recB = await mkRec(refunded[1], "owed", 19); // double resolve
    const recC = await mkRec(refunded[2], "owed", 18, 1000); // stays owed: the next payout deducts it
    const recR = await mkRec(refunded[3], "reversed", 17);

    console.log("\nadmin only, every POST");
    const posts: Array<[string, unknown]> = [
      [`/api/admin/events/payouts/${payRetry}/retry`, undefined],
      [`/api/admin/events/recoveries/${recA}/resolve`, { action: "collected" }],
      [`/api/admin/events/payouts/${payHeld}/email-host`, undefined],
    ];
    for (const [path, body] of posts) {
      let r = await call("POST", path, { body });
      assert(r.status === 401, `${path.split("/").slice(-1)[0]} signed out: 401`, r.status);
      r = await call("POST", path, { body, token: plainTok });
      assert(r.status === 403, `${path.split("/").slice(-1)[0]} not admin: 403`, r.status);
      r = await call("POST", path, { body, token: tok(plain, true) });
      assert(r.status === 403, `${path.split("/").slice(-1)[0]} token claims admin, user isn't: 403`, r.status);
    }
    assert((await payoutRow(payRetry)).status === "review" && (await auditFor(payRetry)).length === 0 && (await auditFor(recA)).length === 0
      && (await auditFor(payHeld)).length === 0 && sent.length === 0, "non admin calls changed nothing, wrote no audit row, sent no email");

    console.log("\nretry guards");
    let r = await call("POST", `/api/admin/events/payouts/${payHeld}/retry`, { token: adminTok });
    assert(r.status === 409 && r.body?.error?.code === "NOT_IN_REVIEW", "retry a held payout: 409 NOT_IN_REVIEW", r);
    assert((await payoutRow(payHeld)).status === "held" && (await auditFor(payHeld)).length === 0, "held payout unchanged, no audit row");
    const canBefore = await payoutRow(payCan);
    r = await call("POST", `/api/admin/events/payouts/${payCan}/retry`, { token: adminTok });
    assert(r.status === 409 && r.body?.error?.code === "EVENT_NOT_PUBLISHED", "retry on a cancelled event: 409 EVENT_NOT_PUBLISHED", r);
    const canAfter = await payoutRow(payCan);
    assert(canAfter.status === "review" && canAfter.attempts === 1 && String(canAfter.updated_at) === String(canBefore.updated_at) && (await auditFor(payCan)).length === 0,
      "no audit row on a refused retry, row untouched", canAfter);
    r = await call("POST", `/api/admin/events/payouts/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/retry`, { token: adminTok });
    assert(r.status === 404 && r.body?.error?.code === "PAYOUT_NOT_FOUND", "retry unknown payout: 404", r);
    r = await call("POST", `/api/admin/events/payouts/${"x".repeat(80)}/retry`, { token: adminTok });
    assert(r.status === 404, "retry oversized id: 404", r.status);

    console.log("\nretry success, then the job picks the row up and pays it");
    const gateBefore = (await computeHeld()).gates.eventPayoutsWaitingBalance;
    r = await call("POST", `/api/admin/events/payouts/${payRetry}/retry`, { token: adminTok });
    // The pending row must not count as "waiting for balance" (bankPayout gate), then straight to the job step,
    // before the backend's own minute tick can take it.
    const gateAfter = (await computeHeld()).gates.eventPayoutsWaitingBalance;
    const sres = await sendPayout(payRetry, stripeFake);
    assert(r.status === 200 && r.body.success === true && r.body.payout.id === payRetry && r.body.payout.status === "pending" && r.body.payout.attempts === 0
      && typeof r.body.payout.nextAttemptAt === "string", "retry: 200 with pending, attempts 0, due now", r.body);
    const aud = await auditFor(payRetry);
    assert(aud.length === 1 && aud[0].action === "event_payout.retry" && aud[0].actor_id === adminId && aud[0].actor_type === "admin" && aud[0].target_type === "event_payout"
      && aud[0].before_state.status === "review" && aud[0].before_state.attempts === 5 && /insufficient capabilities/.test(aud[0].before_state.last_error)
      && aud[0].after_state.status === "pending" && aud[0].after_state.attempts === 0 && aud[0].after_state.last_error === null, "one audit row with before and after state", aud);
    assert(sres === "paid", "sendPayout after retry: paid", sres);
    const paidRow = await payoutRow(payRetry);
    assert(paidRow.status === "paid" && String(paidRow.transfer_id).startsWith("tr_fake_") && paidRow.amount_cents === 2 * 2923 && paidRow.last_error === null
      && paidRow.hold_reason === null, "payout row paid with the fake transfer, amount unchanged", paidRow);
    const mine = created.filter((c) => c.payoutId === payRetry);
    assert(mine.length === 1 && mine[0].amountCents === 2 * 2923 && mine[0].destination === acctU, "exactly one transfer of the stored amount to the host account", mine);
    assert(gateAfter <= gateBefore, "bank payout gate not raised by the retried row (old insufficient text cleared)", { gateBefore, gateAfter });
    r = await call("POST", `/api/admin/events/payouts/${payRetry}/retry`, { token: adminTok });
    assert(r.status === 409 && r.body.error.code === "NOT_IN_REVIEW" && (await auditFor(payRetry)).length === 1, "second retry (now paid): 409, still one audit row", r);

    console.log("\nresolve guards");
    r = await call("POST", `/api/admin/events/recoveries/${recA}/resolve`, { token: adminTok, body: { action: "paid" } });
    assert(r.status === 400 && r.body.error.code === "BAD_ACTION", "unknown action: 400", r);
    r = await call("POST", `/api/admin/events/recoveries/${recA}/resolve`, { token: adminTok });
    assert(r.status === 400 && r.body.error.code === "BAD_ACTION", "no body: 400", r);
    r = await call("POST", `/api/admin/events/recoveries/${recA}/resolve`, { token: adminTok, body: { action: "collected", extra: 1 } });
    assert(r.status === 400, "extra body keys: 400", r.status);
    r = await call("POST", `/api/admin/events/recoveries/${recR}/resolve`, { token: adminTok, body: { action: "written_off" } });
    assert(r.status === 409 && r.body.error.code === "NOT_OWED" && (await auditFor(recR)).length === 0
      && (await q(`SELECT status FROM event_payout_recoveries WHERE id = $1`, [recR]))[0].status === "reversed", "reversed recovery: 409 NOT_OWED, unchanged, no audit row", r);
    r = await call("POST", `/api/admin/events/recoveries/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/resolve`, { token: adminTok, body: { action: "collected" } });
    assert(r.status === 404 && r.body.error.code === "RECOVERY_NOT_FOUND", "unknown recovery: 404", r);
    r = await call("POST", `/api/admin/events/recoveries/${recA}/resolve`, { token: adminTok, body: { action: "collected" } });
    const recARow = (await q(`SELECT status, resolved_at, resolved_by FROM event_payout_recoveries WHERE id = $1`, [recA]))[0];
    assert(r.status === 200 && r.body.recovery.id === recA && r.body.recovery.status === "collected" && typeof r.body.recovery.resolvedAt === "string"
      && recARow.status === "collected" && recARow.resolved_by === adminId && recARow.resolved_at != null, "Mark collected: 200, resolved by the admin", { body: r.body, recARow });
    const audA = await auditFor(recA);
    assert(audA.length === 1 && audA[0].action === "event_payout_recovery.collected" && audA[0].target_type === "event_payout_recovery"
      && audA[0].before_state.status === "owed" && audA[0].after_state.status === "collected", "collected audit row", audA);
    r = await call("POST", `/api/admin/events/recoveries/${recA}/resolve`, { token: adminTok, body: { action: "written_off" } });
    assert(r.status === 409 && r.body.error.code === "NOT_OWED" && (await auditFor(recA)).length === 1, "resolve again: 409, still one audit row", r);

    console.log("\nconcurrent double resolve");
    const [d1, d2] = await Promise.all([
      call("POST", `/api/admin/events/recoveries/${recB}/resolve`, { token: adminTok, body: { action: "collected" } }),
      call("POST", `/api/admin/events/recoveries/${recB}/resolve`, { token: adminTok, body: { action: "written_off" } }),
    ]);
    const codes = [d1.status, d2.status].sort();
    const audB = await auditFor(recB);
    const recBRow = (await q(`SELECT status FROM event_payout_recoveries WHERE id = $1`, [recB]))[0];
    const winner = d1.status === 200 ? d1 : d2;
    assert(codes[0] === 200 && codes[1] === 409, "double resolve: one 200, one 409", codes);
    assert(audB.length === 1 && recBRow.status === winner.body?.recovery?.status && audB[0].after_state.status === recBRow.status, "exactly one audit row, matching the winner", { audB, recBRow });

    console.log("\nresolved recoveries are not deducted from the next payout");
    // A second event for the same account, ended 4 days ago, 3 valid tickets not yet on a payout.
    const evNext = await mkEvent({ host: hostU, endedDaysAgo: 4, title: "Next show" });
    await mkTickets(evNext, buyer, 3);
    await createDuePayouts(); // or the backend's own tick got there first: the row is checked either way
    let next: any = null;
    for (let i = 0; i < 20 && !next; i++) { next = (await q(`SELECT * FROM event_payouts WHERE event_id = $1`, [evNext]))[0]; if (!next) await sleep(250); }
    assert(!!next && next.gross_cents === 3 * 2923 && next.deducted_cents === 1000 && next.amount_cents === 3 * 2923 - 1000,
      "next payout deducts only the still owed 10.00 (the collected and resolved ones are skipped)", next);
    const recs = await q(`SELECT id, status, recovered_from_payout_id FROM event_payout_recoveries WHERE id = ANY($1)`, [[recA, recB, recC]]);
    const st = (id: string) => recs.find((x) => x.id === id);
    assert(st(recA).status === "collected" && st(recA).recovered_from_payout_id === null && st(recB).status === recBRow.status && st(recB).recovered_from_payout_id === null
      && st(recC).status === "recovered" && st(recC).recovered_from_payout_id === next?.id, "resolved rows untouched, owed row recovered from the new payout", recs);

    console.log("\nemail the host");
    // Payouts: user host held, business host review, photographer host held, failing address held, one for the double click.
    const evEU = await mkEvent({ host: hostU, endedDaysAgo: 5, title: "Email user" });
    const payEU = await mkPayout(evEU, { status: "held", gross: 2923, hold: "not_complete" });
    await mkTickets(evEU, buyer, 1, { payoutId: payEU });
    const evEB = await mkEvent({ host: hostB, type: "business", bizId: biz.id, endedDaysAgo: 5, title: "Email biz" });
    const payEB = await mkPayout(evEB, { status: "review", dest: "business", gross: 2923, attempts: 5, lastError: "the transfer failed 5 times" });
    await mkTickets(evEB, buyer, 1, { payoutId: payEB });
    const evEP = await mkEvent({ host: hostPh, type: "photographer", photoId: ph.id, endedDaysAgo: 5, title: "Email photo" });
    const payEP = await mkPayout(evEP, { status: "held", dest: "photographer", gross: 2923, hold: "no_account" });
    await mkTickets(evEP, buyer, 1, { payoutId: payEP });
    const evEF = await mkEvent({ host: hostF, endedDaysAgo: 5, title: "Email fails" });
    const payEF = await mkPayout(evEF, { status: "held", gross: 2923, hold: "no_account" });
    await mkTickets(evEF, buyer, 1, { payoutId: payEF });
    const evED = await mkEvent({ host: hostU, endedDaysAgo: 5, title: "Double click" });
    const payED = await mkPayout(evED, { status: "review", gross: 2923, attempts: 5, lastError: "boom" });
    await mkTickets(evED, buyer, 1, { payoutId: payED });

    const [{ n: todayBefore }] = await q(
      `SELECT count(*)::int AS n FROM email_log WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'`);
    if (todayBefore > 60) console.warn(`  ⚠ ${todayBefore} email_log rows today already: the send assertions need fewer than 70`);

    r = await call("POST", `/api/admin/events/payouts/${payPaid}/email-host`, { token: adminTok });
    assert(r.status === 409 && r.body.error.code === "NOT_HELD_OR_REVIEW" && (await auditFor(payPaid)).length === 0, "paid payout: 409, no audit row", r);
    r = await call("POST", `/api/admin/events/payouts/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/email-host`, { token: adminTok });
    assert(r.status === 404 && r.body.error.code === "PAYOUT_NOT_FOUND", "unknown payout: 404", r);

    // Budget: 70 rows today -> 503, nothing claimed, nothing sent.
    await q(`INSERT INTO email_log (kind, label, status, created_at) SELECT 'ticket', $1, 'sent', now() FROM generate_series(1, 70)`, [`${P}-fill`]);
    r = await call("POST", `/api/admin/events/payouts/${payEU}/email-host`, { token: adminTok });
    assert(r.status === 503 && r.body.error.code === "EMAIL_BUDGET" && (await auditFor(payEU)).length === 0 && sent.length === 0, "budget used up (70 today): 503, no audit row, no email", r);
    await q(`DELETE FROM email_log WHERE label = $1`, [`${P}-fill`]);

    // Success for each host type.
    const hostEmail = async (id: string) => (await q(`SELECT email FROM users WHERE id = $1`, [id]))[0].email as string;
    const cases: Array<[string, string, string, "held" | "review", string]> = [
      ["user host", payEU, hostU, "held", "Email user"],
      ["business host (owner account, not the contact email)", payEB, hostB, "review", "Email biz"],
      ["photographer host", payEP, hostPh, "held", "Email photo"],
    ];
    for (const [label, pid, userId, notice, title] of cases) {
      const before = sent.length;
      r = await call("POST", `/api/admin/events/payouts/${pid}/email-host`, { token: adminTok });
      const mail = sent[before];
      const to = await hostEmail(userId);
      assert(r.status === 200 && r.body.success === true && r.body.sent === true && r.body.notice === notice && sent.length === before + 1, `${label}: 200, one email`, r);
      assert(!r.raw.includes("@") && !r.raw.includes(P + "-"), `${label}: response has no address`, r.raw);
      const wantSubject = notice === "held" ? `Your payout for ${P} ${title} is waiting` : `We couldn't send your payout for ${P} ${title}`;
      const wantText = notice === "held"
        ? `Your payout for ${P} ${title} is waiting. Finish your payout setup so we can send your earnings.`
        : `We couldn't send your payout for ${P} ${title}. Please check your payout account details in Stripe, then reply to this email.`;
      const html = String(mail?.html ?? "").replace(/&#39;|&#x27;/g, "'");
      assert(mail && (Array.isArray(mail.to) ? mail.to[0] : mail.to) === to && mail.subject === wantSubject && html.includes(wantText)
        && mail.reply_to === ADMIN_EMAIL, `${label}: sent to the account email with the spec copy`, { to: mail?.to, subject: mail?.subject, reply_to: mail?.reply_to });
      assert(!/[‒–—―]| - |%/.test(`${mail?.subject} ${wantText}`), `${label}: no dashes or percentages in the copy`);
      const a = await auditFor(pid);
      assert(a.length === 1 && a[0].action === "event_payout.email_host" && a[0].actor_id === adminId && a[0].target_type === "event_payout"
        && !JSON.stringify(a[0]).includes("@"), `${label}: one audit row, no address in it`, a);
      let logged: any[] = [];
      for (let i = 0; i < 20 && !logged.length; i++) {
        logged = await q(`SELECT kind, label, status, user_id FROM email_log WHERE user_id = $1 AND label = 'Event payout notice'`, [userId]);
        if (!logged.length) await sleep(150);
      }
      assert(logged.length === 1 && logged[0].kind === "ticket" && logged[0].status === "sent", `${label}: email_log row written`, logged);
    }
    assert(!sent.some((m) => String(m.to).includes("bizcontact")), "business contact email is not used");

    // Cooldown: a second click within 24 hours.
    let before = sent.length;
    r = await call("POST", `/api/admin/events/payouts/${payEU}/email-host`, { token: adminTok });
    assert(r.status === 429 && r.body.error.code === "EMAIL_RECENTLY_SENT" && sent.length === before && (await auditFor(payEU)).length === 1,
      "second email within 24 hours: 429, no email, still one audit row", r);
    // Older than 24 hours: allowed again.
    await q(`UPDATE audit_logs SET created_at = created_at - interval '25 hours' WHERE target_id = $1 AND action = 'event_payout.email_host'`, [payEU]);
    r = await call("POST", `/api/admin/events/payouts/${payEU}/email-host`, { token: adminTok });
    assert(r.status === 200 && sent.length === before + 1 && (await auditFor(payEU)).length === 2, "after 24 hours: allowed again, second audit row", r);

    // Double click on a fresh payout.
    before = sent.length;
    const [c1, c2] = await Promise.all([
      call("POST", `/api/admin/events/payouts/${payED}/email-host`, { token: adminTok }),
      call("POST", `/api/admin/events/payouts/${payED}/email-host`, { token: adminTok }),
    ]);
    const cc = [c1.status, c2.status].sort();
    assert(cc[0] === 200 && cc[1] === 429 && sent.length === before + 1 && (await auditFor(payED)).length === 1, "double click: one email, one 200 and one 429", { cc, sent: sent.length - before });

    // Failed send: 502, claim given back, a retry is allowed (and fails again, not 429).
    r = await call("POST", `/api/admin/events/payouts/${payEF}/email-host`, { token: adminTok });
    assert(r.status === 502 && r.body.error.code === "EMAIL_FAILED" && (await auditFor(payEF)).length === 0 && !r.raw.includes("@"), "Resend error: 502, audit row removed", r);
    r = await call("POST", `/api/admin/events/payouts/${payEF}/email-host`, { token: adminTok });
    assert(r.status === 502 && (await auditFor(payEF)).length === 0, "retry after a failure is allowed (502 again, not 429)", r);
    const logPath = process.env.EV_TEST_BACKEND_LOG;
    if (logPath) {
      const log = (await import("fs")).readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("[AdminEvents]"));
      assert(log.some((l) => l.includes(payEF)) && !log.some((l) => /@test\.local|hostf\+fail/.test(l)), "backend log shows the failed payout id but never the address", log.slice(-5));
    }

    console.log("\nactivity text (B2 carry over)");
    const DR = await call("GET", `/api/admin/events/${evRetry}`, { token: adminTok });
    const retryAct = (DR.body.activity as any[]).find((a) => a.kind === "admin_action");
    assert(retryAct?.text === `Payout set to try again by @${P}adm.`, "retry shows as a readable admin action", retryAct);
    const DE = await call("GET", `/api/admin/events/${evEB}`, { token: adminTok });
    const rv5 = (DE.body.activity as any[]).find((a) => a.kind === "payout_review");
    assert(rv5?.text === "Payout moved to review. Tried 5 times.", "review after 5 tries", rv5);
    assert((DE.body.activity as any[]).some((a) => a.kind === "admin_action" && a.text === `Host emailed about the payout by @${P}adm.`), "email host shows in activity");
    const DC = await call("GET", `/api/admin/events/${evCan}`, { token: adminTok });
    const rv1 = (DC.body.activity as any[]).find((a) => a.kind === "payout_review");
    assert(rv1?.text === "Payout moved to review.", "review after 1 try (cancelled event): no count, no \"1 tries\"", rv1);
    const DP = await call("GET", `/api/admin/events/${evPaid}`, { token: adminTok });
    const texts = (DP.body.activity as any[]).map((a) => a.text);
    assert(texts.includes(`Owed amount marked collected by @${P}adm.`), "collected shows in activity", texts);
    assert(![DR, DE, DC, DP].some((x) => (x.body.activity as any[]).some((a) => /tries\b|[‒–—―]| - /.test(a.text))), "no \"tries\" and no dashes in any activity text");

    console.log("\nimpossible dates (B2 carry over)");
    for (const bad of ["?from=2026-02-30", "?to=2026-04-31", "?from=2026-02-29", "?from=2026-10-01T24:00:00Z", "?from=2026-10-01T10:00:00+24:00", "?from=2026-00-10"]) {
      r = await call("GET", `/api/admin/events${bad}`, { token: adminTok });
      assert(r.status === 400 && r.body.error.code === "BAD_RANGE", `${bad}: 400`, r.status);
    }
    for (const ok of ["?from=2028-02-29", "?from=2026-02-28&to=2026-03-01", "?from=2026-10-01T23:59:59-04:00"]) {
      r = await call("GET", `/api/admin/events${ok}`, { token: adminTok });
      assert(r.status === 200, `${ok}: 200`, r.status);
    }
    console.log(`  (in-process admin alerts: ${adminAlerts.length}; other emails through the stub: ${other.length})`);
  } finally {
    setAdminAlertForTest(null);
    await q(`DELETE FROM email_log WHERE label = $1`, [`${P}-fill`]);
    if (eventIds.length) {
      const payIds = (await q(`SELECT id FROM event_payouts WHERE event_id = ANY($1)`, [eventIds])).map((x) => x.id);
      if (payIds.length) {
        const recIds = (await q(`SELECT id FROM event_payout_recoveries WHERE payout_id = ANY($1) OR recovered_from_payout_id = ANY($1)`, [payIds])).map((x) => x.id);
        await q(`DELETE FROM audit_logs WHERE target_id = ANY($1)`, [[...payIds, ...recIds]]);
        await q(`DELETE FROM event_payout_recoveries WHERE id = ANY($1)`, [recIds]);
      }
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM event_payouts WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    }
    await q(`DELETE FROM businesses WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM photographers WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM user_payout_accounts WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    if (adminId) {
      await q(`DELETE FROM audit_logs WHERE actor_id = $1`, [adminId]);
      await q(`DELETE FROM users WHERE id = $1 AND email = $2`, [adminId, ADMIN_EMAIL]);
    }
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    const left = await q(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [ADMIN_EMAIL]);
    console.log(`\ncleanup: ${ADMIN_EMAIL} rows left = ${left[0].n}`);
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
