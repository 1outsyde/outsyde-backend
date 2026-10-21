/**
 * Subscription lifecycle step 1.0b: late payments, 7 day grace, pause and unpause, notices, plan switch.
 * Run with:
 *   LIFECYCLE_LOCAL_PG=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   STRIPE_SECRET_KEY=sk_test_stub STRIPE_PUBLISHABLE_KEY=pk_test_stub STRIPE_STUB_PORT=5096 \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" \
 *   npx tsx server/subscriptionLifecycle1b.test.ts
 * with `node .dev/neon-local-proxy.mjs` running and migration 060 applied to the same LOCAL database.
 *
 * SCRATCH ONLY: local Postgres + the in-process Stripe stub below; nothing reaches Neon, Stripe, Resend
 * or Expo (notice senders are replaced). Skips when LIFECYCLE_LOCAL_PG is unset; refuses non-local hosts.
 */
import http from 'node:http';
import pg from 'pg';
import { vendorCopy, adminCopy, setSubscriptionNoticeDepsForTest, type SubscriptionEvent, type NoticeContext } from './subscriptions/notices';
import { SUBSCRIPTION_GRACE_DAYS, SUBSCRIPTION_REMINDER_DAY } from './subscriptions/policy';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const DAY = 24 * 60 * 60 * 1000;

function copyTests() {
  console.log('\nCopy (no dashes, no fee percentage)');
  const ctx: NoticeContext = { vendorSubscriptionId: 'v', vendorId: 'u', businessId: 'b', businessName: 'Test Biz', ownerEmail: 'o@x.test', ownerFirstName: 'Dana', planName: 'Grandfathered', stripeSubscriptionId: 'sub_1' };
  const events: SubscriptionEvent[] = ['activated', 'renewed', 'plan_switched', 'payment_failed', 'action_required', 'grace_reminder', 'paused', 'restored', 'ended', 'free_started'];
  const d = { amountCents: 4099, pastDueSince: new Date('2026-10-01T12:00:00Z'), periodEnd: new Date('2026-11-01T12:00:00Z'), previousPlanName: 'Growth', pausedItems: 3, restoredItems: 3, invoiceId: 'in_1', invoiceUrl: 'https://invoice.stripe.com/i/x' };
  for (const e of events) {
    const v = vendorCopy(e, ctx, d);
    const a = adminCopy(e, ctx, d, v?.subject ?? null);
    const text = JSON.stringify([v, a]);
    assert(!/[–—]| - /.test(text), `${e}: no dashes in vendor or admin copy`);
    assert(!/8\s?%|percent/i.test(text), `${e}: no fee percentage`);
    assert(a.subject.startsWith('[Subscription] Test Biz: '), `${e}: Outsyde copy subject names the business`, a.subject);
  }
  assert(vendorCopy('renewed', ctx) === null && vendorCopy('plan_switched', ctx) === null, 'renewed / switched: Outsyde copy only (vendor already gets in-app)');
  // Legend 2026-10-21: every new paid plan sends the vendor a "You're live" email and push; the in-app row
  // still comes from NotificationTriggers.subscriptionActivated, so the notice adds none.
  assert(vendorCopy('activated', ctx)?.subject === "You're live on Outsyde" && vendorCopy('activated', ctx)?.inApp === null, 'activated: vendor gets "You\'re live" email + push, no second in-app');
  assert(vendorCopy('payment_failed', ctx, d)!.body.includes('Thursday, October 8'), 'late email names the day listings pause (7 days after the first failure)', vendorCopy('payment_failed', ctx, d)!.body);
  assert(vendorCopy('action_required', ctx, d)!.cta!.url === d.invoiceUrl, 'confirm email links to the Stripe payment page');
}

(async () => {
  copyTests();

  const PG = process.env.LIFECYCLE_LOCAL_PG;
  const STUB_PORT = Number(process.env.STRIPE_STUB_PORT || 0);
  if (!PG) { console.log('\n⏭  DB tests skipped: set LIFECYCLE_LOCAL_PG'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }
  const local = (u: string) => ['localhost', '127.0.0.1'].includes(new URL(u).hostname);
  if (!local(PG) || !STUB_PORT || !process.env.DATABASE_URL || !local(process.env.DATABASE_URL)) throw new Error('refusing: local DB and STRIPE_STUB_PORT required');

  // ── Notice senders replaced: record everything ──
  const sent: { to?: string; subject?: string; push?: string; inApp?: string; kind: string }[] = [];
  setSubscriptionNoticeDepsForTest({
    sendEmail: async (p) => { sent.push({ kind: p.to === 'admin@outsyde.test' ? 'admin' : 'vendor', to: p.to, subject: p.subject }); return true; },
    sendPush: async (p) => { sent.push({ kind: 'push', push: p.title }); return true; },
    createInApp: async (p) => { sent.push({ kind: 'inapp', inApp: p.title }); },
    adminEmail: 'admin@outsyde.test',
  });
  const take = () => sent.splice(0, sent.length);

  // ── Stripe stub ──
  const subs: Record<string, any> = {};
  const updates: Record<string, URLSearchParams> = {};
  let nextUpdate: 'paid' | 'pending' = 'paid';
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = (req.url || '').split('?')[0];
      res.setHeader('content-type', 'application/json');
      const m = url.match(/^\/v1\/subscriptions\/([^/]+)$/);
      if (m && req.method === 'GET' && subs[m[1]]) { res.end(JSON.stringify(subs[m[1]])); return; }
      if (m && req.method === 'POST' && subs[m[1]]) {
        const form = new URLSearchParams(raw);
        updates[m[1]] = form;
        const s = subs[m[1]];
        const now = Math.floor(Date.now() / 1000);
        if (nextUpdate === 'pending') {
          res.end(JSON.stringify({ ...s, pending_update: { expires_at: now + 82800, subscription_items: [{ id: s.items.data[0].id, price: form.get('items[0][price]') }] }, latest_invoice: { id: 'in_pending', hosted_invoice_url: 'https://invoice.stripe.com/i/pending', status: 'open', amount_paid: 0 } }));
          return;
        }
        const updated = { ...s, status: 'active', items: { data: [{ id: s.items.data[0].id, current_period_start: now, current_period_end: now + 30 * 86400, price: { id: form.get('items[0][price]') } }] }, latest_invoice: { id: 'in_switch', status: 'paid', amount_paid: 5900, hosted_invoice_url: null } };
        subs[m[1]] = updated;
        res.end(JSON.stringify(updated));
        return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such resource' } }));
    });
  });
  await new Promise<void>(r => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  const db = new pg.Client({ connectionString: PG });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const { WebhookHandlers } = await import('./stripe/webhookHandlers');
  const { storage } = await import('./storage');
  const { runSubscriptionGraceJob } = await import('./subscriptions/lifecycle');
  const { switchPaidPlan, applySwitchedPlan } = await import('./subscriptions/planSwitch');
  const { getUncachableStripeClient } = await import('./stripe/stripeClient');

  const P = `lb${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`.slice(0, 36);
  const GF_PRICE = `price_${P}_gf`, GR_PRICE = `price_${P}_gr`;
  const tierGf = id('t-gf'), tierGr = id('t-gr');
  const users: string[] = [], bizs: string[] = [];

  try {
    await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps, stripe_price_id, sort_order, max_staff)
             VALUES ($1, $2, 'Grandfathered', 4099, 800, $3, -1, 8), ($4, $5, 'Growth', 5900, 800, $6, 1, 8)`, [tierGf, `${P}-gf`, GF_PRICE, tierGr, `${P}-gr`, GR_PRICE]);

    const now = Math.floor(Date.now() / 1000);
    async function seed(key: string, subId: string, opts: { status?: string; pastDueDaysAgo?: number; collection?: string } = {}) {
      const u = id(`u-${key}`), b = id(`b-${key}`), v = id(`v-${key}`);
      await q(`INSERT INTO users (id, username, email, password, is_vendor, first_name) VALUES ($1::varchar, $1::text, $2, 'x', true, 'Dana')`, [u, `${u}@lb.test`]);
      await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, subscription_active) VALUES ($1::varchar, $2, $3, 'beauty', 'approved', true)`, [b, u, `Biz ${key}`]);
      const pds = opts.pastDueDaysAgo != null ? new Date(Date.now() - opts.pastDueDaysAgo * DAY).toISOString() : null;
      await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, stripe_subscription_id, stripe_customer_id, status, current_period_start, current_period_end, past_due_since)
               VALUES ($1, $2, $3, $4, $5, 'cus_lb', $6, now() - interval '20 days', now() + interval '10 days', $7)`, [v, u, b, tierGf, subId, opts.status ?? 'active', pds]);
      await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, status, is_active) VALUES ($1, $3, 'live svc', 1000, 30, 'live', true), ($2, $3, 'vendor paused svc', 1000, 30, 'paused', true)`, [id(`s1-${key}`), id(`s2-${key}`), b]);
      await q(`INSERT INTO vendor_products (id, business_id, name, price, status, is_active) VALUES ($1, $2, 'live prod', 1500, 'live', true)`, [id(`p1-${key}`), b]);
      subs[subId] = { id: subId, object: 'subscription', status: opts.status ?? 'active', collection_method: opts.collection ?? 'charge_automatically', metadata: {}, items: { data: [{ id: `si_${subId}`, current_period_start: now - 20 * 86400, current_period_end: now + 10 * 86400, price: { id: GF_PRICE } }] } };
      users.push(u); bizs.push(b);
      return { u, b, v, s1: id(`s1-${key}`), s2: id(`s2-${key}`), p1: id(`p1-${key}`) };
    }
    const row = async (v: string) => (await q(`SELECT status, tier_id, past_due_since, current_period_end FROM vendor_subscriptions WHERE id = $1`, [v]))[0];
    const items = async (x: { s1: string; s2: string; p1: string }) => {
      const r = await q(`SELECT id, status FROM vendor_services WHERE id IN ($1,$2) UNION ALL SELECT id, status FROM vendor_products WHERE id = $3`, [x.s1, x.s2, x.p1]);
      const m: Record<string, string> = {}; for (const i of r) m[i.id] = i.status; return { s1: m[x.s1], s2: m[x.s2], p1: m[x.p1] };
    };
    const basilInvoice = (inv: string, subId: string, extra: Record<string, unknown> = {}) => ({ id: inv, object: 'invoice', parent: { type: 'subscription_details', subscription_details: { subscription: subId } }, ...extra });

    // ── Policy ──
    console.log('\nGrace policy (7 days from past_due_since)');
    {
      const a = await seed('pol6', `sub_${P}_p6`, { status: 'past_due', pastDueDaysAgo: 6 });
      const b2 = await seed('pol8', `sub_${P}_p8`, { status: 'past_due', pastDueDaysAgo: 8 });
      assert((await storage.isBusinessSubscriptionActive(a.b)).active === true, 'late 6 days: still active (grace)');
      assert((await storage.isBusinessSubscriptionActive(b2.b)).active === false, 'late 8 days: inactive');
      await q(`UPDATE vendor_subscriptions SET updated_at = now() WHERE id = $1`, [b2.v]);
      assert((await storage.isBusinessSubscriptionActive(b2.b)).active === false, 'a later write (updated_at reset) no longer extends the grace');
      assert(SUBSCRIPTION_GRACE_DAYS === 7 && SUBSCRIPTION_REMINDER_DAY === 5, 'grace 7 days, reminder on day 5');
    }

    // ── Late, reminder, pause, restore ──
    console.log('\nFailed payment, reminder, pause, paid again');
    {
      const subId = `sub_${P}_late`;
      const s = await seed('late', subId);
      subs[subId].status = 'past_due';
      take();
      await WebhookHandlers.handleEvent({ type: 'invoice.payment_failed', data: { object: basilInvoice('in_late1', subId, { amount_due: 4099, billing_reason: 'subscription_cycle', hosted_invoice_url: 'https://invoice.stripe.com/i/late1' }) } });
      let r = await row(s.v);
      const firstSince = r.past_due_since;
      assert(r.status === 'past_due' && !!firstSince, 'invoice.payment_failed: marked late at once (past_due + past_due_since)', r);
      assert(JSON.stringify(await items(s)) === JSON.stringify({ s1: 'live', s2: 'paused', p1: 'live' }), 'during grace listings stay live', await items(s));
      let out = take();
      assert(out.some(o => o.kind === 'vendor' && o.subject === "Your Outsyde plan payment didn't go through"), 'vendor emailed: payment not received', out);
      assert(out.some(o => o.kind === 'admin' && /Payment failed/.test(o.subject!)), 'Outsyde gets a copy', out);
      assert(out.some(o => o.kind === 'push') && out.some(o => o.kind === 'inapp'), 'phone push + in-app sent', out);

      // Stripe retries the same invoice and fails again; the subscription.updated also arrives.
      await WebhookHandlers.handleEvent({ type: 'invoice.payment_failed', data: { object: basilInvoice('in_late1', subId, { amount_due: 4099, billing_reason: 'subscription_cycle' }) } });
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.updated', data: { object: { ...subs[subId], latest_invoice: 'in_late1' } } });
      r = await row(s.v);
      assert(String(r.past_due_since) === String(firstSince), 'retries keep the first past_due_since (grace not extended)', { firstSince, now: r.past_due_since });
      assert(take().length === 0, 'retries and subscription.updated send nothing new');

      // Day 5.5: reminder once
      await q(`UPDATE vendor_subscriptions SET past_due_since = now() - interval '5 days 12 hours' WHERE id = $1`, [s.v]);
      await runSubscriptionGraceJob(); await runSubscriptionGraceJob();
      out = take();
      assert(out.filter(o => o.kind === 'vendor' && o.to?.startsWith(s.u) && o.subject === 'Your Outsyde listings pause soon').length === 1, 'day 5: one reminder, even with two job runs', out);
      assert(JSON.stringify(await items(s)) === JSON.stringify({ s1: 'live', s2: 'paused', p1: 'live' }), 'day 5: still live');

      // Day 7.5: pause once
      await q(`UPDATE vendor_subscriptions SET past_due_since = now() - interval '7 days 12 hours' WHERE id = $1`, [s.v]);
      await runSubscriptionGraceJob(); await runSubscriptionGraceJob();
      out = take();
      assert(JSON.stringify(await items(s)) === JSON.stringify({ s1: 'paused', s2: 'paused', p1: 'paused' }), 'day 7: live items paused', await items(s));
      const marks = await q(`SELECT item_id FROM subscription_paused_items WHERE business_id = $1 ORDER BY item_id`, [s.b]);
      assert(marks.length === 2 && !marks.some(m => m.item_id === s.s2), 'only the 2 items the system paused are marked (not the vendor-paused one)', marks);
      assert(out.filter(o => o.kind === 'vendor' && o.to?.startsWith(s.u) && o.subject === 'Your Outsyde listings are paused').length === 1, 'one "listings paused" email', out);
      assert((await storage.isBusinessSubscriptionActive(s.b)).active === false, 'business inactive (hidden from public, go-live blocked)');
      assert(await storage.isSystemPausedItem('service', s.s1) === true && await storage.isSystemPausedItem('service', s.s2) === false, 'isSystemPausedItem tells system-paused from vendor-paused');

      // Paid: invoice.paid (basil) with the subscription active again
      subs[subId].status = 'active';
      await WebhookHandlers.handleEvent({ type: 'invoice.paid', data: { object: basilInvoice('in_late1', subId, { amount_paid: 4099, billing_reason: 'subscription_cycle' }) } });
      r = await row(s.v);
      assert(r.status === 'active' && r.past_due_since === null, 'invoice.paid: active, past_due_since cleared', r);
      assert(JSON.stringify(await items(s)) === JSON.stringify({ s1: 'live', s2: 'paused', p1: 'live' }), 'system-paused items back live, vendor-paused item stays paused', await items(s));
      assert((await q(`SELECT count(*)::int AS n FROM subscription_paused_items WHERE business_id = $1`, [s.b]))[0].n === 0, 'pause markers cleared');
      out = take();
      assert(out.filter(o => o.kind === 'vendor' && o.subject === "You're back live on Outsyde").length === 1, 'one "back live" email', out);
      assert(out.some(o => o.kind === 'admin' && /Renewal paid/.test(o.subject!)), 'Outsyde told about the paid renewal', out);
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.updated', data: { object: subs[subId] } });
      await WebhookHandlers.handleEvent({ type: 'invoice.paid', data: { object: basilInvoice('in_late1', subId, { amount_paid: 4099, billing_reason: 'subscription_cycle' }) } });
      assert(take().length === 0, 'replays after paying send nothing new');
    }

    // ── Bank confirmation ──
    console.log('\nPayment needs confirmation');
    {
      const subId = `sub_${P}_sca`;
      await seed('sca', subId);
      take();
      await WebhookHandlers.handleEvent({ type: 'invoice.payment_action_required', data: { object: basilInvoice('in_sca', subId, { amount_due: 4099, hosted_invoice_url: 'https://invoice.stripe.com/i/sca' }) } });
      await WebhookHandlers.handleEvent({ type: 'invoice.payment_action_required', data: { object: basilInvoice('in_sca', subId, { amount_due: 4099, hosted_invoice_url: 'https://invoice.stripe.com/i/sca' }) } });
      const out = take();
      assert(out.filter(o => o.kind === 'vendor' && o.subject === 'Confirm your Outsyde plan payment').length === 1, 'one "confirm payment" email', out);
    }

    // ── Stripe ends the subscription ──
    console.log('\nSubscription deleted');
    {
      const subId = `sub_${P}_del`;
      const s = await seed('del', subId, { status: 'past_due', pastDueDaysAgo: 14 });
      take();
      const ended = { ...subs[subId], status: 'canceled', ended_at: Math.floor(Date.now() / 1000) - 60 };
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.deleted', data: { object: ended } });
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.deleted', data: { object: ended } });
      const r = await row(s.v);
      assert(r.status === 'canceled' && r.past_due_since === null && new Date(r.current_period_end + 'Z').getTime() <= Date.now(), 'canceled, access ends now (period end moved to ended_at)', r);
      assert(JSON.stringify(await items(s)) === JSON.stringify({ s1: 'paused', s2: 'paused', p1: 'paused' }), 'listings paused', await items(s));
      const out = take();
      assert(out.filter(o => o.kind === 'vendor' && o.subject === 'Your Outsyde plan has ended').length === 1, 'one "plan ended" email (replay ignored)', out);
      await runSubscriptionGraceJob();
      assert(take().filter(o => o.to?.startsWith(s.u)).length === 0, 'grace job does not repeat the ended notice');

      // Resubscribe through checkout: same row, new Stripe subscription, everything the system paused comes back.
      const newSub = `sub_${P}_del_new`;
      subs[newSub] = { id: newSub, status: 'active', items: { data: [{ id: 'si_new', current_period_start: now, current_period_end: now + 30 * 86400, price: { id: GF_PRICE } }] } };
      await WebhookHandlers.handleVendorSubscriptionCheckoutCompleted({ id: 'cs_resub', subscription: newSub, customer: 'cus_lb', amount_total: 4099, metadata: { vendorId: s.u, businessId: s.b, tierId: tierGf } });
      const r2 = await row(s.v);
      assert(r2.status === 'active' && r2.past_due_since === null, 'resubscribe: row active again', r2);
      assert(JSON.stringify(await items(s)) === JSON.stringify({ s1: 'live', s2: 'paused', p1: 'live' }), 'resubscribe unpauses what the system paused, not the vendor-paused item', await items(s));
      const out2 = take();
      assert(out2.some(o => o.kind === 'admin' && /New plan started/.test(o.subject!)), 'Outsyde told: new plan started', out2);
      assert(out2.some(o => o.kind === 'vendor' && o.subject === "You're back live on Outsyde"), 'vendor told: back live', out2);
    }

    // ── Plan switch ──
    console.log('\nPlan switch (full price now, no credit)');
    {
      const subId = `sub_${P}_sw`;
      const s = await seed('sw', subId);
      const stripe = await getUncachableStripeClient();
      take();
      nextUpdate = 'pending';
      const pending = await switchPaidPlan(stripe, subId, GR_PRICE);
      const f = updates[subId];
      assert(f.get('proration_behavior') === 'none' && f.get('billing_cycle_anchor') === 'now' && f.get('payment_behavior') === 'pending_if_incomplete', 'Stripe asked for: no proration, billing date now, change only if paid', Object.fromEntries(f));
      assert(pending.kind === 'pending' && (pending as any).url === 'https://invoice.stripe.com/i/pending', 'declined or needs confirmation: plan unchanged, payment page returned', pending);
      assert((await row(s.v)).tier_id === tierGf, 'pending: tier not switched');

      nextUpdate = 'paid';
      const paid = await switchPaidPlan(stripe, subId, GR_PRICE);
      assert(paid.kind === 'switched' && (paid as any).amountCents === 5900, 'paid: switched, full new price charged', paid);
      const vs = await storage.getVendorSubscriptionByBusinessId(s.b);
      const [gr] = await q(`SELECT * FROM subscription_tiers WHERE id = $1`, [tierGr]);
      await applySwitchedPlan(vs!, { ...gr, id: gr.id, name: gr.name, displayName: gr.display_name, priceInCents: gr.price_in_cents, stripePriceId: gr.stripe_price_id } as any, paid as any);
      const r = await row(s.v);
      assert(r.tier_id === tierGr, 'tier switched once paid', r);
      // The webhook for the same change arrives afterwards: no second notice.
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.updated', data: { object: subs[subId] } });
      const out = take();
      assert(out.filter(o => o.kind === 'admin' && /Plan switched/.test(o.subject!)).length === 1, 'one "plan switched" notice to Outsyde even when the webhook follows', out);

      const subInv = `sub_${P}_inv`;
      await seed('inv', subInv, { collection: 'send_invoice' });
      const ns = await switchPaidPlan(stripe, subInv, GR_PRICE);
      assert(ns.kind === 'not_switchable', 'Send invoice plan: refused with a message (pending updates need automatic charging)', ns);
    }
  } finally {
    setSubscriptionNoticeDepsForTest(null);
    for (const b of bizs) {
      await q(`DELETE FROM subscription_paused_items WHERE business_id = $1`, [b]).catch(() => {});
      await q(`DELETE FROM audit_logs WHERE target_id = $1`, [b]).catch(() => {});
      await q(`DELETE FROM vendor_services WHERE business_id = $1`, [b]).catch(() => {});
      await q(`DELETE FROM vendor_products WHERE business_id = $1`, [b]).catch(() => {});
      for (const v of await q(`SELECT id FROM vendor_subscriptions WHERE business_id = $1`, [b]).catch(() => [] as any[])) {
        await q(`DELETE FROM subscription_notices WHERE vendor_subscription_id = $1`, [v.id]).catch(() => {});
        await q(`DELETE FROM benefit_allowances WHERE subscription_id = $1`, [v.id]).catch(() => {});
        await q(`DELETE FROM audit_logs WHERE target_id = $1`, [v.id]).catch(() => {});
      }
      await q(`DELETE FROM vendor_subscriptions WHERE business_id = $1`, [b]).catch(() => {});
      await q(`DELETE FROM businesses WHERE id = $1`, [b]).catch(() => {});
    }
    for (const u of users) {
      await q(`DELETE FROM notifications WHERE user_id = $1`, [u]).catch(() => {});
      await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => {});
    }
    await q(`DELETE FROM subscription_tiers WHERE id IN ($1, $2)`, [tierGf, tierGr]).catch(() => {});
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
