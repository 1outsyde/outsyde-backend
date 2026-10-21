/**
 * Daily bank payout, held money query (computeHeld). In-process test against LOCAL Postgres only.
 *
 * Run with:
 *   DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/bankPayout.test.ts
 *
 * Seeds rows directly with pg using ids prefixed bp-test-, deletes them at start, after every test and at the end.
 * Each test seeds ONE obligation and checks that exactly one part moved by the seeded cents (measured against a
 * baseline read taken just before seeding) and that total moved by the same amount and equals the sum of the parts.
 * Refuses to run unless DATABASE_URL is localhost.
 */
const DB_URL = process.env.DATABASE_URL;
const isLocal = (u: string) => { try { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname); } catch { return false; } };

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}

const DAY = 86400000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const ymd = (iso: string) => iso.slice(0, 10);

(async () => {
  if (!DB_URL || !isLocal(DB_URL)) throw new Error("refusing to run: DATABASE_URL must be set and point at localhost");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const ins = async (table: string, o: Record<string, unknown>) => {
    const cols = Object.keys(o);
    await q(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => o[c]));
  };
  process.env.JWT_SECRET = process.env.JWT_SECRET || "bp-test-jwt"; // eventsRouter pulls in auth, which requires it
  const { computeHeld } = await import("./bankPayout");

  // Children first. tickets before event_payouts (tickets.payout_id) and before ticket_order_items.
  const cleanup = async () => {
    for (const t of ["event_payout_recoveries", "tickets", "ticket_order_items", "ticket_orders", "ticket_types", "event_payouts", "events",
      "booking_payout_issues", "appointments", "shoot_bookings", "orders", "refund_requests", "influencer_earning_ledger",
      "influencer_profiles", "photographers", "businesses", "users"]) {
      await q(`DELETE FROM ${t} WHERE id LIKE 'bp-test-%'`);
    }
  };

  // Shared parents. Everything is created fresh per test (cleanup runs after each one).
  const baseParents = async () => {
    await ins("users", { id: "bp-test-user", username: "bp-test-user" });
    await ins("businesses", { id: "bp-test-biz", owner_id: "bp-test-user", name: "bp-test biz", category: "beauty" });
    await ins("photographers", { id: "bp-test-photog", user_id: "bp-test-user", display_name: "bp-test photog", hourly_rate: 100 });
  };
  const seedEvent = async (o: { status: string; starts: string; ends: string }) => {
    await baseParents();
    await ins("events", { id: "bp-test-event", host_user_id: "bp-test-user", slug: "bp-test-event", title: "bp-test event", status: o.status, starts_at: o.starts, ends_at: o.ends, timezone: "America/New_York" });
  };
  const seedType = async () => ins("ticket_types", { id: "bp-test-type", event_id: "bp-test-event", name: "GA", price_cents: 1000, quantity: 10 });
  const seedOrder = async (o: Record<string, unknown>) =>
    ins("ticket_orders", { id: "bp-test-order", event_id: "bp-test-event", buyer_user_id: "bp-test-user", ticket_count: 1, ...o, host_net_cents: Number(o.subtotal_cents ?? 0) - Number(o.platform_fee_cents ?? 0) });
  const seedTicket = async (o: Record<string, unknown>) => {
    await seedType();
    await ins("ticket_order_items", { id: "bp-test-item", order_id: "bp-test-order", event_id: "bp-test-event", ticket_type_id: "bp-test-type", buyer_user_id: "bp-test-user", quantity: 1, unit_price_cents: 1000, expires_at: ahead(1), status: "issued" });
    await ins("tickets", { id: "bp-test-ticket", order_id: "bp-test-order", order_item_id: "bp-test-item", event_id: "bp-test-event", ticket_type_id: "bp-test-type", holder_user_id: "bp-test-user", item_index: 1, code: "bp-test-code", price_cents: 1000, platform_fee_cents: 100, host_net_cents: 900, ...o });
  };
  const apptBase = (o: Record<string, unknown>) => ({ id: "bp-test-appt", business_id: "bp-test-biz", client_id: "bp-test-user", appointment_date: ymd(ahead(30)), appointment_time: "10:00", total_price: 5000, ...o });
  const shootBase = (o: Record<string, unknown>) => ({ id: "bp-test-shoot", photographer_id: "bp-test-photog", client_id: "bp-test-user", shoot_type: "portrait", date: ymd(ahead(30)), start_time: "10:00", end_time: "11:00", duration_hours: 1, total_price: 5000, ...o });
  const issueBase = (o: Record<string, unknown>) => ({ id: "bp-test-issue", reference_type: "appointment", reference_id: "bp-test-appt", recipient_key: "bp-test-rk", is_base: false, connected_account_id: "acct_bp_test", amount_cents: 1000, ...o });

  type H = Awaited<ReturnType<typeof computeHeld>>;
  const sumParts = (h: H) => Object.values(h.breakdown).reduce((a, b) => a + b, 0);

  /** Seeds one obligation; asserts `part` moved by `cents`, no other part moved, and total moved by `cents` and equals the sum of parts. */
  async function expectPart(name: string, part: keyof H["breakdown"] | null, cents: number, seed: () => Promise<void>, gates?: Partial<H["gates"]>) {
    console.log(name);
    await cleanup();
    try {
      const before = await computeHeld();
      await seed();
      const after = await computeHeld();
      for (const k of Object.keys(after.breakdown) as (keyof H["breakdown"])[]) {
        const delta = after.breakdown[k] - before.breakdown[k];
        const want = k === part ? cents : 0;
        assert(delta === want, `${k} moved by ${want}`, { k, delta });
      }
      assert(after.total - before.total === cents, `total moved by ${cents}`, { before: before.total, after: after.total });
      assert(after.total === sumParts(after), "total equals the sum of the parts", { total: after.total, sum: sumParts(after) });
      assert(Object.values(after.breakdown).every((v) => typeof v === "number") && typeof after.total === "number", "values are numbers");
      for (const g of Object.keys(after.gates) as (keyof H["gates"])[]) {
        const delta = after.gates[g] - before.gates[g];
        const want = gates?.[g] ?? 0;
        assert(delta === want && typeof after.gates[g] === "number", `gate ${g} moved by ${want}`, { g, delta });
      }
    } finally {
      await cleanup();
    }
  }

  try {
    await cleanup();

    // ── booking_payout_issues, settled appointments/shoots ──
    await expectPart("open booking payout issue", "openBookingPayouts", 1000, async () => {
      await baseParents();
      await ins("appointments", apptBase({ status: "completed" }));
      await ins("booking_payout_issues", issueBase({}));
    }, { openIssueRows: 1 });

    await expectPart("settled appointment with no transfer", "settledNoTransfer", 2000, async () => {
      await baseParents();
      await ins("appointments", apptBase({ status: "completed", settled_at: ago(1), vendor_net: 2000 }));
    });
    await expectPart("settled appointment with an is_base issue row is not counted twice", "openBookingPayouts", 500, async () => {
      await baseParents();
      await ins("appointments", apptBase({ status: "completed", settled_at: ago(1), vendor_net: 2000 }));
      await ins("booking_payout_issues", issueBase({ is_base: true, amount_cents: 500 }));
    }, { openIssueRows: 1 });
    await expectPart("settled shoot booking with no transfer", "settledNoTransfer", 2200, async () => {
      await baseParents();
      await ins("shoot_bookings", shootBase({ status: "completed", settled_at: ago(1), vendor_net: 2200, payment_method: "payment_intent" }));
    });
    await expectPart("settled shoot booking paid by checkout_session is not counted", null, 0, async () => {
      await baseParents();
      await ins("shoot_bookings", shootBase({ status: "completed", settled_at: ago(1), vendor_net: 2200, payment_method: "checkout_session" }));
    });

    await expectPart("unsettled confirmed hold appointment", "unsettledConfirmed", 1500, async () => {
      await baseParents();
      await ins("appointments", apptBase({ status: "confirmed", hold_id: "bp-test-hold", platform_fee: 100, vendor_net: 1500 }));
    });
    await expectPart("unsettled confirmed payment_intent shoot", "unsettledConfirmed", 1600, async () => {
      await baseParents();
      await ins("shoot_bookings", shootBase({ status: "confirmed", payment_method: "payment_intent", vendor_net: 1600 }));
    });

    // ── orders, refund requests ──
    await expectPart("order transfer_failed", "ordersTransferFailed", 700, async () => {
      await baseParents();
      await ins("orders", { id: "bp-test-order-o", business_id: "bp-test-biz", customer_id: "bp-test-user", items: "[]", total_amount: 1000, status: "transfer_failed", vendor_net: 700 });
    });
    await expectPart("pending refund request", "pendingRefundRequests", 400, async () => {
      await baseParents();
      await ins("refund_requests", { id: "bp-test-refreq", requester_id: "bp-test-user", requester_type: "customer", target_type: "order", target_id: "bp-test-order-o", reason: "test", amount: 400, status: "pending" });
    });

    // ── tickets and event payouts ──
    await expectPart("valid ticket on a completed order with no payout", "ticketHostNetUnpaid", 900, async () => {
      await seedEvent({ status: "paused", starts: ahead(10), ends: ahead(11) });
      await seedOrder({ status: "completed", subtotal_cents: 1000, platform_fee_cents: 100, host_net_cents: 900, total_cents: 1000 });
      await seedTicket({});
    });
    await expectPart("event payout held", "eventPayoutsOpen", 900, async () => {
      await seedEvent({ status: "paused", starts: ago(10), ends: ago(9) });
      await ins("event_payouts", { id: "bp-test-payout", event_id: "bp-test-event", gross_cents: 1000, deducted_cents: 100, amount_cents: 900, status: "held" });
    });
    await expectPart("event payout pending waiting on balance", "eventPayoutsOpen", 600, async () => {
      await seedEvent({ status: "paused", starts: ago(10), ends: ago(9) });
      await ins("event_payouts", { id: "bp-test-payout", event_id: "bp-test-event", gross_cents: 600, amount_cents: 600, status: "pending", last_error: "Insufficient funds in Stripe account" });
    }, { eventPayoutsWaitingBalance: 1 });
    await expectPart("ticket order refunding", "ticketRefundsSending", 300, async () => {
      await seedEvent({ status: "paused", starts: ahead(10), ends: ahead(11) });
      await seedOrder({ status: "refunding", subtotal_cents: 1000, total_cents: 1000, refund_reason: "buyer", refund_amount_cents: 300 });
    });
    await expectPart("unstarted event exposure is total minus refunded", "ticketExposureUnstarted", 4400, async () => {
      await seedEvent({ status: "published", starts: ahead(10), ends: ahead(11) });
      await seedOrder({ status: "completed", subtotal_cents: 5000, service_fee_cents: 400, total_cents: 5400, refunded_cents: 1000 });
    });
    await expectPart("started event that ended 10 days ago is counted", "ticketExposureStarted30d", 5000, async () => {
      await seedEvent({ status: "published", starts: ago(11), ends: ago(10) });
      await seedOrder({ status: "completed", subtotal_cents: 5000, service_fee_cents: 400, total_cents: 5400 });
    });
    await expectPart("started event that ended 40 days ago is not counted", null, 0, async () => {
      await seedEvent({ status: "published", starts: ago(41), ends: ago(40) });
      await seedOrder({ status: "completed", subtotal_cents: 5000, service_fee_cents: 400, total_cents: 5400 });
    });
    await expectPart("owed event recovery changes nothing", null, 0, async () => {
      await seedEvent({ status: "paused", starts: ago(10), ends: ago(9) });
      await ins("event_payouts", { id: "bp-test-payout", event_id: "bp-test-event", gross_cents: 1000, deducted_cents: 100, amount_cents: 900, status: "paid" });
      await seedOrder({ status: "refunded", subtotal_cents: 1000, total_cents: 1000, refunded_cents: 1000, refund_reason: "buyer" });
      await seedTicket({ status: "refunded", payout_id: "bp-test-payout" });
      await ins("event_payout_recoveries", { id: "bp-test-recovery", ticket_id: "bp-test-ticket", payout_id: "bp-test-payout", connected_account_id: "acct_bp_test", amount_cents: 900, status: "owed" });
    });

    // ── influencers ──
    await expectPart("influencer ledger ready_for_payout, negative rows ignored", "influencerOwed", 250, async () => {
      await baseParents();
      await ins("influencer_profiles", { id: "bp-test-infl", user_id: "bp-test-user" });
      await ins("influencer_earning_ledger", { id: "bp-test-led1", influencer_id: "bp-test-infl", source_type: "order", amount_cents: 250, status: "ready_for_payout" });
      await ins("influencer_earning_ledger", { id: "bp-test-led2", influencer_id: "bp-test-infl", source_type: "order", amount_cents: -100, status: "ready_for_payout" });
    });

    // ── booking refund cover: deposit 1000 + 8% = 1080 ──
    const cover = { stripe_payment_intent_id: "pi_bp_test", deposit_amount_cents: 1000 };
    await expectPart("booking cover: appointment created 5 days ago", "bookingRefundCover", 1080, async () => {
      await baseParents();
      await ins("appointments", apptBase({ ...cover, status: "completed", created_at: ago(5), appointment_date: ymd(ago(4)) }));
    });
    await expectPart("booking cover: shoot created 5 days ago", "bookingRefundCover", 1080, async () => {
      await baseParents();
      await ins("shoot_bookings", shootBase({ ...cover, status: "completed", created_at: ago(5), date: ymd(ago(4)) }));
    });
    await expectPart("booking cover: created 45 days ago with a future date", "bookingRefundCover", 1080, async () => {
      await baseParents();
      await ins("appointments", apptBase({ ...cover, status: "confirmed", created_at: ago(45), appointment_date: ymd(ahead(5)) }));
    });
    await expectPart("booking cover: shoot created 45 days ago with a future date", "bookingRefundCover", 1080, async () => {
      await baseParents();
      await ins("shoot_bookings", shootBase({ ...cover, status: "confirmed", created_at: ago(45), date: ymd(ahead(5)) }));
    });
    await expectPart("booking cover: created 45 days ago with a past date is not counted", null, 0, async () => {
      await baseParents();
      await ins("appointments", apptBase({ ...cover, status: "confirmed", created_at: ago(45), appointment_date: ymd(ago(40)) }));
    });

    // ── gates ──
    await expectPart("gate: top-up 2 days ago is counted", "openBookingPayouts", 1000, async () => {
      await baseParents();
      await ins("booking_payout_issues", issueBase({ topup_requested_at: ago(2) }));
    }, { recentTopups: 1, openIssueRows: 1 });
    await expectPart("gate: top-up 8 days ago is not counted", "openBookingPayouts", 1000, async () => {
      await baseParents();
      await ins("booking_payout_issues", issueBase({ topup_requested_at: ago(8) }));
    }, { openIssueRows: 1 });
  } finally {
    await cleanup();
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
