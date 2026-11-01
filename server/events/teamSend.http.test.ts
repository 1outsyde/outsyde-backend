/**
 * p4-team step 4b-2: sending team pay (Legend 2026-10-30, calls 20 to 23).
 *
 *   20 Sending is behind TEAM_PAYOUTS_ENABLED (pause only): off = worked out and held on Stripe, nothing sent, never
 *      given to the host.
 *   21 Taking someone off: a reason (late, no show, unprofessional conduct, other + note) the person is shown; once
 *      the event is over its team is locked. Old clients that send no reason keep working for people with no pay.
 *   22 Payout setup isn't needed to accept a spot. Paid members without it: a push on accept and once a day, emails the
 *      day of the event and the day after, until setup or the deadline (when the payout is worked out). Not set up by
 *      then: their share goes to the host ('no_setup') and they get one last message.
 *   23 I paid them / Got it / Not yet, undo until Got it, a Not yet open after 3 days goes to the admin.
 *
 * Run in process: EV_TEST_PG_URL=<local> DATABASE_URL=<local> STRIPE_STUB_PORT=<free port>
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" npx tsx server/events/teamSend.http.test.ts
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
const DASH = /[–—]| - /;

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
  delete process.env.TEAM_PAYOUTS_ENABLED;
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  // Real Stripe must never be reached: every send below gets the fake. Any call to the stub fails the run.
  const stripeCalls: string[] = [];
  const stub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      stripeCalls.push(`${req.method} ${req.url}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "api_error", message: "stub: tests pass a fake Stripe" } }));
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  /** Fake Stripe for team sends: accounts ready unless told, transfers kept per group. */
  const fake = {
    notReady: new Set<string>(),
    transfers: [] as Array<{ id: string; group: string; amount: number; destination: string; metadata: any; key: string }>,
    mode: "ok" as "ok" | "error" | "insufficient",
    creates: 0,
    gate: null as null | Promise<void>,
  };
  const fakeStripe: any = {
    getPayoutReadiness: async (acct: string) => {
      const ready = !fake.notReady.has(acct);
      return { ready, chargesEnabled: ready, payoutsEnabled: ready, detailsSubmitted: true };
    },
    findEventTeamPayoutTransfer: async (teamPayoutId: string) => {
      const t = fake.transfers.find((x) => x.group === `event_team_${teamPayoutId}`);
      return t ? { id: t.id, amount: t.amount } : null;
    },
    createEventTeamPayoutTransfer: async (p: any) => {
      fake.creates++;
      if (fake.gate) await fake.gate;
      if (fake.mode === "error") throw new Error("stub: Stripe is down");
      if (fake.mode === "insufficient") { const e: any = new Error("Insufficient funds in Stripe account"); e.code = "balance_insufficient"; throw e; }
      const id = `tr_team_${fake.transfers.length + 1}`;
      fake.transfers.push({ id, group: `event_team_${p.teamPayoutId}`, amount: p.amountCents, destination: p.destination, metadata: { type: "event_team_payout", eventId: p.eventId, teamPayoutId: p.teamPayoutId }, key: p.idempotencyKey });
      return { id };
    },
    isInsufficientFundsError: (err: any) => err?.code === "balance_insufficient",
    // The host payout step in runEventPayoutJob uses these; hosts in this file have ready accounts.
    findEventPayoutTransfer: async () => null,
    createEventPayoutTransfer: async () => ({ id: `tr_host_${Date.now()}` }),
    findEventPayoutReversal: async () => null,
    reverseEventPayoutTransfer: async () => ({ id: "trr_x" }),
  };

  const express = (await import("express")).default;
  const notices = await import("./ticketNotices");
  const pushes: any[] = [];
  const activity: any[] = [];
  const setupEmails: any[] = [];
  notices.setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; },
    createActivity: async (p: any) => { activity.push(p); },
    sendDoorInvite: async () => {}, sendOwedReminder: async () => {},
    sendTeamSetupReminder: async (p: any) => { setupEmails.push(p); },
  } as any);
  const { setAdminAlertForTest } = await import("./ticketCheckout");
  const adminEmails: Array<{ subject: string; detail: string }> = [];
  setAdminAlertForTest(async (subject: string, detail: string) => { adminEmails.push({ subject, detail }); });
  const payouts = await import("./eventPayouts");
  const send = await import("./teamSend");
  const { computeHeld } = await import("../bankPayout");
  const { listTeamAttention } = await import("./adminEventsQueries");
  const app = express();
  app.use(express.json());
  app.use("/api/events", (await import("./doorRouter")).default);
  app.use("/api/events", (await import("./eventsRouter")).default);
  app.use("/api/events", (await import("./ticketRefunds")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `tz${Date.now().toString(36)}`;
  const allEvents: string[] = [];
  const allUsers: string[] = [];
  const user = async (s: string) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, username],
    ))[0].id as string;
    allUsers.push(id);
    // Step 9d: everyone in this file accepted the Event Team note, so "ready" here means payout setup, as before. teamNote.http.test.ts covers a missing note.
    await q(`INSERT INTO event_team_note_acceptances (user_id, version) VALUES ($1, '2026-11-01') ON CONFLICT DO NOTHING`, [id]);
    return { id, username };
  };
  /** A payout account that has finished setup (the member, or a host so its own payout can go). */
  const ready = async (u: { id: string }, done = true) => {
    const acct = `acct_${P}_${u.id.slice(0, 8)}`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET onboarding_complete = EXCLUDED.onboarding_complete`, [u.id, acct, done]);
    return acct;
  };
  const FEE_HOST = 40; // 2% of $20
  /** Ended `ended` ago (default 4 days: due), or in the future with `startsIn`. */
  const event = async (host: { id: string }, slug: string, o: { ended?: string; startsIn?: string; status?: string; tz?: string } = {}) => {
    const when = o.startsIn
      ? `now() + $5::interval, now() + $5::interval + interval '5 hours'`
      : `now() - ($5::interval + interval '5 hours'), now() - $5::interval`;
    const e = (await q(
      `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at)
       VALUES ($1, $2, $3, $4, ${when}, $6, now() - interval '20 days')
       RETURNING id, slug, title, starts_at, ends_at`,
      [host.id, `${P}-${slug}`, `${P} ${slug}`, o.status ?? "published", o.startsIn ?? o.ended ?? "4 days", o.tz ?? "America/New_York"],
    ))[0] as { id: string; slug: string; title: string; starts_at: Date; ends_at: Date };
    allEvents.push(e.id);
    return e;
  };
  const mkType = async (eventId: string) => (await q(
    `INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'GA', 2000, 500, 1, 50) RETURNING id`, [eventId],
  ))[0].id as string;
  const buyer = await user("buyer");
  /** One completed order of `count` $20 tickets (host gets $19.60 each). */
  const sell = async (eventId: string, count: number) => {
    const typeId = await mkType(eventId);
    const sub = 2000 * count, plat = FEE_HOST * count;
    const oid = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents,
         host_net_cents, total_cents, completed_at, paid_at)
       VALUES ($1, $2, 'completed', $3, $4, 0, 0, $5, $6, $4, now() - interval '6 days', now() - interval '6 days') RETURNING id`,
      [eventId, buyer.id, count, sub, plat, sub - plat],
    ))[0].id as string;
    const iid = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 2000, 'issued', now() + interval '1 day') RETURNING id`, [oid, eventId, typeId, buyer.id, count],
    ))[0].id as string;
    for (let i = 1; i <= count; i++) {
      await q(
        `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents,
           service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid', 2000, 0, 0, $8, $9)`,
        [oid, iid, eventId, typeId, buyer.id, i, `${P}${Math.random().toString(36).slice(2, 12)}`, FEE_HOST, 2000 - FEE_HOST]);
    }
  };
  const addMember = async (eventId: string, host: { id: string }, u: { id: string }, role: string, o: { accepted?: boolean } = {}) =>
    (await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, invited_at, accepted_at)
       VALUES ($1, $2, $3, $4, now() - interval '12 days', ${o.accepted === false ? "NULL" : "now() - interval '10 days'"}) RETURNING id`,
      [eventId, u.id, host.id, role]))[0].id as string;
  const addStanding = async (host: { id: string }, u: { id: string }, role: string) =>
    q(`INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id, role, invited_at, accepted_at)
       VALUES ($1, $2, $1, $3, now() - interval '12 days', now() - interval '10 days')`, [host.id, u.id, role]);
  const setPay = (eventId: string, u: { id: string }, role: string, host: { id: string }, fixed: number) =>
    q(`INSERT INTO event_team_pay (event_id, member_user_id, role, pay_type, fixed_cents, updated_by_user_id)
       VALUES ($1, $2, $3, 'fixed', $4, $5)`, [eventId, u.id, role, fixed, host.id]);
  const payoutOf = async (eventId: string) => (await q(`SELECT * FROM event_payouts WHERE event_id = $1`, [eventId]))[0];
  const teamOf = async (eventId: string) => q(`SELECT * FROM event_team_payouts WHERE event_id = $1 ORDER BY amount_cents DESC`, [eventId]);
  const rowOf = async (eventId: string, userId: string) => (await q(`SELECT * FROM event_team_payouts WHERE event_id = $1 AND member_user_id = $2`, [eventId, userId]))[0];
  const runCreate = async () => { for (let i = 0; i < 5; i++) await payouts.createDuePayouts(); };
  /** Makes a row due again now (as if its next try time came). */
  const due = (id: string) => q(`UPDATE event_team_payouts SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
  const pushesTo = (userId: string) => pushes.filter((p) => p.userId === userId);

  try {
    // ════════════════════ 22: payout setup deadline when the payout is worked out ════════════════════
    console.log("\nworked out: a member without payout setup by then goes to the host (call 22)");
    const h1 = await user("h1"); await ready(h1);
    const a1 = await user("a1"); const acctA1 = await ready(a1);
    const b1 = await user("b1"); // no payout account
    const c1 = await user("c1"); await ready(c1, false); // started setup, not finished
    const e1 = await event(h1, "deadline");
    await sell(e1.id, 10); // $196 for the host
    for (const u of [a1, b1, c1]) await addMember(e1.id, h1, u, "security");
    await setPay(e1.id, a1, "security", h1, 5000);
    await setPay(e1.id, b1, "security", h1, 3000);
    await setPay(e1.id, c1, "security", h1, 2000);
    await runCreate();
    let p1 = await payoutOf(e1.id);
    assert(p1 && Number(p1.gross_cents) === 19600 && Number(p1.team_cents) === 5000 && Number(p1.amount_cents) === 14600,
      "only the member with setup is taken from the payout ($50); the $50 of the other two stays with the host ($146)", p1);
    const ra1 = await rowOf(e1.id, a1.id), rb1 = await rowOf(e1.id, b1.id), rc1 = await rowOf(e1.id, c1.id);
    assert(ra1?.outcome === "covered" && ra1?.status === "pending", "set up: covered, waiting to be sent", ra1);
    assert(rb1?.outcome === "no_setup" && rb1?.status === "host_to_pay" && rc1?.outcome === "no_setup" && rc1?.status === "host_to_pay",
      "no account or setup not finished: no_setup, the host pays them", { rb1, rc1 });
    assert(rb1?.payout_id === p1.id, "no_setup rows still point at the payout");
    let sm = await call("GET", `/api/events/${e1.id}/summary`, { token: tok(h1.id) });
    const smB = sm.body?.teamPay?.members?.find((m: any) => m.userId === b1.id);
    const smA = sm.body?.teamPay?.members?.find((m: any) => m.userId === a1.id);
    assert(sm.status === 200 && sm.body?.teamPay?.covered === true && sm.body?.teamPay?.teamPaidCents === 5000 && sm.body?.teamPay?.hostTakeHomeCents === 14600,
      "host summary: still covered (the host must not think nobody is paid by Outsyde)", sm.body?.teamPay);
    assert(smA?.paidBy === "outsyde" && smB?.paidBy === "host" && smB?.outcome === "no_setup", "summary says who pays each person", sm.body?.teamPay?.members);
    const heldNow = (await computeHeld()).breakdown.teamPayoutsOpen;
    const hn = await user("hn"); await ready(hn);
    const nn = await user("nn");
    const en = await event(hn, "noheld");
    await sell(en.id, 10);
    await addMember(en.id, hn, nn, "security"); await setPay(en.id, nn, "security", hn, 7000);
    await runCreate();
    assert((await rowOf(en.id, nn.id))?.outcome === "no_setup" && (await computeHeld()).breakdown.teamPayoutsOpen === heldNow,
      "no_setup pay is not held back from the bank payout (it is in the host's payout)", { heldNow });

    console.log("\nthe one last message to members whose share went to the host");
    pushes.length = 0; activity.length = 0;
    const told = await send.notifyNoSetupMembers();
    pushes.splice(0, pushes.length, ...pushes.filter((x) => x.userId !== nn.id));
    const bPush = pushesTo(b1.id);
    assert(told >= 2 && bPush.length === 1 && pushesTo(c1.id).length === 1 && pushesTo(a1.id).length === 0, "one push each to the two members, none to the one set up", { told, pushes });
    assert(/\$30\.00/.test(bPush[0]?.body ?? "") && bPush[0]?.body.includes(e1.title) && /host/i.test(bPush[0]?.body ?? "") && !DASH.test(bPush[0]?.body ?? ""),
      "it names the amount, the event and that the host pays them (no dashes)", bPush[0]);
    assert(activity.some((x) => x.userId === b1.id && x.type === "team_pay_to_host"), "and an Activity item", activity);
    pushes.length = 0;
    await send.notifyNoSetupMembers();
    assert(pushesTo(b1.id).length === 0, "said once only");
    assert(!!(await rowOf(e1.id, b1.id))?.member_notified_at, "member_notified_at recorded");

    console.log("\nnot covered stays not covered for everyone, set up or not");
    const h2 = await user("h2"); await ready(h2);
    const a2 = await user("a2"); await ready(a2);
    const e2 = await event(h2, "uncovered");
    await sell(e2.id, 1); // $19.60
    await addMember(e2.id, h2, a2, "security");
    await setPay(e2.id, a2, "security", h2, 5000);
    await runCreate();
    const r2 = await rowOf(e2.id, a2.id);
    assert(r2?.outcome === "not_covered" && r2?.status === "host_to_pay" && Number((await payoutOf(e2.id))?.team_cents) === 0, "uncovered: not_covered, nothing taken", r2);

    console.log("\nall or nothing is judged on everyone's pay, set up or not");
    const h3 = await user("h3"); await ready(h3);
    const a3 = await user("a3"); await ready(a3);
    const b3 = await user("b3");
    const e3 = await event(h3, "allornothing");
    await sell(e3.id, 5); // $98
    await addMember(e3.id, h3, a3, "security"); await addMember(e3.id, h3, b3, "door");
    await setPay(e3.id, a3, "security", h3, 5000); await setPay(e3.id, b3, "door", h3, 6000); // $110 > $98
    await runCreate();
    assert((await teamOf(e3.id)).every((r: any) => r.outcome === "not_covered"), "team owed more than the event made: nobody covered, even the one set up", await teamOf(e3.id));

    console.log("\nan approved business with finished setup counts as set up");
    const h4 = await user("h4"); await ready(h4);
    const a4 = await user("a4");
    await q(`INSERT INTO businesses (id, owner_id, name, category, stripe_account_id, stripe_onboarding_complete, approval_status)
             VALUES (gen_random_uuid(), $1, $2, 'other', $3, true, 'approved')`, [a4.id, `${P} biz`, `acct_${P}_biz`]);
    const e4 = await event(h4, "bizdest");
    await sell(e4.id, 10);
    await addMember(e4.id, h4, a4, "entertainment");
    await setPay(e4.id, a4, "entertainment", h4, 4000);
    await runCreate();
    const hasBiz = (await q(`SELECT 1 FROM businesses WHERE owner_id = $1`, [a4.id])).length > 0;
    assert(hasBiz && (await rowOf(e4.id, a4.id))?.outcome === "covered", "business account ready: covered", await rowOf(e4.id, a4.id));

    // ════════════════════ 20: the send switch ════════════════════
    console.log("\nswitch off (TEAM_PAYOUTS_ENABLED unset): nothing sent, money stays held");
    fake.transfers.length = 0; fake.creates = 0;
    const heldBefore = (await computeHeld()).breakdown.teamPayoutsOpen;
    const off = await send.runTeamPayoutSends(fakeStripe);
    assert(off.sent === 0 && fake.creates === 0 && (await rowOf(e1.id, a1.id)).status === "pending", "no transfer, the row waits", { off, creates: fake.creates });
    assert((await computeHeld()).breakdown.teamPayoutsOpen === heldBefore && heldBefore >= 5000, "the bank payout keeps it on Stripe", heldBefore);
    process.env.TEAM_PAYOUTS_ENABLED = "false";
    assert((await send.runTeamPayoutSends(fakeStripe)).sent === 0 && fake.creates === 0, "\"false\" is off too");
    process.env.TEAM_PAYOUTS_ENABLED = "true";

    // ════════════════════ sending ════════════════════
    console.log("\nswitch on: sent to the member's own account");
    pushes.length = 0; activity.length = 0;
    let res = await send.sendTeamPayout(ra1.id, fakeStripe);
    let row = await rowOf(e1.id, a1.id);
    const tr = fake.transfers[0];
    assert(res === "paid" && row.status === "paid" && row.transfer_id === tr?.id && !!row.paid_at && row.connected_account_id === acctA1 && row.destination_type === "user",
      "paid, transfer saved, destination recorded", { res, row });
    assert(tr?.amount === 5000 && tr?.destination === acctA1 && tr?.group === `event_team_${ra1.id}` && tr?.metadata?.type === "event_team_payout" && tr?.metadata?.eventId === e1.id,
      "one $50 transfer to the member, its own transfer group, tagged", tr);
    assert(/^event_team_payout_/.test(tr?.key ?? ""), "idempotency key per claim", tr?.key);
    const paidPush = pushesTo(a1.id)[0];
    assert(!!paidPush && /\$50\.00/.test(paidPush.body) && paidPush.body.includes(e1.title) && !DASH.test(paidPush.body) && paidPush.data?.type === "team_pay_sent",
      "the member gets a push: amount and event", paidPush);
    assert(activity.some((x) => x.userId === a1.id && x.type === "team_pay_sent"), "and an Activity item");
    res = await send.sendTeamPayout(ra1.id, fakeStripe);
    assert(res === "not_due" && fake.transfers.length === 1, "never sent twice", res);

    console.log("\nhost_to_pay rows are never sent");
    await due(rb1.id);
    res = await send.sendTeamPayout(rb1.id, fakeStripe);
    assert(res === "not_due" && fake.transfers.length === 1, "no_setup row: nothing sent", res);

    // A fresh covered event for the send cases.
    const hs = await user("hs"); await ready(hs);
    const mkCovered = async (slug: string, members: Array<{ id: string }>, each = 2000) => {
      const e = await event(hs, slug);
      await sell(e.id, 10);
      for (const m of members) { await addMember(e.id, hs, m, "security"); await setPay(e.id, m, "security", hs, each); }
      await runCreate();
      return e;
    };

    console.log("\na transfer already in Stripe (sent, not saved) is recorded, not sent again");
    const m5 = await user("m5"); await ready(m5);
    const e5 = await mkCovered("found", [m5]);
    const r5 = await rowOf(e5.id, m5.id);
    fake.transfers.push({ id: "tr_found_5", group: `event_team_${r5.id}`, amount: 2000, destination: "x", metadata: {}, key: "old" });
    fake.creates = 0;
    res = await send.sendTeamPayout(r5.id, fakeStripe);
    assert(res === "paid" && (await rowOf(e5.id, m5.id)).transfer_id === "tr_found_5" && fake.creates === 0, "recorded as paid with the found transfer", res);

    console.log("\na found transfer for another amount goes to review");
    const m6 = await user("m6"); await ready(m6);
    const e6 = await mkCovered("mismatch", [m6]);
    const r6 = await rowOf(e6.id, m6.id);
    fake.transfers.push({ id: "tr_wrong_6", group: `event_team_${r6.id}`, amount: 1999, destination: "x", metadata: {}, key: "old" });
    adminEmails.length = 0;
    res = await send.sendTeamPayout(r6.id, fakeStripe);
    assert(res === "review" && (await rowOf(e6.id, m6.id)).status === "review" && adminEmails.length === 1 && adminEmails[0].detail.includes(r6.id), "review + one admin email", { res, adminEmails });

    console.log("\npaused event: held, sent once it is released");
    const m7 = await user("m7"); await ready(m7);
    const e7 = await mkCovered("paused", [m7]);
    const r7 = await rowOf(e7.id, m7.id);
    await q(`UPDATE events SET status = 'paused' WHERE id = $1`, [e7.id]);
    res = await send.sendTeamPayout(r7.id, fakeStripe);
    let x7 = await rowOf(e7.id, m7.id);
    assert(res === "held" && x7.status === "held" && x7.hold_reason === "event_paused" && Number(x7.attempts) === 0, "held, not counted as a try", x7);
    await q(`UPDATE events SET status = 'published' WHERE id = $1`, [e7.id]);
    await due(r7.id);
    res = await send.sendTeamPayout(r7.id, fakeStripe);
    x7 = await rowOf(e7.id, m7.id);
    assert(res === "paid" && x7.status === "paid" && x7.hold_reason === null, "released: sent", x7);

    console.log("\nStripe says the member's account can't take payouts: held, admin told once");
    const m8 = await user("m8"); const acct8 = await ready(m8);
    const e8 = await mkCovered("notready", [m8]);
    const r8 = await rowOf(e8.id, m8.id);
    fake.notReady.add(acct8);
    adminEmails.length = 0;
    res = await send.sendTeamPayout(r8.id, fakeStripe);
    assert(res === "held" && (await rowOf(e8.id, m8.id)).hold_reason === "stripe_not_ready" && adminEmails.length === 1, "held + one admin email", { res, adminEmails });
    const heldPush = pushesTo(m8.id).filter((x) => x.data?.type === "team_pay_held");
    assert(heldPush.length === 1 && /\$20\.00/.test(heldPush[0].body) && !DASH.test(heldPush[0].body), "the member is told to finish payout setup", pushesTo(m8.id));
    await due(r8.id);
    res = await send.sendTeamPayout(r8.id, fakeStripe);
    assert(res === "held" && adminEmails.length === 1 && pushesTo(m8.id).filter((x) => x.data?.type === "team_pay_held").length === 1,
      "same hold again: no second email or push", adminEmails.length);
    fake.notReady.delete(acct8);
    await due(r8.id);
    assert((await send.sendTeamPayout(r8.id, fakeStripe)) === "paid", "ready again: sent");

    console.log("\nmember's setup undone after the deadline (account gone): held, never given to the host");
    const m9 = await user("m9"); await ready(m9);
    const e9 = await mkCovered("acctgone", [m9]);
    const r9 = await rowOf(e9.id, m9.id);
    await q(`DELETE FROM user_payout_accounts WHERE user_id = $1`, [m9.id]);
    res = await send.sendTeamPayout(r9.id, fakeStripe);
    const x9 = await rowOf(e9.id, m9.id);
    assert(res === "held" && x9.status === "held" && x9.hold_reason === "no_account" && x9.outcome === "covered", "held for the member", x9);

    console.log("\nnot enough platform balance: waits, not a try, the bank payout waits too");
    const m10 = await user("m10"); await ready(m10);
    const e10 = await mkCovered("balance", [m10]);
    const r10 = await rowOf(e10.id, m10.id);
    fake.mode = "insufficient"; adminEmails.length = 0;
    res = await send.sendTeamPayout(r10.id, fakeStripe);
    let x10 = await rowOf(e10.id, m10.id);
    assert(res === "insufficient" && x10.status === "pending" && Number(x10.attempts) === 0 && /insufficient/i.test(x10.last_error ?? ""), "pending, attempts 0", x10);
    assert(adminEmails.length === 1, "one admin email", adminEmails);
    assert((await computeHeld()).gates.teamPayoutsWaitingBalance >= 1, "bank payout gate: team pay waiting for balance", (await computeHeld()).gates);
    await due(r10.id);
    await send.sendTeamPayout(r10.id, fakeStripe);
    assert(adminEmails.length === 1, "again within 24 hours: no second email");
    fake.mode = "ok";
    await due(r10.id);
    assert((await send.sendTeamPayout(r10.id, fakeStripe)) === "paid", "balance back: sent");

    console.log("\nother errors: backoff, review after 5 tries");
    const m11 = await user("m11"); await ready(m11);
    const e11 = await mkCovered("errors", [m11]);
    const r11 = await rowOf(e11.id, m11.id);
    fake.mode = "error"; adminEmails.length = 0;
    const results: string[] = [];
    for (let i = 0; i < 5; i++) { await due(r11.id); results.push(await send.sendTeamPayout(r11.id, fakeStripe)); }
    const x11 = await rowOf(e11.id, m11.id);
    assert(results.slice(0, 4).every((r) => r === "retry") && results[4] === "review" && x11.status === "review" && adminEmails.length === 1, "4 retries then review + one email", { results, x11 });
    fake.mode = "ok";

    console.log("\nevent cancelled after the pay was worked out: review, not sent");
    const m12 = await user("m12"); await ready(m12);
    const e12 = await mkCovered("cancelled", [m12]);
    const r12 = await rowOf(e12.id, m12.id);
    await q(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [e12.id]);
    fake.creates = 0;
    res = await send.sendTeamPayout(r12.id, fakeStripe);
    assert(res === "review" && fake.creates === 0, "review, no transfer", res);

    console.log("\ntwo runs at the same time send once");
    const m13 = await user("m13"); await ready(m13);
    const e13 = await mkCovered("race", [m13]);
    const r13 = await rowOf(e13.id, m13.id);
    let open!: () => void;
    fake.gate = new Promise<void>((r) => { open = r; });
    fake.creates = 0;
    const first = send.sendTeamPayout(r13.id, fakeStripe);
    await new Promise((r) => setTimeout(r, 200));
    const second = await send.sendTeamPayout(r13.id, fakeStripe);
    open(); fake.gate = null;
    const firstRes = await first;
    assert(firstRes === "paid" && second === "not_due" && fake.creates === 1, "one transfer", { firstRes, second, creates: fake.creates });

    console.log("\na run whose lock ran out and was claimed by another sends nothing");
    const m16 = await user("m16"); await ready(m16);
    const e16 = await mkCovered("lostlock", [m16]);
    const r16 = await rowOf(e16.id, m16.id);
    send.setTeamSendHooksForTest({ afterClaim: async (id) => {
      // Another run claims the row after this one's lock ran out (it changes updated_at, the ownership tag).
      await q(`UPDATE event_team_payouts SET attempts = attempts + 1, next_attempt_at = now() + interval '10 minutes', updated_at = now() + interval '1 second' WHERE id = $1`, [id]);
    } });
    fake.creates = 0;
    res = await send.sendTeamPayout(r16.id, fakeStripe);
    send.setTeamSendHooksForTest(null);
    assert(res === "not_due" && fake.creates === 0 && (await rowOf(e16.id, m16.id)).status === "pending", "the slow run stops before Stripe", { res, creates: fake.creates });

    console.log("\nthe payout job sends team pay when the switch is on");
    const m14 = await user("m14"); await ready(m14);
    const e14 = await event(hs, "job");
    await sell(e14.id, 10);
    await addMember(e14.id, hs, m14, "security"); await setPay(e14.id, m14, "security", hs, 2500);
    const out = await payouts.runEventPayoutJob(fakeStripe);
    assert((await rowOf(e14.id, m14.id))?.status === "paid" && (out as any).teamSent >= 1, "worked out and sent in the same run", out);
    process.env.TEAM_PAYOUTS_ENABLED = "";
    const m15 = await user("m15"); await ready(m15);
    const e15 = await event(hs, "joboff");
    await sell(e15.id, 10);
    await addMember(e15.id, hs, m15, "security"); await setPay(e15.id, m15, "security", hs, 2500);
    await payouts.runEventPayoutJob(fakeStripe);
    assert((await rowOf(e15.id, m15.id))?.status === "pending", "switch off: worked out, not sent");
    process.env.TEAM_PAYOUTS_ENABLED = "true";

    // ════════════════════ 21: taking someone off ════════════════════
    console.log("\ntaking someone off: reasons (call 21)");
    const hr = await user("hr");
    const er = await event(hr, "remove", { startsIn: "5 days" });
    const paidM = await user("paidm"); const freeM = await user("freem"); const otherM = await user("otherm"); const badM = await user("badm");
    const paidInvite = await addMember(er.id, hr, paidM, "security"); await setPay(er.id, paidM, "security", hr, 4000);
    await addMember(er.id, hr, freeM, "door");
    await addMember(er.id, hr, otherM, "security"); await setPay(er.id, otherM, "security", hr, 4000);
    await addMember(er.id, hr, badM, "security"); await setPay(er.id, badM, "security", hr, 4000);
    const del = (u: { id: string }, role: string, extra = "") => call("DELETE", `/api/events/${er.id}/door/team/${u.id}?scope=event&role=${role}${extra}`, { token: tok(hr.id) });
    let r = await del(paidM, "security");
    assert(r.status === 400 && r.body?.error?.code === "REASON_REQUIRED", "paid member, no reason: refused", r.body);
    r = await del(freeM, "door");
    assert(r.status === 200, "no pay, no reason (today's app and website): still works", r.body);
    r = await del(badM, "security", "&reason=rude");
    assert(r.status === 400 && r.body?.error?.code === "INVALID_REQUEST", "unknown reason refused", r.body);
    r = await del(otherM, "security", "&reason=other");
    assert(r.status === 400 && r.body?.error?.code === "INVALID_REQUEST", "other needs a short note", r.body);
    r = await del(otherM, "security", `&reason=other&note=${encodeURIComponent("x".repeat(201))}`);
    assert(r.status === 400, "note over 200 characters refused", r.body);
    pushes.length = 0; activity.length = 0;
    r = await del(paidM, "security", "&reason=late");
    assert(r.status === 200, "with a reason: removed", r.body);
    const stored = (await q(`SELECT removal_reason, removal_note, removed_at FROM event_door_members WHERE id = $1`, [paidInvite]))[0];
    assert(stored?.removal_reason === "late" && stored?.removal_note === null && !!stored?.removed_at, "reason stored", stored);
    const rp = pushesTo(paidM.id)[0];
    assert(!!rp && rp.title === "Removed: Late" && rp.body.includes(er.title) && !DASH.test(rp.body) && rp.data?.type === "team_removed", "the person is told: Removed: Late", rp);
    assert(activity.some((x) => x.userId === paidM.id && x.type === "team_removed"), "Activity item too");
    r = await call("GET", `/api/events/door/invites/${paidInvite}?roles=all`, { token: tok(paidM.id) });
    assert(r.status === 200 && r.body?.invite?.status === "gone" && r.body?.invite?.removal?.reason === "late" && r.body?.invite?.removal?.label === "Late",
      "the invite shows the reason", r.body?.invite);
    r = await del(otherM, "security", `&reason=other&note=${encodeURIComponent("Left early")}`);
    assert(r.status === 200 && pushesTo(otherM.id)[0]?.title === "Removed: Left early", "other: the note is the reason shown", pushesTo(otherM.id));
    r = await del(badM, "security", "&reason=no_show");
    assert(r.status === 200 && pushesTo(badM.id)[0]?.title === "Removed: No show", "No show", pushesTo(badM.id));
    pushes.length = 0;
    const silentM = await user("silentm"); const silentInv = await addMember(er.id, hr, silentM, "door");
    r = await del(silentM, "door");
    const silentRow = (await q(`SELECT removed_at, removal_reason FROM event_door_members WHERE id = $1`, [silentInv]))[0];
    assert(r.status === 200 && !!silentRow?.removed_at && silentRow?.removal_reason === null && pushesTo(silentM.id).length === 0,
      "no reason given: removed, no push (same as today)", { s: r.status, silentRow });

    console.log("\nunprofessional conduct, and a standing member with pay at an upcoming event");
    const stM = await user("stm");
    await addStanding(hr, stM, "security");
    await setPay(er.id, stM, "security", hr, 3000);
    r = await call("DELETE", `/api/events/${er.id}/door/team/${stM.id}?scope=standing&role=security`, { token: tok(hr.id) });
    assert(r.status === 400 && r.body?.error?.code === "REASON_REQUIRED", "standing member paid at an upcoming event: reason needed", r.body);
    pushes.length = 0;
    r = await call("DELETE", `/api/events/${er.id}/door/team/${stM.id}?scope=standing&role=security&reason=unprofessional`, { token: tok(hr.id) });
    assert(r.status === 200 && pushesTo(stM.id)[0]?.title === "Removed: Unprofessional conduct", "removed, told why", { s: r.status, p: pushesTo(stM.id) });

    console.log("\nonce the event is over its team is locked");
    const hl = await user("hl");
    const el = await event(hl, "locked", { ended: "2 hours" });
    const lockM = await user("lockm"); const lockInvite = await addMember(el.id, hl, lockM, "security");
    r = await call("DELETE", `/api/events/${el.id}/door/team/${lockM.id}?scope=event&role=security&reason=late`, { token: tok(hl.id) });
    assert(r.status === 409 && r.body?.error?.code === "EVENT_ENDED" && !DASH.test(r.body?.error?.message ?? ""), "host can't take anyone off after the end", r.body);
    r = await call("POST", `/api/events/door/invites/${lockInvite}/leave?roles=all`, { token: tok(lockM.id) });
    assert(r.status === 409 && r.body?.error?.code === "EVENT_ENDED", "the member can't leave it after the end either", r.body);
    const stillOn = (await q(`SELECT removed_at FROM event_door_members WHERE id = $1`, [lockInvite]))[0];
    assert(stillOn?.removed_at === null, "still on the team", stillOn);
    const stL = await user("stl"); await addStanding(hl, stL, "door");
    r = await call("DELETE", `/api/events/${el.id}/door/team/${stL.id}?scope=standing&role=door`, { token: tok(hl.id) });
    assert(r.status === 200, "standing team removal after an event still works (future events only)", r.body);

    // ════════════════════ 22: reminders to set up payouts ════════════════════
    console.log("\nsetup reminders: a push on accept");
    const hq = await user("hq");
    const eq = await event(hq, "accept", { startsIn: "10 days" });
    const accNo = await user("accno"); const accYes = await user("accyes"); await ready(accYes); const accFree = await user("accfree");
    const invNo = await addMember(eq.id, hq, accNo, "security", { accepted: false }); await setPay(eq.id, accNo, "security", hq, 20000);
    const invYes = await addMember(eq.id, hq, accYes, "security", { accepted: false }); await setPay(eq.id, accYes, "security", hq, 20000);
    const invFree = await addMember(eq.id, hq, accFree, "door", { accepted: false });
    pushes.length = 0;
    for (const [u, inv] of [[accNo, invNo], [accYes, invYes], [accFree, invFree]] as const) {
      r = await call("POST", `/api/events/door/invites/${inv}/accept?roles=all`, { token: tok(u.id) });
      assert(r.status === 200, `accepted (${u.username})`, r.body);
    }
    await new Promise((res2) => setTimeout(res2, 300));
    const setupPush = pushesTo(accNo.id).find((x) => x.data?.type === "team_payout_setup");
    assert(!!setupPush && setupPush.body.includes(eq.title) && /Set up payouts/.test(setupPush.body) && !DASH.test(setupPush.body), "paid, no setup: told to set up payouts", pushesTo(accNo.id));
    assert(!pushesTo(accYes.id).some((x) => x.data?.type === "team_payout_setup") && !pushesTo(accFree.id).some((x) => x.data?.type === "team_payout_setup"),
      "set up, or no pay: no setup push");

    console.log("\nsetup reminders: once a day until setup or the deadline");
    pushes.length = 0;
    let n = await send.remindTeamSetup();
    assert(pushesTo(accNo.id).filter((x) => x.data?.type === "team_payout_setup").length === 0, "the accept push counts as today's", { n, p: pushesTo(accNo.id) });
    await q(`UPDATE event_team_setup_notices SET last_push_at = now() - interval '25 hours' WHERE event_id = $1 AND member_user_id = $2`, [eq.id, accNo.id]);
    n = await send.remindTeamSetup();
    assert(pushesTo(accNo.id).filter((x) => x.data?.type === "team_payout_setup").length === 1, "a day later: one more", pushesTo(accNo.id));
    n = await send.remindTeamSetup();
    assert(pushesTo(accNo.id).filter((x) => x.data?.type === "team_payout_setup").length === 1, "not twice the same day");
    assert(pushesTo(accYes.id).length === 0 && pushesTo(accFree.id).length === 0, "never to the one set up or the unpaid one");
    await ready(accNo);
    await q(`UPDATE event_team_setup_notices SET last_push_at = now() - interval '25 hours' WHERE event_id = $1 AND member_user_id = $2`, [eq.id, accNo.id]);
    pushes.length = 0;
    await send.remindTeamSetup();
    assert(pushesTo(accNo.id).length === 0, "setup done: reminders stop at once");

    console.log("\nsetup reminders: emails the day of the event and the day after");
    const hd = await user("hd");
    const ed = await event(hd, "dayof", { startsIn: "1 minute" });
    // Local noon today in New York, so the test never straddles midnight.
    await q(`UPDATE events SET starts_at = (date_trunc('day', now() AT TIME ZONE 'America/New_York') + interval '12 hours') AT TIME ZONE 'America/New_York',
             ends_at = (date_trunc('day', now() AT TIME ZONE 'America/New_York') + interval '17 hours') AT TIME ZONE 'America/New_York' WHERE id = $1`, [ed.id]);
    const dm = await user("dm");
    await addMember(ed.id, hd, dm, "security"); await setPay(ed.id, dm, "security", hd, 20000);
    setupEmails.length = 0; pushes.length = 0;
    await send.remindTeamSetup();
    const dayOf = setupEmails.filter((x) => x.userId === dm.id);
    assert(dayOf.length === 1 && dayOf[0].amountCents === 20000 && dayOf[0].eventTitle === ed.title && typeof dayOf[0].deadlineText === "string" && dayOf[0].deadlineText.length > 0,
      "day of: one email with the amount, event and deadline", dayOf);
    assert(pushesTo(dm.id).some((x) => x.data?.type === "team_payout_setup" && /\$200\.00/.test(x.body) && /goes to the host/.test(x.body)),
      "day of: the push says the $200 goes to the host if not set up", pushesTo(dm.id));
    await send.remindTeamSetup();
    assert(setupEmails.filter((x) => x.userId === dm.id).length === 1, "day of email once");
    await q(`UPDATE events SET starts_at = starts_at - interval '1 day', ends_at = ends_at - interval '1 day' WHERE id = $1`, [ed.id]);
    await q(`UPDATE event_team_setup_notices SET last_push_at = now() - interval '25 hours' WHERE event_id = $1`, [ed.id]);
    await send.remindTeamSetup();
    assert(setupEmails.filter((x) => x.userId === dm.id).length === 2, "day after: a second email", setupEmails.filter((x) => x.userId === dm.id));
    await q(`UPDATE events SET team_pay_fixed_at = now() WHERE id = $1`, [ed.id]);
    await q(`UPDATE event_team_setup_notices SET last_push_at = now() - interval '25 hours' WHERE event_id = $1`, [ed.id]);
    pushes.length = 0;
    await send.remindTeamSetup();
    assert(pushesTo(dm.id).length === 0, "deadline passed (pay worked out): no more reminders");

    console.log("\na standing member who left after the event ended is still owed, so still reminded");
    const hx = await user("hx");
    const ex = await event(hx, "leftafter", { ended: "1 hour" });
    const sx = await user("sx");
    await addStanding(hx, sx, "security");
    await setPay(ex.id, sx, "security", hx, 4000);
    await q(`UPDATE event_door_team SET removed_at = now(), removed_by_user_id = $1 WHERE host_user_id = $1 AND member_user_id = $2`, [hx.id, sx.id]);
    pushes.length = 0;
    await send.remindTeamSetup();
    assert(pushesTo(sx.id).some((x) => x.data?.type === "team_payout_setup"), "reminded", pushesTo(sx.id));
    const sy = await user("sy");
    const ey = await event(hx, "joinedafter", { ended: "1 hour" });
    await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, invited_at, accepted_at) VALUES ($1, $2, $3, 'door', now() - interval '2 hours', now() - interval '10 minutes')`, [ey.id, sy.id, hx.id]);
    await setPay(ey.id, sy, "door", hx, 4000);
    pushes.length = 0;
    await send.remindTeamSetup();
    assert(pushesTo(sy.id).length === 0, "someone who joined after the end isn't on that team: no reminder");

    console.log("\npeople already told today don't block the ones still due");
    const hz = await user("hz");
    const ez = await event(hz, "starve", { ended: "2 days 20 hours" }); // earliest start of all, still before its deadline
    const z1 = await user("z1"); const z2 = await user("z2");
    await addMember(ez.id, hz, z1, "security"); await setPay(ez.id, z1, "security", hz, 1000);
    await addMember(ez.id, hz, z2, "security"); await setPay(ez.id, z2, "security", hz, 1000);
    const [firstId, secondId] = [z1.id, z2.id].sort();
    await q(`INSERT INTO event_team_setup_notices (event_id, member_user_id, last_push_at) VALUES ($1, $2, now())`, [ez.id, firstId]);
    pushes.length = 0;
    await send.remindTeamSetup(1);
    assert(pushesTo(secondId).length === 1 && pushesTo(firstId).length === 0, "with room for one, the one still due is reminded", pushes.map((x) => x.userId));

    console.log("\nsetup email copy");
    const { renderTeamSetupReminder } = await import("../emailService");
    const em = renderTeamSetupReminder({ toEmail: "a@b.c", userId: "u", firstName: "Ana", amountCents: 20000, eventTitle: "Big Night", deadlineText: "Monday, November 9", final: true });
    const dl = send.deadlineText("2026-11-06T04:00:00Z", "America/New_York");
    assert(dl === "Sunday, November 8 at 11:00 PM", "deadline names the day and the time", dl);
    assert(em.html.includes("$200.00") && em.html.includes("Big Night") && em.html.includes("Monday, November 9") && !DASH.test(em.subject) && !/[–—]/.test(em.html),
      "amount, event and deadline, no dashes", em.subject);

    // ════════════════════ 23: I paid them / Got it / Not yet ════════════════════
    console.log("\nI paid them / Got it / Not yet (call 23)");
    // e1: b1 and c1 are no_setup (host_to_pay), a1 was sent.
    const paidPath = (u: { id: string }) => `/api/events/${e1.id}/team-payouts/${u.id}/paid`;
    r = await call("GET", `/api/events/${e1.id}/team-payouts`, { token: tok(h1.id) });
    const listB = r.body?.payouts?.find((x: any) => x.member?.userId === b1.id);
    assert(r.status === 200 && r.body?.payouts?.length === 3 && listB?.outcome === "no_setup" && listB?.status === "host_to_pay" && listB?.amountCents === 3000 && listB?.member?.username === b1.username,
      "host sees each person's pay and who they pay directly", r.body);
    r = await call("GET", `/api/events/${e1.id}/team-payouts`, { token: tok(b1.id) });
    assert(r.status === 404, "a member can't see everyone's pay", r.status);
    r = await call("POST", paidPath(a1), { token: tok(h1.id) });
    assert(r.status === 409 && r.body?.error?.code === "NOT_HOST_TO_PAY", "Outsyde's own payments can't be marked paid by the host", r.body);
    r = await call("POST", paidPath(b1), { token: tok(a1.id) });
    assert(r.status === 404, "only the host", r.status);
    const co1 = await user("co1");
    await addMember(e1.id, h1, co1, "cohost");
    r = await call("GET", `/api/events/${e1.id}/team-payouts`, { token: tok(co1.id) });
    assert(r.status === 200, "a co-host can see team pay", r.status);
    r = await call("POST", paidPath(b1), { token: tok(co1.id) });
    assert(r.status === 404 && !(await rowOf(e1.id, b1.id)).host_settled_at, "but not mark it paid (the host's own money)", r.status);
    r = await call("POST", `/api/events/${e1.id}/team/me/payout/got-it`, { token: tok(b1.id) });
    assert(r.status === 409 && r.body?.error?.code === "NOT_MARKED_PAID", "Got it before I paid them: refused", r.body);
    pushes.length = 0; activity.length = 0;
    r = await call("POST", paidPath(b1), { token: tok(h1.id) });
    assert(r.status === 200 && r.body?.payout?.hostPaidAt, "I paid them", r.body);
    const askPush = pushesTo(b1.id)[0];
    assert(!!askPush && /\$30\.00/.test(askPush.body) && askPush.body.includes(e1.title) && /Did you get it\?/.test(askPush.body) && !DASH.test(askPush.body) && askPush.data?.type === "team_pay_marked_paid",
      "the member is asked: did you get it?", askPush);
    assert(activity.some((x) => x.userId === b1.id && x.type === "team_pay_marked_paid"), "Activity item for the member");
    r = await call("DELETE", paidPath(b1), { token: tok(h1.id) });
    assert(r.status === 200 && r.body?.payout?.hostPaidAt === null, "undo", r.body);
    r = await call("POST", `/api/events/${e1.id}/team/me/payout/got-it`, { token: tok(b1.id) });
    assert(r.status === 409, "after undo the member can't confirm", r.body);
    await call("POST", paidPath(b1), { token: tok(h1.id) });
    pushes.length = 0;
    r = await call("POST", `/api/events/${e1.id}/team/me/payout/not-yet`, { token: tok(b1.id) });
    assert(r.status === 200 && r.body?.payout?.notYetAt, "Not yet", r.body);
    const alertPush = pushesTo(h1.id)[0];
    assert(!!alertPush && /hasn't|haven't|not/i.test(alertPush.body) && /\$30\.00/.test(alertPush.body) && !DASH.test(alertPush.body) && alertPush.data?.type === "team_pay_not_received",
      "the host is alerted", alertPush);
    pushes.length = 0;
    r = await call("POST", `/api/events/${e1.id}/team/me/payout/got-it`, { token: tok(b1.id) });
    assert(r.status === 200 && r.body?.payout?.confirmedAt, "Got it later", r.body);
    assert(pushesTo(h1.id)[0]?.data?.type === "team_pay_confirmed" && !DASH.test(pushesTo(h1.id)[0]?.body ?? ""), "host told it's confirmed", pushesTo(h1.id));
    r = await call("DELETE", paidPath(b1), { token: tok(h1.id) });
    assert(r.status === 409 && r.body?.error?.code === "CONFIRMED", "after Got it it's final: no undo", r.body);
    r = await call("POST", `/api/events/${e1.id}/team/me/payout/not-yet`, { token: tok(b1.id) });
    assert(r.status === 409, "and no Not yet after Got it", r.body);

    console.log("\na Not yet open for 3 days goes to the admin once");
    await call("POST", paidPath(c1), { token: tok(h1.id) });
    await call("POST", `/api/events/${e1.id}/team/me/payout/not-yet`, { token: tok(c1.id) });
    adminEmails.length = 0;
    assert((await send.flagNotReceived()) === 0, "not after 1 minute");
    await q(`UPDATE event_team_payouts SET member_not_yet_at = now() - interval '3 days 1 minute' WHERE event_id = $1 AND member_user_id = $2`, [e1.id, c1.id]);
    const flagged = await send.flagNotReceived();
    assert(flagged === 1 && adminEmails.length === 1 && adminEmails[0].detail.includes(e1.title), "flagged: one admin email", { flagged, adminEmails });
    assert((await send.flagNotReceived()) === 0 && adminEmails.length === 1, "once only");
    const attn = await listTeamAttention();
    const notRec = attn.find((x: any) => x.kind === "team_not_received" && x.memberUserId === c1.id);
    assert(!!notRec && notRec.amountCents === 2000 && notRec.eventId === e1.id, "admin Needs attention lists it (team section)", attn);
    assert(attn.some((x: any) => x.kind === "team_review" && x.teamPayoutId === r6.id) && attn.some((x: any) => x.kind === "team_held" && x.teamPayoutId === r9.id),
      "and team pay in review or held", attn.map((x: any) => x.kind));
    await call("POST", `/api/events/${e1.id}/team/me/payout/got-it`, { token: tok(c1.id) });
    assert(!(await listTeamAttention()).some((x: any) => x.kind === "team_not_received" && x.memberUserId === c1.id), "Got it clears it");

    // ════════════════════ each person who worked it keeps one view ════════════════════
    console.log("\nthe member's own view of the event (call 21)");
    r = await call("GET", `/api/events/${e1.id}/team/me`, { token: tok(a1.id) });
    assert(r.status === 200 && r.body?.payout?.status === "paid" && r.body?.payout?.amountCents === 5000 && !!r.body?.payout?.sentAt, "after the end: their pay, sent", r.body?.payout);
    r = await call("GET", `/api/events/${e1.id}/team/me`, { token: tok(b1.id) });
    assert(r.status === 200 && r.body?.payout?.outcome === "no_setup" && !!r.body?.payout?.hostPaidAt && !!r.body?.payout?.confirmedAt, "host paid: I paid them and Got it shown", r.body?.payout);
    // Standing member removed after the end keeps the view of that event.
    const hv = await user("hv"); await ready(hv);
    const sv = await user("sv"); await ready(sv);
    await addStanding(hv, sv, "security");
    const ev = await event(hv, "view");
    await sell(ev.id, 10);
    await setPay(ev.id, sv, "security", hv, 1500);
    await runCreate();
    await q(`UPDATE event_door_team SET removed_at = now(), removed_by_user_id = $1 WHERE host_user_id = $1 AND member_user_id = $2`, [hv.id, sv.id]);
    r = await call("GET", `/api/events/${ev.id}/team/me`, { token: tok(sv.id) });
    assert(r.status === 200 && r.body?.payout?.amountCents === 1500, "removed from the standing team after the end: still sees this event's pay", r.body);
    // Removed before the end: no view.
    r = await call("GET", `/api/events/${er.id}/team/me`, { token: tok(paidM.id) });
    assert(r.status === 404, "taken off before the end: no view", r.status);
    // Before the end: setup banner info.
    const hb = await user("hb");
    const eb = await event(hb, "banner", { startsIn: "3 days" });
    const bm = await user("bm");
    await addMember(eb.id, hb, bm, "security"); await setPay(eb.id, bm, "security", hb, 9000);
    r = await call("GET", `/api/events/${eb.id}/team/me`, { token: tok(bm.id) });
    assert(r.status === 200 && r.body?.payoutSetup?.needed === true && !!r.body?.payoutSetup?.deadline && r.body?.payout === null, "before: setup needed, with the deadline", r.body);
    await ready(bm);
    r = await call("GET", `/api/events/${eb.id}/team/me`, { token: tok(bm.id) });
    assert(r.body?.payoutSetup?.needed === false, "set up: not needed", r.body?.payoutSetup);

    console.log("\nno Stripe call reached the real client");
    assert(stripeCalls.length === 0, "none", stripeCalls);
  } catch (err) {
    failed++;
    console.error("  ❌ crashed:", err);
  } finally {
    try {
      if (allEvents.length) {
        const ev = allEvents;
        await q(`DELETE FROM event_team_payouts WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_team_setup_notices WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_payout_recoveries WHERE payout_id IN (SELECT id FROM event_payouts WHERE event_id = ANY($1))`, [ev]);
        await q(`UPDATE tickets SET payout_id = NULL WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_payouts WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_team_pay WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_team_schedules WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_promoter_links WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM events WHERE id = ANY($1)`, [ev]);
      }
      if (allUsers.length) {
        await q(`DELETE FROM event_door_team WHERE host_user_id = ANY($1) OR member_user_id = ANY($1)`, [allUsers]);
        await q(`DELETE FROM businesses WHERE owner_id = ANY($1)`, [allUsers]).catch(() => {});
        await q(`DELETE FROM event_team_note_acceptances WHERE user_id = ANY($1)`, [allUsers]);
        await q(`DELETE FROM user_payout_accounts WHERE user_id = ANY($1)`, [allUsers]);
        await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [allUsers]).catch(() => {});
        await q(`DELETE FROM users WHERE id = ANY($1)`, [allUsers]).catch((e) => console.error("cleanup users:", e.message));
      }
    } catch (e) {
      console.error("cleanup failed:", (e as Error).message);
    }
    await db.end();
    srv.close();
    stub.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
