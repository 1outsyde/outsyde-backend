/**
 * Events & Ticketing Phase 2 PR 5a: host payouts (accounts, readiness, status routes; later tasks add the payout job and recoveries).
 *
 * Run with: npx tsx server/events/eventPayouts.http.test.ts
 *
 * SCRATCH ONLY. Same setup as ticketRefunds.http.test.ts (local Postgres with migrations through 061, backend on
 * localhost with the Stripe stub preload, DATABASE_URL + neon preload for in-process calls):
 *   EV_TEST_BASE_URL, EV_TEST_PG_URL, EV_TEST_STRIPE_PORT, JWT_SECRET
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host. Nothing reaches real Stripe.
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const BASE_PAID = process.env.EV_TEST_BASE_URL_PAID; // second server, PAID_EVENTS_ENABLED=true
const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.EV_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, ms = 5000) { const end = Date.now() + ms; while (!check() && Date.now() < end) await sleep(50); }
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown; base?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, o.base ?? BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
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

async function getNoFollow(path: string): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: "GET", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode || 0, location: (res.headers.location as string) ?? null }));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL + EV_TEST_STRIPE_PORT to run"); process.exit(0); }
  if (!BASE_PAID || !isLocal(BASE_PAID)) throw new Error("refusing to run: EV_TEST_BASE_URL_PAID must be set and localhost");
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error("refusing to run: BASE and PG_URL must be localhost and EV_TEST_STRIPE_PORT set");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub, shared by the server (over HTTP) and this process (direct calls). One section per endpoint;
  // later tasks add to the sections below (state first, then the route in the handler). ──
  const formParams = (form: URLSearchParams) => { const o: Record<string, string> = {}; for (const [k, v] of form.entries()) o[k] = v; return o; };

  // Section: /v1/accounts (create, retrieve). accountState is per account; default all false.
  let accountSeq = 0;
  const accountCreates: Array<Record<string, string>> = [];
  const accountsByKey: Record<string, any> = {};
  const accountKeys: string[] = [];
  const failRetrieveFor = new Set<string>(); // GET /v1/accounts/:id answers account_invalid
  const accountState: Record<string, { charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean }> = {};
  const stateOf = (id: string) => (accountState[id] ??= { charges_enabled: false, payouts_enabled: false, details_submitted: false });
  const setReady = (id: string, ready = true) => { Object.assign(stateOf(id), { charges_enabled: ready, payouts_enabled: ready, details_submitted: ready }); };

  // Section: /v1/account_links. A chosen account id can be made to answer account_invalid.
  const accountLinkCalls: Array<Record<string, string>> = [];
  const failLinksFor = new Set<string>();

  // Section: /v1/transfers (+ reversals). Switches: failTransfer, insufficient (until turned off), failOnce, loseResponse (counts).
  const sw = { failTransfer: false, insufficient: false, failOnce: 0, loseResponse: 0 };
  const transfers: any[] = [];
  const reversals: any[] = [];
  const transferPosts: Array<{ key: string | null; payoutId: string | null; ok: boolean; replayed: boolean }> = []; // every POST, failed ones too
  // Stripe saves the first response for an Idempotency-Key and replays it for 24h, errors (500s, balance_insufficient) included.
  const savedByKey: Record<string, { code: number; body: any }> = {};
  /** Stripe's rules for POST /v1/transfers, shared by the HTTP stub and the in-process fake. */
  const doTransfer = (params: Record<string, string>, key: string | null): { code: number; body: any } => {
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
    const log = (ok: boolean, replayed = false) => transferPosts.push({ key, payoutId: metadata.payoutId ?? null, ok, replayed });
    if (key && savedByKey[key]) { log(savedByKey[key].code === 200, true); return savedByKey[key]; }
    let out: { code: number; body: any };
    if (sw.insufficient) out = { code: 400, body: { error: { type: "invalid_request_error", code: "balance_insufficient", message: "Insufficient funds in Stripe account." } } };
    else if (sw.failTransfer || sw.failOnce > 0) {
      if (sw.failOnce > 0) sw.failOnce--;
      out = { code: 500, body: { error: { type: "api_error", message: "stub transfer failure" } } };
    } else {
      const t = { id: `tr_stub_${transfers.length + 1}`, object: "transfer", amount: Number(params.amount), currency: params.currency, destination: params.destination, transfer_group: params.transfer_group ?? null, metadata, reversed: false, amount_reversed: 0 };
      transfers.push(t);
      out = { code: 200, body: t };
    }
    if (key) savedByKey[key] = out;
    if (out.code === 200 && sw.loseResponse > 0) {
      // Created and saved on Stripe's side, but the caller never hears back.
      sw.loseResponse--;
      log(false);
      return { code: 500, body: { error: { type: "api_connection_error", message: "stub: response lost" } } };
    }
    log(out.code === 200);
    return out;
  };
  // Reversals (task 7): own switches, same replay-per-key rule, a list per transfer.
  const rsw = { insufficient: false, failRev: false, failOnce: 0, loseResponse: 0, failLookup: 0, timeoutLandLater: 0 };
  /** Reversals Stripe is still working on after the client timed out: landLater() makes them land. */
  const inFlightReversals: Array<() => void> = [];
  const landLater = () => { while (inFlightReversals.length) inFlightReversals.shift()!(); };
  const reversalPosts: Array<{ key: string | null; ticketId: string | null; ok: boolean; replayed: boolean }> = [];
  const doReversal = (transferId: string, params: Record<string, string>, key: string | null): { code: number; body: any } => {
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
    const log = (ok: boolean, replayed = false) => reversalPosts.push({ key, ticketId: metadata.ticketId ?? null, ok, replayed });
    if (key && savedByKey[key]) { log(savedByKey[key].code === 200, true); return savedByKey[key]; }
    const t = transfers.find((x) => x.id === transferId);
    if (t && rsw.timeoutLandLater > 0) {
      // The client gives up (timeout) while Stripe is still working: nothing exists yet, it lands later.
      rsw.timeoutLandLater--;
      inFlightReversals.push(() => {
        const rv = { id: `trr_stub_${reversals.length + 1}`, object: "transfer_reversal", transfer: t.id, amount: Number(params.amount), metadata };
        reversals.push(rv); t.amount_reversed += rv.amount;
        if (key) savedByKey[key] = { code: 200, body: rv };
      });
      log(false);
      return { code: 500, body: { error: { type: "api_connection_error", message: "stub: request timed out" } } };
    }
    let out: { code: number; body: any };
    if (!t) out = { code: 404, body: { error: { type: "invalid_request_error", message: "No such transfer" } } };
    else if (rsw.insufficient) out = { code: 400, body: { error: { type: "invalid_request_error", code: "balance_insufficient", message: "Insufficient funds in the connected account." } } };
    else if (rsw.failRev || rsw.failOnce > 0) {
      if (rsw.failOnce > 0) rsw.failOnce--;
      out = { code: 500, body: { error: { type: "api_error", message: "stub reversal failure" } } };
    } else {
      const rv = { id: `trr_stub_${reversals.length + 1}`, object: "transfer_reversal", transfer: t.id, amount: Number(params.amount), metadata };
      reversals.push(rv); t.amount_reversed += rv.amount;
      out = { code: 200, body: rv };
    }
    if (key) savedByKey[key] = out;
    if (out.code === 200 && rsw.loseResponse > 0) {
      rsw.loseResponse--;
      log(false);
      return { code: 500, body: { error: { type: "api_connection_error", message: "stub: response lost" } } };
    }
    log(out.code === 200);
    return out;
  };

  // Section: /v1/customers, /v1/payment_intents, /v1/refunds (checkout and host refunds, task 6). Same rules as ticketRefunds.http.test.ts.
  const piStore: Record<string, any> = {};
  const refundsByKey: Record<string, any> = {};
  const doRefund = (piId: string, amount: number, key: string | null): { code: number; body: any } => {
    const pi = piStore[piId];
    if (!pi) return { code: 404, body: { error: { message: "No such payment_intent" } } };
    if (key && refundsByKey[key]) return { code: 200, body: refundsByKey[key] };
    if (amount > pi.amount_received - pi.amount_refunded) return { code: 400, body: { error: { type: "invalid_request_error", message: "amount exceeds what's left" } } };
    pi.amount_refunded += amount;
    const refund = { id: `re_${Math.random().toString(36).slice(2, 10)}`, object: "refund", amount, payment_intent: piId, status: "succeeded" };
    if (key) refundsByKey[key] = refund;
    return { code: 200, body: refund };
  };
  const piJson = (pi: any) => ({ ...pi, latest_charge: { id: `ch_${pi.id}`, object: "charge", amount_refunded: pi.amount_refunded } });

  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const url = new URL(req.url ?? "", "http://stub");
      const path = url.pathname;
      const key = (req.headers["idempotency-key"] as string) ?? null;

      // /v1/accounts
      if (req.method === "POST" && path === "/v1/accounts") {
        const params = formParams(form);
        if (key) accountKeys.push(key);
        if (key && accountsByKey[key]) return send(200, accountsByKey[key]); // same key = same account, as Stripe does
        const id = `acct_stub_${++accountSeq}`;
        accountCreates.push(params);
        stateOf(id);
        const acct = { id, object: "account", email: params.email ?? null, ...accountState[id] };
        if (key) accountsByKey[key] = acct;
        return send(200, acct);
      }
      const acctM = path.match(/^\/v1\/accounts\/([^/]+)$/);
      if (req.method === "GET" && acctM && failRetrieveFor.has(acctM[1])) return send(400, { error: { type: "invalid_request_error", code: "account_invalid", message: "The provided key does not have access to account." } });
      if (req.method === "GET" && acctM) return send(200, { id: acctM[1], object: "account", ...stateOf(acctM[1]) });

      // /v1/account_links
      if (req.method === "POST" && path === "/v1/account_links") {
        const params = formParams(form);
        accountLinkCalls.push(params);
        if (failLinksFor.has(params.account)) return send(400, { error: { type: "invalid_request_error", code: "account_invalid", message: "You requested an account link for an account that is not connected to your platform or does not exist." } });
        return send(200, { object: "account_link", url: `https://connect.stripe.test/setup/${params.account}`, expires_at: Math.floor(Date.now() / 1000) + 300 });
      }

      // /v1/transfers
      if (req.method === "POST" && path === "/v1/transfers") {
        const r = doTransfer(formParams(form), key);
        return send(r.code, r.body);
      }
      if (req.method === "GET" && path === "/v1/transfers") {
        const group = url.searchParams.get("transfer_group");
        return send(200, { object: "list", has_more: false, data: transfers.filter((t) => !group || t.transfer_group === group) });
      }
      const revM = path.match(/^\/v1\/transfers\/([^/]+)\/reversals$/);
      if (req.method === "POST" && revM) {
        const r = doReversal(revM[1], formParams(form), key);
        return send(r.code, r.body);
      }
      if (req.method === "GET" && revM) {
        return send(200, { object: "list", has_more: false, data: reversals.filter((x) => x.transfer === revM[1]) });
      }

      // /v1/customers, /v1/payment_intents, /v1/refunds
      if (req.method === "POST" && path === "/v1/customers") return send(200, { id: `cus_stub_${Date.now()}`, object: "customer" });
      const custM = path.match(/^\/v1\/customers\/([^/]+)$/);
      if (req.method === "GET" && custM) return send(200, { id: custM[1], object: "customer" });
      if (req.method === "POST" && path === "/v1/payment_intents") {
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        const id = `pi_ep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        piStore[id] = { id, object: "payment_intent", amount: Number(form.get("amount") || 0), amount_received: 0, amount_refunded: 0,
          status: "requires_payment_method", client_secret: `${id}_secret`, metadata };
        return send(200, piStore[id]);
      }
      const cancelM = path.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelM) {
        const pi = piStore[cancelM[1]];
        if (!pi) return send(404, { error: { message: "No such payment_intent" } });
        if (pi.status === "succeeded") return send(400, { error: { message: "already succeeded" } });
        pi.status = "canceled"; return send(200, piJson(pi));
      }
      const piM = path.match(/^\/v1\/payment_intents\/([^/]+)$/);
      if (req.method === "GET" && piM) { const pi = piStore[piM[1]]; return pi ? send(200, piJson(pi)) : send(404, { error: { message: "No such payment_intent" } }); }
      if (req.method === "POST" && path === "/v1/refunds") {
        const r = doRefund(String(form.get("payment_intent")), Number(form.get("amount")), key);
        return send(r.code, r.body);
      }

      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const P = `ep${Date.now().toString(36)}`;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO users (id, email, name, first_name, username) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [`${P}-${s}@test.local`, `Host ${s}`, `Host${s}`, `${P}${s}`.slice(0, 20)],
  ))[0].id as string;
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });
  const hostA = await mkUser("a");   // plain customer
  const hostB = await mkUser("b");   // business owner
  const hostC = await mkUser("c");   // photographer
  const hostD = await mkUser("d");   // customer whose saved account is gone from Stripe
  const hostE = await mkUser("e");   // two simultaneous first calls
  const nobody = await mkUser("n");  // no profiles

  try {
    console.log("setup-link: auth and body");
    let r = await call("POST", "/api/events/payouts/setup-link", { body: {} });
    assert(r.status === 401 && r.body.error.code === "NO_AUTH", "no auth: 401 NO_AUTH", r);
    r = await call("GET", "/api/events/payouts/status");
    assert(r.status === 401 && r.body.error.code === "NO_AUTH", "status without auth: 401 NO_AUTH", r);

    console.log("setup-link creates one host account");
    r = await call("POST", "/api/events/payouts/setup-link", { token: tok(hostA), body: {} });
    assert(r.status === 200 && r.body.success === true && /^https:\/\/connect\.stripe\.test\/setup\/acct_stub_\d+$/.test(r.body.url), "first call returns an onboarding url", r);
    const r2 = await call("POST", "/api/events/payouts/setup-link", { token: tok(hostA), body: { web: true } });
    assert(r2.status === 200 && r2.body.url === r.body.url, "second call reuses the same account", r2);
    const mine = accountCreates.filter((a) => a.email === `${P}-a@test.local`);
    assert(mine.length === 1, "stub saw exactly one POST /v1/accounts for this user", mine);
    assert(mine[0]?.["metadata[role]"] === "host" && mine[0]?.["metadata[userId]"] === hostA, "metadata role=host and userId", mine[0]);
    assert(mine[0]?.["capabilities[card_payments][requested]"] === "true" && mine[0]?.["capabilities[transfers][requested]"] === "true", "card_payments and transfers requested", mine[0]);
    assert(mine[0]?.type === "express" && mine[0]?.business_type === "individual", "express, individual", mine[0]);
    let uas = await q(`SELECT * FROM user_payout_accounts WHERE user_id = $1`, [hostA]);
    assert(uas.length === 1 && uas[0].onboarding_complete === false && uas[0].stripe_account_id === r.body.url.split("/").pop(), "one user_payout_accounts row, not complete", uas);
    const acctA = uas[0].stripe_account_id as string;
    const linksA = accountLinkCalls.filter((l) => l.account === acctA);
    assert(linksA.length === 2, "two links made for the one account", linksA);
    assert(/\/api\/stripe\/connect-return\?account=acct_stub_\d+&type=host$/.test(linksA[0].return_url) && /\/api\/stripe\/connect-refresh\?account=acct_stub_\d+&type=host$/.test(linksA[0].refresh_url), "app links use type=host", linksA[0]);
    assert(/&type=host-web$/.test(linksA[1].return_url) && /&type=host-web$/.test(linksA[1].refresh_url), "web: true uses type=host-web", linksA[1]);
    assert(linksA[0].type === "account_onboarding", "link type is account_onboarding", linksA[0]);

    console.log("setup-link replaces an unreachable account once");
    r = await call("POST", "/api/events/payouts/setup-link", { token: tok(hostD), body: {} });
    const oldD = (await q(`SELECT stripe_account_id FROM user_payout_accounts WHERE user_id = $1`, [hostD]))[0].stripe_account_id as string;
    await q(`UPDATE user_payout_accounts SET onboarding_complete = true WHERE user_id = $1`, [hostD]);
    failLinksFor.add(oldD);
    const createsBefore = accountCreates.length;
    r = await call("POST", "/api/events/payouts/setup-link", { token: tok(hostD), body: {} });
    const newD = (await q(`SELECT * FROM user_payout_accounts WHERE user_id = $1`, [hostD]));
    assert(r.status === 200 && newD.length === 1 && newD[0].stripe_account_id !== oldD && r.body.url.endsWith(newD[0].stripe_account_id), "new account saved and its link returned", { r, newD });
    assert(accountCreates.length === createsBefore + 1, "exactly one replacement account created", accountCreates.length - createsBefore);
    assert(newD[0].onboarding_complete === false, "replacement starts unfinished", newD[0]);
    r = await call("POST", "/api/events/payouts/setup-link", { token: tok(hostD), body: {} });
    assert(r.status === 200 && accountCreates.length === createsBefore + 1, "next call reuses the replacement", { status: r.status, extra: accountCreates.length - createsBefore });

    console.log("two simultaneous first calls share one Stripe account");
    const [c1, c2] = await Promise.all([
      call("POST", "/api/events/payouts/setup-link", { token: tok(hostE), body: {} }),
      call("POST", "/api/events/payouts/setup-link", { token: tok(hostE), body: {} }),
    ]);
    const eRows = await q(`SELECT stripe_account_id FROM user_payout_accounts WHERE user_id = $1`, [hostE]);
    const eCreates = accountCreates.filter((a) => a.email === `${P}-e@test.local`);
    assert(c1.status === 200 && c2.status === 200 && c1.body.url === c2.body.url && eRows.length === 1 && c1.body.url.endsWith(eRows[0].stripe_account_id), "both calls return the link for the one saved account", { c1, c2, eRows });
    assert(eCreates.length === 1, "stub created one account for the pair", eCreates.length);
    assert(accountKeys.includes(`host_account_${hostE}`), "account created with key host_account_<userId>", accountKeys);
    assert(accountKeys.some((k) => k.startsWith(`host_account_${hostD}_replace_`)), "replacement uses host_account_<userId>_replace_<old id>", accountKeys);

    console.log("status for a user host");
    r = await call("GET", "/api/events/payouts/status?hostType=user", { token: tok(nobody) });
    assert(r.status === 200 && r.body.success && r.body.hostType === "user" && r.body.hasAccount === false && r.body.ready === false && r.body.needsSetup === true, "before setup: no account, not ready, needs setup", r);
    r = await call("GET", "/api/events/payouts/status", { token: tok(hostA) });
    assert(r.status === 200 && r.body.hasAccount === true && r.body.ready === false && r.body.needsSetup === true, "account made but not finished: needs setup (hostType defaults to user)", r);
    await q(`UPDATE user_payout_accounts SET onboarding_complete = true WHERE user_id = $1`, [hostA]);
    r = await call("GET", "/api/events/payouts/status?hostType=user", { token: tok(hostA) });
    assert(r.status === 200 && r.body.hasAccount === true && r.body.ready === false && r.body.needsSetup === true, "flag true but Stripe not ready: still needs setup", r);
    setReady(acctA);
    r = await call("GET", "/api/events/payouts/status?hostType=user", { token: tok(hostA) });
    assert(r.status === 200 && r.body.hasAccount === true && r.body.ready === true && r.body.needsSetup === false, "flag true and Stripe ready: ready", r);
    r = await call("GET", "/api/events/payouts/status?hostType=nonsense", { token: tok(hostA) });
    assert(r.status === 400 && r.body.error.code === "INVALID_HOST_TYPE", "unknown hostType: 400", r);

    console.log("status when the saved account is unreachable");
    failRetrieveFor.add(acctA);
    r = await call("GET", "/api/events/payouts/status?hostType=user", { token: tok(hostA) });
    assert(r.status === 200 && r.body.hasAccount === true && r.body.ready === false && r.body.needsSetup === true, "unreachable account: 200, not ready, needs setup (no 500)", r);
    failRetrieveFor.delete(acctA);

    console.log("status for a business host uses the business account");
    r = await call("GET", "/api/events/payouts/status?hostType=business", { token: tok(hostB) });
    assert(r.status === 403 && r.body.error.code === "NOT_A_BUSINESS_OWNER", "hostType=business without a business: 403", r);
    const bizId = (await q(
      `INSERT INTO businesses (owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 'beauty', 'pending', 'acct_biz_ep', true) RETURNING id`,
      [hostB, `${P} Biz`]))[0].id;
    r = await call("GET", "/api/events/payouts/status?hostType=business", { token: tok(hostB) });
    assert(r.status === 403 && r.body.error.code === "BUSINESS_NOT_APPROVED", "unapproved business: 403", r);
    await q(`UPDATE businesses SET approval_status = 'approved' WHERE id = $1`, [bizId]);
    const createsBiz = accountCreates.length;
    r = await call("GET", "/api/events/payouts/status?hostType=business", { token: tok(hostB) });
    assert(r.status === 200 && r.body.hostType === "business" && r.body.hasAccount === true && r.body.ready === false && r.body.needsSetup === true, "business account exists but Stripe not ready", r);
    setReady("acct_biz_ep");
    r = await call("GET", "/api/events/payouts/status?hostType=business", { token: tok(hostB) });
    assert(r.status === 200 && r.body.hasAccount === true && r.body.ready === true && r.body.needsSetup === false, "business account ready", r);
    await q(`UPDATE businesses SET stripe_onboarding_complete = false WHERE id = $1`, [bizId]);
    r = await call("GET", "/api/events/payouts/status?hostType=business", { token: tok(hostB) });
    assert(r.status === 200 && r.body.hasAccount === true && r.body.ready === false, "business local flag false: not ready even if Stripe is", r);
    assert(accountCreates.length === createsBiz && (await q(`SELECT 1 FROM user_payout_accounts WHERE user_id = $1`, [hostB])).length === 0, "no new Stripe account and no user_payout_accounts row for the business owner");

    console.log("status for a photographer host");
    r = await call("GET", "/api/events/payouts/status?hostType=photographer", { token: tok(hostC) });
    assert(r.status === 403 && r.body.error.code === "NOT_A_PHOTOGRAPHER", "hostType=photographer without a profile: 403", r);
    await q(`INSERT INTO photographers (user_id, display_name, hourly_rate, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 100, 'acct_photo_ep', true)`, [hostC, `${P} Photo`]);
    setReady("acct_photo_ep");
    r = await call("GET", "/api/events/payouts/status?hostType=photographer", { token: tok(hostC) });
    assert(r.status === 200 && r.body.hostType === "photographer" && r.body.hasAccount === true && r.body.ready === true && r.body.needsSetup === false, "photographer account ready", r);
    r = await call("GET", "/api/events/payouts/status?hostType=user", { token: tok(hostC) });
    assert(r.status === 200 && r.body.hasAccount === false && r.body.ready === false, "same person hosting as themselves: separate (user) account state", r);

    console.log("isHostReady (in process, fake Stripe)");
    const { isHostReady, hostPayoutDestination } = await import("./hostPayouts");
    let liveCalls = 0; let liveReady = true;
    const fake = { getPayoutReadiness: async (_id: string) => { liveCalls++; return { ready: liveReady, chargesEnabled: liveReady, payoutsEnabled: liveReady, detailsSubmitted: true }; } };
    const uEv = (u: string) => ({ host_type: "user", host_user_id: u, host_business_id: null, host_photographer_id: null });
    let ready = await isHostReady(uEv(nobody), fake);
    assert(ready.ready === false && ready.reason === "no_account" && liveCalls === 0, "no account: no_account, Stripe not asked", { ready, liveCalls });
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id) VALUES ($1, $2)`, [nobody, `acct_local_${P}`]);
    ready = await isHostReady(uEv(nobody), fake);
    assert(ready.ready === false && ready.reason === "not_complete" && liveCalls === 0, "account not complete locally: not_complete, Stripe not asked", { ready, liveCalls });
    await q(`UPDATE user_payout_accounts SET onboarding_complete = true WHERE user_id = $1`, [nobody]);
    liveReady = false;
    ready = await isHostReady(uEv(nobody), fake);
    assert(ready.ready === false && ready.reason === "stripe_not_ready" && liveCalls === 1, "Stripe says no: stripe_not_ready", { ready, liveCalls });
    liveReady = true;
    ready = await isHostReady(uEv(nobody), fake);
    assert(ready.ready === true && ready.reason === null, "everything yes: ready", ready);
    const boom = { getPayoutReadiness: async (_id: string) => { throw Object.assign(new Error("stripe down"), { type: "StripeConnectionError" }); } };
    ready = await isHostReady(uEv(nobody), boom);
    assert(ready.ready === false && ready.reason === "stripe_not_ready", "Stripe error: stripe_not_ready, never throws", ready);
    const dBiz = await hostPayoutDestination({ host_type: "business", host_user_id: hostB, host_business_id: bizId, host_photographer_id: null });
    assert(dBiz.destinationType === "business" && dBiz.accountId === "acct_biz_ep" && dBiz.localReady === false, "destination: business", dBiz);
    const dUser = await hostPayoutDestination(uEv(hostA));
    assert(dUser.destinationType === "user" && dUser.accountId === acctA && dUser.localReady === true, "destination: user", dUser);

    console.log("connect-return and connect-refresh for hosts");
    const hostR = await mkUser("r");
    const hostW = await mkUser("w");
    const hostI = await mkUser("i");
    const acctR = `acct_ret_${P}`, acctW = `acct_retw_${P}`, acctI = `acct_reti_${P}`;
    for (const [u, a] of [[hostR, acctR], [hostW, acctW], [hostI, acctI]] as const) await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id) VALUES ($1, $2)`, [u, a]);
    const flag = async (a: string) => (await q(`SELECT onboarding_complete FROM user_payout_accounts WHERE stripe_account_id = $1`, [a]))[0]?.onboarding_complete;
    setReady(acctR);
    let g = await getNoFollow(`/api/stripe/connect-return?account=${acctR}&type=host`);
    assert(g.status === 302 && g.location === "outsyde://stripe-return?status=complete&type=host", "return host: 302 to the deep link", g);
    assert((await flag(acctR)) === true, "return host marks complete when charges and details are in");
    g = await getNoFollow(`/api/stripe/connect-return?account=${acctI}&type=host`);
    assert(g.status === 302 && g.location === "outsyde://stripe-return?status=complete&type=host" && (await flag(acctI)) === false, "return host incomplete leaves false", g);
    setReady(acctR, false);
    g = await getNoFollow(`/api/stripe/connect-return?account=${acctR}&type=host`);
    assert((await flag(acctR)) === true, "return host never writes false");
    setReady(acctW);
    g = await getNoFollow(`/api/stripe/connect-return?account=${acctW}&type=host-web`);
    assert(g.status === 302 && g.location === "https://goutsyde.test/events/payouts?stripe=done", "return host-web redirects to /events/payouts?stripe=done", g);
    assert((await flag(acctW)) === true, "return host-web marks complete");
    failRetrieveFor.add(acctI);
    g = await getNoFollow(`/api/stripe/connect-return?account=${acctI}&type=host`);
    assert(g.status === 302 && g.location === "outsyde://stripe-return?status=complete&type=host" && (await flag(acctI)) === false, "return host with a failed Stripe retrieve still redirects", g);
    failRetrieveFor.delete(acctI);
    g = await getNoFollow(`/api/stripe/connect-refresh?account=${acctR}&type=host`);
    assert(g.status === 302 && g.location === "outsyde://stripe-return?status=refresh&type=host", "refresh host deep link", g);
    g = await getNoFollow(`/api/stripe/connect-refresh?account=${acctR}&type=host-web`);
    assert(g.status === 302 && g.location === "https://goutsyde.test/events/payouts?stripe=refresh", "refresh host-web", g);

    console.log("vendor return unchanged");
    const hostV = await mkUser("v");
    const acctV = `acct_vend_${P}`;
    await q(`INSERT INTO businesses (owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 'beauty', 'pending', $3, false)`, [hostV, `${P} Vendor`, acctV]);
    setReady(acctV);
    g = await getNoFollow(`/api/stripe/connect-return?account=${acctV}&type=vendor`);
    assert(g.status === 302 && g.location === "outsyde://stripe-return?status=complete&type=vendor", "vendor return still redirects to its deep link", g);
    assert((await q(`SELECT stripe_onboarding_complete AS c FROM businesses WHERE stripe_account_id = $1`, [acctV]))[0].c === true, "vendor return still marks the business complete");

    console.log("account.updated for hosts (in process)");
    const { handleHostAccountUpdated } = await import("./hostPayouts");
    const { WebhookHandlers } = await import("../stripe/webhookHandlers");
    const hostX = await mkUser("x");
    const acctX = `acct_wh_${P}`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id) VALUES ($1, $2)`, [hostX, acctX]);
    const row = async () => (await q(`SELECT onboarding_complete AS c, extract(epoch from last_event_at)::bigint AS t FROM user_payout_accounts WHERE stripe_account_id = $1`, [acctX]))[0];
    const T = 1_900_000_000;
    await handleHostAccountUpdated({ id: acctX, charges_enabled: true, details_submitted: true }, T);
    let w = await row();
    assert(w.c === true && Number(w.t) === T, "webhook host true sets complete and last_event_at", w);
    await handleHostAccountUpdated({ id: acctX, charges_enabled: false, details_submitted: true }, T + 10);
    w = await row();
    assert(w.c === true && Number(w.t) === T + 10, "webhook host true then later false keeps true, writes last_event_at", w);
    await handleHostAccountUpdated({ id: acctX, charges_enabled: true, details_submitted: true }, T + 5);
    w = await row();
    assert(Number(w.t) === T + 10, "webhook older event ignored (last_event_at unchanged)", w);
    // Final review fix: Stripe often sends several account.updated in one second; a complete one after an incomplete one counts.
    const hostSame = await mkUser("ws");
    const acctSame = `acct_wh_same_${P}`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id) VALUES ($1, $2)`, [hostSame, acctSame]);
    await handleHostAccountUpdated({ id: acctSame, charges_enabled: false, details_submitted: true }, T);
    await handleHostAccountUpdated({ id: acctSame, charges_enabled: true, details_submitted: true }, T);
    const wSame = (await q(`SELECT onboarding_complete AS c, extract(epoch from last_event_at)::bigint AS t FROM user_payout_accounts WHERE stripe_account_id = $1`, [acctSame]))[0];
    assert(wSame.c === true && Number(wSame.t) === T, "two events in the same second, the second complete: flag true", wSame);
    const hostY = await mkUser("y");
    const acctY = `acct_wh2_${P}`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, last_event_at) VALUES ($1, $2, to_timestamp($3))`, [hostY, acctY, T]);
    await handleHostAccountUpdated({ id: acctY, charges_enabled: true, details_submitted: true }, T - 100);
    assert((await q(`SELECT onboarding_complete AS c FROM user_payout_accounts WHERE stripe_account_id = $1`, [acctY]))[0].c === false, "older event does not complete the account");
    await handleHostAccountUpdated({ id: `acct_unknown_${P}`, charges_enabled: true, details_submitted: true }, T);
    assert(true, "unknown account id is a no-op, no throw");
    await WebhookHandlers.handleConnectAccountUpdated({ id: acctY, metadata: { role: "host", userId: hostY }, charges_enabled: true, details_submitted: true }, T + 1);
    assert((await q(`SELECT onboarding_complete AS c FROM user_payout_accounts WHERE stripe_account_id = $1`, [acctY]))[0].c === true, "handleConnectAccountUpdated routes role=host to the host handler");
    const hostZ = await mkUser("z");
    const acctZ = `acct_wh3_${P}`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id) VALUES ($1, $2)`, [hostZ, acctZ]);
    await WebhookHandlers.handleConnectAccountUpdated({ id: acctZ, metadata: {}, charges_enabled: true, details_submitted: true }, T);
    assert((await q(`SELECT onboarding_complete AS c FROM user_payout_accounts WHERE stripe_account_id = $1`, [acctZ]))[0].c === true, "no metadata: falls back to user_payout_accounts lookup by account id");

    console.log("paid publish and end time rules (task 5)");
    const PAID = { base: BASE_PAID };
    const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86400000 + h * 3600000).toISOString();
    const evBody = () => ({ title: "Payout rules", startsAt: inDays(10), endsAt: inDays(10, 5), timezone: "America/New_York", capacity: 100 });
    const hostReadyU = await mkUser("pr");
    const hostNotReadyU = await mkUser("pn");
    const acctPR = `acct_pr_${P}`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [hostReadyU, acctPR]);
    setReady(acctPR);
    const mkEvent = async (host: string, o: { base?: string } = {}) => {
      const c = await call("POST", "/api/events", { token: tok(host), body: evBody(), ...o });
      if (c.status !== 201 && c.status !== 200) throw new Error("event create failed " + JSON.stringify(c));
      return c.body.event.id as string;
    };
    const addType = (ev: string, host: string, priceCents: number, o: { base?: string } = {}) =>
      call("POST", `/api/events/${ev}/ticket-types`, { token: tok(host), body: { name: priceCents ? "Paid" : "Free", priceCents, quantity: 50 }, ...o });
    const publish = (ev: string, host: string, o: { base?: string } = {}) => call("POST", `/api/events/${ev}/publish`, { token: tok(host), ...o });

    // switch off (5071): unchanged behaviour, even for a ready host
    let ev = await mkEvent(hostReadyU);
    await addType(ev, hostReadyU, 2000);
    r = await publish(ev, hostReadyU);
    assert(r.status === 409 && r.body.error.code === "PAID_TICKETS_NOT_AVAILABLE", "switch off: publish paid, ready host -> PAID_TICKETS_NOT_AVAILABLE", r);

    // switch on (5072)
    ev = await mkEvent(hostNotReadyU);
    await addType(ev, hostNotReadyU, 2000);
    r = await publish(ev, hostNotReadyU, PAID);
    assert(r.status === 409 && r.body.error.code === "PAYOUTS_NOT_SET_UP" && r.body.error.message === "Set up payouts before selling paid tickets.", "switch on: publish paid, host not set up -> PAYOUTS_NOT_SET_UP", r);
    assert((await q(`SELECT status FROM events WHERE id = $1`, [ev]))[0].status === "draft", "event stays a draft");
    ev = await mkEvent(hostNotReadyU);
    await addType(ev, hostNotReadyU, 0);
    r = await publish(ev, hostNotReadyU, PAID);
    assert(r.status === 200 && r.body.event.status === "published", "switch on: publish free-only, host not set up -> 200", r);
    const evFreePub = ev;

    ev = await mkEvent(hostReadyU);
    await addType(ev, hostReadyU, 2000);
    r = await publish(ev, hostReadyU, PAID);
    assert(r.status === 200 && r.body.event.status === "published", "switch on: publish paid, host ready -> 200", r);
    const evPaidPub = ev;

    // paid type on a published event
    r = await addType(evFreePub, hostNotReadyU, 1500);
    assert(r.status === 409 && r.body.error.code === "PAID_TICKETS_NOT_AVAILABLE", "switch off: add paid type to published event -> PAID_TICKETS_NOT_AVAILABLE", r);
    r = await addType(evFreePub, hostNotReadyU, 1500, PAID);
    assert(r.status === 409 && r.body.error.code === "PAYOUTS_NOT_SET_UP", "switch on: add paid type to published event, not ready -> PAYOUTS_NOT_SET_UP", r);
    r = await addType(evPaidPub, hostReadyU, 1500, PAID);
    assert(r.status === 201 && r.body.ticketType.priceCents === 1500, "switch on: add paid type to published event, ready -> 201", r);
    const paidTypeId = r.body.ticketType.id as string;
    const patchT = (evId: string, tid: string, host: string, body: unknown, o: { base?: string } = {}) =>
      call("PATCH", `/api/events/${evId}/ticket-types/${tid}`, { token: tok(host), body, ...o });
    r = await patchT(evPaidPub, paidTypeId, hostReadyU, { quantity: 60 }, PAID);
    assert(r.status === 200 && r.body.ticketType.quantity === 60, "switch on: edit quantity of existing paid type on published event -> 200", r);
    r = await patchT(evPaidPub, paidTypeId, hostReadyU, { name: "Paid renamed", priceCents: 1500 }, PAID);
    assert(r.status === 200 && r.body.ticketType.name === "Paid renamed", "switch on: edit name with the same price -> 200", r);
    r = await patchT(evPaidPub, paidTypeId, hostReadyU, { hidden: true });
    assert(r.status === 200 && r.body.ticketType.hidden === true, "switch off: edit existing paid type on published event -> 200", r);
    const sqlType = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'SQL paid', 2500, 10, 1, 5) RETURNING id`, [evPaidPub]))[0].id as string;
    r = await patchT(evPaidPub, sqlType, hostReadyU, { quantity: 20 });
    assert(r.status === 200 && r.body.ticketType.quantity === 20, "switch off: quantity edit of a paid type created by SQL -> 200", r);
    r = await addType(evPaidPub, hostReadyU, 1500);
    assert(r.status === 409 && r.body.error.code === "PAID_TICKETS_NOT_AVAILABLE", "switch off: ready host adding paid type to published event -> PAID_TICKETS_NOT_AVAILABLE", r);
    r = await addType(evFreePub, hostNotReadyU, 0, PAID);
    assert(r.status === 201, "switch on: add free type to published event, not ready -> 201", r);

    // repricing on a published event
    const freeTypeId = r.body.ticketType.id as string;
    r = await call("PATCH", `/api/events/${evFreePub}/ticket-types/${freeTypeId}`, { token: tok(hostNotReadyU), body: { priceCents: 900 }, ...PAID });
    assert(r.status === 409 && r.body.error.code === "PAYOUTS_NOT_SET_UP", "switch on: reprice free->paid on published, not ready -> PAYOUTS_NOT_SET_UP", r);
    const readyFree = await addType(evPaidPub, hostReadyU, 0, PAID);
    r = await call("PATCH", `/api/events/${evPaidPub}/ticket-types/${readyFree.body.ticketType.id}`, { token: tok(hostReadyU), body: { priceCents: 900 }, ...PAID });
    assert(r.status === 200 && r.body.ticketType.priceCents === 900, "switch on: reprice free->paid on published, ready -> 200", r);
    r = await call("PATCH", `/api/events/${evPaidPub}/ticket-types/${readyFree.body.ticketType.id}`, { token: tok(hostReadyU), body: { priceCents: 800 } });
    assert(r.status === 409 && r.body.error.code === "PAID_TICKETS_NOT_AVAILABLE", "switch off: reprice on published -> PAID_TICKETS_NOT_AVAILABLE", r);

    // draft events keep allowing paid types on both servers
    ev = await mkEvent(hostNotReadyU);
    r = await addType(ev, hostNotReadyU, 700, PAID);
    assert(r.status === 201, "draft: paid type allowed (switch on, not ready)", r);
    r = await addType(ev, hostNotReadyU, 700);
    assert(r.status === 201, "draft: paid type allowed (switch off)", r);

    // local flag true but Stripe says no: same code
    const hostLost = await mkUser("pl");
    const acctPL = `acct_pl_${P}`;
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [hostLost, acctPL]);
    ev = await mkEvent(hostLost);
    await addType(ev, hostLost, 2000);
    r = await publish(ev, hostLost, PAID);
    assert(r.status === 409 && r.body.error.code === "PAYOUTS_NOT_SET_UP", "local flag true but Stripe not ready: PAYOUTS_NOT_SET_UP", r);

    // end time can only move later once the event has started
    const hostT = await mkUser("pt");
    ev = await mkEvent(hostT);
    await addType(ev, hostT, 0);
    await publish(ev, hostT);
    const origEnd = new Date(Date.now() + 2 * 3600000).toISOString();
    await q(`UPDATE events SET starts_at = now() - interval '1 hour', ends_at = $2 WHERE id = $1`, [ev, origEnd]);
    const MSG = "Once the event has started, the end time can only move later.";
    r = await call("PATCH", `/api/events/${ev}`, { token: tok(hostT), body: { endsAt: new Date(Date.now() + 3600000).toISOString() } });
    assert(r.status === 400 && r.body.error.code === "INVALID_EVENT_TIMES" && r.body.error.message === MSG, "started event: earlier end refused", r);
    assert(new Date((await q(`SELECT ends_at FROM events WHERE id = $1`, [ev]))[0].ends_at).toISOString() === origEnd, "end time unchanged after refusal");
    const laterEnd = new Date(Date.now() + 5 * 3600000).toISOString();
    r = await call("PATCH", `/api/events/${ev}`, { token: tok(hostT), body: { endsAt: laterEnd } });
    assert(r.status === 200 && new Date(r.body.event.endsAt).toISOString() === laterEnd, "started event: later end ok", r);
    r = await call("PATCH", `/api/events/${ev}`, { token: tok(hostT), body: { title: "Renamed while live" } });
    assert(r.status === 200, "started event: other edits unchanged", r);
    // Final review fix: the two-step bypass (move the start into the future, then pull the end in) is refused.
    const START_MSG = "Once the event has started, its start time can't change.";
    // Millisecond start, as a client writes it (the SQL setup above used now(), which has microseconds).
    await q(`UPDATE events SET starts_at = date_trunc('milliseconds', starts_at) WHERE id = $1`, [ev]);
    const savedStart = new Date((await q(`SELECT starts_at FROM events WHERE id = $1`, [ev]))[0].starts_at).toISOString();
    r = await call("PATCH", `/api/events/${ev}`, { token: tok(hostT), body: { startsAt: new Date(Date.now() + 5 * 60000).toISOString() } });
    assert(r.status === 400 && r.body.error.code === "INVALID_EVENT_TIMES" && r.body.error.message === START_MSG, "started event: start moved into the future refused", r);
    assert(new Date((await q(`SELECT starts_at FROM events WHERE id = $1`, [ev]))[0].starts_at).toISOString() === savedStart, "start time unchanged after refusal");
    r = await call("PATCH", `/api/events/${ev}`, { token: tok(hostT), body: { endsAt: new Date(Date.now() + 3600000).toISOString() } });
    assert(r.status === 400 && r.body.error.message === MSG, "second step (earlier end) still refused: the event is still started", r);
    assert(new Date((await q(`SELECT ends_at FROM events WHERE id = $1`, [ev]))[0].ends_at).toISOString() === laterEnd, "end time unchanged after the two-step try");
    r = await call("PATCH", `/api/events/${ev}`, { token: tok(hostT), body: { startsAt: savedStart, title: "Same start sent back" } });
    assert(r.status === 200 && r.body.event.title === "Same start sent back", "started event: the saved start sent back unchanged is fine", r);
    ev = await mkEvent(hostT);
    r = await call("PATCH", `/api/events/${ev}`, { token: tok(hostT), body: { endsAt: inDays(10, 2) } });
    assert(r.status === 200, "event not started: earlier end ok", r);

    // ── Task 6: the payout job (in process, with a fake Stripe that shares the HTTP stub's state) ──
    console.log("payout job (task 6)");
    const pushes: any[] = [];
    const { setNoticeDepsForTest } = await import("./ticketNotices");
    setNoticeDepsForTest({
      sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
      sendPush: async (p) => { pushes.push(p); return true; },
    });
    const adminEmails: Array<{ subject: string; detail: string }> = [];
    const { setAdminAlertForTest } = await import("./ticketCheckout");
    setAdminAlertForTest(async (subject, detail) => { adminEmails.push({ subject, detail }); });
    const { createDuePayouts, sendPayout, runEventPayoutJob } = await import("./eventPayouts");

    const fakeLog: Array<{ fn: string; id: string }> = []; // readiness: account id; find/create: event id
    let holdGate: Promise<void> | null = null;
    let createStarted: (() => void) | null = null;
    let readinessGate: Promise<void> | null = null;
    let readinessStarted: (() => void) | null = null;
    let revLookupGate: Promise<void> | null = null;
    let revLookupStarted: (() => void) | null = null;
    let revHoldGate: Promise<void> | null = null;
    let revCreateStarted: (() => void) | null = null;
    const revBounds: Array<{ timeoutMs?: number; maxNetworkRetries?: number }> = [];
    const payoutFake = {
      getPayoutReadiness: async (id: string, _o?: { timeoutMs?: number; maxNetworkRetries?: number }) => {
        fakeLog.push({ fn: "readiness", id });
        // Held open: a slow Stripe answer before the create (one call only).
        if (readinessGate) { const g = readinessGate; readinessGate = null; readinessStarted?.(); await g; }
        const s = stateOf(id);
        return { ready: s.charges_enabled && s.payouts_enabled, chargesEnabled: s.charges_enabled, payoutsEnabled: s.payouts_enabled, detailsSubmitted: s.details_submitted };
      },
      findEventPayoutTransfer: async (eventId: string, payoutId: string) => {
        fakeLog.push({ fn: "find", id: eventId });
        const t = transfers.find((x) => x.transfer_group === `event_${eventId}` && x.metadata.payoutId === payoutId);
        return t ? { id: t.id as string, amount: t.amount as number } : null;
      },
      createEventPayoutTransfer: async (p: { eventId: string; payoutId: string; destination: string; amountCents: number; idempotencyKey?: string }) => {
        fakeLog.push({ fn: "create", id: p.eventId });
        // Held open: the request is in flight and Stripe hasn't processed it yet (one call only).
        if (holdGate) { const g = holdGate; holdGate = null; createStarted?.(); await g; }
        const res = doTransfer({
          amount: String(p.amountCents), currency: "usd", destination: p.destination, transfer_group: `event_${p.eventId}`,
          "metadata[type]": "event_payout", "metadata[eventId]": p.eventId, "metadata[payoutId]": p.payoutId,
        }, p.idempotencyKey ?? `event_payout_${p.payoutId}`); // same default as stripeService
        if (res.code !== 200) throw Object.assign(new Error(res.body.error.message), { code: res.body.error.code, type: res.body.error.type });
        return { id: res.body.id as string };
      },
      // Task 7: reversals, sharing the HTTP stub's state. Gates hold one call open (a slow Stripe).
      findEventPayoutReversal: async (transferId: string, ticketId: string, _o?: { timeoutMs?: number; maxNetworkRetries?: number }) => {
        fakeLog.push({ fn: "findReversal", id: ticketId });
        if (rsw.failLookup > 0) { rsw.failLookup--; throw Object.assign(new Error("stub reversal list failure"), { type: "api_error" }); }
        if (revLookupGate) { const g = revLookupGate; revLookupGate = null; revLookupStarted?.(); await g; }
        const rv = reversals.find((x) => x.transfer === transferId && x.metadata?.ticketId === ticketId);
        return rv ? { id: rv.id as string, amount: rv.amount as number } : null;
      },
      reverseEventPayoutTransfer: async (p: { transferId: string; ticketId: string; amountCents: number; idempotencyKey?: string; timeoutMs?: number; maxNetworkRetries?: number }) => {
        fakeLog.push({ fn: "reverse", id: p.ticketId });
        revBounds.push({ timeoutMs: p.timeoutMs, maxNetworkRetries: p.maxNetworkRetries });
        if (revHoldGate) { const g = revHoldGate; revHoldGate = null; revCreateStarted?.(); await g; }
        const res = doReversal(p.transferId, { amount: String(p.amountCents), "metadata[type]": "event_payout_recovery", "metadata[ticketId]": p.ticketId },
          p.idempotencyKey ?? `event_recovery_${p.ticketId}`); // same default as stripeService
        if (res.code !== 200) throw Object.assign(new Error(res.body.error.message), { code: res.body.error.code, type: res.body.error.type });
        return { id: res.body.id as string };
      },
    };

    const mkReadyHost = async (s: string) => {
      const u = await mkUser(s);
      const a = `acct_job_${s}_${P}`;
      await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [u, a]);
      setReady(a);
      return { u, a };
    };
    const buyers: string[] = [];
    for (let i = 0; i < 8; i++) buyers.push(await mkUser(`jb${i}`));
    const jobEvent = async (host: string, title: string, priceCents = 2000) => {
      const c = await call("POST", "/api/events", { token: tok(host), body: { title, startsAt: inDays(5), endsAt: inDays(5, 4), timezone: "America/New_York", capacity: 100 } });
      if (c.status !== 201 && c.status !== 200) throw new Error("event create failed " + JSON.stringify(c));
      const id = c.body.event.id as string;
      const t = await call("POST", `/api/events/${id}/ticket-types`, { token: tok(host), body: { name: priceCents ? "GA" : "Free", priceCents, quantity: 50, maxPerOrder: priceCents ? 4 : 1, perAccountLimit: priceCents ? 4 : 1 } });
      if (t.status !== 201) throw new Error("type create failed " + JSON.stringify(t));
      await q(`UPDATE events SET status = 'published', published_at = now() WHERE id = $1`, [id]);
      return { id, typeId: t.body.ticketType.id as string };
    };
    const checkout = async (eventId: string, user: string, typeId: string, quantity = 1) => {
      const c = await call("POST", `/api/events/${eventId}/checkout`, { token: tok(user), body: { ticketTypeId: typeId, quantity } });
      if (c.status !== 201) throw new Error(`checkout failed ${JSON.stringify(c)}`);
      return c.body as { orderId: string; paymentIntentId: string };
    };
    /** Checkout + pay through the real webhook handler (in this process). */
    const buy = async (eventId: string, user: string, typeId: string, quantity = 1) => {
      const c = await checkout(eventId, user, typeId, quantity);
      const pi = piStore[c.paymentIntentId];
      pi.status = "succeeded"; pi.amount_received = pi.amount;
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
      const [o] = await q(`SELECT status FROM ticket_orders WHERE id = $1`, [c.orderId]);
      if (o?.status !== "completed") throw new Error("order not completed " + JSON.stringify(o));
      return c.orderId;
    };
    const endedHoursAgo = (id: string, h: number) =>
      q(`UPDATE events SET starts_at = now() - make_interval(hours => $2::int + 5), ends_at = now() - make_interval(hours => $2::int) WHERE id = $1`, [id, h]);
    const payoutOf = async (eventId: string) => q(`SELECT *, extract(epoch from (next_attempt_at - now()))::int AS due_in FROM event_payouts WHERE event_id = $1`, [eventId]);
    const tix = async (eventId: string) => q(`SELECT id, order_id, status, payout_id, host_net_cents FROM tickets WHERE event_id = $1 ORDER BY created_at, item_index`, [eventId]);
    const advance = (payoutId: string) => q(`UPDATE event_payouts SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [payoutId]);

    console.log("due rule and the created payout");
    const h1 = await mkReadyHost("j1");
    const e1 = await jobEvent(h1.u, "Payout Night");
    await buy(e1.id, buyers[0], e1.typeId, 2);
    await endedHoursAgo(e1.id, 71);
    await createDuePayouts();
    assert((await payoutOf(e1.id)).length === 0, "not due before ends_at + 3 days");
    await endedHoursAgo(e1.id, 73);
    let made = await createDuePayouts();
    let pr = await payoutOf(e1.id);
    assert(pr.length === 1 && pr[0].gross_cents === 3920 && pr[0].amount_cents === 3920 && pr[0].deducted_cents === 0 && pr[0].status === "pending" && pr[0].attempts === 0,
      "due creates one payout = sum of valid host_net (2 x 1960 = 3920)", pr);
    assert(pr[0]?.destination_type === "user" && pr[0]?.connected_account_id === h1.a, "payout records the host's destination", pr[0]);
    assert(typeof made === "string" && made.split(",").includes(pr[0]?.id), "createDuePayouts returns the new id in a comma list", made);
    let tk = await tix(e1.id);
    assert(tk.length === 2 && tk.every((t) => t.payout_id === pr[0].id), "both tickets stamped with the payout", tk);
    made = await createDuePayouts();
    assert((await payoutOf(e1.id)).length === 1 && !made.split(",").includes(pr[0].id), "second run creates nothing more", made);

    console.log("refunded and cancelled tickets excluded");
    const h3 = await mkReadyHost("j3");
    const e3 = await jobEvent(h3.u, "Mixed Night");
    const o3a = await buy(e3.id, buyers[1], e3.typeId, 2);
    const o3b = await buy(e3.id, buyers[2], e3.typeId, 1);
    const o3c = await buy(e3.id, buyers[3], e3.typeId, 1);
    r = await call("POST", `/api/events/${e3.id}/orders/${o3b}/refund`, { token: tok(h3.u) });
    assert(r.status === 200 && r.body.order.status === "refunded", "host refund of one order done", r);
    await q(`UPDATE tickets SET status = 'cancelled', cancelled_at = now() WHERE id = (SELECT id FROM tickets WHERE order_id = $1 ORDER BY item_index LIMIT 1)`, [o3a]);
    await endedHoursAgo(e3.id, 80);
    await createDuePayouts();
    pr = await payoutOf(e3.id);
    tk = await tix(e3.id);
    assert(pr.length === 1 && pr[0].gross_cents === 3920, "gross counts only the 2 valid tickets", { pr, tk });
    assert(tk.filter((t) => t.payout_id === pr[0]?.id).length === 2 && tk.filter((t) => t.status !== "valid").every((t) => t.payout_id === null)
      && tk.filter((t) => t.order_id === o3c).every((t) => t.payout_id === pr[0]?.id), "refunded and cancelled tickets not stamped", tk);

    console.log("open orders block, flagged ones don't");
    const h4 = await mkReadyHost("j4");
    const e4 = await jobEvent(h4.u, "Blocked Night");
    const o4a = await buy(e4.id, buyers[0], e4.typeId, 1);
    const o4b = await buy(e4.id, buyers[1], e4.typeId, 1);
    const pend4 = await checkout(e4.id, buyers[2], e4.typeId, 1);
    await q(`UPDATE ticket_orders SET status = 'refunding', refund_reason = 'host', refund_amount_cents = 2000, refund_requested_at = now(),
               refund_next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [o4b]);
    await endedHoursAgo(e4.id, 80);
    await createDuePayouts();
    assert((await payoutOf(e4.id)).length === 0, "pending order blocks");
    await q(`UPDATE ticket_orders SET needs_review_at = now(), review_reason = 'test' WHERE id = $1`, [pend4.orderId]);
    await createDuePayouts();
    assert((await payoutOf(e4.id)).length === 0, "refunding order blocks (pending one flagged)");
    await q(`UPDATE ticket_orders SET needs_review_at = now(), review_reason = 'test' WHERE id = $1`, [o4b]);
    await createDuePayouts();
    pr = await payoutOf(e4.id);
    tk = await tix(e4.id);
    assert(pr.length === 1 && pr[0].gross_cents === 1960 && tk.filter((t) => t.order_id === o4a).every((t) => t.payout_id === pr[0].id)
      && tk.filter((t) => t.order_id !== o4a).every((t) => t.payout_id === null), "flagged order doesn't block and isn't paid", { pr, tk });

    console.log("free and cancelled events");
    const h5 = await mkReadyHost("j5");
    const e5 = await jobEvent(h5.u, "Free Night", 0);
    r = await call("POST", `/api/events/${e5.id}/rsvp`, { token: tok(buyers[0]), body: { ticketTypeId: e5.typeId } });
    assert(r.status === 200 || r.status === 201, "free RSVP made", r);
    await endedHoursAgo(e5.id, 80);
    await runEventPayoutJob(payoutFake);
    assert((await payoutOf(e5.id)).length === 0 && (await tix(e5.id)).every((t) => t.payout_id === null), "free event: no payout row, nothing stamped");
    assert(!fakeLog.some((l) => l.id === e5.id || l.id === h5.a), "free event: no Stripe call", fakeLog);
    const h6 = await mkReadyHost("j6");
    const e6 = await jobEvent(h6.u, "Called Off");
    await buy(e6.id, buyers[1], e6.typeId, 1);
    await endedHoursAgo(e6.id, 80);
    await q(`UPDATE events SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [e6.id]);
    await createDuePayouts();
    assert((await payoutOf(e6.id)).length === 0, "cancelled event: no payout");

    console.log("paused events");
    const e6b = await jobEvent(h6.u, "Paused Night");
    await buy(e6b.id, buyers[2], e6b.typeId, 1);
    await endedHoursAgo(e6b.id, 80);
    await q(`UPDATE events SET status = 'paused' WHERE id = $1`, [e6b.id]);
    await createDuePayouts();
    assert((await payoutOf(e6b.id)).length === 0, "paused event: not due");
    await q(`UPDATE events SET status = 'published' WHERE id = $1`, [e6b.id]);
    await createDuePayouts();
    pr = await payoutOf(e6b.id);
    await q(`UPDATE events SET status = 'paused' WHERE id = $1`, [e6b.id]);
    let sres = await sendPayout(pr[0].id, payoutFake);
    pr = await payoutOf(e6b.id);
    assert(sres === "held" && pr[0].status === "held" && pr[0].hold_reason === "event_paused" && pr[0].due_in > 3500 && pr[0].due_in <= 3600,
      "payout of an event paused after creation is held (event_paused), rechecked in an hour", { sres, pr });
    assert(!transferPosts.some((t) => t.payoutId === pr[0].id), "held: no transfer sent");
    await q(`UPDATE events SET status = 'published' WHERE id = $1`, [e6b.id]);
    await advance(pr[0].id);
    sres = await sendPayout(pr[0].id, payoutFake);
    pr = await payoutOf(e6b.id);
    assert(sres === "paid" && pr[0].status === "paid" && pr[0].hold_reason === null, "unpaused: paid on the next try", { sres, pr });

    console.log("two runs send one transfer, host gets a push");
    const h7 = await mkReadyHost("j7");
    const e7 = await jobEvent(h7.u, "Double Run Night");
    await buy(e7.id, buyers[3], e7.typeId, 2);
    await endedHoursAgo(e7.id, 80);
    const [ra, rb] = await Promise.all([runEventPayoutJob(payoutFake), runEventPayoutJob(payoutFake)]);
    pr = await payoutOf(e7.id);
    const g7 = transfers.filter((t) => t.transfer_group === `event_${e7.id}`);
    assert(pr.length === 1 && pr[0].status === "paid" && pr[0].transfer_id === g7[0]?.id && pr[0].paid_at && pr[0].attempts === 1, "payout paid once", { pr, ra, rb });
    assert(g7.length === 1 && transferPosts.filter((t) => t.payoutId === pr[0]?.id).length === 1, "stub saw exactly 1 transfer POST", { g7, posts: transferPosts.filter((t) => t.payoutId === pr[0]?.id) });
    assert(g7[0]?.amount === 3920 && g7[0]?.destination === h7.a && g7[0]?.metadata.type === "event_payout" && g7[0]?.metadata.eventId === e7.id
      && new RegExp(`^event_payout_${pr[0]?.id}_\\d+$`).test(transferPosts.find((t) => t.payoutId === pr[0]?.id)?.key ?? ""), "transfer amount, destination, metadata and key event_payout_<id>_<n>", { g7: g7[0], posts: transferPosts.filter((t) => t.payoutId === pr[0]?.id) });
    assert(ra.created + rb.created === 1 && ra.paid + rb.paid >= 1, "job counts: one created", { ra, rb });
    await waitFor(() => pushes.some((p) => p.data?.payoutId === pr[0]?.id));
    const myPush = pushes.filter((p) => p.data?.payoutId === pr[0]?.id);
    assert(myPush.length === 1 && myPush[0].userId === h7.u && myPush[0].title === "Payout sent"
      && myPush[0].body === "Your payout for Double Run Night is on its way to your bank." && myPush[0].data.type === "event_payout_sent", "host push on paid", myPush);

    console.log("sent but unsaved transfer is recorded");
    const h8 = await mkReadyHost("j8");
    const e8 = await jobEvent(h8.u, "Lost Reply Night");
    await buy(e8.id, buyers[4], e8.typeId, 1);
    await endedHoursAgo(e8.id, 80);
    await createDuePayouts();
    pr = await payoutOf(e8.id);
    const pre = { id: `tr_presaved_${P}`, object: "transfer", amount: 1960, currency: "usd", destination: h8.a, transfer_group: `event_${e8.id}`, metadata: { type: "event_payout", eventId: e8.id, payoutId: pr[0].id }, reversed: false, amount_reversed: 0 };
    transfers.push(pre);
    const postsBefore = transferPosts.length;
    sres = await sendPayout(pr[0].id, payoutFake);
    pr = await payoutOf(e8.id);
    assert(sres === "paid" && pr[0].status === "paid" && pr[0].transfer_id === pre.id && transferPosts.length === postsBefore, "existing transfer recorded, no new POST", { sres, pr });

    console.log("held then resumes");
    const h9 = await mkReadyHost("j9");
    setReady(h9.a, false);
    const e9 = await jobEvent(h9.u, "Not Ready Night");
    await buy(e9.id, buyers[5], e9.typeId, 1);
    await endedHoursAgo(e9.id, 80);
    await createDuePayouts();
    pr = await payoutOf(e9.id);
    const id9 = pr[0].id as string;
    let emailsBefore = adminEmails.length;
    sres = await sendPayout(id9, payoutFake);
    pr = await payoutOf(e9.id);
    assert(sres === "held" && pr[0].status === "held" && pr[0].hold_reason === "stripe_not_ready" && pr[0].attempts === 0 && pr[0].due_in > 3500 && pr[0].due_in <= 3600 && pr[0].alerted_at,
      "host not ready: held, reason saved, attempts not counted, rechecked in an hour", { sres, pr });
    assert(adminEmails.length === emailsBefore + 1 && adminEmails[adminEmails.length - 1].detail.includes(id9), "one admin email for the hold", adminEmails.slice(emailsBefore));
    sres = await sendPayout(id9, payoutFake);
    assert(sres === "not_due", "held payout not retried before its time", sres);
    await advance(id9);
    sres = await sendPayout(id9, payoutFake);
    assert(sres === "held" && adminEmails.length === emailsBefore + 1, "still not ready an hour later: held, no second email", { sres, n: adminEmails.length - emailsBefore });
    setReady(h9.a, true);
    await advance(id9);
    sres = await sendPayout(id9, payoutFake);
    pr = await payoutOf(e9.id);
    assert(sres === "paid" && pr[0].status === "paid" && pr[0].hold_reason === null && transfers.some((t) => t.id === pr[0].transfer_id && t.amount === 1960), "ready again: paid", { sres, pr });

    console.log("insufficient platform balance");
    const h10 = await mkReadyHost("j10");
    const e10 = await jobEvent(h10.u, "Low Balance Night");
    await buy(e10.id, buyers[6], e10.typeId, 1);
    await endedHoursAgo(e10.id, 80);
    await createDuePayouts();
    pr = await payoutOf(e10.id);
    const id10 = pr[0].id as string;
    emailsBefore = adminEmails.length;
    sw.insufficient = true;
    sres = await sendPayout(id10, payoutFake);
    pr = await payoutOf(e10.id);
    assert(sres === "insufficient" && pr[0].status === "pending" && pr[0].attempts === 0 && pr[0].due_in > 3500 && pr[0].due_in <= 3600 && pr[0].last_error,
      "insufficient: stays pending, attempts unchanged, retried in an hour", { sres, pr });
    assert(adminEmails.length === emailsBefore + 1 && adminEmails[adminEmails.length - 1].detail.includes(id10), "insufficient: one admin email", adminEmails.slice(emailsBefore));
    await advance(id10);
    sres = await sendPayout(id10, payoutFake);
    pr = await payoutOf(e10.id);
    assert(sres === "insufficient" && pr[0].attempts === 0 && adminEmails.length === emailsBefore + 1, "insufficient again within 24h: no second email, attempts still 0", { sres, pr, n: adminEmails.length - emailsBefore });
    await q(`UPDATE event_payouts SET alerted_at = now() - interval '25 hours' WHERE id = $1`, [id10]);
    await advance(id10);
    sres = await sendPayout(id10, payoutFake);
    assert(sres === "insufficient" && adminEmails.length === emailsBefore + 2, "insufficient after 24h: emails again", { sres, n: adminEmails.length - emailsBefore });
    sw.insufficient = false;
    await advance(id10);
    sres = await sendPayout(id10, payoutFake);
    assert(sres === "paid" && (await payoutOf(e10.id))[0].status === "paid", "balance back: paid", sres);
    const posts10 = transferPosts.filter((t) => t.payoutId === id10);
    assert(posts10.length === 4 && new Set(posts10.map((t) => t.key)).size === 4 && posts10[3].ok && !posts10[3].replayed && posts10.slice(0, 3).every((t) => !t.ok),
      "each try used a new key, so the saved insufficient reply wasn't replayed after the balance came back", posts10);

    console.log("other errors back off, then review");
    const h11 = await mkReadyHost("j11");
    const e11 = await jobEvent(h11.u, "Broken Night");
    await buy(e11.id, buyers[7], e11.typeId, 1);
    await endedHoursAgo(e11.id, 80);
    await createDuePayouts();
    pr = await payoutOf(e11.id);
    const id11 = pr[0].id as string;
    emailsBefore = adminEmails.length;
    sw.failTransfer = true;
    const waits: number[] = [];
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await sendPayout(id11, payoutFake));
      const row = (await payoutOf(e11.id))[0];
      waits.push(row.due_in);
      await advance(id11);
    }
    pr = await payoutOf(e11.id);
    assert(results.slice(0, 4).every((x) => x === "retry") && results[4] === "review", "4 retries then review", results);
    assert(waits[0] > 590 && waits[0] <= 600 && waits[1] > 1190 && waits[1] <= 1200 && waits[2] > 2390 && waits[2] <= 2400 && waits[3] > 3590 && waits[3] <= 3600, "backoff 10, 20, 40, 60 minutes (never shorter than the 10 minute in-flight lock)", waits);
    assert(pr[0].status === "review" && pr[0].attempts === 5 && /stub transfer failure/.test(pr[0].last_error ?? ""), "row in review with the last error", pr);
    assert(adminEmails.length === emailsBefore + 1 && adminEmails[adminEmails.length - 1].detail.includes(id11), "one admin email for review", adminEmails.slice(emailsBefore));
    sres = await sendPayout(id11, payoutFake);
    await runEventPayoutJob(payoutFake);
    assert(sres === "not_due" && adminEmails.length === emailsBefore + 1 && transferPosts.filter((t) => t.payoutId === id11).length === 5, "review is left alone (no more tries or emails)", { sres, n: adminEmails.length - emailsBefore });
    sw.failTransfer = false;

    console.log("a transient 500 once, then OK");
    const h13 = await mkReadyHost("j13");
    const e13 = await jobEvent(h13.u, "Blip Night");
    await buy(e13.id, buyers[0], e13.typeId, 1);
    await endedHoursAgo(e13.id, 80);
    await createDuePayouts();
    const id13 = (await payoutOf(e13.id))[0].id as string;
    emailsBefore = adminEmails.length;
    sw.failOnce = 1;
    const r13a = await sendPayout(id13, payoutFake);
    const due13 = (await payoutOf(e13.id))[0].due_in;
    const r13early = await sendPayout(id13, payoutFake);
    assert(r13a === "retry" && due13 > 590 && due13 <= 600 && r13early === "not_due", "after an error the row is due again at the backoff time (10 minutes), not before", { r13a, due13, r13early });
    await advance(id13);
    const r13b = await sendPayout(id13, payoutFake);
    pr = await payoutOf(e13.id);
    const posts13 = transferPosts.filter((t) => t.payoutId === id13);
    assert(r13a === "retry" && r13b === "paid" && pr[0].status === "paid" && pr[0].attempts === 2 && adminEmails.length === emailsBefore,
      "500 once then OK: paid on the next try, no review, no email", { r13a, r13b, pr });
    assert(posts13.length === 2 && posts13[0].key !== posts13[1].key && !posts13[1].replayed && transfers.filter((t) => t.transfer_group === `event_${e13.id}`).length === 1,
      "second try used a new key (the saved 500 wasn't replayed), one transfer", posts13);

    console.log("transfer created but its response lost");
    const h14 = await mkReadyHost("j14");
    const e14 = await jobEvent(h14.u, "Lost Response Night");
    await buy(e14.id, buyers[1], e14.typeId, 1);
    await endedHoursAgo(e14.id, 80);
    await createDuePayouts();
    const id14 = (await payoutOf(e14.id))[0].id as string;
    sw.loseResponse = 1;
    const r14a = await sendPayout(id14, payoutFake);
    const g14 = transfers.filter((t) => t.transfer_group === `event_${e14.id}`);
    assert(r14a === "retry" && g14.length === 1 && (await payoutOf(e14.id))[0].status === "pending", "lost response: Stripe has the transfer, row still pending", { r14a, g14 });
    await advance(id14);
    const r14b = await sendPayout(id14, payoutFake);
    pr = await payoutOf(e14.id);
    assert(r14b === "paid" && pr[0].status === "paid" && pr[0].transfer_id === g14[0]?.id && transfers.filter((t) => t.transfer_group === `event_${e14.id}`).length === 1
      && transferPosts.filter((t) => t.payoutId === id14).length === 1, "next try finds it by group lookup and records it, no second POST or transfer", { r14b, pr });

    console.log("a transfer still in flight is never claimed again");
    const h15 = await mkReadyHost("j15");
    const e15 = await jobEvent(h15.u, "Slow Stripe Night");
    await buy(e15.id, buyers[2], e15.typeId, 1);
    await endedHoursAgo(e15.id, 80);
    await createDuePayouts();
    const id15 = (await payoutOf(e15.id))[0].id as string;
    let release!: () => void;
    holdGate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { createStarted = r; });
    const first = sendPayout(id15, payoutFake);
    await started;
    const lock15 = (await payoutOf(e15.id))[0].due_in;
    assert(lock15 > 590 && lock15 <= 600, "claim locks the row for 10 minutes while the transfer is in flight", lock15);
    // 61 seconds pass (longer than the old 1 minute lease), then another run tries.
    await q(`UPDATE event_payouts SET next_attempt_at = next_attempt_at - interval '61 seconds' WHERE id = $1`, [id15]);
    const second = await sendPayout(id15, payoutFake);
    const jobAgain = await runEventPayoutJob(payoutFake);
    assert(second === "not_due" && transferPosts.filter((t) => t.payoutId === id15).length === 0, "second claim while in flight: not due, nothing sent", { second, jobAgain });
    release();
    const firstRes = await first;
    pr = await payoutOf(e15.id);
    assert(firstRes === "paid" && pr[0].status === "paid" && pr[0].next_attempt_at === null
      && transfers.filter((t) => t.transfer_group === `event_${e15.id}`).length === 1 && transferPosts.filter((t) => t.payoutId === id15).length === 1,
      "exactly 1 transfer at the end", { firstRes, pr });

    console.log("a slow check before the create outlasts the lock: that run sends nothing");
    const h16 = await mkReadyHost("j16");
    const e16 = await jobEvent(h16.u, "Slow Check Night");
    await buy(e16.id, buyers[3], e16.typeId, 1);
    await endedHoursAgo(e16.id, 80);
    await createDuePayouts();
    const id16 = (await payoutOf(e16.id))[0].id as string;
    let rel16!: () => void;
    readinessGate = new Promise<void>((r) => { rel16 = r; });
    const check16 = new Promise<void>((r) => { readinessStarted = r; });
    const run1 = sendPayout(id16, payoutFake);
    await check16;
    // Run 1 is stuck on Stripe for more than 10 minutes: its lock runs out and run 2 claims the row.
    await q(`UPDATE event_payouts SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id16]);
    let rel16b!: () => void;
    holdGate = new Promise<void>((r) => { rel16b = r; });
    const create16 = new Promise<void>((r) => { createStarted = r; });
    const run2 = sendPayout(id16, payoutFake);
    await create16; // run 2's transfer is in flight, not yet on Stripe
    rel16();
    const r16a = await run1;
    rel16b();
    const r16b = await run2;
    pr = await payoutOf(e16.id);
    assert(r16a === "not_due" && r16b === "paid" && pr[0].status === "paid", "run 1 can't re-take the lock and sends nothing; run 2 pays", { r16a, r16b, pr });
    assert(transfers.filter((t) => t.transfer_group === `event_${e16.id}`).length === 1 && transferPosts.filter((t) => t.payoutId === id16).length === 1,
      "exactly 1 transfer overall", transferPosts.filter((t) => t.payoutId === id16));

    console.log("a run that lost the row writes nothing: stale review on a cancelled event");
    const { setPayoutHooksForTest } = await import("./eventPayouts");
    const h17 = await mkReadyHost("j17");
    const e17 = await jobEvent(h17.u, "Stale Review Night");
    await buy(e17.id, buyers[4], e17.typeId, 1);
    await endedHoursAgo(e17.id, 80);
    await createDuePayouts();
    const id17 = (await payoutOf(e17.id))[0].id as string;
    let rel17!: () => void;
    const gate17 = new Promise<void>((r) => { rel17 = r; });
    let claimed17!: () => void;
    const atClaim17 = new Promise<void>((r) => { claimed17 = r; });
    let once17 = true;
    setPayoutHooksForTest({ afterClaim: async (id) => { if (id === id17 && once17) { once17 = false; claimed17(); await gate17; } } });
    const stale17 = sendPayout(id17, payoutFake); // claims, then is stuck before reading the event
    await atClaim17;
    // More than 10 minutes pass: its lock runs out and run 2 claims and gets as far as its create.
    await q(`UPDATE event_payouts SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id17]);
    let rel17b!: () => void;
    holdGate = new Promise<void>((r) => { rel17b = r; });
    const create17 = new Promise<void>((r) => { createStarted = r; });
    const owner17 = sendPayout(id17, payoutFake);
    await create17;
    // The event is cancelled now, so the stale run sees it cancelled.
    await q(`UPDATE events SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [e17.id]);
    const emailsBefore17 = adminEmails.length;
    rel17();
    const r17a = await stale17;
    const mid17 = (await payoutOf(e17.id))[0];
    assert(r17a === "not_due" && mid17.status === "pending" && adminEmails.length === emailsBefore17,
      "stale run on a cancelled event: not due, row untouched, no email", { r17a, mid17, emails: adminEmails.slice(emailsBefore17) });
    rel17b();
    const r17b = await owner17;
    setPayoutHooksForTest(null);
    pr = await payoutOf(e17.id);
    const g17 = transfers.filter((t) => t.transfer_group === `event_${e17.id}`);
    assert(r17b === "paid" && pr[0].status === "paid" && g17.length === 1 && pr[0].transfer_id === g17[0]?.id,
      "owner pays: row paid with the transfer id, exactly 1 transfer", { r17b, pr, g17 });
    assert(!adminEmails.slice(emailsBefore17).some((m) => /not sent/.test(m.detail)) && adminEmails.length === emailsBefore17,
      "no 'not sent' admin email", adminEmails.slice(emailsBefore17));
    await waitFor(() => pushes.some((x) => x.data?.payoutId === id17), 2000);
    await sleep(200);
    assert(pushes.filter((x) => x.data?.payoutId === id17).length === 1, "host push sent once, by the owner", pushes.filter((x) => x.data?.payoutId === id17));

    console.log("a run that lost the row writes nothing: stale hold while the owner pays");
    const h18 = await mkReadyHost("j18");
    const e18 = await jobEvent(h18.u, "Stale Hold Night");
    await buy(e18.id, buyers[5], e18.typeId, 1);
    await endedHoursAgo(e18.id, 80);
    await createDuePayouts();
    const id18 = (await payoutOf(e18.id))[0].id as string;
    let rel18!: () => void;
    readinessGate = new Promise<void>((r) => { rel18 = r; });
    const check18 = new Promise<void>((r) => { readinessStarted = r; });
    const stale18 = sendPayout(id18, payoutFake); // claim 1 (attempts 1), stuck on the readiness check
    await check18;
    await q(`UPDATE event_payouts SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id18]);
    let rel18b!: () => void;
    holdGate = new Promise<void>((r) => { rel18b = r; });
    const create18 = new Promise<void>((r) => { createStarted = r; });
    const owner18 = sendPayout(id18, payoutFake); // claim 2 (attempts 2), create in flight
    await create18;
    const emailsBefore18 = adminEmails.length;
    setReady(h18.a, false); // the stale run's late answer says not ready
    rel18();
    const r18a = await stale18;
    const mid18 = (await payoutOf(e18.id))[0];
    assert(r18a === "not_due" && mid18.status === "pending" && mid18.attempts === 2 && adminEmails.length === emailsBefore18,
      "stale hold: not due, row untouched, attempts unchanged, no email", { r18a, mid18, emails: adminEmails.slice(emailsBefore18) });
    setReady(h18.a, true);
    rel18b();
    const r18b = await owner18;
    pr = await payoutOf(e18.id);
    assert(r18b === "paid" && pr[0].status === "paid" && pr[0].attempts === 2 && pr[0].hold_reason === null
      && transfers.filter((t) => t.transfer_group === `event_${e18.id}`).length === 1,
      "row stays paid, attempts not changed by the stale run, 1 transfer", { r18b, pr });
    assert(adminEmails.length === emailsBefore18, "no hold email", adminEmails.slice(emailsBefore18));

    console.log("race: host refund vs payout create");
    const h12 = await mkReadyHost("j12");
    const e12 = await jobEvent(h12.u, "Race Night");
    const oR = await buy(e12.id, buyers[4], e12.typeId, 2);
    await buy(e12.id, buyers[5], e12.typeId, 1);
    await endedHoursAgo(e12.id, 80);
    const [rr] = await Promise.all([
      call("POST", `/api/events/${e12.id}/orders/${oR}/refund`, { token: tok(h12.u) }),
      createDuePayouts(),
    ]);
    assert(rr.status === 200, "refund accepted", rr);
    await createDuePayouts(); // the refunding order may have blocked the first one
    pr = await payoutOf(e12.id);
    tk = await tix(e12.id);
    const refundedTix = tk.filter((t) => t.order_id === oR);
    const stampedTix = tk.filter((t) => t.payout_id === pr[0]?.id);
    const stampedSum = stampedTix.reduce((n, t) => n + Number(t.host_net_cents), 0);
    const branch = refundedTix.every((t) => t.payout_id === null) ? "refund first" : refundedTix.every((t) => t.payout_id === pr[0]?.id) ? "payout first" : "mixed";
    console.log(`    (race went: ${branch})`);
    assert(pr.length === 1 && pr[0].gross_cents === stampedSum && refundedTix.every((t) => t.status === "refunded"), "gross = stamped host_net, refunded order's tickets refunded", { pr, tk });
    assert((branch === "refund first" && pr[0]?.gross_cents === 1960) || (branch === "payout first" && pr[0]?.gross_cents === 5880),
      "either not stamped and excluded, or stamped and refunded (Task 7 recovery covers it)", { branch, pr, tk });
    // Same race with the create started a little later, so the other orderings get a chance too.
    for (const delay of [15, 40, 80]) {
      const hx = await mkReadyHost(`jr${delay}`);
      const ex = await jobEvent(hx.u, `Race Night ${delay}`);
      const oX = await buy(ex.id, buyers[6], ex.typeId, 2);
      await buy(ex.id, buyers[7], ex.typeId, 1);
      await endedHoursAgo(ex.id, 80);
      const [rx] = await Promise.all([
        call("POST", `/api/events/${ex.id}/orders/${oX}/refund`, { token: tok(hx.u) }),
        sleep(delay).then(() => createDuePayouts()),
      ]);
      await createDuePayouts();
      const px = await payoutOf(ex.id);
      const tx = await tix(ex.id);
      const rt = tx.filter((t) => t.order_id === oX);
      const sum = tx.filter((t) => t.payout_id === px[0]?.id).reduce((n, t) => n + Number(t.host_net_cents), 0);
      const bx = rt.every((t) => t.payout_id === null) ? "refund first" : rt.every((t) => t.payout_id === px[0]?.id) ? "payout first" : "mixed";
      console.log(`    (race +${delay}ms went: ${bx})`);
      assert(rx.status === 200 && px.length === 1 && px[0].gross_cents === sum && rt.every((t) => t.status === "refunded")
        && ((bx === "refund first" && sum === 1960) || (bx === "payout first" && sum === 5880)), `race +${delay}ms: invariant holds`, { bx, px, tx });
    }

    // ── Task 7: recoveries (refund after the host was paid) and the deduction from the next event payout ──
    console.log("recoveries (task 7)");
    const { openRecoveries, processRecovery, alertOldOwed } = await import("./eventPayouts");
    const recOf = async (ticketId: string) => q(`SELECT *, extract(epoch from (next_attempt_at - now()))::int AS due_in FROM event_payout_recoveries WHERE ticket_id = $1`, [ticketId]);
    const advanceRec = (id: string) => q(`UPDATE event_payout_recoveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
    const ticketOf = async (orderId: string) => (await q(`SELECT id FROM tickets WHERE order_id = $1 ORDER BY item_index LIMIT 1`, [orderId]))[0].id as string;
    const refundOrder = async (eventId: string, host: string, orderId: string) => {
      const x = await call("POST", `/api/events/${eventId}/orders/${orderId}/refund`, { token: tok(host) });
      if (x.status !== 200 || x.body?.order?.status !== "refunded") throw new Error("refund failed " + JSON.stringify(x));
    };
    /** An ended event with `n` one-ticket orders (1960 host net each), already paid out to the host. */
    const paidOut = async (h: { u: string; a: string }, title: string, n = 2) => {
      const ev = await jobEvent(h.u, title);
      const orders: string[] = [];
      for (let i = 0; i < n; i++) orders.push(await buy(ev.id, buyers[i], ev.typeId, 1));
      await endedHoursAgo(ev.id, 80);
      await createDuePayouts();
      const [p] = await payoutOf(ev.id);
      const res = await sendPayout(p.id, payoutFake);
      const [paid] = await payoutOf(ev.id);
      if (res !== "paid" || !paid.transfer_id) throw new Error("payout not paid " + JSON.stringify({ res, paid }));
      return { ev, orders, payoutId: p.id as string, transferId: paid.transfer_id as string };
    };

    console.log("refund before payout: no recovery");
    const o3bTickets = await q(`SELECT id FROM tickets WHERE order_id = $1`, [o3b]);
    await openRecoveries();
    assert((await q(`SELECT 1 FROM event_payout_recoveries WHERE ticket_id = ANY($1)`, [o3bTickets.map((t) => t.id)])).length === 0,
      "ticket refunded before its event was paid out: no recovery row", o3bTickets);

    console.log("refund after payout opens one recovery");
    const hR1 = await mkReadyHost("r1");
    const pR1 = await paidOut(hR1, "Recovery Night");
    await refundOrder(pR1.ev.id, hR1.u, pR1.orders[0]);
    const tR1 = await ticketOf(pR1.orders[0]);
    const n1 = await openRecoveries();
    let rc = await recOf(tR1);
    assert(n1 >= 1 && rc.length === 1 && rc[0].status === "pending" && rc[0].amount_cents === 1960 && rc[0].payout_id === pR1.payoutId
      && rc[0].connected_account_id === hR1.a && rc[0].attempts === 0, "one pending recovery: host net 1960, the payout and the host's account", { n1, rc });
    const n1b = await openRecoveries();
    assert(n1b === 0 && (await recOf(tR1)).length === 1, "second open: nothing new", n1b);
    assert((await recOf(await ticketOf(pR1.orders[1]))).length === 0, "the ticket that wasn't refunded has no recovery");

    console.log("reversal success -> reversed");
    sres = await processRecovery(rc[0].id, payoutFake) as any;
    rc = await recOf(tR1);
    const rvR1 = reversals.filter((x) => x.metadata?.ticketId === tR1);
    const postsR1 = reversalPosts.filter((x) => x.ticketId === tR1);
    assert(sres === "reversed" && rc[0].status === "reversed" && rc[0].reversal_id === rvR1[0]?.id && rc[0].next_attempt_at === null && rc[0].attempts === 1,
      "status reversed with the reversal id", { sres, rc });
    assert(rvR1.length === 1 && rvR1[0].transfer === pR1.transferId && rvR1[0].amount === 1960 && rvR1[0].metadata.type === "event_payout_recovery",
      "stub saw one reversal of 1960 on the payout's transfer", rvR1);
    assert(postsR1.length === 1 && new RegExp(`^event_recovery_${tR1}_\\d+$`).test(postsR1[0].key ?? ""), "reversal key event_recovery_<ticketId>_<claim>", postsR1);
    assert(revBounds.length > 0 && revBounds.every((b) => b.timeoutMs === 30000 && b.maxNetworkRetries === 1), "reversal call bounded (30 s, 1 retry)", revBounds);
    sres = await processRecovery(rc[0].id, payoutFake) as any;
    assert(sres === "not_due" && reversals.filter((x) => x.metadata?.ticketId === tR1).length === 1, "reversed is final: not due, still one reversal", sres);

    console.log("insufficient host balance -> owed");
    const hR2 = await mkReadyHost("r2");
    const pR2 = await paidOut(hR2, "Owed Night");
    await refundOrder(pR2.ev.id, hR2.u, pR2.orders[0]);
    const tR2 = await ticketOf(pR2.orders[0]);
    await openRecoveries();
    rc = await recOf(tR2);
    rsw.insufficient = true;
    sres = await processRecovery(rc[0].id, payoutFake) as any;
    rsw.insufficient = false;
    rc = await recOf(tR2);
    assert(sres === "owed" && rc[0].status === "owed" && rc[0].reversal_id === null && /Insufficient/.test(rc[0].last_error ?? "") && rc[0].next_attempt_at === null,
      "insufficient: owed at once with the error", { sres, rc });
    sres = await processRecovery(rc[0].id, payoutFake) as any;
    assert(sres === "not_due" && reversals.filter((x) => x.metadata?.ticketId === tR2).length === 0, "owed is not retried by the reversal step", sres);

    console.log("owed deducted from the next event payout");
    const eR2b = await jobEvent(hR2.u, "Owed Night Two");
    await buy(eR2b.id, buyers[2], eR2b.typeId, 2);
    await endedHoursAgo(eR2b.id, 80);
    await createDuePayouts();
    pr = await payoutOf(eR2b.id);
    rc = await recOf(tR2);
    assert(pr.length === 1 && pr[0].gross_cents === 3920 && pr[0].deducted_cents === 1960 && pr[0].amount_cents === 1960,
      "next payout: gross 3920, deducted 1960, amount 1960", pr);
    assert(rc[0].status === "recovered" && rc[0].recovered_from_payout_id === pr[0]?.id, "recovery recovered from the new payout", rc);
    sres = await sendPayout(pr[0].id, payoutFake);
    const gR2b = transfers.filter((t) => t.transfer_group === `event_${eR2b.id}`);
    assert(sres === "paid" && gR2b.length === 1 && gR2b[0].amount === 1960, "transfer sent for the reduced amount", { sres, gR2b });

    console.log("owed bigger than the payout: the rest stays owed");
    const hR3 = await mkReadyHost("r3");
    const pR3 = await paidOut(hR3, "Big Owed Night");
    const [tR3a, tR3b] = [await ticketOf(pR3.orders[0]), await ticketOf(pR3.orders[1])];
    // Written by SQL to get amounts a real ticket can't: 5000 (older) and 1000 (newer).
    const [big] = await q(`INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status, created_at)
      VALUES ($1, $2, $3, 5000, 'owed', now() - interval '2 days') RETURNING id`, [tR3a, pR3.payoutId, hR3.a]);
    const [small] = await q(`INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status, created_at)
      VALUES ($1, $2, $3, 1000, 'owed', now() - interval '1 day') RETURNING id`, [tR3b, pR3.payoutId, hR3.a]);
    const eR3b = await jobEvent(hR3.u, "Big Owed Night Two");
    await buy(eR3b.id, buyers[3], eR3b.typeId, 2);
    await endedHoursAgo(eR3b.id, 80);
    await createDuePayouts();
    pr = await payoutOf(eR3b.id);
    const bigRow = (await q(`SELECT * FROM event_payout_recoveries WHERE id = $1`, [big.id]))[0];
    const smallRow = (await q(`SELECT * FROM event_payout_recoveries WHERE id = $1`, [small.id]))[0];
    assert(pr.length === 1 && pr[0].gross_cents === 3920 && pr[0].deducted_cents === 1000 && pr[0].amount_cents === 2920,
      "only 1000 deducted (5000 would not leave a payout), amount 2920", pr);
    assert(bigRow.status === "owed" && bigRow.recovered_from_payout_id === null && smallRow.status === "recovered" && smallRow.recovered_from_payout_id === pr[0]?.id,
      "5000 stays owed, 1000 recovered from this payout", { bigRow, smallRow });

    console.log("no deduction for another account or with no account");
    const hR3o = await mkReadyHost("r3o");
    const eR3o = await jobEvent(hR3o.u, "Other Host Night");
    await buy(eR3o.id, buyers[4], eR3o.typeId, 1);
    const hR3n = await mkUser("r3n"); // no payout account at all
    const eR3n = await jobEvent(hR3n, "No Account Night");
    await buy(eR3n.id, buyers[5], eR3n.typeId, 1);
    await endedHoursAgo(eR3o.id, 80);
    await endedHoursAgo(eR3n.id, 80);
    await createDuePayouts();
    const pO = (await payoutOf(eR3o.id))[0];
    const pN = (await payoutOf(eR3n.id))[0];
    assert(pO?.deducted_cents === 0 && pO?.amount_cents === 1960 && pN?.deducted_cents === 0 && pN?.amount_cents === 1960 && pN?.connected_account_id === null,
      "other host and host with no account: nothing deducted", { pO, pN });
    assert((await q(`SELECT status FROM event_payout_recoveries WHERE id = $1`, [big.id]))[0].status === "owed", "another host's owed untouched");

    console.log("owed older than 30 days -> one admin email");
    await q(`UPDATE event_payout_recoveries SET created_at = now() - interval '31 days' WHERE id = $1`, [big.id]);
    const hR3y = await mkReadyHost("r3y");
    const pR3y = await paidOut(hR3y, "Young Owed Night", 1);
    const [young] = await q(`INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status, created_at)
      VALUES ($1, $2, $3, 700, 'owed', now() - interval '29 days') RETURNING id`, [await ticketOf(pR3y.orders[0]), pR3y.payoutId, hR3y.a]);
    emailsBefore = adminEmails.length;
    const nOld = await alertOldOwed();
    const oldMails = adminEmails.slice(emailsBefore);
    assert(nOld >= 1 && oldMails.length === 1 && oldMails[0].detail.includes(big.id) && oldMails[0].detail.includes("5000") && !oldMails[0].detail.includes(young.id),
      "one admin email listing the 31 day old owed recovery, not the 29 day one", { nOld, oldMails });
    const bigAfter = (await q(`SELECT alerted_at, status FROM event_payout_recoveries WHERE id = $1`, [big.id]))[0];
    assert(bigAfter.alerted_at && bigAfter.status === "owed", "alerted_at set, still owed", bigAfter);
    emailsBefore = adminEmails.length;
    const nOld2 = await alertOldOwed();
    assert(nOld2 === 0 && adminEmails.length === emailsBefore, "second run: no email", { nOld2 });

    console.log("refund on a stamped payout not yet paid: recovered after it is paid");
    const hR4 = await mkReadyHost("r4");
    const eR4 = await jobEvent(hR4.u, "Stamped Night");
    const oR4 = await buy(eR4.id, buyers[0], eR4.typeId, 1);
    await buy(eR4.id, buyers[1], eR4.typeId, 1);
    await endedHoursAgo(eR4.id, 80);
    await createDuePayouts();
    const pR4 = (await payoutOf(eR4.id))[0];
    await refundOrder(eR4.id, hR4.u, oR4);
    const tR4 = await ticketOf(oR4);
    await openRecoveries();
    assert((await recOf(tR4)).length === 0, "payout not paid yet: no recovery");
    assert((await sendPayout(pR4.id, payoutFake)) === "paid", "payout pays the stamped amount");
    await openRecoveries();
    rc = await recOf(tR4);
    assert(rc.length === 1 && rc[0].status === "pending" && rc[0].amount_cents === 1960, "after it is paid: one pending recovery", rc);

    console.log("reversal created but its response lost");
    rsw.loseResponse = 1;
    sres = await processRecovery(rc[0].id, payoutFake) as any;
    let rcl = (await recOf(tR4))[0];
    assert(sres === "retry" && rcl.status === "pending" && rcl.due_in > 590 && rcl.due_in <= 600 && reversals.filter((x) => x.metadata?.ticketId === tR4).length === 1,
      "lost response: Stripe has it, row pending, due again in 10 minutes", { sres, rcl });
    await advanceRec(rc[0].id);
    sres = await processRecovery(rc[0].id, payoutFake) as any;
    rcl = (await recOf(tR4))[0];
    const rvR4 = reversals.filter((x) => x.metadata?.ticketId === tR4);
    assert(sres === "reversed" && rcl.status === "reversed" && rcl.reversal_id === rvR4[0]?.id && rvR4.length === 1 && reversalPosts.filter((x) => x.ticketId === tR4).length === 1,
      "next try finds it on the transfer and records it: exactly 1 reversal, no second POST", { sres, rcl, rvR4 });

    console.log("other errors back off, after 5 -> owed");
    const hR5 = await mkReadyHost("r5");
    const pR5 = await paidOut(hR5, "Broken Reversal Night");
    await refundOrder(pR5.ev.id, hR5.u, pR5.orders[0]);
    const tR5 = await ticketOf(pR5.orders[0]);
    await openRecoveries();
    const idR5 = (await recOf(tR5))[0].id as string;
    rsw.failRev = true;
    const rWaits: number[] = [];
    const rResults: string[] = [];
    for (let i = 0; i < 5; i++) {
      rResults.push(await processRecovery(idR5, payoutFake));
      rWaits.push((await recOf(tR5))[0].due_in);
      await advanceRec(idR5);
    }
    rc = await recOf(tR5);
    // Final review fix: the claim whose own call just failed never owes; it backs off at least one lock period.
    assert(rResults.every((x) => x === "retry") && rc[0].status === "pending" && rc[0].attempts === 5, "5 failures: all retry, still pending (never owed in the failing claim)", { rResults, rc });
    assert(rWaits[0] > 590 && rWaits[0] <= 600 && rWaits[1] > 1190 && rWaits[1] <= 1200 && rWaits[2] > 2390 && rWaits[2] <= 2400 && rWaits[3] > 3590 && rWaits[3] <= 3600
      && rWaits[4] >= 600, "backoff 10, 20, 40, 60 minutes, and at least the lock after the 5th", rWaits);
    const r5six = await processRecovery(idR5, payoutFake); // failRev still on: a POST here would fail, and must not happen
    rsw.failRev = false;
    rc = await recOf(tR5);
    const postsR5 = reversalPosts.filter((x) => x.ticketId === tR5);
    assert(r5six === "owed" && rc[0].status === "owed" && rc[0].attempts === 6 && /stub reversal failure/.test(rc[0].last_error ?? ""), "next claim: lookup only, nothing there -> owed with the last error", { r5six, rc });
    assert(postsR5.length === 5 && new Set(postsR5.map((x) => x.key)).size === 5 && postsR5.every((x) => !x.replayed), "no new reversal POST on the lookup-only claim; a new key on every try", postsR5);
    assert(fakeLog.filter((l) => l.fn === "findReversal" && l.id === tR5).length === 6, "5 lookups before creates + 1 on the lookup-only claim",
      fakeLog.filter((l) => l.fn === "findReversal" && l.id === tR5).length);

    console.log("fix 1: last try's reversal lands but its response is lost -> reversed, not owed");
    const hF1 = await mkReadyHost("f1");
    const pF1 = await paidOut(hF1, "Last Try Lost Night");
    await refundOrder(pF1.ev.id, hF1.u, pF1.orders[0]);
    const tF1 = await ticketOf(pF1.orders[0]);
    await openRecoveries();
    const idF1 = (await recOf(tF1))[0].id as string;
    rsw.failOnce = 4; rsw.loseResponse = 1; // tries 1-4: 500; try 5: reversal made, reply lost
    const fRes: string[] = [];
    for (let i = 0; i < 6; i++) { fRes.push(await processRecovery(idF1, payoutFake)); await advanceRec(idF1); }
    rsw.failOnce = 0; rsw.loseResponse = 0;
    rc = await recOf(tF1);
    const rvF1 = reversals.filter((x) => x.metadata?.ticketId === tF1);
    assert(fRes.slice(0, 5).every((x) => x === "retry") && fRes[5] === "reversed" && rc[0].status === "reversed" && rc[0].reversal_id === rvF1[0]?.id && rvF1.length === 1
      && reversalPosts.filter((x) => x.ticketId === tF1).length === 5, "5th try lost: next claim's lookup finds the reversal and records it, no 6th POST", { fRes, rc, rvF1 });
    const eF1b = await jobEvent(hF1.u, "Last Try Lost Night Two");
    await buy(eF1b.id, buyers[2], eF1b.typeId, 2); // gross 3920: an owed 1960 would be deducted
    await endedHoursAgo(eF1b.id, 80);
    await createDuePayouts();
    pr = await payoutOf(eF1b.id);
    assert(pr.length === 1 && pr[0].deducted_cents === 0 && pr[0].amount_cents === 3920, "next payout deducts nothing (no double recovery)", pr);

    console.log("final fix: 5th try times out, its reversal lands later -> next claim finds it, reversed, nothing deducted");
    const hT1 = await mkReadyHost("t1");
    const pT1 = await paidOut(hT1, "Late Landing Night");
    await refundOrder(pT1.ev.id, hT1.u, pT1.orders[0]);
    const tT1 = await ticketOf(pT1.orders[0]);
    await openRecoveries();
    const idT1 = (await recOf(tT1))[0].id as string;
    rsw.failOnce = 4; // tries 1-4: 500
    const tRes: string[] = [];
    for (let i = 0; i < 4; i++) { tRes.push(await processRecovery(idT1, payoutFake)); await advanceRec(idT1); }
    rsw.timeoutLandLater = 1; // try 5: the client times out, Stripe is still working on it
    tRes.push(await processRecovery(idT1, payoutFake));
    rc = await recOf(tT1);
    assert(tRes.every((x) => x === "retry") && rc[0].status === "pending" && rc[0].due_in >= 600 && reversals.filter((x) => x.metadata?.ticketId === tT1).length === 0,
      "5th try timed out: pending (not owed), backed off at least the lock, nothing on Stripe yet", { tRes, rc });
    landLater(); // the reversal lands at Stripe after the claim gave up
    await advanceRec(idT1);
    const t6 = await processRecovery(idT1, payoutFake);
    rc = await recOf(tT1);
    const rvT1 = reversals.filter((x) => x.metadata?.ticketId === tT1);
    assert(t6 === "reversed" && rc[0].status === "reversed" && rc[0].reversal_id === rvT1[0]?.id && rvT1.length === 1 && reversalPosts.filter((x) => x.ticketId === tT1).length === 5,
      "next claim: lookup finds the late reversal, records it, no new POST", { t6, rc, rvT1 });
    const eT1b = await jobEvent(hT1.u, "Late Landing Night Two");
    await buy(eT1b.id, buyers[4], eT1b.typeId, 2);
    await endedHoursAgo(eT1b.id, 80);
    await createDuePayouts();
    pr = await payoutOf(eT1b.id);
    assert(pr.length === 1 && pr[0].deducted_cents === 0 && pr[0].amount_cents === 3920, "next payout deducts 0 (host charged once)", pr);

    console.log("fix 1: reversal lost on try 1, lookups fail after -> never owed, then reversed");
    const hF2 = await mkReadyHost("f2");
    const pF2 = await paidOut(hF2, "Lookup Down Night");
    await refundOrder(pF2.ev.id, hF2.u, pF2.orders[0]);
    const tF2 = await ticketOf(pF2.orders[0]);
    await openRecoveries();
    const idF2 = (await recOf(tF2))[0].id as string;
    rsw.loseResponse = 1;
    const g1 = await processRecovery(idF2, payoutFake); // reversal made, reply lost
    await advanceRec(idF2);
    rsw.failLookup = 5; // tries 2-5 lookups fail, and the lookup-only claim (try 6) fails too
    const gRes: string[] = [];
    for (let i = 0; i < 5; i++) { gRes.push(await processRecovery(idF2, payoutFake)); await advanceRec(idF2); }
    rc = await recOf(tF2);
    assert(g1 === "retry" && gRes.every((x) => x === "retry") && rc[0].status === "pending" && rc[0].attempts === 6 && rsw.failLookup === 0
      && /list failure/.test(rc[0].last_error ?? ""), "lookup errors on the lookup-only claim: stays pending (not owed), error saved", { g1, gRes, rc, left: rsw.failLookup });
    await advanceRec(idF2);
    const g6 = await processRecovery(idF2, payoutFake);
    rc = await recOf(tF2);
    assert(g6 === "reversed" && rc[0].status === "reversed" && reversals.filter((x) => x.metadata?.ticketId === tF2).length === 1
      && reversalPosts.filter((x) => x.ticketId === tF2).length === 1, "lookup back: the lost reversal is recorded, exactly 1 reversal", { g6, rc });
    const eF2b = await jobEvent(hF2.u, "Lookup Down Night Two");
    await buy(eF2b.id, buyers[3], eF2b.typeId, 2);
    await endedHoursAgo(eF2b.id, 80);
    await createDuePayouts();
    pr = await payoutOf(eF2b.id);
    assert(pr.length === 1 && pr[0].deducted_cents === 0, "next payout deducts nothing", pr);

    console.log("fix 1: insufficient with a lookup failure before owing stays pending");
    const hF3 = await mkReadyHost("f3");
    const pF3 = await paidOut(hF3, "Insufficient Lookup Night");
    await refundOrder(pF3.ev.id, hF3.u, pF3.orders[0]);
    const tF3 = await ticketOf(pF3.orders[0]);
    await openRecoveries();
    const idF3 = (await recOf(tF3))[0].id as string;
    rsw.failLookup = 0;
    rsw.insufficient = true;
    // First lookup (before the create) works; the one before owing fails.
    const origFind = payoutFake.findEventPayoutReversal;
    let findN = 0;
    payoutFake.findEventPayoutReversal = async (a: string, b: string, o?: any) => { if (b === tF3 && ++findN === 2) rsw.failLookup = 1; return origFind(a, b, o); };
    const i1 = await processRecovery(idF3, payoutFake);
    payoutFake.findEventPayoutReversal = origFind;
    rc = await recOf(tF3);
    assert(i1 === "retry" && rc[0].status === "pending" && rc[0].due_in > 590, "insufficient but can't confirm no reversal: pending with backoff", { i1, rc });
    await advanceRec(idF3);
    const i2 = await processRecovery(idF3, payoutFake);
    rsw.insufficient = false;
    assert(i2 === "owed" && (await recOf(tF3))[0].status === "owed", "insufficient and lookup confirms none: owed", i2);

    console.log("final fix: a recovery stuck pending at max tries for over 24 hours -> one admin email");
    const alertStuckRecoveries: () => Promise<number> = ((await import("./eventPayouts")) as any).alertStuckRecoveries ?? (async () => 0);
    const hS1 = await mkReadyHost("s1");
    const pS1 = await paidOut(hS1, "Stuck Lookup Night", 3);
    const [tS1, tS2, tS3] = [await ticketOf(pS1.orders[0]), await ticketOf(pS1.orders[1]), await ticketOf(pS1.orders[2])];
    const stuckIns = (t: string, attempts: number, hoursAgo: number) => q(`INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status, attempts, next_attempt_at, last_error, created_at)
      VALUES ($1, $2, $3, 1960, 'pending', $4, now() + interval '1 hour', 'stub reversal list failure', now() - make_interval(hours => $5::int)) RETURNING id`, [t, pS1.payoutId, hS1.a, attempts, hoursAgo]);
    const [stuck] = await stuckIns(tS1, 9, 30);
    const [young24] = await stuckIns(tS2, 9, 20);
    const [fewTries] = await stuckIns(tS3, 3, 30);
    const tagBefore = (await q(`SELECT updated_at FROM event_payout_recoveries WHERE id = $1`, [stuck.id]))[0].updated_at;
    emailsBefore = adminEmails.length;
    const nStuck = await alertStuckRecoveries();
    const stuckMails = adminEmails.slice(emailsBefore);
    assert(nStuck === 1 && stuckMails.length === 1 && stuckMails[0].detail.includes(stuck.id) && !stuckMails[0].detail.includes(young24.id) && !stuckMails[0].detail.includes(fewTries.id),
      "one admin email for the recovery stuck at max tries over 24 hours, not the younger or fewer-tries ones", { nStuck, stuckMails });
    const stuckAfter = (await q(`SELECT alerted_at, status, updated_at FROM event_payout_recoveries WHERE id = $1`, [stuck.id]))[0];
    assert(stuckAfter.alerted_at && stuckAfter.status === "pending" && String(stuckAfter.updated_at) === String(tagBefore),
      "alerted_at set, still pending, ownership tag (updated_at) untouched", { stuckAfter, tagBefore });
    emailsBefore = adminEmails.length;
    assert((await alertStuckRecoveries()) === 0 && adminEmails.length === emailsBefore, "second run: no second email");
    await advanceRec(stuck.id);
    const sOwed = await processRecovery(stuck.id, payoutFake); // lookup works now and finds nothing -> owed
    const sRow = (await q(`SELECT status, alerted_at FROM event_payout_recoveries WHERE id = $1`, [stuck.id]))[0];
    assert(sOwed === "owed" && sRow.status === "owed" && sRow.alerted_at === null && reversalPosts.filter((x) => x.ticketId === tS1).length === 0,
      "later owed: alerted_at cleared so the 30 day owed email still fires, no reversal POST", { sOwed, sRow });
    await q(`DELETE FROM event_payout_recoveries WHERE id = ANY($1)`, [[stuck.id, young24.id, fewTries.id]]);

    console.log("a transient 500 once, then reversed with a new key");
    const hR6 = await mkReadyHost("r6");
    const pR6 = await paidOut(hR6, "Blip Reversal Night");
    await refundOrder(pR6.ev.id, hR6.u, pR6.orders[0]);
    const tR6 = await ticketOf(pR6.orders[0]);
    await openRecoveries();
    const idR6 = (await recOf(tR6))[0].id as string;
    rsw.failOnce = 1;
    const r6a = await processRecovery(idR6, payoutFake);
    const r6early = await processRecovery(idR6, payoutFake);
    await advanceRec(idR6);
    const r6b = await processRecovery(idR6, payoutFake);
    const postsR6 = reversalPosts.filter((x) => x.ticketId === tR6);
    assert(r6a === "retry" && r6early === "not_due" && r6b === "reversed" && postsR6.length === 2 && postsR6[0].key !== postsR6[1].key && !postsR6[1].replayed
      && reversals.filter((x) => x.metadata?.ticketId === tR6).length === 1, "500 then OK: reversed on the next try, new key, 1 reversal", { r6a, r6early, r6b, postsR6 });

    console.log("two overlapping runs: a reversal in flight is never claimed again");
    const hR7 = await mkReadyHost("r7");
    const pR7 = await paidOut(hR7, "Slow Reversal Night");
    await refundOrder(pR7.ev.id, hR7.u, pR7.orders[0]);
    const tR7 = await ticketOf(pR7.orders[0]);
    await openRecoveries();
    const idR7 = (await recOf(tR7))[0].id as string;
    let relR7!: () => void;
    revHoldGate = new Promise<void>((r) => { relR7 = r; });
    const startedR7 = new Promise<void>((r) => { revCreateStarted = r; });
    const firstR7 = processRecovery(idR7, payoutFake);
    await startedR7;
    const lockR7 = (await recOf(tR7))[0].due_in;
    assert(lockR7 > 590 && lockR7 <= 600, "claim locks the recovery for 10 minutes while the reversal is in flight", lockR7);
    await q(`UPDATE event_payout_recoveries SET next_attempt_at = next_attempt_at - interval '61 seconds' WHERE id = $1`, [idR7]);
    const secondR7 = await processRecovery(idR7, payoutFake);
    await runEventPayoutJob(payoutFake);
    assert(secondR7 === "not_due" && reversalPosts.filter((x) => x.ticketId === tR7).length === 0, "second run while in flight: not due, nothing sent", secondR7);
    relR7();
    const firstR7Res = await firstR7;
    assert(firstR7Res === "reversed" && (await recOf(tR7))[0].status === "reversed" && reversals.filter((x) => x.metadata?.ticketId === tR7).length === 1
      && reversalPosts.filter((x) => x.ticketId === tR7).length === 1, "exactly 1 reversal at the end", { firstR7Res });

    console.log("two overlapping runs: a slow lookup outlasts the lock, that run sends nothing");
    const hR8 = await mkReadyHost("r8");
    const pR8 = await paidOut(hR8, "Slow Lookup Night");
    await refundOrder(pR8.ev.id, hR8.u, pR8.orders[0]);
    const tR8 = await ticketOf(pR8.orders[0]);
    await openRecoveries();
    const idR8 = (await recOf(tR8))[0].id as string;
    // Run 1 claims, then is stuck in a slow DB read (hook) past its lock; run 2 claims and gets to its create.
    let relR8!: () => void;
    const gateR8 = new Promise<void>((r) => { relR8 = r; });
    let claimedR8!: () => void;
    const atClaimR8 = new Promise<void>((r) => { claimedR8 = r; });
    let onceR8 = true;
    setPayoutHooksForTest({ afterRecoveryClaim: async (id: string) => { if (id === idR8 && onceR8) { onceR8 = false; claimedR8(); await gateR8; } } });
    const run1R8 = processRecovery(idR8, payoutFake);
    await atClaimR8;
    await q(`UPDATE event_payout_recoveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [idR8]);
    let relR8b!: () => void;
    revHoldGate = new Promise<void>((r) => { relR8b = r; });
    const createR8 = new Promise<void>((r) => { revCreateStarted = r; });
    const run2R8 = processRecovery(idR8, payoutFake);
    await createR8;
    relR8();
    const r8a = await run1R8;
    relR8b();
    const r8b = await run2R8;
    setPayoutHooksForTest(null);
    rc = await recOf(tR8);
    assert(r8a === "not_due" && r8b === "reversed" && rc[0].status === "reversed", "stale run can't re-take the lock; the owner reverses", { r8a, r8b, rc });
    assert(reversals.filter((x) => x.metadata?.ticketId === tR8).length === 1 && reversalPosts.filter((x) => x.ticketId === tR8).length === 1, "exactly 1 reversal overall");
    // A slow lookup: run 1's lookup answers after its lock ran out and run 2 claimed. Run 1 must not create.
    const hR8c = await mkReadyHost("r8c");
    const pR8c = await paidOut(hR8c, "Slow Lookup Night Two");
    await refundOrder(pR8c.ev.id, hR8c.u, pR8c.orders[0]);
    const tR8c = await ticketOf(pR8c.orders[0]);
    await openRecoveries();
    const idR8c = (await recOf(tR8c))[0].id as string;
    let relL!: () => void;
    revLookupGate = new Promise<void>((r) => { relL = r; });
    const lookStarted = new Promise<void>((r) => { revLookupStarted = r; });
    const run1c = processRecovery(idR8c, payoutFake);
    await lookStarted;
    await q(`UPDATE event_payout_recoveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [idR8c]);
    let relC!: () => void;
    revHoldGate = new Promise<void>((r) => { relC = r; });
    const createC = new Promise<void>((r) => { revCreateStarted = r; });
    const run2c = processRecovery(idR8c, payoutFake);
    await createC;
    relL();
    const r8ca = await run1c;
    relC();
    const r8cb = await run2c;
    const nRevC = reversals.filter((x) => x.metadata?.ticketId === tR8c).length;
    const nPostC = reversalPosts.filter((x) => x.ticketId === tR8c).length;
    assert(r8ca === "not_due" && r8cb === "reversed" && nRevC === 1 && nPostC === 1 && (await recOf(tR8c))[0].status === "reversed",
      "slow lookup: run 1 checks it still owns the row before creating, sends nothing; exactly 1 reversal", { r8ca, r8cb, nRevC, nPostC });

    console.log("the job opens, reverses and alerts");
    const hR9 = await mkReadyHost("r9");
    const pR9 = await paidOut(hR9, "Job Recovery Night");
    await refundOrder(pR9.ev.id, hR9.u, pR9.orders[1]);
    const tR9 = await ticketOf(pR9.orders[1]);
    await q(`UPDATE event_payout_recoveries SET alerted_at = NULL, created_at = now() - interval '40 days' WHERE id = $1`, [young.id]);
    emailsBefore = adminEmails.length;
    await runEventPayoutJob(payoutFake);
    rc = await recOf(tR9);
    assert(rc.length === 1 && rc[0].status === "reversed" && reversals.filter((x) => x.metadata?.ticketId === tR9).length === 1, "one job run: recovery opened and reversed", rc);
    assert(adminEmails.slice(emailsBefore).filter((m) => m.detail.includes(young.id)).length === 1, "one job run: old owed alerted", adminEmails.slice(emailsBefore));

    console.log("two payout creates at once take an owed recovery once");
    const hR10 = await mkReadyHost("r10");
    const pR10 = await paidOut(hR10, "Shared Owed Night", 1);
    const [owed10] = await q(`INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status)
      VALUES ($1, $2, $3, 1000, 'owed') RETURNING id`, [await ticketOf(pR10.orders[0]), pR10.payoutId, hR10.a]);
    const eR10a = await jobEvent(hR10.u, "Shared Owed A");
    await buy(eR10a.id, buyers[0], eR10a.typeId, 1);
    const eR10b = await jobEvent(hR10.u, "Shared Owed B");
    await buy(eR10b.id, buyers[1], eR10b.typeId, 1);
    await endedHoursAgo(eR10a.id, 80);
    await endedHoursAgo(eR10b.id, 80);
    await Promise.all([createDuePayouts(), createDuePayouts()]);
    await createDuePayouts(); // a guarded statement leaves its event for the next run
    const pa = (await payoutOf(eR10a.id))[0], pb = (await payoutOf(eR10b.id))[0];
    const o10 = (await q(`SELECT * FROM event_payout_recoveries WHERE id = $1`, [owed10.id]))[0];
    assert(pa && pb && pa.deducted_cents + pb.deducted_cents === 1000 && o10.status === "recovered" && [pa.id, pb.id].includes(o10.recovered_from_payout_id)
      && (o10.recovered_from_payout_id === pa.id ? pa.deducted_cents : pb.deducted_cents) === 1000, "deducted exactly once, from the payout it names", { pa, pb, o10 });

    console.log("guard: an owed recovery taken by someone else mid-statement undoes the whole create");
    const hR11 = await mkReadyHost("r11");
    const pR11 = await paidOut(hR11, "Guard Owed Night", 1);
    const [owed11] = await q(`INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status)
      VALUES ($1, $2, $3, 900, 'owed') RETURNING id`, [await ticketOf(pR11.orders[0]), pR11.payoutId, hR11.a]);
    const eR11 = await jobEvent(hR11.u, "Guard Owed Two");
    await buy(eR11.id, buyers[2], eR11.typeId, 1);
    await endedHoursAgo(eR11.id, 80);
    const other = new pg.Client({ connectionString: PG_URL });
    await other.connect();
    await other.query("BEGIN");
    await other.query(`UPDATE event_payout_recoveries SET status = 'recovered', recovered_from_payout_id = $2 WHERE id = $1`, [owed11.id, pR11.payoutId]);
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: any[]) => { errs.push(a.map(String).join(" ")); origErr(...a); };
    const creating = createDuePayouts(); // reads the row as owed, then waits on its lock
    await sleep(800);
    await other.query("COMMIT");
    await creating;
    console.error = origErr;
    await other.end();
    assert((await payoutOf(eR11.id)).length === 0 && (await tix(eR11.id)).every((t) => t.payout_id === null), "guarded: no payout row and no ticket stamped", await tix(eR11.id));
    assert(errs.some((m) => m.includes(eR11.id) && m.includes("GUARD_PAYOUT_DEDUCT")), "stopped by GUARD_PAYOUT_DEDUCT", errs.filter((m) => m.includes(eR11.id)));
    await createDuePayouts();
    pr = await payoutOf(eR11.id);
    assert(pr.length === 1 && pr[0].deducted_cents === 0 && pr[0].amount_cents === 1960 && (await tix(eR11.id)).every((t) => t.payout_id === pr[0].id),
      "next run creates it with nothing deducted (the recovery is already taken)", pr);
  } finally {
    stub.close();
    try {
      (await import("./ticketNotices")).setNoticeDepsForTest(null);
      (await import("./ticketCheckout")).setAdminAlertForTest(null);
      (await import("./eventPayouts")).setPayoutHooksForTest(null);
    } catch { /* not loaded */ }
    const evIds = (await q(`SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`])).map((x) => x.id);
    if (evIds.length) {
      await q(`UPDATE tickets SET payout_id = NULL WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM event_payout_recoveries WHERE payout_id IN (SELECT id FROM event_payouts WHERE event_id = ANY($1))
                 OR recovered_from_payout_id IN (SELECT id FROM event_payouts WHERE event_id = ANY($1))
                 OR ticket_id IN (SELECT id FROM tickets WHERE event_id = ANY($1))`, [evIds]);
      await q(`DELETE FROM event_payouts WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [evIds]);
      await q(`DELETE FROM ticket_account_counts WHERE ticket_type_id IN (SELECT id FROM ticket_types WHERE event_id = ANY($1))`, [evIds]);
      await q(`UPDATE ticket_types SET unlock_after_ticket_type_id = NULL WHERE event_id = ANY($1)`, [evIds]);
    }
    await q(`DELETE FROM ticket_types WHERE event_id IN (SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1))`, [`${P}-%`]);
    await q(`DELETE FROM events WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM user_payout_accounts WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM businesses WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM photographers WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
