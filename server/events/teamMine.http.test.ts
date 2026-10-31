/**
 * p4-team step 8: GET /door/mine?roles=all lists every event I'm on the team for, in any role, with my roles (the
 * website's Event team page). Without ?roles=all the answer is exactly as before (Admissions only, old app builds).
 * Run: EV_TEST_PG_URL=<local> DATABASE_URL=<local> NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/events/teamMine.http.test.ts
 */
import http from "http";

const PG_URL = process.env.EV_TEST_PG_URL;
let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set EV_TEST_PG_URL to run"); process.exit(0); }
  if (!isLocal(PG_URL)) throw new Error("refusing to run: PG_URL must be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/events", (await import("./doorRouter")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (path: string, id: string) => {
    const r = await fetch(new URL(path, BASE), { headers: { Authorization: `Bearer ${tok(id)}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const P = `tm${Date.now().toString(36)}`;
  const users: string[] = [], events: string[] = [];
  const user = async (s: string) => {
    const id = (await q(`INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, `${P}${s}`.slice(0, 24)]))[0].id as string;
    users.push(id); return id;
  };
  const event = async (host: string, slug: string, startsIn: string, endsIn: string, status = "published") => {
    const id = (await q(`INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at)
      VALUES ($1, $2, $3, $4, now() + $5::interval, now() + $6::interval, 'America/New_York', now() - interval '10 days') RETURNING id`,
      [host, `${P}-${slug}`, `${P} ${slug}`, status, startsIn, endsIn]))[0].id as string;
    events.push(id); return id;
  };
  const member = (eventId: string, host: string, u: string, role: string, o: { label?: string; pending?: boolean; removed?: boolean } = {}) =>
    q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, role_label, cohost_level, invited_at, accepted_at, removed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - interval '5 days', $7, $8) RETURNING id`,
      [eventId, u, host, role, o.label ?? null, role === "cohost" ? "team" : null, o.pending ? null : new Date(Date.now() - 4 * 86400e3), o.removed ? new Date() : null]);
  const standing = (host: string, u: string, role: string) =>
    q(`INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id, role, invited_at, accepted_at)
       VALUES ($1, $2, $1, $3, now() - interval '5 days', now() - interval '4 days') RETURNING id`, [host, u, role]);

  try {
    const host = await user("host"), me = await user("me"), other = await user("other");
    const a = await event(host, "a", "2 days", "2 days 5 hours");       // Security + Admissions here
    const b = await event(host, "b", "3 days", "3 days 5 hours");       // standing Promoter covers it
    const c = await event(other, "c", "4 days", "4 days 5 hours");      // pending invite: not listed
    const d = await event(other, "d", "-3 days", "-3 days 5 hours");    // ended 2 days ago, Media: listed (pay after)
    const old = await event(other, "old", "-30 days", "-30 days 5 hours"); // ended long ago: not listed
    const gone = await event(other, "gone", "5 days", "5 days 5 hours"); // removed: not listed
    const cx = await event(other, "cx", "6 days", "6 days 5 hours", "cancelled");
    const mine = await event(me, "mine", "1 day", "1 day 5 hours");     // I host it
    const host2 = await user("host2");
    const before = await event(host2, "before", "-3 days", "-3 days 5 hours"); // ended before I joined host2's team: not listed
    await member(a, host, me, "security"); await member(a, host, me, "door");
    await standing(host, me, "host");
    await member(c, other, me, "media", { pending: true });
    await member(d, other, me, "media");
    await member(old, other, me, "other", { label: "Coat check" });
    await member(gone, other, me, "security", { removed: true });
    await member(cx, other, me, "security");
    await q(`INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id, role, invited_at, accepted_at)
       VALUES ($1, $2, $1, 'security', now() - interval '2 days', now() - interval '1 day')`, [host2, me]);

    console.log("\nwithout ?roles=all: exactly as before");
    let r = await get("/api/events/door/mine", me);
    const ids = r.body?.events?.map((e: any) => e.id) ?? [];
    assert(r.status === 200 && ids.length === 2 && ids.includes(mine) && ids.includes(a) && r.body.events.every((e: any) => e.team === undefined),
      "my event and the Admissions one only, no new fields", r.body);

    console.log("\nwith ?roles=all");
    r = await get("/api/events/door/mine?roles=all", me);
    const by = new Map((r.body?.events ?? []).map((e: any) => [e.id, e]));
    assert(r.status === 200 && by.size === 4 && [mine, a, b, d].every((x) => by.has(x)), "mine, both of my teams' upcoming events, and one that ended this week", Array.from(by.keys()));
    const ea: any = by.get(a);
    assert(ea?.team?.length === 3 && ea.team.some((t: any) => t.role === "door" && t.scope === "event" && typeof t.inviteId === "string")
      && ea.team.some((t: any) => t.role === "security") && ea.team.some((t: any) => t.role === "host" && t.scope === "standing")
      && ea.canScan === true && ea.ended === false, "Security and Admissions here plus the standing Promoter spot, can scan (Admissions)", ea);
    const eb: any = by.get(b);
    assert(eb?.team?.length === 1 && eb.team[0].role === "host" && eb.team[0].scope === "standing" && eb.canScan === false, "standing Promoter: every event of that host, no scanner", eb);
    const ed: any = by.get(d);
    assert(ed?.ended === true && ed.team[0].role === "media", "ended 2 days ago: still listed so they can see their pay", ed);
    const em: any = by.get(mine);
    assert(em?.role === "host" && em.team.length === 0 && em.canScan === true, "my own event", em);
    assert(!by.has(c) && !by.has(old) && !by.has(gone) && !by.has(cx), "not pending, long ended, removed or cancelled", null);
    assert(!by.has(before), "a standing spot doesn't reach events that ended before I joined (review M14)", null);
  } catch (err) {
    failed++; console.error("  ❌ crashed:", err);
  } finally {
    for (const [t, args] of [
      [`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [events]],
      [`DELETE FROM event_door_team WHERE member_user_id = ANY($1)`, [users]],
      [`DELETE FROM events WHERE id = ANY($1)`, [events]],
      [`DELETE FROM users WHERE id = ANY($1)`, [users]],
    ] as const) await q(t, args as unknown as unknown[]).catch((e) => console.error("cleanup:", e.message));
    await db.end(); srv.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
