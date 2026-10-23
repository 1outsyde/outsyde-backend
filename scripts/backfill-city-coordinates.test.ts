/**
 * scripts/backfill-city-coordinates.ts — run with: npx tsx scripts/backfill-city-coordinates.test.ts
 *
 * SCRATCH ONLY. Runs the real script as a child process against a LOCAL scratch Postgres (through the
 * neon local proxy) with the Nominatim stub (.dev/geocode-stub-preload.mjs). Needs:
 *   BF_TEST_PG_URL   local scratch database, e.g. postgresql://outsyde:outsyde@localhost:5432/outsyde
 * Skips (exit 0) when BF_TEST_PG_URL is unset; refuses any non-local host.
 */
import { execFileSync } from "child_process";

const PG_URL = process.env.BF_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set BF_TEST_PG_URL to run"); process.exit(0); }
  if (!["localhost", "127.0.0.1"].includes(new URL(PG_URL).hostname)) throw new Error("refusing: database must be local");

  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `bf-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  await q(`INSERT INTO users (id, username, email, name, is_vendor, is_photographer) VALUES ($1::varchar, $2, $3, 'BF owner', true, true)`,
    [id("u"), `bf${Date.now().toString(36)}`, `${id("u")}@x.test`]);
  // name, city, state
  const biz: Array<[string, string | null, string | null]> = [
    ["freeport", "Freeport ", "Ny"],       // messy city/state → found
    ["queens", "Queens", null],            // no state → --state override NY
    ["skipme", "Baldwin", "New Jersey"],   // --skip
    ["nowhere", "Nowhereville", "NY"],     // no match
    ["nocity", null, null],                // nothing to look up
  ];
  for (const [tag, city, state] of biz) {
    await q(`INSERT INTO businesses (id, owner_id, name, category, city, state, approval_status) VALUES ($1, $2, $3, 'Beauty', $4, $5, 'approved')`,
      [id(tag), id("u"), `BF ${tag}`, city, state]);
  }
  await q(`INSERT INTO businesses (id, owner_id, name, category, city, state, latitude, longitude, approval_status)
           VALUES ($1, $2, 'BF has point', 'Beauty', 'Miami', 'FL', 1, 2, 'approved')`, [id("haspoint"), id("u")]);
  await q(`INSERT INTO photographers (id, user_id, display_name, city, state, visibility_status, hourly_rate)
           VALUES ($1, $2, 'BF photog', 'Norfolk', 'Virginia', 'public', 100)`, [id("ph"), id("u")]);

  const ids = [...biz.map(([t]) => id(t)), id("haspoint"), id("ph")];
  const run = (extra: string[]) =>
    execFileSync("npx", ["tsx", "scripts/backfill-city-coordinates.ts", `--only=${ids.join(",")}`, `--skip=${id("skipme")}`, `--state=${id("queens")}:NY`, ...extra], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: PG_URL,
        GEOCODE_STUB: "1",
        NODE_OPTIONS: "--import ./.dev/neon-preload.mjs --import ./.dev/geocode-stub-preload.mjs",
      },
    });
  const point = async (table: string, rowId: string) =>
    (await q(`SELECT latitude, longitude, state FROM ${table} WHERE id = $1`, [rowId]))[0];

  try {
    const dry = run([]);
    assert(/DRY RUN/.test(dry), "dry run is the default");
    assert(dry.includes(`WOULD SET ${"business".padEnd(12)} ${id("freeport")}`) && dry.includes('"Freeport, NY" -> 40.6576, -73.5832'),
      "messy city/state normalized and proposed", dry);
    assert(dry.includes('"Queens, NY" -> 40.7282, -73.7949'), "--state override used for the lookup");
    assert(dry.includes(`SKIP      ${"business".padEnd(12)} ${id("skipme")}`), "--skip row skipped");
    assert(dry.includes(`NO MATCH  ${"business".padEnd(12)} ${id("nowhere")}`), "no match reported");
    assert(dry.includes(`NO CITY   ${"business".padEnd(12)} ${id("nocity")}`), "no city reported");
    assert(dry.includes('"Norfolk, VA" -> 36.8508, -76.2859'), "photographer proposed, state name normalized");
    assert(!dry.includes(id("haspoint")), "row that already has a point is not listed");
    assert(dry.includes("https://www.google.com/maps?q=40.6576,-73.5832"), "map link printed for checking");
    assert((await point("businesses", id("freeport"))).latitude === null, "dry run wrote nothing");

    const apply = run(["--apply"]);
    assert(/written: 3/.test(apply), "apply writes 3 points (freeport, queens, photographer)", apply.split("\n").at(-2));
    assert((await point("businesses", id("freeport"))).latitude === 40.6576, "freeport written");
    const qn = await point("businesses", id("queens"));
    assert(qn.latitude === 40.7282 && qn.state === null, "queens written, saved state left unchanged", qn);
    assert((await point("photographers", id("ph"))).latitude === 36.8508, "photographer written");
    assert((await point("businesses", id("skipme"))).latitude === null, "skipped row untouched");
    assert((await point("businesses", id("nowhere"))).latitude === null, "no-match row untouched");
    const hp = await point("businesses", id("haspoint"));
    assert(hp.latitude === 1 && hp.longitude === 2, "existing point never overwritten", hp);

    const again = run(["--apply"]);
    assert(/points found: 0/.test(again) || /written: 0/.test(again), "second apply writes nothing", again.split("\n").at(-2));
  } finally {
    await q(`DELETE FROM photographers WHERE id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM businesses WHERE id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
