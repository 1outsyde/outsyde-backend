/**
 * Events door check-in Task 1: door access rules (in-process, no server route).
 *
 * Run with: .superpowers/sdd/2026-10-22-events-list-day-of-address/env/run-suite.sh server/events/doorAccess.http.test.ts
 * SCRATCH ONLY. Needs a LOCAL scratch Postgres with migrations through 067 (EV_TEST_PG_URL, localhost only) and
 * DATABASE_URL pointing at the same database (the neon shim preload), so doorAccess runs in this process.
 * Skips (exit 0) when EV_TEST_PG_URL is unset.
 *
 * Mutation checks:
 *  - drop `now() < e.ends_at` in the event member branch → "event member denied after ends_at" fails.
 *  - drop `removed_at IS NULL` in either team query → "removed member denied" / "removed event member denied" fails.
 *  - drop the is_active check → "inactive member denied" fails.
 *  - drop `accepted_at IS NOT NULL` (p4-scanner, migration 075) in either branch → "pending ... denied" fails.
 */
const PG_URL = process.env.EV_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set EV_TEST_PG_URL (+ DATABASE_URL via the shim) to run"); process.exit(0); }
  if (!isLocal(PG_URL)) throw new Error("refusing to run: PG_URL must be localhost");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const { loadEventForDoor, isWithinScanWindow } = await import("./doorAccess");

  const P = `dr${Date.now().toString(36)}`;
  const mkUser = async (s: string, active = true) => (await q(
    `INSERT INTO users (id, email, name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [`${P}-${s}@test.local`, `Person ${s}`, `${P}${s}`.slice(0, 20), active],
  ))[0].id as string;
  const host = await mkUser("host");
  const otherHost = await mkUser("ohost");
  const standing = await mkUser("stand");
  const removedStanding = await mkUser("rstand");
  const evMember = await mkUser("evm");
  const removedEv = await mkUser("revm");
  const stranger = await mkUser("str");
  const inactive = await mkUser("inact", false);
  const otherStanding = await mkUser("ostand");
  const pendStanding = await mkUser("pstand");
  const declStanding = await mkUser("dstand");
  const pendEv = await mkUser("pevm");
  const declEv = await mkUser("devm");

  const mkEvent = async (hostId: string, startsH: number, endsH: number, status = "published") => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, now() + ($6 || ' hours')::interval, 'America/New_York') RETURNING id`,
    [hostId, `${P}-${Math.random().toString(36).slice(2, 8)}`, `${P} event`, status, String(startsH), String(endsH)],
  ))[0].id as string;
  const live = await mkEvent(host, -1, 2);
  const ended = await mkEvent(host, -5, -1);
  const otherHostEvent = await mkEvent(otherHost, -1, 2);
  const eventIds = [live, ended, otherHostEvent];

  // Invite state (075): accepted unless told otherwise; pending = accepted_at NULL; declined = declined_at set.
  type St = "accepted" | "pending" | "declined";
  const cols = (st: St) => st === "accepted" ? "now(), NULL" : st === "declined" ? "NULL, now()" : "NULL, NULL";
  const addStanding = (h: string, m: string, removed = false, st: St = "accepted") => q(
    `INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id, removed_at, accepted_at, declined_at)
     VALUES ($1,$2,$1, ${removed ? "now()" : "NULL"}, ${cols(st)})`, [h, m]);
  const addEv = (e: string, m: string, h: string, removed = false, st: St = "accepted") => q(
    `INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, removed_at, accepted_at, declined_at)
     VALUES ($1,$2,$3, ${removed ? "now()" : "NULL"}, ${cols(st)})`, [e, m, h]);
  await addStanding(host, standing);
  await addStanding(host, removedStanding, true);
  await addStanding(host, inactive);
  await addStanding(otherHost, otherStanding);
  await addEv(live, evMember, host);
  await addEv(live, removedEv, host, true);
  await addEv(ended, evMember, host);
  await addStanding(host, pendStanding, false, "pending");
  await addStanding(host, declStanding, false, "declined");
  await addEv(live, pendEv, host, false, "pending");
  await addEv(live, declEv, host, false, "declined");

  try {
    console.log("\nloadEventForDoor");
    let r = await loadEventForDoor(live, host);
    assert(r?.role === "host", "host gets role host", r?.role);
    assert(!!r && ["id", "title", "host_user_id", "status", "starts_at", "ends_at", "timezone"].every((k) => k in r!.event), "event row has the needed fields");
    r = await loadEventForDoor(live, standing);
    assert(r?.role === "standing", "standing member gets role standing", r?.role);
    r = await loadEventForDoor(live, evMember);
    assert(r?.role === "event", "event member before end gets role event", r?.role);
    assert((await loadEventForDoor(ended, evMember)) === null, "event member denied after ends_at");
    assert((await loadEventForDoor(live, removedEv)) === null, "removed event member denied");
    assert((await loadEventForDoor(live, removedStanding)) === null, "removed member denied");
    assert((await loadEventForDoor(live, otherStanding)) === null, "standing member of a different host denied");
    assert((await loadEventForDoor(live, stranger)) === null, "stranger denied");
    assert((await loadEventForDoor(live, inactive)) === null, "inactive member denied");
    assert((await loadEventForDoor(otherHostEvent, evMember)) === null, "event member of another event denied");
    assert((await loadEventForDoor("00000000-0000-0000-0000-000000000000", host)) === null, "unknown event denied");
    assert((await loadEventForDoor(live, pendStanding)) === null, "pending standing invite denied");
    assert((await loadEventForDoor(live, declStanding)) === null, "declined standing invite denied");
    assert((await loadEventForDoor(live, pendEv)) === null, "pending event invite denied");
    assert((await loadEventForDoor(live, declEv)) === null, "declined event invite denied");
    r = await loadEventForDoor(ended, standing);
    assert(r?.role === "standing", "standing member still has access after the event ends", r?.role);

    console.log("\nisWithinScanWindow");
    const s = new Date("2026-11-01T20:00:00Z");
    const e = new Date("2026-11-01T23:00:00Z");
    const min = 60_000;
    const ev = (status = "published") => ({ status, starts_at: s, ends_at: e });
    assert(isWithinScanWindow(ev(), new Date(s.getTime() - 6 * 60 * min)), "true at starts_at minus 6h");
    assert(!isWithinScanWindow(ev(), new Date(s.getTime() - 6 * 60 * min - min)), "false 1 minute earlier");
    assert(isWithinScanWindow(ev(), e), "true at ends_at");
    assert(!isWithinScanWindow(ev(), new Date(e.getTime() + min)), "false 1 minute after ends_at");
    assert(isWithinScanWindow({ status: "published", starts_at: s.toISOString(), ends_at: e.toISOString() }, s), "accepts ISO strings");
    for (const st of ["draft", "paused", "cancelled"]) assert(!isWithinScanWindow(ev(st), s), `false for ${st}`);
  } finally {
    await q(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [eventIds]);
    await q(`DELETE FROM event_door_team WHERE host_user_id IN ($1,$2)`, [host, otherHost]);
    await q(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
