/**
 * Video cover media HTTP tests — run with:
 *   npx tsx server/coverMedia.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres, with
 * MUX_WEBHOOK_SECRET set on the server and the same values here:
 *   COVER_TEST_BASE_URL     e.g. http://localhost:5091   (must be localhost)
 *   COVER_TEST_PG_URL       the SAME scratch database    (localhost only; seeds + cleans up)
 *   MUX_WEBHOOK_SECRET      identical to the server's
 * Leave MUX_TOKEN_ID / MUX_TOKEN_SECRET unset on the server: the save routes then can't reach Mux,
 * which is exactly the "still processing" path (upload id kept, webhook fills it in).
 * Skips (exit 0) when COVER_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Rules under test:
 *  - PATCH /api/users/me accepts a Mux upload id only with coverMediaType "video"; URLs work as before.
 *  - PATCH /api/vendor/my-business, /api/staff/me, /api/photographers/me keep accepting covers as before.
 *  - POST /api/webhooks/mux swaps the upload id for the playable URL on users, businesses, staff,
 *    photographers; rows that don't match are untouched; unsigned / badly signed calls get 401.
 *  - GET /api/users/:id returns coverPosterUrl (additive) and every field it returned before.
 *  - toPublicBusinessDTO / toPublicPhotographerDTO return coverPosterUrl (additive).
 */
import { createHmac } from "crypto";
import { toPublicBusinessDTO } from "./serializers/business";
import { toPublicPhotographerDTO } from "./serializers/photographer";

const BASE = process.env.COVER_TEST_BASE_URL;
const PG_URL = process.env.COVER_TEST_PG_URL;
const SECRET = process.env.MUX_WEBHOOK_SECRET;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log("⏭  skipped: set COVER_TEST_BASE_URL (+ COVER_TEST_PG_URL, MUX_WEBHOOK_SECRET) to run the HTTP tests");
    process.exit(0);
  }
  if (!PG_URL || !SECRET || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error("refusing to run: base URL and database must both be local scratch instances, and MUX_WEBHOOK_SECRET must be set");
  }

  const bcryptMod: any = await import("bcrypt");
  const bcrypt = bcryptMod.default ?? bcryptMod;
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `cov${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const PASSWORD = "local-test-pass-123";
  const hash = await bcrypt.hash(PASSWORD, 4);
  const R2 = "https://r2.test.example/covers";
  const up = (s: string) => `UP${P}${s}`.replace(/[^A-Za-z0-9]/g, "");
  const PLAY = (s: string) => `PB${P}${s}`.replace(/[^A-Za-z0-9]/g, "");
  const m3u8 = (s: string) => `https://stream.mux.com/${PLAY(s)}.m3u8`;

  const mkUser = (key: string, extra = "") =>
    q(`INSERT INTO users (id, username, email, password, name ${extra ? ", " + extra.split("=")[0] : ""}) VALUES ($1::varchar, $2, $3, $4, 'Cover Tester' ${extra ? ", " + extra.split("=")[1] : ""})`,
      [id(key), `${P}${key}`.slice(0, 30), `${id(key)}@x.test`, hash]);

  await mkUser("consumer");
  await mkUser("owner", "is_vendor=true");
  await mkUser("staffer");
  await mkUser("photog", "is_photographer=true");
  await mkUser("bystander");
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'Cover Biz', 'beauty', 'approved')`, [id("biz"), id("owner")]);
  await q(`INSERT INTO staff_members (id, business_id, user_id, display_name) VALUES ($1, $2, $3, 'Cover Staff')`, [id("staff"), id("biz"), id("staffer")]);
  await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate) VALUES ($1, $2, 'Cover Photog', 100)`, [id("ph"), id("photog")]);
  await q(`UPDATE users SET cover_media_url = $2, cover_media_type = 'video' WHERE id = $1`, [id("bystander"), up("other")]);

  let ipSeq = 0;
  async function call(method: string, path: string, o: { body?: unknown; token?: string; headers?: Record<string, string>; raw?: string } = {}) {
    const headers: Record<string, string> = { "X-Forwarded-For": `10.97.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`, ...(o.headers || {}) };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    let body: string | undefined = o.raw;
    if (o.body !== undefined) body = JSON.stringify(o.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(BASE + path, { method, headers, body });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text };
  }
  async function login(key: string) {
    const r = await call("POST", "/api/auth/mobile/login", { body: { email: `${id(key)}@x.test`, password: PASSWORD } });
    const token = r.body?.accessToken ?? r.body?.tokens?.accessToken ?? r.body?.token;
    if (r.status !== 200 || !token) throw new Error(`login ${key} failed: ${r.status} ${r.text.slice(0, 200)}`);
    return token as string;
  }
  function signed(body: unknown, secret = SECRET!, t = Math.floor(Date.now() / 1000)) {
    const raw = JSON.stringify(body);
    const sig = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
    return { raw, headers: { "Mux-Signature": `t=${t},v1=${sig}` } };
  }
  const ready = (uploadId: string, playbackId: string) => ({
    type: "video.asset.ready",
    data: { id: `asset${playbackId}`, upload_id: uploadId, playback_ids: [{ id: playbackId, policy: "public" }] },
  });
  const userRow = async (k: string) => (await q(`SELECT cover_media_url, cover_media_type FROM users WHERE id = $1`, [id(k)]))[0];

  try {
    const tConsumer = await login("consumer");
    const tOwner = await login("owner");
    const tStaff = await login("staffer");
    const tPhotog = await login("photog");

    console.log("\nPATCH /api/users/me — customer covers");
    let r = await call("PATCH", "/api/users/me", { token: tConsumer, body: { coverMediaUrl: `${R2}/c1.jpg`, coverMediaType: "image" } });
    assert(r.status === 200 && (await userRow("consumer")).cover_media_url === `${R2}/c1.jpg`, "image URL still saves (unchanged)", r.body);
    r = await call("PATCH", "/api/users/me", { token: tConsumer, body: { coverMediaUrl: up("c"), coverMediaType: "video" } });
    let row = await userRow("consumer");
    assert(r.status === 200 && row.cover_media_url === up("c") && row.cover_media_type === "video", "video upload id saves while processing (was 400)", { status: r.status, body: r.body, row });
    assert(r.body?.user?.coverMediaUrl === up("c") || r.body?.user?.coverMediaUrl === undefined, "response shape unchanged", r.body?.user);
    r = await call("PATCH", "/api/users/me", { token: tConsumer, body: { coverMediaUrl: up("x"), coverMediaType: "image" } });
    assert(r.status === 400 && (await userRow("consumer")).cover_media_url === up("c"), "upload id with type image → 400, nothing written", r.body);
    r = await call("PATCH", "/api/users/me", { token: tConsumer, body: { coverMediaUrl: up("x") } });
    assert(r.status === 400, "upload id without type → 400 (existing rule)", r.body);
    r = await call("PATCH", "/api/users/me", { token: tConsumer, body: { coverMediaUrl: "file:///var/mobile/a.jpg", coverMediaType: "image" } });
    assert(r.status === 400, "phone file path → 400 (new: http(s) only)", r.body);
    r = await call("PATCH", "/api/users/me", { token: tConsumer, body: { coverMediaUrl: "not a url!", coverMediaType: "video" } });
    assert(r.status === 400, "junk with type video → 400", r.body);
    r = await call("PATCH", "/api/users/me", { token: tConsumer, body: { bio: "hello" } });
    row = await userRow("consumer");
    assert(r.status === 200 && row.cover_media_url === up("c"), "bio-only save leaves the cover alone", row);

    console.log("\nsave routes for businesses, staff, photographers (upload id kept while processing)");
    r = await call("PATCH", "/api/vendor/my-business", { token: tOwner, body: { coverImage: up("b"), coverMediaType: "video" } });
    let b = (await q(`SELECT cover_image, cover_media_type FROM businesses WHERE id = $1`, [id("biz")]))[0];
    assert(r.status === 200 && b.cover_image === up("b") && b.cover_media_type === "video", "my-business video upload id saves", { status: r.status, b });
    r = await call("PATCH", "/api/staff/me", { token: tStaff, body: { coverImage: up("s"), coverMediaType: "video" } });
    let s = (await q(`SELECT cover_image, cover_media_type FROM staff_members WHERE id = $1`, [id("staff")]))[0];
    assert(r.status === 200 && s.cover_image === up("s") && s.cover_media_type === "video", "staff/me video upload id saves", { status: r.status, body: r.body, s });
    r = await call("PATCH", "/api/photographers/me", { token: tPhotog, body: { coverImage: up("p"), coverMediaType: "video" } });
    let p = (await q(`SELECT cover_image, cover_media_type FROM photographers WHERE id = $1`, [id("ph")]))[0];
    assert(r.status === 200 && p.cover_image === up("p") && p.cover_media_type === "video", "photographers/me video upload id saves", { status: r.status, body: r.body, p });
    r = await call("PATCH", "/api/vendor/my-business", { token: tOwner, body: { coverImage: `${R2}/b.jpg`, coverMediaType: "image" } });
    b = (await q(`SELECT cover_image, cover_media_type FROM businesses WHERE id = $1`, [id("biz")]))[0];
    assert(r.status === 200 && b.cover_image === `${R2}/b.jpg` && b.cover_media_type === "image", "my-business image still saves (vendor sites)", b);
    r = await call("PATCH", "/api/vendor/my-business", { token: tOwner, body: { coverImage: up("b"), coverMediaType: "video" } });
    r = await call("PATCH", "/api/vendor/my-business", { token: tOwner, body: { coverImage: `${R2}/no-type.jpg` } });
    assert(r.status === 400, "my-business cover without type → 400 (existing rule)", r.body);

    console.log("\nPOST /api/webhooks/mux — signature");
    const evt = ready(up("c"), PLAY("c"));
    r = await call("POST", "/api/webhooks/mux", { raw: JSON.stringify(evt) });
    assert(r.status === 401 && (await userRow("consumer")).cover_media_url === up("c"), "unsigned → 401, nothing written", r.body);
    const bad = signed(evt, "wrong-secret");
    r = await call("POST", "/api/webhooks/mux", { raw: bad.raw, headers: bad.headers });
    assert(r.status === 401 && (await userRow("consumer")).cover_media_url === up("c"), "wrong secret → 401, nothing written", r.body);
    const stale = signed(evt, SECRET, Math.floor(Date.now() / 1000) - 3600);
    r = await call("POST", "/api/webhooks/mux", { raw: stale.raw, headers: stale.headers });
    assert(r.status === 401, "replayed old event → 401", r.body);

    console.log("\nPOST /api/webhooks/mux — asset ready");
    let ok = signed(evt);
    r = await call("POST", "/api/webhooks/mux", { raw: ok.raw, headers: ok.headers });
    row = await userRow("consumer");
    assert(r.status === 200 && row.cover_media_url === m3u8("c") && row.cover_media_type === "video", "customer cover becomes playable", { status: r.status, row });
    assert((await userRow("bystander")).cover_media_url === up("other"), "other users' processing covers untouched");
    for (const [key, table, col, rid] of [["b", "businesses", "cover_image", id("biz")], ["s", "staff_members", "cover_image", id("staff")], ["p", "photographers", "cover_image", id("ph")]] as const) {
      ok = signed(ready(up(key), PLAY(key)));
      r = await call("POST", "/api/webhooks/mux", { raw: ok.raw, headers: ok.headers });
      const v = (await q(`SELECT ${col} AS v FROM ${table} WHERE id = $1`, [rid]))[0]?.v;
      assert(r.status === 200 && v === m3u8(key), `${table} cover becomes playable (unchanged behaviour)`, { status: r.status, v });
    }
    ok = signed({ type: "video.asset.created", data: { id: "x" } });
    r = await call("POST", "/api/webhooks/mux", { raw: ok.raw, headers: ok.headers });
    assert(r.status === 200, "other event types still acknowledged", r.body);

    console.log("\nGET /api/users/:id — coverPosterUrl (additive)");
    r = await call("GET", `/api/users/${id("consumer")}`);
    const u = r.body?.user;
    assert(r.status === 200 && u?.coverMediaUrl === m3u8("c") && u?.coverMediaType === "video", "cover fields unchanged", u);
    assert(u?.coverPosterUrl === `https://image.mux.com/${PLAY("c")}/thumbnail.jpg`, "video → Mux thumbnail", u?.coverPosterUrl);
    for (const k of ["id", "userId", "name", "username", "bio", "profileImageUrl", "avatarUrl", "city", "state", "isVendor", "isPhotographer", "isInfluencer", "followerCount", "followingCount", "profilePhotoUrl"]) {
      if (!(k in (u || {}))) assert(false, `field ${k} still returned`);
    }
    r = await call("GET", `/api/users/${id("bystander")}`);
    assert(r.body?.user?.coverPosterUrl === null, "still processing → null poster", r.body?.user);

    console.log("\nserializers — coverPosterUrl (additive)");
    const bizRow = (await q(`SELECT * FROM businesses WHERE id = $1`, [id("biz")]))[0];
    const camel = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
    const bdto: any = toPublicBusinessDTO(camel(bizRow) as any, { followerCount: 0, followingCount: 0 });
    assert(bdto.coverImage === m3u8("b") && bdto.coverMediaType === "video" && bdto.coverPosterUrl === `https://image.mux.com/${PLAY("b")}/thumbnail.jpg`, "business DTO poster", bdto);
    const imgDto: any = toPublicBusinessDTO({ ...camel(bizRow), coverImage: `${R2}/i.jpg`, coverMediaType: "image" } as any, { followerCount: 0, followingCount: 0 });
    assert(imgDto.coverPosterUrl === `${R2}/i.jpg`, "image business → poster is the image", imgDto.coverPosterUrl);
    const phRow = (await q(`SELECT * FROM photographers WHERE id = $1`, [id("ph")]))[0];
    const pdto: any = toPublicPhotographerDTO(camel(phRow) as any, { followerCount: 0, followingCount: 0 });
    assert(pdto.coverPosterUrl === `https://image.mux.com/${PLAY("p")}/thumbnail.jpg`, "photographer DTO poster", pdto.coverPosterUrl);
  } finally {
    await q(`DELETE FROM photographers WHERE id = $1`, [id("ph")]);
    await q(`DELETE FROM staff_members WHERE id = $1`, [id("staff")]);
    await q(`DELETE FROM businesses WHERE id = $1`, [id("biz")]);
    await q(`DELETE FROM refresh_tokens WHERE user_id LIKE $1`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}-%`]).catch((e: any) => console.warn("cleanup users:", e.message));
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
