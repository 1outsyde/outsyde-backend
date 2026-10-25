/**
 * Business referral cash (referral Step 4) — run with:
 *   BREF_LOCAL_PG=postgresql://outsyde:outsyde@localhost:5432/outsyde DATABASE_URL=x \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/businessReferrals.test.ts
 *
 * SCRATCH ONLY. Local Postgres built from shared/schema.ts plus migrations (072 included), reached through
 * .dev/neon-local-proxy.mjs (LOCAL_PG_URL must point at the same database). Stripe is a fake passed in.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const PG = process.env.BREF_LOCAL_PG;
  if (!PG) { console.log("⏭  skipped: set BREF_LOCAL_PG to run"); process.exit(0); }
  if (!["localhost", "127.0.0.1"].includes(new URL(PG).hostname)) throw new Error("refusing to run: BREF_LOCAL_PG must be local");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "bref-test-jwt";

  const br = await import("./referrals/businessReferrals");
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
    id: crypto.randomUUID(), email: `bref-${S}-${++n}@test.local`, username: `bref${S}${n}`, is_active: true, deletion_status: "active", ...o,
  });
  const codeFor = async (u: string) => { const c = `R${S.toUpperCase().slice(-5)}${n}${Math.floor(Math.random() * 90 + 10)}`.slice(0, 20); await q(`UPDATE users SET referral_code=$2 WHERE id=$1`, [u, c]); return c; };
  let tierId: string | null = null;
  const tier = async () => tierId ?? (tierId = await ins("subscription_tiers", { id: crypto.randomUUID(), name: `Growth ${S}`, price_in_cents: 4999, stripe_price_id: "price_test" }));

  /** A business with every fact true except the ones turned off. */
  async function business(owner: string, off: Partial<Record<"approved" | "paid" | "active" | "post" | "live", boolean>> = {}, extra: Record<string, unknown> = {}) {
    const id = await ins("businesses", {
      id: crypto.randomUUID(), owner_id: owner, name: `Shop ${S} ${++n}`, category: "beauty",
      approval_status: off.approved === false ? "pending" : "approved", is_demo: false,
      stripe_account_id: `acct_shop_${S}_${n}`, stripe_onboarding_complete: true, ...extra,
    });
    await ins("vendor_subscriptions", {
      id: crypto.randomUUID(), vendor_id: owner, business_id: id, tier_id: await tier(),
      stripe_subscription_id: `sub_${S}_${n}`, status: off.active === false ? "past_due" : "active",
      first_paid_at: off.paid === false ? null : new Date(), first_paid_invoice_id: off.paid === false ? null : `in_${n}`,
    });
    if (off.post !== false) await ins("feed_posts", { id: crypto.randomUUID(), author_id: owner, author_type: "vendor", post_type: "photo", is_active: true });
    if (off.live !== false) await ins("vendor_services", { id: crypto.randomUUID(), business_id: id, name: "Braids", price: 10000, duration_minutes: 60, status: "live", is_active: true });
    return id;
  }

  let setupOk = true;
  br.setSetupCheckForTest(async () => setupOk);

  // Fake Stripe: records creates, answers lookups from them.
  type T = { id: string; group: string; payoutId: string; amount: number; key: string; destination: string };
  const made: T[] = [];
  const fake = (o: { ready?: (acct: string) => boolean; standing?: string; createError?: Error; insufficient?: boolean } = {}) => ({
    getPayoutReadiness: async (acct: string) => ({ ready: o.ready ? o.ready(acct) : true }),
    findReferralPayoutTransfer: async (refId: string, payoutId: string) => {
      const t = made.find((x) => x.group === `referral_${refId}` && x.payoutId === payoutId);
      return t ? { id: t.id, amount: t.amount } : null;
    },
    createReferralPayoutTransfer: async (p: any) => {
      if (o.createError) throw o.createError;
      await sleep(30);
      const t = { id: `tr_${made.length + 1}`, group: `referral_${p.businessReferralId}`, payoutId: p.payoutId, amount: p.amountCents, key: p.idempotencyKey, destination: p.destination };
      made.push(t);
      return { id: t.id };
    },
    getInvoicePaymentStanding: async () => (o.standing ?? "stands") as any,
    isInsufficientFundsError: (e: any) => !!o.insufficient && /insufficient/i.test(String(e?.message)),
  });
  const payoutOf = async (bizId: string) => (await q(`SELECT p.* FROM referral_payouts p JOIN business_referrals r ON r.id=p.business_referral_id WHERE r.business_id=$1`, [bizId]))[0];
  const makeDue = async (payoutId: string) => q(`UPDATE referral_payouts SET payable_after = now() - interval '1 minute', next_attempt_at = NULL WHERE id=$1`, [payoutId]);
  const notes = async (u: string, kind: string) => Number((await q(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type='business_referral_reward' AND metadata->>'kind'=$2`, [u, kind]))[0].n);

  console.log("\n1. Signup with a code");
  {
    const ref = await user();
    const code = await codeFor(ref);
    const owner = await user({ is_vendor: true });
    const biz = await business(owner);
    assert(await br.applyBusinessReferralAtSignup(owner, biz, ` ${code.toLowerCase()} `), "code applied (trimmed, any case)");
    const r = (await q(`SELECT r.*, (r.expires_at - b.created_at) AS window FROM business_referrals r JOIN businesses b ON b.id=r.business_id WHERE r.business_id=$1`, [biz]))[0];
    assert(r?.status === "pending" && r.referrer_user_id === ref && r.referred_owner_user_id === owner && r.window?.days === 90, "pending, expires 90 days after the business was created", r);
    assert(!(await br.applyBusinessReferralAtSignup(owner, biz, code)), "a second code for the same business does nothing");
    assert((await q(`SELECT count(*)::int n FROM referrals WHERE referred_user_id=$1`, [owner]))[0].n === 0
      && (await q(`SELECT referred_by FROM users WHERE id=$1`, [owner]))[0].referred_by === null, "no friend referral and no referred_by written");

    const owner2 = await user({ is_vendor: true });
    const biz2 = await business(owner2);
    assert(!(await br.applyBusinessReferralAtSignup(owner2, biz2, await codeFor(owner2))), "own code refused");
    assert(!(await br.applyBusinessReferralAtSignup(owner2, biz2, "NOPE2345")), "unknown code refused");
    assert(!(await br.applyBusinessReferralAtSignup(owner2, biz2, { evil: 1 })), "non-text code refused without throwing");
    assert(!(await br.applyBusinessReferralAtSignup(owner2, biz2, "AB-12")), "malformed code refused");
    const gone = await user({ deletion_status: "pending_deletion" });
    assert(!(await br.applyBusinessReferralAtSignup(owner2, biz2, await codeFor(gone))), "a deleted referrer's code refused");
  }

  console.log("\n2. First real plan charge");
  {
    const owner = await user({ is_vendor: true });
    const biz = await business(owner, { paid: false });
    const vs = (await q(`SELECT id FROM vendor_subscriptions WHERE business_id=$1`, [biz]))[0].id;
    assert((await br.recordFirstPlanPayment(vs, { id: "in_trial", status: "paid", amount_paid: 0 })) === null, "$0 invoice (trial, coupon) never counts");
    assert((await br.recordFirstPlanPayment(vs, { id: "in_open", status: "open", amount_paid: 4999 })) === null, "unpaid invoice never counts");
    assert((await br.recordFirstPlanPayment(vs, { id: "in_real", status: "paid", amount_paid: 4999 })) === biz, "first real charge recorded, business returned");
    assert((await br.recordFirstPlanPayment(vs, { id: "in_next", status: "paid", amount_paid: 4999 })) === null, "later invoices never move it");
    const row = (await q(`SELECT first_paid_invoice_id FROM vendor_subscriptions WHERE id=$1`, [vs]))[0];
    assert(row.first_paid_invoice_id === "in_real", "keeps the first invoice id", row);
  }

  console.log("\n3. Qualification: every fact is required");
  {
    const facts = ["approved", "paid", "active", "post", "live"] as const;
    for (const f of facts) {
      const ref = await user();
      const owner = await user({ is_vendor: true });
      const biz = await business(owner, { [f]: false });
      await br.applyBusinessReferralAtSignup(owner, biz, await codeFor(ref));
      assert((await br.checkBusinessReferral(biz)) === "pending" && !(await payoutOf(biz)), `missing ${f}: stays pending, no payout`);
    }
    {
      const ref = await user();
      const owner = await user({ is_vendor: true });
      const biz = await business(owner);
      await br.applyBusinessReferralAtSignup(owner, biz, await codeFor(ref));
      setupOk = false;
      assert((await br.checkBusinessReferral(biz)) === "pending", "setup not complete: stays pending");
      setupOk = true;
    }
    {
      const ref = await user();
      const owner = await user({ is_vendor: true });
      const biz = await business(owner, { post: false, live: false });
      await ins("stories", { id: crypto.randomUUID(), author_id: owner, is_active: true, expires_at: new Date(Date.now() + 3600e3) }).catch(() => null);
      await ins("feed_posts", { id: crypto.randomUUID(), author_id: owner, author_type: "vendor", post_type: "photo", is_active: false });
      await ins("vendor_products", { id: crypto.randomUUID(), business_id: biz, name: "Oil", price: 1500, status: "draft", is_active: true });
      await br.applyBusinessReferralAtSignup(owner, biz, await codeFor(ref));
      assert((await br.checkBusinessReferral(biz)) === "pending", "a story, a deleted post and a draft product don't count");
      {
        const r2 = await user();
        const o2 = await user({ is_vendor: true });
        const b2 = await business(o2, { post: false });
        await ins("feed_posts", { id: crypto.randomUUID(), author_id: o2, author_type: "vendor", post_type: "photo", is_active: false });
        await br.applyBusinessReferralAtSignup(o2, b2, await codeFor(r2));
        assert((await br.checkBusinessReferral(b2)) === "pending", "a deleted post alone doesn't count, even with everything else done");
      }
      await ins("feed_posts", { id: crypto.randomUUID(), author_id: owner, author_type: "photographer", post_type: "photo", is_active: true });
      await ins("staff_services", { id: crypto.randomUUID(), business_id: biz, staff_member_id: await ins("staff_members", { id: crypto.randomUUID(), business_id: biz, display_name: "Kim", email: `kim-${S}@x.test` }), name: "Cut", price_cents: 3000, duration_minutes: 30, status: "live", is_active: true });
      assert((await br.checkBusinessReferral(biz)) === "qualified", "a feed post (any author type) and a live staff service qualify");
    }
    {
      const ref = await user();
      const owner = await user({ is_vendor: true });
      const biz = await business(owner);
      await br.applyBusinessReferralAtSignup(owner, biz, await codeFor(ref));
      const res = await Promise.all([1, 2, 3, 4].map(() => br.checkBusinessReferral(biz)));
      const p = await q(`SELECT p.* FROM referral_payouts p JOIN business_referrals r ON r.id=p.business_referral_id WHERE r.business_id=$1`, [biz]);
      const pay = p[0];
      const gap = (await q(`SELECT (p.payable_after - r.qualified_at) AS d FROM referral_payouts p JOIN business_referrals r ON r.id=p.business_referral_id WHERE p.id=$1`, [pay?.id]))[0]?.d;
      assert(res.includes("qualified") && p.length === 1 && pay.amount_cents === 2500 && pay.status === "pending" && pay.recipient_user_id === ref && gap?.days === 7,
        "four checks at once: one payout of $25 to the referrer, payable 7 days after qualifying", { res, p, gap });
      // The notice is sent in the background: wait for it (up to 3s), then make sure no second one follows.
      for (let i = 0; i < 30 && (await notes(ref, "qualified")) === 0; i++) await sleep(100);
      await sleep(300);
      assert((await notes(ref, "qualified")) === 1, "referrer told once that it qualified");
    }
  }

  console.log("\n4. Expiry, blocks and the yearly cap");
  {
    const ref = await user();
    const owner = await user({ is_vendor: true });
    const biz = await business(owner);
    await br.applyBusinessReferralAtSignup(owner, biz, await codeFor(ref));
    await q(`UPDATE business_referrals SET expires_at = now() - interval '1 minute' WHERE business_id=$1`, [biz]);
    assert((await br.checkBusinessReferral(biz)) === "expired" && !(await payoutOf(biz)), "past 90 days: expired, no payout");

    const cases: Array<[string, (ref: string, ownerBiz: string) => Promise<void>, string]> = [
      ["staff", async (r, b) => { await ins("staff_members", { id: crypto.randomUUID(), business_id: b, user_id: r, display_name: "Ref" }); }, "staff"],
      ["staff by email", async (r, b) => { const e = (await q(`SELECT email FROM users WHERE id=$1`, [r]))[0].email; await ins("staff_members", { id: crypto.randomUUID(), business_id: b, display_name: "Ref", email: e.toUpperCase() }); }, "staff"],
      ["shared Stripe account", async (r, b) => { const a = (await q(`SELECT stripe_account_id FROM businesses WHERE id=$1`, [b]))[0].stripe_account_id; await ins("user_payout_accounts", { user_id: r, stripe_account_id: a, onboarding_complete: true }); }, "shared_stripe"],
      ["shared email", async (r, b) => { const e = (await q(`SELECT email FROM users WHERE id=$1`, [r]))[0].email; await q(`UPDATE businesses SET contact_email=$2 WHERE id=$1`, [b, e]); }, "shared_email"],
    ];
    for (const [name, setup, reason] of cases) {
      const r = await user();
      const o = await user({ is_vendor: true });
      const b = await business(o);
      await br.applyBusinessReferralAtSignup(o, b, await codeFor(r));
      await setup(r, b);
      const st = await br.checkBusinessReferral(b);
      const row = (await q(`SELECT status, block_reason FROM business_referrals WHERE business_id=$1`, [b]))[0];
      assert(st === "blocked" && row.block_reason === reason && !(await payoutOf(b)), `${name}: blocked (${reason}), no payout`, row);
    }

    // Cap: 20 this New York year; cancelled ones don't count; the 21st is blocked.
    const busy = await user();
    const code = await codeFor(busy);
    const cancelledOwner = await user({ is_vendor: true });
    const cancelledBiz = await business(cancelledOwner);
    await br.applyBusinessReferralAtSignup(cancelledOwner, cancelledBiz, code);
    await br.checkBusinessReferral(cancelledBiz);
    await q(`UPDATE referral_payouts SET status='cancelled' WHERE id=$1`, [(await payoutOf(cancelledBiz)).id]);
    for (let i = 0; i < 20; i++) {
      const o = await user({ is_vendor: true });
      const b = await business(o);
      await br.applyBusinessReferralAtSignup(o, b, code);
      const st = await br.checkBusinessReferral(b);
      if (st !== "qualified") { assert(false, `referral ${i + 1} of 20 qualifies`, st); break; }
    }
    const o21 = await user({ is_vendor: true });
    const b21 = await business(o21);
    await br.applyBusinessReferralAtSignup(o21, b21, code);
    const st21 = await br.checkBusinessReferral(b21);
    const row21 = (await q(`SELECT status, block_reason FROM business_referrals WHERE business_id=$1`, [b21]))[0];
    assert(st21 === "blocked" && row21.block_reason === "yearly_cap" && !(await payoutOf(b21)), "20 paid this year (a cancelled one not counted): the 21st is blocked", row21);
  }

  console.log("\n5. Payout");
  const qualified = async (refOverrides: Record<string, unknown> = {}) => {
    const ref = await user(refOverrides);
    const owner = await user({ is_vendor: true });
    const biz = await business(owner);
    await br.applyBusinessReferralAtSignup(owner, biz, await codeFor(ref));
    await br.checkBusinessReferral(biz);
    return { ref, owner, biz, payout: await payoutOf(biz) };
  };
  {
    const { ref, payout } = await qualified();
    assert((await br.sendReferralPayout(payout.id, fake() as any)) === "not_due" && made.length === 0, "nothing sent before the 7 days");
    await makeDue(payout.id);
    assert((await br.sendReferralPayout(payout.id, fake() as any)) === "held", "no payouts account: held");
    let row = (await q(`SELECT * FROM referral_payouts WHERE id=$1`, [payout.id]))[0];
    assert(row.status === "held" && row.hold_reason === "no_account" && row.attempts === 0, "held no_account, try given back", row);
    await q(`UPDATE referral_payouts SET next_attempt_at = NULL WHERE id=$1`, [payout.id]);
    await br.sendReferralPayout(payout.id, fake() as any);
    await sleep(300);
    assert((await notes(ref, "setup_payouts")) === 1, "referrer told once to set up payouts, even after two holds");

    await ins("user_payout_accounts", { user_id: ref, stripe_account_id: `acct_ref_${S}`, onboarding_complete: false });
    await q(`UPDATE referral_payouts SET next_attempt_at = NULL WHERE id=$1`, [payout.id]);
    await br.sendReferralPayout(payout.id, fake() as any);
    row = (await q(`SELECT * FROM referral_payouts WHERE id=$1`, [payout.id]))[0];
    assert(row.status === "held" && row.hold_reason === "not_complete", "payouts started but not finished: held not_complete", row);

    await q(`UPDATE user_payout_accounts SET onboarding_complete = true WHERE user_id=$1`, [ref]);
    await q(`UPDATE referral_payouts SET next_attempt_at = NULL WHERE id=$1`, [payout.id]);
    const before = made.length;
    const res = await Promise.all([1, 2, 3].map(() => br.sendReferralPayout(payout.id, fake() as any)));
    row = (await q(`SELECT * FROM referral_payouts WHERE id=$1`, [payout.id]))[0];
    const t = made[made.length - 1];
    assert(res.filter((x) => x === "paid").length === 1 && made.length === before + 1, "three sends at once: exactly one transfer", { res, n: made.length - before });
    assert(row.status === "paid" && row.destination_type === "user" && row.connected_account_id === `acct_ref_${S}` && row.transfer_id === t.id && t.amount === 2500,
      "paid $25 to the personal payouts account", row);
    assert(new RegExp(`^referral_payout_${payout.id}_\\d{15,17}$`).test(t.key) && t.group === `referral_${payout.business_referral_id}`, "one key per claim, grouped by referral", t);
    await sleep(300);
    assert((await notes(ref, "paid")) === 1, "referrer told it was sent");
    assert((await br.sendReferralPayout(payout.id, fake() as any)) === "not_due" && made.length === before + 1, "a paid payout is never sent again");
  }
  {
    // Owner of an approved business gets paid there first.
    const r = await user();
    const own = await business(r, {}, { stripe_account_id: `acct_refbiz_${S}` });
    void own;
    const owner = await user({ is_vendor: true });
    const biz = await business(owner);
    await br.applyBusinessReferralAtSignup(owner, biz, await codeFor(r));
    await br.checkBusinessReferral(biz);
    const p = await payoutOf(biz);
    await ins("user_payout_accounts", { user_id: r, stripe_account_id: `acct_refuser_${S}`, onboarding_complete: true });
    await makeDue(p.id);
    await br.sendReferralPayout(p.id, fake() as any);
    const row = (await q(`SELECT destination_type, connected_account_id FROM referral_payouts WHERE id=$1`, [p.id]))[0];
    assert(row.destination_type === "business" && row.connected_account_id === `acct_refbiz_${S}`, "a referrer with a ready business account is paid there first", row);
  }
  {
    // Business not ready at Stripe: falls through to the personal account.
    const r = await user();
    await business(r, {}, { stripe_account_id: `acct_notready_${S}` });
    const owner = await user({ is_vendor: true });
    const biz = await business(owner);
    await br.applyBusinessReferralAtSignup(owner, biz, await codeFor(r));
    await br.checkBusinessReferral(biz);
    const p = await payoutOf(biz);
    await ins("user_payout_accounts", { user_id: r, stripe_account_id: `acct_fallback_${S}`, onboarding_complete: true });
    await makeDue(p.id);
    await br.sendReferralPayout(p.id, fake({ ready: (a) => a !== `acct_notready_${S}` }) as any);
    const row = (await q(`SELECT status, destination_type FROM referral_payouts WHERE id=$1`, [p.id]))[0];
    assert(row.status === "paid" && row.destination_type === "user", "business account not ready at Stripe: paid to the personal account", row);
  }
  for (const standing of ["refunded", "disputed", "unpaid"]) {
    const { ref, payout } = await qualified();
    await ins("user_payout_accounts", { user_id: ref, stripe_account_id: `acct_${standing}_${S}`, onboarding_complete: true });
    await makeDue(payout.id);
    const heldBefore = (await computeHeld()).breakdown.referralPayoutsOpen;
    const before = made.length;
    assert((await br.sendReferralPayout(payout.id, fake({ standing }) as any)) === "cancelled" && made.length === before, `first plan payment ${standing}: cancelled, nothing sent`);
    const heldAfter = (await computeHeld()).breakdown.referralPayoutsOpen;
    assert(heldBefore - heldAfter === 2500, `${standing}: the $25 is no longer held for the bank payout`, { heldBefore, heldAfter });
  }
  {
    const { ref, payout } = await qualified();
    await ins("user_payout_accounts", { user_id: ref, stripe_account_id: `acct_unknown_${S}`, onboarding_complete: true });
    await makeDue(payout.id);
    assert((await br.sendReferralPayout(payout.id, fake({ standing: "unknown" }) as any)) === "review", "Stripe can't confirm the plan payment: review, not sent");
  }
  {
    // A block that appears after qualifying stops the payout.
    const { ref, biz, payout } = await qualified();
    await ins("user_payout_accounts", { user_id: ref, stripe_account_id: `acct_lateblock_${S}`, onboarding_complete: true });
    await ins("staff_members", { id: crypto.randomUUID(), business_id: biz, user_id: ref, display_name: "Ref" });
    await makeDue(payout.id);
    const res = await br.sendReferralPayout(payout.id, fake() as any);
    const r = (await q(`SELECT status, block_reason FROM business_referrals WHERE business_id=$1`, [biz]))[0];
    assert(res === "cancelled" && r.status === "blocked" && r.block_reason === "staff", "referrer joined the staff before payout: cancelled and blocked", { res, r });
  }
  {
    // Sent before but not saved: recorded, not sent again.
    const { ref, payout } = await qualified();
    await ins("user_payout_accounts", { user_id: ref, stripe_account_id: `acct_resent_${S}`, onboarding_complete: true });
    made.push({ id: "tr_earlier", group: `referral_${payout.business_referral_id}`, payoutId: payout.id, amount: 2500, key: "k", destination: "x" });
    await makeDue(payout.id);
    const before = made.length;
    await br.sendReferralPayout(payout.id, fake() as any);
    const row = (await q(`SELECT status, transfer_id FROM referral_payouts WHERE id=$1`, [payout.id]))[0];
    assert(row.status === "paid" && row.transfer_id === "tr_earlier" && made.length === before, "a transfer already at Stripe is recorded, never sent twice", row);
  }
  {
    // Not enough platform balance: pending, try given back, bank payout waits.
    const { ref, payout } = await qualified();
    await ins("user_payout_accounts", { user_id: ref, stripe_account_id: `acct_broke_${S}`, onboarding_complete: true });
    await makeDue(payout.id);
    const res = await br.sendReferralPayout(payout.id, fake({ createError: new Error("Insufficient funds in Stripe account"), insufficient: true }) as any);
    const row = (await q(`SELECT status, attempts, last_error FROM referral_payouts WHERE id=$1`, [payout.id]))[0];
    assert(res === "insufficient" && row.status === "pending" && row.attempts === 0 && /nsufficient/.test(row.last_error), "waiting for balance: pending, not counted as a try", row);
    assert((await computeHeld()).gates.referralPayoutsWaitingBalance >= 1, "bank payout gate is raised");
    await q(`UPDATE referral_payouts SET status='paid' WHERE id=$1`, [payout.id]);
  }
  {
    // Other errors: backoff, then review after 5 tries.
    const { ref, payout } = await qualified();
    await ins("user_payout_accounts", { user_id: ref, stripe_account_id: `acct_flaky_${S}`, onboarding_complete: true });
    await makeDue(payout.id);
    let last = "";
    for (let i = 0; i < 5; i++) {
      await q(`UPDATE referral_payouts SET next_attempt_at = NULL WHERE id=$1`, [payout.id]);
      last = await br.sendReferralPayout(payout.id, fake({ createError: new Error("Stripe 500") }) as any);
    }
    const row = (await q(`SELECT status, attempts FROM referral_payouts WHERE id=$1`, [payout.id]))[0];
    assert(last === "review" && row.status === "review" && row.attempts === 5, "5 failed tries: review", { last, row });
  }

  console.log("\n6. Sweep and read model");
  {
    const ref = await user();
    const owner = await user({ is_vendor: true });
    const biz = await business(owner, { post: false });
    await br.applyBusinessReferralAtSignup(owner, biz, await codeFor(ref));
    await br.sweepBusinessReferrals();
    assert((await q(`SELECT status FROM business_referrals WHERE business_id=$1`, [biz]))[0].status === "pending", "sweep: still pending without a post");
    await ins("feed_posts", { id: crypto.randomUUID(), author_id: owner, author_type: "vendor", post_type: "photo", is_active: true });
    await br.sweepBusinessReferrals(10000);
    assert((await q(`SELECT status FROM business_referrals WHERE business_id=$1`, [biz]))[0].status === "qualified", "sweep: qualifies once the post exists");
    const mine = await br.listBusinessReferralsFor(ref);
    assert(mine.referrals.length === 1 && mine.referrals[0].status === "qualified" && mine.referrals[0].payout?.status === "pending" && mine.totals.waitingCents === 2500,
      "list shows the business, its status and the $25 waiting", mine);
  }

  br.setSetupCheckForTest(null);
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
