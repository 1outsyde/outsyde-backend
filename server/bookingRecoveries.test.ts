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
    await q(`DELETE FROM event_payout_recoveries WHERE id LIKE 'br-test-%'`);
    await q(`DELETE FROM tickets WHERE id LIKE 'br-test-%'`);
    await q(`DELETE FROM event_payouts WHERE id LIKE 'br-test-%'`);
    await q(`DELETE FROM events WHERE id LIKE 'br-test-%'`);
    await q(`DELETE FROM booking_payout_issues WHERE id LIKE 'br-test-%'`);
    await q(`DELETE FROM staff_members WHERE id LIKE 'br-test-%'`);
    await q(`DELETE FROM photographers WHERE id LIKE 'br-test-%'`);
    await q(`DELETE FROM businesses WHERE id LIKE 'br-test-%'`);
    await q(`DELETE FROM users WHERE id LIKE 'br-test-%'`);
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

    // ─── Task 3: the recovery job, seller alerts, every-minute step ───────────
    await q(`DELETE FROM booking_refund_recoveries WHERE refund_id LIKE 'br-test-%'`);
    const { processBookingRecovery, retryOwed, notifyOwedSellers, alertOldOwed, runBookingRecoveryJob, setRecoveryNotifyForTest } = await import("./bookingRecoveries");
    const { setBankAlertForTest } = await import("./bankPayout");
    const sent: any[] = [];
    setRecoveryNotifyForTest(async (m: any) => { sent.push(m); });
    const admin: Array<{ subject: string; detail: string }> = [];
    setBankAlertForTest(async (subject: string, detail: string) => { admin.push({ subject, detail }); });

    // Seller records: business (owner + contact email), staff member (own account), photographer, event host.
    await ins("users", { id: "br-test-u-owner", username: "br-test-u-owner", email: "br-test-owner@example.test" });
    await ins("users", { id: "br-test-u-staff", username: "br-test-u-staff", email: "br-test-staffuser@example.test" });
    await ins("users", { id: "br-test-u-ph", username: "br-test-u-ph", email: "br-test-ph@example.test" });
    await ins("users", { id: "br-test-u-host", username: "br-test-u-host", email: "br-test-host@example.test" });
    await ins("businesses", { id: "br-test-biz", owner_id: "br-test-u-owner", name: "BR Test Biz", category: "beauty", contact_email: "br-test-biz@example.test", stripe_account_id: "acct_br_biz" });
    await ins("staff_members", { id: "br-test-staff", business_id: "br-test-biz", display_name: "BR Staff", email: "br-test-staff@example.test", user_id: "br-test-u-staff", stripe_account_id: "acct_br_staff" });
    await ins("photographers", { id: "br-test-ph", user_id: "br-test-u-ph", display_name: "BR Ph", hourly_rate: 100, stripe_account_id: "acct_br_ph" });

    // Fake Stripe: transfers by group, reversals with metadata.refundId, idempotency replay, failure switches.
    type T = { id: string; group: string; amount: number; amountReversed: number; destination: string };
    type R = { id: string; transferId: string; amount: number; refundId: string; key: string };
    const fs = {
      transfers: [] as T[],
      reversals: [] as R[],
      refunds: new Map<string, Array<{ id: string; amount: number; created: number; status: string }>>(),
      received: new Map<string, number>(),
      insufficientFor: new Set<string>(), // transfer ids whose reversal is refused for low balance
      landsButThrows: 0, // next N reversals land at Stripe, then the reply is lost
      failReverse: 0, // next N reversals fail with an unknown error and nothing lands
      reverseDelayMs: 0,
      calls: [] as Array<{ fn: string; arg: any; opts: any }>,
      seq: 0,
    };
    const bounded = (o: any) => o && o.timeoutMs === 30000 && o.maxNetworkRetries === 1;
    const fk: any = {
      listBookingTransfers: async (group: string, opts: any) => {
        fs.calls.push({ fn: "listBookingTransfers", arg: group, opts });
        return fs.transfers.filter((t) => t.group === group).map((t) => ({ id: t.id, amount: t.amount, amountReversed: t.amountReversed, destination: t.destination }));
      },
      listPaymentIntentRefunds: async (pi: string, opts: any) => {
        fs.calls.push({ fn: "listPaymentIntentRefunds", arg: pi, opts });
        return fs.refunds.get(pi) ?? [];
      },
      findRecoveryReversals: async (transferId: string, refundId: string, opts: any) => {
        fs.calls.push({ fn: "findRecoveryReversals", arg: { transferId, refundId }, opts });
        return fs.reversals.filter((r) => r.transferId === transferId && r.refundId === refundId).map((r) => ({ id: r.id, amount: r.amount }));
      },
      reverseForRecovery: async (p: any) => {
        fs.calls.push({ fn: "reverseForRecovery", arg: p, opts: p });
        if (fs.reverseDelayMs) await new Promise((res) => setTimeout(res, fs.reverseDelayMs));
        const replay = fs.reversals.find((r) => r.key === p.idempotencyKey);
        if (replay) return { id: replay.id };
        if (fs.failReverse > 0) { fs.failReverse--; throw new Error("stripe unknown error"); }
        if (fs.insufficientFor.has(p.transferId)) { const e: any = new Error("Insufficient funds in Stripe account"); e.code = "balance_insufficient"; throw e; }
        const t = fs.transfers.find((x) => x.id === p.transferId);
        if (!t || p.amountCents > t.amount - t.amountReversed || p.amountCents <= 0) throw new Error("invalid reversal amount");
        t.amountReversed += p.amountCents;
        const r = { id: `trr_${++fs.seq}`, transferId: p.transferId, amount: p.amountCents, refundId: p.refundId, key: p.idempotencyKey };
        fs.reversals.push(r);
        if (fs.landsButThrows > 0) { fs.landsButThrows--; throw new Error("socket hang up"); }
        return { id: r.id };
      },
      getPaymentIntentAmountReceived: async (pi: string, opts: any) => {
        fs.calls.push({ fn: "getPaymentIntentAmountReceived", arg: pi, opts });
        return fs.received.get(pi) ?? 0;
      },
      isInsufficientFundsError: (err: any) => err?.code === "balance_insufficient",
    };
    const reverses = () => fs.calls.filter((c) => c.fn === "reverseForRecovery");
    const resetCalls = () => { fs.calls.length = 0; };
    const row = async (refundId: string) => (await q(`SELECT * FROM booking_refund_recoveries WHERE refund_id = $1`, [refundId]))[0];
    const idOf = async (refundId: string) => String((await row(refundId)).id);
    /** Make a row due and unlocked, as if its lock or backoff ran out long ago. */
    const due = async (refundId: string) => q(`UPDATE booking_refund_recoveries SET next_attempt_at = now() - interval '1 second', updated_at = now() - interval '11 minutes' WHERE refund_id = $1`, [refundId]);
    let tseq = 0;
    /** A booking (appointment unless shoot) with its transfers, a succeeded refund and a recorded pending row. */
    const booking = async (key: string, o: { transfers?: number[]; refund: number; staff?: boolean; shoot?: boolean; deposit?: number; status?: string; total?: number; received?: number; dest?: string }) => {
      const id = `br-test-${key}`;
      const pi = `pi_${id}`;
      if (o.shoot) {
        await ins("shoot_bookings", { id, photographer_id: "br-test-ph", client_id: "br-test-cl", shoot_type: "x", date: "2026-11-02", start_time: "10:00", end_time: "11:00", duration_hours: 1, total_price: o.total ?? 20000, vendor_net: Math.round((o.total ?? 20000) * 0.98), stripe_payment_intent_id: pi, status: "confirmed" });
      } else {
        await appt(id, { appointment_date: "2026-11-03", total_price: o.total ?? 10000, deposit_amount_cents: o.deposit ?? null, ...(o.staff ? { staff_member_id: "br-test-staff" } : {}) });
      }
      const group = o.shoot ? `shoot_booking_${id}` : `appointment_${id}`;
      const dest = o.dest ?? (o.shoot ? "acct_br_ph" : o.staff ? "acct_br_staff" : "acct_br_biz");
      for (const amt of o.transfers ?? [9800]) fs.transfers.push({ id: `tr_br_${++tseq}`, group, amount: amt, amountReversed: 0, destination: dest });
      fs.received.set(pi, Math.round((o.deposit ?? o.total ?? (o.shoot ? 20000 : 10000)) * 1.08));
      if (o.received != null) fs.received.set(pi, o.received);
      const refundId = `br-test-re-${key}`;
      fs.refunds.set(pi, [...(fs.refunds.get(pi) ?? []), { id: refundId, amount: o.refund, created: RECOVERY_START_UNIX + 100, status: o.status ?? "succeeded" }]);
      await recordBookingRefund({ refundId, paymentIntentId: pi, refundCents: o.refund, createdUnix: RECOVERY_START_UNIX + 100 });
      return { id, pi, refundId, group };
    };

    console.log("processBookingRecovery");
    {
      const b = await booking("full", { refund: 10000 });
      resetCalls();
      const res = await processBookingRecovery(await idOf(b.refundId), fk);
      const r = await row(b.refundId);
      assert(res === "reversed" && r.status === "reversed" && r.amount_cents === 9800 && r.reversed_cents === 9800, "full reverse: whole transfer taken back, status reversed", { res, r });
      assert(r.reference_type === "appointment" && r.reference_id === b.id && r.recipient === "business" && r.connected_account_id === "acct_br_biz", "booking, recipient and the transfer's Connect account recorded", r);
      const rv = reverses();
      assert(rv.length === 1 && rv[0].arg.amountCents === 9800 && rv[0].arg.refundId === b.refundId && rv[0].arg.bookingType === "appointment" && rv[0].arg.bookingId === b.id, "one reversal with refund and booking metadata", rv.map((c) => c.arg));
      assert(new RegExp(`^booking_recovery_${b.refundId}_${rv[0].arg.transferId}_\\d+$`).test(rv[0].arg.idempotencyKey), "idempotency key booking_recovery_<refundId>_<transferId>_<claim micros>", rv[0].arg.idempotencyKey);
      assert(fs.calls.every((c) => bounded(c.opts)), "every Stripe call bounded 30 s, 1 retry", fs.calls.filter((c) => !bounded(c.opts)).map((c) => c.fn));
      const fi = fs.calls.findIndex((c) => c.fn === "findRecoveryReversals");
      const ri = fs.calls.findIndex((c) => c.fn === "reverseForRecovery");
      assert(fi >= 0 && fi < ri, "reversals looked up before the reverse");
      assert(String(r.reversal_ids) === fs.reversals[fs.reversals.length - 1].id, "reversal id saved", r.reversal_ids);
      assert((await processBookingRecovery(r.id, fk)) === "not_due" && reverses().length === 1, "a reversed row is never taken again");
    }
    {
      const b = await booking("part", { refund: 5000 });
      const res = await processBookingRecovery(await idOf(b.refundId), fk);
      const r = await row(b.refundId);
      assert(res === "reversed" && r.amount_cents === 4900 && r.reversed_cents === 4900, "partial: half refund takes back 49.00 of 98.00", r);
    }
    {
      const b = await booking("two", { refund: 10000, transfers: [1800, 8000] });
      resetCalls();
      const res = await processBookingRecovery(await idOf(b.refundId), fk);
      const rv = reverses().map((c) => c.arg);
      const base = fs.transfers.find((t) => t.group === b.group && t.amount === 8000)!;
      assert(res === "reversed" && rv.length === 2 && rv[0].transferId === base.id && rv[0].amountCents === 8000 && rv[1].amountCents === 1800, "two transfers (base + rewards): largest first, both reversed", rv);
      assert(rv[0].idempotencyKey !== rv[1].idempotencyKey, "one key per transfer");
      const b2 = await booking("two-part", { refund: 5000, transfers: [1800, 8000] });
      resetCalls();
      await processBookingRecovery(await idOf(b2.refundId), fk);
      const rv2 = reverses().map((c) => c.arg);
      assert(rv2.length === 1 && rv2[0].amountCents === 4900 && fs.transfers.find((t) => t.id === rv2[0].transferId)!.amount === 8000, "partial on two transfers: all from the largest", rv2);
    }
    {
      const b = await booking("race", { refund: 10000 });
      const id = await idOf(b.refundId);
      resetCalls();
      fs.reverseDelayMs = 150;
      const out = await Promise.all([processBookingRecovery(id, fk), processBookingRecovery(id, fk), processBookingRecovery(id, fk)]);
      fs.reverseDelayMs = 0;
      assert(reverses().length === 1 && out.filter((x) => x === "reversed").length === 1 && out.filter((x) => x === "not_due").length === 2, "two runs at once reverse once", out);
    }
    {
      const b = await booking("lost", { refund: 10000 });
      fs.landsButThrows = 1;
      const first = await processBookingRecovery(await idOf(b.refundId), fk);
      const mid = await row(b.refundId);
      assert(first === "retry" && mid.status === "pending" && mid.amount_cents === 9800, "lost reply: stays pending with backoff, amount fixed", { first, mid });
      assert(new Date(mid.next_attempt_at).getTime() > Date.now() + 9 * 60000, "backoff at least the 10 minute lock", mid.next_attempt_at);
      await due(b.refundId);
      resetCalls();
      const second = await processBookingRecovery(mid.id, fk);
      const r = await row(b.refundId);
      assert(second === "reversed" && reverses().length === 0 && r.reversed_cents === 9800 && fs.reversals.filter((x) => x.refundId === b.refundId).length === 1, "lost reversal response is recorded (found by lookup, never reversed twice)", { second, r });
    }
    {
      const b = await booking("insuf", { refund: 10000, transfers: [1800, 8000] });
      const rewards = fs.transfers.find((t) => t.group === b.group && t.amount === 1800)!;
      fs.insufficientFor.add(rewards.id);
      resetCalls();
      const res = await processBookingRecovery(await idOf(b.refundId), fk);
      const r = await row(b.refundId);
      assert(res === "owed" && r.status === "owed" && r.amount_cents === 9800 && r.reversed_cents === 8000 && r.owed_at !== null, "insufficient -> owed, reversed_cents kept (only the rest is owed)", r);
      const finds = fs.calls.filter((c) => c.fn === "findRecoveryReversals").length;
      assert(finds >= 4, "one more lookup on every transfer before owing", finds);
      assert(new Date(r.next_attempt_at).getTime() > Date.now() + 55 * 60000, "owed retried once an hour", r.next_attempt_at);

      console.log("retryOwed");
      await q(`UPDATE booking_refund_recoveries SET updated_at = now() - interval '20 minutes', owed_at = now() - interval '20 minutes' WHERE refund_id = $1`, [b.refundId]);
      await retryOwed();
      assert(new Date((await row(b.refundId)).next_attempt_at).getTime() > Date.now(), "owed: no newer transfer, not due yet");
      // A business payout after the debt (settled booking with a transfer to the same account).
      await appt("br-test-newer", { appointment_date: "2026-11-04", settled_at: new Date().toISOString(), stripe_transfer_id: "tr_br_newer", stripe_payment_intent_id: null });
      await retryOwed();
      const d = await row(b.refundId);
      assert(new Date(d.next_attempt_at).getTime() <= Date.now() + 1000, "owed -> due now after a newer settled booking to the same account", d.next_attempt_at);
      fs.insufficientFor.delete(rewards.id);
      resetCalls();
      const rec = await processBookingRecovery(d.id, fk);
      const done = await row(b.refundId);
      assert(rec === "reversed" && done.status === "recovered" && done.reversed_cents === 9800 && done.recovered_at !== null, "owed -> retried -> recovered", done);
      assert(reverses().length === 1 && reverses()[0].arg.amountCents === 1800, "only the owed rest is reversed", reverses().map((c) => c.arg));
    }
    {
      const b = await booking("staffdebt", { refund: 10000, staff: true });
      const t = fs.transfers.find((x) => x.group === b.group)!;
      fs.insufficientFor.add(t.id);
      const res = await processBookingRecovery(await idOf(b.refundId), fk);
      const r0 = await row(b.refundId);
      assert(res === "owed" && r0.recipient === "staff" && r0.connected_account_id === "acct_br_staff", "staff booking owed on the staff account", r0);
      await q(`UPDATE booking_refund_recoveries SET updated_at = now() - interval '20 minutes', owed_at = now() - interval '20 minutes' WHERE refund_id = $1`, [b.refundId]);
      await appt("br-test-bizpay", { appointment_date: "2026-11-05", settled_at: new Date().toISOString(), stripe_transfer_id: "tr_br_bizpay", stripe_payment_intent_id: null });
      await retryOwed();
      assert(new Date((await row(b.refundId)).next_attempt_at).getTime() > Date.now() + 30 * 60000, "staff debt not retried by a business payout");
      await ins("booking_payout_issues", { id: "br-test-iss1", reference_type: "appointment", reference_id: "br-test-other", recipient_key: "staff", is_base: true, connected_account_id: "acct_br_staff", amount_cents: 500, status: "paid", resolved_at: new Date().toISOString(), transfer_id: "tr_br_iss" });
      await retryOwed();
      assert(new Date((await row(b.refundId)).next_attempt_at).getTime() <= Date.now() + 1000, "staff debt retried after a paid payout retry to the staff account");
      // Event payout to the business account makes a business debt due; never touches event recoveries.
      fs.insufficientFor.delete(t.id);
      await processBookingRecovery(r0.id, fk);
    }
    {
      // A row in flight (just claimed) is never made due by retryOwed.
      const b = await booking("inflight", { refund: 10000 });
      const t = fs.transfers.find((x) => x.group === b.group)!;
      fs.insufficientFor.add(t.id);
      await processBookingRecovery(await idOf(b.refundId), fk);
      await q(`UPDATE booking_refund_recoveries SET owed_at = now() - interval '1 hour', next_attempt_at = now() + interval '10 minutes', updated_at = now() - interval '1 minute' WHERE refund_id = $1`, [b.refundId]);
      await appt("br-test-newer2", { appointment_date: "2026-11-06", settled_at: new Date().toISOString(), stripe_transfer_id: "tr_br_newer2", stripe_payment_intent_id: null });
      await retryOwed();
      assert(new Date((await row(b.refundId)).next_attempt_at).getTime() > Date.now() + 5 * 60000, "retryOwed leaves a row inside its lock alone");
      fs.insufficientFor.delete(t.id);
    }
    {
      const b = await booking("five", { refund: 10000 });
      const id = await idOf(b.refundId);
      fs.failReverse = 100;
      resetCalls();
      const outs: string[] = [];
      for (let i = 0; i < 5; i++) { outs.push(await processBookingRecovery(id, fk)); await due(b.refundId); }
      const tries = reverses().length;
      const last = await processBookingRecovery(id, fk);
      fs.failReverse = 0;
      const r = await row(b.refundId);
      assert(outs.every((x) => x === "retry") && tries === 5, "5 failed tries each sent one reversal", { outs, tries });
      assert(last === "owed" && reverses().length === 5 && r.status === "owed" && r.reversed_cents === 0, "after 5 failures: lookup only, then owed", { last, r });
    }
    {
      // Lookup only, but a timed-out reversal did land: recorded, not owed.
      const b = await booking("five-landed", { refund: 10000 });
      const id = await idOf(b.refundId);
      fs.landsButThrows = 1;
      await processBookingRecovery(id, fk);
      fs.failReverse = 100;
      for (let i = 0; i < 5; i++) { await due(b.refundId); await processBookingRecovery(id, fk); }
      fs.failReverse = 0;
      const r = await row(b.refundId);
      assert(r.status === "reversed" && r.reversed_cents === 9800, "a landed reversal is found by the lookup, never owed", r);
    }

    console.log("rulings");
    {
      const b = await booking("rpending", { refund: 10000, status: "pending" });
      resetCalls();
      const res = await processBookingRecovery(await idOf(b.refundId), fk);
      const r = await row(b.refundId);
      assert(res === "retry" && r.status === "pending" && r.attempts === 0 && r.amount_cents === 0 && reverses().length === 0, "refund still pending on Stripe: waits, try given back, nothing reversed", { res, r });
      fs.refunds.get(b.pi)![0].status = "succeeded";
      await due(b.refundId);
      assert((await processBookingRecovery(r.id, fk)) === "reversed", "refund succeeded later: reversed");
      const bf = await booking("rfailed", { refund: 10000, status: "failed" });
      resetCalls();
      const rf = await processBookingRecovery(await idOf(bf.refundId), fk);
      const rr = await row(bf.refundId);
      assert(rf === "nothing_sent" && rr.status === "nothing_sent" && rr.amount_cents === 0 && reverses().length === 0, "failed refund: nothing_sent, amount 0", rr);
    }
    {
      await recordBookingRefund({ refundId: "br-test-re-ticket", paymentIntentId: "pi_ticket_order_br-test", refundCents: 3000, createdUnix: RECOVERY_START_UNIX + 5 });
      fs.refunds.set("pi_ticket_order_br-test", [{ id: "br-test-re-ticket", amount: 3000, created: RECOVERY_START_UNIX + 5, status: "succeeded" }]);
      resetCalls();
      const res = await processBookingRecovery(await idOf("br-test-re-ticket"), fk);
      const r = await row("br-test-re-ticket");
      assert(res === "not_booking" && r.status === "not_booking" && reverses().length === 0, "ticket refund (no booking): not_booking, no reversal", r);
    }
    {
      const b = await booking("notransfer", { refund: 10000, transfers: [] });
      const res = await processBookingRecovery(await idOf(b.refundId), fk);
      const r = await row(b.refundId);
      assert(res === "nothing_sent" && r.status === "nothing_sent" && r.amount_cents === 0, "no transfers in the group: nothing_sent, amount 0", r);
    }
    {
      // Two refunds on one booking: the second is capped by what the first fixed.
      const b = await booking("tworef", { refund: 6000 });
      await processBookingRecovery(await idOf(b.refundId), fk);
      fs.refunds.get(b.pi)!.push({ id: "br-test-re-tworef2", amount: 6000, created: RECOVERY_START_UNIX + 200, status: "succeeded" });
      await recordBookingRefund({ refundId: "br-test-re-tworef2", paymentIntentId: b.pi, refundCents: 6000, createdUnix: RECOVERY_START_UNIX + 200 });
      await processBookingRecovery(await idOf("br-test-re-tworef2"), fk);
      const r1 = await row(b.refundId);
      const r2 = await row("br-test-re-tworef2");
      assert(r1.amount_cents === 5880 && r2.amount_cents === 3920 && r1.reversed_cents + r2.reversed_cents === 9800, "second refund takes only what is left (never more than sent)", { r1: r1.amount_cents, r2: r2.amount_cents });
    }
    {
      // While one row of a booking is claimed with no amount fixed, a sibling is not claimed.
      const b = await booking("sib", { refund: 3000 });
      fs.refunds.get(b.pi)!.push({ id: "br-test-re-sib2", amount: 3000, created: RECOVERY_START_UNIX + 200, status: "succeeded" });
      await recordBookingRefund({ refundId: "br-test-re-sib2", paymentIntentId: b.pi, refundCents: 3000, createdUnix: RECOVERY_START_UNIX + 200 });
      await q(`UPDATE booking_refund_recoveries SET next_attempt_at = now() + interval '10 minutes', updated_at = now() WHERE refund_id = $1`, [b.refundId]);
      assert((await processBookingRecovery(await idOf("br-test-re-sib2"), fk)) === "not_due" && (await row("br-test-re-sib2")).amount_cents === 0, "sibling skipped while another row of the booking is claimed unfixed");
    }

    console.log("notifyOwedSellers");
    {
      sent.length = 0;
      // Earlier owed rows from this run (staffdebt was recovered; insuf recovered): set up fresh owed rows.
      const b = await booking("nbiz", { refund: 10000 });
      const t = fs.transfers.find((x) => x.group === b.group)!;
      fs.insufficientFor.add(t.id);
      await processBookingRecovery(await idOf(b.refundId), fk);
      const bs = await booking("nstaff", { refund: 5000, staff: true });
      fs.insufficientFor.add(fs.transfers.find((x) => x.group === bs.group)!.id);
      await processBookingRecovery(await idOf(bs.refundId), fk);
      const bp = await booking("nph", { refund: 20000, shoot: true, total: 20000 });
      fs.insufficientFor.add(fs.transfers.find((x) => x.group === bp.group)!.id);
      await processBookingRecovery(await idOf(bp.refundId), fk);
      await q(`UPDATE booking_refund_recoveries SET seller_notified_at = now() WHERE status = 'owed' AND refund_id NOT IN ($1, $2, $3)`, [b.refundId, bs.refundId, bp.refundId]);

      await notifyOwedSellers();
      await notifyOwedSellers();
      const biz = sent.filter((m) => m.to === "br-test-biz@example.test" || m.userId === "br-test-u-owner");
      const bizBody = biz.find((m) => m.channel === "email" && m.text.includes("$100.00"));
      assert(!!bizBody && bizBody.subject === "Money owed for a refund" && bizBody.kind === "booking", "business owner emailed at the contact email, kind booking", biz);
      assert(bizBody?.text === "A customer was refunded $100.00 for your booking on November 3, 2026. Your Stripe balance didn't cover your share of $98.00, so it will be taken from your next payout.", "booking copy exact", bizBody?.text);
      const staffMsgs = sent.filter((m) => m.to === "br-test-staff@example.test" || m.userId === "br-test-u-staff");
      assert(staffMsgs.filter((m) => m.channel === "email").length === 1 && staffMsgs.filter((m) => m.channel === "push").length === 1 && staffMsgs[0].kind === "staff", "staff case notifies the staff member (email + push)", staffMsgs);
      const ownerForStaff = sent.filter((m) => (m.to === "br-test-biz@example.test" || m.userId === "br-test-u-owner") && (m.text ?? m.body).includes("$50.00"));
      assert(ownerForStaff.filter((m) => m.channel === "email").length === 1 && ownerForStaff.filter((m) => m.channel === "push").length === 1, "staff case also notifies the business owner", ownerForStaff);
      const bizOnly = sent.filter((m) => (m.to === "br-test-biz@example.test" || m.userId === "br-test-u-owner") && (m.text ?? m.body).includes("$100.00"));
      assert(bizOnly.filter((m) => m.channel === "email").length === 1 && bizOnly.filter((m) => m.channel === "push").length === 1, "seller notified once (email + push), second run sends nothing", bizOnly);
      const ph = sent.filter((m) => m.to === "br-test-ph@example.test" || m.userId === "br-test-u-ph");
      assert(ph.length === 2 && ph.some((m) => m.channel === "email" && m.kind === "shoot"), "photographer notified (email + push), kind shoot", ph);
      fs.insufficientFor.clear();
    }
    {
      sent.length = 0;
      await ins("events", { id: "br-test-ev1", host_user_id: "br-test-u-host", slug: "br-test-ev1", title: "Night Market", starts_at: "2026-10-01T20:00:00Z", ends_at: "2026-10-01T23:00:00Z", timezone: "America/New_York" });
      await ins("event_payouts", { id: "br-test-ep1", event_id: "br-test-ev1", destination_type: "user", connected_account_id: "acct_br_host", gross_cents: 5000, deducted_cents: 0, amount_cents: 5000, status: "paid", transfer_id: "tr_br_ep1", paid_at: new Date().toISOString() });
      await ins("tickets", { id: "br-test-tk1", order_id: "br-test-o1", order_item_id: "br-test-oi1", event_id: "br-test-ev1", ticket_type_id: "br-test-tt", holder_user_id: "br-test-u-owner", item_index: 1, code: "br-test-c1", status: "refunded", price_cents: 2500, platform_fee_cents: 50, host_net_cents: 2450 });
      await ins("tickets", { id: "br-test-tk0", order_id: "br-test-o1", order_item_id: "br-test-oi1", event_id: "br-test-ev1", ticket_type_id: "br-test-tt", holder_user_id: "br-test-u-owner", item_index: 2, code: "br-test-c0", status: "refunded", price_cents: 2500, platform_fee_cents: 50, host_net_cents: 2450 });
      await ins("event_payout_recoveries", { id: "br-test-epr1", ticket_id: "br-test-tk1", payout_id: "br-test-ep1", connected_account_id: "acct_br_host", amount_cents: 2450, status: "owed" });
      await ins("event_payout_recoveries", { id: "br-test-epr0", ticket_id: "br-test-tk0", payout_id: "br-test-ep1", connected_account_id: "acct_br_host", amount_cents: 2450, status: "owed", created_at: new Date((RECOVERY_START_UNIX - 3600) * 1000).toISOString() });
      await notifyOwedSellers();
      await notifyOwedSellers();
      const host = sent.filter((m) => m.to === "br-test-host@example.test" || m.userId === "br-test-u-host");
      assert(host.filter((m) => m.channel === "email").length === 1 && host.filter((m) => m.channel === "push").length === 1, "event owed recovery: host notified once (email + push)", host);
      assert(host.find((m) => m.channel === "email")?.text === "A customer was refunded $25.00 for your event Night Market. Your Stripe balance didn't cover your share of $24.50, so it will be taken from your next payout." && host[0].kind === "ticket", "event copy exact, kind ticket", host);
      const old = (await q(`SELECT seller_notified_at FROM event_payout_recoveries WHERE id = 'br-test-epr0'`))[0];
      assert(old.seller_notified_at === null, "old event recovery (owed before the start date) never notified", old);

      // retryOwed never touches event recoveries.
      await q(`UPDATE event_payout_recoveries SET next_attempt_at = now() + interval '1 day', updated_at = now() - interval '1 hour' WHERE id = 'br-test-epr1'`);
      const before = (await q(`SELECT next_attempt_at, updated_at::text AS u FROM event_payout_recoveries WHERE id = 'br-test-epr1'`))[0];
      await retryOwed();
      const after = (await q(`SELECT next_attempt_at, updated_at::text AS u FROM event_payout_recoveries WHERE id = 'br-test-epr1'`))[0];
      assert(String(before.next_attempt_at) === String(after.next_attempt_at) && before.u === after.u, "retryOwed leaves event recoveries alone");
    }
    {
      const all = sent.concat([]);
      const texts = all.map((m) => `${m.subject ?? m.title} ${m.text ?? m.body}`);
      assert(texts.length > 0 && texts.every((x) => !/ - | – | — |—|–/.test(x) && !x.includes("8%")), "copy has no dash separators and no 8%", texts);
    }

    console.log("alertOldOwed");
    {
      admin.length = 0;
      await q(`UPDATE booking_refund_recoveries SET owed_at = now() - interval '31 days' WHERE refund_id = 'br-test-re-nbiz'`);
      const n1 = await alertOldOwed();
      const n2 = await alertOldOwed();
      assert(n1 === 1 && n2 === 0 && admin.length === 1 && admin[0].subject.startsWith("[Payouts] ") && (await row("br-test-re-nbiz")).alerted_at !== null, "admin email after 30 days, once, [Payouts] prefix", { n1, n2, admin });
    }

    console.log("runBookingRecoveryJob");
    {
      const b = await booking("job", { refund: 10000 });
      const out = await runBookingRecoveryJob(fk);
      const r = await row(b.refundId);
      assert(r.status === "reversed" && out.reversed >= 1, "the job processes due rows", { out, r });
      const throwing = { ...fk, listPaymentIntentRefunds: async () => { throw new Error("down"); } };
      let threw = false;
      try { await runBookingRecoveryJob(throwing); } catch { threw = true; }
      assert(!threw, "a failing step never throws out of the job");
    }
    const { readFileSync } = await import("fs");
    const bsm = readFileSync(new URL("./bookingStateMachine.ts", import.meta.url), "utf8");
    const bankIdx = bsm.indexOf('await import("./bankPayout")');
    const recIdx = bsm.indexOf('await import("./bookingRecoveries")');
    assert(bankIdx > 0 && recIdx > bankIdx && /runBookingRecoveryJob\(\)/.test(bsm.slice(recIdx)), "every-minute step added after the bank payout step");
    setRecoveryNotifyForTest(null);
    setBankAlertForTest(null);
  } finally {
    await clean();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
