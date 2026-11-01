/**
 * p4-team step 7: asking someone to stay longer (Legend decision 12, calls 41 to 48, call 45 changed 11:35 PM).
 *   41 Admissions, Security, Entertainment, Media, Other can be asked; never Promoters or co-hosts.
 *   42 Only the host asks.
 *   43 Hourly members: At their hourly rate, No extra pay or To be discussed (never Fixed on top). Others: Fixed, No
 *      extra pay, To be discussed.
 *   44 From the event start until their current end; one open request per person; again after an answer.
 *   45 Open until the later of their current end and 30 minutes after it was sent; then expired, host told.
 *   46 30 minutes to 6 hours, ending no later than 12 hours after the event; Fixed up to $1,000; role total $10,000.
 *   47 To be discussed: the host enters it until the payout is worked out (reminders the morning after and the day
 *      before payout day); not entered = $0.
 *   48 Accept moves their end and adds the extra to their pay at once; decline changes nothing; host told either way.
 * Run: EV_TEST_PG_URL=<local> DATABASE_URL=<local> NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/events/teamExtensions.http.test.ts
 */
import http from "http";

const PG_URL = process.env.EV_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);
const DASH = /[–—]| - /;
const H = 3600e3, MIN = 60e3, DAY = 24 * H;

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  process.env.FRONTEND_URL = "https://goutsyde.test";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const notices = await import("./ticketNotices");
  const pushes: any[] = [];
  const activity: any[] = [];
  notices.setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; },
    createActivity: async (p: any) => { activity.push(p); },
    sendDoorInvite: async () => {}, sendOwedReminder: async () => {}, sendTeamSetupReminder: async () => {},
  } as any);
  const ext = await import("./teamExtensions");
  const payouts = await import("./eventPayouts");
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/events", (await import("./doorRouter")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);
  const settle = () => new Promise((r) => setTimeout(r, 300));

  const P = `tx${Date.now().toString(36)}`;
  const allEvents: string[] = [];
  const allUsers: string[] = [];
  const user = async (s: string) => {
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, `${P}${s}`.slice(0, 24)],
    ))[0].id as string;
    allUsers.push(id);
    // Step 9d: everyone in this file accepted the Event Team note, so "ready" here means payout setup, as before. teamNote.http.test.ts covers a missing note.
    await q(`INSERT INTO event_team_note_acceptances (user_id, version) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, (await import("./teamNote")).TEAM_NOTE_VERSION]);
    return { id };
  };
  /** Started `startedAgo` ago, ends `endsIn` from now (negative = already ended). */
  const event = async (host: { id: string }, slug: string, startedAgoMs: number, endsInMs: number) => {
    const e = (await q(
      `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at, venue_name)
       VALUES ($1, $2, $3, 'published', now() - make_interval(secs => $4::float / 1000), now() + make_interval(secs => $5::float / 1000),
         'America/New_York', now() - interval '10 days', 'The Loft') RETURNING id, title, starts_at, ends_at`,
      [host.id, `${P}-${slug}`, `${P} ${slug}`, startedAgoMs, endsInMs],
    ))[0];
    allEvents.push(e.id);
    return e as { id: string; title: string; starts_at: Date; ends_at: Date };
  };
  const member = (eventId: string, host: { id: string }, u: { id: string }, role: string) =>
    q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, cohost_level, invited_at, accepted_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '30 days', now() - interval '20 days')`, [eventId, u.id, host.id, role, role === "cohost" ? "team" : null]);
  const pay = (eventId: string, u: { id: string }, role: string, host: { id: string }, p: { type: "fixed" | "hourly" | "none"; fixed?: number; hourly?: number }) =>
    q(`INSERT INTO event_team_pay (event_id, member_user_id, role, pay_type, fixed_cents, hourly_cents, updated_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventId, u.id, role, p.type, p.fixed ?? null, p.hourly ?? null, host.id]);
  /** Shift from `fromMs` to `toMs` relative to now. */
  const shift = (eventId: string, u: { id: string }, role: string, host: { id: string }, fromMs: number, toMs: number) =>
    q(`INSERT INTO event_team_schedules (event_id, member_user_id, role, starts_at, ends_at, updated_by_user_id)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4::float / 1000), now() + make_interval(secs => $5::float / 1000), $6)`,
      [eventId, u.id, role, fromMs, toMs, host.id]);
  const ask = (eventId: string, as: { id: string }, u: { id: string }, role: string, body: unknown) =>
    call("POST", `/api/events/${eventId}/door/team/${u.id}/stay-longer?role=${role}`, { token: tok(as.id), body });
  const answer = (eventId: string, u: { id: string }, id: string, a: "accept" | "decline") =>
    call("POST", `/api/events/${eventId}/team/me/stay-longer/${id}/${a}`, { token: tok(u.id) });
  const me = async (eventId: string, u: { id: string }) => (await call("GET", `/api/events/${eventId}/team/me`, { token: tok(u.id) })).body;
  const to = (u: { id: string }) => pushes.filter((p) => p.userId === u.id);

  try {
    const host = await user("host");
    // Started 3 hours ago, ends in 2 hours.
    const e = await event(host, "night", 3 * H, 2 * H);
    const sec = await user("sec"), dj = await user("dj"), pro = await user("pro"), co = await user("co"), adm = await user("adm"), med = await user("med");
    await member(e.id, host, sec, "security"); await pay(e.id, sec, "security", host, { type: "fixed", fixed: 16000 }); await shift(e.id, sec, "security", host, -4 * H, H);
    await member(e.id, host, dj, "entertainment"); await pay(e.id, dj, "entertainment", host, { type: "hourly", hourly: 5000 }); await shift(e.id, dj, "entertainment", host, -H, H);
    await member(e.id, host, pro, "host");
    await member(e.id, host, co, "cohost");
    await member(e.id, host, adm, "door"); await shift(e.id, adm, "door", host, -3 * H, 5 * MIN);
    await member(e.id, host, med, "media");

    console.log("\nthe host asks Security to stay 1 more hour, $50 (calls 42, 48)");
    pushes.length = 0; activity.length = 0;
    let r = await ask(e.id, host, sec, "security", { minutes: 60, pay: "fixed", fixedCents: 5000 });
    assert(r.status === 201 && r.body?.request?.status === "open" && r.body?.request?.extraMinutes === 60 && r.body?.request?.payKind === "fixed" && r.body?.request?.fixedCents === 5000, "request sent", r.body);
    const req1 = r.body?.request;
    const p1 = to(sec)[0];
    assert(!!p1 && p1.title === "Person host asked you to stay 1 more hour" && /^Until \d{1,2}:\d{2} [AP]M, \$50\.00 extra\. Tap to accept or decline\.$/.test(p1.body) && p1.data?.type === "team_stay_longer" && p1.data?.requestId === req1?.id && !DASH.test(p1.body),
      "they get a push: who, how long, until when, the extra", p1);
    assert(activity.some((a) => a.userId === sec.id && a.type === "team_stay_longer"), "and an Activity item (waiting for an answer)", activity);
    let m = await me(e.id, sec);
    assert(m?.stayLonger?.some((x: any) => x.id === req1?.id && x.status === "open"), "it shows on their event screen", m?.stayLonger);
    r = await ask(e.id, host, sec, "security", { minutes: 30, pay: "none" });
    assert(r.status === 409 && r.body?.error?.code === "REQUEST_OPEN", "one open request at a time (call 44)", r.body);

    console.log("\nthey accept");
    pushes.length = 0;
    r = await answer(e.id, sec, req1.id, "accept");
    assert(r.status === 200 && r.body?.request?.status === "accepted", "accepted", r.body);
    await settle();
    const hp = to(host)[0];
    assert(!!hp && hp.title === "Firstsec will stay 1 more hour" && hp.body.includes(e.title) && hp.data?.type === "team_stay_longer_answer" && !DASH.test(hp.body), "the host is told", to(host));
    m = await me(e.id, sec);
    const secPay = m?.roles?.find((x: any) => x.role === "security")?.pay;
    assert(secPay?.earnedCents === 21000 && secPay?.extraCents === 5000, "$160 fixed + $50 stayed 1 more hour = $210 (screen 51)", secPay);
    assert(m?.payTotalCents === 21000, "their total", m?.payTotalCents);
    assert(m?.stayLonger?.find((x: any) => x.id === req1.id)?.newEndAt === req1.newEndAt, "their new end time", m?.stayLonger);
    r = await answer(e.id, sec, req1.id, "decline");
    assert(r.status === 409, "can't answer twice", r.body);
    assert(to(sec).some((p) => p.data?.type === "team_payout_setup"), "a paying extra with no payout setup: they're told to set it up", to(sec));

    console.log("\nwhat they agreed to stays fixed");
    const putPay = (body: unknown) => call("PUT", `/api/events/${e.id}/door/team/${sec.id}/pay?role=security`, { token: tok(host.id), body });
    r = await putPay({ payType: "hourly", hourlyCents: 3000 });
    assert(r.status === 409 && r.body?.error?.code === "STAY_LONGER_SET" && !DASH.test(r.body?.error?.message ?? ""), "can't switch to hourly after they agreed to stay", r.body);
    r = await putPay({ payType: "fixed", fixedCents: 999000 });
    assert(r.status === 409 && r.body?.error?.code === "OVER_ROLE_CAP", "can't push the role past $10,000 with the extra", r.body);
    r = await putPay({ payType: "fixed", fixedCents: 16000 });
    assert(r.status === 200, "other pay changes still fine", r.body);
    const sh = (await q(`SELECT starts_at, ends_at FROM event_team_schedules WHERE event_id = $1 AND member_user_id = $2`, [e.id, sec.id]))[0];
    const putShift = (endsAt: string) => call("PUT", `/api/events/${e.id}/door/team/${sec.id}/schedule?role=security`, { token: tok(host.id), body: { startsAt: new Date(sh.starts_at).toISOString(), endsAt } });
    r = await putShift(new Date(new Date(sh.ends_at).getTime() + H).toISOString());
    assert(r.status === 409 && r.body?.error?.code === "STAY_LONGER_SET", "their end can't be moved by hand any more", r.body);
    r = await putShift(new Date(sh.ends_at).toISOString());
    assert(r.status === 200, "the rest of their times still save", r.body);

    console.log("\nasking again starts from the new end");
    r = await ask(e.id, host, sec, "security", { minutes: 30, pay: "none" });
    assert(r.status === 201 && r.body?.request?.fromEndAt === req1.newEndAt, "from 1 hour later", r.body);
    pushes.length = 0;
    const req2 = r.body.request;
    r = await answer(e.id, sec, req2.id, "decline");
    assert(r.status === 200 && r.body?.request?.status === "declined", "declined", r.body);
    await settle();
    assert(to(host)[0]?.title === "Firstsec can't stay longer" && !DASH.test(to(host)[0]?.body ?? ""), "the host is told", to(host));
    m = await me(e.id, sec);
    assert(m?.roles?.find((x: any) => x.role === "security")?.pay?.earnedCents === 21000, "declining changes nothing", m?.roles);

    console.log("\nthe host and co-hosts see the requests");
    r = await call("GET", `/api/events/${e.id}/team/stay-longer`, { token: tok(co.id) });
    assert(r.status === 200 && r.body?.requests?.length === 2 && r.body.requests[0].id === req2.id && r.body.requests[0].member?.firstName === "Firstsec", "a co-host sees them, newest first", r.body);
    r = await call("GET", `/api/events/${e.id}/team/stay-longer`, { token: tok(sec.id) });
    assert(r.status === 404, "a member doesn't", r.status);
    r = await answer(e.id, dj, req2.id, "accept");
    assert(r.status === 404, "only the person asked can answer", r.body);

    console.log("\nwho can be asked and who can ask (calls 41, 42)");
    r = await ask(e.id, host, pro, "host", { minutes: 60, pay: "none" });
    assert(r.status === 409 && r.body?.error?.code === "CANT_STAY_LONGER", "never Promoters", r.body);
    r = await ask(e.id, host, co, "cohost", { minutes: 60, pay: "none" });
    assert(r.status === 409 && r.body?.error?.code === "CANT_STAY_LONGER", "never co-hosts", r.body);
    r = await ask(e.id, co, med, "media", { minutes: 60, pay: "none" });
    assert(r.status === 404, "a co-host can't ask", r.status);
    r = await ask(e.id, sec, med, "media", { minutes: 60, pay: "none" });
    assert(r.status === 404, "nor can a member", r.status);
    r = await ask(e.id, host, med, "media", { minutes: 60, pay: "tbd" });
    assert(r.status === 201, "Media can be asked (no end set: from the event end)", r.body);
    assert(new Date(r.body?.request?.fromEndAt).getTime() === new Date(e.ends_at).getTime(), "counts from the event end", r.body?.request);
    const reqMed = r.body.request;

    console.log("\nhourly members (call 43)");
    r = await ask(e.id, host, dj, "entertainment", { minutes: 60, pay: "fixed", fixedCents: 5000 });
    assert(r.status === 400 && r.body?.error?.code === "FIXED_ON_HOURLY", "never a Fixed amount on top of hourly pay", r.body);
    r = await ask(e.id, host, sec, "security", { minutes: 60, pay: "hourly" });
    assert(r.status === 400, "At their hourly rate: only for hourly members", r.body);
    pushes.length = 0;
    r = await ask(e.id, host, dj, "entertainment", { minutes: 90, pay: "hourly" });
    assert(r.status === 201 && r.body?.request?.payKind === "hourly", "asked at their rate", r.body);
    assert(to(dj)[0]?.title === "Person host asked you to stay 1 more hour and 30 minutes" && /^Until .+, paid at your hourly rate\. Tap/.test(to(dj)[0]?.body ?? ""), "the push says at your hourly rate", to(dj));
    await answer(e.id, dj, r.body.request.id, "accept");
    m = await me(e.id, dj);
    const djPay = m?.roles?.find((x: any) => x.role === "entertainment")?.pay;
    assert(djPay?.extraCents === 7500 && djPay?.earnedCents === 10000 + 7500, "$50 an hour: 2 hours shift $100, plus 1.5 hours $75", djPay);

    console.log("\nlimits (call 46)");
    const sec2 = await user("sec2"); await member(e.id, host, sec2, "security"); await pay(e.id, sec2, "security", host, { type: "none" }); await shift(e.id, sec2, "security", host, -H, 2 * H);
    for (const [body, why] of [
      [{ minutes: 20, pay: "none" }, "under 30 minutes"], [{ minutes: 361, pay: "none" }, "over 6 hours"],
      [{ minutes: 60, pay: "fixed", fixedCents: 100001 }, "Fixed over $1,000"], [{ minutes: 60, pay: "fixed" }, "Fixed needs an amount"],
      [{ minutes: 60, pay: "none", fixedCents: 100 }, "an amount only with Fixed"], [{ minutes: 60, pay: "maybe" }, "unknown pay choice"],
      [{ minutes: 60, endAt: new Date(Date.now() + 9 * H).toISOString(), pay: "none" }, "minutes or an end time, not both"],
    ] as const) {
      r = await ask(e.id, host, sec2, "security", body);
      assert(r.status === 400, `refused: ${why}`, r.body);
    }
    r = await ask(e.id, host, sec2, "security", { endAt: new Date(new Date(e.ends_at).getTime() + 13 * H).toISOString(), pay: "none" });
    assert(r.status === 400 && r.body?.error?.code === "TOO_LATE", "no later than 12 hours after the event ends", r.body);
    r = await ask(e.id, host, sec2, "security", { endAt: new Date(Date.now() + 4 * H).toISOString(), pay: "none" });
    assert(r.status === 201 && r.body?.request?.extraMinutes === 120, "Pick end time: 2 hours after their end", r.body);
    const big = await user("big"); await member(e.id, host, big, "security"); await pay(e.id, big, "security", host, { type: "fixed", fixed: 990000 }); await shift(e.id, big, "security", host, -H, 2 * H);
    r = await ask(e.id, host, big, "security", { minutes: 60, pay: "fixed", fixedCents: 20000 });
    assert(r.status === 409 && r.body?.error?.code === "OVER_ROLE_CAP" && !DASH.test(r.body?.error?.message ?? ""), "the role's pay stays within $10,000", r.body);

    console.log("\nwhen the host can ask (call 44)");
    const early = await event(host, "early", -2 * H, 7 * H); // starts in 2 hours
    const s3 = await user("s3"); await member(early.id, host, s3, "security");
    r = await ask(early.id, host, s3, "security", { minutes: 60, pay: "none" });
    assert(r.status === 409 && r.body?.error?.code === "NOT_STARTED", "not before the event starts", r.body);
    const s4 = await user("s4"); await member(e.id, host, s4, "security"); await shift(e.id, s4, "security", host, -3 * H, -MIN);
    r = await ask(e.id, host, s4, "security", { minutes: 60, pay: "none" });
    assert(r.status === 409 && r.body?.error?.code === "SHIFT_OVER", "not after their end", r.body);

    console.log("\na request near the end of a shift stays open 30 minutes (call 45, Legend)");
    r = await ask(e.id, host, adm, "door", { minutes: 60, pay: "none" });
    const left = new Date(r.body?.request?.expiresAt).getTime() - Date.now();
    assert(r.status === 201 && left > 29 * MIN && left <= 30 * MIN + 5000, "their shift ends in 5 minutes, but it's open for 30", { s: r.status, left: left / MIN });
    const reqAdm = r.body.request;
    // Their shift ended 10 minutes ago, the request is still open: accepting still counts from the original end.
    await q(`UPDATE event_team_schedules SET ends_at = now() - interval '10 minutes' WHERE event_id = $1 AND member_user_id = $2`, [e.id, adm.id]);
    r = await answer(e.id, adm, reqAdm.id, "accept");
    assert(r.status === 200 && r.body?.request?.status === "accepted" && r.body?.request?.fromEndAt === reqAdm.fromEndAt, "accepted after their end, inside the 30 minutes", r.body);
    const s5 = await user("s5"); await member(e.id, host, s5, "security"); await shift(e.id, s5, "security", host, -H, 2 * H);
    r = await ask(e.id, host, s5, "security", { minutes: 60, pay: "none" });
    const left5 = new Date(r.body?.request?.expiresAt).getTime() - Date.now();
    assert(left5 > 119 * MIN && left5 <= 120 * MIN + 5000, "far from the end: open until their end", left5 / MIN);
    const reqS5 = r.body.request;
    await q(`UPDATE event_team_extensions SET expires_at = now() - interval '1 second' WHERE id = $1`, [reqS5.id]);
    pushes.length = 0;
    r = await answer(e.id, s5, reqS5.id, "accept");
    assert(r.status === 409 && r.body?.error?.code === "EXPIRED", "too late to answer", r.body);
    const n = await ext.expireStayLonger();
    assert(n >= 1 && (await q(`SELECT status FROM event_team_extensions WHERE id = $1`, [reqS5.id]))[0].status === "expired", "marked expired", n);
    assert(to(host).some((p) => p.title === "Your request to Firsts5 expired" && !DASH.test(p.body)), "the host is told", to(host));
    const before5 = to(host).filter((p) => p.data?.type === "team_stay_longer_expired").length;
    await ext.expireStayLonger();
    assert(to(host).filter((p) => p.data?.type === "team_stay_longer_expired").length === before5, "told once");
    r = await ask(e.id, host, s5, "security", { minutes: 30, pay: "none" });
    assert(r.status === 201, "the host can ask again after it expired", r.body);
    const reqS5b = r.body.request;
    pushes.length = 0;
    r = await call("DELETE", `/api/events/${e.id}/door/team/${s5.id}?scope=event&role=security`, { token: tok(host.id) });
    assert(r.status === 200, "taken off the team", r.body);
    assert((await q(`SELECT status FROM event_team_extensions WHERE id = $1`, [reqS5b.id]))[0].status === "expired", "their open request closes with it", null);
    await ext.expireStayLonger();
    assert(!to(host).some((p) => p.data?.type === "team_stay_longer_expired"), "quietly: no 'didn't answer' push", to(host));

    console.log("\nTo be discussed (call 47)");
    r = await answer(e.id, med, reqMed.id, "accept");
    m = await me(e.id, med);
    let medPay = m?.roles?.find((x: any) => x.role === "media")?.pay;
    assert(medPay?.extraCents === 0 && medPay?.extras?.[0]?.tbd === true && medPay?.extras?.[0]?.cents === null, "accepted: $0 until the host enters it, shown as to be discussed", medPay);
    r = await call("PUT", `/api/events/${e.id}/team/stay-longer/${reqMed.id}/amount`, { token: tok(med.id), body: { cents: 9000 } });
    assert(r.status === 404, "only the host enters it", r.status);
    r = await call("PUT", `/api/events/${e.id}/team/stay-longer/${reqMed.id}/amount`, { token: tok(host.id), body: { cents: 100001 } });
    assert(r.status === 400, "up to $1,000", r.body);
    r = await call("PUT", `/api/events/${e.id}/team/stay-longer/${req1.id}/amount`, { token: tok(host.id), body: { cents: 100 } });
    assert(r.status === 409 && r.body?.error?.code === "NOT_TBD", "only To be discussed requests", r.body);
    r = await call("PUT", `/api/events/${e.id}/team/stay-longer/${reqMed.id}/amount`, { token: tok(host.id), body: { cents: 9000 } });
    assert(r.status === 200 && r.body?.request?.finalCents === 9000, "host enters $90", r.body);
    m = await me(e.id, med);
    medPay = m?.roles?.find((x: any) => x.role === "media")?.pay;
    assert(medPay?.extraCents === 9000 && medPay?.earnedCents === 9000, "now in their pay", medPay);

    pushes.length = 0;
    const teamSend = await import("./teamSend");
    await teamSend.remindTeamSetup();
    assert(to(med).some((p) => p.data?.type === "team_payout_setup"), "their only pay is the extra: still reminded to set up payouts", to(med));

    console.log("\nTo be discussed reminders to the host, then the deadline");
    const ended = await event(host, "ended", 10 * H, -5 * H); // ended 5 hours ago
    const s6 = await user("s6"); await member(ended.id, host, s6, "security"); await pay(ended.id, s6, "security", host, { type: "fixed", fixed: 10000 });
    await q(`INSERT INTO event_team_extensions (event_id, member_user_id, role, requested_by_user_id, extra_minutes, from_end_at, new_end_at, pay_kind, status, expires_at, answered_at)
             SELECT id, $2, 'security', $3, 60, ends_at, ends_at + interval '1 hour', 'tbd', 'accepted', ends_at, ends_at - interval '1 hour' FROM events WHERE id = $1`, [ended.id, s6.id, host.id]);
    const endAt = new Date(ended.ends_at);
    const nyHour = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(d));
    // A moment the next morning in New York (10:00 AM the day after it ended).
    const nextMorning = new Date(endAt.getTime() + DAY - (nyHour(endAt) - 10) * H);
    // Someone still working at that time (asked after the end, until later that morning): not reminded yet.
    const s6c = await user("s6c"); await member(ended.id, host, s6c, "door");
    await q(`INSERT INTO event_team_extensions (event_id, member_user_id, role, requested_by_user_id, extra_minutes, from_end_at, new_end_at, pay_kind, status, expires_at, answered_at)
             VALUES ($1, $2, 'door', $3, 60, $4::timestamptz, $4::timestamptz + interval '1 hour', 'tbd', 'accepted', $4::timestamptz, $4::timestamptz)`,
      [ended.id, s6c.id, host.id, new Date(nextMorning.getTime() + H).toISOString()]);
    pushes.length = 0;
    await ext.remindStayLongerAmounts(new Date(endAt.getTime() + 30 * MIN));
    assert(!to(host).some((p) => p.data?.type === "team_stay_longer_amount"), "not right after the event");
    await ext.remindStayLongerAmounts(nextMorning);
    const tr = to(host).filter((p) => p.data?.type === "team_stay_longer_amount");
    assert(tr.length === 1 && tr[0].title === "Enter the extra pay" && tr[0].body.includes("Firsts6") && /or it's \$0\./.test(tr[0].body) && !DASH.test(tr[0].body), "the morning after: one push", to(host));
    await ext.remindStayLongerAmounts(new Date(nextMorning.getTime() + MIN));
    assert(to(host).filter((p) => p.data?.type === "team_stay_longer_amount").length === 1, "once");
    await ext.remindStayLongerAmounts(new Date(endAt.getTime() + 2 * DAY + MIN));
    assert(to(host).filter((p) => p.data?.type === "team_stay_longer_amount" && p.body.includes("Firsts6 ")).length === 2, "and the day before payout day");
    // Not entered by payout time: $0, the rest pays on time.
    await q(`UPDATE events SET starts_at = starts_at - interval '4 days', ends_at = ends_at - interval '4 days' WHERE id = $1`, [ended.id]);
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true) ON CONFLICT (user_id) DO NOTHING`, [s6.id, `acct_${P}_s6`]);
    const typeId = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'GA', 2000, 100, 1, 10) RETURNING id`, [ended.id]))[0].id;
    const buyer = await user("buyer");
    const oid = (await q(`INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents, total_cents, completed_at, paid_at)
      VALUES ($1, $2, 'completed', 10, 20000, 0, 0, 400, 19600, 20000, now() - interval '6 days', now() - interval '6 days') RETURNING id`, [ended.id, buyer.id]))[0].id;
    const iid = (await q(`INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at) VALUES ($1, $2, $3, $4, 10, 2000, 'issued', now() + interval '1 day') RETURNING id`, [oid, ended.id, typeId, buyer.id]))[0].id;
    for (let i = 1; i <= 10; i++) await q(`INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid', 2000, 0, 0, 40, 1960)`, [oid, iid, ended.id, typeId, buyer.id, i, `${P}${Math.random().toString(36).slice(2, 12)}`]);
    for (let i = 0; i < 5; i++) await payouts.createDuePayouts();
    const po6 = (await q(`SELECT team_cents, amount_cents, status FROM event_payouts WHERE event_id = $1`, [ended.id]))[0];
    const tp = (await q(`SELECT amount_cents FROM event_team_payouts WHERE event_id = $1 AND member_user_id = $2`, [ended.id, s6.id]))[0];
    assert(Number(tp?.amount_cents) === 10000, "payout: $100 fixed, the to be discussed extra never entered = $0", { tp, po6 });
    r = await call("PUT", `/api/events/${ended.id}/team/stay-longer/${(await q(`SELECT id FROM event_team_extensions WHERE event_id = $1`, [ended.id]))[0].id}/amount`, { token: tok(host.id), body: { cents: 5000 } });
    assert(r.status === 409 && r.body?.error?.code === "PAY_FIXED", "too late once the payout is worked out", r.body);

    console.log("\nTo be discussed: 3 days after the event, too late even before the payout runs");
    const late = await event(host, "late", 3 * DAY + 6 * H, -3 * DAY - MIN);
    const s9 = await user("s9"); await member(late.id, host, s9, "security");
    const x9 = (await q(`INSERT INTO event_team_extensions (event_id, member_user_id, role, requested_by_user_id, extra_minutes, from_end_at, new_end_at, pay_kind, status, expires_at, answered_at)
             SELECT id, $2, 'security', $3, 60, ends_at, ends_at + interval '1 hour', 'tbd', 'accepted', ends_at, ends_at - interval '1 hour' FROM events WHERE id = $1 RETURNING id`, [late.id, s9.id, host.id]))[0].id;
    r = await call("PUT", `/api/events/${late.id}/team/stay-longer/${x9}/amount`, { token: tok(host.id), body: { cents: 5000 } });
    assert(r.status === 409 && r.body?.error?.code === "PAY_FIXED", "payout time has come", r.body);
    await q(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [late.id]); // keep it out of the payout run below

    console.log("\na free event where the only pay is an extra is still recorded");
    const free = await event(host, "free", 4 * DAY + 6 * H, -4 * DAY);
    const s10 = await user("s10"); await member(free.id, host, s10, "security");
    await q(`INSERT INTO event_team_extensions (event_id, member_user_id, role, requested_by_user_id, extra_minutes, from_end_at, new_end_at, pay_kind, fixed_cents, status, expires_at, answered_at)
             SELECT id, $2, 'security', $3, 60, ends_at, ends_at + interval '1 hour', 'fixed', 3000, 'accepted', ends_at, ends_at - interval '1 hour' FROM events WHERE id = $1`, [free.id, s10.id, host.id]);

    console.log("\nextras are paid with the rest");
    const e7 = await event(host, "paid", 4 * DAY + 6 * H, -4 * DAY);
    const s7 = await user("s7"); await member(e7.id, host, s7, "security"); await pay(e7.id, s7, "security", host, { type: "fixed", fixed: 16000 });
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true) ON CONFLICT (user_id) DO NOTHING`, [s7.id, `acct_${P}_s7`]);
    await q(`INSERT INTO event_team_extensions (event_id, member_user_id, role, requested_by_user_id, extra_minutes, from_end_at, new_end_at, pay_kind, fixed_cents, status, expires_at, answered_at)
             SELECT id, $2, 'security', $3, 60, ends_at, ends_at + interval '1 hour', 'fixed', 5000, 'accepted', ends_at, ends_at - interval '1 hour' FROM events WHERE id = $1`, [e7.id, s7.id, host.id]);
    // Someone with no pay set who stayed for a Fixed $40 is paid that.
    const s8 = await user("s8"); await member(e7.id, host, s8, "media");
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true) ON CONFLICT (user_id) DO NOTHING`, [s8.id, `acct_${P}_s8`]);
    await q(`INSERT INTO event_team_extensions (event_id, member_user_id, role, requested_by_user_id, extra_minutes, from_end_at, new_end_at, pay_kind, fixed_cents, status, expires_at, answered_at)
             SELECT id, $2, 'media', $3, 30, ends_at, ends_at + interval '30 minutes', 'fixed', 4000, 'accepted', ends_at, ends_at - interval '1 hour' FROM events WHERE id = $1`, [e7.id, s8.id, host.id]);
    const t7 = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'GA', 5000, 100, 1, 10) RETURNING id`, [e7.id]))[0].id;
    const o7 = (await q(`INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents, total_cents, completed_at, paid_at)
      VALUES ($1, $2, 'completed', 10, 50000, 0, 0, 1000, 49000, 50000, now() - interval '6 days', now() - interval '6 days') RETURNING id`, [e7.id, buyer.id]))[0].id;
    const i7 = (await q(`INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at) VALUES ($1, $2, $3, $4, 10, 5000, 'issued', now() + interval '1 day') RETURNING id`, [o7, e7.id, t7, buyer.id]))[0].id;
    for (let i = 1; i <= 10; i++) await q(`INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid', 5000, 0, 0, 100, 4900)`, [o7, i7, e7.id, t7, buyer.id, i, `${P}${Math.random().toString(36).slice(2, 12)}`]);
    for (let i = 0; i < 5; i++) await payouts.createDuePayouts();
    const tp7 = (await q(`SELECT amount_cents, breakdown FROM event_team_payouts WHERE event_id = $1 AND member_user_id = $2`, [e7.id, s7.id]))[0];
    const po7 = (await q(`SELECT team_cents, amount_cents FROM event_payouts WHERE event_id = $1`, [e7.id]))[0];
    assert(Number(tp7?.amount_cents) === 21000 && tp7?.breakdown?.extraCents === 5000, "$160 + $50 extra = $210 to them, the extra on record", tp7);
    const tp10 = (await q(`SELECT amount_cents, outcome FROM event_team_payouts WHERE event_id = $1 AND member_user_id = $2`, [free.id, s10.id]))[0];
    assert(Number(tp10?.amount_cents) === 3000 && tp10?.outcome !== "covered", "the $30 is on record for the host to pay", tp10);
    const tp8 = (await q(`SELECT amount_cents FROM event_team_payouts WHERE event_id = $1 AND member_user_id = $2`, [e7.id, s8.id]))[0];
    assert(Number(tp8?.amount_cents) === 4000, "no pay set, stayed for $40: paid $40", tp8);
    assert(Number(po7?.team_cents) === 25000 && Number(po7?.amount_cents) === 49000 - 25000, "taken from the host payout ($490 earned, $240 to the host)", po7);

    console.log("\nwording");
    const all = pushes.concat(activity.map((a) => ({ title: a.title, body: a.message })));
    assert(all.every((p) => !DASH.test(p.title ?? "") && !DASH.test(p.body ?? "")), "no dashes in any push or Activity item", all.filter((p) => DASH.test(p.title ?? "") || DASH.test(p.body ?? "")));
    assert(ext.durationText(30) === "30 more minutes" && ext.durationText(60) === "1 more hour" && ext.durationText(90) === "1 more hour and 30 minutes"
      && ext.durationText(120) === "2 more hours" && ext.durationText(45) === "45 more minutes", "durations", [30, 60, 90, 120, 45].map(ext.durationText));
  } catch (err) {
    failed++;
    console.error("  ❌ crashed:", err);
  } finally {
    const ev = allEvents, us = allUsers;
    for (const [t, args] of [
      [`DELETE FROM event_team_extensions WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM event_team_payouts WHERE event_id = ANY($1)`, [ev]],
      [`UPDATE tickets SET payout_id = NULL WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM event_payouts WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM tickets WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM event_team_schedules WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM event_team_pay WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM event_team_setup_notices WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM event_promoter_links WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [ev]],
      [`DELETE FROM events WHERE id = ANY($1)`, [ev]],
      [`DELETE FROM event_team_note_acceptances WHERE user_id = ANY($1)`, [us]],
      [`DELETE FROM user_payout_accounts WHERE user_id = ANY($1)`, [us]],
      [`DELETE FROM notifications WHERE user_id = ANY($1)`, [us]],
      [`DELETE FROM users WHERE id = ANY($1)`, [us]],
    ] as const) {
      await q(t, args as unknown as unknown[]).catch((err) => console.error(`cleanup (${t.slice(0, 40)}):`, (err as Error).message));
    }
    await db.end();
    srv.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
