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
    for (const t of ["referral_payouts", "business_referrals", "event_payout_recoveries", "tickets", "ticket_order_items", "ticket_orders", "ticket_types", "event_payouts", "events",
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
    // A pending refund request counts at most what the admin approval would really refund for its target.
    const refReq = (o: Record<string, unknown>) => ins("refund_requests", { id: "bp-test-refreq", requester_id: "bp-test-user", requester_type: "customer", target_type: "order", target_id: "bp-test-order-o", reason: "test", amount: 400, status: "pending", ...o });
    const paidOrder = () => ins("orders", { id: "bp-test-order-o", business_id: "bp-test-biz", customer_id: "bp-test-user", items: "[]", total_amount: 1000, status: "paid", stripe_payment_intent_id: "pi_bp_test_o" });
    await expectPart("pending refund request below the paid amount counts its amount", "pendingRefundRequests", 400, async () => {
      await baseParents();
      await paidOrder();
      await refReq({});
    });
    await expectPart("pending refund request of 2,147,483,647 on a 1000 cent order counts 1000", "pendingRefundRequests", 1000, async () => {
      await baseParents();
      await paidOrder();
      await refReq({ amount: 2147483647 });
    });
    await expectPart("pending refund request on a missing target counts 0", null, 0, async () => {
      await baseParents();
      await refReq({ amount: 2147483647, target_id: "bp-test-nope" });
    });
    await expectPart("pending refund request on an unknown target type counts 0", null, 0, async () => {
      await baseParents();
      await paidOrder();
      await refReq({ amount: 500, target_type: "gift_card" });
    });
    await expectPart("pending refund request on an order with no Stripe payment counts 0", null, 0, async () => {
      await baseParents();
      await ins("orders", { id: "bp-test-order-o", business_id: "bp-test-biz", customer_id: "bp-test-user", items: "[]", total_amount: 1000, status: "paid" });
      await refReq({ amount: 500 });
    });
    await expectPart("pending refund request on an appointment counts at most its paid deposit plus fee less refunds", "pendingRefundRequests", 980, async () => {
      await baseParents();
      // Old and past, so booking refund cover does not count it.
      await ins("appointments", apptBase({ status: "completed", stripe_payment_intent_id: "pi_bp_test_a", deposit_amount_cents: 1000, refund_amount: 100, created_at: ago(45), appointment_date: ymd(ago(40)) }));
      await refReq({ target_type: "appointment", target_id: "bp-test-appt", amount: 2147483647 });
    });
    await expectPart("pending refund request on a shoot booking counts at most its paid amount", "pendingRefundRequests", 1080, async () => {
      await baseParents();
      await ins("shoot_bookings", shootBase({ status: "completed", stripe_payment_intent_id: "pi_bp_test_s", deposit_amount_cents: 1000, created_at: ago(45), date: ymd(ago(40)) }));
      await refReq({ target_type: "shoot_booking", target_id: "bp-test-shoot", amount: 5000 });
    });

    // ── tickets and event payouts ──
    await expectPart("valid ticket on a completed order with no payout", "ticketHostNetUnpaid", 900, async () => {
      // cancelled: a paused (or published) unstarted event would also count the order in ticket exposure.
      await seedEvent({ status: "cancelled", starts: ahead(10), ends: ahead(11) });
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
    // Business referral cash (072): $25 owed to a referrer stays on the platform until it is sent.
    const seedReferral = async () => {
      await baseParents();
      await ins("users", { id: "bp-test-referrer", username: "bp-test-referrer" });
      await ins("business_referrals", { id: "bp-test-bref", referrer_user_id: "bp-test-referrer", business_id: "bp-test-biz", referred_owner_user_id: "bp-test-user", code: "BPTEST", status: "qualified", expires_at: ahead(60), qualified_at: ago(1) });
    };
    for (const st of ["pending", "held", "review"]) {
      await expectPart(`referral payout ${st} is held`, "referralPayoutsOpen", 2500, async () => {
        await seedReferral();
        await ins("referral_payouts", { id: "bp-test-rpay", business_referral_id: "bp-test-bref", recipient_user_id: "bp-test-referrer", amount_cents: 2500, status: st, payable_after: ago(1) });
      });
    }
    for (const st of ["paid", "cancelled"]) {
      await expectPart(`referral payout ${st} is not held`, null, 0, async () => {
        await seedReferral();
        await ins("referral_payouts", { id: "bp-test-rpay", business_referral_id: "bp-test-bref", recipient_user_id: "bp-test-referrer", amount_cents: 2500, status: st, payable_after: ago(1) });
      });
    }
    await expectPart("referral payout waiting on balance gates the bank payout", "referralPayoutsOpen", 2500, async () => {
      await seedReferral();
      await ins("referral_payouts", { id: "bp-test-rpay", business_referral_id: "bp-test-bref", recipient_user_id: "bp-test-referrer", amount_cents: 2500, status: "pending", payable_after: ago(1), last_error: "Insufficient funds in Stripe account" });
    }, { referralPayoutsWaitingBalance: 1 });
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
    await expectPart("paused unstarted event exposure is total minus refunded", "ticketExposureUnstarted", 4400, async () => {
      await seedEvent({ status: "paused", starts: ahead(10), ends: ahead(11) });
      await seedOrder({ status: "completed", subtotal_cents: 5000, service_fee_cents: 400, total_cents: 5400, refunded_cents: 1000 });
    });
    await expectPart("paused started event that ended 10 days ago is counted", "ticketExposureStarted30d", 5000, async () => {
      await seedEvent({ status: "paused", starts: ago(11), ends: ago(10) });
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

    await jobTests();
  } finally {
    await cleanup();
    await q(`DELETE FROM bank_payouts WHERE payout_date >= '2090-01-01'`).catch(() => {});
    await db.end();
  }

  // ═════════════════════════ Task 4: the daily job ═════════════════════════
  // Rows use New York dates in 2099 (deleted before and after every test). A fake BankStripe records every call.
  async function jobTests() {
    const bp: any = await import("./bankPayout");
    const BOUND = { timeoutMs: 30000, maxNetworkRetries: 1 };
    const isBound = (o: any) => o && o.timeoutMs === 30000 && o.maxNetworkRetries === 1;
    // 2099-01-15 is EST (UTC-5): 12:00Z = 07:00 New York, 10:59Z = 05:59 New York.
    const DATE = "2099-01-15";
    const NOW = new Date("2099-01-15T12:00:00Z");
    const BEFORE_SIX = new Date("2099-01-15T10:59:00Z");
    const DAY_START = Date.UTC(2099, 0, 15, 5) / 1000;
    const clearRows = () => q(`DELETE FROM bank_payouts WHERE payout_date >= '2090-01-01'`);
    const rowOf = async (d = DATE) => (await q(`SELECT *, payout_date::text AS pd, round(extract(epoch from (next_attempt_at - now())) / 60)::int AS mins_left FROM bank_payouts WHERE payout_date = $1`, [d]))[0];
    const countRows = async () => Number((await q(`SELECT count(*)::int AS n FROM bank_payouts WHERE payout_date >= '2090-01-01'`))[0].n);
    const makeDue = (d = DATE) => q(`UPDATE bank_payouts SET next_attempt_at = now() - interval '1 second' WHERE payout_date = $1`, [d]);

    let emails: { subject: string; detail: string }[] = [];
    bp.setBankAlertForTest?.(async (subject: string, detail: string) => { emails.push({ subject, detail }); });

    type Mode = "ok" | "throwOnce" | "alwaysThrow" | "landsButThrows" | "insufficient";
    function fake(init: Partial<{ interval: string | null; usd: number; other: string[]; payouts: any[]; mode: Mode; delayMs: number; listThrows: boolean; retrieve: Record<string, { status: string; failureCode?: string | null } | "throw"> }> = {}) {
      const st = { interval: "manual" as string | null, usd: 0, other: [] as string[], payouts: [] as any[], mode: "ok" as Mode, delayMs: 0, listThrows: false, retrieve: {} as Record<string, any>, ...init };
      const calls: string[] = [];
      const opts: any[] = [];
      const creates: any[] = [];
      const listSince: number[] = [];
      let n = 0;
      const land = (p: any) => {
        const id = `po_bp_test_${++n}`;
        st.payouts.push({ id, amount: p.amountCents, status: "pending", created: Math.floor(Date.now() / 1000), metadata: { type: "outsyde_bank_payout", payoutDate: p.payoutDate, rowId: p.rowId } });
        return id;
      };
      const s = {
        async getPlatformPayoutInterval(o: any) { calls.push("interval"); opts.push(o); return st.interval; },
        async getAvailableUsdBalance(o: any) { calls.push("balance"); opts.push(o); return { usdCents: st.usd, otherCurrencies: st.other }; },
        async listPlatformPayoutsCreatedSince(since: number, o: any) {
          calls.push("list"); opts.push(o); listSince.push(since);
          if (st.listThrows) throw new Error("Stripe list timed out");
          return st.payouts.map((p) => ({ ...p }));
        },
        async createPlatformPayout(p: any) {
          calls.push("create"); creates.push(p); opts.push({ timeoutMs: p.timeoutMs, maxNetworkRetries: p.maxNetworkRetries });
          if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
          if (st.mode === "throwOnce") { st.mode = "ok"; throw new Error("Stripe API error (500)"); }
          if (st.mode === "alwaysThrow") throw new Error("Stripe API error (500)");
          if (st.mode === "insufficient") throw Object.assign(new Error("Insufficient funds in Stripe account"), { code: "balance_insufficient" });
          if (st.mode === "landsButThrows") { st.mode = "ok"; land(p); throw new Error("Request timed out"); }
          const id = land(p);
          return { id, status: "pending" };
        },
        async retrievePlatformPayout(id: string, o: any) {
          calls.push("retrieve"); opts.push(o);
          const r = st.retrieve[id];
          if (!r || r === "throw") throw new Error("Stripe retrieve timed out");
          return { id, status: r.status, failureCode: r.failureCode ?? null };
        },
        isInsufficientFundsError(err: unknown) {
          const e = err as any;
          const code = e?.code ?? e?.raw?.code;
          return code === "balance_insufficient" || /insufficient (available )?funds/i.test(e?.message ?? "");
        },
      };
      return { s, st, calls, opts, creates, listSince };
    }

    const heldNow = async () => (await computeHeld()).total;
    async function jobTest(name: string, fn: () => Promise<void>) {
      console.log(name);
      await clearRows();
      emails = [];
      process.env.DAILY_BANK_PAYOUT_ENABLED = "true";
      bp.setBankHooksForTest?.(null);
      try {
        await fn();
      } catch (err) {
        assert(false, `${name}: threw`, String((err as Error)?.stack ?? err));
      } finally {
        bp.setBankHooksForTest?.(null);
        await clearRows();
        await cleanup();
      }
    }

    // Preconditions: the job tests read the real held total, so nothing may gate them on this local DB.
    const g0 = (await computeHeld()).gates;
    if (g0.recentTopups || g0.openIssueRows || g0.eventPayoutsWaitingBalance || g0.referralPayoutsWaitingBalance) throw new Error(`local DB has gate rows (${JSON.stringify(g0)}): clean them first`);
    if (Number((await q(`SELECT count(*)::int AS n FROM bank_payouts WHERE status IN ('pending','sent') AND payout_date < '2090-01-01'`))[0].n)) throw new Error("local DB has open bank_payouts rows outside the test range");

    // ── nyDayAndHour ──
    await jobTest("nyDayAndHour: clock edges, New York date and midnight", async () => {
      const f = bp.nyDayAndHour;
      const a = f(new Date("2026-10-21T09:59:00Z"));
      assert(a.hour === 5 && a.date === "2026-10-21", "09:59Z (EDT) is 05 New York", a);
      const b = f(new Date("2026-10-21T10:00:00Z"));
      assert(b.hour === 6 && b.date === "2026-10-21", "10:00Z (EDT) is 06 New York", b);
      const c = f(new Date("2026-10-22T01:30:00Z"));
      assert(c.date === "2026-10-21" && c.hour === 21, "2026-10-22T01:30Z is still 2026-10-21 in New York", c);
      assert(c.dayStartUnix === Date.UTC(2026, 9, 21, 4) / 1000, "dayStartUnix is New York midnight (EDT)", c);
      const d = f(new Date("2026-12-01T11:00:00Z"));
      assert(d.hour === 6 && d.date === "2026-12-01", "11:00Z (EST) is 06 New York", d);
      assert(d.dayStartUnix === Date.UTC(2026, 11, 1, 5) / 1000, "dayStartUnix is New York midnight (EST)", d);
      const e = f(new Date("2026-12-01T00:00:00Z"));
      assert(e.hour === 19 && e.date === "2026-11-30", "00:00Z (EST) is 19 the day before", e);
      const sp = f(new Date("2026-03-08T12:00:00Z"));
      assert(sp.date === "2026-03-08" && sp.hour === 8 && sp.dayStartUnix === Date.UTC(2026, 2, 8, 5) / 1000, "spring forward day: midnight was still EST", sp);
      const fb = f(new Date("2026-11-01T12:00:00Z"));
      assert(fb.date === "2026-11-01" && fb.hour === 7 && fb.dayStartUnix === Date.UTC(2026, 10, 1, 4) / 1000, "fall back day: midnight was still EDT", fb);
      const mid = f(new Date("2026-10-21T04:00:00Z"));
      assert(mid.hour === 0 && mid.date === "2026-10-21", "exactly midnight is hour 0 of the new day", mid);
    });

    // ── 1. switch off ──
    await jobTest("1. switch off: off, no Stripe call, no row", async () => {
      delete process.env.DAILY_BANK_PAYOUT_ENABLED;
      const f = fake({ usd: 10_000_000 });
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, sent_at) VALUES ('2099-01-01','sent','po_off',now() - interval '11 days')`);
      const r = await bp.runBankPayoutJob(NOW, f.s);
      assert(r?.action === "off", "action off", r);
      assert(f.calls.length === 0, "no Stripe call (not even the sent check)", f.calls);
      assert((await countRows()) === 1 && (await rowOf("2099-01-01")).status === "sent", "no row written or changed");
      process.env.DAILY_BANK_PAYOUT_ENABLED = "false";
      const r2 = await bp.runBankPayoutJob(NOW, f.s);
      assert(r2?.action === "off" && f.calls.length === 0, "'false' is off too", r2);
      assert(emails.length === 0, "no email");
    });

    // ── 2. checkSentPayouts ──
    await jobTest("2a. sent check: paid -> paid + paid_at, no email; runs first even before 6:00", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, amount_cents, sent_at) VALUES ('2099-01-10','sent','po_a',5000,now() - interval '2 days')`);
      const f = fake({ retrieve: { po_a: { status: "paid" } } });
      const r = await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      assert(r?.action === "not_yet", "still not_yet for today", r);
      const row = await rowOf("2099-01-10");
      assert(row.status === "paid" && row.paid_at !== null && row.stripe_status === "paid", "row paid with paid_at", row);
      assert(f.calls.join(",") === "retrieve" && isBound(f.opts[0]), "one bounded retrieve", { calls: f.calls, opts: f.opts });
      assert(emails.length === 0, "no email for paid");
      assert(row.mins_left === 60, "a paid row's next check is in an hour", row);
      const n = await bp.checkSentPayouts(f.s);
      assert(n === 0 && f.calls.length === 1, "a paid row is not checked again within the hour", { n, calls: f.calls });
    });
    await jobTest("2g. sent check: a sent row not final is checked at most hourly", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, amount_cents, sent_at) VALUES ('2099-01-10','sent','po_h',5000,now() - interval '1 day')`);
      const f = fake({ retrieve: { po_h: { status: "in_transit" } } });
      await bp.checkSentPayouts(f.s);
      const row = await rowOf("2099-01-10");
      assert(row.status === "sent" && row.stripe_status === "in_transit" && row.mins_left === 60, "still sent, next check in an hour", row);
      await bp.checkSentPayouts(f.s);
      await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      assert(f.calls.filter((c) => c === "retrieve").length === 1, "not checked again within the hour", f.calls);
      await makeDue("2099-01-10");
      await bp.checkSentPayouts(f.s);
      assert(f.calls.filter((c) => c === "retrieve").length === 2 && (await rowOf("2099-01-10")).mins_left === 60, "checked again once the hour is up", f.calls);
    });
    await jobTest("2g2. sent check: a failed retrieve also waits an hour before the next check", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, amount_cents, sent_at) VALUES ('2099-01-10','sent','po_t2',5000,now() - interval '1 day')`);
      const f = fake({ retrieve: { po_t2: "throw" } });
      await bp.checkSentPayouts(f.s);
      await bp.checkSentPayouts(f.s);
      const row = await rowOf("2099-01-10");
      assert(row.status === "sent" && row.mins_left === 60 && f.calls.filter((c) => c === "retrieve").length === 1, "one retrieve, next check in an hour", { row, calls: f.calls });
    });
    await jobTest("2h. paid row re-checked within 7 days: failed at Stripe -> failed + one email (same copy)", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, stripe_status, amount_cents, sent_at, paid_at) VALUES ('2099-01-10','paid','po_p','paid',5000,now() - interval '3 days', now() - interval '2 days')`);
      const f = fake({ retrieve: { po_p: { status: "failed", failureCode: "account_closed" } } });
      const n = await bp.checkSentPayouts(f.s);
      const row = await rowOf("2099-01-10");
      assert(n === 1 && row.status === "failed" && row.failed_at !== null && row.stripe_status === "failed" && /account_closed/.test(row.last_error ?? ""), "paid row now failed with failed_at", row);
      assert(emails.length === 1 && emails[0].subject === "[Payouts] Bank payout failed" && /po_p/.test(emails[0].detail) && /failed at Stripe/.test(emails[0].detail) && !/was failed/.test(emails[0].detail), "one email, same copy", emails);
      await makeDue("2099-01-10");
      await bp.checkSentPayouts(f.s);
      assert(emails.length === 1 && f.calls.filter((c) => c === "retrieve").length === 1, "a failed row is not checked again", { emails, calls: f.calls });
    });
    await jobTest("2h2. paid row re-checked: canceled -> failed; still paid -> next check in an hour, no email", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, stripe_status, amount_cents, sent_at, paid_at) VALUES ('2099-01-10','paid','po_pc','paid',5000,now() - interval '3 days', now() - interval '2 days'), ('2099-01-11','paid','po_pp','paid',5000,now() - interval '2 days', now() - interval '1 day')`);
      const f = fake({ retrieve: { po_pc: { status: "canceled" }, po_pp: { status: "paid" } } });
      await bp.checkSentPayouts(f.s);
      const c = await rowOf("2099-01-10");
      const p = await rowOf("2099-01-11");
      assert(c.status === "failed" && c.stripe_status === "canceled", "canceled paid row is failed", c);
      assert(p.status === "paid" && p.mins_left === 60, "still paid: next check in an hour", p);
      assert(emails.length === 1 && /po_pc/.test(emails[0].detail) && /was canceled at Stripe/.test(emails[0].detail), "one email for the canceled one", emails);
    });
    await jobTest("2i. paid row paid more than 7 days ago is not checked", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, stripe_status, amount_cents, sent_at, paid_at) VALUES ('2099-01-01','paid','po_o','paid',5000,now() - interval '9 days', now() - interval '8 days')`);
      const f = fake({ retrieve: { po_o: { status: "failed" } } });
      await bp.checkSentPayouts(f.s);
      assert(f.calls.length === 0 && (await rowOf("2099-01-01")).status === "paid" && emails.length === 0, "no retrieve, still paid, no email", f.calls);
    });
    await jobTest("2b. sent check: failed -> failed + one email", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, amount_cents, sent_at) VALUES ('2099-01-10','sent','po_f',5000,now() - interval '2 days')`);
      const f = fake({ retrieve: { po_f: { status: "failed", failureCode: "account_closed" } } });
      await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      const row = await rowOf("2099-01-10");
      assert(row.status === "failed" && row.failed_at !== null && row.stripe_status === "failed", "row failed with failed_at", row);
      assert(emails.length === 1 && emails[0].subject.startsWith("[Payouts] ") && /account_closed/.test(emails[0].detail) && /po_f/.test(emails[0].detail), "one [Payouts] email with id and code", emails);
      assert(/failed at Stripe/.test(emails[0]?.detail ?? "") && !/was failed/.test(emails[0]?.detail ?? ""), "copy: failed at Stripe, not was failed", emails);
      await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      assert(emails.length === 1 && f.calls.filter((c) => c === "retrieve").length === 1, "no second email or retrieve", { emails, calls: f.calls });
    });
    await jobTest("2c. sent check: canceled -> failed + one email", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, amount_cents, sent_at) VALUES ('2099-01-10','sent','po_c',5000,now() - interval '1 day')`);
      const f = fake({ retrieve: { po_c: { status: "canceled" } } });
      await bp.checkSentPayouts(f.s);
      const row = await rowOf("2099-01-10");
      assert(row.status === "failed" && row.stripe_status === "canceled", "canceled is failed", row);
      assert(emails.length === 1, "one email", emails);
    });
    await jobTest("2d. sent check: in transit after 10 days -> one email (alerted_at); 3 days -> none", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, amount_cents, sent_at) VALUES ('2099-01-01','sent','po_old',5000,now() - interval '11 days'), ('2099-01-09','sent','po_new',5000,now() - interval '3 days')`);
      const f = fake({ retrieve: { po_old: { status: "in_transit" }, po_new: { status: "in_transit" } } });
      await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      const old = await rowOf("2099-01-01");
      const nw = await rowOf("2099-01-09");
      assert(old.status === "sent" && old.alerted_at !== null && old.stripe_status === "in_transit", "old row still sent, alerted", old);
      assert(nw.status === "sent" && nw.alerted_at === null, "new row not alerted", nw);
      assert(emails.length === 1 && /po_old/.test(emails[0].detail) && emails[0].subject.startsWith("[Payouts] "), "one email about the old row", emails);
      assert(emails[0]?.subject === "[Payouts] Bank payout has not arrived", "subject: Bank payout has not arrived", emails[0]);
      await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      await makeDue("2099-01-01");
      await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      assert(emails.length === 1, "no second email on the next run", emails);
      assert(f.opts.every(isBound), "every retrieve bounded", f.opts);
    });
    await jobTest("2e. sent check: retrieve keeps failing for 10 days -> still one email; a failed retrieve changes nothing else", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, amount_cents, sent_at) VALUES ('2099-01-01','sent','po_x',5000,now() - interval '11 days'), ('2099-01-09','sent','po_y',5000,now() - interval '1 day')`);
      const f = fake({ retrieve: { po_x: "throw", po_y: "throw" } });
      await bp.checkSentPayouts(f.s);
      assert((await rowOf("2099-01-01")).status === "sent" && (await rowOf("2099-01-09")).status === "sent", "both still sent");
      assert(emails.length === 1 && /po_x/.test(emails[0].detail), "one email for the old one", emails);
    });
    await jobTest("2f. sent check: alerted before the send (other currency email) still gets the 10 day email", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, amount_cents, sent_at, alerted_at) VALUES ('2099-01-01','sent','po_z',5000,now() - interval '11 days', now() - interval '11 days 1 minute')`);
      const f = fake({ retrieve: { po_z: { status: "in_transit" } } });
      await bp.checkSentPayouts(f.s);
      assert(emails.length === 1, "one email", emails);
      await makeDue("2099-01-01");
      await bp.checkSentPayouts(f.s);
      assert(emails.length === 1 && f.calls.filter((c) => c === "retrieve").length === 2, "only one, even when checked again", { emails, calls: f.calls });
    });

    // ── 2s. pending row from an earlier New York date ──
    await jobTest("2s. pending row from an earlier date: one email (alerted_at), status unchanged, never again", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, attempts, next_attempt_at) VALUES ('2099-01-14','pending',2,now() - interval '5 minutes')`);
      const f = fake();
      const r = await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      assert(r?.action === "not_yet", "today still not_yet", r);
      const row = await rowOf("2099-01-14");
      assert(row.status === "pending" && Number(row.attempts) === 2 && row.alerted_at !== null, "still pending, attempts unchanged, alerted", row);
      assert(emails.length === 1 && emails[0].subject.startsWith("[Payouts] ") && emails[0].detail.includes("2099-01-14") && /did not finish/.test(emails[0].detail) && /may have reached Stripe/.test(emails[0].detail), "one email naming the date", emails);
      assert(!/8%|8 %/.test(emails[0]?.detail ?? "") && !/ - | — | – /.test(emails[0]?.detail ?? ""), "copy: no 8%, no dash separators", emails[0]);
      assert(f.calls.length === 0, "no Stripe call", f.calls);
      await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      await bp.runBankPayoutJob(NOW, fake({ usd: 0 }).s);
      assert(emails.length === 1, "never again", emails);
    });
    await jobTest("2s2. earlier pending row: other currency email that day does not stop it; a lock still in flight waits; today's pending row is not alerted", async () => {
      await q(`INSERT INTO bank_payouts (payout_date, status, attempts, next_attempt_at, alerted_at) VALUES
        ('2099-01-13','pending',1,now() - interval '1 hour', now() - interval '2 hours'),
        ('2099-01-14','pending',1,now() + interval '5 minutes', NULL),
        ($1,'pending',1,now() + interval '5 minutes', NULL)`, [DATE]);
      await bp.runBankPayoutJob(NOW, fake().s);
      assert(emails.length === 1 && emails[0].detail.includes("2099-01-13"), "one email, for the 13th only", emails);
      assert((await rowOf("2099-01-14")).alerted_at === null && (await rowOf()).alerted_at === null, "in-flight and today's rows not alerted", null);
      await makeDue("2099-01-14");
      await bp.runBankPayoutJob(NOW, fake().s);
      assert(emails.length === 2 && emails[1].detail.includes("2099-01-14"), "the 14th once its lock ran out", emails);
    });

    // ── 3. not yet / done today ──
    await jobTest("3a. before 06:00 New York: not_yet, nothing read, no row", async () => {
      const held = await heldNow();
      const f = fake({ usd: held + 100_000 });
      const r = await bp.runBankPayoutJob(BEFORE_SIX, f.s);
      assert(r?.action === "not_yet", "not_yet at 05:59", r);
      assert(f.calls.length === 0 && (await countRows()) === 0, "no Stripe call, no row", f.calls);
      const r6 = await bp.runBankPayoutJob(new Date("2099-01-15T11:00:00Z"), f.s);
      assert(r6?.action === "sent", "06:00 sharp runs", r6);
    });
    await jobTest("3b. today's row already final: done_today, no interval/list/create", async () => {
      for (const status of ["paid", "sent", "skipped", "failed", "review"]) {
        await clearRows();
        await q(`INSERT INTO bank_payouts (payout_date, status, stripe_payout_id, sent_at) VALUES ($1,$2,'po_t',now())`, [DATE, status]);
        const f = fake({ usd: 10_000_000, retrieve: { po_t: { status: "in_transit" } } });
        const r = await bp.runBankPayoutJob(NOW, f.s);
        assert(r?.action === "done_today", `${status}: done_today`, r);
        assert(!f.calls.some((c) => c !== "retrieve"), `${status}: only the sent check touched Stripe`, f.calls);
      }
    });

    // ── 4. not manual ──
    await jobTest("4. Stripe interval not manual: skipped stripe_not_manual, no row, no email", async () => {
      for (const interval of ["daily", null]) {
        const f = fake({ interval, usd: 10_000_000 });
        const r = await bp.runBankPayoutJob(NOW, f.s);
        assert(r?.action === "skipped" && r?.reason === "stripe_not_manual", `${interval}: skipped stripe_not_manual`, r);
        assert(f.calls.join(",") === "interval" && isBound(f.opts[0]), `${interval}: only a bounded interval read`, { calls: f.calls, opts: f.opts });
      }
      assert((await countRows()) === 0, "no row written");
      assert(emails.length === 0, "no email");
      const held = await heldNow();
      const f2 = fake({ usd: held + 15_000 });
      const r2 = await bp.runBankPayoutJob(NOW, f2.s);
      assert(r2?.action === "sent", "once flipped to manual the same day still runs", r2);
    });
    await jobTest("4b. interval read fails: no row, no create", async () => {
      const f = fake({ usd: 10_000_000 });
      (f.s as any).getPlatformPayoutInterval = async () => { f.calls.push("interval"); throw new Error("Stripe down"); };
      const r = await bp.runBankPayoutJob(NOW, f.s);
      assert(r?.action === "retry", "retry", r);
      assert((await countRows()) === 0 && !f.calls.includes("create"), "no row, no create", f.calls);
    });

    // ── 5. claim ──
    await jobTest("5a. claim: new pending row with attempts 1 and a 10 minute lock (held at create time)", async () => {
      const held = await heldNow();
      const f = fake({ usd: held + 15_000 });
      let seen: any = null;
      bp.setBankHooksForTest({ beforeCreate: async () => { seen = await rowOf(); } });
      await bp.runBankPayoutJob(NOW, f.s);
      assert(seen?.status === "pending" && Number(seen?.attempts) === 1 && seen?.mins_left === 10, "pending, attempts 1, lock 10 minutes", seen);
    });
    await jobTest("5b. re-claim a due pending row: attempts + 1; a locked one: done_today, no Stripe", async () => {
      const held = await heldNow();
      await q(`INSERT INTO bank_payouts (payout_date, status, attempts, next_attempt_at) VALUES ($1,'pending',2,now() + interval '5 minutes')`, [DATE]);
      const f = fake({ usd: held + 15_000 });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      assert(r?.action === "done_today", "locked pending: done_today", r);
      assert(f.calls.length === 0, "no Stripe call while locked", f.calls);
      await makeDue();
      const r2 = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r2?.action === "sent" && Number(row.attempts) === 3, "due pending re-claimed (attempts 3) and sent", { r2, row });
    });

    // ── 6. gates and other currency ──
    const gateCases: [string, string, () => Promise<void>][] = [
      ["recent top-up", "recent_topup", async () => { await baseParents(); await ins("appointments", apptBase({ status: "completed" })); await ins("booking_payout_issues", issueBase({ status: "paid", topup_requested_at: ago(2) })); }],
      ["open booking payout issue", "open_booking_payout_issues", async () => { await baseParents(); await ins("appointments", apptBase({ status: "completed" })); await ins("booking_payout_issues", issueBase({})); }],
      ["event payout waiting for balance", "event_payout_waiting_balance", async () => {
        await seedEvent({ status: "paused", starts: ago(10), ends: ago(9) });
        await ins("event_payouts", { id: "bp-test-payout", event_id: "bp-test-event", gross_cents: 600, amount_cents: 600, status: "pending", last_error: "Insufficient funds in Stripe account" });
      }],
    ];
    for (const [label, reason, seed] of gateCases) {
      await jobTest(`6. gate ${label}: skipped ${reason}, no create, no email`, async () => {
        await seed();
        const f = fake({ usd: 100_000_000 });
        const r = await bp.runBankPayoutJob(NOW, f.s);
        const row = await rowOf();
        assert(r?.action === "skipped" && r?.reason === reason, `skipped ${reason}`, r);
        assert(row?.status === "skipped" && row?.skip_reason === reason && row?.next_attempt_at === null, "row skipped with reason", row);
        assert(!f.calls.includes("create") && emails.length === 0, "no create, no email", { calls: f.calls, emails });
      });
    }
    await jobTest("6b. other currency in balance: pays USD, one email per day", async () => {
      const held = await heldNow();
      const f = fake({ usd: held + 15_000, other: ["eur", "gbp"], mode: "throwOnce" });
      const r1 = await bp.runBankPayoutJob(NOW, f.s);
      assert(r1?.action === "retry", "first try fails", r1);
      assert(emails.length === 1 && /eur/i.test(emails[0].detail) && emails[0].subject.startsWith("[Payouts] "), "one email naming the currency", emails);
      await makeDue();
      const r2 = await bp.runBankPayoutJob(NOW, f.s);
      assert(r2?.action === "sent" && f.creates.at(-1)?.amountCents === 5_000, "second try pays the USD amount", { r2, c: f.creates });
      assert(emails.length === 1, "still one email that day", emails);
      assert(!/8%|8 %/.test(emails[0].detail) && !/ - | — | – /.test(emails[0].detail), "copy: no 8%, no dash separators", emails[0]);
    });

    // ── 7. lookup ──
    await jobTest("7a. ours already at Stripe today: recorded as sent, never created", async () => {
      const held = await heldNow();
      const f = fake({ usd: held + 15_000, payouts: [{ id: "po_ours", amount: 4321, status: "in_transit", created: DAY_START + 60, metadata: { type: "outsyde_bank_payout", payoutDate: DATE, rowId: "x" } }] });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r?.action === "sent", "sent", r);
      assert(row.status === "sent" && row.stripe_payout_id === "po_ours" && Number(row.amount_cents) === 4321 && row.sent_at !== null, "row records that payout", row);
      assert(!f.calls.includes("create"), "no create", f.calls);
      assert(f.listSince[0] === DAY_START && isBound(f.opts[f.calls.indexOf("list")]), "list since New York midnight, bounded", { since: f.listSince, DAY_START });
    });
    for (const [label, p] of [
      ["a hand payout", { id: "po_hand", amount: 9999, status: "pending", created: DAY_START + 10, metadata: {} }],
      ["ours for another date", { id: "po_y", amount: 9999, status: "pending", created: DAY_START + 10, metadata: { type: "outsyde_bank_payout", payoutDate: "2099-01-14", rowId: "y" } }],
    ] as [string, any][]) {
      await jobTest(`7b. other payout today (${label}): skipped other_payout_today, no create, no email`, async () => {
        const f = fake({ usd: 100_000_000, payouts: [p] });
        const r = await bp.runBankPayoutJob(NOW, f.s);
        const row = await rowOf();
        assert(r?.action === "skipped" && r?.reason === "other_payout_today" && row?.skip_reason === "other_payout_today" && row?.status === "skipped", "skipped other_payout_today", { r, row });
        assert(!f.calls.includes("create") && emails.length === 0, "no create, no email", f.calls);
      });
    }
    await jobTest("7c. 500 payouts listed (page cap): can't tell, failed try with backoff, no create", async () => {
      const many = Array.from({ length: 500 }, (_, i) => ({ id: `po_m${i}`, amount: 1, status: "paid", created: DAY_START + i, metadata: {} }));
      const f = fake({ usd: 100_000_000, payouts: many });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r?.action === "retry", "retry", r);
      assert(row.status === "pending" && row.mins_left === 10 && row.last_error, "pending, backoff 10, error saved", row);
      assert(!f.calls.includes("create"), "no create", f.calls);
    });
    await jobTest("7d. lookup fails: failed try, no create", async () => {
      const f = fake({ usd: 100_000_000, listThrows: true });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      assert(r?.action === "retry" && !f.calls.includes("create") && (await rowOf()).status === "pending", "retry, no create", { r, calls: f.calls });
    });

    // ── 8. below minimum ──
    await jobTest("8. amount below 2500: skipped below_minimum with available, held, breakdown saved; 2500 sends", async () => {
      const h = await computeHeld();
      const f = fake({ usd: h.total + 10_000 + 2_499 });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r?.action === "skipped" && r?.reason === "below_minimum", "skipped below_minimum", r);
      assert(row.status === "skipped" && row.skip_reason === "below_minimum" && Number(row.available_cents) === h.total + 12_499 && Number(row.held_cents) === h.total && Number(row.buffer_cents) === 10_000, "available, held, buffer saved", row);
      assert(row.held_breakdown && typeof row.held_breakdown === "object" && "bookingRefundCover" in row.held_breakdown, "breakdown saved", row.held_breakdown);
      assert(!f.calls.includes("create") && emails.length === 0, "no create, no email");
      await clearRows();
      const f2 = fake({ usd: h.total + 10_000 + 2_500 });
      const r2 = await bp.runBankPayoutJob(NOW, f2.s);
      assert(r2?.action === "sent" && f2.creates[0]?.amountCents === 2_500, "exactly 2500 is sent", { r2, c: f2.creates });
      await clearRows();
      const f3 = fake({ usd: Math.max(0, h.total - 50_000) });
      const r3 = await bp.runBankPayoutJob(NOW, f3.s);
      const row3 = await rowOf();
      assert(r3?.reason === "below_minimum" && row3.status === "skipped", "balance below held: below_minimum", { r3, row3 });
      assert(!f3.calls.includes("create") && Number(row3.available_cents) === Math.max(0, h.total - 50_000) && row3.amount_cents === null, "no create, available saved, no amount", { calls: f3.calls, row3 });
    });

    // ── 9. send ──
    await jobTest("9. send: lock re-taken, create with per-try key -> sent with id, amount, breakdown", async () => {
      const h = await computeHeld();
      const f = fake({ usd: h.total + 10_000 + 5_000 });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r?.action === "sent", "sent", r);
      assert(f.creates.length === 1, "one create");
      const c = f.creates[0];
      assert(c.amountCents === 5_000 && c.payoutDate === DATE && c.rowId === row.id, "amount, date, row id", c);
      assert(new RegExp(`^bank_payout_${DATE}_\\d{16}$`).test(c.idempotencyKey), "key bank_payout_<date>_<claim microseconds>", c.idempotencyKey);
      assert(isBound(c), "create bounded", c);
      assert(f.calls.indexOf("list") < f.calls.indexOf("create"), "lookup before create", f.calls);
      assert(f.opts.every(isBound), "every call bounded", f.opts);
      assert(row.status === "sent" && row.stripe_payout_id === "po_bp_test_1" && Number(row.amount_cents) === 5_000 && row.sent_at !== null && row.next_attempt_at === null, "row sent", row);
      assert(Number(row.held_cents) === h.total && Number(row.available_cents) === h.total + 15_000 && row.held_breakdown && Number(row.held_breakdown.bookingRefundCover) === h.breakdown.bookingRefundCover, "held and breakdown saved", row);
      assert(emails.length === 0, "no email when sent");
      const again = await bp.runBankPayoutJob(new Date("2099-01-15T20:00:00Z"), f.s);
      assert(again?.action === "done_today" && f.creates.length === 1, "later the same day: done_today, no second create", again);
    });
    await jobTest("9b. a run that lost its claim before sending sends nothing and writes nothing", async () => {
      const held = await heldNow();
      const f = fake({ usd: held + 15_000 });
      bp.setBankHooksForTest({ afterClaim: async () => { await q(`UPDATE bank_payouts SET updated_at = now() + interval '1 second', next_attempt_at = now() + interval '10 minutes' WHERE payout_date = $1`, [DATE]); } });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r?.action !== "sent" && !f.calls.includes("create"), "no create", { r, calls: f.calls });
      assert(row.status === "pending" && Number(row.attempts) === 1 && row.last_error === null, "row untouched by the run that lost it", row);
    });

    // ── 10. errors ──
    await jobTest("10a. insufficient funds on create: skipped insufficient_funds, no email, no retry", async () => {
      const held = await heldNow();
      const f = fake({ usd: held + 15_000, mode: "insufficient" });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r?.action === "skipped" && r?.reason === "insufficient_funds", "skipped insufficient_funds", r);
      assert(row.status === "skipped" && row.skip_reason === "insufficient_funds" && row.next_attempt_at === null && /nsufficient/.test(row.last_error ?? ""), "row skipped, error saved", row);
      assert(emails.length === 0, "no email");
      await bp.runBankPayoutJob(NOW, f.s);
      assert(f.creates.length === 1, "no second try that day", f.creates.length);
    });
    await jobTest("10b. other errors: backoff 10, 20, 40, 60; after 5 tries review + one email", async () => {
      const held = await heldNow();
      const f = fake({ usd: held + 15_000, mode: "alwaysThrow" });
      const want = [10, 20, 40, 60];
      for (let i = 0; i < 4; i++) {
        const r = await bp.runBankPayoutJob(NOW, f.s);
        const row = await rowOf();
        assert(r?.action === "retry" && row.status === "pending" && Number(row.attempts) === i + 1 && row.mins_left === want[i] && /500/.test(row.last_error ?? ""), `try ${i + 1}: retry, backoff ${want[i]}`, { r, row });
        await makeDue();
      }
      assert(emails.length === 0, "no email before review");
      const r5 = await bp.runBankPayoutJob(NOW, f.s);
      const row5 = await rowOf();
      assert(r5?.action === "review" && row5.status === "review" && row5.next_attempt_at === null, "5th failure: review", { r5, row5 });
      assert(emails.length === 1 && emails[0].subject.startsWith("[Payouts] ") && emails[0].detail.includes(DATE), "one review email", emails);
      assert(f.creates.length === 5 && new Set(f.creates.map((c: any) => c.idempotencyKey)).size === 5, "a new key on every try", f.creates.map((c: any) => c.idempotencyKey));
      await bp.runBankPayoutJob(NOW, f.s);
      assert(emails.length === 1 && f.creates.length === 5, "review: nothing more that day", { e: emails.length, c: f.creates.length });
    });
    await jobTest("10c. a DB error inside skip() reaches the catch: backoff with attempts counted", async () => {
      const f = fake({ usd: 100_000_000, payouts: [{ id: "po_hand", amount: 9999, status: "pending", created: DAY_START + 10, metadata: {} }] });
      bp.setBankHooksForTest({ beforeHelperWrite: async (h: string) => { if (h === "skip") throw new Error("DB connection lost in skip"); } });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r?.action === "retry" && r?.reason === "error", "retry (error)", r);
      assert(row.status === "pending" && Number(row.attempts) === 1 && row.mins_left === 10 && /DB connection lost in skip/.test(row.last_error ?? ""), "pending, attempts 1, backoff 10, error saved", row);
      assert(!f.calls.includes("create"), "no create", f.calls);
    });
    await jobTest("10d. a DB error inside toReview() (two of ours listed) reaches the catch, not the caller", async () => {
      const f = fake({ usd: 100_000_000, payouts: [
        { id: "po_d1", amount: 1, status: "pending", created: DAY_START + 1, metadata: { type: "outsyde_bank_payout", payoutDate: DATE, rowId: "a" } },
        { id: "po_d2", amount: 1, status: "pending", created: DAY_START + 2, metadata: { type: "outsyde_bank_payout", payoutDate: DATE, rowId: "b" } }] });
      bp.setBankHooksForTest({ beforeHelperWrite: async (h: string) => { if (h === "toReview") throw new Error("DB connection lost in review"); } });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r?.action === "retry" && row.status === "pending" && row.mins_left === 10 && /lost in review/.test(row.last_error ?? ""), "retry with backoff", { r, row });
    });

    await jobTest("10e. a DB error inside record() (ours already listed) reaches the catch, not the caller", async () => {
      const f = fake({ usd: 100_000_000, payouts: [{ id: "po_r1", amount: 4321, status: "pending", created: DAY_START + 1, metadata: { type: "outsyde_bank_payout", payoutDate: DATE, rowId: "a" } }] });
      bp.setBankHooksForTest({ beforeHelperWrite: async (h: string) => { if (h === "record") throw new Error("DB connection lost in record"); } });
      const r = await bp.runBankPayoutJob(NOW, f.s);
      const row = await rowOf();
      assert(r?.action === "retry" && row.status === "pending" && Number(row.attempts) === 1 && row.mins_left === 10 && /lost in record/.test(row.last_error ?? ""), "retry with backoff", { r, row });
      assert(!f.calls.includes("create"), "no create", f.calls);
    });

    await jobTest("lost response is recorded, not resent", async () => {
      const held = await heldNow();
      const f = fake({ usd: held + 15_000, mode: "landsButThrows" });
      const r1 = await bp.runBankPayoutJob(NOW, f.s);
      const row1 = await rowOf();
      assert(r1?.action === "retry" && row1.status === "pending" && row1.stripe_payout_id === null, "first try: retry, not concluded either way", { r1, row1 });
      assert(f.creates.length === 1 && f.st.payouts.length === 1, "the payout landed at Stripe");
      await makeDue(); // 11 minutes later
      const r2 = await bp.runBankPayoutJob(NOW, f.s);
      const row2 = await rowOf();
      assert(r2?.action === "sent", "second run: sent", r2);
      assert(f.creates.length === 1, "0 new creates", f.creates.length);
      assert(row2.status === "sent" && row2.stripe_payout_id === f.st.payouts[0].id && Number(row2.amount_cents) === 5_000, "row sent with that id", row2);
    });
    await jobTest("two runs at once send one payout", async () => {
      const held = await heldNow();
      const f = fake({ usd: held + 15_000, delayMs: 300 });
      const [a, b] = await Promise.all([bp.runBankPayoutJob(NOW, f.s), bp.runBankPayoutJob(NOW, f.s)]);
      const actions = [a?.action, b?.action].sort().join(",");
      assert(f.creates.length === 1, "1 create", f.creates.length);
      assert(actions === "done_today,sent", "one sent, one done_today", { a, b });
      assert((await countRows()) === 1 && (await rowOf()).status === "sent", "one row, sent");
      const [c, d] = await Promise.all([bp.runBankPayoutJob(NOW, f.s), bp.runBankPayoutJob(NOW, f.s)]);
      assert(c?.action === "done_today" && d?.action === "done_today" && f.creates.length === 1, "more runs: still 1 create", { c, d });
    });

    bp.setBankAlertForTest?.(null);
    delete process.env.DAILY_BANK_PAYOUT_ENABLED;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
