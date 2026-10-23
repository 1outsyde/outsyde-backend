/**
 * Admin events money: GET /api/admin/events and GET /api/admin/events/:id.
 *
 * Run with:
 *   EV_TEST_BASE_URL=http://localhost:5071 EV_TEST_PG_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde_test JWT_SECRET=test \
 *     npx tsx server/events/adminEvents.http.test.ts
 * SCRATCH ONLY. Local Postgres, backend on localhost. Localhost only. Skips (exit 0) when EV_TEST_BASE_URL is unset.
 * Rows are seeded straight into SQL. The admin user info@goutsyde.com is created for the run and removed after
 * (the run refuses to start if that email already exists, so a real row is never touched).
 *
 * Seeded fees are fixed numbers (111 service, 99 per ticket, 77 host fee per paid ticket), not percentages, so
 * recomputing fees from rates instead of reading the stored columns fails the money assertions.
 *
 * Mutation checks:
 *  - count buyer fees of event_cancelled refunds as kept: "cancelled event: fees 0" fails.
 *  - drop buyer fees of buyer refunds: "business event money" fails on outsydeFeesCents.
 *  - sum host_net over refunded tickets too: "hostEarnsCents excludes refunded tickets" fails.
 *  - limit attention to the date range: "attention is platform wide" fails.
 *  - return the raw connected_account_id: "account id masked" assertions fail.
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 1200)); }
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

/** Every object key anywhere in a JSON value. */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
  return out;
}

const ADMIN_EMAIL = "info@goutsyde.com";
const FEE_SVC = 111, FEE_PER = 99, FEE_HOST = 77;

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const existing = await q(`SELECT id FROM users WHERE lower(email) = $1`, [ADMIN_EMAIL]);
  if (existing.length) { await db.end(); throw new Error(`refusing to run: ${ADMIN_EMAIL} already exists in this database`); }

  const P = `ae${Date.now().toString(36)}`;
  let adminId: string | null = null;
  const mkUser = async (s: string, o: { email?: string; admin?: boolean } = {}) => (await q(
    `INSERT INTO users (id, email, name, first_name, username, is_admin) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
    [o.email ?? `${P}-${s}@test.local`, `Shown ${s}`, `Realfirst${s}`, `${P}${s}`.slice(0, 24), o.admin ?? false],
  ))[0].id as string;
  const tok = (id: string, isAdmin: boolean) => generateAccessToken({ userId: id, isVendor: false, isAdmin });
  const H = (d: number, h = 0) => `now() + interval '${d} days' + interval '${h} hours'`;

  const eventIds: string[] = [];
  const mkEvent = async (o: { host: string; type?: string; bizId?: string; status?: string; startD: number; title: string; cancelled?: boolean }) => {
    const [e] = await q(
      `INSERT INTO events (host_user_id, host_type, host_business_id, slug, title, status, starts_at, ends_at, timezone, city, state, capacity,
         published_at, cancelled_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${H(o.startD)}, ${H(o.startD, 3)}, 'America/New_York', 'Freeport', 'NY', 200,
         ${o.status === "draft" ? "NULL" : H(o.startD - 20)}, ${o.cancelled ? H(o.startD - 2) : "NULL"}, ${H(o.startD - 30)})
       RETURNING id, ends_at`,
      [o.host, o.type ?? "user", o.bizId ?? null, `${P}-${Math.random().toString(36).slice(2, 8)}`, `${P} ${o.title}`, o.status ?? "published"],
    );
    eventIds.push(e.id);
    return e as { id: string; ends_at: Date };
  };
  const mkType = async (eventId: string, name: string, price: number, sort = 0) => (await q(
    `INSERT INTO ticket_types (event_id, name, price_cents, quantity, sort_order) VALUES ($1, $2, $3, 100, $4) RETURNING id`,
    [eventId, name, price, sort],
  ))[0].id as string;

  type Seed = { price: number; status: string; reason: string | null; checkedIn: boolean; payout: string | null };
  const seeded: Record<string, { ticketIds: string[]; tickets: Seed[] }> = {};
  /** One order of `count` tickets with fixed fee numbers. Returns ticket ids. */
  const mkOrder = async (eventId: string, typeId: string, buyer: string, price: number, count: number,
    o: { order?: string; ticket?: string; reason?: string; refundedCents?: number; checkedIn?: number; payoutId?: string | null } = {}) => {
    const orderStatus = o.order ?? "completed";
    const paid = price > 0;
    const sub = price * count, svc = paid ? FEE_SVC * count : 0, per = paid ? FEE_PER * count : 0, plat = paid ? FEE_HOST * count : 0;
    const total = sub + svc + per;
    const refunded = o.refundedCents ?? 0;
    const pendingAmt = orderStatus === "refunding" ? total - refunded : 0;
    const refundTs = o.reason ? "now() - interval '1 day'" : "NULL";
    const refundedTs = orderStatus === "refunded" ? "now() - interval '1 day' + interval '1 minute'" : "NULL";
    const oid = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents,
         host_net_cents, total_cents, refunded_cents, refund_reason, refund_amount_cents, refund_requested_at, refunded_at, completed_at, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ${refundTs}, ${refundedTs}, now() - interval '3 days', now() - interval '3 days') RETURNING id`,
      [eventId, buyer, orderStatus, count, sub, svc, per, plat, sub - plat, total, refunded, o.reason ?? null, pendingAmt],
    ))[0].id as string;
    const iid = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'issued', now() + interval '1 day') RETURNING id`,
      [oid, eventId, typeId, buyer, count, price],
    ))[0].id as string;
    const ids: string[] = [];
    const ticketStatus = o.ticket ?? "valid";
    for (let i = 1; i <= count; i++) {
      const checked = (o.checkedIn ?? 0) >= i;
      const [t] = await q(
        `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents,
           service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents, checked_in_at, refunded_at, payout_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ${checked ? "now() - interval '4 days'" : "NULL"},
           ${ticketStatus === "refunded" ? "now() - interval '1 day'" : "NULL"}, $14) RETURNING id`,
        [oid, iid, eventId, typeId, buyer, i, `${P}${Math.random().toString(36).slice(2, 12)}`, ticketStatus, price,
          paid ? FEE_SVC : 0, paid ? FEE_PER : 0, paid ? FEE_HOST : 0, price - (paid ? FEE_HOST : 0), o.payoutId ?? null],
      );
      ids.push(t.id);
      (seeded[eventId] ??= { ticketIds: [], tickets: [] }).ticketIds.push(t.id);
      seeded[eventId].tickets.push({ price, status: ticketStatus === "valid" && orderStatus !== "completed" ? "other" : ticketStatus, reason: o.reason ?? null, checkedIn: checked, payout: o.payoutId ?? null });
    }
    return ids;
  };
  /** Expected money for one event, straight from the seeded per-ticket numbers. */
  const expect = (eventId: string) => {
    const ts = seeded[eventId]?.tickets ?? [];
    const valid = ts.filter((t) => t.status === "valid");
    const refunded = ts.filter((t) => t.status === "refunded");
    const sold = [...valid, ...refunded];
    const feeOf = (t: Seed) => (t.price > 0 ? 1 : 0);
    return {
      ticketsSold: sold.length, ticketsValid: valid.length, ticketsRefunded: refunded.length,
      salesCents: sold.reduce((a, t) => a + t.price, 0),
      refundedCents: refunded.reduce((a, t) => a + t.price, 0),
      hostEarnsCents: valid.reduce((a, t) => a + t.price - FEE_HOST * feeOf(t), 0),
      outsydeFeesCents: sold.filter((t) => !(t.status === "refunded" && t.reason === "event_cancelled")).reduce((a, t) => a + (FEE_SVC + FEE_PER) * feeOf(t), 0)
        + valid.reduce((a, t) => a + FEE_HOST * feeOf(t), 0),
    };
  };
  const mkPayout = async (eventId: string, o: { status: string; dest: string; acct: string | null; gross: number; deducted?: number; hold?: string | null;
    attempts?: number; lastError?: string | null; paidD?: number | null }) => (await q(
    `INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, amount_cents, status, hold_reason, attempts,
       last_error, paid_at, transfer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${o.paidD == null ? "NULL" : H(o.paidD)}, $11, now() - interval '2 days', now() - interval '1 day')
     RETURNING id`,
    [eventId, o.dest, o.acct, o.gross, o.deducted ?? 0, o.gross - (o.deducted ?? 0), o.status, o.hold ?? null, o.attempts ?? 0, o.lastError ?? null,
      o.status === "paid" ? `tr_${P}` : null],
  ))[0].id as string;

  try {
    adminId = await mkUser("adm", { email: ADMIN_EMAIL, admin: true });
    const plain = await mkUser("plain");
    const flagOnly = await mkUser("flag", { admin: true }); // is_admin but not an allowed admin email
    const hostB = await mkUser("hostb");
    const hostU = await mkUser("hostu");
    const hostO = await mkUser("hosto");
    const buyer = await mkUser("buy");
    const [biz] = await q(
      `INSERT INTO businesses (owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete)
       VALUES ($1, $2, 'Events', 'approved', 'acct_1TESTbiz4f2a', true) RETURNING id`, [hostB, `${P} Lounge`]);
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, 'acct_1TESTold9z9z', true)`, [hostO]);
    const adminTok = tok(adminId, true);

    // 1. Business host, ended 5 days ago: 3 types, 1 refunded ticket (buyer refund, fees kept), payout in review.
    const evBiz = await mkEvent({ host: hostB, type: "business", bizId: biz.id, startD: -5, title: "Biz night" });
    const tEarly = await mkType(evBiz.id, "Early", 3000, 0);
    const tGen = await mkType(evBiz.id, "General", 4000, 1);
    const tVip = await mkType(evBiz.id, "VIP", 6000, 2);
    const payBiz = await mkPayout(evBiz.id, { status: "review", dest: "business", acct: "acct_1TESTbiz4f2a", gross: 2 * 2923 + 2 * 3923 + 5923,
      attempts: 5, lastError: "Stripe refused the transfer: acct_1TESTbiz4f2a can't receive transfers" });
    await mkOrder(evBiz.id, tEarly, buyer, 3000, 2, { checkedIn: 2, payoutId: payBiz });
    await mkOrder(evBiz.id, tGen, buyer, 4000, 2, { payoutId: payBiz });
    await mkOrder(evBiz.id, tGen, buyer, 4000, 1, { order: "refunded", ticket: "refunded", reason: "buyer", refundedCents: 4000 });
    await mkOrder(evBiz.id, tVip, buyer, 6000, 1, { payoutId: payBiz });
    await q(`INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, metadata) VALUES ($1, 'admin', 'event_payout_note_test', 'event_payout', $2, '{}'::jsonb)`, [adminId, payBiz]);

    // 2. User host without a payout account, ended 5 days ago: payout held (no_account). 55 audit rows (activity cap).
    const evUser = await mkEvent({ host: hostU, startD: -5, title: "User party" });
    const tU = await mkType(evUser.id, "General", 2000);
    const payUser = await mkPayout(evUser.id, { status: "held", dest: "user", acct: null, gross: 3 * 1923, hold: "no_account" });
    await mkOrder(evUser.id, tU, buyer, 2000, 3, { payoutId: payUser });
    await q(`INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, created_at)
             SELECT $1, 'admin', 'event_payout_note_test', 'event_payout', $2, now() - (g || ' seconds')::interval FROM generate_series(1, 55) g`, [adminId, payUser]);

    // 3. Free event: 4 RSVPs and 1 cancelled RSVP. No payout.
    const evFree = await mkEvent({ host: hostU, startD: -2, title: "Free meetup" });
    const tF = await mkType(evFree.id, "RSVP", 0);
    await mkOrder(evFree.id, tF, buyer, 0, 4);
    await mkOrder(evFree.id, tF, buyer, 0, 1, { order: "cancelled", ticket: "cancelled" });

    // 4. Cancelled event: every paid ticket refunded with fees (event_cancelled), including an earlier buyer refund topped up.
    const evCan = await mkEvent({ host: hostU, status: "cancelled", cancelled: true, startD: -1, title: "Cancelled show" });
    const tC = await mkType(evCan.id, "General", 2500);
    await mkOrder(evCan.id, tC, buyer, 2500, 2, { order: "refunded", ticket: "refunded", reason: "event_cancelled", refundedCents: 2 * (2500 + FEE_SVC + FEE_PER) });
    await mkOrder(evCan.id, tC, buyer, 2500, 1, { order: "refunded", ticket: "refunded", reason: "event_cancelled", refundedCents: 2500 + FEE_SVC + FEE_PER });
    await mkOrder(evCan.id, tC, buyer, 0, 1, { order: "cancelled", ticket: "cancelled" });

    // 5. Upcoming business event, no payout row yet.
    const evUp = await mkEvent({ host: hostB, type: "business", bizId: biz.id, startD: 10, title: "Upcoming gala" });
    const tUp = await mkType(evUp.id, "General", 1500);
    await mkOrder(evUp.id, tUp, buyer, 1500, 2);

    // 6. User host with a payout account, ended 40 days ago, paid; two tickets refunded after payout: one owed 35 days, one owed 5 days.
    const evOld = await mkEvent({ host: hostO, startD: -40, title: "Old fest" });
    const tO = await mkType(evOld.id, "General", 3000);
    const payOld = await mkPayout(evOld.id, { status: "paid", dest: "user", acct: "acct_1TESTold9z9z", gross: 4 * 2923, paidD: -36 });
    await mkOrder(evOld.id, tO, buyer, 3000, 2, { payoutId: payOld });
    const [refOld] = await mkOrder(evOld.id, tO, buyer, 3000, 1, { order: "refunded", ticket: "refunded", reason: "host", refundedCents: 3000, payoutId: payOld });
    const [refNew] = await mkOrder(evOld.id, tO, buyer, 3000, 1, { order: "refunded", ticket: "refunded", reason: "host", refundedCents: 3000, payoutId: payOld });
    const [recOld] = await q(
      `INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status, last_error, created_at, updated_at)
       VALUES ($1, $2, 'acct_1TESTold9z9z', 2923, 'owed', 'Insufficient funds on acct_1TESTold9z9z', now() - interval '35 days', now() - interval '34 days') RETURNING id`,
      [refOld, payOld]);
    const [recNew] = await q(
      `INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status, created_at, updated_at)
       VALUES ($1, $2, 'acct_1TESTold9z9z', 2923, 'owed', now() - interval '5 days', now() - interval '5 days') RETURNING id`, [refNew, payOld]);

    // 7. Outside the default range (120 days ago), and a draft (never listed).
    const evOut = await mkEvent({ host: hostU, startD: -120, title: "Way back" });
    const tOut = await mkType(evOut.id, "General", 1000);
    await mkOrder(evOut.id, tOut, buyer, 1000, 1);
    const evDraft = await mkEvent({ host: hostU, status: "draft", startD: 3, title: "Draft" });

    const listPath = "/api/admin/events";
    const detailPath = `/api/admin/events/${evBiz.id}`;

    console.log("\nadmin only");
    for (const path of [listPath, detailPath]) {
      let r = await callAt(BASE, "GET", path);
      assert(r.status === 401, `${path.slice(0, 18)}… signed out: 401`, r);
      r = await callAt(BASE, "GET", path, { token: tok(plain, false) });
      assert(r.status === 403, `${path.slice(0, 18)}… signed in, not admin: 403`, r);
      r = await callAt(BASE, "GET", path, { token: tok(plain, true) });
      assert(r.status === 403, `${path.slice(0, 18)}… token says admin but the user isn't: 403`, r);
      r = await callAt(BASE, "GET", path, { token: tok(flagOnly, true) });
      assert(r.status === 403, `${path.slice(0, 18)}… admin flag without an allowed email: 403`, r);
      r = await callAt(BASE, "GET", path, { token: adminTok });
      assert(r.status === 200 && r.body?.success === true, `${path.slice(0, 18)}… admin: 200`, r);
    }

    console.log("\nlist");
    const L = await callAt(BASE, "GET", listPath, { token: adminTok });
    const events: any[] = L.body.events;
    const byId = (id: string) => events.find((e) => e.id === id);
    assert(L.body.range?.default === true && L.body.range.from === null && L.body.range.to === null, "default range reported", L.body.range);
    for (const [label, ev] of [["business", evBiz], ["user", evUser], ["free", evFree], ["cancelled", evCan], ["upcoming", evUp], ["old", evOld]] as const) {
      const row = byId(ev.id);
      const want = expect(ev.id);
      const got = row && { ticketsSold: row.ticketsSold, ticketsValid: row.ticketsValid, ticketsRefunded: row.ticketsRefunded, salesCents: row.salesCents,
        refundedCents: row.refundedCents, hostEarnsCents: row.hostEarnsCents, outsydeFeesCents: row.outsydeFeesCents };
      assert(!!row && JSON.stringify(got) === JSON.stringify(want), `${label} event money matches the stored columns`, { got, want });
    }
    assert(!byId(evOut.id), "event older than 90 days is outside the default range");
    assert(!byId(evDraft.id), "drafts are never listed");
    const biz1 = byId(evBiz.id);
    assert(biz1.salesCents === 24000 && biz1.refundedCents === 4000 && biz1.hostEarnsCents === 2 * 2923 + 2 * 3923 + 5923,
      "business event: sales include the refunded ticket, hostEarnsCents excludes refunded tickets", biz1);
    assert(biz1.outsydeFeesCents === 6 * (FEE_SVC + FEE_PER) + 5 * FEE_HOST, "business event: buyer fees kept on the buyer refund, host fee on valid tickets only", biz1);
    assert(biz1.host.type === "business" && biz1.host.name === `${P} Lounge` && biz1.host.ownerUsername === `${P}hostb`.slice(0, 24)
      && biz1.host.payoutReady === true && biz1.host.payoutSetup === "ready" && biz1.host.id === biz.id, "business host identity and readiness", biz1.host);
    assert(biz1.payout?.id === payBiz && biz1.payout.status === "review" && biz1.payout.attempts === 5 && biz1.payoutStatus === "on_hold"
      && biz1.payout.amountCents === biz1.hostEarnsCents && biz1.payout.lastError.includes("acct_••••4f2a") && !biz1.payout.lastError.includes("1TEST"),
      "business payout in review, error text masked", biz1.payout);
    assert(biz1.owedToHostCents === biz1.payout.amountCents && biz1.paidToHostCents === 0, "review payout is still owed", biz1);
    const due = new Date(new Date(evBiz.ends_at).getTime() + 3 * 86400000).toISOString();
    assert(biz1.payoutDueAt === due && biz1.payout.dueAt === due && biz1.payoutExpectedAt === due, "due date is end plus 3 days", biz1);
    const u1 = byId(evUser.id);
    assert(u1.host.type === "user" && u1.host.name === "Shown hostu" && u1.host.ownerUsername === `${P}hostu`.slice(0, 24)
      && u1.host.payoutReady === false && u1.host.payoutSetup === "no_account", "user host without payout account: not ready", u1.host);
    assert(u1.payout.status === "held" && u1.payout.holdReason === "no_account" && u1.payoutStatus === "payout_setup_needed", "user payout held, setup needed", u1);
    const f1 = byId(evFree.id);
    assert(f1.ticketsSold === 4 && f1.salesCents === 0 && f1.outsydeFeesCents === 0 && f1.hostEarnsCents === 0 && f1.payout === null
      && f1.payoutStatus === "none" && f1.payoutExpectedAt === null && f1.owedToHostCents === 0, "free event: 4 RSVPs, no money, no payout", f1);
    const c1 = byId(evCan.id);
    assert(c1.status === "cancelled" && c1.ticketsSold === 3 && c1.ticketsRefunded === 3 && c1.salesCents === 7500 && c1.refundedCents === 7500
      && c1.hostEarnsCents === 0 && c1.outsydeFeesCents === 0 && c1.payout === null && c1.payoutStatus === "none" && c1.owedToHostCents === 0,
      "cancelled event: everything refunded, fees 0, nothing owed", c1);
    const up1 = byId(evUp.id);
    assert(up1.payout === null && up1.payoutStatus === "scheduled" && up1.hostEarnsCents === 2 * 1423 && up1.owedToHostCents === 2 * 1423
      && up1.payoutExpectedAt === new Date(new Date(up1.endsAt).getTime() + 3 * 86400000).toISOString(), "upcoming event without payout row: scheduled, owed = host earns", up1);
    const o1 = byId(evOld.id);
    assert(o1.payout.status === "paid" && o1.paidToHostCents === 4 * 2923 && o1.owedToHostCents === 0 && o1.payoutStatus === "paid"
      && o1.recoveriesOwed.count === 2 && o1.recoveriesOwed.amountCents === 2 * 2923 && o1.host.payoutReady === true, "old paid event with owed recoveries", o1);
    assert(o1.hostEarnsCents === 2 * 2923 && o1.outsydeFeesCents === 4 * (FEE_SVC + FEE_PER) + 2 * FEE_HOST, "old event: host refunds keep buyer fees, host fee only on valid", o1);

    const keys = ["events", "ticketsSold", "ticketsValid", "ticketsRefunded", "salesCents", "refundedCents", "hostEarnsCents", "outsydeFeesCents", "owedToHostCents", "paidToHostCents"];
    const sums: Record<string, number> = { events: events.length };
    for (const k of keys.slice(1)) sums[k] = events.reduce((a, e) => a + e[k], 0);
    assert(keys.every((k) => L.body.totals[k] === sums[k]), "totals equal the sum of the rows", { totals: L.body.totals, sums });
    assert(events.every((e, i) => i === 0 || events[i - 1].startsAt >= e.startsAt), "rows newest first by start");

    console.log("\nattention");
    const ours = new Set(eventIds);
    const att: any[] = (L.body.attention as any[]).filter((a) => ours.has(a.eventId));
    assert(att.length === 3, "attention has exactly the 3 seeded items", att);
    const [aR, aH, aO] = att;
    assert(aR?.kind === "payout_review" && aR.payoutId === payBiz && aR.eventId === evBiz.id && aR.amountCents === biz1.payout.amountCents
      && aR.host.name === `${P} Lounge` && aR.reason.includes("acct_••••4f2a") && aR.eventTitle === `${P} Biz night`, "review payout item", aR);
    assert(aH?.kind === "payout_held" && aH.payoutId === payUser && aH.reason === "no_account" && aH.host.ownerUsername === `${P}hostu`.slice(0, 24), "held payout item", aH);
    assert(aO?.kind === "recovery_owed" && aO.recoveryId === recOld.id && aO.payoutId === payOld && aO.amountCents === 2923 && aO.eventId === evOld.id
      && aO.reason.includes("acct_••••9z9z") && !aO.reason.includes("1TEST"), "owed over 30 days item (the 5 day one is left out)", aO);
    assert(!att.some((a) => a.recoveryId === recNew.id), "recovery owed 5 days is not in attention");
    console.log(`  (attention total in DB: ${L.body.attention.length})`);

    console.log("\nrange");
    const day = 86400000;
    let r = await callAt(BASE, "GET", `${listPath}?from=${new Date(Date.now() - 130 * day).toISOString()}&to=${new Date(Date.now() - 100 * day).toISOString()}`, { token: adminTok });
    const inRange = (r.body.events as any[]).filter((e) => ours.has(e.id)).map((e) => e.id);
    assert(r.status === 200 && inRange.length === 1 && inRange[0] === evOut.id && r.body.range.default === false, "from/to selects only the old event", { status: r.status, inRange });
    assert((r.body.attention as any[]).filter((a) => ours.has(a.eventId)).length === 3, "attention is platform wide (not limited by range)");
    r = await callAt(BASE, "GET", `${listPath}?from=${new Date(Date.now() + 5 * day).toISOString().slice(0, 10)}`, { token: adminTok });
    const fromOnly = (r.body.events as any[]).filter((e) => ours.has(e.id)).map((e) => e.id);
    assert(r.status === 200 && fromOnly.length === 1 && fromOnly[0] === evUp.id, "date-only from works", fromOnly);
    for (const bad of ["?from=yesterday", "?to=2026-13-40", `?from=2026-10-10&to=2026-10-01`, "?from=2026-10-01T10:00:00", "?from[]=2026-10-01"]) {
      r = await callAt(BASE, "GET", `${listPath}${bad}`, { token: adminTok });
      assert(r.status === 400 && r.body.error.code === "BAD_RANGE", `bad range ${bad}: 400`, r);
    }

    console.log("\ndetail");
    const D = await callAt(BASE, "GET", detailPath, { token: adminTok });
    const d = D.body;
    assert(D.status === 200 && d.event.id === evBiz.id && d.event.salesCents === biz1.salesCents && d.event.hostEarnsCents === biz1.hostEarnsCents
      && d.event.outsydeFeesCents === biz1.outsydeFeesCents && typeof d.event.publishedAt === "string" && typeof d.event.createdAt === "string", "event matches the list row", d.event);
    const tt: any[] = d.ticketTypes;
    assert(tt.map((t) => t.name).join(",") === "Early,General,VIP", "ticket types in sort order", tt);
    const g = tt.find((t) => t.name === "General");
    assert(g.priceCents === 4000 && g.sold === 3 && g.salesCents === 12000 && g.refundedCents === 4000 && g.hostEarnsCents === 2 * 3923, "General: 3 sold, 1 refunded", g);
    for (const k of ["salesCents", "refundedCents", "hostEarnsCents", "outsydeFeesCents"]) {
      assert(tt.reduce((a, t) => a + t[k], 0) === d.event[k], `ticket types add up to the event ${k}`);
    }
    assert(JSON.stringify(d.orders) === JSON.stringify({ completed: 3, refunded: 1, refunding: 0, flagged: 0 }), "order counts", d.orders);
    assert(d.checkIns.checkedIn === 2 && d.checkIns.validTickets === 5, "check ins", d.checkIns);
    assert(d.payout.connectedAccount === "acct_••••4f2a" && d.payout.destinationType === "business" && d.payout.grossCents === biz1.payout.amountCents
      && d.payout.deductedCents === 0 && d.payout.attempts === 5 && "nextAttemptAt" in d.payout && "createdAt" in d.payout, "payout card with masked account", d.payout);
    assert(d.host.connectedAccount === "acct_••••4f2a" && d.host.payoutReady === true && d.host.ownerUsername === biz1.host.ownerUsername, "host card masked, ready", d.host);
    assert(!D.raw.includes("acct_1TEST"), "account id never appears in full");
    assert(Array.isArray(d.recoveries) && d.recoveries.length === 0, "no recoveries on the business event");
    const kinds = (d.activity as any[]).map((a) => a.kind);
    for (const k of ["event_created", "event_published", "event_ended", "order_refund_requested", "order_refunded", "payout_created", "payout_review", "admin_action"]) {
      assert(kinds.includes(k), `activity has ${k}`, kinds);
    }
    const adminRow = (d.activity as any[]).find((a) => a.kind === "admin_action");
    assert(adminRow?.actorUsername === `${P}adm` && adminRow.refId === payBiz, "admin action shows the admin's @username", adminRow);
    assert((d.activity as any[]).every((a, i, xs) => i === 0 || xs[i - 1].at >= a.at), "activity newest first");
    assert(!(d.activity as any[]).some((a) => /[‒–—―]| - /.test(a.text)), "activity text has no dashes", d.activity.map((a: any) => a.text));

    const DU = await callAt(BASE, "GET", `/api/admin/events/${evUser.id}`, { token: adminTok });
    assert(DU.status === 200 && DU.body.host.payoutReady === false && DU.body.host.payoutSetup === "no_account" && DU.body.host.connectedAccount === null
      && DU.body.host.payoutReady === u1.host.payoutReady, "detail readiness (hostPayoutDestination) agrees with the list", DU.body.host);
    assert(DU.body.activity.length === 50 && DU.body.activity.every((a: any, i: number, xs: any[]) => i === 0 || xs[i - 1].at >= a.at), "activity capped at 50, newest first", DU.body.activity.length);
    assert(DU.body.payout.connectedAccount === null && DU.body.payout.holdReason === "no_account", "held payout without account", DU.body.payout);

    const DO = await callAt(BASE, "GET", `/api/admin/events/${evOld.id}`, { token: adminTok });
    const recs: any[] = DO.body.recoveries;
    assert(DO.status === 200 && recs.length === 2 && recs.every((x) => x.connectedAccount === "acct_••••9z9z" && x.status === "owed"), "recoveries listed, masked", recs);
    assert(recs.find((x) => x.id === recOld.id)?.owedOver30Days === true && recs.find((x) => x.id === recNew.id)?.owedOver30Days === false, "owed over 30 days flag", recs);
    assert(DO.body.host.connectedAccount === "acct_••••9z9z" && DO.body.payout.transferId === `tr_${P}` && typeof DO.body.payout.paidAt === "string", "paid payout card", DO.body.payout);
    assert(!DO.raw.includes("acct_1TEST"), "old event: account id never in full");

    const DC = await callAt(BASE, "GET", `/api/admin/events/${evCan.id}`, { token: adminTok });
    assert(DC.status === 200 && DC.body.payout === null && (DC.body.activity as any[]).some((a) => a.kind === "event_cancelled")
      && !(DC.body.activity as any[]).some((a) => a.kind === "event_ended"), "cancelled event: no payout, cancelled in activity", DC.body.activity);
    const DD = await callAt(BASE, "GET", `/api/admin/events/${evDraft.id}`, { token: adminTok });
    assert(DD.status === 200 && DD.body.event.status === "draft", "detail still opens a draft by id");

    r = await callAt(BASE, "GET", `/api/admin/events/nope-${P}`, { token: adminTok });
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "unknown id: 404", r);
    r = await callAt(BASE, "GET", `/api/admin/events/${"x".repeat(80)}`, { token: adminTok });
    assert(r.status === 404, "oversized id: 404", r);

    console.log("\nprivacy");
    const everything = [L, D, DU, DO, DC, DD];
    const keysFound = everything.flatMap((x) => allKeys(x.body));
    assert(!keysFound.some((k) => /email/i.test(k)), "no key containing \"email\" anywhere", keysFound.filter((k) => /email/i.test(k)));
    const raw = everything.map((x) => x.raw).join("\n");
    assert(!raw.includes("@test.local") && !raw.includes(ADMIN_EMAIL), "no email address anywhere");
    assert(!raw.includes("Realfirst"), "no real first name anywhere");
    assert(!raw.includes("acct_1TEST"), "no full Stripe account id anywhere");

    console.log("\nother admin routes still resolve");
    r = await callAt(BASE, "GET", "/api/admin/emails/budget", { token: adminTok });
    assert(r.status === 200 && r.body.success === true, "/api/admin/emails/budget still 200", r.status);
  } finally {
    if (eventIds.length) {
      const payIds = (await q(`SELECT id FROM event_payouts WHERE event_id = ANY($1)`, [eventIds])).map((x) => x.id);
      if (payIds.length) {
        await q(`DELETE FROM audit_logs WHERE target_id = ANY($1)`, [payIds]);
        await q(`DELETE FROM event_payout_recoveries WHERE payout_id = ANY($1)`, [payIds]);
      }
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM event_payouts WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    }
    await q(`DELETE FROM businesses WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM user_payout_accounts WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    if (adminId) {
      await q(`DELETE FROM audit_logs WHERE actor_id = $1`, [adminId]);
      await q(`DELETE FROM users WHERE id = $1 AND email = $2`, [adminId, ADMIN_EMAIL]);
    }
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    const left = await q(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [ADMIN_EMAIL]);
    console.log(`\ncleanup: ${ADMIN_EMAIL} rows left = ${left[0].n}`);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
