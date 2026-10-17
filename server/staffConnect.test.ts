/**
 * Staff Stripe Connect account tests. Run with:
 *   DATABASE_URL=postgresql://x:x@localhost:5432/x STRIPE_SECRET_KEY=sk_test_stub STRIPE_PUBLISHABLE_KEY=pk_test_stub \
 *   STRIPE_STUB_PORT=4599 NODE_OPTIONS="--import ./.dev/stripe-stub-preload.mjs" npx tsx server/staffConnect.test.ts
 *
 * Runs the real stripeService code against a local Stripe stub (this file starts it on STRIPE_STUB_PORT),
 * so nothing reaches api.stripe.com and no database is touched (DATABASE_URL is only needed because
 * db.ts throws on import). Refuses to run without STRIPE_STUB_PORT.
 *
 * Covers the 2026-10-17 Render errors:
 *  - staff accounts must request card_payments + transfers (live rejected transfers-only)
 *  - "account that is not connected to your platform or does not exist" is recognised as an
 *    unreachable saved account; other Stripe errors are not.
 */
import http from "http";

const PORT = Number(process.env.STRIPE_STUB_PORT);
if (!PORT) {
  console.error("STRIPE_STUB_PORT is not set; refusing to run (would call real Stripe).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

type Seen = { method: string; path: string; body: string };
const seen: Seen[] = [];
let nextLinkError: { status: number; error: Record<string, unknown> } | null = null;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/accounts" && req.method === "POST") {
      res.end(JSON.stringify({ id: "acct_stub_new", object: "account" }));
      return;
    }
    if (req.url === "/v1/account_links" && req.method === "POST") {
      if (nextLinkError) {
        const e = nextLinkError;
        nextLinkError = null;
        res.statusCode = e.status;
        res.end(JSON.stringify({ error: e.error }));
        return;
      }
      res.end(JSON.stringify({ object: "account_link", url: "https://connect.stripe.com/setup/e/stub" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "stub: unknown route" } }));
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
  const { stripeService, isUnreachableConnectAccountError } = await import("./stripe/stripeService");

  console.log("createStaffConnectAccount");
  const acct = await stripeService.createStaffConnectAccount("staff@example.com", "staff_1", "biz_1", "Test Staff");
  const create = seen.find((s) => s.path === "/v1/accounts");
  const params = new URLSearchParams(create?.body ?? "");
  check("returns the created account", acct.id === "acct_stub_new", acct);
  check("requests card_payments", params.get("capabilities[card_payments][requested]") === "true", create?.body);
  check("requests transfers", params.get("capabilities[transfers][requested]") === "true", create?.body);
  check("keeps express + individual", params.get("type") === "express" && params.get("business_type") === "individual");
  check("keeps metadata role=staff (webhook staff branch)", params.get("metadata[role]") === "staff");
  check("keeps metadata staffId/businessId", params.get("metadata[staffId]") === "staff_1" && params.get("metadata[businessId]") === "biz_1");

  console.log("isUnreachableConnectAccountError");
  async function linkErrorFor(error: Record<string, unknown>, status = 400): Promise<unknown> {
    nextLinkError = { status, error };
    try {
      await stripeService.createConnectOnboardingLink("acct_old", "https://x.test/r", "https://x.test/ret");
      return null;
    } catch (e) {
      return e;
    }
  }
  const dead = await linkErrorFor({
    type: "invalid_request_error",
    message:
      "You requested an account link for an account that is not connected to your platform or does not exist.",
  });
  check("real stripe-node error for the Render message → true", isUnreachableConnectAccountError(dead) === true, dead);

  const coded = await linkErrorFor({ type: "invalid_request_error", code: "account_invalid", message: "x" });
  check("code account_invalid → true", isUnreachableConnectAccountError(coded) === true);

  const capability = await linkErrorFor({
    type: "invalid_request_error",
    message:
      "Your platform needs approval for accounts to have requested the `transfers` capability without the `card_payments` capability.",
  });
  check("capability approval error → false (must not loop recreating)", isUnreachableConnectAccountError(capability) === false);

  const auth = await linkErrorFor({ type: "invalid_request_error", message: "Invalid API Key provided" }, 401);
  check("auth error → false", isUnreachableConnectAccountError(auth) === false);

  const server500 = await linkErrorFor({ type: "api_error", message: "not connected to your platform or does not exist" }, 500);
  check("non invalid-request error with same words → false", isUnreachableConnectAccountError(server500) === false);

  check("null / plain Error → false", !isUnreachableConnectAccountError(null) && !isUnreachableConnectAccountError(new Error("x")));

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
