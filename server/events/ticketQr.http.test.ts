/**
 * Events door check-in Task 4: signed QR image route + /me/tickets qrUrl. HTTP integration tests.
 *
 * Run with: npx tsx server/events/ticketQr.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (migrations through 067).
 *   EV_TEST_BASE_URL, EV_TEST_PG_URL (both localhost), JWT_SECRET identical to the server's.
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - skip the timingSafeEqual compare in ticketIdFromQrToken (accept any signature) → "tampered signature" and
 *    "edited ticket id" tests fail.
 *  - drop `status = 'valid'` in the route's lookup → "refunded ticket" and "cancelled ticket" 404 tests fail.
 *  - drop the Cross-Origin-Resource-Policy override → "four headers" fails (helmet's same-origin wins).
 *  - put the code (not the signed id) in the URL → "code never appears in qrUrl" fails.
 *  - drop the limiter → "121st QR request in a minute is 429" fails.
 *  - drop redactLogPath in the request logger → "logger redaction" unit checks still pass, so the logger wiring is
 *    covered by the source grep assertion at the end of this file (index.ts must call redactLogPath).
 */
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

type Res = { status: number; headers: http.IncomingHttpHeaders; raw: Buffer; body: any };
function get(base: string, p: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json: any = null; try { json = JSON.parse(raw.toString("utf8")); } catch {}
        resolve({ status: res.statusCode || 0, headers: res.headers, raw, body: json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test";
  const { generateAccessToken } = await import("../auth");
  const { qrTokenFor, ticketIdFromQrToken, qrUrlFor, qrPng } = await import("./ticketQr");
  const { redactLogPath } = await import("../logRedaction");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const P = `qr${Date.now().toString(36)}`;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
    [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, `${P}${s}`.slice(0, 24)],
  ))[0].id as string;
  const host = await mkUser("host");
  const guest = await mkUser("guest");
  const ev = (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, 'published', now() + interval '1 day', now() + interval '2 days', 'America/New_York') RETURNING id`,
    [host, `${P}-ev`, `${P} Event`],
  ))[0].id as string;
  const type = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, 'General', 0, 100) RETURNING id`, [ev]))[0].id as string;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const makeCode = () => Array.from({ length: 16 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  const mkTicket = async (status = "valid") => {
    const orderId = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, platform_fee_cents, host_net_cents, total_cents, completed_at)
       VALUES ($1, $2, 'completed', 1, 0, 0, 0, 0, now()) RETURNING id`, [ev, guest],
    ))[0].id as string;
    const itemId = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, 1, 0, 'issued', now()) RETURNING id`, [orderId, ev, type, guest],
    ))[0].id as string;
    const code = makeCode();
    const id = (await q(
      `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents, platform_fee_cents, host_net_cents)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 0, 0, 0) RETURNING id`, [orderId, itemId, ev, type, guest, code, status],
    ))[0].id as string;
    return { id, code };
  };

  const good = await mkTicket("valid");
  const good2 = await mkTicket("valid");
  const refunded = await mkTicket("refunded");
  const cancelled = await mkTicket("cancelled");
  const qrPath = (t: string) => `/api/events/qr/${t}.png`;

  // In-process app for the real per-IP limit
  const express = (await import("express")).default;
  const { default: doorRouter } = await import("./doorRouter");
  const app = express();
  app.use("/api/events", doorRouter);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const LOCAL = `http://127.0.0.1:${(srv.address() as any).port}`;

  try {
    console.log("\ntoken");
    const t1 = qrTokenFor(good.id);
    assert(ticketIdFromQrToken(t1) === good.id, "token round trip", t1);
    assert(!t1.includes(good.code) && !t1.includes("."), "token has neither the code nor a dot", t1);
    assert(qrTokenFor(good.id) === t1, "token is deterministic");
    assert(qrTokenFor(good2.id) !== t1, "different tickets give different tokens");
    const sep = t1.indexOf("~");
    const idPart = t1.slice(0, sep), sig = t1.slice(sep + 1);
    assert(sep > 0 && sig.length === 22 && /^[A-Za-z0-9_-]+$/.test(idPart + sig), "shape: base64url(id) ~ 22 char signature", t1);
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
    assert(ticketIdFromQrToken(`${idPart}~${flip(sig)}`) === null, "tampered signature → null");
    assert(ticketIdFromQrToken(`${Buffer.from(good2.id).toString("base64url")}~${sig}`) === null, "edited ticket id with old signature → null");
    for (const bad of ["", "abc", "~", `${idPart}~`, `~${sig}`, `${idPart}~${sig}~x`, `${idPart}.${sig}`, `${idPart}~${sig}extra`, `${idPart}~${sig.slice(0, 21)}`, "!!!~!!!"]) {
      assert(ticketIdFromQrToken(bad) === null, `malformed token rejected: ${JSON.stringify(bad)}`);
    }
    const png1 = await qrPng(good.code);
    const png2 = await qrPng(good2.code);
    assert(png1.subarray(0, 4).equals(PNG) && png2.subarray(0, 4).equals(PNG), "qrPng returns a PNG");
    assert(!png1.equals(png2), "two codes give two different images");
    assert(png1.readUInt32BE(16) === 512 && png1.readUInt32BE(20) === 512, "image is 512 wide and tall", [png1.readUInt32BE(16), png1.readUInt32BE(20)]);

    console.log("\nqrUrlFor");
    const url = qrUrlFor(good.id);
    assert(url.endsWith(`/api/events/qr/${t1}.png`) && /^https?:\/\/|^\/api/.test(url), "url ends with /api/events/qr/<token>.png", url);
    assert(!url.includes(good.code), "code never appears in the url", url);
    const prevBase = process.env.API_BASE_URL;
    process.env.API_BASE_URL = "https://api.example.test/";
    assert(qrUrlFor(good.id) === `https://api.example.test/api/events/qr/${t1}.png`, "API_BASE_URL used, trailing slash trimmed", qrUrlFor(good.id));
    if (prevBase === undefined) delete process.env.API_BASE_URL; else process.env.API_BASE_URL = prevBase;
    const prevSecret = { j: process.env.JWT_SECRET, s: process.env.SESSION_SECRET };
    delete process.env.JWT_SECRET; delete process.env.SESSION_SECRET;
    assert(typeof qrUrlFor(good.id) === "string" && qrUrlFor(good.id).includes("/api/events/qr/"), "no secret: qrUrlFor still returns a url");
    assert(ticketIdFromQrToken(t1) === null, "no secret: nothing verifies");
    process.env.JWT_SECRET = prevSecret.j!; if (prevSecret.s !== undefined) process.env.SESSION_SECRET = prevSecret.s;
    assert(ticketIdFromQrToken(t1) === good.id, "secret restored: verifies again");

    console.log("\nroute");
    let r = await get(BASE, qrPath(t1));
    assert(r.status === 200 && r.raw.subarray(0, 4).equals(PNG), "real token returns a PNG (public, no auth)", { s: r.status, h: r.headers["content-type"] });
    assert(r.headers["content-type"] === "image/png", "Content-Type image/png", r.headers["content-type"]);
    assert(r.headers["cross-origin-resource-policy"] === "cross-site", "Cross-Origin-Resource-Policy cross-site (overrides helmet)", r.headers["cross-origin-resource-policy"]);
    assert(r.headers["referrer-policy"] === "no-referrer", "Referrer-Policy no-referrer", r.headers["referrer-policy"]);
    assert(r.headers["cache-control"] === "private, max-age=86400", "Cache-Control private, max-age=86400", r.headers["cache-control"]);
    assert(r.raw.equals(png1), "served image equals qrPng(code) for that ticket (code looked up server side)");
    const r2 = await get(BASE, qrPath(qrTokenFor(good2.id)));
    assert(r2.status === 200 && !r2.raw.equals(r.raw), "another ticket serves another image");

    // Decode the PNG back to the code (python3 + OpenCV if present)
    let decoded: string | null | "unavailable" = "unavailable";
    try {
      const f = path.join(os.tmpdir(), `${P}.png`);
      fs.writeFileSync(f, r.raw);
      decoded = execFileSync("python3", ["-c", "import cv2,sys;im=cv2.imread(sys.argv[1]);print(cv2.QRCodeDetector().detectAndDecode(im)[0])", f], { encoding: "utf8" }).trim();
      fs.unlinkSync(f);
    } catch { decoded = "unavailable"; }
    if (decoded === "unavailable") console.log("  ⏭  decode check skipped (python3 + cv2 not available)");
    else assert(decoded === good.code, "decoded PNG equals the ticket code", decoded);

    const bads: Array<[string, string]> = [
      ["tampered signature", `${idPart}~${flip(sig)}`],
      ["edited ticket id", `${Buffer.from(good2.id).toString("base64url")}~${sig}`],
      ["unknown ticket (valid signature)", qrTokenFor("00000000-0000-4000-8000-000000000000")],
      ["refunded ticket", qrTokenFor(refunded.id)],
      ["cancelled ticket", qrTokenFor(cancelled.id)],
      ["garbage", "not-a-token"],
      ["raw ticket code", good.code],
    ];
    const bodies: string[] = [];
    for (const [name, t] of bads) {
      r = await get(BASE, qrPath(t));
      bodies.push(`${r.status}|${r.raw.toString("utf8")}|${r.headers["content-type"]}`);
      assert(r.status === 404, `${name} → 404`, { s: r.status, b: r.raw.toString().slice(0, 100) });
    }
    assert(new Set(bodies).size === 1, "all 404s are identical (status, body, content type)", bodies);
    assert(!r.raw.toString("utf8").includes("valid") && !r.raw.toString("utf8").includes("refund"), "404 body leaks no reason", r.raw.toString());
    r = await get(LOCAL, qrPath(t1).replace(".png", ".jpg"));
    assert(r.status === 404, "wrong extension → 404 (in process; the dev server's page fallback answers other paths)", r.status);

    console.log("\nno secret configured → 404 (in process)");
    {
      const keep = { j: process.env.JWT_SECRET, s: process.env.SESSION_SECRET };
      delete process.env.JWT_SECRET; delete process.env.SESSION_SECRET;
      r = await get(LOCAL, qrPath(t1));
      assert(r.status === 404, "route 404s without a secret", r.status);
      process.env.JWT_SECRET = keep.j!; if (keep.s !== undefined) process.env.SESSION_SECRET = keep.s;
      r = await get(LOCAL, qrPath(t1));
      assert(r.status === 200, "route serves once the secret is back (in process)", r.status);
    }

    console.log("\nlogger redaction");
    assert(redactLogPath(`/api/events/qr/${t1}.png`) === "/api/events/qr/[token].png", "token path redacted");
    assert(redactLogPath("/api/events/qr/anything-at-all.png") === "/api/events/qr/[token].png", "any token redacted");
    assert(redactLogPath(`/api/events/qr/${good.code}.png`) === "/api/events/qr/[token].png", "a raw code in that slot is redacted too");
    assert(redactLogPath("/api/events/me/tickets") === "/api/events/me/tickets", "other paths untouched");
    assert(redactLogPath("/api/events/door/mine") === "/api/events/door/mine", "door paths untouched");
    const idx = fs.readFileSync(path.join(process.cwd(), "server", "index.ts"), "utf8");
    assert(/redactLogPath\(\s*req\.path\s*\)/.test(idx) || /redactLogPath\(path\)/.test(idx), "request logger in index.ts uses redactLogPath");

    console.log("\nmy tickets");
    r = await get(BASE, "/api/events/me/tickets", { Authorization: `Bearer ${tok(guest)}` });
    assert(r.status === 200 && Array.isArray(r.body.tickets) && r.body.tickets.length === 2, "guest sees two valid tickets", r.body);
    const mine = r.body.tickets.find((x: any) => x.id === good.id);
    assert(mine && mine.qrUrl.endsWith(`/api/events/qr/${qrTokenFor(good.id)}.png`), "ticket carries qrUrl", mine?.qrUrl);
    assert(!JSON.stringify(r.body).includes(`qr/${good.code}`) && !mine.qrUrl.includes(good.code), "code never appears in qrUrl", mine?.qrUrl);
    const keys = Object.keys(mine).sort();
    assert(JSON.stringify(keys) === JSON.stringify(["checkedInAt", "code", "event", "id", "orderId", "qrUrl", "status", "ticketTypeName"]), "ticket keys: old ones plus qrUrl only", keys);
    assert(JSON.stringify(Object.keys(mine.event).sort()) === JSON.stringify(["addressHidden", "addressLine1", "addressLine2", "addressRevealAt", "coverImageUrl", "city", "endsAt", "id", "postalCode", "slug", "startsAt", "state", "status", "timezone", "title", "venueName"].sort()), "event keys unchanged", Object.keys(mine.event));
    assert(mine.code === good.code && mine.status === "valid" && mine.ticketTypeName === "General" && mine.checkedInAt === null, "old values unchanged");
    const viaUrl = await get(BASE, new URL(mine.qrUrl, BASE).pathname);
    assert(viaUrl.status === 200 && viaUrl.raw.subarray(0, 4).equals(PNG), "the qrUrl from my tickets actually serves the image", viaUrl.status);

    console.log("\nrate limit (per IP, in process)");
    let ok = 0; let last: Res | null = null;
    // 3 requests already went to LOCAL above; use a fresh budget via X-Forwarded-For is not honored (trust proxy off here), so count from now.
    const already = 2;
    for (let i = 0; i < 120 - already; i++) { last = await get(LOCAL, qrPath(t1)); if (last.status === 200) ok++; }
    assert(ok === 120 - already, "requests up to 120 per minute pass", { ok, last: last?.status });
    r = await get(LOCAL, qrPath(t1));
    assert(r.status === 429, "121st QR request in a minute is 429", r.status);
    assert(r.body?.success === false && r.body?.error?.code === "RATE_LIMITED" && typeof r.body?.error?.message === "string", "429 is the RATE_LIMITED shape", r.body);
  } finally {
    srv.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
