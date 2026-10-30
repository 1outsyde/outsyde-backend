/**
 * p4-team step 4a: Event team pay, set by the host and shown (no money moves yet).
 *
 *   PUT /api/events/:id/door/team/:userId/pay?role=   host only: { payType: none|fixed|hourly, fixedCents?, hourlyCents?, commissionPercent? }
 *   GET /api/events/:id/team/me                        each role gains `pay`; top level `payTotalCents` (only their own)
 *   GET /api/events/:id/door/team?roles=all            each member gains `pay`; top level `payTotals` (host and co-hosts)
 *   GET /api/events/:id/summary                        gains `teamPay` (host and co-hosts)
 * Rules (Legend 2026-10-29 / 2026-10-30): only the host sets pay, until the event ends, and the member gets a push when
 * it changes. Commission for Promoters (role 'host') and Entertainment on ticket price through their own link (so
 * Entertainment gets links too). Hourly = exact hours of the shift the host set. All or nothing: team owed more than the
 * host's earnings -> Outsyde pays the team $0. Pending invites, declined and removed people count for nothing.
 *
 * Mutation checks (run 2026-10-30, 19 rules, each caught; script kept in the session): all or nothing, covered at exactly
 * equal, pending and removed people, hourly rounding, commission roles, limits, host only, after the event, push only on a
 * real change (decided in the upsert, so 3 saves at once push once), no push to pending invites, a second commission refused
 * (COMMISSION_ON_OTHER_ROLE) and counted once if it slips in, the invitee's own offered pay, $0 hourly still listed for the
 * host, Entertainment links, and the safety tries in summary and team view (caught by promoterLinks.http.test.ts).
 * A save is the whole setting: leaving out commissionPercent clears it (same as the times route).
 *
 * SCRATCH ONLY. Local scratch Postgres with migrations through 086 (EV_TEST_PG_URL, localhost only) and DATABASE_URL via
 * the neon shim preload; Stripe goes to a stub in this process (STRIPE_STUB_PORT + ./.dev/stripe-stub-preload.mjs).
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

  // Stripe stub (same as promoterLinks.http.test.ts).
  const piStore: Record<string, any> = {};
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === "POST" && req.url === "/v1/customers") return send(200, { id: `cus_stub_${Date.now()}`, object: "customer" });
      const custM = req.url?.match(/^\/v1\/customers\/([^/?]+)/);
      if (req.method === "GET" && custM) return send(200, { id: custM[1], object: "customer" });
      if (req.method === "POST" && req.url === "/v1/payment_intents") {
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        const id = `pi_tp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        piStore[id] = { id, object: "payment_intent", amount: Number(form.get("amount") || 0), amount_received: 0, status: "requires_payment_method",
          client_secret: `${id}_secret`, metadata, customer: form.get("customer") };
        return send(200, piStore[id]);
      }
      const piM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)$/);
      if (req.method === "GET" && piM) { const pi = piStore[piM[1]]; return pi ? send(200, pi) : send(404, { error: { message: "No such payment_intent" } }); }
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const express = (await import("express")).default;
  const { setNoticeDepsForTest } = await import("./ticketNotices");
  const pushes: any[] = [];
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; }, createActivity: async () => {}, sendDoorInvite: async () => {},
  } as any);
  const { handleTicketPaymentSucceeded } = await import("./ticketCheckout");
  const app = express();
  app.use(express.json());
  app.use("/api/events", (await import("./doorRouter")).default);
  app.use("/api/events", (await import("./eventsRouter")).default);
  app.use("/api/events", (await import("./ticketsRouter")).default);
  app.use("/api/events", (await import("./ticketCheckout")).default);
  app.use("/api/events", (await import("./ticketRefunds")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `tp${Date.now().toString(36)}`;
  const mkUser = async (s: string) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, username],
    ))[0].id as string;
    return { id, username };
  };
  const host = await mkUser("host");
  const coT = await mkUser("cot");
  const pA = await mkUser("pa");      // Promoter
  const dj = await mkUser("dj");      // Entertainment
  const sec = await mkUser("sec");    // Security
  const door = await mkUser("door");  // Admissions
  const pend = await mkUser("pend");  // Security invite never accepted
  const gone = await mkUser("gone");  // Security, removed
  const stranger = await mkUser("str");
  const buyers: Array<{ id: string; username: string }> = [];
  for (let i = 0; i < 3; i++) buyers.push(await mkUser(`b${i}`));
  const ht = tok(host.id);

  const mkEvent = async (slug: string, startsIn: string, endsIn: string) => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at)
     VALUES ($1, $2, $3, 'published', now() + $4::interval, now() + $5::interval, 'America/New_York', now()) RETURNING id, slug, starts_at, ends_at`,
    [host.id, `${P}-${slug}`, `${P} ${slug}`, startsIn, endsIn],
  ))[0] as { id: string; slug: string; starts_at: Date; ends_at: Date };
  const ev = await mkEvent("main", "7 days", "7 days 5 hours");
  const past = await mkEvent("past", "-2 days", "-1 day");
  const ga = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'GA', 2000, 100, 1, 10) RETURNING id`, [ev.id]))[0].id as string;

  const invite = async (eventId: string, u: { username: string }, role: string, scope = "event") => {
    const r = await call("POST", `/api/events/${eventId}/door/team`, { token: ht, body: { username: u.username, scope, role } });
    if (r.status !== 201) throw new Error(`invite failed ${JSON.stringify(r)}`);
  };
  for (const [u, role] of [[coT, "cohost"], [pA, "host"], [dj, "entertainment"], [sec, "security"], [door, "door"], [pend, "security"], [gone, "security"]] as const) await invite(ev.id, u, role);
  // The API refuses invites to an event that's over, so this one is seeded as if it was accepted before.
  await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, invited_at, accepted_at) VALUES ($1, $2, $3, 'security', now() - interval '3 days', now() - interval '3 days')`,
    [past.id, sec.id, host.id]);
  await q(`UPDATE event_door_members SET accepted_at = now() WHERE event_id = ANY($1) AND accepted_at IS NULL AND member_user_id <> $2`, [[ev.id, past.id], pend.id]);

  const setPay = (eventId: string, u: { id: string }, role: string, body: unknown, token = ht) =>
    call("PUT", `/api/events/${eventId}/door/team/${u.id}/pay?role=${role}`, { token, body });
  const me = (u: { id: string }) => call("GET", `/api/events/${ev.id}/team/me`, { token: tok(u.id) });
  const roleOf = (r: any, role: string) => (r.body?.roles ?? []).find((x: any) => x.role === role);

  try {
    console.log("\nonly the host sets pay");
    let r = await setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 16000 });
    assert(r.status === 200 && r.body?.pay?.payType === "fixed" && r.body?.pay?.fixedCents === 16000, "host sets Security $160 fixed", r.body);
    r = await setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 1 }, tok(coT.id));
    assert(r.status === 403 && r.body?.error?.code === "HOST_ONLY", "co-host can't set pay", r.body);
    r = await setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 1 }, tok(sec.id));
    assert(r.status === 404, "the team member can't set their own pay", r.body);
    r = await setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 1 }, tok(stranger.id));
    assert(r.status === 404, "a stranger can't", r.body);
    r = await setPay(ev.id, sec, "door", { payType: "fixed", fixedCents: 1000 });
    assert(r.status === 404 && r.body?.error?.code === "NOT_ON_TEAM", "a role they don't hold: NOT_ON_TEAM", r.body);
    r = await setPay(ev.id, sec, "security", { payType: "none", commissionPercent: 10 });
    assert(r.status === 400, "commission refused for Security", r.body);
    r = await setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 1000001 });
    assert(r.status === 400, "fixed over $10,000 refused", r.body);
    r = await setPay(past.id, sec, "security", { payType: "fixed", fixedCents: 1000 });
    assert(r.status === 409 && r.body?.error?.code === "EVENT_ENDED", "pay can't change after the event ends", r.body);
    r = await call("PUT", `/api/events/${ev.id}/door/team/${sec.id}/pay`, { token: ht, body: { payType: "none" } });
    assert(r.status === 400, "role is required", r.body);

    console.log("\npush when pay changes");
    pushes.length = 0;
    r = await setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 16000 });
    assert(r.status === 200 && pushes.length === 0, "same pay again: no push", pushes);
    r = await setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 18000 });
    const push = pushes.find((p) => p.userId === sec.id);
    assert(r.status === 200 && push?.data?.type === "team_pay_changed" && push?.data?.eventId === ev.id, "changed pay: one push to that person", pushes);
    assert(!!push && !/[—–]/.test(`${push.title} ${push.body}`) && !/%/.test(`${push.title} ${push.body}`), "push copy has no dashes and no percent", push);
    pushes.length = 0;
    r = await setPay(ev.id, pend, "security", { payType: "fixed", fixedCents: 5000 });
    assert(r.status === 200 && pushes.length === 0, "pending invite: pay saved, no push yet", { r: r.body, pushes });
    r = await setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 16000 });

    console.log("\nlinks for Promoters and Entertainment");
    r = await me(dj);
    const djCode = r.body?.promoter?.code;
    assert(r.status === 200 && /^[A-HJ-NP-Z2-9]{8}$/.test(djCode ?? ""), "DJ gets a link", r.body?.promoter);
    r = await me(pA);
    const pACode = r.body?.promoter?.code;
    assert(/^[A-HJ-NP-Z2-9]{8}$/.test(pACode ?? "") && pACode !== djCode, "Promoter keeps their own link", r.body?.promoter);
    r = await me(sec);
    assert(r.status === 200 && r.body?.promoter === null, "Security: no link", r.body?.promoter);

    console.log("\nhourly needs the shift, then pays exact hours");
    r = await setPay(ev.id, dj, "entertainment", { payType: "hourly", hourlyCents: 5000, commissionPercent: 10 });
    assert(r.status === 200 && r.body?.pay?.commissionPercent === 10, "DJ $50 an hour plus 10%", r.body);
    r = await me(dj);
    let p = roleOf(r, "entertainment")?.pay;
    assert(p?.payType === "hourly" && p?.needsShift === true && p?.earnedCents === 0, "no set times yet: $0 and needs a shift", p);
    const startsAt = new Date(new Date(ev.starts_at).getTime() + 3600000).toISOString();
    const endsAt = new Date(new Date(ev.starts_at).getTime() + 3600000 + 4.5 * 3600000).toISOString();
    r = await call("PUT", `/api/events/${ev.id}/door/team/${dj.id}/schedule?role=entertainment`, { token: ht, body: { startsAt, endsAt } });
    assert(r.status === 200, "host sets the DJ's set times (4.5 h)", r.body);
    r = await me(dj);
    p = roleOf(r, "entertainment")?.pay;
    assert(p?.needsShift === false && p?.hours === 4.5 && p?.hourlyCents === 22500 && p?.earnedCents === 22500, "$50 x 4.5 h = $225", p);
    assert(r.body?.payTotalCents === 22500, "DJ's own total", r.body?.payTotalCents);

    console.log("\ncommission on sales through their link");
    r = await setPay(ev.id, pA, "host", { payType: "none", commissionPercent: 10 });
    assert(r.status === 200, "Promoter 10% commission", r.body);
    const buy = async (u: { id: string }, qty: number, linkCode?: string) => {
      const c = await call("POST", `/api/events/${ev.id}/checkout`, { token: tok(u.id), body: { ticketTypeId: ga, quantity: qty, ...(linkCode ? { linkCode } : {}) } });
      if (c.status !== 201) throw new Error(`checkout failed ${JSON.stringify(c)}`);
      const pi = piStore[c.body.paymentIntentId]; pi.status = "succeeded"; pi.amount_received = pi.amount;
      await handleTicketPaymentSucceeded(pi);
    };
    await buy(buyers[0], 10, pACode);
    await buy(buyers[1], 5, pACode);
    await buy(buyers[2], 2, djCode);
    r = await me(pA);
    p = roleOf(r, "host")?.pay;
    assert(p?.commissionCents === 3000 && p?.earnedCents === 3000, "Promoter: 10% of $300 = $30", p);
    r = await me(dj);
    p = roleOf(r, "entertainment")?.pay;
    assert(p?.commissionCents === 400 && p?.earnedCents === 22900, "DJ: $225 plus 10% of $40 = $229", p);

    console.log("\neach person sees only their own pay");
    r = await me(sec);
    p = roleOf(r, "security")?.pay;
    assert(p?.payType === "fixed" && p?.earnedCents === 16000 && r.body?.payTotalCents === 16000, "Security sees $160", p);
    const secJson = JSON.stringify(r.body);
    assert(!secJson.includes(dj.username) && !secJson.includes(pA.username) && !secJson.includes("22900") && !secJson.includes("hostTakeHome"),
      "no one else's pay, names or the host's numbers", r.body);
    r = await me(door);
    assert(r.status === 200 && roleOf(r, "door")?.pay?.payType === "none" && r.body?.payTotalCents === 0, "no pay set: shows none and $0", r.body);

    console.log("\nhost and co-host totals (all or nothing)");
    const sum = async (token = ht) => call("GET", `/api/events/${ev.id}/summary`, { token });
    r = await sum();
    const earnings = r.body?.totals?.hostEarningsCents;
    const tp = r.body?.teamPay;
    // Team: Security 16000 + DJ 22900 + Promoter 3000 = 41900. Pending (5000) and removed people don't count.
    assert(typeof earnings === "number" && earnings > 0 && earnings < 41900, "host earnings are less than the team's pay", { earnings });
    assert(tp?.totalCents === 41900 && tp?.covered === false && tp?.teamPaidCents === 0 && tp?.hostTakeHomeCents === earnings,
      "team owed more than the event made: team $0, host keeps it all", tp);
    assert(Array.isArray(tp?.members) && tp.members.length === 3 && tp.members.every((m: any) => typeof m.totalCents === "number"), "per person totals (3 people)", tp?.members);
    r = await setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 1000 });
    r = await sum();
    const tp2 = r.body?.teamPay;
    assert(tp2?.totalCents === 26900 && tp2?.covered === true && tp2?.teamPaidCents === 26900 && tp2?.hostTakeHomeCents === earnings - 26900,
      "lower Security to $10: covered, host takes home the rest", { tp2, earnings });
    assert(r.body?.totals?.hostEarningsCents === earnings, "hostEarningsCents keeps its meaning for old app builds", r.body?.totals);
    r = await sum(tok(coT.id));
    assert(r.status === 200 && r.body?.teamPay?.totalCents === 26900, "co-host sees the same team pay", r.body?.teamPay);

    console.log("\nteam list for host and co-host");
    r = await call("GET", `/api/events/${ev.id}/door/team?roles=all`, { token: ht });
    const rowFor = (u: { id: string }, role: string) => (r.body?.event ?? []).find((m: any) => m.userId === u.id && m.role === role);
    assert(r.status === 200 && rowFor(sec, "security")?.pay?.earnedCents === 1000 && rowFor(dj, "entertainment")?.pay?.earnedCents === 22900, "each member shows their pay", r.body?.event);
    assert(rowFor(pend, "security")?.pay?.fixedCents === 5000 && rowFor(pend, "security")?.status === "invited", "pending invite shows the pay offered", rowFor(pend, "security"));
    assert(r.body?.payTotals?.teamCents === 26900 && r.body?.payTotals?.covered === true, "team list totals", r.body?.payTotals);
    const oldKeys = ["userId", "firstName", "username", "addedAt", "inviteId", "status", "invitedAt"];
    assert(oldKeys.every((k) => k in (rowFor(sec, "security") ?? {})), "old member keys unchanged", rowFor(sec, "security"));
    r = await call("GET", `/api/events/${ev.id}/door/team?roles=all`, { token: tok(coT.id) });
    assert(r.status === 200 && r.body?.payTotals?.teamCents === 26900, "co-host sees the team list totals", r.body?.payTotals);

    console.log("\nremoved people count for nothing");
    await setPay(ev.id, gone, "security", { payType: "fixed", fixedCents: 99999 });
    r = await sum();
    assert(r.body?.teamPay?.totalCents === 26900 + 99999, "accepted Security with pay counts", r.body?.teamPay);
    r = await call("DELETE", `/api/events/${ev.id}/door/team/${gone.id}?scope=event&role=security`, { token: ht });
    assert(r.status === 200, "host removes them", r.body);
    r = await sum();
    assert(r.body?.teamPay?.totalCents === 26900, "removed: their pay drops out", r.body?.teamPay);
    r = await setPay(ev.id, gone, "security", { payType: "fixed", fixedCents: 100 });
    assert(r.status === 404, "can't set pay for someone removed", r.body);

    console.log("\nthe invitee sees the pay offered (only their own)");
    r = await call("GET", `/api/events/${ev.id}/door/team?roles=all`, { token: ht });
    const pendInvite = (r.body?.event ?? []).find((m: any) => m.userId === pend.id && m.role === "security")?.inviteId;
    r = await call("GET", `/api/events/door/invites/${pendInvite}?roles=all`, { token: tok(pend.id) });
    assert(r.status === 200 && r.body?.invite?.pay?.payType === "fixed" && r.body?.invite?.pay?.fixedCents === 5000, "invitee sees $50 offered", r.body?.invite);
    assert(!JSON.stringify(r.body).includes("payTotals") && !JSON.stringify(r.body).includes(sec.username), "nothing about anyone else", r.body);
    r = await call("GET", `/api/events/door/invites/${pendInvite}?roles=all`, { token: tok(stranger.id) });
    assert(r.status === 404, "someone else can't open it", r.body);

    console.log("\ncommission once per person, even with two link roles");
    const both = await mkUser("both");
    await invite(ev.id, both, "host");
    await invite(ev.id, both, "entertainment");
    await q(`UPDATE event_door_members SET accepted_at = now() WHERE event_id = $1 AND member_user_id = $2`, [ev.id, both.id]);
    r = await setPay(ev.id, both, "host", { payType: "none", commissionPercent: 10 });
    assert(r.status === 200, "Promoter role: 10% commission", r.body);
    r = await setPay(ev.id, both, "entertainment", { payType: "fixed", fixedCents: 5000, commissionPercent: 5 });
    assert(r.status === 409 && r.body?.error?.code === "COMMISSION_ON_OTHER_ROLE", "a second commission on the same link is refused", r.body);
    assert(!/[—–]/.test(r.body?.error?.message ?? "x") && !/%/.test(r.body?.error?.message ?? "%"), "message has no dashes or percent", r.body);
    r = await setPay(ev.id, both, "entertainment", { payType: "fixed", fixedCents: 5000 });
    assert(r.status === 200 && r.body?.pay?.earnedCents === 5000, "the DJ role can still have fixed pay", r.body);
    r = await setPay(ev.id, both, "host", { payType: "none" });
    r = await setPay(ev.id, both, "entertainment", { payType: "fixed", fixedCents: 5000, commissionPercent: 5 });
    assert(r.status === 200 && r.body?.pay?.commissionPercent === 5, "moved to the DJ role once the Promoter role has none", r.body);
    // Two saves racing could still leave commission on both roles: the totals must count the link's sales once.
    const bothCode = (await me(both)).body?.promoter?.code;
    await buy(buyers[0], 1, bothCode);
    await q(`UPDATE event_team_pay SET commission_bps = 1000 WHERE event_id = $1 AND member_user_id = $2 AND role = 'host'`, [ev.id, both.id]);
    r = await sum();
    const bothRow = (r.body?.teamPay?.members ?? []).find((m: any) => m.userId === both.id);
    assert(/^[A-HJ-NP-Z2-9]{8}$/.test(bothCode ?? "") && bothRow?.totalCents === 5000 + 200,
      "commission on both roles anyway: the $20 sale earns commission once (10% on the first link role)", bothRow);
    await q(`UPDATE event_team_pay SET commission_bps = NULL WHERE event_id = $1 AND member_user_id = $2 AND role = 'host'`, [ev.id, both.id]);

    console.log("\nstanding team members get pay per event");
    const stand = await mkUser("stand");
    await invite(ev.id, stand, "security", "standing");
    await q(`UPDATE event_door_team SET accepted_at = now() WHERE host_user_id = $1 AND member_user_id = $2`, [host.id, stand.id]);
    const before = (await sum()).body?.teamPay?.totalCents;
    r = await setPay(ev.id, stand, "security", { payType: "fixed", fixedCents: 2500 });
    assert(r.status === 200, "host sets this event's pay for a standing member", r.body);
    r = await sum();
    assert(r.body?.teamPay?.totalCents === before + 2500, "counted in this event's team total", { before, after: r.body?.teamPay?.totalCents });
    r = await me(stand);
    assert(roleOf(r, "security")?.pay?.earnedCents === 2500 && r.body?.payTotalCents === 2500, "standing member sees their pay", r.body);

    console.log("\nhourly still waiting for a shift is listed for the host");
    const wait = await mkUser("wait");
    await invite(ev.id, wait, "media");
    await q(`UPDATE event_door_members SET accepted_at = now() WHERE event_id = $1 AND member_user_id = $2`, [ev.id, wait.id]);
    await setPay(ev.id, wait, "media", { payType: "hourly", hourlyCents: 4000 });
    r = await sum();
    const w = (r.body?.teamPay?.members ?? []).find((m: any) => m.userId === wait.id);
    assert(w?.totalCents === 0 && w?.needsShift === true, "shown with $0 and needs a shift", r.body?.teamPay?.members);

    console.log("\ntwo saves at once: one push");
    pushes.length = 0;
    await Promise.all([
      setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 4321 }),
      setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 4321 }),
      setPay(ev.id, sec, "security", { payType: "fixed", fixedCents: 4321 }),
    ]);
    await new Promise((res) => setTimeout(res, 200));
    assert(pushes.filter((p) => p.userId === sec.id).length === 1, "exactly one push for one change", pushes);

    console.log("\nfree event with fixed pay: Outsyde pays nothing");
    const free = await mkEvent("free", "3 days", "3 days 4 hours");
    await invite(free.id, sec, "security");
    await q(`UPDATE event_door_members SET accepted_at = now() WHERE event_id = $1`, [free.id]);
    await setPay(free.id, sec, "security", { payType: "fixed", fixedCents: 16000 });
    r = await call("GET", `/api/events/${free.id}/summary`, { token: ht });
    assert(r.body?.teamPay?.totalCents === 16000 && r.body?.teamPay?.covered === false && r.body?.teamPay?.teamPaidCents === 0, "no ticket money: not covered", r.body?.teamPay);
  } finally {
    const ids = (await q(`SELECT id FROM events WHERE slug LIKE $1`, [`${P}-%`])).map((x) => x.id);
    const clean = async (t: string, p: unknown[]) => { try { await q(t, p); } catch (err) { console.error(`  cleanup: ${(err as Error).message}`); } };
    await clean(`DELETE FROM tickets WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_account_counts WHERE ticket_type_id IN (SELECT id FROM ticket_types WHERE event_id = ANY($1))`, [ids]);
    await clean(`DELETE FROM event_promoter_links WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_team_pay WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_team_schedules WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_door_team WHERE host_user_id = $1`, [host.id]);
    await clean(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await clean(`DELETE FROM events WHERE id = ANY($1)`, [ids]);
    await clean(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    srv.close();
    stub.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
