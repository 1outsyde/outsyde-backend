/**
 * Booking refund recovery Task 1: refund hook + bounded Stripe helpers on stripeService.
 *
 * Run with:
 *   JWT_SECRET=local_test_only STRIPE_SECRET_KEY=sk_test_stub_only STRIPE_STUB_PORT=5182 EV_TEST_STRIPE_PORT=5182 DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" npx tsx server/bookingRecoveries.stripe.http.test.ts
 *
 * SCRATCH ONLY. In-process calls against a local Stripe stub and local Postgres; no backend server. Skips (exit 0)
 * when EV_TEST_STRIPE_PORT is unset; refuses anything non-local. Nothing reaches real Stripe.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!STUB_PORT) { console.log("⏭  skipped: set EV_TEST_STRIPE_PORT (and STRIPE_STUB_PORT, STRIPE_SECRET_KEY) to run"); process.exit(0); }
  const stubPort = process.env.STRIPE_STUB_PORT;
  if (!stubPort || Number(stubPort) !== STUB_PORT) throw new Error("refusing to run: STRIPE_STUB_PORT must equal EV_TEST_STRIPE_PORT");
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_SECRET_KEY.startsWith("sk_test_")) throw new Error("refusing to run: STRIPE_SECRET_KEY must be a sk_test_ stub key");
  if (!isLocal(`http://127.0.0.1:${STUB_PORT}`)) throw new Error("refusing to run: stub must be local");
  if (!process.env.DATABASE_URL || !isLocal(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, "http:"))) throw new Error("refusing to run: DATABASE_URL must be local");
  process.env.STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_stub_only";

  type Rec = { method: string; path: string; query: URLSearchParams; form: Record<string, string>; idem: string | null };
  const recs: Rec[] = [];
  const START = 1792540800;
  let refundCreated = START + 100;
  let refundAmountOverride: number | null = null;
  let transferPages: any[][] = [];
  let transferPageIdx = 0;
  let reversalPages: any[][] = [];
  let reversalPageIdx = 0;
  let refundListPages: any[][] = [];
  let refundListIdx = 0;
  let nextRefund = "re_t1_a";

  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const form: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(body).entries()) form[k] = v;
      recs.push({ method: req.method || "", path: u.pathname, query: u.searchParams, form, idem: (req.headers["idempotency-key"] as string) ?? null });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      const meta = () => { const m: Record<string, string> = {}; for (const [k, v] of Object.entries(form)) { const x = k.match(/^metadata\[(.+)\]$/); if (x) m[x[1]] = v; } return m; };
      if (req.method === "GET" && u.pathname.startsWith("/v1/payment_intents/")) return send(200, { id: u.pathname.split("/").pop(), object: "payment_intent", status: "succeeded", amount_received: 10000, latest_charge: null });
      if (req.method === "POST" && u.pathname === "/v1/refunds") {
        return send(200, { id: nextRefund, object: "refund", payment_intent: form.payment_intent, amount: refundAmountOverride ?? Number(form.amount), status: "succeeded", created: refundCreated, metadata: meta() });
      }
      if (req.method === "GET" && u.pathname === "/v1/transfers") {
        const page = transferPages[transferPageIdx++] ?? [];
        return send(200, { object: "list", data: page, has_more: false, url: "/v1/transfers" });
      }
      if (req.method === "GET" && u.pathname === "/v1/refunds") {
        const page = refundListPages[refundListIdx++] ?? [];
        return send(200, { object: "list", data: page, has_more: false, url: "/v1/refunds" });
      }
      if (req.method === "GET" && /^\/v1\/transfers\/[^/]+\/reversals$/.test(u.pathname)) {
        const page = reversalPages[reversalPageIdx++] ?? [];
        return send(200, { object: "list", data: page, has_more: reversalPageIdx < reversalPages.length, url: u.pathname });
      }
      if (req.method === "POST" && /^\/v1\/transfers\/[^/]+\/reversals$/.test(u.pathname)) {
        return send(200, { id: "trr_new_1", object: "transfer_reversal", amount: Number(form.amount), metadata: meta() });
      }
      return send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${u.pathname}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const { sql } = await import("drizzle-orm");
  const { rows } = await import("./events/eventsRouter");
  const rowFor = async (id: string) => rows<any>(sql`SELECT * FROM booking_refund_recoveries WHERE refund_id = ${id}`);
  const waitRow = async (id: string, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const r = await rowFor(id); if (r.length) return r; await sleep(50); } return []; };

  try {
    await rows(sql`DELETE FROM booking_refund_recoveries WHERE refund_id LIKE 're_t1_%'`);
    const { stripeService } = await import("./stripe/stripeService");
    const svc: any = stripeService;
    const opts = { timeoutMs: 5000, maxNetworkRetries: 0 };

    console.log("recordBookingRefund");
    const br = await import("./bookingRecoveries");
    assert(br.RECOVERY_START_UNIX === 1792540800, "RECOVERY_START_UNIX value");
    await br.recordBookingRefund({ refundId: "re_t1_old", paymentIntentId: "pi_1", refundCents: 500, createdUnix: START - 1 });
    assert((await rowFor("re_t1_old")).length === 0, "refund before start date records nothing");
    await br.recordBookingRefund({ refundId: "re_t1_x", paymentIntentId: "pi_1", refundCents: 500, createdUnix: START });
    await br.recordBookingRefund({ refundId: "re_t1_x", paymentIntentId: "pi_1", refundCents: 999, createdUnix: START });
    const xr = await rowFor("re_t1_x");
    assert(xr.length === 1, "same refund twice is one row", xr.length);
    assert(xr[0]?.status === "pending" && xr[0]?.refund_cents === 500 && xr[0]?.payment_intent_id === "pi_1", "pending, first values kept", xr[0]);
    assert(xr[0]?.next_attempt_at !== null && xr[0]?.attempts === 0, "next_attempt_at set, attempts 0", xr[0]);
    assert(new Date(xr[0]?.refund_created_at).getTime() === START * 1000, "refund_created_at from created", xr[0]?.refund_created_at);

    console.log("createBookingRefund hook");
    recs.length = 0; nextRefund = "re_t1_a"; refundCreated = START + 100;
    const refund = await svc.createBookingRefund({ paymentIntentId: "pi_hook_1", amountCents: 1234, idempotencyKey: "k_hook_1" });
    assert(refund.id === "re_t1_a" && refund.amount === 1234 && refund.payment_intent === "pi_hook_1" && refund.status === "succeeded", "returns the Stripe refund object unchanged", refund);
    const post = recs.find((r) => r.method === "POST" && r.path === "/v1/refunds");
    assert(post?.form.amount === "1234" && post?.idem === "k_hook_1", "refund params and idempotency key unchanged", post);
    const ar = await waitRow("re_t1_a");
    assert(ar.length === 1 && ar[0].status === "pending" && ar[0].refund_cents === 1234 && ar[0].payment_intent_id === "pi_hook_1", "one pending row recorded", ar);
    await svc.createBookingRefund({ paymentIntentId: "pi_hook_1", amountCents: 1234, idempotencyKey: "k_hook_1" });
    await sleep(300);
    assert((await rowFor("re_t1_a")).length === 1, "a replayed refund (same id) stays one row");

    console.log("old refund is not recorded");
    nextRefund = "re_t1_oldhook"; refundCreated = START - 5;
    const old = await svc.createBookingRefund({ paymentIntentId: "pi_hook_2", amountCents: 100 });
    await sleep(400);
    assert(old.id === "re_t1_oldhook" && (await rowFor("re_t1_oldhook")).length === 0, "returned, no row");

    console.log("insert failure never breaks the refund");
    nextRefund = "re_t1_fail"; refundCreated = START + 5; refundAmountOverride = 3_000_000_000; // overflows integer: the insert fails
    const errs: string[] = [];
    const origErr = console.error; console.error = (...a: any[]) => { errs.push(a.map(String).join(" ")); };
    let failedRefund: any = null; let threw = false;
    try { failedRefund = await svc.createBookingRefund({ paymentIntentId: "pi_hook_3", amountCents: 100 }); } catch { threw = true; }
    await sleep(600);
    console.error = origErr; refundAmountOverride = null;
    assert(!threw && failedRefund?.id === "re_t1_fail" && failedRefund?.amount === 3_000_000_000, "refund still returned when the insert fails", { threw, failedRefund });
    assert((await rowFor("re_t1_fail")).length === 0, "no row");
    assert(errs.some((e) => e.includes("re_t1_fail")), "failure logged with the refund id", errs);

    console.log("listBookingTransfers");
    transferPages = [[{ id: "tr_1", amount: 900, amount_reversed: 100, destination: "acct_1", object: "transfer" }, { id: "tr_2", amount: 50, amount_reversed: 0, destination: "acct_2", object: "transfer" }]];
    transferPageIdx = 0; recs.length = 0;
    const trs = await svc.listBookingTransfers("ORDER_group_1", opts);
    const tg = recs.find((r) => r.path === "/v1/transfers");
    assert(tg?.query.get("transfer_group") === "ORDER_group_1" && tg?.query.get("limit") === "100", "transfer_group and limit sent", tg && [...tg.query.entries()]);
    assert(JSON.stringify(trs) === JSON.stringify([{ id: "tr_1", amount: 900, amountReversed: 100, destination: "acct_1" }, { id: "tr_2", amount: 50, amountReversed: 0, destination: "acct_2" }]), "fields mapped", trs);
    recs.length = 0; transferPageIdx = 0;
    await svc.listBookingTransfers("g", undefined);
    assert(recs.some((r) => r.path === "/v1/transfers"), "works with default bounds");

    console.log("listPaymentIntentRefunds");
    refundListPages = [[{ id: "re_a", amount: 300, created: 1792540900, status: "succeeded", object: "refund" }]]; refundListIdx = 0; recs.length = 0;
    const rl = await svc.listPaymentIntentRefunds("pi_x", opts);
    const rg = recs.find((r) => r.path === "/v1/refunds" && r.method === "GET");
    assert(rg?.query.get("payment_intent") === "pi_x" && rg?.query.get("limit") === "100", "payment_intent and limit sent", rg && [...rg.query.entries()]);
    assert(JSON.stringify(rl) === JSON.stringify([{ id: "re_a", amount: 300, created: 1792540900, status: "succeeded" }]), "fields mapped", rl);

    console.log("findRecoveryReversals");
    const rev = (id: string, refundId: string | null, amount: number) => ({ id, object: "transfer_reversal", amount, metadata: refundId ? { refundId } : {} });
    reversalPages = [[rev("trr_a", "re_1", 100), rev("trr_b", "re_2", 200)], [rev("trr_c", "re_1", 50), rev("trr_d", null, 9)]];
    reversalPageIdx = 0; recs.length = 0;
    const found = await svc.findRecoveryReversals("tr_1", "re_1", opts);
    assert(JSON.stringify(found) === JSON.stringify([{ id: "trr_a", amount: 100 }, { id: "trr_c", amount: 50 }]), "matches on metadata.refundId across pages", found);
    const rg2 = recs.filter((r) => /reversals$/.test(r.path));
    assert(rg2.length === 2 && rg2[0].query.get("limit") === "100" && rg2[1].query.get("starting_after") === "trr_b", "pages with starting_after", rg2.map((r) => [...r.query.entries()]));
    reversalPages = Array.from({ length: 14 }, (_, i) => [rev(`trr_p${i}`, "re_9", 1)]); reversalPageIdx = 0; recs.length = 0;
    let capErr: any = null; let capped: any = null;
    try { capped = await svc.findRecoveryReversals("tr_1", "re_9", opts); } catch (e) { capErr = e; }
    assert(recs.filter((r) => /reversals$/.test(r.path)).length === 10 && capErr instanceof Error && capped === null, "throws after 10 pages (never a partial list)", { calls: recs.length, capped, err: String(capErr) });
    assert(/tr_1/.test(String(capErr?.message)) && /re_9/.test(String(capErr?.message)), "error names the transfer and the refund", String(capErr?.message));
    reversalPages = Array.from({ length: 10 }, (_, i) => [rev(`trr_q${i}`, "re_8", 1)]); reversalPageIdx = 0; recs.length = 0;
    const ten = await svc.findRecoveryReversals("tr_1", "re_8", opts);
    assert(recs.filter((r) => /reversals$/.test(r.path)).length === 10 && ten.length === 10, "exactly 10 pages: full list returned", { calls: recs.length, n: ten.length });

    console.log("reverseForRecovery");
    recs.length = 0;
    const rv = await svc.reverseForRecovery({ transferId: "tr_1", amountCents: 321, refundId: "re_1", bookingType: "appointment", bookingId: "appt_1", idempotencyKey: "booking_recovery_re_1_try1", ...opts });
    const rp = recs.find((r) => r.method === "POST" && r.path === "/v1/transfers/tr_1/reversals");
    assert(rp?.form.amount === "321", "amount", rp?.form);
    assert(rp?.form["metadata[type]"] === "booking_refund_recovery" && rp?.form["metadata[refundId]"] === "re_1" && rp?.form["metadata[bookingType]"] === "appointment" && rp?.form["metadata[bookingId]"] === "appt_1", "metadata", rp?.form);
    assert(rp?.idem === "booking_recovery_re_1_try1", "Idempotency-Key equals key passed", rp?.idem);
    assert(rv.id === "trr_new_1", "returns id", rv);

    console.log("getPaymentIntentAmountReceived");
    recs.length = 0;
    const got = await svc.getPaymentIntentAmountReceived("pi_amt", opts);
    assert(got === 10000, "amount_received", got);
    assert(recs.some((r) => r.path === "/v1/payment_intents/pi_amt"), "retrieves the payment intent");
  } finally {
    await rows(sql`DELETE FROM booking_refund_recoveries WHERE refund_id LIKE 're_t1_%'`).catch(() => {});
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
