/**
 * Apple Wallet passes (p3-wallet): GET /api/events/wallet/:token.pkpass, walletUrl on /me/tickets, log redaction.
 * HTTP integration tests.
 *
 * Run with: npx tsx server/events/wallet.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres, started WITH the Wallet env
 * pointing at a throwaway certificate folder made by walletTestCerts.makeTestCerts(<dir>):
 *   APPLE_PASS_TYPE_ID=pass.com.goutsyde.tickets APPLE_TEAM_ID=ABCDE12345
 *   APPLE_PASS_CERT_PEM="$(cat <dir>/signer.pem)" APPLE_PASS_KEY_PEM="$(cat <dir>/signer.key)" APPLE_WWDR_PEM="$(cat <dir>/wwdr.pem)"
 * Test env: EV_TEST_BASE_URL, EV_TEST_PG_URL (both localhost), WALLET_TEST_CERT_DIR=<dir>, JWT_SECRET same as the server.
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - drop `t.status = 'valid'` in the wallet route → refunded and cancelled 404 tests fail.
 *  - verify with ticketIdFromQrToken in the wallet route → "a QR token here is 404" fails.
 *  - skip the walletConfig() check in the route → "not configured → 404 (in process)" fails.
 *  - drop the wallet rule in redactLogPath → the redaction checks fail.
 *  - send walletUrl when the ticket isn't valid / always → "walletUrl null without config" fails.
 */
import http from "http";
import fs from "fs";
import path from "path";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
const CERT_DIR = process.env.WALLET_TEST_CERT_DIR;

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

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL + WALLET_TEST_CERT_DIR to run"); process.exit(0); }
  if (!PG_URL || !CERT_DIR || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must be localhost and WALLET_TEST_CERT_DIR set");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test";
  const readCert = (f: string) => fs.readFileSync(path.join(CERT_DIR, f), "utf8");
  const certs = { signerCert: readCert("signer.pem"), signerKey: readCert("signer.key"), wwdr: readCert("wwdr.pem"), passphrase: "", signerKeyEncrypted: "", dir: CERT_DIR };

  const { generateAccessToken } = await import("../auth");
  const { walletTokenFor, resetWalletConfigCacheForTest } = await import("./walletPass");
  const { qrTokenFor } = await import("./ticketQr");
  const { redactLogPath } = await import("../logRedaction");
  const { setWalletEnv, unzipPass, signatureVerifies } = await import("./walletTestCerts");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const P = `wl${Date.now().toString(36)}`;
  const mkUser = async (s: string, first: string | null) => (await q(
    `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
    [`${P}-${s}@test.local`, `Person ${s}`, first, `${P}${s}`.slice(0, 24)],
  ))[0].id as string;
  const host = await mkUser("host", "Hosty");
  const guest = await mkUser("guest", "Zoë");
  const noName = await mkUser("noname", null);
  const ev = (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, venue_name, address_line1, city, state, postal_code, address_visibility)
     VALUES ($1, $2, $3, 'published', now() + interval '3 days', now() + interval '3 days 5 hours', 'America/Los_Angeles',
             'The Loft', '12 Main St', 'Los Angeles', 'CA', '90012', 'ticket_holders_day_of') RETURNING id`,
    [host, `${P}-ev`, `${P} Rooftop 🎉`],
  ))[0].id as string;
  const type = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, 'VIP Table', 0, 100) RETURNING id`, [ev]))[0].id as string;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const makeCode = () => Array.from({ length: 16 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  const mkTicket = async (holder: string, status = "valid") => {
    const orderId = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, platform_fee_cents, host_net_cents, total_cents, completed_at)
       VALUES ($1, $2, 'completed', 1, 0, 0, 0, 0, now()) RETURNING id`, [ev, holder],
    ))[0].id as string;
    const itemId = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, 1, 0, 'issued', now()) RETURNING id`, [orderId, ev, type, holder],
    ))[0].id as string;
    const code = makeCode();
    const id = (await q(
      `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents, platform_fee_cents, host_net_cents)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 0, 0, 0) RETURNING id`, [orderId, itemId, ev, type, holder, code, status],
    ))[0].id as string;
    return { id, code };
  };
  const good = await mkTicket(guest);
  const nameless = await mkTicket(noName);
  const refunded = await mkTicket(guest, "refunded");
  const cancelled = await mkTicket(guest, "cancelled");
  const wPath = (t: string) => `/api/events/wallet/${t}.pkpass`;
  const snapshot = async () => JSON.stringify(await q(`SELECT * FROM tickets WHERE event_id = $1 ORDER BY id`, [ev]));

  // In-process app (same routers) for the not-configured and rate limit cases.
  const express = (await import("express")).default;
  const { default: doorRouter } = await import("./doorRouter");
  const { default: ticketsRouter } = await import("./ticketsRouter");
  const app = express();
  app.use("/api/events", doorRouter);
  app.use("/api/events", ticketsRouter);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const LOCAL = `http://127.0.0.1:${(srv.address() as any).port}`;

  try {
    const before = await snapshot();

    console.log("\nmy tickets (server has Wallet configured)");
    let r = await get(BASE, "/api/events/me/tickets", { Authorization: `Bearer ${tok(guest)}` });
    assert(r.status === 200 && r.body.tickets.length === 1, "guest sees one valid ticket", r.body);
    const mine = r.body.tickets[0];
    assert(typeof mine.walletUrl === "string" && mine.walletUrl.endsWith(wPath(walletTokenFor(good.id))), "walletUrl is the signed pass link", mine.walletUrl);
    assert(!mine.walletUrl.includes(good.code), "code never appears in walletUrl", mine.walletUrl);
    assert(mine.qrUrl.endsWith(`/api/events/qr/${qrTokenFor(good.id)}.png`), "qrUrl unchanged", mine.qrUrl);

    console.log("\npass download");
    r = await get(BASE, new URL(mine.walletUrl).pathname);
    assert(r.status === 200, "walletUrl from my tickets downloads (public, no auth)", { s: r.status, b: r.raw.toString().slice(0, 200) });
    assert(r.headers["content-type"] === "application/vnd.apple.pkpass", "Content-Type application/vnd.apple.pkpass", r.headers["content-type"]);
    assert(r.headers["cache-control"] === "private, no-store", "Cache-Control private, no-store", r.headers["cache-control"]);
    assert(r.headers["referrer-policy"] === "no-referrer", "Referrer-Policy no-referrer", r.headers["referrer-policy"]);
    const files = unzipPass(r.raw);
    const pj = JSON.parse(files["pass.json"].toString("utf8"));
    assert(pj.barcodes?.[0]?.message === good.code, "barcode = this ticket's code", pj.barcodes);
    assert(pj.serialNumber === good.id, "serialNumber = ticket id");
    const all = [...pj.eventTicket.primaryFields, ...pj.eventTicket.secondaryFields, ...pj.eventTicket.auxiliaryFields, ...pj.eventTicket.backFields];
    assert(all.find((f: any) => f.key === "name")?.value === "Zoë", "Name = the holder's first name", all.find((f: any) => f.key === "name"));
    assert(all.find((f: any) => f.key === "ticket")?.value === "VIP Table", "ticket type");
    assert(all.find((f: any) => f.key === "event")?.value === `${P} Rooftop 🎉`, "event title");
    assert(all.find((f: any) => f.key === "where")?.value === "Los Angeles, CA" && !JSON.stringify(pj).includes("12 Main St"), "day of event, 3 days out: city and state only");
    assert(signatureVerifies(files["signature"], files["manifest.json"], certs.signerCert), "pass signed by the configured certificate");
    r = await get(BASE, wPath(walletTokenFor(nameless.id)));
    const pj2 = JSON.parse(unzipPass(r.raw)["pass.json"].toString("utf8"));
    assert(r.status === 200 && !pj2.eventTicket.auxiliaryFields.some((f: any) => f.key === "name"), "holder without a first name: no Name field");

    console.log("\n404 rules");
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
    const tg = walletTokenFor(good.id);
    const bads: Array<[string, string]> = [
      ["tampered signature", flip(tg)],
      ["unknown ticket (valid signature)", walletTokenFor("00000000-0000-4000-8000-000000000000")],
      ["refunded ticket", walletTokenFor(refunded.id)],
      ["cancelled ticket", walletTokenFor(cancelled.id)],
      ["a QR token here", qrTokenFor(good.id)],
      ["raw ticket code", good.code],
      ["garbage", "nope"],
    ];
    const bodies: string[] = [];
    for (const [name, t] of bads) {
      r = await get(BASE, wPath(t));
      bodies.push(`${r.status}|${r.raw.toString("utf8")}|${r.headers["content-type"]}`);
      assert(r.status === 404 && r.body?.success === false && r.body?.error?.code === "NOT_FOUND", `${name} → 404 NOT_FOUND`, { s: r.status, b: r.raw.toString().slice(0, 120) });
    }
    assert(new Set(bodies).size === 1, "all 404s are identical", bodies);
    r = await get(BASE, `/api/events/qr/${tg}.png`);
    assert(r.status === 404, "a Wallet token doesn't open the QR image", r.status);
    r = await get(LOCAL, `/api/events/wallet/${tg}.png`);
    assert(r.status === 404, "wrong extension → 404 (in process)", r.status);

    console.log("\nnot configured → 404 and walletUrl null (in process)");
    {
      const restore = setWalletEnv(certs, { APPLE_WWDR_PEM: undefined });
      resetWalletConfigCacheForTest();
      r = await get(LOCAL, wPath(tg));
      assert(r.status === 404 && r.body?.error?.code === "NOT_FOUND", "route 404s when Wallet isn't fully configured", r.status);
      r = await get(LOCAL, "/api/events/me/tickets", { Authorization: `Bearer ${tok(guest)}` });
      assert(r.status === 200 && r.body.tickets[0].walletUrl === null, "walletUrl null without config", r.body.tickets?.[0]?.walletUrl);
      assert(typeof r.body.tickets[0].qrUrl === "string", "qrUrl still there without Wallet config");
      restore();
      const restore2 = setWalletEnv(certs, { APPLE_PASS_KEY_PEM: "broken" });
      resetWalletConfigCacheForTest();
      r = await get(LOCAL, wPath(tg));
      assert(r.status === 404 && !r.raw.toString().toLowerCase().includes("stack"), "malformed key → 404 JSON, no stack", { s: r.status, b: r.raw.toString().slice(0, 120) });
      restore2();
      const restore3 = setWalletEnv(certs);
      resetWalletConfigCacheForTest();
      r = await get(LOCAL, wPath(tg));
      assert(r.status === 200 && r.headers["content-type"] === "application/vnd.apple.pkpass", "serves once configured (in process)", r.status);
      restore3();
      resetWalletConfigCacheForTest();
    }

    console.log("\nno writes");
    assert((await snapshot()) === before, "downloads and list reads change no tickets row");

    console.log("\nlogger redaction");
    assert(redactLogPath(wPath(tg)) === "/api/events/wallet/[token].pkpass", "wallet token path redacted");
    assert(redactLogPath(`/API/Events/Wallet/${tg}.pkpass`) === "/API/Events/Wallet/[token].pkpass", "case-insensitive");
    assert(!redactLogPath(`/api/events/wallet/${tg}/x`).includes(tg), "anything under wallet redacted");
    assert(redactLogPath(`/api/events/qr/${qrTokenFor(good.id)}.png`) === "/api/events/qr/[token].png", "QR redaction unchanged");
    assert(redactLogPath("/api/events/walletx/abc") === "/api/events/walletx/abc", "sibling prefix untouched");
    assert(redactLogPath("/api/events/me/tickets") === "/api/events/me/tickets", "other paths untouched");

    console.log("\nrate limit (per IP, in process; shared with the QR images)");
    let ok = 0;
    const used = 3; // in-process wallet requests above that reach the limiter (the .png one never matches the route)
    for (let i = 0; i < 120 - used; i++) { const x = await get(LOCAL, `/api/events/wallet/${flip(tg)}.pkpass`); if (x.status === 404) ok++; }
    assert(ok === 120 - used, "up to 120 a minute answered", ok);
    r = await get(LOCAL, wPath(tg));
    assert(r.status === 429 && r.body?.error?.code === "RATE_LIMITED", "121st request in a minute is 429", r.status);
  } finally {
    srv.close();
    await q(`DELETE FROM tickets WHERE event_id = $1`, [ev]);
    await q(`DELETE FROM ticket_order_items WHERE event_id = $1`, [ev]);
    await q(`DELETE FROM ticket_orders WHERE event_id = $1`, [ev]);
    await q(`DELETE FROM ticket_types WHERE event_id = $1`, [ev]);
    await q(`DELETE FROM events WHERE id = $1`, [ev]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
