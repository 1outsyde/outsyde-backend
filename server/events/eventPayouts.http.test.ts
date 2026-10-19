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

  // Section: /v1/transfers (+ reversals). Switches: failTransfer, insufficient. (Used by later tasks.)
  const sw = { failTransfer: false, insufficient: false };
  const transfersByKey: Record<string, any> = {};
  const transfers: any[] = [];
  const reversals: any[] = [];

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
        if (sw.insufficient) return send(400, { error: { type: "invalid_request_error", code: "balance_insufficient", message: "Insufficient funds in Stripe account." } });
        if (sw.failTransfer) return send(500, { error: { type: "api_error", message: "stub transfer failure" } });
        if (key && transfersByKey[key]) return send(200, transfersByKey[key]);
        const params = formParams(form);
        const metadata: Record<string, string> = {};
        for (const [k, v] of Object.entries(params)) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        const t = { id: `tr_stub_${transfers.length + 1}`, object: "transfer", amount: Number(params.amount), currency: params.currency, destination: params.destination, transfer_group: params.transfer_group ?? null, metadata, reversed: false, amount_reversed: 0 };
        transfers.push(t);
        if (key) transfersByKey[key] = t;
        return send(200, t);
      }
      if (req.method === "GET" && path === "/v1/transfers") {
        const group = url.searchParams.get("transfer_group");
        return send(200, { object: "list", has_more: false, data: transfers.filter((t) => !group || t.transfer_group === group) });
      }
      const revM = path.match(/^\/v1\/transfers\/([^/]+)\/reversals$/);
      if (req.method === "POST" && revM) {
        if (sw.insufficient) return send(400, { error: { type: "invalid_request_error", code: "balance_insufficient", message: "Insufficient funds in the connected account." } });
        const t = transfers.find((x) => x.id === revM[1]);
        if (!t) return send(404, { error: { message: "No such transfer" } });
        const params = formParams(form);
        const rv = { id: `trr_stub_${reversals.length + 1}`, object: "transfer_reversal", transfer: t.id, amount: Number(params.amount) };
        reversals.push(rv); t.amount_reversed += rv.amount;
        return send(200, rv);
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
    ev = await mkEvent(hostT);
    r = await call("PATCH", `/api/events/${ev}`, { token: tok(hostT), body: { endsAt: inDays(10, 2) } });
    assert(r.status === 200, "event not started: earlier end ok", r);
  } finally {
    stub.close();
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
