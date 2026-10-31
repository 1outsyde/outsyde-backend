/**
 * p4-team step 5: host messages to the event team (Legend 2026-10-30, decision 10, calls 27 and 30 to 33).
 * Personal messages only (group chat is a later step):
 *   - the host or a co-host sends to the whole team, one role, or one person;
 *   - each person gets it in their own Messages thread with the sender (a normal messages row, marked read so the
 *     Activity item is the one unread), plus one push that opens that thread and one Activity item;
 *   - whole team = accepted (co-hosts too; the host when a co-host sends), never pending, declined, taken off,
 *     blocked either way, or the sender;
 *   - from publishing until 3 days after the event; text 1 to 1,000 characters; the same text twice in a row refused.
 *
 * Run in process: EV_TEST_PG_URL=<local> DATABASE_URL=<local>
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/events/teamMessages.http.test.ts
 * SCRATCH ONLY: refuses any non-local database. Nothing reaches Expo or Resend.
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

  const express = (await import("express")).default;
  const notices = await import("./ticketNotices");
  const pushes: any[] = [];
  const activity: any[] = [];
  notices.setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; },
    createActivity: async (p: any) => { activity.push(p); },
    sendDoorInvite: async () => {}, sendOwedReminder: async () => {}, sendTeamSetupReminder: async () => {},
  } as any);
  const app = express();
  app.use(express.json());
  app.use("/api/events", (await import("./doorRouter")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `tm${Date.now().toString(36)}`;
  const allEvents: string[] = [];
  const allUsers: string[] = [];
  const user = async (s: string) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, username],
    ))[0].id as string;
    allUsers.push(id);
    return { id, username, first: `First${s}` };
  };
  const event = async (host: { id: string }, slug: string, o: { startsIn?: string; endedAgo?: string; status?: string } = {}) => {
    const when = o.endedAgo
      ? `now() - ($5::interval + interval '5 hours'), now() - $5::interval`
      : `now() + $5::interval, now() + $5::interval + interval '5 hours'`;
    const e = (await q(
      `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at)
       VALUES ($1, $2, $3, $4, ${when}, 'America/New_York', now() - interval '5 days') RETURNING id, title`,
      [host.id, `${P}-${slug}`, `${P} ${slug}`, o.status ?? "published", o.endedAgo ?? o.startsIn ?? "3 days"],
    ))[0] as { id: string; title: string };
    allEvents.push(e.id);
    return e;
  };
  const member = async (eventId: string, host: { id: string }, u: { id: string }, role: string, o: { state?: "accepted" | "pending" | "declined" | "removed"; level?: string } = {}) => {
    const st = o.state ?? "accepted";
    return (await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, cohost_level, invited_at, accepted_at, declined_at, removed_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '2 days',
         ${st === "accepted" || st === "removed" ? "now() - interval '1 day'" : "NULL"},
         ${st === "declined" ? "now() - interval '1 day'" : "NULL"},
         ${st === "removed" ? "now() - interval '1 hour'" : "NULL"}) RETURNING id`,
      [eventId, u.id, host.id, role, role === "cohost" ? (o.level ?? "team") : null]))[0].id as string;
  };
  const standing = (host: { id: string }, u: { id: string }, role: string) =>
    q(`INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id, role, invited_at, accepted_at)
       VALUES ($1, $2, $1, $3, now() - interval '2 days', now() - interval '1 day')`, [host.id, u.id, role]);
  const send = (eventId: string, as: { id: string }, body: unknown) => call("POST", `/api/events/${eventId}/team/messages`, { token: tok(as.id), body });
  /** The Messages thread between two people (either order) and its messages. */
  const thread = async (a: string, b: string) => {
    const [c] = await q(`SELECT * FROM conversations WHERE (participant1_id = $1 AND participant2_id = $2) OR (participant1_id = $2 AND participant2_id = $1)`, [a, b]);
    const msgs = c ? await q(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [c.id]) : [];
    return { c, msgs };
  };
  const pushesTo = (id: string) => pushes.filter((p) => p.userId === id);

  try {
    const host = await user("host");
    const e1 = await event(host, "night");
    const sec1 = await user("sec1"), sec2 = await user("sec2"), dj = await user("dj"), co = await user("co");
    const pend = await user("pend"), decl = await user("decl"), gone = await user("gone"), blk = await user("blk"), std = await user("std");
    await member(e1.id, host, sec1, "security");
    await member(e1.id, host, sec2, "security");
    await member(e1.id, host, dj, "entertainment");
    await member(e1.id, host, co, "cohost");
    await member(e1.id, host, pend, "security", { state: "pending" });
    await member(e1.id, host, decl, "security", { state: "declined" });
    await member(e1.id, host, gone, "security", { state: "removed" });
    await member(e1.id, host, blk, "door");
    await standing(host, std, "door");
    await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [blk.id, host.id]);
    // sec2 already talks to the host: the message goes into that same thread.
    const [old] = await q(`INSERT INTO conversations (participant1_id, participant2_id, last_message_preview) VALUES ($1, $2, 'hi') RETURNING id`, [sec2.id, host.id]);

    console.log("\nwhole team (call 31)");
    pushes.length = 0; activity.length = 0;
    let r = await send(e1.id, host, { to: "team", text: "  Black shirts tonight. Bag checks at the front.  " });
    assert(r.status === 201 && r.body?.message?.recipientCount === 5 && r.body?.message?.audience === "team", "sent to 5 people", r.body);
    const got = (await q(`SELECT member_user_id FROM event_team_message_recipients WHERE team_message_id = $1`, [r.body?.message?.id])).map((x: any) => x.member_user_id).sort();
    assert(JSON.stringify(got) === JSON.stringify([sec1.id, sec2.id, dj.id, co.id, std.id].sort()),
      "accepted members, the co-host and the standing team; not pending, declined, taken off, blocked or the host", got);
    const t1 = await thread(host.id, sec1.id);
    assert(t1.c && t1.msgs.length === 1 && t1.msgs[0].sender_id === host.id && t1.msgs[0].content === "Black shirts tonight. Bag checks at the front." && t1.msgs[0].is_read === true,
      "a normal message in their thread with the host, trimmed, marked read (call 27)", t1.msgs);
    assert(t1.c.last_message_preview?.startsWith("Black shirts"), "the thread shows it as the latest message", t1.c);
    const t2 = await thread(host.id, sec2.id);
    assert(t2.c?.id === old.id && t2.msgs.length === 1, "an existing thread is reused, not a second one", t2);
    const p1 = pushesTo(sec1.id);
    assert(p1.length === 1 && p1[0].title === "From Person host" && p1[0].body.startsWith("Black shirts") && p1[0].data?.type === "new_message" && p1[0].data?.conversationId === t1.c.id,
      "one push: From [host], opens that thread in today's app", p1);
    assert(!DASH.test(p1[0]?.title ?? "") && !DASH.test(p1[0]?.body ?? ""), "no dashes in the push");
    const a1 = activity.filter((x) => x.userId === sec1.id);
    assert(a1.length === 1 && a1[0].type === "team_message" && a1[0].title === p1[0]?.title && a1[0].metadata?.eventId === e1.id && a1[0].metadata?.conversationId === t1.c.id,
      "one Activity item for the event", a1);
    assert(pushesTo(host.id).length === 0 && pushesTo(blk.id).length === 0 && pushesTo(pend.id).length === 0, "nothing to the sender, the blocked person or pending invites");

    console.log("\nthe same text twice in a row is refused (call 33)");
    r = await send(e1.id, host, { to: "team", text: "Black shirts tonight. Bag checks at the front." });
    assert(r.status === 409 && r.body?.error?.code === "DUPLICATE_MESSAGE" && !DASH.test(r.body?.error?.message ?? ""), "refused", r.body);

    console.log("\none role");
    pushes.length = 0;
    r = await send(e1.id, host, { to: "role", role: "security", text: "Front door until 11, then move to the back door." });
    assert(r.status === 201 && r.body?.message?.recipientCount === 2, "2 Security", r.body);
    assert(pushesTo(sec1.id).length === 1 && pushesTo(sec2.id).length === 1 && pushesTo(dj.id).length === 0 && pushesTo(co.id).length === 0, "only Security", pushes.map((p) => p.userId));
    r = await send(e1.id, host, { to: "role", role: "media", text: "Anyone here?" });
    assert(r.status === 409 && r.body?.error?.code === "NO_RECIPIENTS", "a role with nobody on it: refused", r.body);
    r = await send(e1.id, host, { to: "role", role: "bouncer", text: "x" });
    assert(r.status === 400, "unknown role refused", r.body);
    r = await send(e1.id, host, { to: "role", text: "x" });
    assert(r.status === 400, "role needed", r.body);

    console.log("\none person");
    pushes.length = 0;
    r = await send(e1.id, host, { to: "person", userId: dj.id, text: "Load in at 8, side door." });
    assert(r.status === 201 && r.body?.message?.recipientCount === 1 && pushesTo(dj.id).length === 1 && pushes.length === 1, "just them", r.body);
    r = await send(e1.id, host, { to: "person", userId: pend.id, text: "Hello?" });
    assert(r.status === 404 && r.body?.error?.code === "NOT_ON_TEAM", "someone who hasn't accepted: not on the team", r.body);
    r = await send(e1.id, host, { to: "person", userId: blk.id, text: "Hello?" });
    assert(r.status === 409 && r.body?.error?.code === "NO_RECIPIENTS", "blocked: nobody to send to", r.body);
    r = await send(e1.id, host, { to: "person", text: "x" });
    assert(r.status === 400, "userId needed", r.body);

    console.log("\nwho can send (call 30)");
    pushes.length = 0;
    r = await send(e1.id, co, { to: "team", text: "Co-host here: doors at 9." });
    assert(r.status === 201 && r.body?.message?.recipientCount === 6 && pushesTo(blk.id).length === 1,
      "a co-host can: the host gets it, the co-host doesn't (and the person who blocked only the host does)", r.body);
    assert(pushesTo(host.id).length === 1 && pushesTo(co.id).length === 0 && pushesTo(host.id)[0]?.title === "From Person co", "sent by the co-host's own name", pushesTo(host.id));
    r = await send(e1.id, sec1, { to: "team", text: "Hi all" });
    assert(r.status === 404, "a member can't message the team", r.status);
    r = await send(e1.id, pend, { to: "team", text: "Hi all" });
    assert(r.status === 404, "nor can a stranger", r.status);
    r = await call("POST", `/api/events/${e1.id}/team/messages`, { body: { to: "team", text: "x" } });
    assert(r.status === 401, "signed in only", r.status);

    console.log("\nwhat a message can hold (call 33)");
    r = await send(e1.id, host, { to: "team", text: "   " });
    assert(r.status === 400, "empty refused", r.body);
    r = await send(e1.id, host, { to: "team", text: "x".repeat(1001) });
    assert(r.status === 400, "over 1,000 characters refused", r.body);
    r = await send(e1.id, host, { to: "team", text: "y".repeat(1000) });
    assert(r.status === 201, "1,000 is fine", r.status);
    r = await send(e1.id, host, { to: "team", text: "ok", mediaItems: ["https://x/y.jpg"] });
    assert(r.status === 400, "no photos yet", r.body);
    r = await send(e1.id, host, { to: "everyone", text: "ok" });
    assert(r.status === 400, "unknown audience refused", r.body);

    console.log("\nwhen (call 32)");
    const e2 = await event(host, "recent", { endedAgo: "2 days" });
    const m2 = await user("m2"); await member(e2.id, host, m2, "security");
    r = await send(e2.id, host, { to: "team", text: "Thanks everyone." });
    assert(r.status === 201, "up to 3 days after the event: allowed", r.body);
    const e3 = await event(host, "old", { endedAgo: "3 days 1 hour" });
    const m3 = await user("m3"); await member(e3.id, host, m3, "security");
    r = await send(e3.id, host, { to: "team", text: "Late thanks." });
    assert(r.status === 409 && r.body?.error?.code === "MESSAGES_CLOSED" && !DASH.test(r.body?.error?.message ?? ""), "after payout day: closed", r.body);
    const e4 = await event(host, "draft", { status: "draft" });
    const m4 = await user("m4"); await member(e4.id, host, m4, "security");
    r = await send(e4.id, host, { to: "team", text: "Early note." });
    assert(r.status === 409 && r.body?.error?.code === "MESSAGES_CLOSED", "not published yet: closed", r.body);
    const e5 = await event(host, "cancelled", { status: "cancelled" });
    const m5 = await user("m5"); await member(e5.id, host, m5, "security");
    r = await send(e5.id, host, { to: "team", text: "Sorry." });
    assert(r.status === 409 && r.body?.error?.code === "MESSAGES_CLOSED", "cancelled: closed", r.body);

    console.log("\nwhat each side sees");
    r = await call("GET", `/api/events/${e1.id}/team/messages`, { token: tok(host.id) });
    const sent = r.body?.messages ?? [];
    assert(r.status === 200 && sent.length === 5 && sent[0].text.startsWith("y") && sent.some((m: any) => m.audience === "role" && m.role === "security" && m.recipientCount === 2)
      && sent.some((m: any) => m.audience === "person" && m.to?.userId === dj.id) && sent.some((m: any) => m.from?.userId === co.id),
      "host: every message sent for the event, newest first, with who it went to", sent);
    r = await call("GET", `/api/events/${e1.id}/team/messages`, { token: tok(co.id) });
    assert(r.status === 200 && (r.body?.messages ?? []).length === 5, "co-host sees them too", r.status);
    r = await call("GET", `/api/events/${e1.id}/team/messages`, { token: tok(sec1.id) });
    assert(r.status === 404, "a member can't see the sent list", r.status);
    r = await call("GET", `/api/events/${e1.id}/team/me`, { token: tok(sec1.id) });
    const fh = r.body?.fromHost ?? [];
    assert(r.status === 200 && fh.length === 4 && fh[0].text.startsWith("y") && fh.some((m: any) => m.text.startsWith("Front door")) && !fh.some((m: any) => m.text.startsWith("Load in"))
      && fh.every((m: any) => typeof m.at === "string" && m.from?.name), "Security: From the host lists only what was sent to them, newest first", fh);
    r = await call("GET", `/api/events/${e1.id}/team/me`, { token: tok(dj.id) });
    assert((r.body?.fromHost ?? []).some((m: any) => m.text.startsWith("Load in")) && !(r.body?.fromHost ?? []).some((m: any) => m.text.startsWith("Front door")), "the DJ sees theirs", r.body?.fromHost);
  } catch (err) {
    failed++;
    console.error("  ❌ crashed:", err);
  } finally {
    try {
      const ev = allEvents, us = allUsers;
      await q(`DELETE FROM event_team_message_recipients WHERE team_message_id IN (SELECT id FROM event_team_messages WHERE event_id = ANY($1))`, [ev]);
      await q(`DELETE FROM event_team_messages WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1))`, [us]);
      await q(`DELETE FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [us]);
      await q(`DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`, [us]);
      await q(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM event_door_team WHERE host_user_id = ANY($1)`, [us]);
      await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [us]).catch(() => {});
      await q(`DELETE FROM events WHERE id = ANY($1)`, [ev]);
      await q(`DELETE FROM users WHERE id = ANY($1)`, [us]).catch((e) => console.error("cleanup users:", e.message));
    } catch (e) {
      console.error("cleanup failed:", (e as Error).message);
    }
    await db.end();
    srv.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
