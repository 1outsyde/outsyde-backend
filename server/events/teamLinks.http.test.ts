/**
 * p4-team step 9-0: Event team invite links (migration 092, Legend 2026-10-31 calls 66 to 71 and 67b).
 *
 *   POST   /api/events/:id/team/links              (auth, host or co-host) make a one person link, optionally emailed
 *   GET    /api/events/:id/team/links              (auth, host or co-host) open links
 *   DELETE /api/events/:id/team/links/:linkId      (auth, host or co-host) cancel an open link
 *   GET    /api/events/team-links/:code            (public) what the link is, never the email
 *   POST   /api/events/team-links/:code/accept     (auth) take the spot
 *
 * SCRATCH ONLY: Postgres (EV_TEST_PG_URL) + DATABASE_URL via the neon shim, in-process router with notice fakes.
 * Skips (exit 0) when EV_TEST_PG_URL is unset.
 *
 * Mutation checks (each must turn a test red):
 *  - drop `status = 'open'` from the accept claim → "two people at once: exactly one gets it" fails.
 *  - drop the revert after ALREADY_ON_TEAM → "already on the team: the link stays open" fails.
 *  - drop the pay insert on accept → "the link's pay becomes theirs" fails.
 *  - send sent_to_email in the public view → "the link page never shows the email" fails.
 *  - drop the per host email count of links → "the 11th email of the day isn't sent" fails.
 *  - let a co-host make a standing link → "a co-host can't make an All my events link" fails.
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

async function callAt(base: string, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set EV_TEST_PG_URL to run"); process.exit(0); }
  if (!isLocal(PG_URL) || !(process.env.DATABASE_URL && isLocal(process.env.DATABASE_URL))) throw new Error("refusing to run: PG_URL and DATABASE_URL must be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  process.env.FRONTEND_URL = "https://goutsyde.test";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const P = `tl${Date.now().toString(36)}`;
  const mkUser = async (s: string, first: string | null = `First${s}`) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, password, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, 'x', $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, first, username],
    ))[0].id as string;
    return { id, username };
  };
  const host = await mkUser("host", "Hosty");
  const co = await mkUser("co", "Cora");
  const ana = await mkUser("ana", "Ana");
  const bo = await mkUser("bo", "Bo");
  const cy = await mkUser("cy", "Cy");
  const di = await mkUser("di", "Di");
  const host2 = await mkUser("hosttwo", "Hostess");
  const mkEvent = async (startsH: number, endsH: number, title: string, status = "published", hostId = host.id) => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, now() + ($6 || ' hours')::interval, 'America/New_York') RETURNING id, ends_at`,
    [hostId, `${P}-${Math.random().toString(36).slice(2, 8)}`, title, status, String(startsH), String(endsH)],
  ))[0] as { id: string; ends_at: Date };
  const evA = await mkEvent(24, 30, `${P} Alpha`);
  const evB = await mkEvent(48, 52, `${P} Beta`);
  const evOver = await mkEvent(-5, -1, `${P} Over`);
  const ht = tok(host.id);
  // Co-host on evA (accepted, Team level).
  await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, cohost_level, accepted_at) VALUES ($1, $2, $3, 'cohost', 'team', now())`, [evA.id, co.id, host.id]);

  const express = (await import("express")).default;
  const { setNoticeDepsForTest } = await import("./ticketNotices");
  const pushes: any[] = [];
  const emails: any[] = [];
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p) => { pushes.push(p); return true; }, createActivity: async () => {},
    sendDoorInvite: async (p: any) => { emails.push(p); },
  });
  const { default: doorRouter } = await import("./doorRouter");
  const app = express();
  app.use(express.json());
  app.use("/api/events", doorRouter);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);
  const make = (ev: string, body: unknown, token = ht) => call("POST", `/api/events/${ev}/team/links`, { token, body });

  try {
    console.log("\nmaking a link");
    let r = await make(evA.id, { scope: "event", role: "security", pay: { payType: "fixed", fixedCents: 16000 } });
    assert(r.status === 201 && r.body.success === true, "host makes a This event link (201)", r.body);
    const l1 = r.body.link;
    assert(/^[A-HJ-NP-Z2-9]{12}$/.test(l1?.code ?? "") && l1.url === `https://goutsyde.test/team/${l1.code}`, "12 character code and goutsyde.com/team/CODE", l1);
    assert(l1.scope === "event" && l1.role === "security" && l1.status === "open" && l1.roleLabel === null && l1.cohostLevel === null, "link shape", l1);
    assert(l1.pay?.payType === "fixed" && l1.pay.fixedCents === 16000, "pay is on the link", l1.pay);
    assert(new Date(l1.expiresAt).getTime() === new Date(evA.ends_at).getTime(), "This event link ends when the event ends", [l1.expiresAt, evA.ends_at]);
    assert(r.body.emailed === null && emails.length === 0, "no email asked: nothing emailed", r.body);
    const [row1] = await q(`SELECT * FROM event_team_links WHERE id = $1`, [l1.id]);
    assert(row1?.host_user_id === host.id && row1.created_by_user_id === host.id && row1.event_id === evA.id, "saved under the event's host", row1);

    r = await make(evA.id, { scope: "standing", role: "door" });
    const l2 = r.body.link;
    const days = (new Date(l2?.expiresAt).getTime() - Date.now()) / 86400_000;
    assert(r.status === 201 && l2.scope === "standing" && days > 6.99 && days < 7.01 && l2.pay === null, "an All my events link lasts 7 days, no pay", l2);

    r = await make(evA.id, { scope: "standing", role: "door", pay: { payType: "fixed", fixedCents: 100 } });
    assert(r.status === 400 && r.body.error.code === "INVALID_REQUEST" && /one event at a time/.test(r.body.error.message), "no pay on an All my events link", r.body);
    r = await make(evA.id, { scope: "event", role: "other" });
    assert(r.status === 400 && /roleLabel/.test(r.body.error.message), "Other needs its name", r.body);
    r = await make(evOver.id, { scope: "event", role: "security" });
    assert(r.status === 409 && r.body.error.code === "EVENT_ENDED", "no link for an event that's over", r.body);
    r = await make(evA.id, { scope: "event", role: "security" }, tok(ana.id));
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "someone not on the team can't make links (404)", r.body);
    r = await call("POST", `/api/events/${evA.id}/team/links`, { body: { scope: "event", role: "security" } });
    assert(r.status === 401, "signed out is 401", r.status);

    console.log("\nco-hosts");
    r = await make(evA.id, { scope: "event", role: "media" }, tok(co.id));
    assert(r.status === 201 && r.body.link.role === "media", "a co-host makes a This event link", r.body);
    const coLink = r.body.link;
    const [coRow] = await q(`SELECT host_user_id, created_by_user_id FROM event_team_links WHERE id = $1`, [coLink.id]);
    assert(coRow?.host_user_id === host.id && coRow.created_by_user_id === co.id, "saved under the host, made by the co-host", coRow);
    r = await make(evA.id, { scope: "standing", role: "media" }, tok(co.id));
    assert(r.status === 403 && r.body.error.code === "HOST_ONLY", "a co-host can't make an All my events link", r.body);
    r = await make(evA.id, { scope: "event", role: "cohost" }, tok(co.id));
    assert(r.status === 403 && r.body.error.code === "HOST_ONLY", "a co-host can't make a co-host link", r.body);
    r = await make(evA.id, { scope: "event", role: "media", pay: { payType: "fixed", fixedCents: 500 } }, tok(co.id));
    assert(r.status === 403 && r.body.error.code === "HOST_ONLY" && /pay/i.test(r.body.error.message), "a co-host can't put pay on a link", r.body);
    r = await make(evB.id, { scope: "event", role: "media" }, tok(co.id));
    assert(r.status === 404, "a co-host of Alpha can't make links for Beta", r.body);

    console.log("\nlisting and cancelling");
    r = await call("GET", `/api/events/${evA.id}/team/links`, { token: ht });
    const ids = (r.body?.links ?? []).map((x: any) => x.id).sort();
    assert(r.status === 200 && ids.join() === [l1.id, l2.id, coLink.id].sort().join(), "the host sees this event's links and their All my events links", r.body);
    r = await call("GET", `/api/events/${evA.id}/team/links`, { token: tok(co.id) });
    assert(r.status === 200 && r.body.links.every((x: any) => x.scope === "event") && r.body.links.length === 2, "a co-host sees this event's links only", r.body);
    r = await call("GET", `/api/events/${evB.id}/team/links`, { token: ht });
    assert(r.status === 200 && r.body.links.length === 1 && r.body.links[0].id === l2.id, "another event shows only the All my events link", r.body);
    r = await call("DELETE", `/api/events/${evA.id}/team/links/${l2.id}`, { token: tok(co.id) });
    assert(r.status === 403 && r.body.error.code === "HOST_ONLY", "a co-host can't cancel an All my events link", r.body);
    r = await call("DELETE", `/api/events/${evA.id}/team/links/${coLink.id}`, { token: ht });
    assert(r.status === 200 && r.body.link.status === "cancelled", "the host cancels a link", r.body);
    r = await call("DELETE", `/api/events/${evA.id}/team/links/${coLink.id}`, { token: ht });
    assert(r.status === 409 && r.body.error.code === "LINK_CLOSED", "cancelling twice is 409", r.body);
    r = await call("DELETE", `/api/events/${evB.id}/team/links/${l1.id}`, { token: ht });
    assert(r.status === 404 && r.body.error.code === "LINK_NOT_FOUND", "another event's link can't be cancelled from here", r.body);
    r = await call("GET", `/api/events/${evA.id}/team/links`, { token: ht });
    assert(!r.body.links.some((x: any) => x.id === coLink.id), "cancelled links leave the list", r.body);

    console.log("\nthe link page (public)");
    r = await call("GET", `/api/events/team-links/${l1.code}`);
    const pv = r.body?.link;
    assert(r.status === 200 && pv.status === "open" && pv.role === "security" && pv.scope === "event" && pv.host?.name && pv.event?.id === evA.id && pv.event.title === `${P} Alpha`, "anyone can see what the link is", r.body);
    assert(pv.pay?.fixedCents === 16000 && pv.yours === false && pv.isHost === false, "with the pay, not yours", pv);
    assert(!("code" in pv) && !("id" in pv) && !/test\.local|sent_to|createdBy/i.test(r.raw), "no code, id, email or who made it", r.raw.slice(0, 300));
    r = await call("GET", `/api/events/team-links/${l1.code.toLowerCase()}`);
    assert(r.status === 200, "a lowercase code still opens", r.status);
    r = await call("GET", `/api/events/team-links/${l1.code}`, { token: ht });
    assert(r.body.link.isHost === true, "the host is told it's their own link", r.body);
    r = await call("GET", `/api/events/team-links/ABCDEFGHJKLM`);
    assert(r.status === 404 && r.body.error.code === "LINK_NOT_FOUND", "unknown code is 404", r.body);
    r = await call("GET", `/api/events/team-links/NOT-A-CODE`);
    assert(r.status === 404, "a malformed code is 404", r.status);
    r = await call("GET", `/api/events/team-links/${coLink.code}`);
    assert(r.status === 200 && r.body.link.status === "cancelled", "a cancelled link says so", r.body);
    r = await call("GET", `/api/events/team-links/${l2.code}`);
    assert(r.body.link.scope === "standing" && r.body.link.event === null && Array.isArray(r.body.link.upcoming) && r.body.link.upcoming.some((e: any) => e.id === evA.id), "an All my events link lists upcoming events", r.body);

    console.log("\naccepting");
    pushes.length = 0;
    r = await call("POST", `/api/events/team-links/${l1.code}/accept`, { token: ht });
    assert(r.status === 400 && r.body.error.code === "CANNOT_ADD_HOST", "the host can't take their own link", r.body);
    r = await call("POST", `/api/events/team-links/${l1.code}/accept`);
    assert(r.status === 401, "accepting needs sign in", r.status);
    r = await call("POST", `/api/events/team-links/${l1.code}/accept`, { token: tok(ana.id) });
    await sleep(300);
    assert(r.status === 200 && r.body.invite?.status === "accepted" && r.body.invite.role === "security" && r.body.invite.scope === "event", "Ana takes the Security spot", r.body);
    const [memRow] = await q(`SELECT * FROM event_door_members WHERE event_id = $1 AND member_user_id = $2 AND role = 'security'`, [evA.id, ana.id]);
    assert(!!memRow?.accepted_at && memRow.removed_at === null && memRow.added_by_user_id === host.id, "a normal accepted team row, added by who made the link", memRow);
    const [payRow] = await q(`SELECT * FROM event_team_pay WHERE event_id = $1 AND member_user_id = $2 AND role = 'security'`, [evA.id, ana.id]);
    assert(payRow?.pay_type === "fixed" && payRow.fixed_cents === 16000 && payRow.updated_by_user_id === host.id, "the link's pay becomes theirs", payRow);
    const [l1Row] = await q(`SELECT * FROM event_team_links WHERE id = $1`, [l1.id]);
    assert(l1Row.status === "accepted" && l1Row.accepted_by_user_id === ana.id && l1Row.accepted_invite_id === memRow.id, "the link records who took it", l1Row);
    assert(pushes.some((p) => p.userId === host.id && p.data?.type === "team_accepted" && p.data.eventId === evA.id), "the host gets the usual joined push", pushes);
    r = await call("POST", `/api/events/team-links/${l1.code}/accept`, { token: tok(ana.id) });
    assert(r.status === 200 && r.body.invite.status === "accepted", "accepting again is fine for the same person", r.body);
    r = await call("POST", `/api/events/team-links/${l1.code}/accept`, { token: tok(bo.id) });
    assert(r.status === 409 && r.body.error.code === "LINK_CLOSED", "someone else can't use a taken link", r.body);
    r = await call("GET", `/api/events/team-links/${l1.code}`, { token: tok(ana.id) });
    assert(r.body.link.status === "accepted" && r.body.link.yours === true, "the link page shows it's theirs now", r.body);
    r = await call("GET", `/api/events/${evA.id}/team/links`, { token: ht });
    assert(!r.body.links.some((x: any) => x.id === l1.id), "taken links leave the open list", r.body);
    r = await call("GET", `/api/events/${evA.id}/team/me`, { token: tok(ana.id) });
    assert(r.status === 200 && r.body.roles.some((x: any) => x.role === "security" && x.pay?.payType === "fixed" && x.pay.fixedCents === 16000), "their event page shows the role and pay", r.body);

    console.log("\ntwo people at once");
    r = await make(evA.id, { scope: "event", role: "door" });
    const race = r.body.link;
    const both = await Promise.all([bo, cy].map((u) => call("POST", `/api/events/team-links/${race.code}/accept`, { token: tok(u.id) })));
    const codes = both.map((x) => x.status).sort();
    assert(codes.join() === "200,409", "two people at once: exactly one gets it", codes);
    const winners = await q(`SELECT member_user_id FROM event_door_members WHERE event_id = $1 AND role = 'door' AND accepted_at IS NOT NULL AND member_user_id = ANY($2)`, [evA.id, [bo.id, cy.id]]);
    assert(winners.length === 1, "and only one team row", winners);

    console.log("\nalready on the team");
    r = await make(evA.id, { scope: "event", role: "security" });
    const dup = r.body.link;
    r = await call("POST", `/api/events/team-links/${dup.code}/accept`, { token: tok(ana.id) });
    assert(r.status === 409 && r.body.error.code === "ALREADY_ON_TEAM" && r.body.error.message === "You're already on this Event team as Security.", "already Security here: refused, in their own words", r.body);
    const [dupRow] = await q(`SELECT status, accepted_by_user_id FROM event_team_links WHERE id = $1`, [dup.id]);
    assert(dupRow.status === "open" && dupRow.accepted_by_user_id === null, "already on the team: the link stays open", dupRow);
    r = await call("POST", `/api/events/team-links/${dup.code}/accept`, { token: tok(di.id) });
    assert(r.status === 200, "and someone else can still take it", r.body);

    console.log("\nthe same person, two links for one role at once");
    let stuck = 0, rowsOk = true, openLeft = 0;
    for (let i = 0; i < 8; i++) {
      // Its own host, so these 16 links don't use up the first host's 30 invites an hour.
      const ev = await mkEvent(24 + i, 30 + i, `${P} Race ${i}`, "published", host2.id);
      const a = (await make(ev.id, { scope: "event", role: "entertainment" }, tok(host2.id))).body.link;
      const b = (await make(ev.id, { scope: "event", role: "entertainment" }, tok(host2.id))).body.link;
      await Promise.all([a, b].map((x) => call("POST", `/api/events/team-links/${x.code}/accept`, { token: tok(di.id) })));
      stuck += Number((await q(`SELECT count(*)::int AS n FROM event_team_links WHERE id = ANY($1) AND status = 'accepted' AND accepted_invite_id IS NULL`, [[a.id, b.id]]))[0].n);
      openLeft += Number((await q(`SELECT count(*)::int AS n FROM event_team_links WHERE id = ANY($1) AND status = 'open'`, [[a.id, b.id]]))[0].n);
      const n = (await q(`SELECT 1 FROM event_door_members WHERE event_id = $1 AND member_user_id = $2 AND role = 'entertainment' AND removed_at IS NULL`, [ev.id, di.id])).length;
      if (n !== 1) rowsOk = false;
    }
    assert(stuck === 0, "no link is ever left taken without a spot behind it (the loser reopens)", stuck);
    assert(rowsOk, "and they hold exactly one spot each time");
    assert(openLeft === 8, "one of the two links stays open every time (one person never uses up two)", openLeft);

    console.log("\na pending invite in the same role");
    r = await call("POST", `/api/events/${evB.id}/door/team`, { token: ht, body: { username: bo.username, scope: "event", role: "media" } });
    assert(r.status === 201, "host invited Bo by username for Media at Beta", r.body);
    r = await make(evB.id, { scope: "event", role: "media" });
    r = await call("POST", `/api/events/team-links/${r.body.link.code}/accept`, { token: tok(bo.id) });
    const pend = await q(`SELECT accepted_at FROM event_door_members WHERE event_id = $1 AND member_user_id = $2 AND role = 'media' AND removed_at IS NULL`, [evB.id, bo.id]);
    assert(r.status === 200 && pend.length === 1 && !!pend[0].accepted_at, "the link accepts their pending invite (one row, accepted)", { r: r.body, pend });

    console.log("\nAll my events link");
    r = await call("POST", `/api/events/team-links/${l2.code}/accept`, { token: tok(cy.id) });
    const [st] = await q(`SELECT * FROM event_door_team WHERE host_user_id = $1 AND member_user_id = $2 AND role = 'door'`, [host.id, cy.id]);
    assert(r.status === 200 && r.body.invite.scope === "standing" && !!st?.accepted_at, "joins the standing team (being on one event's Admissions doesn't block it)", { r: r.body, st });

    console.log("\nends and cancels");
    const evEnds = await mkEvent(24, 26, `${P} Ends`);
    r = await make(evEnds.id, { scope: "event", role: "security" });
    const late = r.body.link;
    // A This event link ends with its event (it follows the event's own end, call 69 and review fix 4).
    await q(`UPDATE events SET starts_at = now() - interval '3 hours', ends_at = now() - interval '1 minute' WHERE id = $1`, [evEnds.id]);
    r = await call("POST", `/api/events/team-links/${late.code}/accept`, { token: tok(bo.id) });
    assert(r.status === 409 && r.body.error.code === "LINK_CLOSED", "an expired link can't be taken", r.body);
    r = await call("GET", `/api/events/team-links/${late.code}`);
    assert(r.body.link.status === "expired", "and says expired", r.body);
    r = await call("POST", `/api/events/team-links/${coLink.code}/accept`, { token: tok(bo.id) });
    assert(r.status === 409 && r.body.error.code === "LINK_CLOSED", "a cancelled link can't be taken", r.body);
    r = await make(evB.id, { scope: "event", role: "security" });
    const cancelledEvent = r.body.link;
    await q(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [evB.id]);
    r = await call("POST", `/api/events/team-links/${cancelledEvent.code}/accept`, { token: tok(cy.id) });
    assert(r.status === 409 && r.body.error.code === "LINK_CLOSED", "a cancelled event's link can't be taken", r.body);
    await q(`UPDATE events SET status = 'published' WHERE id = $1`, [evB.id]);

    console.log("\nreview fixes");
    // Bug 1: a retry after a half finished accept finishes it and never reopens the link.
    r = await make(evA.id, { scope: "event", role: "media", pay: { payType: "fixed", fixedCents: 9000 } });
    const half = r.body.link;
    await q(`UPDATE event_team_links SET status = 'accepted', accepted_at = now(), accepted_by_user_id = $2 WHERE id = $1`, [half.id, cy.id]);
    const [cyRow] = await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, accepted_at) VALUES ($1, $2, $3, 'media', now()) RETURNING id`, [evA.id, cy.id, host.id]);
    r = await call("POST", `/api/events/team-links/${half.code}/accept`, { token: tok(cy.id) });
    const [halfRow] = await q(`SELECT status, accepted_by_user_id, accepted_invite_id FROM event_team_links WHERE id = $1`, [half.id]);
    assert(r.status === 200 && r.body.invite?.status === "accepted" && halfRow.status === "accepted" && halfRow.accepted_invite_id === cyRow.id, "a retry after a half finished accept finishes it (never reopens)", { r: r.body, halfRow });
    r = await call("POST", `/api/events/team-links/${half.code}/accept`, { token: tok(bo.id) });
    assert(r.status === 409 && r.body.error.code === "LINK_CLOSED", "and nobody else can take it", r.body);
    // Bug 4: a This event link follows the event's own end time.
    const evMove = await mkEvent(24, 26, `${P} Moves`);
    r = await make(evMove.id, { scope: "event", role: "security" });
    const mv = r.body.link;
    await q(`UPDATE events SET ends_at = now() + interval '40 hours' WHERE id = $1`, [evMove.id]);
    await q(`UPDATE event_team_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [mv.id]);
    r = await call("GET", `/api/events/team-links/${mv.code}`);
    assert(r.body.link.status === "open", "the event moved later: its link is still open", r.body);
    r = await call("GET", `/api/events/${evMove.id}/team/links`, { token: ht });
    assert(r.body.links.some((x: any) => x.id === mv.id && new Date(x.expiresAt).getTime() > Date.now() + 39 * 3600_000), "and listed with the event's new end", r.body);
    r = await call("POST", `/api/events/team-links/${mv.code}/accept`, { token: tok(bo.id) });
    assert(r.status === 200, "and can be taken", r.body);
    // Bug 5: a co-host can't take a link they made.
    r = await make(evA.id, { scope: "event", role: "security" }, tok(co.id));
    const own = r.body.link;
    r = await call("POST", `/api/events/team-links/${own.code}/accept`, { token: tok(co.id) });
    assert(r.status === 400 && r.body.error.code === "CANNOT_ADD_SELF", "whoever made a link can't take it", r.body);
    const [ownRow] = await q(`SELECT status FROM event_team_links WHERE id = $1`, [own.id]);
    assert(ownRow.status === "open", "and it stays open", ownRow);
    // Review 7: a closed link's page shows no event or pay to strangers.
    r = await call("GET", `/api/events/team-links/${l1.code}`, { token: tok(bo.id) });
    assert(r.body.link.status === "accepted" && r.body.link.event === null && r.body.link.pay === null && r.body.link.upcoming.length === 0, "a taken link shows no event or pay to someone else", r.body);
    r = await call("GET", `/api/events/team-links/${l1.code}`, { token: tok(ana.id) });
    assert(r.body.link.event?.id === evA.id && r.body.link.pay?.fixedCents === 16000, "but the person who took it still sees theirs", r.body);
    // Second review: a double tap gets the spot on both answers; someone taken off later isn't told they're on.
    r = await make(evA.id, { scope: "event", role: "media" });
    const tap = r.body.link;
    const taps = await Promise.all([1, 2].map(() => call("POST", `/api/events/team-links/${tap.code}/accept`, { token: tok(ana.id) })));
    assert(taps.every((x) => x.status === 200 && x.body.invite?.status === "accepted"), "a double tap: both answers say they're on the team", taps.map((x) => x.body));
    await q(`UPDATE event_door_members SET removed_at = now(), removed_by_user_id = $3 WHERE event_id = $1 AND member_user_id = $2 AND role = 'media'`, [evA.id, ana.id, host.id]);
    r = await call("POST", `/api/events/team-links/${tap.code}/accept`, { token: tok(ana.id) });
    assert(r.status === 409 && r.body.error.code === "NOT_ON_TEAM", "taken off after joining: the link doesn't say they're on", r.body);
    // Review 9: All my events links can be made from an ended event's page (same as username invites).
    r = await make(evOver.id, { scope: "standing", role: "door" });
    assert(r.status === 201 && r.body.link.scope === "standing", "an All my events link from an ended event's page", r.body);
    const { renderDoorTeamInvite } = await import("../emailService");
    const mail = renderDoorTeamInvite({ toEmail: "x@y.co", firstName: null, hostName: "Hosty", scope: "event", eventTitle: "T", whenText: null, doorUrl: "https://goutsyde.test/team/AAAAAAAAAAAA", role: "door", newcomer: true });
    const plain = renderDoorTeamInvite({ toEmail: "x@y.co", firstName: null, hostName: "Hosty", scope: "event", eventTitle: "T", whenText: null, doorUrl: "https://goutsyde.test/events/door", role: "door" });
    assert(/See the invite/.test(mail.html) && /New to Outsyde\?/.test(mail.html) && !/Accept or decline/.test(mail.html), "a link email says See the invite and welcomes someone new", null);
    assert(/Accept or decline/.test(plain.html) && !/New to Outsyde/.test(plain.html), "a username invite email is unchanged", null);
    assert(!/[\u2013\u2014]/.test(mail.html) && !/ - /.test(mail.html.replace(/<[^>]+>/g, "")), "no dashes in the email copy", null);

    console.log("\nemail (67b)");
    emails.length = 0;
    r = await make(evA.id, { scope: "event", role: "door", email: "New.Person@Example.com" });
    assert(r.status === 201 && r.body.emailed === true && r.body.link.sentToEmail === "new.person@example.com", "emailed, stored lowercase", r.body);
    assert(emails.length === 1 && emails[0].toEmail === "new.person@example.com" && emails[0].doorUrl === r.body.link.url && emails[0].newcomer === true && emails[0].firstName === null, "the email holds that person's own link", emails);
    const accounts = await q(`SELECT 1 FROM event_door_members m JOIN users u ON u.id = m.member_user_id WHERE lower(u.email) = 'new.person@example.com'`);
    assert(accounts.length === 0, "no account is matched by email", accounts);
    r = await call("GET", `/api/events/team-links/${r.body.link.code}`);
    assert(!/new\.person/i.test(r.raw), "the link page never shows the email", r.raw.slice(0, 200));
    r = await make(evA.id, { scope: "event", role: "door", email: `${ana.username}@test.local` });
    assert(r.status === 201 && emails.length === 2, "an email that has an account gets the same link email (host can't tell)", r.body);
    const [emailedRow] = await q(`SELECT member_user_id FROM event_door_members WHERE event_id = $1 AND member_user_id = $2 AND role = 'door'`, [evA.id, ana.id]);
    assert(!emailedRow, "and no team row is made for that account", emailedRow);
    // Fill the host's day: 2 link emails so far today, plus older door invite emails from this host.
    const todayEmails = Number((await q(`SELECT
        (SELECT count(*) FROM event_team_links WHERE host_user_id = $1 AND email_sent_at IS NOT NULL)
      + (SELECT count(*) FROM event_door_members m JOIN events e ON e.id = m.event_id WHERE e.host_user_id = $1 AND m.invite_emailed_at IS NOT NULL)
      + (SELECT count(*) FROM event_door_team WHERE host_user_id = $1 AND invite_emailed_at IS NOT NULL) AS n`, [host.id]))[0].n);
    for (let i = todayEmails; i < 10; i++) {
      r = await make(evA.id, { scope: "event", role: "door", email: `fill${i}@example.com` });
      if (r.body.emailed !== true) { assert(false, `email ${i + 1} of the day is sent`, r.body); break; }
    }
    const before = emails.length;
    r = await make(evA.id, { scope: "event", role: "door", email: "eleventh@example.com" });
    assert(r.status === 201 && r.body.emailed === false && emails.length === before, "the 11th email of the day isn't sent (the link is still made)", r.body);
    r = await call("POST", `/api/events/${evA.id}/door/team`, { token: ht, body: { username: di.username, scope: "event", role: "media" } });
    await sleep(300);
    assert(r.status === 201 && emails.length === before, "a username invite email counts toward the same 10", emails.length - before);

    console.log("\nold answers unchanged");
    r = await call("GET", `/api/events/${evA.id}/door/team`, { token: ht });
    assert(r.status === 200 && !("links" in r.body), "GET /door/team has no new keys", Object.keys(r.body ?? {}));
  } finally {
    srv.close();
    setNoticeDepsForTest(null);
    await q(`DELETE FROM event_team_links WHERE host_user_id = ANY($1)`, [[host.id, host2.id]]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
