/**
 * p4-team step 4b-1: team pay fixed 3 days after the event, taken from the host payout. Nothing is sent (4b-2 sends).
 *
 * Rules (Legend 2026-10-30, calls 1 to 18):
 *   - Order: what the host owes Outsyde from earlier events first (may take the whole payout, call 17), then team pay,
 *     all or nothing against what's left, then the host (can be $0, recorded as paid with nothing sent).
 *   - Team = whoever was on it when the event ended (call 15). Free or uncovered events get team rows too
 *     ('host_to_pay', for the settle button in 4b-2). A paused event gets nothing until it's released.
 *   - Host refunds stop once the payout is worked out. The end time locks once the event is over (call 16).
 *   - Hosts who owe get a push and an email every 7 days (call 18).
 *   - The daily bank payout keeps unpaid team pay on Stripe.
 *
 * Run in process: EV_TEST_PG_URL=<local> DATABASE_URL=<local> STRIPE_STUB_PORT=<free port>
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" npx tsx server/events/teamPayouts.http.test.ts
 * SCRATCH ONLY: refuses any non-local database. Nothing reaches real Stripe, Resend or Expo.
 */
import http from "http";

const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.STRIPE_STUB_PORT || "0");
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

function callAt(base: string, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set EV_TEST_PG_URL (+ DATABASE_URL via the shim) to run"); process.exit(0); }
  if (!isLocal(PG_URL)) throw new Error("refusing to run: PG_URL must be localhost");
  if (!STUB_PORT) throw new Error("refusing to run: set STRIPE_STUB_PORT and preload ./.dev/stripe-stub-preload.mjs");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  process.env.FRONTEND_URL = "https://goutsyde.test";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  // Stripe stub: nothing in 4b-1 should call Stripe; any call is recorded so a test can say so.
  const stripeCalls: string[] = [];
  const stub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      stripeCalls.push(`${req.method} ${req.url}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "api_error", message: "stub: 4b-1 must not call Stripe" } }));
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const express = (await import("express")).default;
  const notices = await import("./ticketNotices");
  const pushes: any[] = [];
  const owedEmails: any[] = [];
  notices.setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; }, createActivity: async () => {}, sendDoorInvite: async () => {},
    sendOwedReminder: async (p: any) => { owedEmails.push(p); },
  } as any);
  const payouts = await import("./eventPayouts");
  const { computeHeld } = await import("../bankPayout");
  const { requestOrderRefund } = await import("./ticketRefunds");
  const app = express();
  app.use(express.json());
  app.use("/api/events", (await import("./doorRouter")).default);
  app.use("/api/events", (await import("./eventsRouter")).default);
  app.use("/api/events", (await import("./ticketsRouter")).default);
  app.use("/api/events", (await import("./ticketRefunds")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `tq${Date.now().toString(36)}`;
  const mkUser = async (s: string) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, username],
    ))[0].id as string;
    return { id, username };
  };
  const FEE_HOST = 40; // 2% of $20
  const mkEvent = async (host: { id: string }, slug: string, o: { ended?: string; status?: string } = {}) => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at)
     VALUES ($1, $2, $3, $4, now() - ($5::interval + interval '5 hours'), now() - $5::interval, 'America/New_York', now() - interval '20 days')
     RETURNING id, slug, starts_at, ends_at`,
    [host.id, `${P}-${slug}`, `${P} ${slug}`, o.status ?? "published", o.ended ?? "4 days"],
  ))[0] as { id: string; slug: string; starts_at: Date; ends_at: Date };
  const mkType = async (eventId: string) => (await q(
    `INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'GA', 2000, 500, 1, 50) RETURNING id`, [eventId],
  ))[0].id as string;
  /** One completed order of `count` $20 tickets (host gets $19.60 each), optionally through a promoter link. */
  const mkOrder = async (eventId: string, typeId: string, buyer: string, count: number, linkId: string | null = null) => {
    const sub = 2000 * count, plat = FEE_HOST * count;
    const oid = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents,
         host_net_cents, total_cents, completed_at, paid_at, promoter_link_id)
       VALUES ($1, $2, 'completed', $3, $4, 0, 0, $5, $6, $4, now() - interval '6 days', now() - interval '6 days', $7) RETURNING id`,
      [eventId, buyer, count, sub, plat, sub - plat, linkId],
    ))[0].id as string;
    const iid = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 2000, 'issued', now() + interval '1 day') RETURNING id`, [oid, eventId, typeId, buyer, count],
    ))[0].id as string;
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) {
      ids.push((await q(
        `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents,
           service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid', 2000, 0, 0, $8, $9) RETURNING id`,
        [oid, iid, eventId, typeId, buyer, i, `${P}${Math.random().toString(36).slice(2, 12)}`, FEE_HOST, 2000 - FEE_HOST],
      ))[0].id);
    }
    return { orderId: oid, ticketIds: ids };
  };
  /** Accepted event team member (accepted 10 days ago unless told otherwise). */
  const addMember = async (eventId: string, host: { id: string }, u: { id: string }, role: string, o: { acceptedAt?: string; removedAt?: string | null } = {}) =>
    q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, invited_at, accepted_at, removed_at)
       VALUES ($1, $2, $3, $4, now() - interval '12 days', ${o.acceptedAt ?? "now() - interval '10 days'"}, ${o.removedAt ?? "NULL"})`,
      [eventId, u.id, host.id, role]);
  const setPay = (eventId: string, u: { id: string }, role: string, host: { id: string }, p: { type: string; fixed?: number; hourly?: number; bps?: number }) =>
    q(`INSERT INTO event_team_pay (event_id, member_user_id, role, pay_type, fixed_cents, hourly_cents, commission_bps, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [eventId, u.id, role, p.type, p.fixed ?? null, p.hourly ?? null, p.bps ?? null, host.id]);
  const setShift = (eventId: string, u: { id: string }, role: string, host: { id: string }, hours: number) =>
    q(`INSERT INTO event_team_schedules (event_id, member_user_id, role, starts_at, ends_at, updated_by_user_id)
       SELECT id, $2, $3, starts_at, starts_at + make_interval(mins => $4::int), $5 FROM events WHERE id = $1`, [eventId, u.id, role, Math.round(hours * 60), host.id]);
  const mkLink = async (eventId: string, u: { id: string }) => (await q(
    `INSERT INTO event_promoter_links (event_id, promoter_user_id, code) VALUES ($1, $2, $3) RETURNING id`,
    [eventId, u.id, Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("")],
  ))[0].id as string;
  const payoutOf = async (eventId: string) => (await q(`SELECT * FROM event_payouts WHERE event_id = $1`, [eventId]))[0];
  const teamOf = async (eventId: string) => q(`SELECT * FROM event_team_payouts WHERE event_id = $1 ORDER BY amount_cents DESC`, [eventId]);
  const fixedAt = async (eventId: string) => (await q(`SELECT team_pay_fixed_at FROM events WHERE id = $1`, [eventId]))[0]?.team_pay_fixed_at ?? null;
  /** Runs the create step until it has nothing left for these events (other test data may be due too). */
  const runCreate = async () => { for (let i = 0; i < 5; i++) await payouts.createDuePayouts(); };

  const buyer = await mkUser("buyer");
  const allEvents: string[] = [];
  const allUsers: string[] = [buyer.id];
  const user = async (s: string) => { const u = await mkUser(s); allUsers.push(u.id); return u; };
  const event = async (h: { id: string }, slug: string, o: { ended?: string; status?: string } = {}) => { const e = await mkEvent(h, slug, o); allEvents.push(e.id); return e; };

  try {
    // ── 1. Covered: $196 earned, team $100 (fixed $50 + DJ $20 x 2 h + promoter 10% of $100), host $96 ──
    console.log("\ncovered: team paid from the host payout");
    const h1 = await user("h1"); const sec1 = await user("s1"); const dj1 = await user("d1"); const pr1 = await user("p1");
    const e1 = await event(h1, "covered");
    const t1 = await mkType(e1.id);
    const link1 = await mkLink(e1.id, pr1);
    await mkOrder(e1.id, t1, buyer.id, 5);
    await mkOrder(e1.id, t1, buyer.id, 5, link1);
    for (const [u, role] of [[sec1, "security"], [dj1, "entertainment"], [pr1, "host"]] as const) await addMember(e1.id, h1, u, role);
    await setPay(e1.id, sec1, "security", h1, { type: "fixed", fixed: 5000 });
    await setPay(e1.id, dj1, "entertainment", h1, { type: "hourly", hourly: 2000 });
    await setShift(e1.id, dj1, "entertainment", h1, 2);
    await setPay(e1.id, pr1, "host", h1, { type: "none", bps: 1000 });
    const heldBefore = (await computeHeld()).total;
    stripeCalls.length = 0;
    await runCreate();
    let p = await payoutOf(e1.id);
    assert(p && Number(p.gross_cents) === 19600 && Number(p.team_cents) === 10000 && Number(p.deducted_cents) === 0 && Number(p.amount_cents) === 9600 && p.status === "pending",
      "host payout: $196 earned, $100 team, $96 to the host", p);
    let team = await teamOf(e1.id);
    const byUser = (id: string) => team.find((r: any) => r.member_user_id === id);
    assert(team.length === 3 && Number(byUser(sec1.id)?.amount_cents) === 5000 && Number(byUser(dj1.id)?.amount_cents) === 4000 && Number(byUser(pr1.id)?.amount_cents) === 1000,
      "team rows: Security $50, DJ $40, Promoter $10", team);
    assert(team.every((r: any) => r.outcome === "covered" && r.status === "pending" && r.payout_id === p.id && r.transfer_id === null), "covered, pending, tied to the payout, nothing sent", team);
    assert(byUser(dj1.id)?.breakdown?.hours === 2 && byUser(dj1.id)?.breakdown?.hourlyCents === 4000 && byUser(pr1.id)?.breakdown?.commissionCents === 1000,
      "breakdown kept on record (hours, hourly, commission)", team.map((r: any) => r.breakdown));
    assert(!!(await fixedAt(e1.id)), "event marked as team pay fixed");
    const held = await computeHeld();
    assert(held.total === heldBefore && held.breakdown.teamPayoutsOpen >= 10000, "bank payout keeps the same money held (host share + unpaid team pay)", { before: heldBefore, after: held.total, team: held.breakdown.teamPayoutsOpen });
    await runCreate();
    assert((await teamOf(e1.id)).length === 3, "a second run adds nothing");

    console.log("\nnothing sent to Stripe in 4b-1");
    assert(stripeCalls.length === 0, "no Stripe call while working it out", stripeCalls);

    console.log("\nhost refunds stop once the payout is worked out");
    const ord1 = (await q(`SELECT id FROM ticket_orders WHERE event_id = $1 LIMIT 1`, [e1.id]))[0].id;
    let r = await call("POST", `/api/events/${e1.id}/orders/${ord1}/refund`, { token: tok(h1.id) });
    assert(r.status === 409 && r.body?.error?.code === "PAYOUT_CREATED" && typeof r.body?.error?.message === "string", "host refund refused: PAYOUT_CREATED", r.body);
    assert(!/[–—]/.test(r.body?.error?.message ?? "") && !/ - /.test(r.body?.error?.message ?? ""), "refusal copy has no dashes", r.body?.error?.message);
    assert((await q(`SELECT status FROM ticket_orders WHERE id = $1`, [ord1]))[0].status === "completed", "order untouched");

    console.log("\nsummary shows the fixed amounts");
    r = await call("GET", `/api/events/${e1.id}/summary`, { token: tok(h1.id) });
    assert(r.status === 200 && r.body?.teamPay?.fixed === true && r.body?.teamPay?.teamPaidCents === 10000 && r.body?.teamPay?.covered === true && r.body?.teamPay?.hostTakeHomeCents === 9600,
      "summary teamPay comes from the fixed rows", r.body?.teamPay);
    assert(r.body?.payout?.teamCents === 10000 && r.body?.payout?.amountCents === 9600 && r.body?.totals?.hostEarningsCents === 19600 && r.body?.payout?.status === "scheduled",
      "payout gains teamCents; old keys keep their meaning", r.body?.payout);

    console.log("\nadmin money gains the team line");
    const { listAdminEvents } = await import("./adminEventsQueries");
    const adminRow = (await listAdminEvents({ from: new Date(Date.now() - 30 * 86400000).toISOString(), to: null })).find((x: any) => x.id === e1.id);
    assert(adminRow?.payout?.teamCents === 10000 && adminRow?.payout?.amountCents === 9600 && adminRow?.paidToHostCents === 0 && adminRow?.owedToHostCents === 9600,
      "admin payout: teamCents 10000, amount 9600, owed to host is the host share", adminRow?.payout);

    // ── 2. Not covered: team $250 > $196 ──
    console.log("\nnot covered: team $0 from Outsyde, host keeps everything");
    const h2 = await user("h2"); const sec2 = await user("s2");
    const e2 = await event(h2, "uncovered");
    const t2 = await mkType(e2.id);
    await mkOrder(e2.id, t2, buyer.id, 10);
    await addMember(e2.id, h2, sec2, "security");
    await setPay(e2.id, sec2, "security", h2, { type: "fixed", fixed: 25000 });
    await runCreate();
    p = await payoutOf(e2.id);
    assert(p && Number(p.team_cents) === 0 && Number(p.amount_cents) === 19600, "host payout keeps the full $196", p);
    team = await teamOf(e2.id);
    assert(team.length === 1 && Number(team[0].amount_cents) === 25000 && team[0].outcome === "not_covered" && team[0].status === "host_to_pay",
      "team row kept: $250 for the host to pay", team);

    // ── 3. Free event with fixed pay: no host payout, team row for the host to pay ──
    console.log("\nfree event with fixed pay");
    const h3 = await user("h3"); const sec3 = await user("s3");
    const e3 = await event(h3, "free");
    await addMember(e3.id, h3, sec3, "security");
    await setPay(e3.id, sec3, "security", h3, { type: "fixed", fixed: 16000 });
    await runCreate();
    assert(!(await payoutOf(e3.id)), "no host payout row ($0 earned)");
    team = await teamOf(e3.id);
    assert(team.length === 1 && team[0].payout_id === null && team[0].status === "host_to_pay" && Number(team[0].amount_cents) === 16000, "team row: $160 for the host to pay", team);
    assert(!!(await fixedAt(e3.id)), "free event marked fixed, so the job doesn't visit it again");

    // ── 4. Team = who was on it when the event ended (call 15) ──
    console.log("\nteam as it stood when the event ended");
    const h4 = await user("h4"); const stay = await user("st"); const late = await user("lt"); const early = await user("er"); const after = await user("af");
    const e4 = await event(h4, "asof");
    const t4 = await mkType(e4.id);
    await mkOrder(e4.id, t4, buyer.id, 10);
    await addMember(e4.id, h4, stay, "security");
    await addMember(e4.id, h4, late, "security", { removedAt: "now() - interval '3 days'" });   // removed after it ended (ended 4 days ago)
    await addMember(e4.id, h4, early, "security", { removedAt: "now() - interval '6 days'" });  // removed before it ended
    await addMember(e4.id, h4, after, "security", { acceptedAt: "now() - interval '3 days'" }); // accepted after it ended
    for (const u of [stay, late, early, after]) await setPay(e4.id, u, "security", h4, { type: "fixed", fixed: 1000 });
    await runCreate();
    team = await teamOf(e4.id);
    const ids4 = team.map((x: any) => x.member_user_id).sort();
    assert(JSON.stringify(ids4) === JSON.stringify([stay.id, late.id].sort()), "paid: on the team at the end (even if removed later); not: removed before, or joined after", { got: ids4 });
    assert(Number((await payoutOf(e4.id))?.team_cents) === 2000, "team total $20");

    // ── 5. Old debt first; may take the whole payout (call 17) ──
    console.log("\nwhat the host owes Outsyde comes out first");
    const h5 = await user("h5"); const sec5 = await user("s5");
    const acct5 = `acct_${P}h5`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [h5.id, acct5]);
    const old5 = await event(h5, "old5", { ended: "40 days" });
    const tOld = await mkType(old5.id);
    const oldOrd = await mkOrder(old5.id, tOld, buyer.id, 1);
    const oldPay = (await q(`INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, amount_cents, status, transfer_id, paid_at)
      VALUES ($1, 'user', $2, 1960, 0, 1960, 'paid', 'tr_old', now() - interval '35 days') RETURNING id`, [old5.id, acct5]))[0].id;
    await q(`UPDATE events SET team_pay_fixed_at = now() - interval '35 days' WHERE id = $1`, [old5.id]);
    await q(`UPDATE tickets SET payout_id = $1, status = 'refunded', refunded_at = now() - interval '30 days' WHERE id = $2`, [oldPay, oldOrd.ticketIds[0]]);
    await q(`INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status) VALUES ($1, $2, $3, 5000, 'owed')`, [oldOrd.ticketIds[0], oldPay, acct5]);
    const e5 = await event(h5, "debt");
    const t5 = await mkType(e5.id);
    await mkOrder(e5.id, t5, buyer.id, 10); // $196
    await addMember(e5.id, h5, sec5, "security");
    await setPay(e5.id, sec5, "security", h5, { type: "fixed", fixed: 15000 }); // $150 > $196 - $50 = $146
    await runCreate();
    p = await payoutOf(e5.id);
    assert(p && Number(p.deducted_cents) === 5000 && Number(p.team_cents) === 0 && Number(p.amount_cents) === 14600, "$50 debt first; $150 team doesn't fit the $146 left: host $146", p);
    assert((await teamOf(e5.id))[0]?.status === "host_to_pay", "team row: host to pay");

    console.log("\ndebt equal to the earnings is taken in full, host payout $0 (recorded, never sent)");
    const h6 = await user("h6");
    const acct6 = `acct_${P}h6`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [h6.id, acct6]);
    const old6 = await event(h6, "old6", { ended: "40 days" });
    const tOld6 = await mkType(old6.id);
    const oldOrd6 = await mkOrder(old6.id, tOld6, buyer.id, 1);
    const oldPay6 = (await q(`INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, amount_cents, status, transfer_id, paid_at)
      VALUES ($1, 'user', $2, 1960, 0, 1960, 'paid', 'tr_old6', now() - interval '35 days') RETURNING id`, [old6.id, acct6]))[0].id;
    await q(`UPDATE events SET team_pay_fixed_at = now() - interval '35 days' WHERE id = $1`, [old6.id]);
    await q(`UPDATE tickets SET payout_id = $1, status = 'refunded', refunded_at = now() - interval '30 days' WHERE id = $2`, [oldPay6, oldOrd6.ticketIds[0]]);
    await q(`INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status) VALUES ($1, $2, $3, 1960, 'owed')`, [oldOrd6.ticketIds[0], oldPay6, acct6]);
    const e6 = await event(h6, "debtall");
    const t6 = await mkType(e6.id);
    await mkOrder(e6.id, t6, buyer.id, 1); // $19.60, debt $19.60
    await runCreate();
    p = await payoutOf(e6.id);
    assert(p && Number(p.deducted_cents) === 1960 && Number(p.amount_cents) === 0 && p.status === "paid" && p.transfer_id === null && !!p.paid_at,
      "$0 payout: debt taken in full, recorded as paid, nothing sent", p);
    assert((await payouts.sendPayout(p.id)) === "not_due" && stripeCalls.length === 0, "the send step never picks up a $0 payout", stripeCalls);

    console.log("\nteam takes everything: host $0, team covered");
    const h7 = await user("h7"); const sec7 = await user("s7");
    const e7 = await event(h7, "exact");
    const t7 = await mkType(e7.id);
    await mkOrder(e7.id, t7, buyer.id, 10);
    await addMember(e7.id, h7, sec7, "security");
    await setPay(e7.id, sec7, "security", h7, { type: "fixed", fixed: 19600 });
    await runCreate();
    p = await payoutOf(e7.id);
    assert(p && Number(p.team_cents) === 19600 && Number(p.amount_cents) === 0 && p.status === "paid" && (await teamOf(e7.id))[0]?.status === "pending",
      "team exactly equals earnings: team $196 pending, host $0 recorded", p);

    console.log("\na refund on a $0 payout is owed by the host straight away");
    const t7ticket = (await q(`SELECT id FROM tickets WHERE event_id = $1 LIMIT 1`, [e7.id]))[0].id;
    await q(`UPDATE tickets SET status = 'refunded', refunded_at = now() WHERE id = $1`, [t7ticket]);
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [h7.id, `acct_${P}h7`]);
    await q(`UPDATE event_payouts SET connected_account_id = $1, destination_type = 'user' WHERE id = $2`, [`acct_${P}h7`, p.id]);
    await payouts.openRecoveries();
    const rec7 = (await q(`SELECT * FROM event_payout_recoveries WHERE ticket_id = $1`, [t7ticket]))[0];
    assert(rec7?.status === "owed" && Number(rec7?.amount_cents) === 1960 && stripeCalls.length === 0, "recovery opened as owed (no transfer to reverse)", rec7);

    // ── 8. Paused: nothing until released ──
    console.log("\npaused event: nothing until released");
    const h8 = await user("h8"); const sec8 = await user("s8");
    const e8 = await event(h8, "paused", { status: "paused" });
    const t8 = await mkType(e8.id);
    await mkOrder(e8.id, t8, buyer.id, 10);
    await addMember(e8.id, h8, sec8, "security");
    await setPay(e8.id, sec8, "security", h8, { type: "fixed", fixed: 1000 });
    await runCreate();
    assert(!(await payoutOf(e8.id)) && (await teamOf(e8.id)).length === 0 && !(await fixedAt(e8.id)), "no payout, no team rows, not fixed");

    // ── 9. Guard: earnings changed between working out pay and the statement ──
    console.log("\nearnings change mid-way: nothing written, next run tries again");
    const h9 = await user("h9"); const sec9 = await user("s9");
    const e9 = await event(h9, "guard");
    const t9 = await mkType(e9.id);
    const o9 = await mkOrder(e9.id, t9, buyer.id, 10);
    await addMember(e9.id, h9, sec9, "security");
    await setPay(e9.id, sec9, "security", h9, { type: "fixed", fixed: 1000 });
    payouts.setPayoutHooksForTest({ afterTeamCompute: async (eventId: string) => {
      if (eventId === e9.id) await q(`UPDATE tickets SET status = 'refunded', refunded_at = now() WHERE id = $1`, [o9.ticketIds[0]]);
    } });
    await payouts.createDuePayouts();
    payouts.setPayoutHooksForTest(null);
    assert(!(await payoutOf(e9.id)) && (await teamOf(e9.id)).length === 0 && !(await fixedAt(e9.id)), "guard stopped it: nothing written", await payoutOf(e9.id));
    await runCreate();
    p = await payoutOf(e9.id);
    assert(p && Number(p.gross_cents) === 9 * 1960 && Number(p.team_cents) === 1000, "next run: worked out on the new earnings", p);

    // ── 10. End time locked once the event is over (call 16) ──
    console.log("\nend time locked once the event is over");
    const h10 = await user("h10");
    const e10 = await event(h10, "lock", { ended: "2 hours" });
    const sameEnd = new Date(e10.ends_at).toISOString();
    r = await call("PATCH", `/api/events/${e10.id}`, { token: tok(h10.id), body: { endsAt: new Date(new Date(e10.ends_at).getTime() + 86400000).toISOString() } });
    assert(r.status === 400 && r.body?.error?.code === "INVALID_EVENT_TIMES" && /over/.test(r.body?.error?.message ?? ""), "moving the end later after it ended: refused", r.body);
    r = await call("PATCH", `/api/events/${e10.id}`, { token: tok(h10.id), body: { endsAt: sameEnd, title: `${P} lock renamed` } });
    assert(r.status === 200, "sending the same end time (whole form) still saves", r.body);

    // ── 11. Owed reminders every 7 days (call 18) ──
    console.log("\nhosts who owe get a push and an email every 7 days");
    pushes.length = 0; owedEmails.length = 0;
    const sent1 = await payouts.remindOwedHosts();
    // h5's $50 was already taken from their next payout (case 5); h7 owes the $19.60 refund on their $0 payout.
    const pushH7 = pushes.filter((x) => x.userId === h7.id);
    const mailH7 = owedEmails.filter((x) => x.userId === h7.id);
    assert(sent1 >= 1 && pushH7.length === 1 && mailH7.length === 1 && mailH7[0].amountCents === 1960, "host h7 (owes $19.60) gets one push and one email", { pushes, owedEmails });
    const owedCopy = `${pushH7[0]?.title ?? ""} ${pushH7[0]?.body ?? ""}`;
    assert(/\$19\.60/.test(owedCopy) && !/[\u2013\u2014]/.test(owedCopy) && !/ - /.test(owedCopy), "push names $19.60, no dashes", owedCopy);
    assert(pushes.filter((x) => x.userId === h5.id || x.userId === h6.id).length === 0, "hosts whose debt came back from the next payout: no reminder");
    pushes.length = 0; owedEmails.length = 0;
    await payouts.remindOwedHosts();
    assert(pushes.filter((x) => x.userId === h7.id).length === 0, "again within 7 days: nothing");
    await q(`UPDATE event_payout_recoveries SET host_reminded_at = now() - interval '8 days' WHERE connected_account_id = $1`, [`acct_${P}h7`]);
    await payouts.remindOwedHosts();
    assert(pushes.filter((x) => x.userId === h7.id).length === 1, "8 days later: reminded again");
    pushes.length = 0;
    await q(`UPDATE event_payout_recoveries SET status = 'collected', host_reminded_at = now() - interval '8 days' WHERE connected_account_id = $1`, [`acct_${P}h7`]);
    await payouts.remindOwedHosts();
    assert(pushes.filter((x) => x.userId === h7.id).length === 0, "collected by an admin: reminders stop");

    // ── 12. Refunds before payout day still work ──
    console.log("\nhost refund before the payout is worked out still works");
    const h12 = await user("h12");
    const e12 = await event(h12, "early", { ended: "1 day" });
    const t12 = await mkType(e12.id);
    const o12 = await mkOrder(e12.id, t12, buyer.id, 1);
    const rr = await requestOrderRefund(o12.orderId, h12.id, "host");
    assert(rr.ok === true, "1 day after the event: host can still refund", rr);
  } finally {
    payouts.setPayoutHooksForTest(null);
    const ids = allEvents;
    const clean = async (t: string, p: unknown[]) => { try { await q(t, p); } catch (err) { console.error(`  cleanup: ${(err as Error).message}`); } };
    await clean(`DELETE FROM event_payout_recoveries WHERE payout_id IN (SELECT id FROM event_payouts WHERE event_id = ANY($1))`, [ids]);
    await clean(`DELETE FROM event_team_payouts WHERE event_id = ANY($1)`, [ids]);
    await clean(`UPDATE tickets SET payout_id = NULL WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_payouts WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM tickets WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_account_counts WHERE ticket_type_id IN (SELECT id FROM ticket_types WHERE event_id = ANY($1))`, [ids]);
    await clean(`DELETE FROM event_promoter_links WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_team_pay WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_team_schedules WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM user_payout_accounts WHERE user_id = ANY($1)`, [allUsers]);
    await clean(`DELETE FROM notifications WHERE user_id = ANY($1)`, [allUsers]);
    await clean(`DELETE FROM events WHERE id = ANY($1)`, [ids]);
    await clean(`DELETE FROM users WHERE id = ANY($1)`, [allUsers]);
    srv.close();
    stub.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
