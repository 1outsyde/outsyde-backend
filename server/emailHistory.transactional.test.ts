/**
 * PR C2: transactional email history. Run with:
 *   DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/emailHistory.transactional.test.ts
 * (plus `node .dev/neon-local-proxy.mjs` running). LOCAL scratch database only, migration 043 applied.
 * Runs its own Resend stub, so no email leaves the machine. Seeds rows with ids starting "c2test-"
 * and deletes them at the end.
 *
 * Checks: emails to customers, vendors, photographers and staff write one email_log row with the
 * right kind, label and account; nothing personal is stored; failures still throw / return exactly
 * as before and are logged as failed; internal alerts and the support form are never logged; the
 * admin daily budget ignores these rows; Resend usage is read and cached, and hidden on errors.
 */
import http from "http";
import type { AddressInfo } from "net";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dbUrl = process.env.DATABASE_URL || "";
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(dbUrl)) {
    console.error("Refusing to run: DATABASE_URL must point at a local database.");
    process.exit(1);
  }

  // Resend stub: POST /emails → id, or a Resend error for addresses containing "+fail";
  // GET /usage → daily usage (403 while `usageForbidden` is set).
  const sent: { to: string; subject: string }[] = [];
  let usageForbidden = false;
  let usageCalls = 0;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/usage") {
        usageCalls++;
        if (usageForbidden) { res.statusCode = 403; return res.end(JSON.stringify({ message: "restricted_api_key" })); }
        return res.end(JSON.stringify({ emails: { daily: { used: 7, limit: 100, sent: 7, received: 0, resets_at: "2026-10-16T23:59:59.999Z" } } }));
      }
      const j = body ? JSON.parse(body) : {};
      const to = Array.isArray(j.to) ? j.to[0] : j.to;
      if (String(to).includes("+fail")) {
        res.statusCode = 422;
        return res.end(JSON.stringify({ name: "validation_error", message: `Invalid recipient ${to}`, statusCode: 422 }));
      }
      sent.push({ to, subject: j.subject });
      res.end(JSON.stringify({ id: `re_stub_${sent.length}` }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const port = (stub.address() as AddressInfo).port;
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_BASE_URL = `http://127.0.0.1:${port}`;

  const { db } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const H = await import("./emailHistory");
  const E = await import("./emailService");
  const R = await import("./services/resendService");

  const rows = async (where = sql`true`) =>
    (await db.execute(sql`SELECT user_id, kind, label, status, error, resend_id, send_id FROM email_log WHERE created_at > now() - interval '10 minutes' AND ${where} ORDER BY created_at, id`)).rows as any[];
  const waitForRows = async (n: number, where = sql`true`) => {
    for (let i = 0; i < 40; i++) { const r = await rows(where); if (r.length >= n) return r; await sleep(50); }
    return rows(where);
  };
  const cleanup = async () => {
    await db.execute(sql`DELETE FROM email_log WHERE user_id LIKE 'c2test-%' OR label IN ('Order shipped','Booking confirmation','New booking (vendor)','Business approved','Staff invite','Staff member joined (owner)','Deposit booking confirmation','Order delivered','Account deletion scheduled') AND created_at > now() - interval '10 minutes'`);
    await db.execute(sql`DELETE FROM users WHERE id LIKE 'c2test-%'`);
  };

  try {
    await cleanup();
    await db.execute(sql`INSERT INTO users (id, email, name) VALUES
      ('c2test-cust', 'C2.Customer@Example.test', 'C2 Customer'),
      ('c2test-vendor', 'c2vendor@example.test', NULL)`);
    const budgetBefore = (await H.getBudget()).sentToday;

    console.log("\n── helpers");
    assert(H.scrubError(new Error("Invalid recipient a.b+x@site.co.uk, try again")) === "Invalid recipient [address], try again", "scrubError hides addresses");
    assert(await H.findUserIdByEmail("c2.customer@example.TEST") === "c2test-cust", "account found ignoring case");
    assert(await H.findUserIdByEmail("nobody@example.test") === null, "no account → null");

    console.log("\n── customer email (sendBrandedEmail path)");
    await E.sendOrderShippedEmail({ toEmail: "c2.customer@example.test", consumerName: "C2", vendorName: "Glow", productName: "Oil", orderId: "ord_c2", orderNumber: 7, carrier: "UPS", trackingNumber: "1Z", trackingUrl: "https://example.test/t" });
    let r = await waitForRows(1, sql`label = 'Order shipped'`);
    assert(r.length === 1, "one row for the order shipped email", r);
    assert(r[0]?.user_id === "c2test-cust" && r[0]?.kind === "order" && r[0]?.status === "sent", "row has the account, kind order, sent", r[0]);
    assert(r[0]?.resend_id === `re_stub_${sent.length}` && r[0]?.send_id === null, "Resend id kept, no send id", r[0]);
    assert(!JSON.stringify(r[0]).includes("@"), "row holds no email address", r[0]);

    console.log("\n── failure keeps the old behaviour");
    let threw: unknown = null;
    try {
      await E.sendAppointmentConfirmationToConsumer({ toEmail: "c2.customer+fail@example.test", consumerName: "C2", serviceName: "Braids", vendorName: "Glow", bookingId: "b_c2", bookingNumber: 12, date: "Oct 20", time: "10:00", basePrice: 100 });
    } catch (e) { threw = e; }
    assert(threw instanceof Error && /^Resend error: /.test((threw as Error).message), "still throws \"Resend error: …\" exactly as before", String(threw));
    r = await waitForRows(1, sql`label = 'Booking confirmation'`);
    assert(r.length === 1 && r[0].status === "failed" && r[0].user_id === null, "failed row, no account matched for the +fail address", r);
    assert(typeof r[0]?.error === "string" && r[0].error.includes("[address]") && !r[0].error.includes("@"), "error saved without the address", r[0]?.error);

    console.log("\n── no account: logged without a person");
    await E.sendAppointmentNotificationToVendor({ toEmail: "walkin@example.test", vendorName: "Glow", consumerName: "C2", serviceName: "Braids", bookingId: "b_c2", bookingNumber: 12, date: "Oct 20", time: "10:00", basePrice: 100 });
    r = await waitForRows(1, sql`label = 'New booking (vendor)'`);
    assert(r.length === 1 && r[0].user_id === null && r[0].kind === "booking" && r[0].status === "sent", "row kept with no account", r[0]);

    console.log("\n── internal alerts are never logged");
    const before = (await rows()).length;
    await E.sendInternalEventAlert({ eventType: "product_order", bookingOrOrderId: "ord_1", consumerName: "C2", consumerEmail: "c2.customer@example.test", vendorName: "Glow", vendorEmail: "c2vendor@example.test" } as any);
    await E.sendNewConsumerSignupEmail({ adminEmail: "info@goutsyde.com", userName: "C2", userEmail: "c2.customer@example.test", username: "c2", userId: "c2test-cust" });
    await sleep(400);
    assert((await rows()).length === before, "sale alert and signup alert wrote nothing", (await rows()).length - before);

    console.log("\n── sendAdminEmail path keeps returning a boolean");
    const ok = await E.sendVendorApprovalEmail({ ownerEmail: "C2VENDOR@example.test", ownerName: "", businessName: "Glow", stripeOnboardingUrl: null });
    assert(ok === true, "approval returns true");
    r = await waitForRows(1, sql`label = 'Business approved'`);
    assert(r.length === 1 && r[0].user_id === "c2test-vendor" && r[0].kind === "account", "approval logged under the vendor (case insensitive)", r[0]);
    const bad = await E.sendVendorRejectionEmail({ ownerEmail: "x+fail@example.test", ownerName: "", businessName: "Glow", rejectionReason: "test" });
    assert(bad === false, "rejection with a Resend error still returns false");

    console.log("\n── direct deposit send");
    await E.sendBookingConfirmationToCustomer({ toEmail: "c2.customer@example.test", customerName: "C2", serviceName: "Braids", date: "Oct 20", time: "10:00", appointmentId: "a_c2" });
    r = await waitForRows(1, sql`label = 'Deposit booking confirmation'`);
    assert(r.length === 1 && r[0].user_id === "c2test-cust", "deposit confirmation logged", r[0]);

    console.log("\n── staff emails: logged, support form not");
    const inv = await R.sendStaffInviteEmail("newstaff@example.test", "Glow", "ABC123", "stylist");
    assert(inv.sent === true, "invite still returns { sent: true }", inv);
    const inv2 = await R.sendStaffInviteEmail("x+fail@example.test", "Glow", "ABC123", "stylist");
    assert(inv2.sent === false && typeof inv2.error === "string", "failed invite still returns { sent: false, error }", inv2);
    r = await waitForRows(2, sql`label = 'Staff invite'`);
    assert(r.length === 2 && r.map((x) => x.status).sort().join() === "failed,sent", "both invites logged (sent + failed)", r);
    const beforeSupport = (await rows()).length;
    await R.sendSupportContactEmail({ name: "C2", email: "c2.customer@example.test", userId: "c2test-cust", message: "hi" });
    await sleep(400);
    assert((await rows()).length === beforeSupport, "support contact email not logged");

    console.log("\n── budget and Resend usage");
    assert((await H.getBudget()).sentToday === budgetBefore, "admin daily count unchanged by these emails", { before: budgetBefore, after: (await H.getBudget()).sentToday });
    const u1 = await H.getResendUsage(1_000_000);
    assert(u1?.used === 7 && u1?.limit === 100 && u1?.resetsAt === "2026-10-16T23:59:59.999Z", "usage read from Resend", u1);
    const calls = usageCalls;
    await H.getResendUsage(1_030_000);
    assert(usageCalls === calls, "cached for a minute");
    usageForbidden = true;
    assert(await H.getResendUsage(1_200_000) === null, "a key without usage access → null (line hidden)");
  } finally {
    await cleanup();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
