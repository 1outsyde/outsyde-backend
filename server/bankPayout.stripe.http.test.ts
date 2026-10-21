/**
 * Daily bank payout (PR 5b) Task 2: bounded Stripe payout helpers on stripeService.
 *
 * Run with:
 *   STRIPE_SECRET_KEY=sk_test_stub_only STRIPE_STUB_PORT=5181 EV_TEST_STRIPE_PORT=5181 DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" npx tsx server/bankPayout.stripe.http.test.ts
 *
 * SCRATCH ONLY. In-process calls against a local Stripe stub; no backend server. Skips (exit 0) when
 * EV_TEST_STRIPE_PORT is unset; refuses anything non-local. Nothing reaches real Stripe.
 */
import http from "http";

const STUB_PORT = Number(process.env.EV_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

(async () => {
  if (!STUB_PORT) { console.log("⏭  skipped: set EV_TEST_STRIPE_PORT (and STRIPE_STUB_PORT, STRIPE_SECRET_KEY) to run"); process.exit(0); }
  const stubPort = process.env.STRIPE_STUB_PORT;
  if (!stubPort || Number(stubPort) !== STUB_PORT) throw new Error("refusing to run: STRIPE_STUB_PORT must equal EV_TEST_STRIPE_PORT (the stub preload routes Stripe calls there)");
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_SECRET_KEY.startsWith("sk_test_")) throw new Error("refusing to run: STRIPE_SECRET_KEY must be a sk_test_ stub key");
  if (!isLocal(`http://127.0.0.1:${STUB_PORT}`)) throw new Error("refusing to run: stub must be local");
  process.env.STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_stub_only";

  type Rec = { method: string; path: string; query: URLSearchParams; form: Record<string, string>; idem: string | null };
  const recs: Rec[] = [];
  let interval: string | null = "daily";
  let balanceAvailable: Array<{ amount: number; currency: string }> = [{ amount: 5000, currency: "usd" }, { amount: 300, currency: "cad" }];
  let payoutPages: any[][] = [];
  let payoutPageIdx = 0;
  let retrieved: any = { id: "po_1", status: "failed", failure_code: "account_closed" };

  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const form: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(body).entries()) form[k] = v;
      recs.push({ method: req.method || "", path: u.pathname, query: u.searchParams, form, idem: (req.headers["idempotency-key"] as string) ?? null });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.method === "GET" && u.pathname === "/v1/account") return send(200, { id: "acct_platform", object: "account", settings: { payouts: { schedule: interval ? { interval } : undefined } } });
      if (req.method === "GET" && u.pathname === "/v1/balance") return send(200, { object: "balance", available: balanceAvailable, pending: [] });
      if (req.method === "GET" && u.pathname === "/v1/payouts") {
        const page = payoutPages[payoutPageIdx++] ?? [];
        return send(200, { object: "list", data: page, has_more: payoutPageIdx < payoutPages.length, url: "/v1/payouts" });
      }
      if (req.method === "POST" && u.pathname === "/v1/payouts") {
        const metadata: Record<string, string> = {};
        for (const [k, v] of Object.entries(form)) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        return send(200, { id: "po_new_1", object: "payout", status: "pending", amount: Number(form.amount), metadata });
      }
      if (req.method === "GET" && u.pathname === "/v1/payouts/po_1") return send(200, retrieved);
      return send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${u.pathname}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  try {
    const { stripeService } = await import("./stripe/stripeService");
    const svc: any = stripeService;
    const opts = { timeoutMs: 5000, maxNetworkRetries: 0 };

    console.log("create sends the exact params");
    recs.length = 0;
    const created = await svc.createPlatformPayout({ amountCents: 12345, payoutDate: "2026-10-21", rowId: "row-abc", idempotencyKey: "bank_payout_row-abc_try1", ...opts });
    const post = recs.find((r) => r.method === "POST" && r.path === "/v1/payouts");
    assert(!!post, "POST /v1/payouts sent");
    assert(post?.form.amount === "12345", "amount", post?.form);
    assert(post?.form.currency === "usd", "currency=usd");
    assert(post?.form.method === "standard", "method=standard");
    assert(post?.form.statement_descriptor === "OUTSYDE", "statement_descriptor=OUTSYDE");
    assert(post?.form.description === "Outsyde daily payout 2026-10-21", "description", post?.form.description);
    assert(post?.form["metadata[type]"] === "outsyde_bank_payout", "metadata[type]");
    assert(post?.form["metadata[payoutDate]"] === "2026-10-21", "metadata[payoutDate]");
    assert(post?.form["metadata[rowId]"] === "row-abc", "metadata[rowId]");
    assert(post?.idem === "bank_payout_row-abc_try1", "Idempotency-Key header equals key passed", post?.idem);
    assert(created.id === "po_new_1" && created.status === "pending", "returns id and status", created);
    // defaults when opts missing
    recs.length = 0;
    await svc.createPlatformPayout({ amountCents: 100, payoutDate: "2026-10-21", rowId: "r2", idempotencyKey: "k2" });
    assert(recs.some((r) => r.method === "POST" && r.idem === "k2"), "create works with default bounds");

    console.log("interval read from /v1/account");
    recs.length = 0;
    const iv = await svc.getPlatformPayoutInterval(opts);
    assert(iv === "daily", "interval daily", iv);
    assert(recs.length === 1 && recs[0].path === "/v1/account", "called GET /v1/account (no id)", recs.map((r) => r.path));
    interval = null;
    assert((await svc.getPlatformPayoutInterval(opts)) === null, "missing schedule gives null");

    console.log("usd only, other currencies listed");
    const bal = await svc.getAvailableUsdBalance(opts);
    assert(bal.usdCents === 5000, "usdCents 5000", bal);
    assert(JSON.stringify(bal.otherCurrencies) === JSON.stringify(["cad"]), "otherCurrencies [cad]", bal);
    balanceAvailable = [{ amount: 700, currency: "usd" }, { amount: 0, currency: "eur" }, { amount: 5, currency: "usd" }];
    const bal2 = await svc.getAvailableUsdBalance(opts);
    assert(bal2.usdCents === 705 && bal2.otherCurrencies.length === 0, "sums usd, ignores zero other currencies", bal2);

    console.log("list pages until has_more false");
    const mk = (id: string) => ({ id, object: "payout", amount: 100, status: "paid", created: 1760000000, metadata: { type: "outsyde_bank_payout" } });
    payoutPages = [[mk("po_a"), mk("po_b")], [mk("po_c")]];
    payoutPageIdx = 0; recs.length = 0;
    const listed = await svc.listPlatformPayoutsCreatedSince(1759900000, opts);
    assert(listed.map((p: any) => p.id).join() === "po_a,po_b,po_c", "3 payouts across 2 pages", listed);
    const gets = recs.filter((r) => r.path === "/v1/payouts");
    assert(gets.length === 2, "two page calls", gets.length);
    assert(gets[0].query.get("created[gte]") === "1759900000" && gets[0].query.get("limit") === "100", "created[gte] and limit sent", [...gets[0].query.entries()]);
    assert(gets[1].query.get("starting_after") === "po_b", "second page starts after last id", [...gets[1].query.entries()]);
    assert(listed[0].metadata.type === "outsyde_bank_payout" && listed[0].amount === 100 && listed[0].status === "paid" && listed[0].created === 1760000000, "fields mapped", listed[0]);
    // cap at 5 pages
    payoutPages = Array.from({ length: 8 }, (_, i) => [mk(`po_p${i}`)]);
    payoutPageIdx = 0; recs.length = 0;
    const capped = await svc.listPlatformPayoutsCreatedSince(1, opts);
    assert(recs.filter((r) => r.path === "/v1/payouts").length === 5 && capped.length === 5, "stops after 5 pages", { calls: recs.length, n: capped.length });

    console.log("retrieve maps failure_code");
    const r1 = await svc.retrievePlatformPayout("po_1", opts);
    assert(r1.id === "po_1" && r1.status === "failed" && r1.failureCode === "account_closed", "failed payout mapped", r1);
    retrieved = { id: "po_1", status: "paid", failure_code: null };
    const r2 = await svc.retrievePlatformPayout("po_1", opts);
    assert(r2.status === "paid" && r2.failureCode === null, "paid payout has null failureCode", r2);
  } finally {
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
