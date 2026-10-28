/**
 * Events host sales summary: GET /api/events/:id/summary.
 *
 * Run with: .superpowers/sdd/2026-10-22-events-list-day-of-address/env/run-suite.sh server/events/eventSummary.http.test.ts
 * SCRATCH ONLY. Local scratch Postgres, backend on localhost (EV_TEST_BASE_URL), EV_TEST_PG_URL. Localhost only.
 * Skips (exit 0) when EV_TEST_BASE_URL is unset. Rows are seeded straight into SQL (no Stripe).
 *
 * Mutation checks:
 *  - sum t.price_cents of refunded tickets -> o.refunded_cents: "cancelled event refunds count ticket price only" fails.
 *  - drop `o.status = 'completed'` from the sold rule: the pending checkout assertions fail.
 *  - use loadEventForHost's door-member check: "door team member gets 404" fails.
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function callAt(base: string, method: string, path: string, o: { token?: string } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const headers: Record<string, string> = {};
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json, raw: b }); });
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const call = (p: string, token?: string) => callAt(BASE, "GET", p, { token });
  const { generateAccessToken } = await import("../auth");
  const { HOST_PAYOUT_DELAY_DAYS } = await import("./payoutTiming");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const P = `sm${Date.now().toString(36)}`;
  const mkUser = async (s: string, active = true) => (await q(
    `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
    [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, `${P}${s}`.slice(0, 24), active],
  ))[0].id as string;
  const host = await mkUser("host");
  const hostInactive = await mkUser("hin", false);
  const stranger = await mkUser("str");
  const doorMember = await mkUser("door");
  const buyers: string[] = [];
  for (let i = 0; i < 6; i++) buyers.push(await mkUser(`b${i}`));

  const mkEvent = async (hostId: string, status: string, endsH: number) => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, $4, now() + (($5::int - 3) || ' hours')::interval, now() + ($5 || ' hours')::interval, 'America/New_York') RETURNING id, ends_at`,
    [hostId, `${P}-${Math.random().toString(36).slice(2, 8)}`, `${P} ${status}`, status, endsH],
  ))[0] as { id: string; ends_at: Date };
  const mkType = async (eventId: string, name: string, price: number, o: { hidden?: boolean; sort?: number; status?: string } = {}) => (await q(
    `INSERT INTO ticket_types (event_id, name, price_cents, quantity, hidden, sort_order, status) VALUES ($1, $2, $3, 100, $4, $5, $6) RETURNING id`,
    [eventId, name, price, o.hidden ?? false, o.sort ?? 0, o.status ?? "active"],
  ))[0].id as string;
  /** One order of `count` tickets of one type. fee/host split: platform fee is 5% of price rounded, just a number here. */
  const mkOrder = async (eventId: string, typeId: string, buyer: string, price: number, count: number,
    o: { order?: string; ticket?: string; reason?: string; refundedCents?: number } = {}) => {
    const orderStatus = o.order ?? "completed";
    const platform = price > 0 ? Math.round(price * 0.1) : 0;
    const sub = price * count;
    const svc = price > 0 ? 100 * count : 0;
    const total = sub + svc;
    const refunded = o.refundedCents ?? 0;
    const pendingAmt = orderStatus === "refunding" ? total - refunded : 0;
    const oid = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, platform_fee_cents, host_net_cents, total_cents,
         refunded_cents, refund_reason, refund_amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [eventId, buyer, orderStatus, count, sub, svc, platform * count, sub - platform * count, total, refunded, o.reason ?? null, pendingAmt],
    ))[0].id as string;
    const iid = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'issued', now() + interval '1 day') RETURNING id`,
      [oid, eventId, typeId, buyer, count, price],
    ))[0].id as string;
    for (let i = 1; i <= count; i++) {
      await q(
        `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents, platform_fee_cents, host_net_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [oid, iid, eventId, typeId, buyer, i, `${P}${Math.random().toString(36).slice(2, 12)}`, o.ticket ?? "valid", price, platform, price - platform],
      );
    }
    return oid;
  };
  const ht = tok(host);

  try {
    console.log("\nmixed orders");
    const ev = await mkEvent(host, "published", 48);
    const tGen = await mkType(ev.id, "General", 2000, { sort: 1 });
    const tVip = await mkType(ev.id, "VIP", 5000, { sort: 2, hidden: true });
    const tFree = await mkType(ev.id, "Free RSVP", 0, { sort: 3 });
    const tOld = await mkType(ev.id, "Old", 1000, { sort: 4, status: "archived" });
    const tFirst = await mkType(ev.id, "Early", 1500, { sort: 0 });
    await mkOrder(ev.id, tGen, buyers[0], 2000, 2);                                                   // sold 2 x 2000
    await mkOrder(ev.id, tVip, buyers[1], 5000, 1);                                                   // sold 1 x 5000 (hidden type)
    await mkOrder(ev.id, tFree, buyers[2], 0, 3);                                                     // free RSVP, 3 sold
    await mkOrder(ev.id, tGen, buyers[3], 2000, 1, { order: "refunded", ticket: "refunded", reason: "buyer", refundedCents: 2100 }); // buyer refund, done
    await mkOrder(ev.id, tGen, buyers[4], 2000, 2, { order: "refunding", ticket: "refunded", reason: "host" });                     // refund in flight
    await mkOrder(ev.id, tGen, buyers[5], 2000, 4, { order: "pending", ticket: "valid" });           // checkout not paid
    await mkOrder(ev.id, tFree, buyers[5], 0, 2, { order: "cancelled", ticket: "cancelled" });       // cancelled free RSVP
    const sold = await q(`SELECT coalesce(sum(t.host_net_cents),0)::int AS n FROM tickets t JOIN ticket_orders o ON o.id = t.order_id WHERE t.event_id = $1 AND t.status = 'valid' AND o.status = 'completed'`, [ev.id]);

    let r = await call(`/api/events/${ev.id}/summary`);
    assert(r.status === 401 && r.body.error.code === "NO_AUTH" && r.body.success === false, "401 without auth", r);
    r = await call(`/api/events/${ev.id}/summary`, tok(stranger));
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "stranger gets 404", r);
    await q(`INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id, accepted_at) VALUES ($1, $2, $1, now())`, [host, doorMember]);
    await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, accepted_at) VALUES ($1, $2, $3, now())`, [ev.id, doorMember, host]);
    r = await call(`/api/events/${ev.id}/summary`, tok(doorMember));
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "door team member gets 404", r);
    r = await call(`/api/events/nope-${P}/summary`, ht);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "unknown id gets 404", r);
    const evIn = await mkEvent(hostInactive, "published", 48);
    r = await call(`/api/events/${evIn.id}/summary`, tok(hostInactive));
    assert(r.status === 403 && r.body.error.code === "ACCOUNT_INACTIVE", "inactive host gets 403 ACCOUNT_INACTIVE", r);

    r = await call(`/api/events/${ev.id}/summary`, ht);
    const s = r.body;
    assert(r.status === 200 && s.success === true, "host gets 200", r);
    const tt = s.ticketTypes ?? [];
    assert(JSON.stringify(tt.map((t: any) => t.name)) === JSON.stringify(["Early", "General", "VIP", "Free RSVP"]), "non-archived types incl. hidden, in sort order, archived left out", tt);
    const by = (n: string) => tt.find((t: any) => t.name === n) ?? {};
    assert(by("Early").sold === 0 && by("Early").grossCents === 0 && by("Early").priceCents === 1500, "type with no sales shows zero", by("Early"));
    assert(by("General").sold === 2 && by("General").grossCents === 4000 && by("General").priceCents === 2000 && by("General").ticketTypeId === tGen, "General: only completed valid tickets", by("General"));
    assert(by("VIP").sold === 1 && by("VIP").grossCents === 5000, "hidden type is counted", by("VIP"));
    assert(by("Free RSVP").sold === 3 && by("Free RSVP").grossCents === 0, "free RSVPs count as sold with no gross", by("Free RSVP"));
    const tot = s.totals ?? {};
    assert(tot.sold === 6 && tot.grossCents === 9000, "totals sold and gross", tot);
    assert(tot.hostEarningsCents === sold[0].n && tot.hostEarningsCents === (4000 - 400) + (5000 - 500), "hostEarningsCents equals what the payout job would pay", { tot, sold });
    assert(tot.refundedTickets === 3 && tot.refundedCents === 6000, "refunded tickets and ticket price only", tot);
    assert(tot.refundPendingTickets === 2, "refund pending only for orders still refunding", tot);
    assert(JSON.stringify(Object.keys(tot).sort()) === JSON.stringify(["grossCents", "hostEarningsCents", "refundPendingTickets", "refundedCents", "refundedTickets", "sold"]), "totals keys", Object.keys(tot));

    console.log("\ncancelled event refunds count ticket price only");
    const evC = await mkEvent(host, "cancelled", 48);
    const tC = await mkType(evC.id, "General", 2000);
    await mkOrder(evC.id, tC, buyers[0], 2000, 2, { order: "refunded", ticket: "refunded", reason: "event_cancelled", refundedCents: 4200 });
    r = await call(`/api/events/${evC.id}/summary`, ht);
    assert(r.body.totals.refundedTickets === 2 && r.body.totals.refundedCents === 4000, "4000 not 4200 (fees left out)", r.body.totals);
    assert(r.body.totals.sold === 0 && r.body.totals.hostEarningsCents === 0, "nothing sold", r.body.totals);
    assert(r.body.payout.expectedAt === null && r.body.payout.status === "none", "cancelled event has no payout date", r.body.payout);

    console.log("\npayout states");
    const expected = new Date(ev.ends_at.getTime() + HOST_PAYOUT_DELAY_DAYS * 86400000).toISOString();
    assert(s.payout.status === "scheduled" && s.payout.expectedAt === expected && s.payout.amountCents === null
      && s.payout.deductedCents === null && s.payout.paidAt === null, "no row, published paid: scheduled, ends_at + 3 days", s.payout);
    assert(HOST_PAYOUT_DELAY_DAYS === 3, "HOST_PAYOUT_DELAY_DAYS is 3");
    const evF = await mkEvent(host, "published", 48);
    const tF = await mkType(evF.id, "Free", 0);
    await mkOrder(evF.id, tF, buyers[0], 0, 2);
    r = await call(`/api/events/${evF.id}/summary`, ht);
    assert(r.body.payout.status === "none" && r.body.payout.expectedAt === null, "free-only event: none, no date", r.body.payout);
    const evD = await mkEvent(host, "draft", 48);
    await mkType(evD.id, "General", 2000);
    r = await call(`/api/events/${evD.id}/summary`, ht);
    assert(r.body.payout.status === "none" && r.body.payout.expectedAt === null, "draft: no date", r.body.payout);
    assert(r.body.ticketTypes.length === 1 && r.body.totals.sold === 0, "draft still returns its types", r.body);

    console.log("\nremoved ticket types and payout timing");
    const evA = await mkEvent(host, "published", 48);
    const aFree = await mkType(evA.id, "Free", 0, { sort: 0 });
    const aGone = await mkType(evA.id, "Gone", 2000, { sort: 1, status: "archived" });
    const aGoneRefunded = await mkType(evA.id, "Gone refunded", 1000, { sort: 2, status: "archived" });
    await mkType(evA.id, "Gone empty", 3000, { sort: 3, status: "archived" });
    await mkOrder(evA.id, aFree, buyers[0], 0, 2);
    await mkOrder(evA.id, aGone, buyers[1], 2000, 2);
    await mkOrder(evA.id, aGoneRefunded, buyers[2], 1000, 1, { order: "refunded", ticket: "refunded", reason: "buyer", refundedCents: 1100 });
    r = await call(`/api/events/${evA.id}/summary`, ht);
    const ta = r.body.ticketTypes ?? [];
    assert(JSON.stringify(ta.map((t: any) => t.name)) === JSON.stringify(["Free", "Gone", "Gone refunded"]), "archived types with sales or refunds are listed, an empty archived type is not", ta);
    const byA = (n: string) => ta.find((t: any) => t.name === n) ?? {};
    assert(byA("Gone").archived === true && byA("Gone").sold === 2 && byA("Gone").grossCents === 4000, "archived type with sales: archived true, counted", byA("Gone"));
    assert(byA("Gone refunded").archived === true && byA("Gone refunded").sold === 0, "archived type with only refunded tickets is listed with zero sold", byA("Gone refunded"));
    assert(byA("Free").archived === false, "active type: archived false", byA("Free"));
    assert(ta.every((t: any) => typeof t.archived === "boolean"), "every row has archived boolean", ta);
    assert(ta.reduce((n: number, t: any) => n + t.sold, 0) === r.body.totals.sold && ta.reduce((n: number, t: any) => n + t.grossCents, 0) === r.body.totals.grossCents
      && r.body.totals.sold === 4 && r.body.totals.grossCents === 4000, "listed rows add up to totals.sold and totals.grossCents", { ta, totals: r.body.totals });
    assert(tt.every((t: any) => t.archived === false), "main event rows all archived false", tt);
    const expectedA = new Date(evA.ends_at.getTime() + HOST_PAYOUT_DELAY_DAYS * 86400000).toISOString();
    assert(r.body.payout.status === "scheduled" && r.body.payout.expectedAt === expectedA, "archived paid type with sales, only a free type active: scheduled, ends_at + 3 days", r.body.payout);

    const evZ = await mkEvent(host, "published", 48);
    await mkType(evZ.id, "General", 2000);
    r = await call(`/api/events/${evZ.id}/summary`, ht);
    assert(r.body.payout.status === "none" && r.body.payout.expectedAt === null, "published paid event with zero sales: none, no date", r.body.payout);

    const evR = await mkEvent(host, "published", 48);
    const rT = await mkType(evR.id, "General", 2000);
    await mkOrder(evR.id, rT, buyers[0], 2000, 2, { order: "refunded", ticket: "refunded", reason: "buyer", refundedCents: 4200 });
    r = await call(`/api/events/${evR.id}/summary`, ht);
    assert(r.body.payout.status === "none" && r.body.payout.expectedAt === null && r.body.totals.refundedTickets === 2, "published paid event, every paid ticket refunded: none, no date", r.body);

    const evP = await mkEvent(host, "paused", 48);
    const pT = await mkType(evP.id, "General", 2000);
    await mkOrder(evP.id, pT, buyers[0], 2000, 1);
    r = await call(`/api/events/${evP.id}/summary`, ht);
    assert(r.body.payout.status === "event_paused" && r.body.payout.expectedAt === null && r.body.payout.amountCents === null, "paused event with sales and no payout row: event_paused, no date", r.body.payout);
    const evP0 = await mkEvent(host, "paused", 48);
    await mkType(evP0.id, "General", 2000);
    r = await call(`/api/events/${evP0.id}/summary`, ht);
    assert(r.body.payout.status === "none" && r.body.payout.expectedAt === null, "paused event with nothing to pay: none", r.body.payout);

    const setPayout = async (eventId: string, status: string, hold: string | null, o: { paid?: boolean; deducted?: number } = {}) => {
      await q(`DELETE FROM event_payouts WHERE event_id = $1`, [eventId]);
      const ded = o.deducted ?? 0;
      await q(`INSERT INTO event_payouts (event_id, gross_cents, deducted_cents, amount_cents, status, hold_reason, last_error, transfer_id, connected_account_id, paid_at)
               VALUES ($1, 3600, $2, $3, $4, $5, 'secret error text', 'tr_secret123', 'acct_secret123', $6)`,
        [eventId, ded, 3600 - ded, status, hold, o.paid ? new Date() : null]);
    };
    const rawAll: string[] = [];
    const cases: Array<[string, string, string | null, string, any?]> = [
      ["pending", "pending", null, "scheduled"],
      ["paid", "paid", null, "paid", { paid: true, deducted: 500 }],
      ["held event_paused", "held", "event_paused", "event_paused"],
      ["held no_account", "held", "no_account", "payout_setup_needed"],
      ["held not_complete", "held", "not_complete", "payout_setup_needed"],
      ["held stripe_not_ready", "held", "stripe_not_ready", "payout_setup_needed"],
      ["held other", "held", "something_else", "on_hold"],
      ["review", "review", null, "on_hold"],
    ];
    for (const [label, st, hold, want, o] of cases) {
      await setPayout(ev.id, st, hold, o);
      r = await call(`/api/events/${ev.id}/summary`, ht);
      rawAll.push(r.raw);
      const p = r.body.payout;
      assert(p.status === want, `${label} -> ${want}`, p);
      if (st === "paid") assert(p.amountCents === 3100 && p.deductedCents === 500 && typeof p.paidAt === "string" && !Number.isNaN(Date.parse(p.paidAt)), "paid shows amount, deducted, paidAt", p);
      else assert(p.paidAt === null && p.amountCents === 3600 && p.deductedCents === 0, `${label} shows amount, no paidAt`, p);
    }
    const all = JSON.stringify(s) + rawAll.join("\n");
    for (const bad of ["hold_reason", "holdReason", "last_error", "lastError", "transfer", "account", "acct_", "tr_", "serviceFee", "service_fee", "0.08", "0.02", "secret", "something_else", "stripe_not_ready", "not_complete"]) {
      assert(!all.includes(bad), `response never contains "${bad}"`);
    }
    assert(!/[‒–—―]| - /.test(all), "no dashes in any text");

    console.log("\nroutes still resolve");
    r = await call(`/api/events/mine`, ht);
    assert(r.status === 200 && r.body.success === true, "/mine still resolves", r);
    r = await call(`/api/events/slug/${P}-nope`);
    assert(r.status === 404, "/slug/x still resolves (404 for unknown)", r);
    r = await call(`/api/events/door/mine`, ht);
    assert(r.status === 200, "/door/mine still resolves", r);
  } finally {
    // Every event a test user hosts, and everything seeded under it.
    const evIds = (await q(`SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`])).map((x) => x.id);
    await q(`DELETE FROM event_door_team WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    if (evIds.length) {
      await q(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM ticket_account_counts WHERE ticket_type_id IN (SELECT id FROM ticket_types WHERE event_id = ANY($1))`, [evIds]);
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM event_payouts WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [evIds]);
    }
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
