/**
 * p4-team step 9d: the Event Team note (Legend's calls 25 and 79 to 83, 2026-10-31).
 *
 *   79 Shown when someone takes a paid spot and on their event page until accepted. Once per person per version.
 *   80 Part of being set up by payout day: Stripe payout setup AND the current note. Not both by then: the host pays them
 *      ('no_setup'), with the same daily reminders, worded for what is missing.
 *   81 Joining a team is never blocked by the note.
 *   82 The wording: six points, version 2026-11-01. No dashes, no fee percentage.
 *
 * Run in process: EV_TEST_PG_URL=<local> DATABASE_URL=<local> STRIPE_STUB_PORT=<free port>
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" npx tsx server/events/teamNote.http.test.ts
 * Needs migrations up to 093 on the local database. SCRATCH ONLY: refuses any non-local database.
 *
 * Mutation checks (each must turn a test red):
 *  - drop the note from memberReadySql → "Stripe alone is not ready", "Stripe only: the host pays them" fail.
 *  - drop `version = TEAM_NOTE_VERSION` from the note check → "an older version doesn't count" fails.
 *  - drop `user_id = ...` from the note check → "someone else's acceptance doesn't count" fails.
 *  - drop the version check in POST /accept → "an older version can't be accepted" fails.
 *  - DO UPDATE SET accepted_at = now() instead of DO NOTHING → "accepting twice keeps the first time" fails.
 *  - always use the Stripe wording → "note only: the reminder asks for the note" fails.
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

function callAt(base: string, method: string, path: string, o: { token?: string; body?: unknown; ua?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    if (o.ua) headers["User-Agent"] = o.ua;
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
  process.env.TEAM_NOTE_REQUIRED = "true";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const stub = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(500); res.end("{}"); }); });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const express = (await import("express")).default;
  const notices = await import("./ticketNotices");
  const pushes: any[] = [];
  const setupEmails: any[] = [];
  notices.setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; },
    createActivity: async () => {},
    sendDoorInvite: async () => {}, sendOwedReminder: async () => {},
    sendTeamSetupReminder: async (p: any) => { setupEmails.push(p); },
  } as any);
  const note = await import("./teamNote");
  const send = await import("./teamSend");
  const payouts = await import("./eventPayouts");
  const { renderTeamSetupReminder } = await import("../emailService");
  const app = express();
  app.use(express.json());
  app.use("/api/events", (await import("./doorRouter")).default);
  app.use("/api/events", note.default);
  app.use("/api/events", (await import("./eventsRouter")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown; ua?: string } = {}) => callAt(BASE, m, p, o);

  const P = `tn${Date.now().toString(36)}`;
  const allEvents: string[] = [];
  const allUsers: string[] = [];
  const user = async (s: string, active = true) => {
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, `${P}${s}`.slice(0, 24), active],
    ))[0].id as string;
    allUsers.push(id);
    return { id };
  };
  const stripeReady = (u: { id: string }) => q(
    `INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)
     ON CONFLICT (user_id) DO UPDATE SET onboarding_complete = true`, [u.id, `acct_${P}_${u.id.slice(0, 8)}`]);
  const accepted = (u: { id: string }, version = note.TEAM_NOTE_VERSION) =>
    q(`INSERT INTO event_team_note_acceptances (user_id, version) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [u.id, version]);
  const isReady = async (u: { id: string }) => (await send.readyMembers([u.id])).has(u.id);
  const event = async (host: { id: string }, slug: string, o: { ended?: string; startsIn?: string } = {}) => {
    const when = o.startsIn
      ? `now() + $4::interval, now() + $4::interval + interval '5 hours'`
      : `now() - ($4::interval + interval '5 hours'), now() - $4::interval`;
    const e = (await q(
      `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at)
       VALUES ($1, $2, $3, 'published', ${when}, 'America/New_York', now() - interval '20 days') RETURNING id, title`,
      [host.id, `${P}-${slug}`, `${P} ${slug}`, o.startsIn ?? o.ended ?? "4 days"],
    ))[0] as { id: string; title: string };
    allEvents.push(e.id);
    return e;
  };
  const sell = async (eventId: string, buyerId: string, count: number) => {
    const typeId = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'GA', 2000, 500, 1, 50) RETURNING id`, [eventId]))[0].id;
    const sub = 2000 * count, plat = 40 * count;
    const oid = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents,
         host_net_cents, total_cents, completed_at, paid_at)
       VALUES ($1, $2, 'completed', $3, $4, 0, 0, $5, $6, $4, now() - interval '6 days', now() - interval '6 days') RETURNING id`,
      [eventId, buyerId, count, sub, plat, sub - plat]))[0].id;
    const iid = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 2000, 'issued', now() + interval '1 day') RETURNING id`, [oid, eventId, typeId, buyerId, count]))[0].id;
    for (let i = 1; i <= count; i++) {
      await q(`INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents,
           service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid', 2000, 0, 0, 40, 1960)`,
        [oid, iid, eventId, typeId, buyerId, i, `${P}${Math.random().toString(36).slice(2, 12)}`]);
    }
  };
  const addMember = async (eventId: string, host: { id: string }, u: { id: string }, role: string, o: { accepted?: boolean } = {}) =>
    (await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, invited_at, accepted_at)
       VALUES ($1, $2, $3, $4, now() - interval '12 days', ${o.accepted === false ? "NULL" : "now() - interval '10 days'"}) RETURNING id`,
      [eventId, u.id, host.id, role]))[0].id as string;
  const setPay = (eventId: string, u: { id: string }, role: string, host: { id: string }, fixed: number) =>
    q(`INSERT INTO event_team_pay (event_id, member_user_id, role, pay_type, fixed_cents, updated_by_user_id)
       VALUES ($1, $2, $3, 'fixed', $4, $5)`, [eventId, u.id, role, fixed, host.id]);

  try {
    // ════════════════════ the note itself (82) ════════════════════
    console.log("\nthe note (call 82)");
    const m1 = await user("m1");
    let r = await call("GET", "/api/events/team-note");
    assert(r.status === 401, "signed out: 401", r);
    r = await call("GET", "/api/events/team-note", { token: tok(m1.id) });
    const n = r.body?.note;
    assert(r.status === 200 && n?.version === "2026-11-01" && n?.title === "Event Team note" && n?.accepted === false && n?.acceptedAt === null,
      "the current version, not accepted yet", r.body);
    assert(Array.isArray(n?.points) && n.points.length === 6, "six points", n?.points);
    const all = [n?.title, n?.intro, ...(n?.points ?? [])].join(" ");
    assert(!DASH.test(all) && !/%/.test(all), "no dashes and no percentage anywhere", all);
    assert(/payout day/i.test(n?.points?.[0] ?? "") && /host pays you directly/i.test(n?.points?.[0] ?? ""), "point 1: payout day, otherwise the host pays", n?.points?.[0]);
    assert(/employer/i.test(all) && /tax forms/i.test(all) && /taken back/i.test(all) && /takes you off/i.test(all), "employer, tax forms, never taken back, taken off", all);

    // ════════════════════ accepting (79) ════════════════════
    console.log("\naccepting (call 79)");
    r = await call("POST", "/api/events/team-note/accept", { token: tok(m1.id), body: { version: "2026-10-01" } });
    assert(r.status === 409 && r.body?.error?.code === "NOTE_VERSION_CHANGED", "an older version can't be accepted", r);
    r = await call("POST", "/api/events/team-note/accept", { token: tok(m1.id), body: {} });
    assert(r.status === 400, "no version: 400", r);
    r = await call("POST", "/api/events/team-note/accept", { token: tok(m1.id), body: { version: "2026-11-01", extra: 1 } });
    assert(r.status === 400, "unknown fields refused", r);
    r = await call("POST", "/api/events/team-note/accept", { body: { version: "2026-11-01" } });
    assert(r.status === 401, "signed out can't accept", r);
    r = await call("POST", "/api/events/team-note/accept", { token: tok(m1.id), body: { version: "2026-11-01" }, ua: "OutsydeTest/1" });
    assert(r.status === 200 && r.body?.note?.accepted === true && typeof r.body?.note?.acceptedAt === "string", "accepted", r.body);
    const first = r.body?.note?.acceptedAt;
    const rows1 = await q(`SELECT * FROM event_team_note_acceptances WHERE user_id = $1`, [m1.id]);
    assert(rows1.length === 1 && rows1[0].version === "2026-11-01" && rows1[0].user_agent === "OutsydeTest/1", "one record, with the device", rows1);
    await new Promise((x) => setTimeout(x, 20));
    r = await call("POST", "/api/events/team-note/accept", { token: tok(m1.id), body: { version: "2026-11-01" } });
    assert(r.status === 200 && r.body?.note?.acceptedAt === first && (await q(`SELECT 1 FROM event_team_note_acceptances WHERE user_id = $1`, [m1.id])).length === 1,
      "accepting twice keeps the first time", { first, r: r.body });
    r = await call("GET", "/api/events/team-note", { token: tok(m1.id) });
    assert(r.body?.note?.accepted === true && r.body?.note?.acceptedAt === first, "read back: accepted", r.body);
    const off = await user("off", false);
    r = await call("POST", "/api/events/team-note/accept", { token: tok(off.id), body: { version: "2026-11-01" } });
    assert(r.status === 403, "an inactive account can't accept", r);

    // ════════════════════ ready = Stripe AND note (80) ════════════════════
    console.log("\nready by payout day (call 80)");
    const s1 = await user("s1"); await stripeReady(s1);
    const n1 = await user("n1"); await accepted(n1);
    const b1 = await user("b1"); await stripeReady(b1); await accepted(b1);
    const o1 = await user("o1"); await stripeReady(o1); await accepted(o1, "2026-01-01");
    const x1 = await user("x1"); await stripeReady(x1);
    assert(!(await isReady(s1)), "Stripe alone is not ready");
    assert(!(await isReady(n1)), "the note alone is not ready");
    assert(await isReady(b1), "both: ready");
    assert(!(await isReady(o1)), "an older version doesn't count");
    await accepted(b1); // b1 accepted; x1 has only Stripe
    assert(!(await isReady(x1)), "someone else's acceptance doesn't count");
    const st = await send.readinessOf(s1.id), nt = await send.readinessOf(n1.id), bt = await send.readinessOf(b1.id);
    assert(st.stripe && !st.note && !nt.stripe && nt.note && bt.stripe && bt.note, "readiness says what is missing", { st, nt, bt });

    console.log("\nthe switch: TEAM_NOTE_REQUIRED off means payout setup only, as before 9d");
    delete process.env.TEAM_NOTE_REQUIRED;
    const so = await send.readinessOf(s1.id);
    assert(await isReady(s1) && so.stripe && so.note, "off: Stripe alone is ready and nothing asks for the note", so);
    assert(!(await isReady(n1)), "off: the note alone is still not ready");
    const rOff = await call("GET", "/api/events/team-note", { token: tok(m1.id) });
    assert(rOff.status === 200 && rOff.body?.note?.accepted === true, "off: the note can still be read and accepted", rOff.body);
    process.env.TEAM_NOTE_REQUIRED = "true";

    console.log("\nthe payout: Stripe only means the host pays them");
    const h = await user("h"); await stripeReady(h); await accepted(h);
    const buyer = await user("buyer");
    const e = await event(h, "pay");
    await sell(e.id, buyer.id, 10);
    const both = await user("both"); await stripeReady(both); await accepted(both);
    const sOnly = await user("sonly"); await stripeReady(sOnly);
    for (const u of [both, sOnly]) await addMember(e.id, h, u, "security");
    await setPay(e.id, both, "security", h, 3000);
    await setPay(e.id, sOnly, "security", h, 2000);
    for (let i = 0; i < 5; i++) await payouts.createDuePayouts();
    const rowOf = async (u: { id: string }) => (await q(`SELECT * FROM event_team_payouts WHERE event_id = $1 AND member_user_id = $2`, [e.id, u.id]))[0];
    const rb = await rowOf(both), rs = await rowOf(sOnly);
    assert(rb?.outcome === "covered" && rb?.status === "pending", "Stripe and the note: Outsyde pays them", rb);
    assert(rs?.outcome === "no_setup" && rs?.status === "host_to_pay", "Stripe only: the host pays them", rs);
    const p = (await q(`SELECT * FROM event_payouts WHERE event_id = $1`, [e.id]))[0];
    assert(Number(p?.team_cents) === 3000 && Number(p?.amount_cents) === 19600 - 3000, "only the ready member is taken from the host's payout", p);

    // ════════════════════ their event page ════════════════════
    console.log("\ntheir event page (/team/me)");
    const future = await event(h, "future", { startsIn: "5 days" });
    const nm = await user("nm"); await stripeReady(nm);
    await addMember(future.id, h, nm, "security"); await setPay(future.id, nm, "security", h, 1500);
    r = await call("GET", `/api/events/${future.id}/team/me`, { token: tok(nm.id) });
    let ps = r.body?.payoutSetup;
    assert(r.status === 200 && ps?.needed === true && ps?.noteNeeded === true && ps?.stripeNeeded === false && typeof ps?.deadline === "string",
      "Stripe done, note missing: needed, and it says the note", ps);
    await accepted(nm);
    r = await call("GET", `/api/events/${future.id}/team/me`, { token: tok(nm.id) });
    ps = r.body?.payoutSetup;
    assert(ps?.needed === false && ps?.noteNeeded === false && ps?.stripeNeeded === false, "both done: nothing needed", ps);
    const nn = await user("nn");
    await addMember(future.id, h, nn, "security"); await setPay(future.id, nn, "security", h, 1500);
    r = await call("GET", `/api/events/${future.id}/team/me`, { token: tok(nn.id) });
    ps = r.body?.payoutSetup;
    assert(ps?.needed === true && ps?.noteNeeded === true && ps?.stripeNeeded === true, "neither: both missing", ps);

    // ════════════════════ joining is never blocked (81) ════════════════════
    console.log("\njoining a paid spot without the note (call 81)");
    const j = await user("j");
    const inv = await addMember(future.id, h, j, "media", { accepted: false });
    await setPay(future.id, j, "media", h, 4000);
    pushes.length = 0;
    r = await call("POST", `/api/events/door/invites/${inv}/accept?roles=all`, { token: tok(j.id) });
    assert(r.status === 200 && r.body?.invite?.status === "accepted", "accepted without the note", r.body);
    await new Promise((x) => setTimeout(x, 150));
    const jp = pushes.filter((x) => x.userId === j.id && x.data?.type === "team_payout_setup");
    assert(jp.length === 1 && /Event Team note/.test(jp[0]?.body ?? "") && /payouts/i.test(jp[0]?.body ?? "") && !DASH.test(jp[0]?.body ?? ""),
      "the push on accept asks for both", jp);

    // ════════════════════ reminders worded for what is missing ════════════════════
    console.log("\nreminders");
    const mk = async (s: string, o: { stripe?: boolean; note?: boolean }) => {
      const u = await user(s);
      if (o.stripe) await stripeReady(u);
      if (o.note) await accepted(u);
      await addMember(future.id, h, u, "security"); await setPay(future.id, u, "security", h, 2500);
      return u;
    };
    const rn = await mk("rn", { stripe: true });
    const rs2 = await mk("rs", { note: true });
    const rb2 = await mk("rb", {});
    const rok = await mk("rok", { stripe: true, note: true });
    pushes.length = 0;
    await send.remindTeamSetup(500);
    const pushOf = (u: { id: string }) => pushes.find((x) => x.userId === u.id && x.data?.type === "team_payout_setup");
    const pn = pushOf(rn), psr = pushOf(rs2), pb = pushOf(rb2);
    assert(!!pn && /Event Team note/.test(pn.body) && !/set up payouts/i.test(pn.body), "note only: the reminder asks for the note", pn);
    assert(!!psr && /set up payouts/i.test(psr.body) && !/Event Team note/.test(psr.body), "Stripe only missing: payout setup, as before", psr);
    assert(!!pb && /Event Team note/.test(pb.body) && /set up payouts/i.test(pb.body), "both missing: asks for both", pb);
    assert(!pushOf(rok), "ready: no reminder");
    assert([pn, psr, pb].every((x) => x && !DASH.test(`${x.title} ${x.body}`)), "no dashes in reminders");
    const copy = send.teamCopy.setupFirm("Rooftop", 2500, "Tuesday, November 10 at 2:00 AM", { stripe: true, note: false });
    assert(/\$25\.00/.test(copy.body) && /Event Team note/.test(copy.body) && /host/.test(copy.body) && !DASH.test(copy.body), "firm wording names the note and the host", copy);
    const toHost = send.teamCopy.toHost("Rooftop", 2500);
    assert(!/Payouts weren't set up/.test(toHost.body) && /host will pay you directly/i.test(toHost.body) && !DASH.test(toHost.body), "the last message doesn't blame payout setup alone", toHost);

    console.log("\nsetup email");
    const em = renderTeamSetupReminder({ userId: "u", toEmail: "a@b.c", firstName: "Ana", amountCents: 2500, eventTitle: "Rooftop", deadlineText: "Tuesday", final: false, needs: { stripe: true, note: false } } as any);
    assert(/Event Team note/.test(em.subject + em.html) && !/tap Set up payouts/.test(em.html), "note only: the email asks for the note", em.subject);
    const em2 = renderTeamSetupReminder({ userId: "u", toEmail: "a@b.c", firstName: null, amountCents: 0, eventTitle: "Rooftop", deadlineText: "Tuesday", final: true } as any);
    assert(/payouts/i.test(em2.subject) && /Set up payouts/.test(em2.html), "no needs given (older callers): the payout setup email as before", em2.subject);
    assert(![em.subject, em2.subject].some((s) => DASH.test(s)), "no dashes in subjects");
  } catch (err) {
    failed++;
    console.error("test crashed:", err);
  } finally {
    try {
      const ev = allEvents;
      if (ev.length) {
        await q(`DELETE FROM event_team_payouts WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_payouts WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_team_setup_notices WHERE event_id = ANY($1)`, [ev]).catch(() => {});
        await q(`DELETE FROM event_team_pay WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM event_promoter_links WHERE event_id = ANY($1)`, [ev]).catch(() => {});
        await q(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [ev]);
        await q(`DELETE FROM events WHERE id = ANY($1)`, [ev]);
      }
      if (allUsers.length) {
        await q(`DELETE FROM event_team_note_acceptances WHERE user_id = ANY($1)`, [allUsers]);
        await q(`DELETE FROM user_payout_accounts WHERE user_id = ANY($1)`, [allUsers]);
        await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [allUsers]).catch(() => {});
        await q(`DELETE FROM users WHERE id = ANY($1)`, [allUsers]).catch((x) => console.error("cleanup users:", x.message));
      }
    } catch (x) {
      console.error("cleanup failed:", (x as Error).message);
    }
    await db.end();
    srv.close(); stub.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
