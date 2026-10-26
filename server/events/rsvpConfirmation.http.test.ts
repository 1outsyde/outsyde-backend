/**
 * Free RSVP confirmation email (2026-10-23): after a free RSVP the guest gets the "Your RSVP is confirmed"
 * email with one QR image per ticket, the same email paid buyers get minus the money lines.
 *
 * Run with: npx tsx server/events/rsvpConfirmation.http.test.ts
 *
 * SCRATCH ONLY. Backend booted on localhost against a local scratch Postgres (migrations through 068),
 * DATABASE_URL + neon preload for the in-process calls:
 *   EV_TEST_BASE_URL, EV_TEST_PG_URL, JWT_SECRET (same as the server)
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host. Notices sent from this
 * process go to recording fakes; the server has no Resend key, so nothing reaches real email.
 *
 * Mutation notes:
 *  - drop the `total_cents === 0` check in notifyRsvpConfirmed → "paid order gets no RSVP email" fails.
 *  - drop the event_status check → "cancelled event gets no RSVP email" fails.
 *  - drop the qrUrls → "one QR per ticket" fails.
 *  - remove the call in ticketsRouter → "RSVP route sends the confirmation" fails.
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, p: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(p, BASE!);
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

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  process.env.ALLOW_TEST_SEAMS = "1";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const notices: Array<{ kind: string; p: any }> = [];
  const tn = await import("./ticketNotices");
  tn.setNoticeDepsForTest({
    sendReceipt: async (p) => { notices.push({ kind: "receipt", p }); },
    sendRefund: async (p) => { notices.push({ kind: "refund", p }); },
    sendCancelled: async (p) => { notices.push({ kind: "cancelled", p }); },
    sendAddressReveal: async () => {},
    sendPush: async (p) => { notices.push({ kind: "push", p }); return true; },
  });
  tn.setQrBuilderForTest((id) => `https://api.example.test/api/events/qr/${id}.png`);

  const P = `rc${Date.now().toString(36)}`;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
    [`${P}-${s}@test.local`, `Disp ${s}`, `First${s}`, `${P}${s}`.slice(0, 24)],
  ))[0].id as string;
  const host = await mkUser("host");
  const guest = await mkUser("guest");
  // Every host needs payouts set up to publish (2026-10-26); this suite tests other rules, so its hosts have it.
  await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [host, `acct_${P}_host`]);
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });
  // Publishing needs the current Event Host Agreement accepted (hostAgreement.ts): hosts accept it the way the app does.
  const acceptAgreement = async (id: string) => {
    const g = await call("GET", "/api/events/host-agreement", { token: tok(id) });
    const a = await call("POST", "/api/events/host-agreement/accept", { token: tok(id), body: { version: g.body?.agreement?.version } });
    if (a.status !== 200) throw new Error("agreement accept failed " + JSON.stringify(a));
  };
  const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86400000 + h * 3600000).toISOString();
  const eventIds: string[] = [];

  try {
    await acceptAgreement(host);
    console.log("Setup: a published free event with a 2-per-order RSVP");
    let r = await call("POST", "/api/events", { token: tok(host), body: {
      title: `${P} Free Night`, startsAt: inDays(5), endsAt: inDays(5, 4), timezone: "America/New_York",
      city: "Freeport", state: "NY", addressLine1: "1 Main St", addressVisibility: "ticket_holders",
    } });
    assert(r.status === 201, "event created", r);
    const ev = r.body.event; eventIds.push(ev.id);
    r = await call("POST", `/api/events/${ev.id}/ticket-types`, { token: tok(host), body: { name: "Free RSVP", priceCents: 0, quantity: 50, maxPerOrder: 2, perAccountLimit: 2 } });
    assert(r.status === 201, "free type created", r);
    const ft = r.body.ticketType;
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 200, "published", r);

    console.log("RSVP through the route");
    r = await call("POST", `/api/events/${ev.id}/rsvp`, { token: tok(guest), body: { ticketTypeId: ft.id, quantity: 2, idempotencyKey: `${P}-k1-abcdef` } });
    assert(r.status === 201 && r.body.order.tickets.length === 2, "RSVP for 2 is created", r);
    const order = r.body.order;

    console.log("notifyRsvpConfirmed");
    notices.length = 0;
    await tn.notifyRsvpConfirmed(order.id);
    const receipts = notices.filter((n) => n.kind === "receipt");
    assert(receipts.length === 1, "exactly one confirmation email", notices);
    const p = receipts[0]?.p ?? {};
    assert(p.toEmail === `${P}-guest@test.local`, "sent to the guest", p.toEmail);
    assert(p.totalCents === 0 && p.ticketPriceCents === 0 && p.serviceFeeCents === 0, "free: no money", p);
    assert(p.quantity === 2 && p.ticketTypeName === "Free RSVP", "quantity and ticket type", p);
    const codes = order.tickets.map((t: any) => t.code).sort();
    assert(JSON.stringify([...(p.codes ?? [])].sort()) === JSON.stringify(codes), "ticket codes in the email", { got: p.codes, codes });
    assert(Array.isArray(p.qrUrls) && p.qrUrls.length === 2 && p.qrUrls.every((u: string) => u.startsWith("https://api.example.test/api/events/qr/")), "one QR per ticket", p.qrUrls);
    assert(p.event?.title === `${P} Free Night` && p.event?.whereText === "1 Main St, Freeport, NY", "event title, and the full address for a ticket holder (ticket_holders event)", p.event);
    assert(!notices.some((n) => n.kind === "push"), "no host push for a free RSVP");

    console.log("Day-of address event: city and state only before the reveal");
    r = await call("POST", "/api/events", { token: tok(host), body: {
      title: `${P} Day Of`, startsAt: inDays(6), endsAt: inDays(6, 4), timezone: "America/New_York",
      city: "Freeport", state: "NY", addressLine1: "9 Secret Rd", addressVisibility: "ticket_holders_day_of",
    } });
    const ev2 = r.body.event; eventIds.push(ev2.id);
    r = await call("POST", `/api/events/${ev2.id}/ticket-types`, { token: tok(host), body: { name: "Free", priceCents: 0, quantity: 10 } });
    const ft2 = r.body.ticketType;
    await call("POST", `/api/events/${ev2.id}/publish`, { token: tok(host) });
    r = await call("POST", `/api/events/${ev2.id}/rsvp`, { token: tok(guest), body: { ticketTypeId: ft2.id, quantity: 1, idempotencyKey: `${P}-k2-abcdef` } });
    assert(r.status === 201, "day-of RSVP created", r);
    notices.length = 0;
    await tn.notifyRsvpConfirmed(r.body.order.id);
    const p2 = notices.find((n) => n.kind === "receipt")?.p;
    assert(p2?.event?.whereText === "Freeport, NY" && !JSON.stringify(p2).includes("9 Secret Rd"), "day-of: city and state only, street never in the email", p2?.event);

    console.log("The email itself");
    const em = await import("../emailService");
    const out = em.renderTicketReceipt(p);
    assert(out.subject === `RSVP confirmed: ${P} Free Night`, "subject", out.subject);
    assert(out.html.includes("Your RSVP is confirmed") && !out.html.includes("Service fee") && !out.html.includes("Total charged"), "RSVP wording, no money lines");
    assert((out.html.match(/<img src="https:\/\/api\.example\.test\/api\/events\/qr\//g) ?? []).length === 2, "two QR images in the html");
    assert(!/[–—]| - /.test(out.html.replace(/<[^>]+>/g, " ")), "no dashes in the copy");

    console.log("Daily email budget");
    notices.length = 0;
    await tn.notifyRsvpConfirmed(order.id, { emailCeiling: 0 });
    assert(notices.length === 0, "budget used up: no email, no throw", notices);
    const [{ n: todayCount }] = await q(`SELECT count(*)::int AS n FROM email_log WHERE created_at >= now() - interval '1 day'`);
    await tn.notifyRsvpConfirmed(order.id, { emailCeiling: Number(todayCount) + 1 });
    assert(notices.filter((x) => x.kind === "receipt").length === 1, "under the budget: the email goes", notices.length);
    assert(tn.RSVP_EMAIL_DAILY_CEILING === 60, "default ceiling is 60 (below the reveal job's 70)", tn.RSVP_EMAIL_DAILY_CEILING);

    console.log("Failures never break anything");
    notices.length = 0;
    tn.setQrBuilderForTest(() => { throw new Error("qr down"); });
    await tn.notifyRsvpConfirmed(order.id);
    const noQr = notices.find((x) => x.kind === "receipt")?.p;
    assert(!!noQr && noQr.qrUrls === undefined && noQr.codes.length === 2, "QR failure: email still goes, codes only", noQr);
    tn.setQrBuilderForTest((id) => `https://api.example.test/api/events/qr/${id}.png`);
    tn.setNoticeDepsForTest({
      sendReceipt: async () => { throw new Error("resend down"); },
      sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
      sendPush: async () => true,
    });
    let threw = false;
    try { await tn.notifyRsvpConfirmed(order.id); } catch { threw = true; }
    assert(!threw, "a failing sender never throws");
    tn.setNoticeDepsForTest({
      sendReceipt: async (p) => { notices.push({ kind: "receipt", p }); },
      sendRefund: async (p) => { notices.push({ kind: "refund", p }); },
      sendCancelled: async (p) => { notices.push({ kind: "cancelled", p }); },
      sendAddressReveal: async () => {},
      sendPush: async (p) => { notices.push({ kind: "push", p }); return true; },
    });

    console.log("When it must not send");
    notices.length = 0;
    await q(`UPDATE ticket_orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [order.id]).catch((e) => console.error(e.message));
    await tn.notifyRsvpConfirmed(order.id);
    assert(notices.length === 0, "cancelled RSVP (not completed): no email", notices);
    await q(`UPDATE ticket_orders SET status = 'completed', cancelled_at = NULL WHERE id = $1`, [order.id]);
    notices.length = 0;
    await tn.notifyRsvpConfirmed("00000000-0000-4000-8000-000000000000");
    assert(notices.length === 0, "unknown order: nothing sent, no throw");
    const [paid] = await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents, total_cents)
       VALUES ($1, $2, 'completed', 1, 2000, 160, 99, 40, 1960, 2259) RETURNING id`, [ev.id, guest]).catch((e) => { console.error(e.message); return [] as any[]; });
    if (paid) {
      // Give it a real ticket so only the price rule can stop the email.
      const [it] = await q(`INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
        VALUES ($1, $2, $3, $4, 1, 2000, 'issued', now()) RETURNING id`, [paid.id, ev.id, ft.id, guest]);
      await q(`INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, price_cents)
        VALUES ($1, $2, $3, $4, $5, 1, $6, 0)`, [paid.id, it.id, ev.id, ft.id, guest, `PAID${Date.now().toString(36).toUpperCase()}`.slice(0, 16).padEnd(16, "Z")]);
      await tn.notifyRsvpConfirmed(paid.id);
      assert(notices.length === 0, "paid order gets no RSVP email (it has its own receipt)", notices);
    } else {
      assert(false, "could seed a paid order for the negative case");
    }
    await q(`UPDATE events SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [ev.id]);
    await tn.notifyRsvpConfirmed(order.id);
    assert(notices.length === 0, "cancelled event gets no RSVP email", notices);

    console.log("Route wiring");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "ticketsRouter.ts"), "utf8");
    const rsvpBlock = src.slice(src.indexOf('router.post("/:id/rsvp"'), src.indexOf('router.post("/orders/:orderId/cancel"'));
    assert(/if \(r\?\.order_id\) \{[\s\S]{0,200}notifyRsvpConfirmed\(/.test(rsvpBlock), "RSVP route sends the confirmation on a new order");
    assert((rsvpBlock.match(/notifyRsvpConfirmed\(/g) ?? []).length === 1, "only on the new order path, never on a repeated key");
  } finally {
    tn.setNoticeDepsForTest(null);
    tn.setQrBuilderForTest(null);
    const ids = (await q(`SELECT id FROM events WHERE host_user_id = $1`, [host])).map((x) => x.id);
    if (ids.length) {
      for (const t of ["ticket_account_counts WHERE ticket_type_id IN (SELECT id FROM ticket_types WHERE event_id = ANY($1))",
        "tickets WHERE event_id = ANY($1)", "ticket_order_items WHERE event_id = ANY($1)", "ticket_orders WHERE event_id = ANY($1)",
        "ticket_types WHERE event_id = ANY($1)", "events WHERE id = ANY($1)"]) {
        await q(`DELETE FROM ${t}`, [ids]).catch((e) => console.error("cleanup", t, e.message));
      }
    }
    await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM host_agreement_acceptances WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM user_payout_accounts WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch((e) => console.error("cleanup payouts", e.message));
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]).catch((e) => console.error("cleanup users", e.message));
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
