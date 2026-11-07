/**
 * Charge helpers send Stripe the right payment method settings (app payment methods, Step 1 Task 2).
 *
 * Run with:
 *   JWT_SECRET=local_test_only STRIPE_SECRET_KEY=sk_test_stub_only STRIPE_PUBLISHABLE_KEY=pk_test_stub_only STRIPE_STUB_PORT=5182 EV_TEST_STRIPE_PORT=5182 \
 *   DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" npx tsx server/stripe/paymentMethodPolicy.stripe.http.test.ts
 *
 * SCRATCH ONLY. In-process calls against a local Stripe stub; no backend server, no database writes.
 * Skips (exit 0) when EV_TEST_STRIPE_PORT is unset. Nothing reaches real Stripe.
 */
import http from "http";

const STUB_PORT = Number(process.env.EV_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}

(async () => {
  if (!STUB_PORT) { console.log("⏭  skipped: set EV_TEST_STRIPE_PORT to run"); process.exit(0); }

  const posted: URLSearchParams[] = [];
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "POST" && req.url === "/v1/payment_intents") {
        posted.push(new URLSearchParams(raw));
        const id = `pi_stub_${posted.length}`;
        return res.end(JSON.stringify({ id, object: "payment_intent", client_secret: `${id}_secret`, status: "requires_payment_method" }));
      }
      res.end(JSON.stringify({ error: { message: `stub: no route ${req.method} ${req.url}` } }));
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));
  const last = () => posted[posted.length - 1];

  const { stripeService } = await import("./stripeService");
  const booking = {
    totalChargedCents: 2025, vendorPayoutCents: 1838, customerId: "cus_t", connectedAccountId: "acct_t",
    captureMethod: "automatic" as const, metadata: { type: "product_purchase", orderId: "o1" }, saveForFutureUse: true,
  };
  const platform = {
    amountCents: 2025, customerId: "cus_t", captureMethod: "automatic" as const,
    metadata: { type: "event_ticket", ticketOrderId: "t1" }, saveForFutureUse: true,
  };

  console.log("createBookingPaymentIntent");
  await stripeService.createBookingPaymentIntent(booking);
  assert(last().get("automatic_payment_methods[allow_redirects]") === "never", "default keeps allow_redirects never", Object.fromEntries(last()));
  const before = Object.fromEntries(last());
  await stripeService.createBookingPaymentIntent({ ...booking, redirectMethods: true });
  assert(last().get("automatic_payment_methods[enabled]") === "true", "switch on keeps automatic methods enabled");
  assert(!last().has("automatic_payment_methods[allow_redirects]"), "switch on sends no allow_redirects", Object.fromEntries(last()));
  const after = Object.fromEntries(last());
  delete before["automatic_payment_methods[allow_redirects]"];
  assert(JSON.stringify(before) === JSON.stringify(after), "nothing else changes (transfer, metadata, capture, setup_future_usage)", { before, after });
  await stripeService.createBookingPaymentIntent({ ...booking, redirectMethods: false });
  assert(last().get("automatic_payment_methods[allow_redirects]") === "never", "explicit false keeps never");

  console.log("createPlatformPaymentIntent");
  await stripeService.createPlatformPaymentIntent(platform);
  assert(last().get("automatic_payment_methods[allow_redirects]") === "never", "default keeps allow_redirects never", Object.fromEntries(last()));
  const pBefore = Object.fromEntries(last());
  await stripeService.createPlatformPaymentIntent({ ...platform, redirectMethods: true });
  assert(!last().has("automatic_payment_methods[allow_redirects]"), "switch on sends no allow_redirects", Object.fromEntries(last()));
  const pAfter = Object.fromEntries(last());
  delete pBefore["automatic_payment_methods[allow_redirects]"];
  assert(JSON.stringify(pBefore) === JSON.stringify(pAfter), "nothing else changes (metadata, capture, setup_future_usage)", { pBefore, pAfter });

  stub.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
