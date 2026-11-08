/**
 * Unpaid product order cleanup (app payment methods follow up, 2026-11-07) — tests
 *
 * Run with: npx tsx server/abandonedOrders.test.ts
 *
 * The decision table always runs. The database part needs a LOCAL scratch Postgres with the full schema:
 *   AO_TEST_PG_URL   the scratch database (localhost only; seeds and cleans up its own rows)
 *   DATABASE_URL     the same database, with NODE_OPTIONS="--import ./.dev/neon-preload.mjs"
 * Stripe is never called: the job takes its Stripe calls as arguments.
 */
let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

(async () => {
  const { decideAbandonedOrder, cleanupAbandonedOrders, ORDER_ABANDON_AFTER_MS } = await import("./abandonedOrders");

  console.log("Decision for each PaymentIntent status");
  eq(ORDER_ABANDON_AFTER_MS, 6 * 60 * 60 * 1000, "waits 6 hours (Afterpay allows up to 3 hours to approve)");
  eq(decideAbandonedOrder(null), "close", "no PaymentIntent: close");
  eq(decideAbandonedOrder("canceled"), "close", "already canceled: close");
  eq(decideAbandonedOrder("requires_payment_method"), "cancel_then_close", "declined or never paid: cancel, then close");
  eq(decideAbandonedOrder("requires_action"), "cancel_then_close", "left at Klarna, Afterpay or a bank check: cancel, then close");
  eq(decideAbandonedOrder("requires_confirmation"), "cancel_then_close", "never confirmed: cancel, then close");
  eq(decideAbandonedOrder("processing"), "skip", "money moving: leave it");
  eq(decideAbandonedOrder("requires_capture"), "skip", "authorized: leave it");
  eq(decideAbandonedOrder("succeeded"), "confirm_paid", "paid but the order never heard: run the paid steps");

  const PG_URL = process.env.AO_TEST_PG_URL;
  if (!PG_URL) {
    console.log("⏭  database part skipped: set AO_TEST_PG_URL (+ DATABASE_URL and the neon preload) to run");
  } else {
    if (!isLocal(PG_URL)) throw new Error("refusing to run: localhost database only");
    const pgMod: any = await import("pg");
    const pg = pgMod.default ?? pgMod;
    const db = new pg.Client({ connectionString: PG_URL });
    await db.connect();
    const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
    const tag = `ao${Date.now().toString(36)}`;
    const id = (s: string) => `${tag}_${s}`;
    const now = new Date();
    const old = new Date(now.getTime() - ORDER_ABANDON_AFTER_MS - 60_000);
    const fresh = new Date(now.getTime() - ORDER_ABANDON_AFTER_MS + 60_000);

    const mkUser = async (s: string, vendor: boolean) => {
      const uid = id(s);
      await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@ao.test`, vendor]);
      return uid;
    };
    const vendor = await mkUser("v", true);
    const customer = await mkUser("c", false);
    const biz = id("biz");
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1,$2,'Shop','retail','approved')`, [biz, vendor]);

    const order = async (s: string, o: { pi?: string | null; at: Date; status?: string; group?: string; quote?: boolean }) => {
      const oid = id(s);
      await q(
        `INSERT INTO orders (id, customer_id, business_id, total_amount, items, status, stripe_payment_intent_id, order_group_id, created_at, updated_at)
         VALUES ($1,$2,$3,1000,'[]',$4,$5,$6,$7::timestamp,$7::timestamp)`,
        // Stored like the app stores them: UTC time, no zone (defaultNow on a UTC database).
        [oid, customer, biz, o.status ?? "pending", o.pi ?? null, o.group ?? null, o.at.toISOString()],
      );
      return oid;
    };
    const group = id("grp");
    await q(`INSERT INTO order_groups (id, customer_id, total_vendors, status) VALUES ($1,$2,2,'pending')`, [group, customer]);

    // PaymentIntents the fake Stripe knows, by id.
    const pis: Record<string, string> = {
      [id("pi_unpaid")]: "requires_payment_method",
      [id("pi_klarna")]: "requires_action",
      [id("pi_canceled")]: "canceled",
      [id("pi_processing")]: "processing",
      [id("pi_paid")]: "succeeded",
      [id("pi_err")]: "ERROR",
      [id("pi_cancel_fails")]: "requires_payment_method",
      [id("pi_group")]: "requires_action",
      [id("pi_fresh")]: "requires_payment_method",
      [id("pi_quote")]: "requires_payment_method",
    };
    const oUnpaid = await order("unpaid", { pi: id("pi_unpaid"), at: old });
    const oKlarna = await order("klarna", { pi: id("pi_klarna"), at: old });
    const oCanceled = await order("canceled", { pi: id("pi_canceled"), at: old });
    const oNoPi = await order("nopi", { pi: null, at: old });
    const oProcessing = await order("processing", { pi: id("pi_processing"), at: old });
    const oPaid = await order("paid", { pi: id("pi_paid"), at: old });
    const oErr = await order("err", { pi: id("pi_err"), at: old });
    const oCancelFails = await order("cancelfails", { pi: id("pi_cancel_fails"), at: old });
    const oG1 = await order("g1", { pi: id("pi_group"), at: old, group });
    const oG2 = await order("g2", { pi: id("pi_group"), at: old, group });
    const oFresh = await order("fresh", { pi: id("pi_fresh"), at: fresh });
    const oDone = await order("done", { pi: id("pi_unpaid"), at: old, status: "paid" });
    const oQuote = await order("quote", { pi: id("pi_quote"), at: old });
    // A product quote of this shop, so the quote order really has a quote_id (the quote job owns those).
    const convo = id("convo");
    await q(`INSERT INTO conversations (id, participant1_id, participant2_id) VALUES ($1,$2,$3)`, [convo, customer, vendor]);
    const quoteId = id("quote");
    await q(
      `INSERT INTO quotes (id, kind, business_id, sender_id, customer_id, conversation_id, title, time_zone, total_cents, payment_mode, expires_at, link_code)
       VALUES ($1::varchar,'product',$2,$3,$4,$5,'Cake','America/New_York',1000,'full',now() + interval '7 days',$1::text)`,
      [quoteId, biz, vendor, customer, convo],
    );
    await q(`UPDATE orders SET quote_id = $2 WHERE id = $1`, [oQuote, quoteId]);

    // A points code held by the Klarna order.
    const code = id("code");
    await q(
      `INSERT INTO promo_codes (id, code, user_id, points_cost, discount_cents, status, expires_at, used_on_reference_type, used_on_order_id)
       VALUES ($1::varchar,$1::text,$2,500,100,'reserved',now() + interval '30 days','order',$3)`,
      [code, customer, oKlarna],
    );

    const canceled: string[] = [];
    const confirmed: string[] = [];
    const reads: string[] = [];
    const deps = {
      getPaymentIntent: async (pi: string) => {
        reads.push(pi);
        const status = pis[pi];
        if (!status || status === "ERROR") throw new Error("stripe down");
        return { id: pi, status };
      },
      cancelPaymentIntent: async (pi: string) => {
        if (pi === id("pi_cancel_fails")) throw new Error("paid meanwhile");
        canceled.push(pi);
        pis[pi] = "canceled";
      },
      confirmPaid: async (pi: { id: string }) => { confirmed.push(pi.id); },
    };

    const statusOf = async (oid: string) => (await q(`SELECT status FROM orders WHERE id = $1`, [oid]))[0]?.status;
    try {
      console.log("\nFirst run");
      const r = await cleanupAbandonedOrders(now, deps);
      eq(await statusOf(oUnpaid), "cancelled", "unpaid order closed");
      eq(await statusOf(oKlarna), "cancelled", "order left at Klarna closed");
      eq(await statusOf(oCanceled), "cancelled", "already canceled payment: order closed");
      eq(await statusOf(oNoPi), "cancelled", "order with no payment closed");
      eq(await statusOf(oProcessing), "pending", "processing payment: order untouched");
      eq(await statusOf(oPaid), "pending", "paid payment: left for the paid steps (fake does not mark it)");
      eq(await statusOf(oErr), "pending", "Stripe error: untouched, retried later");
      eq(await statusOf(oCancelFails), "pending", "cancel refused (paid meanwhile): untouched");
      eq([await statusOf(oG1), await statusOf(oG2)], ["cancelled", "cancelled"], "multi shop group: both orders closed");
      eq((await q(`SELECT status FROM order_groups WHERE id = $1`, [group]))[0]?.status, "cancelled", "multi shop group closed once all its orders are");
      eq(await statusOf(oFresh), "pending", "younger than 6 hours: untouched");
      eq(await statusOf(oDone), "paid", "paid order sharing a payment id: untouched");
      eq(await statusOf(oQuote), "pending", "quote order: left to the quote job");
      eq(canceled.sort(), [id("pi_unpaid"), id("pi_klarna"), id("pi_group")].sort(), "cancelled exactly the unpaid payments, the shared one once");
      eq(canceled.includes(id("pi_canceled")), false, "never cancels an already canceled payment");
      eq(confirmed, [id("pi_paid")], "missed paid message: paid steps run once");
      eq(reads.filter((x) => x === id("pi_group")).length, 1, "shared multi shop payment read once");
      eq(reads.includes(id("pi_fresh")) || reads.includes(id("pi_quote")), false, "never reads payments it must not touch");
      eq((await q(`SELECT status, used_on_order_id FROM promo_codes WHERE id = $1`, [code]))[0], { status: "active", used_on_order_id: null }, "points code given back");
      const mine = await q(`SELECT count(*)::int AS n FROM orders WHERE business_id = $1 AND status = 'cancelled'`, [biz]);
      eq(mine[0].n, 6, "six of this test's orders closed");
      eq(r.closed >= 6, true, "the run reports them");
      eq(r.confirmed, 1, "one paid order confirmed");

      console.log("\nSecond run changes nothing new");
      canceled.length = 0;
      confirmed.length = 0;
      const r2 = await cleanupAbandonedOrders(now, deps);
      eq((await q(`SELECT count(*)::int AS n FROM orders WHERE business_id = $1 AND status = 'cancelled'`, [biz]))[0].n, 6, "nothing more of this test's closed");
      eq(r2.confirmed >= 0, true, "second run completes");
      eq(canceled, [], "nothing more to cancel");
    } finally {
      await q(`DELETE FROM promo_codes WHERE id = $1`, [code]).catch((e) => console.error("cleanup", e.message));
      await q(`DELETE FROM orders WHERE business_id = $1`, [biz]).catch((e) => console.error("cleanup", e.message));
      await q(`DELETE FROM order_groups WHERE id = $1`, [group]).catch((e) => console.error("cleanup", e.message));
      await q(`DELETE FROM quotes WHERE id = $1`, [quoteId]).catch((e) => console.error("cleanup", e.message));
      await q(`DELETE FROM conversations WHERE id = $1`, [convo]).catch((e) => console.error("cleanup", e.message));
      await q(`DELETE FROM businesses WHERE id = $1`, [biz]).catch((e) => console.error("cleanup", e.message));
      await q(`DELETE FROM users WHERE id = ANY($1)`, [[vendor, customer]]).catch((e) => console.error("cleanup", e.message));
      await db.end();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
