/**
 * p4-scanner Task 1: migration 075 (door team invites).
 *
 * SCRATCH ONLY: localhost Postgres (EV_TEST_PG_URL). Skips (exit 0) when EV_TEST_PG_URL is unset.
 * Builds the 067 door tables in a throwaway schema (search_path m075x, public, so users/events/tickets resolve to
 * public), then runs 075 twice:
 *   run 1 backfills accepted_at = created_at on rows that existed before 075 (nobody loses access)
 *   run 2, with a pending invite in the table, must NOT accept it (the backfill only runs where 075 adds the column)
 *
 * Mutation checks:
 *  - move the UPDATE outside the "column missing" guard → "re-run keeps a pending invite pending" fails.
 *  - drop the role CHECK → "role check rejects unknown roles" fails.
 */
import fs from "fs";
import path from "path";

const PG_URL = process.env.EV_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set EV_TEST_PG_URL to run"); process.exit(0); }
  if (!isLocal(PG_URL)) throw new Error("refusing to run: PG_URL must be localhost");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const S = `m075x${Date.now().toString(36)}`;
  const mig = (n: string) => fs.readFileSync(path.join(process.cwd(), "migrations", n), "utf8");
  const sql067 = mig("067_event_door_team.sql");
  const sql075 = mig("075_door_team_invites.sql");

  const P = `mg${Date.now().toString(36)}`;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO public.users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
    [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, `${P}${s}`.slice(0, 24)],
  ))[0].id as string;
  const host = await mkUser("host");
  const old1 = await mkUser("old1");
  const old2 = await mkUser("old2");
  const pend = await mkUser("pend");
  const evId = (await q(
    `INSERT INTO public.events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, 'Mig', 'published', now() + interval '1 day', now() + interval '2 days', 'America/New_York') RETURNING id`,
    [host, `${P}-ev`],
  ))[0].id as string;

  try {
    await q(`CREATE SCHEMA ${S}`);
    await q(`SET search_path TO ${S}, public`);
    await db.query(sql067);
    const where = await q(`SELECT table_schema FROM information_schema.tables WHERE table_name = 'event_door_team' AND table_schema = $1`, [S]);
    assert(where.length === 1, "067 tables built in the scratch schema");

    // Rows from before 075: a standing member and an event member, one already removed.
    await q(`INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id, created_at) VALUES ($1, $2, $1, now() - interval '3 days')`, [host, old1]);
    await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id) VALUES ($1, $2, $3)`, [evId, old2, host]);
    await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, removed_at) VALUES ($1, $2, $3, now())`, [evId, old1, host]);

    console.log("\nrun 1");
    await db.query(sql075);
    const cols = await q(
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name IN ('event_door_team','event_door_members')
         AND column_name IN ('invited_at','accepted_at','declined_at','removed_by_user_id','invite_emailed_at','role')`, [S]);
    assert(cols.length === 12, "six new columns on both tables", cols);
    assert(cols.filter((c) => c.column_name === "role").every((c) => c.is_nullable === "NO" && /'door'/.test(String(c.column_default))), "role NOT NULL DEFAULT 'door'", cols);
    assert(cols.filter((c) => c.column_name === "invited_at").every((c) => c.is_nullable === "NO"), "invited_at NOT NULL", cols);
    const [t1] = await q(`SELECT accepted_at, created_at, role FROM event_door_team WHERE member_user_id = $1`, [old1]);
    assert(!!t1.accepted_at && new Date(t1.accepted_at).getTime() === new Date(t1.created_at).getTime(), "existing standing row backfilled accepted_at = created_at", t1);
    assert(t1.role === "door", "existing row gets role door", t1);
    const [m1] = await q(`SELECT accepted_at FROM event_door_members WHERE member_user_id = $1 AND removed_at IS NULL`, [old2]);
    assert(!!m1.accepted_at, "existing event row backfilled", m1);

    console.log("\nrun 2 (re-run)");
    await q(`INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id) VALUES ($1, $2, $1)`, [host, pend]);
    await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id) VALUES ($1, $2, $3)`, [evId, pend, host]);
    await db.query(sql075);
    const [p1] = await q(`SELECT accepted_at, role FROM event_door_team WHERE member_user_id = $1`, [pend]);
    assert(p1.accepted_at === null, "re-run keeps a pending standing invite pending", p1);
    const [p2] = await q(`SELECT accepted_at FROM event_door_members WHERE member_user_id = $1`, [pend]);
    assert(p2.accepted_at === null, "re-run keeps a pending event invite pending", p2);
    assert(p1.role === "door", "new rows default to role door", p1);

    console.log("\nconstraints");
    let err: any = null;
    try { await q(`UPDATE event_door_team SET role = 'bouncer' WHERE member_user_id = $1`, [pend]); } catch (e) { err = e; }
    assert(err?.code === "23514", "role check rejects unknown roles", err?.message);
    for (const role of ["security", "host", "door"]) {
      err = null;
      try { await q(`UPDATE event_door_team SET role = $2 WHERE member_user_id = $1`, [pend, role]); } catch (e) { err = e; }
      assert(err === null, `role ${role} allowed`, err?.message);
    }
    err = null;
    try { await q(`UPDATE event_door_members SET accepted_at = now(), declined_at = now() WHERE member_user_id = $1`, [pend]); } catch (e) { err = e; }
    assert(err?.code === "23514", "accepted and declined together are rejected", err?.message);
    err = null;
    try { await q(`UPDATE event_door_members SET removed_by_user_id = 'nope' WHERE member_user_id = $1`, [pend]); } catch (e) { err = e; }
    assert(err?.code === "23503", "removed_by_user_id references users", err?.message);
  } finally {
    await q(`SET search_path TO public`);
    await q(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => {});
    await q(`DELETE FROM public.events WHERE id = $1`, [evId]).catch(() => {});
    await q(`DELETE FROM public.users WHERE email LIKE $1`, [`${P}-%`]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
