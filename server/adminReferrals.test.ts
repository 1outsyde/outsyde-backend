/**
 * Admin referrals (referral Step 5b): list, pause, release, cancel, retry, and the payout job skipping paused payouts.
 * Run with:
 *   BREF_LOCAL_PG=postgresql://outsyde:outsyde@localhost:5432/outsyde DATABASE_URL=x \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/adminReferrals.test.ts
 *
 * SCRATCH ONLY. Same local Postgres and proxy as businessReferrals.test.ts. Stripe is a fake passed in.
 * Skips (exit 0) when BREF_LOCAL_PG is unset; refuses any non-local database.
 */
import crypto from "node:crypto";
import pg from "pg";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

(async () => {
  const PG = process.env.BREF_LOCAL_PG;
  if (!PG) { console.log("⏭  skipped: set BREF_LOCAL_PG to run"); process.exit(0); }
  if (!["localhost", "127.0.0.1"].includes(new URL(PG).hostname)) throw new Error("refusing to run: BREF_LOCAL_PG must be local");

  process.env.JWT_SECRET = process.env.JWT_SECRET || "aref-test-jwt";
  const br = await import("./referrals/businessReferrals");
  const ar = await import("./referrals/adminReferrals");
  const { computeHeld } = await import("./bankPayout");
  const pool = new pg.Pool({ connectionString: PG });
  const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;

  async function ins(table: string, values: Record<string, unknown>): Promise<string> {
    const cols = await q(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO' AND column_default IS NULL`, [table]);
    const row: Record<string, unknown> = { ...values };
    for (const c of cols) {
      if (c.column_name in row) continue;
      const t = String(c.data_type);
      row[c.column_name] =
        t.includes("int") || t === "numeric" || t.includes("double") || t === "real" ? 0 :
        t === "boolean" ? false :
        t.includes("timestamp") || t === "date" ? new Date() :
        t === "jsonb" || t === "json" ? "{}" :
        t === "ARRAY" ? "{}" :
        c.column_name === "id" ? crypto.randomUUID() : `t-${c.column_name}`;
    }
    const keys = Object.keys(row);
    const res = await q(
      `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
      keys.map((k) => row[k]));
    return String(res[0].id ?? res[0].user_id ?? "");
  }

  const S = Date.now().toString(36);
  let n = 0;
  const user = async (o: Record<string, unknown> = {}) => ins("users", {
    id: crypto.randomUUID(), email: `aref-${S}-${++n}@test.local`, username: `aref${S}${n}`, first_name: `Realname${n}`,
    is_active: true, deletion_status: "active", ...o,
  });
  const admin = await user({ is_admin: true });

  /** A referral with a payout row in the given state (no Stripe needed to set it up). */
  async function payout(state: Record<string, unknown> = {}) {
    const ref = await user();
    const owner = await user({ is_vendor: true });
    const biz = await ins("businesses", { id: crypto.randomUUID(), owner_id: owner, name: `Shop ${S} ${++n}`, category: "beauty", approval_status: "approved" });
    const refId = await ins("business_referrals", {
      id: crypto.randomUUID(), referrer_user_id: ref, business_id: biz, referred_owner_user_id: owner, code: "CODE1",
      status: "qualified", qualified_at: new Date(Date.now() - 8 * 86400000), expires_at: new Date(Date.now() + 80 * 86400000),
    });
    const pid = await ins("referral_payouts", {
      id: crypto.randomUUID(), business_referral_id: refId, recipient_user_id: ref, amount_cents: 2500, status: "pending",
      payable_after: new Date(Date.now() - 86400000), next_attempt_at: null, ...state,
    });
    // updated_at well in the past unless the test says otherwise, so it isn't treated as mid send.
    if (!("updated_at" in state)) await q(`UPDATE referral_payouts SET updated_at = now() - interval '1 hour' WHERE id=$1`, [pid]);
    return { pid, ref, owner, biz, refId };
  }
  const row = async (pid: string) => (await q(`SELECT * FROM referral_payouts WHERE id=$1`, [pid]))[0];
  const audits = async (pid: string, action: string) =>
    (await q(`SELECT * FROM audit_logs WHERE target_type='referral_payout' AND target_id=$1 AND action=$2`, [pid, action]));
  const neverCalled = {
    getPayoutReadiness: async () => { throw new Error("stripe called"); },
    findReferralPayoutTransfer: async () => { throw new Error("stripe called"); },
    createReferralPayoutTransfer: async () => { throw new Error("stripe called"); },
    getInvoicePaymentStanding: async () => { throw new Error("stripe called"); },
    isInsufficientFundsError: () => false,
  };

  console.log("\n1. Pause");
  {
    const a = await payout();
    const r = await ar.pauseReferralPayout(a.pid, admin);
    const p = await row(a.pid);
    assert(r.ok === true && p.status === "held" && p.hold_reason === ar.ADMIN_PAUSE_REASON && p.next_attempt_at === null, "pending payout paused (held, admin_paused)", p);
    const au = await audits(a.pid, ar.ACTION_PAUSE);
    assert(au.length === 1 && au[0].actor_id === admin && au[0].before_state.status === "pending" && au[0].after_state.status === "held", "one audit row with before and after", au);
    assert((await ar.pauseReferralPayout(a.pid, admin)).ok === false, "pausing twice is refused");
    assert(await br.sendReferralPayout(a.pid, neverCalled as any) === "not_due", "the job won't claim a paused payout (Stripe never called)");
    await br.runReferralPayoutJob(neverCalled as any);
    assert((await row(a.pid)).status === "held", "the minute job leaves it paused");
    const held = await computeHeld();
    assert(held.breakdown.referralPayoutsOpen >= 2500, "paused money stays reserved from the bank payout", held.breakdown);

    const h = await payout({ status: "held", hold_reason: "no_account", next_attempt_at: new Date(Date.now() + 3600000) });
    assert((await ar.pauseReferralPayout(h.pid, admin)).ok === true && (await row(h.pid)).hold_reason === ar.ADMIN_PAUSE_REASON, "a held (no account) payout can be paused too");

    for (const st of ["paid", "cancelled", "review"]) {
      const x = await payout({ status: st });
      const rr = await ar.pauseReferralPayout(x.pid, admin);
      assert(rr.ok === false && (rr as any).code === "NOT_PAUSABLE" && (await row(x.pid)).status === st, `${st}: not pausable, unchanged`, rr);
    }
    const missing = await ar.pauseReferralPayout(crypto.randomUUID(), admin);
    assert(missing.ok === false && (missing as any).code === "PAYOUT_NOT_FOUND", "unknown id: PAYOUT_NOT_FOUND");
  }

  console.log("\n2. Mid send is refused");
  {
    // What a claim looks like: touched just now, next try in 10 minutes.
    const a = await payout({ updated_at: new Date(), next_attempt_at: new Date(Date.now() + 10 * 60000) });
    await q(`UPDATE referral_payouts SET updated_at = now(), next_attempt_at = now() + interval '10 minutes' WHERE id=$1`, [a.pid]);
    const r1 = await ar.pauseReferralPayout(a.pid, admin);
    const r2 = await ar.cancelReferralPayout(a.pid, admin);
    assert(r1.ok === false && (r1 as any).code === "PAYOUT_SENDING" && r2.ok === false && (r2 as any).code === "PAYOUT_SENDING", "pause and cancel refused while it may be sending", [r1, r2]);
    assert((await row(a.pid)).status === "pending" && (await audits(a.pid, ar.ACTION_CANCEL)).length === 0, "row and audit untouched");

    const heldClaim = await payout({ status: "held", hold_reason: "no_account" });
    await q(`UPDATE referral_payouts SET updated_at = now(), next_attempt_at = now() + interval '10 minutes' WHERE id=$1`, [heldClaim.pid]);
    assert(((await ar.cancelReferralPayout(heldClaim.pid, admin)) as any).code === "PAYOUT_SENDING", "a held row being claimed is refused too");

    const waiting = await payout({ status: "held", hold_reason: "no_account" });
    await q(`UPDATE referral_payouts SET updated_at = now(), next_attempt_at = now() + interval '1 hour' WHERE id=$1`, [waiting.pid]);
    assert((await ar.pauseReferralPayout(waiting.pid, admin)).ok === true, "held and waiting an hour (not sending): pause allowed");
  }

  console.log("\n3. Release");
  {
    const a = await payout();
    await ar.pauseReferralPayout(a.pid, admin);
    const r = await ar.releaseReferralPayout(a.pid, admin);
    const p = await row(a.pid);
    assert(r.ok === true && p.status === "pending" && p.hold_reason === null && p.next_attempt_at === null, "released: pending, due now", p);
    assert((await audits(a.pid, ar.ACTION_RELEASE)).length === 1, "release audited");
    const not = await ar.releaseReferralPayout(a.pid, admin);
    assert(not.ok === false && (not as any).code === "NOT_PAUSED", "release of a payout that isn't paused: NOT_PAUSED");
    const h = await payout({ status: "held", hold_reason: "no_account" });
    assert(((await ar.releaseReferralPayout(h.pid, admin)) as any).code === "NOT_PAUSED" && (await row(h.pid)).hold_reason === "no_account", "a setup hold can't be released by admin");
  }

  console.log("\n4. Cancel");
  {
    for (const st of ["pending", "held", "review"]) {
      const a = await payout(st === "held" ? { status: st, hold_reason: "no_account" } : { status: st });
      const r = await ar.cancelReferralPayout(a.pid, admin);
      const p = await row(a.pid);
      assert(r.ok === true && p.status === "cancelled" && p.next_attempt_at === null && /admin/i.test(p.last_error ?? ""), `${st}: cancelled by admin`, p);
      assert((await audits(a.pid, ar.ACTION_CANCEL)).length === 1, `${st}: cancel audited`);
    }
    const paused = await payout();
    await ar.pauseReferralPayout(paused.pid, admin);
    assert((await ar.cancelReferralPayout(paused.pid, admin)).ok === true, "a paused payout can be cancelled");
    for (const st of ["paid", "cancelled"]) {
      const x = await payout({ status: st });
      const r = await ar.cancelReferralPayout(x.pid, admin);
      assert(r.ok === false && (r as any).code === "NOT_CANCELLABLE" && (await row(x.pid)).status === st, `${st}: not cancellable`);
    }
    const c = await payout();
    await ar.cancelReferralPayout(c.pid, admin);
    await br.runReferralPayoutJob(neverCalled as any);
    assert((await row(c.pid)).status === "cancelled", "the job never sends a cancelled payout");
  }

  console.log("\n5. Retry");
  {
    const a = await payout({ status: "review", attempts: 5, last_error: "boom", alerted_at: new Date() });
    const r = await ar.retryReferralPayout(a.pid, admin);
    const p = await row(a.pid);
    assert(r.ok === true && p.status === "pending" && p.attempts === 0 && p.last_error === null && p.next_attempt_at === null && p.alerted_at === null, "review back to pending, attempts 0", p);
    assert((await audits(a.pid, ar.ACTION_RETRY)).length === 1, "retry audited");
    for (const st of ["pending", "paid", "cancelled"]) {
      const x = await payout({ status: st });
      const rr = await ar.retryReferralPayout(x.pid, admin);
      assert(rr.ok === false && (rr as any).code === "NOT_IN_REVIEW", `${st}: NOT_IN_REVIEW`);
    }
  }

  console.log("\n6. Referrer view of a paused payout");
  {
    const a = await payout();
    await ar.pauseReferralPayout(a.pid, admin);
    const mine = await br.listBusinessReferralsFor(a.ref);
    const pp = mine.referrals[0]?.payout;
    assert(pp?.status === "review" && pp.holdReason === null, "the referrer sees 'we're checking', never 'set up payouts'", pp);
    assert(mine.totals.waitingCents === 2500, "still counted as on the way");
  }

  console.log("\n7. Admin list");
  {
    const a = await payout({ status: "review", attempts: 5, last_error: "card declined" });
    const b = await payout();
    await ar.pauseReferralPayout(b.pid, admin);
    const fr = await user(); const fd = await user();
    await ins("referrals", { id: crypto.randomUUID(), referrer_id: fr, referred_user_id: fd, status: "completed", referrer_bonus_points: 2500, referred_bonus_points: 2500, created_at: new Date() });
    const list = await ar.listAdminReferrals();
    const ba = list.business.find((x: any) => x.payout?.id === a.pid);
    assert(!!ba && ba.payout.status === "review" && ba.payout.attempts === 5 && ba.payout.lastError === "card declined" && typeof ba.referrer.username === "string" && typeof ba.businessName === "string", "business row with payout detail", ba);
    assert(list.business.find((x: any) => x.payout?.id === b.pid)?.payout.paused === true, "paused flag on a paused payout");
    assert(list.attention.some((x: any) => x.payoutId === a.pid && x.kind === "review") && list.attention.some((x: any) => x.payoutId === b.pid && x.kind === "paused"), "review and paused are in Needs attention", list.attention);
    const f = list.friends.find((x: any) => x.referrer.username && x.status === "completed");
    assert(!!f && f.referrerPoints === 2500 && f.friendPoints === 2500, "friend row with points", f);
    const text = JSON.stringify(list);
    assert(!/@test\.local/.test(text) && !/Realname/.test(text), "no email address or real name in the response");
    assert(typeof list.totals.business.invited === "number" && typeof list.totals.payouts.paidCents === "number" && typeof list.totals.friends.pointsAwarded === "number", "totals present", list.totals);
  }

  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
