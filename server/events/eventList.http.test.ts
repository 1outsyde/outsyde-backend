/**
 * Public event list GET /api/events (server/events/eventList.ts): HTTP integration tests.
 *
 * Run with the local env (see .superpowers/.../env/ENV.md):  env/run-suite.sh server/events/eventList.http.test.ts
 * or by hand: npx tsx server/events/eventList.http.test.ts with
 *   EV_TEST_BASE_URL   e.g. http://localhost:5071   (must be localhost)
 *   EV_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host. Seeds events by direct SQL
 * (every row uses a per-run city so other data in the scratch DB can't change the assertions) and removes them.
 *
 * Mutation checks (edit eventList.ts buildListSql, restart the server, re-run; each must fail the named test):
 *  - drop `ev.status = 'published'`            -> "only the published public event is listed" (draft/paused/cancelled leak)
 *  - drop `ev.visibility = 'public'`           -> "only the published public event is listed" (unlisted leaks)
 *  - drop `ev.ends_at > now()`                 -> "only the published public event is listed" (ended leaks)
 *  - drop the u.is_active / deletion_status    -> "only the published public event is listed" (inactive / deleting host leaks)
 *  - drop `tt.hidden = false` in price_from    -> "priceFromCents ignores hidden ticket types"
 *  - drop `tt.hidden = false` in the free NOT EXISTS -> "free=true excludes ... paid hidden type doesn't" 
 *  - pass viewerHasTicket:true in shapeCard    -> "ticket_holders event card has no venue / street / coordinates"
 *  - ORDER BY distance instead of starts_at    -> "near filter keeps start order"
 *  - drop the ROUND(...,1) CASE (use exact ev.latitude/longitude) -> "1 km radius on the exact point does NOT match a hidden-address event"
 *  - drop the radius haversine condition       -> "near filter excludes an event 100 km away"
 *  - drop the Date.parse / round-trip check in decodeCursor -> "forged cursor with a valid shape but impossible date -> 400" (500 instead)
 *  - drop `.strict()` on listQuerySchema       -> "unknown query keys are refused"
 *  - move the route after hybridAuthMiddleware / below a /:id route -> "invalid Bearer still gets 200"
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string } = {}): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const headers: Record<string, string> = {};
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json, text: b }); });
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `el${Date.now().toString(36)}`;
  const CITY = `Zz${P}`;
  const mkUser = async (s: string, extra: Record<string, unknown> = {}) => {
    const id = (await q(`INSERT INTO users (id, email, name, username) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `${P}${s}`.slice(0, 20)]))[0].id as string;
    for (const [k, v] of Object.entries(extra)) await q(`UPDATE users SET ${k} = $1 WHERE id = $2`, [v, id]);
    return id;
  };
  const host = await mkUser("host");
  await q(`UPDATE users SET name = 'Jay Vibes', first_name = 'Jane', last_name = 'Doe' WHERE id = $1`, [host]);
  const inactiveHost = await mkUser("inact", { is_active: false });
  const deletingHost = await mkUser("del", { deletion_status: "pending_deletion" });
  const owner = await mkUser("owner");
  const [biz] = await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, logo_image) VALUES (gen_random_uuid(), $1, $2, 'Events', 'approved', 'https://img.test/logo.png') RETURNING id`, [owner, `${P} Lounge`]);

  const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86400000 + h * 3600000).toISOString();
  const eventIds: string[] = [];
  let n = 0;
  const mkEv = async (o: Record<string, unknown> = {}) => {
    const v: Record<string, unknown> = {
      host_user_id: host, slug: `${P}-${++n}`, title: `Title ${n}`, starts_at: inDays(10 + n), ends_at: inDays(10 + n, 4),
      timezone: "America/New_York", venue_name: "The Loft", address_line1: "1 Main St", city: CITY, state: "NY", postal_code: "11520",
      latitude: 40.65, longitude: -73.58, address_visibility: "public", visibility: "public", status: "published", ...o,
    };
    const cols = Object.keys(v);
    const id = (await q(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, cols.map((c) => v[c])))[0].id as string;
    eventIds.push(id);
    return id;
  };
  const mkType = async (eventId: string, name: string, price: number, extra = "") =>
    (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity ${extra ? ", " + extra.split("=")[0] : ""}) VALUES ($1, $2, $3, 50 ${extra ? ", " + extra.split("=")[1] : ""}) RETURNING id`, [eventId, name, price]))[0].id as string;
  const listIds = (r: any) => (r.body?.events ?? []).map((e: any) => e.id) as string[];
  const inCity = (extra = "") => `/api/events?city=${encodeURIComponent(CITY)}${extra}`;

  try {
    console.log("Seed");
    // Public, listed, with a free type, a paid type and a hidden paid type (the hidden one must never leak).
    const pub = await mkEv({ title: "Public One", host_type: "business", host_business_id: biz.id, cover_image_url: "https://img.test/c.png", starts_at: inDays(3), ends_at: inDays(3, 4) });
    await mkType(pub, "Free entry", 0);
    await mkType(pub, "Paid GA", 2500);
    await mkType(pub, `SECRET-HIDDEN-${P}`, 100, "hidden=true");
    const draft = await mkEv({ status: "draft", title: "Draft Ev" });
    const paused = await mkEv({ status: "paused", title: "Paused Ev" });
    const cancelled = await mkEv({ status: "cancelled", title: "Cancelled Ev" });
    const unlisted = await mkEv({ visibility: "unlisted", title: "Unlisted Ev" });
    const ended = await mkEv({ starts_at: inDays(-2), ends_at: inDays(-1), title: "Ended Ev" });
    const inact = await mkEv({ host_user_id: inactiveHost, title: "Inactive host Ev" });
    const del = await mkEv({ host_user_id: deletingHost, title: "Deleting host Ev" });
    const bad = new Set([draft, paused, cancelled, unlisted, ended, inact, del]);

    console.log("Filter");
    let r = await call("GET", inCity());
    assert(r.status === 200 && r.body?.success === true, "anonymous call works", r);
    assert(JSON.stringify(listIds(r)) === JSON.stringify([pub]), "only the published public event is listed", { got: listIds(r), bad: [...bad].filter((i) => listIds(r).includes(i)) });
    assert(!r.text.includes(`SECRET-HIDDEN-${P}`), "hidden ticket type name never appears in the response");
    const card = r.body?.events?.[0] ?? {};
    assert(card.priceFromCents === 2500 && card.hasFree === true && card.soldOut === false, "priceFromCents ignores hidden ticket types", card);
    assert(card.host?.kind === "business" && card.host.name === `${P} Lounge` && card.host.avatarUrl === "https://img.test/logo.png", "business host name, logo and kind", card.host);
    assert(card.coverImageUrl === "https://img.test/c.png" && card.slug && card.timezone === "America/New_York" && card.addressHidden === false && card.venueName === "The Loft", "public address card fields", card);
    assert(r.body?.nextCursor === null, "no next page for a single event");
    const keys = Object.keys(card).sort().join(",");
    const want = ["addressHidden", "city", "coverImageUrl", "endsAt", "hasFree", "host", "id", "priceFromCents", "slug", "soldOut", "startsAt", "state", "timezone", "title", "venueName"].join(",");
    assert(keys === want, "card has exactly the documented keys", keys);

    console.log("Address privacy");
    const priv = await mkEv({ address_visibility: "ticket_holders", title: "Private Ev", starts_at: inDays(4), ends_at: inDays(4, 3), address_line1: "1 Main St" });
    await mkType(priv, "Free", 0);
    const privDay = await mkEv({ address_visibility: "ticket_holders_day_of", title: "Private DayOf", starts_at: inDays(5), ends_at: inDays(5, 3) });
    await mkType(privDay, "Free", 0);
    r = await call("GET", inCity());
    const pc = r.body.events.find((e: any) => e.id === priv);
    const pd = r.body.events.find((e: any) => e.id === privDay);
    assert(!!pc && pc.addressHidden === true && pc.venueName === null && pc.city === CITY && pc.state === "NY", "ticket_holders event card has no venue / street / coordinates (area only)", pc);
    assert(!!pd && pd.addressHidden === true && pd.venueName === null, "day-of event card hides the address too", pd);
    assert(pc?.host?.kind === "user" && pc.host.name === "Jay Vibes" && !/Jane|Doe/.test(JSON.stringify(pc)), "person host card shows the display name, never the real name", pc?.host);
    const withheld = ["1 Main St", "The Loft", "11520", "latitude", "longitude", "lat", "lng", "40.65", "-73.58", "addressLine"];
    const leaked = withheld.filter((w) => JSON.stringify([pc, pd]).includes(w));
    assert(leaked.length === 0, "hidden cards carry none of: street, venue, postal code, lat/lng keys or values", leaked);
    assert(!/"?(latitude|longitude|distance\w*)"?\s*:/i.test(r.text), "no latitude/longitude/distance key anywhere in the response");

    console.log("Free, city, dates");
    r = await call("GET", inCity("&free=true"));
    assert(!listIds(r).includes(pub) && listIds(r).includes(priv) && listIds(r).includes(privDay), "free=true excludes an event with a paid visible type, includes free only", listIds(r));
    const hiddenPaid = await mkEv({ title: "Free plus hidden paid", starts_at: inDays(6), ends_at: inDays(6, 3) });
    await mkType(hiddenPaid, "Free", 0);
    await mkType(hiddenPaid, "Secret paid", 5000, "hidden=true");
    r = await call("GET", inCity("&free=true"));
    assert(listIds(r).includes(hiddenPaid), "free=true excludes ... paid hidden type doesn't (hidden ignored)", listIds(r));
    r = await call("GET", inCity("&free=false"));
    assert(listIds(r).includes(pub), "free=false is no filter", listIds(r));
    r = await call("GET", `/api/events?city=${encodeURIComponent(CITY.toLowerCase())}`);
    assert(listIds(r).includes(pub), "city matches case-insensitively", listIds(r));
    r = await call("GET", `/api/events?city=${encodeURIComponent(CITY + "x")}`);
    assert(listIds(r).length === 0, "city is an equality, not a prefix match", listIds(r));
    const enc = encodeURIComponent;
    r = await call("GET", inCity(`&from=${enc(inDays(3, 2))}&to=${enc(inDays(3, 3))}`));
    assert(JSON.stringify(listIds(r)) === JSON.stringify([pub]), "from/to keeps an event in progress inside the window", listIds(r));
    r = await call("GET", inCity(`&from=${enc(inDays(3, 5))}&to=${enc(inDays(3, 6))}`));
    assert(listIds(r).length === 0, "from/to excludes events that ended before the window", listIds(r));
    r = await call("GET", inCity(`&to=${enc(inDays(2))}`));
    assert(listIds(r).length === 0, "to excludes events starting after it", listIds(r));

    console.log("Near");
    const near = await mkEv({ title: "Near 5km", latitude: 40.695, longitude: -73.58, starts_at: inDays(8), ends_at: inDays(8, 2), address_visibility: "ticket_holders" });
    const mid = await mkEv({ title: "Mid 20km", latitude: 40.83, longitude: -73.58, starts_at: inDays(2, 12), ends_at: inDays(2, 14) });
    const far = await mkEv({ title: "Far 100km", latitude: 41.55, longitude: -73.58, starts_at: inDays(7), ends_at: inDays(7, 2) });
    const noCoords = await mkEv({ title: "No coords", latitude: null, longitude: null, starts_at: inDays(9), ends_at: inDays(9, 2) });
    r = await call("GET", inCity("&lat=40.65&lng=-73.58&radiusKm=40"));
    const nid = listIds(r);
    assert(nid.includes(near) && !nid.includes(far), "near filter includes an event 5 km away and excludes one 100 km away", nid);
    assert(nid.includes(pub) && !nid.includes(noCoords), "near filter drops events without stored coordinates", nid);
    assert(nid.indexOf(mid) >= 0 && nid.indexOf(mid) < nid.indexOf(pub) && nid.indexOf(pub) < nid.indexOf(near) && r.body.events.every((e: any, i: number, a: any[]) => i === 0 || a[i - 1].startsAt <= e.startsAt), "near filter keeps start order", r.body.events.map((e: any) => e.startsAt));
    assert(!/distance/i.test(r.text) && !/"(latitude|longitude)"/.test(r.text), "no response key named distance*, no coordinates", r.text.slice(0, 200));
    r = await call("GET", inCity("&lat=40.65&lng=-73.58&radiusKm=150"));
    assert(listIds(r).includes(far), "a larger radius includes the 100 km event", listIds(r));
    r = await call("GET", inCity("&lat=40.65&lng=-73.58"));
    assert(listIds(r).includes(near) && !listIds(r).includes(far), "default radius is 40 km", listIds(r));
    r = await call("GET", `/api/events?lat=40.65&lng=-73.58&limit=50`);
    assert(r.status === 200 && r.body.events.every((e: any) => !("latitude" in e) && !("distanceKm" in e)), "plain near query works", r.status);

    console.log("Near: hidden addresses use 0.1 degree coordinates");
    // P is exact; its 0.1-degree rounding is (40.6, -73.5), about 6.8 km away.
    const PLAT = 40.649, PLNG = -73.549, RLAT = 40.6, RLNG = -73.5;
    const hidP = await mkEv({ title: "Hidden at P", address_visibility: "ticket_holders", latitude: PLAT, longitude: PLNG, starts_at: inDays(12), ends_at: inDays(12, 2) });
    const pubP = await mkEv({ title: "Public at P", address_visibility: "public", latitude: PLAT, longitude: PLNG, starts_at: inDays(13), ends_at: inDays(13, 2) });
    r = await call("GET", inCity(`&lat=${PLAT}&lng=${PLNG}&radiusKm=1`));
    assert(!listIds(r).includes(hidP), "1 km radius on the exact point does NOT match a hidden-address event", listIds(r));
    assert(listIds(r).includes(pubP), "1 km radius on the exact point still matches a public-address event", listIds(r));
    r = await call("GET", inCity(`&lat=${RLAT}&lng=${RLNG}&radiusKm=1`));
    assert(listIds(r).includes(hidP) && !listIds(r).includes(pubP), "1 km radius on the rounded point matches the hidden-address event (and not the public one)", listIds(r));
    r = await call("GET", inCity(`&lat=${PLAT}&lng=${PLNG}&radiusKm=10`));
    assert(listIds(r).includes(hidP) && listIds(r).includes(pubP), "a 10 km radius covers both", listIds(r));

    console.log("Paging");
    const all = await call("GET", inCity("&limit=50"));
    const total = listIds(all).length;
    assert(total >= 5, "enough seeded events to page", total);
    const seen: string[] = [];
    let cursor: string | null = null; let pages = 0;
    do {
      r = await call("GET", inCity(`&limit=2${cursor ? "&cursor=" + enc(cursor) : ""}`));
      if (r.status !== 200) break;
      seen.push(...listIds(r)); cursor = r.body.nextCursor; pages++;
    } while (cursor && pages < 20);
    assert(pages === Math.ceil(total / 2) && seen.length === total && new Set(seen).size === total, "paging walks every event once with no repeat", { pages, total, seen: seen.length });
    assert(JSON.stringify(seen) === JSON.stringify(listIds(all)), "paged order equals the unpaged order", seen);
    r = await call("GET", inCity("&limit=2"));
    assert(r.body.events.length === 2 && typeof r.body.nextCursor === "string", "first page has a cursor", r.body);
    // Two events with the same start time still page without repeat or gap (tie broken by id).
    const tieStart = inDays(20);
    const t1 = await mkEv({ title: "Tie 1", starts_at: tieStart, ends_at: inDays(20, 2) });
    const t2 = await mkEv({ title: "Tie 2", starts_at: tieStart, ends_at: inDays(20, 2) });
    const tieSeen: string[] = []; cursor = null; pages = 0;
    do {
      r = await call("GET", inCity(`&limit=1${cursor ? "&cursor=" + enc(cursor) : ""}`));
      tieSeen.push(...listIds(r)); cursor = r.body.nextCursor; pages++;
    } while (cursor && pages < 30);
    assert(tieSeen.includes(t1) && tieSeen.includes(t2) && new Set(tieSeen).size === tieSeen.length, "equal start times page without gap or repeat", tieSeen);

    console.log("Validation and auth");
    for (const [name, qs] of [
      ["limit=500", "limit=500"], ["limit=0", "limit=0"], ["limit=abc", "limit=abc"],
      ["radiusKm=500", "lat=40&lng=-73&radiusKm=500"], ["lat without lng", "lat=40"], ["radiusKm without lat", "radiusKm=5"],
      ["lat=91", "lat=91&lng=0"], ["from without offset", "from=2026-10-30T10:00:00"], ["free=maybe", "free=maybe"],
      ["bad cursor", "cursor=not-a-cursor"], ["unknown query keys are refused", "bogus=1"],
    ] as const) {
      r = await call("GET", `/api/events?${qs}`);
      assert(r.status === 400 && r.body.success === false && r.body.error.code === "INVALID_QUERY", `${name} -> 400 INVALID_QUERY`, r);
    }
    const forge = (v: string) => Buffer.from(v, "utf8").toString("base64url");
    for (const bad of ["2026-13-45T99:99:99.000000Z|abc", "2026-02-30T10:00:00.000000Z|abc", "0000-01-01T00:00:00.000000Z|abc"]) {
      r = await call("GET", `/api/events?cursor=${enc(forge(bad))}`);
      assert(r.status === 400 && r.body?.error?.code === "INVALID_QUERY", `forged cursor with a valid shape but impossible date -> 400 (${bad.slice(0, 10)})`, { status: r.status, body: r.body });
    }
    r = await call("GET", "/api/events?city=a&city=b");
    assert(r.status === 400 && r.body.error.code === "INVALID_QUERY", "repeated parameter -> 400 INVALID_QUERY", r);
    r = await call("GET", inCity(), { token: "garbage.invalid.token" });
    assert(r.status === 200 && r.body.success === true, "a request with an invalid Bearer still gets 200 (public route)", r);
    r = await call("GET", "/api/events/mine");
    assert(r.status === 401, "/mine still needs auth (route order intact)", r);
    r = await call("GET", `/api/events/slug/${P}-1`);
    assert(r.status === 200 && r.body.event?.id === pub, "slug route still resolves (route order intact)", r.status);
  } finally {
    eventIds.push(...(await q(`SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`])).map((x) => x.id));
    if (eventIds.length) {
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [eventIds]);
      await q(`UPDATE ticket_types SET unlock_after_ticket_type_id = NULL WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    }
    await q(`DELETE FROM businesses WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
