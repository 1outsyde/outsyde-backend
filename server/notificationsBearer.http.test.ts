/**
 * R37 (Quotes step 6c-2a, Legend 2026-11-05 call 1): the Activity routes take the app's sign in token as well as
 * the web session. GET /api/notifications, /unread-count, PATCH /:id/read, POST /mark-all-read. Each person only
 * ever reaches their own rows.
 * Run with: npx tsx server/notificationsBearer.http.test.ts (QT_TEST_BASE_URL, QT_TEST_PG_URL, same scratch setup
 * as server/quotes/quotes.http.test.ts). Skips when QT_TEST_BASE_URL is unset; refuses any non-local host.
 */
import http from "http";

const BASE = process.env.QT_TEST_BASE_URL;
const PG_URL = process.env.QT_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { "X-Forwarded-For": `10.97.2.${Math.floor(Math.random() * 200) + 1}` };
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
  if (!BASE) { console.log("⏭  skipped: set QT_TEST_BASE_URL (+ QT_TEST_PG_URL) to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "qt-test-jwt-secret";
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `nb${Date.now().toString(36)}`;
  const users: string[] = [];
  const mkUser = async (key: string) => {
    const uid = `${P}-${key}`;
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name) VALUES ($1::varchar, $1::text, $2, 'Ana', 'Tester', 'Ana')`, [uid, `${uid}@nb.test`]);
    users.push(uid);
    return { uid, token: generateAccessToken({ userId: uid, isVendor: false, isAdmin: false }) };
  };
  const mkRow = async (uid: string, title: string) =>
    (await q(`INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id, metadata) VALUES ($1, 'quote_extra', $2, 'Added Boxes to Move.', 'quote', $3, '{"quoteId":"q1"}'::jsonb) RETURNING id`, [uid, title, `${P}-ref`]))[0].id as string;

  try {
    const a = await mkUser("a");
    const b = await mkUser("b");
    const a1 = await mkRow(a.uid, "Row A1");
    const a2 = await mkRow(a.uid, "Row A2");
    const b1 = await mkRow(b.uid, "Row B1");

    console.log("\n── GET /api/notifications ──");
    let r = await call("GET", "/api/notifications");
    assert(r.status === 401, "no session and no token: 401", r.status);
    r = await call("GET", "/api/notifications", { token: "not-a-token" });
    assert(r.status === 401, "a bad token: 401", r.status);
    r = await call("GET", "/api/notifications", { token: a.token });
    const ids = (r.body?.notifications ?? []).map((n: any) => n.id);
    assert(r.status === 200 && ids.includes(a1) && ids.includes(a2) && !ids.includes(b1), "the app's token: only your own rows", { status: r.status, ids });
    const row = (r.body?.notifications ?? []).find((n: any) => n.id === a1);
    assert(row?.type === "quote_extra" && row?.metadata?.quoteId === "q1" && row?.referenceId === `${P}-ref`, "with the type, metadata and reference the app reads", row);

    console.log("\n── unread count, read, mark all read ──");
    r = await call("GET", "/api/notifications/unread-count", { token: a.token });
    assert(r.status === 200 && r.body?.count === 2, "unread count with the token", r);
    r = await call("PATCH", `/api/notifications/${b1}/read`, { token: a.token });
    assert(r.status === 404, "someone else's row: not found", r.status);
    assert((await q(`SELECT is_read FROM notifications WHERE id = $1`, [b1]))[0].is_read === false, "and it stays unread");
    r = await call("PATCH", `/api/notifications/${a1}/read`, { token: a.token });
    assert(r.status === 200 && (await q(`SELECT is_read FROM notifications WHERE id = $1`, [a1]))[0].is_read === true, "your own row: read", r.status);
    r = await call("POST", "/api/notifications/mark-all-read", { token: a.token });
    assert(r.status === 200 && (await q(`SELECT is_read FROM notifications WHERE id = $1`, [a2]))[0].is_read === true, "mark all read with the token", r.status);
    assert((await q(`SELECT is_read FROM notifications WHERE id = $1`, [b1]))[0].is_read === false, "never anyone else's");
    r = await call("POST", "/api/notifications/mark-all-read");
    assert(r.status === 401, "mark all read signed out: 401", r.status);
    r = await call("PATCH", `/api/notifications/${a1}/read`);
    assert(r.status === 401, "read signed out: 401", r.status);
    r = await call("GET", "/api/notifications/unread-count");
    assert(r.status === 401, "unread count signed out: 401", r.status);
  } finally {
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => undefined);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
