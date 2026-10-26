/**
 * Admin push routes + news preference + cart reminder lock, over HTTP.
 * Run with: npx tsx server/push/pushAdmin.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend on localhost against a LOCAL scratch Postgres with migration 073 applied,
 * started with the same JWT_SECRET and EXPO_BASE_URL=http://127.0.0.1:<PUSH_TEST_EXPO_PORT>.
 * This test runs the Expo stub itself on PUSH_TEST_EXPO_PORT, so no push ever leaves the machine.
 *   PUSH_TEST_BASE_URL   e.g. http://localhost:5077 (must be localhost)
 *   PUSH_TEST_PG_URL     the SAME scratch database (must be localhost; seeds + cleans up)
 *   PUSH_TEST_EXPO_PORT  e.g. 5099
 * Skips (exit 0) when PUSH_TEST_BASE_URL is unset; refuses any non local host.
 */
import http from "http";
import { gunzipSync } from "zlib";

const BASE = process.env.PUSH_TEST_BASE_URL;
const PG_URL = process.env.PUSH_TEST_PG_URL;
const STUB_PORT = Number(process.env.PUSH_TEST_EXPO_PORT || 0);

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!BASE) { console.log("skipped: set PUSH_TEST_BASE_URL + PUSH_TEST_PG_URL + PUSH_TEST_EXPO_PORT"); process.exit(0); }
  if (!PG_URL || !STUB_PORT || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: base URL and database must both be local, and a stub port is required");

  // Local Expo stub: records every push message.
  const pushed: any[] = [];
  let tk = 0;
  const stub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let raw = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
      const j = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/push/send")) {
        const msgs = Array.isArray(j) ? j : [j];
        pushed.push(...msgs);
        return res.end(JSON.stringify({ data: msgs.map(() => ({ status: "ok", id: `stub-${++tk}` })) }));
      }
      if (req.url?.endsWith("/push/getReceipts")) return res.end(JSON.stringify({ data: {} }));
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((ok) => stub.listen(STUB_PORT, "127.0.0.1", () => ok()));

  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text };
  };

  const P = `pht${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const tok = (s: string) => `ExponentPushToken[${id(s)}]`;
  let createdAdmin = false;
  let adminId = "";
  let adminHadToken: string | null = null;

  try {
    await q(`DELETE FROM push_log`); await q(`DELETE FROM push_sends`);
    const adminRow = await q(`SELECT id, expo_push_token FROM users WHERE lower(email) = 'info@goutsyde.com'`);
    adminId = adminRow[0]?.id;
    adminHadToken = adminRow[0]?.expo_push_token ?? null;
    if (!adminId) {
      adminId = id("admin"); createdAdmin = true;
      await q(`INSERT INTO users (id, email, password, is_admin, username) VALUES ($1, 'info@goutsyde.com', 'x', true, $2)`, [adminId, `${P}adm`]);
    }
    await q(`UPDATE users SET expo_push_token = NULL WHERE id = $1`, [adminId]);
    const adminJwt = generateAccessToken({ userId: adminId, isVendor: false, isAdmin: true } as any);
    const add = (k: string, token: string | null) =>
      q(`INSERT INTO users (id, email, password, username, name, expo_push_token) VALUES ($1::text, $1::text || '@x.test', 'x', $1::text, 'Person ' || $1::text, $2)`, [id(k), token]);
    await add("cons", tok("cons"));
    await add("vend", tok("vend"));
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'Glow Studio', 'beauty', 'approved')`, [id("biz"), id("vend")]);
    await add("notok", null);
    const userJwt = generateAccessToken({ userId: id("cons"), isVendor: false } as any);

    // ── 1. admin only ───────────────────────────────────────────────────────
    const routes = [["GET", "/api/admin/push/audiences"], ["GET", "/api/admin/push/screens"], ["GET", "/api/admin/push/limits"],
      ["GET", "/api/admin/push/people?q=glow"], ["GET", "/api/admin/push/sends"], ["GET", "/api/admin/push/sends/x"],
      ["POST", "/api/admin/push/sends"], ["POST", "/api/admin/push/test"]] as const;
    for (const [m, p] of routes) {
      const r1 = await call(m, p, m === "POST" ? {} : undefined);
      const r2 = await call(m, p, m === "POST" ? {} : undefined, userJwt);
      assert(r1.status === 401 && r2.status === 403, `${m} ${p}: 401 signed out, 403 non admin`, [r1.status, r2.status]);
    }
    assert(pushed.length === 0, "nothing pushed by rejected calls");

    // ── 2. read routes ──────────────────────────────────────────────────────
    let r = await call("GET", "/api/admin/push/screens", undefined, adminJwt);
    assert(r.status === 200 && r.json.screens.length === 24 && r.json.defaultScreen === "activity" && r.json.byAudience.vendors.includes("business_dashboard") && !r.json.byAudience.consumers.includes("business_dashboard"), "screens list and fit rules", r.json?.screens?.length);
    r = await call("GET", "/api/admin/push/audiences", undefined, adminJwt);
    assert(r.status === 200 && r.json.counts.vendors >= 1 && r.json.counts.all >= 2, "audience counts", r.json);
    r = await call("GET", "/api/admin/push/limits", undefined, adminJwt);
    assert(r.status === 200 && r.json.max === 3 && r.json.sentToday === 0 && typeof r.json.quietHours === "boolean", "limits", r.json);
    r = await call("GET", "/api/admin/push/people?q=glow", undefined, adminJwt);
    assert(r.status === 200 && r.json.people.some((x: any) => x.id === id("vend") && x.hasToken && x.canPush), "people search finds the vendor", r.json);
    assert(!r.text.includes("@x.test") && !r.text.includes("ExponentPushToken"), "people search returns no email and no token");

    // ── 3. validation ───────────────────────────────────────────────────────
    const good = { audience: "picked", userIds: [id("cons"), id("vend"), id("notok")], title: "Partner kit", body: "Tap to see it.", screen: "events" };
    r = await call("POST", "/api/admin/push/sends", { ...good }, adminJwt);
    assert(r.status === 400 && r.json.error.code === "INVALID_CLIENT_KEY", "clientKey required", r.json);
    r = await call("POST", "/api/admin/push/sends", { ...good, audience: "consumers", userIds: undefined, screen: "business_dashboard", clientKey: "k0" }, adminJwt);
    assert(r.status === 400 && r.json.error.code === "INVALID_SCREEN", "vendor screen refused for consumers", r.json);
    r = await call("POST", "/api/admin/push/sends", { ...good, screen: "link", url: "https://evil.com", clientKey: "k0" }, adminJwt);
    assert(r.status === 400 && r.json.error.code === "INVALID_SCREEN", "non goutsyde link refused", r.json);
    r = await call("POST", "/api/admin/push/sends", { ...good, title: "x".repeat(66), clientKey: "k0" }, adminJwt);
    assert(r.status === 400 && r.json.error.code === "INVALID_CONTENT", "title over 65 refused", r.json);
    assert((await q(`SELECT count(*)::int n FROM push_sends`))[0].n === 0, "validation writes nothing");

    // ── 4. send ─────────────────────────────────────────────────────────────
    const key = `${P}-key1`;
    r = await call("POST", "/api/admin/push/sends", { ...good, clientKey: key }, adminJwt);
    assert(r.status === 202 && r.json.recipients === 2 && r.json.existing === false, "202 with 2 recipients (no token left out)", r.json);
    const sendId = r.json?.sendId;
    let detail: any = null;
    for (let i = 0; i < 40; i++) { detail = await call("GET", `/api/admin/push/sends/${sendId}`, undefined, adminJwt); if (detail.json?.send?.status === "done") break; await sleep(150); }
    assert(detail.json?.send?.status === "done" && detail.json.send.sentCount === 2, "send finished, 2 sent", detail.json?.send);
    assert(pushed.length === 2 && pushed.every((m) => m.data?.type === "announcement" && m.data?.screen === "events" && m.data?.sendId === sendId && m.title === "Partner kit"), "Expo got 2 announcement pushes with the screen", pushed);
    assert(!detail.text.includes("ExponentPushToken") && !detail.text.includes("@x.test"), "send detail has no token and no email");
    const again = await call("POST", "/api/admin/push/sends", { ...good, clientKey: key }, adminJwt);
    assert(again.status === 200 && again.json.sendId === sendId && again.json.existing === true && pushed.length === 2, "same clientKey: same send, nothing new pushed", again.json);
    const dup = await call("POST", "/api/admin/push/sends", { ...good, clientKey: `${P}-key2` }, adminJwt);
    assert(dup.status === 409 && dup.json.error.code === "DUPLICATE_SEND", "same text within 10 minutes: 409", dup.json);
    const notes = await q(`SELECT user_id, type, metadata FROM notifications WHERE reference_id = $1 ORDER BY user_id`, [sendId]);
    assert(notes.length === 2 && notes.every((n) => n.type === "announcement" && n.metadata.screen === "events"), "Activity row per recipient", notes);
    // GET /api/notifications reads only the session cookie (routes.ts, pre-existing), not a Bearer token,
    // so the Activity row is checked in the database above rather than through that route.
    r = await call("GET", "/api/admin/push/sends", undefined, adminJwt);
    assert(r.status === 200 && r.json.sends[0]?.id === sendId && r.json.sends[0].sentCount === 2, "history lists the send", r.json?.sends?.[0]);

    // ── 5. test push ────────────────────────────────────────────────────────
    r = await call("POST", "/api/admin/push/test", { title: "Test", body: "Body", screen: "edit_profile" }, adminJwt);
    assert(r.status === 400 && r.json.error.code === "NO_TOKEN", "test without a phone: NO_TOKEN", r.json);
    await q(`UPDATE users SET expo_push_token = $2 WHERE id = $1`, [adminId, tok("adminphone")]);
    r = await call("POST", "/api/admin/push/test", { title: "Test", body: "Body", screen: "edit_profile" }, adminJwt);
    assert(r.status === 200 && r.json.status === "sent" && pushed.length === 3 && pushed[2].to === tok("adminphone"), "test goes to the admin's phone only", r.json);
    r = await call("GET", "/api/admin/push/limits", undefined, adminJwt);
    assert(r.json?.sentToday === 1, "test doesn't count toward the limit", r.json);

    // ── 6. news preference ──────────────────────────────────────────────────
    r = await call("GET", "/api/push/preferences");
    assert(r.status === 401, "preferences: signed out 401", r.status);
    r = await call("GET", "/api/push/preferences", undefined, userJwt);
    assert(r.status === 200 && r.json.news === true, "preferences default on", r.json);
    r = await call("PUT", "/api/push/preferences", { news: "no" }, userJwt);
    assert(r.status === 400, "preferences: bad body 400", r.status);
    r = await call("PUT", "/api/push/preferences", { news: false }, userJwt);
    assert(r.status === 200 && r.json.news === false, "preferences off", r.json);
    r = await call("GET", "/api/admin/push/people?q=" + encodeURIComponent(id("cons")), undefined, adminJwt);
    assert(r.json?.people?.[0]?.newsOptOut === true && r.json.people[0].canPush === false, "opted out person shows as opted out", r.json);
    r = await call("PUT", "/api/push/preferences", { news: true }, userJwt);
    assert(r.status === 200 && r.json.news === true, "preferences back on", r.json);

    // ── 7. existing push routes ─────────────────────────────────────────────
    r = await call("POST", "/api/push/send-cart-reminders");
    const r2 = await call("POST", "/api/push/send-cart-reminders", undefined, userJwt);
    const r3 = await call("POST", "/api/push/send-cart-reminders", undefined, adminJwt);
    assert(r.status === 401 && r2.status === 403 && r3.status === 200, "send-cart-reminders: admin only now", [r.status, r2.status, r3.status]);
    r = await call("POST", "/api/push/expo-token", { expoPushToken: tok("cons-new") }, userJwt);
    assert(r.status === 200, "POST /api/push/expo-token still works", r.json);
    r = await call("GET", "/api/push/vapid-key");
    assert(r.status !== 404, "GET /api/push/vapid-key still routed", r.status);
  } finally {
    await q(`DELETE FROM notifications WHERE user_id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM push_log`); await q(`DELETE FROM push_sends`);
    await q(`DELETE FROM push_news_optouts WHERE user_id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM businesses WHERE owner_id LIKE $1`, [`${P}-%`]);
    if (createdAdmin) await q(`DELETE FROM notifications WHERE user_id = $1`, [adminId]);
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}-%`]);
    if (!createdAdmin && adminId) await q(`UPDATE users SET expo_push_token = $2 WHERE id = $1`, [adminId, adminHadToken]);
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
