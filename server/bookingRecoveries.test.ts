/**
 * Booking refund recovery Task 2: record a refund, resolve the booking, compute the share, backfill.
 * In-process test against LOCAL Postgres only; Stripe is a fake object.
 *
 * Run with:
 *   JWT_SECRET=local_test_only DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/bookingRecoveries.test.ts
 *
 * Seeds rows with pg using ids prefixed br-test-, cleans before and after. Foreign keys are bypassed for the seed
 * session only (session_replication_role = replica) so no users or businesses are needed. Refuses non-local DATABASE_URL.
 */
const DB_URL = process.env.DATABASE_URL;
const isLocal = (u: string) => { try { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname); } catch { return false; } };

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}

(async () => {
  if (!DB_URL || !isLocal(DB_URL)) throw new Error("refusing to run: DATABASE_URL must be set and point at localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "br-test-jwt";
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const ins = async (table: string, o: Record<string, unknown>) => {
    const cols = Object.keys(o);
    await q(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => o[c]));
  };
  await q(`SET session_replication_role = replica`);
  const clean = async () => {
    await q(`DELETE FROM booking_refund_recoveries WHERE refund_id LIKE 'br-test-%'`);
    await q(`DELETE FROM appointments WHERE id LIKE 'br-test-%'`);
    await q(`DELETE FROM shoot_bookings WHERE id LIKE 'br-test-%'`);
  };
  await clean();

  const { recordBookingRefund, resolveBooking, computeShare, backfillRefunds, RECOVERY_START_UNIX } = await import("./bookingRecoveries");
  let seq = 0;
  const appt = (id: string, o: Record<string, unknown> = {}) => ins("appointments", {
    id, business_id: "br-test-biz", client_id: "br-test-cl", appointment_date: "2026-11-01", appointment_time: `10:${String(seq++).padStart(2, "0")}`,
    total_price: 10000, status: "confirmed", stripe_payment_intent_id: `pi_${id}`, ...o,
  });

  try {
    console.log("computeShare");
    const base = { intendedPayout: 9800, base: 10000, amountReceived: 10800, sentNet: 9800, alreadyTaken: 0 };
    assert(computeShare({ ...base, refundCents: 10000 }) === 9800, "full refund takes all that was sent");
    assert(computeShare({ ...base, refundCents: 5000 }) === 4900, "50% of a $100 no-deposit booking with $98 sent = $49");
    assert(computeShare({ intendedPayout: 1960, base: 2000, amountReceived: 2160, sentNet: 1960, alreadyTaken: 0, refundCents: 1000 }) === 980, "deposit booking ratio is on the deposit");
    assert(computeShare({ intendedPayout: 1960, base: 2000, amountReceived: 2160, sentNet: 1960, alreadyTaken: 0, refundCents: 2000 }) === 1960, "full refund of the deposit takes the whole payout");
    assert(computeShare({ ...base, amountReceived: 6000, refundCents: 6000 }) === 9800, "points code (received < base), full refund = all");
    assert(computeShare({ ...base, amountReceived: 6000, refundCents: 3000 }) === 4900, "points code, half of what was received = half the payout");
    assert(computeShare({ ...base, sentNet: 8000, refundCents: 5000 }) === 4900, "unsent part never charged: 50% of 98 = 49, under the 80 sent");
    assert(computeShare({ ...base, sentNet: 8000, refundCents: 10000 }) === 8000, "unsent part never charged: 100% capped at 80 sent");
    const first = computeShare({ ...base, refundCents: 6000 });
    assert(first === 5880, "first 60% refund = 58.80", first);
    const second = computeShare({ ...base, refundCents: 6000, alreadyTaken: first });
    assert(second === 9800 - first, "two refunds never exceed sent: second capped to what is left", second);
    assert(first + second <= 9800, "sum never above sent");
    assert(computeShare({ ...base, refundCents: 20000 }) === 9800, "refund above base never exceeds the payout");
    assert(computeShare({ ...base, refundCents: 5000, alreadyTaken: 9800 }) === 0, "nothing left = 0");
    assert(computeShare({ ...base, refundCents: 5000, alreadyTaken: 12000 }) === 0, "over-taken is never negative");
    assert(computeShare({ ...base, refundCents: 0 }) === 0, "zero refund = 0");
    assert(computeShare({ ...base, sentNet: 0, refundCents: 5000 }) === 0, "nothing sent = 0");
    assert(computeShare({ ...base, amountReceived: 0, refundCents: 5000 }) >= 0, "zero received never negative");

    console.log("resolveBooking");
    await appt("br-test-a1");
    const a1 = await resolveBooking("pi_br-test-a1");
    assert(!!a1 && a1.type === "appointment" && a1.id === "br-test-a1" && a1.base === 10000 && a1.intendedPayout === 9800 && a1.recipient === "business", "appointment: base total_price, payout = base minus 2%, business", a1);
    await appt("br-test-a2", { deposit_amount_cents: 2500 });
    const a2 = await resolveBooking("pi_br-test-a2");
    assert(!!a2 && a2.base === 2500 && a2.intendedPayout === 2450, "deposit appointment: base = deposit", a2);
    await appt("br-test-a3", { staff_member_id: "br-test-staff" });
    const a3 = await resolveBooking("pi_br-test-a3");
    assert(a3?.recipient === "staff", "staff booking pays staff", a3);
    await ins("shoot_bookings", { id: "br-test-s1", photographer_id: "br-test-ph", client_id: "br-test-cl", shoot_type: "x", date: "2026-11-01", start_time: "10:00", end_time: "11:00", duration_hours: 1, total_price: 20000, vendor_net: 19000, deposit_amount_cents: 5000, stripe_payment_intent_id: "pi_br-test-s1", status: "confirmed" });
    const s1 = await resolveBooking("pi_br-test-s1");
    assert(!!s1 && s1.type === "shoot_booking" && s1.recipient === "photographer" && s1.intendedPayout === 19000 && s1.base === 5000, "shoot: photographer, payout = vendor_net, base = deposit", s1);
    assert((await resolveBooking("pi_br-test-unknown")) === null, "unknown PaymentIntent -> null (not_booking)");
    assert((await resolveBooking("pi_ticket_order_br-test-t1")) === null, "ticket-order PaymentIntent -> null");

    console.log("recordBookingRefund");
    await recordBookingRefund({ refundId: "br-test-r1", paymentIntentId: "pi_br-test-a1", refundCents: 500, createdUnix: RECOVERY_START_UNIX + 10 });
    await recordBookingRefund({ refundId: "br-test-r1", paymentIntentId: "pi_br-test-a1", refundCents: 500, createdUnix: RECOVERY_START_UNIX + 10 });
    const r1 = await q(`SELECT status FROM booking_refund_recoveries WHERE refund_id = 'br-test-r1'`);
    assert(r1.length === 1 && r1[0].status === "pending", "same refund twice records one row", r1);
    await recordBookingRefund({ refundId: "br-test-r0", paymentIntentId: "pi_br-test-a1", refundCents: 500, createdUnix: RECOVERY_START_UNIX - 1 });
    assert((await q(`SELECT 1 FROM booking_refund_recoveries WHERE refund_id = 'br-test-r0'`)).length === 0, "refund before the start date is skipped");

    console.log("backfillRefunds");
    await appt("br-test-b1", { refunded_at: new Date().toISOString(), refund_amount: 1000 });
    await appt("br-test-b2", { refunded_at: new Date(Date.now() - 90 * 86400000).toISOString(), refund_amount: 1000, updated_at: new Date(Date.now() - 90 * 86400000).toISOString() });
    await appt("br-test-b3", { status: "canceled", stripe_payment_intent_id: null });
    const asked: string[] = [];
    const fake = {
      listPaymentIntentRefunds: async (pi: string) => {
        asked.push(pi);
        if (pi === "pi_br-test-b1") return [
          { id: "br-test-rb1", amount: 1000, created: RECOVERY_START_UNIX + 50, status: "succeeded" },
          { id: "br-test-rb0", amount: 300, created: RECOVERY_START_UNIX - 50, status: "succeeded" },
        ];
        return [];
      },
    };
    await backfillRefunds(50, fake as any);
    await backfillRefunds(50, fake as any);
    const bf = await q(`SELECT refund_id, status, amount_cents, reference_id FROM booking_refund_recoveries WHERE refund_id LIKE 'br-test-rb%'`);
    assert(bf.length === 1 && bf[0].refund_id === "br-test-rb1" && bf[0].status === "pending" && bf[0].amount_cents === 0 && bf[0].reference_id === null, "backfill records the missed refund once, pending, computes nothing; pre-start refund skipped", bf);
    assert(asked.includes("pi_br-test-b1") && !asked.includes("pi_br-test-b2"), "only recent bookings with a PaymentIntent are asked about", asked);
    const failing = { listPaymentIntentRefunds: async () => { throw new Error("stripe down"); } };
    let threw = false;
    try { await backfillRefunds(50, failing as any); } catch { threw = true; }
    assert(!threw, "a Stripe failure on one booking does not throw out of the backfill");
  } finally {
    await clean();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
