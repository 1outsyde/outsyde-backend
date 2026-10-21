/**
 * Hidden plan offers (Plan Offers board 1.3 to 1.6) and the shared paid activation (checkout webhook,
 * success page reconcile, one tap). Run with:
 *   OFFERS_LOCAL_PG=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   STRIPE_SECRET_KEY=sk_test_stub STRIPE_PUBLISHABLE_KEY=pk_test_stub STRIPE_STUB_PORT=5097 \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" \
 *   npx tsx server/planOffers.test.ts
 * with `node .dev/neon-local-proxy.mjs` running and migrations 060 + 062 applied to the same LOCAL database.
 *
 * SCRATCH ONLY: local Postgres + the in-process Stripe stub below; nothing reaches Neon, Stripe, Resend or
 * Expo (notice senders are replaced). Skips when OFFERS_LOCAL_PG is unset; refuses non-local hosts.
 * Uses the local 'grandfathered' and 'waived' tiers when the seeder made them (the Grandfathered price is
 * swapped for a test price and restored), otherwise creates and removes them.
 */
import http from 'node:http';
import pg from 'pg';
import { offerCopy, deferredBillingStart } from './subscriptions/planOffers';
import { vendorCopy, setSubscriptionNoticeDepsForTest, type NoticeContext } from './subscriptions/notices';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const DAY = 24 * 60 * 60 * 1000;
const noDash = (t: string) => !/[–—]| - /.test(t);

function pureTests() {
  console.log('\nCopy and pure rules');
  for (const c of [
    offerCopy({ plan: 'grandfathered', businessName: 'Royal Elite Moving ', firstName: 'Benny', priceInCents: 4099, freeExpiresAt: null }),
    offerCopy({ plan: 'free', businessName: 'Jazzy', firstName: null, priceInCents: 0, freeExpiresAt: new Date('2027-01-31T04:59:00Z') }),
    offerCopy({ plan: 'free', businessName: 'Jazzy', firstName: 'Jo', priceInCents: 0, freeExpiresAt: null }),
  ]) {
    const t = JSON.stringify(c);
    assert(noDash(t), `offer copy "${c.subject}": no dashes`, t);
    assert(!/8\s?%|percent/i.test(t), `offer copy "${c.subject}": no fee percentage`);
    assert(c.cta.url === 'https://www.goutsyde.com/plan-offer', `offer copy "${c.subject}": button opens the confirm page`);
  }
  assert(offerCopy({ plan: 'grandfathered', businessName: 'X', firstName: null, priceInCents: 4099, freeExpiresAt: null }).body.includes('$40.99 a month'), 'grandfathered offer names the price');
  assert(offerCopy({ plan: 'free', businessName: 'X', firstName: null, priceInCents: 0, freeExpiresAt: null }).body.includes('with no end date'), 'permanent free offer says no end date');
  assert(offerCopy({ plan: 'free', businessName: 'X', firstName: null, priceInCents: 0, freeExpiresAt: new Date('2027-01-31T04:59:00Z') }).body.includes('January 30, 2027'), 'dated free offer names the end day in New York (04:59 UTC on the 31st is the 30th)');

  const ctx: NoticeContext = { vendorSubscriptionId: 'v', vendorId: 'u', businessId: 'b', businessName: 'Biz', ownerEmail: 'o@x.test', ownerFirstName: 'Dana', planName: 'Grandfathered', stripeSubscriptionId: 'sub_1' };
  const live = vendorCopy('activated', ctx, { amountCents: 4099, periodEnd: new Date('2026-11-21T12:00:00Z') })!;
  assert(live.subject === "You're live on Outsyde" && live.body.includes('We charged $40.99') && live.inApp === null, '"You\'re live": charge + renewal day, no second in-app', live);
  const trial = vendorCopy('activated', ctx, { billingStartsAt: new Date('2026-12-01T15:00:00Z') })!;
  assert(trial.body.includes('billing starts on Tuesday, December 1') && !trial.body.includes('We charged'), '"You\'re live" over a dated Free plan: billing start day, no charge line', trial.body);
  const free = vendorCopy('free_started', ctx, { permanent: true })!;
  assert(free.subject === 'Your free Outsyde plan is active' && free.body.includes('with no end date') && !!free.inApp, 'free_started: vendor email, push and in-app', free);
  assert(noDash(JSON.stringify([live, trial, free])), 'new notices: no dashes');

  const now = new Date('2026-10-21T12:00:00Z');
  assert(deferredBillingStart(new Date('2026-10-31T12:00:00Z'), now)?.toISOString() === '2026-10-31T12:00:00.000Z', 'Free ends in 10 days: billing starts then');
  assert(deferredBillingStart(new Date('2026-10-22T12:00:00Z'), now) === null, 'Free ends in 24 hours (under Stripe\'s 48 hour minimum): billing starts now');
  assert(deferredBillingStart(new Date('2099-01-01T00:00:00Z'), now) === null, 'permanent Free plan: billing starts now (Legend 2026-10-21)');
  assert(deferredBillingStart(null, now) === null, 'no Free plan: billing starts now');
}

(async () => {
  pureTests();

  const PG = process.env.OFFERS_LOCAL_PG;
  const STUB_PORT = Number(process.env.STRIPE_STUB_PORT || 0);
  if (!PG) { console.log('\n⏭  DB tests skipped: set OFFERS_LOCAL_PG'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }
  const local = (u: string) => ['localhost', '127.0.0.1'].includes(new URL(u).hostname);
  if (!local(PG) || !STUB_PORT || !process.env.DATABASE_URL || !local(process.env.DATABASE_URL)) throw new Error('refusing: local DB and STRIPE_STUB_PORT required');

  // ── Notice senders replaced: record everything ──
  const sent: { kind: string; to?: string; subject?: string; title?: string; data?: Record<string, string>; type?: string; userId?: string; html?: string }[] = [];
  setSubscriptionNoticeDepsForTest({
    sendEmail: async (p) => { sent.push({ kind: p.to === 'admin@outsyde.test' ? 'admin' : 'vendor', to: p.to, subject: p.subject, html: p.html }); return true; },
    sendPush: async (p) => { sent.push({ kind: 'push', title: p.title, data: p.data, userId: p.userId }); return true; },
    createInApp: async (p) => { sent.push({ kind: 'inapp', title: p.title, type: p.type, userId: p.userId }); },
    adminEmail: 'admin@outsyde.test',
  });
  const take = () => sent.splice(0, sent.length);

  // ── Stripe stub ──
  const now = () => Math.floor(Date.now() / 1000);
  const subs: Record<string, any> = {};
  const customers: Record<string, any> = {};
  const sessions: Record<string, any> = {};
  const calls: { method: string; path: string; form: URLSearchParams }[] = [];
  let seq = 0;
  const newSub = (id: string, price: string, status: string, extra: Record<string, unknown> = {}) => {
    const s = { id, object: 'subscription', status, collection_method: 'charge_automatically', metadata: {}, items: { data: [{ id: `si_${id}`, current_period_start: now(), current_period_end: now() + 30 * 86400, price: { id: price } }] }, ...extra };
    subs[id] = s; return s;
  };
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const [path, qs] = (req.url || '').split('?');
      const form = new URLSearchParams(req.method === 'GET' || req.method === 'DELETE' ? (qs || '') + (raw ? `&${raw}` : '') : raw);
      calls.push({ method: req.method || '', path, form });
      res.setHeader('content-type', 'application/json');
      const send = (o: unknown, code = 200) => { res.statusCode = code; res.end(JSON.stringify(o)); };
      let m: RegExpMatchArray | null;
      if (req.method === 'POST' && path === '/v1/customers') { const id = `cus_new${++seq}`; customers[id] = { id, invoice_settings: { default_payment_method: null }, cards: [] }; return send({ id, object: 'customer' }); }
      if ((m = path.match(/^\/v1\/customers\/([^/]+)$/)) && req.method === 'GET') {
        const c = customers[m[1]]; if (!c) return send({ error: { type: 'invalid_request_error', message: 'No such customer' } }, 404);
        return send({ id: c.id, object: 'customer', invoice_settings: { default_payment_method: c.invoice_settings.default_payment_method } });
      }
      if (path === '/v1/payment_methods' && req.method === 'GET') { const c = customers[form.get('customer') || '']; return send({ object: 'list', data: c?.cards ?? [] }); }
      if (path === '/v1/subscriptions' && req.method === 'POST') {
        const pm = form.get('default_payment_method');
        const id = `sub_new${++seq}`;
        const trialEnd = form.get('trial_end');
        const status = pm === 'pm_sca' ? 'incomplete' : trialEnd ? 'trialing' : 'active';
        const s = newSub(id, form.get('items[0][price]') || '', status, trialEnd ? { trial_end: Number(trialEnd), items: { data: [{ id: `si_${id}`, current_period_start: now(), current_period_end: Number(trialEnd), price: { id: form.get('items[0][price]') } }] } } : {});
        return send({ ...s, latest_invoice: { id: `in_${id}`, amount_paid: status === 'active' ? 4099 : 0, status: status === 'incomplete' ? 'open' : 'paid' } });
      }
      if ((m = path.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
        const s = subs[m[1]]; if (!s) return send({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such subscription' } }, 404);
        if (req.method === 'GET') return send(s);
        if (req.method === 'DELETE') { s.status = 'canceled'; s.ended_at = now(); return send(s); }
        if (req.method === 'POST') { // paid switch
          const u = { ...s, status: 'active', items: { data: [{ id: s.items.data[0].id, current_period_start: now(), current_period_end: now() + 30 * 86400, price: { id: form.get('items[0][price]') } }] } };
          subs[m[1]] = u; return send({ ...u, latest_invoice: { id: 'in_switch', status: 'paid', amount_paid: 4099 } });
        }
      }
      if (path === '/v1/checkout/sessions' && req.method === 'POST') {
        const id = `cs_test_${++seq}`;
        sessions[id] = { id, object: 'checkout.session', status: 'open', url: `https://checkout.stripe.com/c/pay/${id}`, form, metadata: { type: form.get('metadata[type]'), vendorId: form.get('metadata[vendorId]'), businessId: form.get('metadata[businessId]'), tierId: form.get('metadata[tierId]'), offerId: form.get('metadata[offerId]') } };
        return send(sessions[id]);
      }
      if ((m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/)) && req.method === 'POST') { sessions[m[1]].status = 'expired'; return send(sessions[m[1]]); }
      if ((m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/)) && req.method === 'GET') { const s = sessions[m[1]]; return s ? send(s) : send({ error: { type: 'invalid_request_error', message: 'No such session' } }, 404); }
      send({ error: { type: 'invalid_request_error', code: 'resource_missing', message: `stub has no ${req.method} ${path}` } }, 404);
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // Timestamps as Postgres text (UTC, no zone), like Neon: node-pg would read them in this machine's time zone.
  for (const oid of [1114]) pg.types.setTypeParser(oid, (v: string) => v);
  const db = new pg.Client({ connectionString: PG });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const offers = await import('./subscriptions/planOffers');
  const { WebhookHandlers } = await import('./stripe/webhookHandlers');
  const { storage } = await import('./storage');
  const { expireComplimentarySubscriptions } = await import('./services/complimentarySubscription');

  const P = `po${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`.slice(0, 36);
  const GF_PRICE = `price_${P}_gf`, GR_PRICE = `price_${P}_gr`;
  let tierGf = id('t-gf'), tierFree = id('t-free');
  const tierGr = id('t-gr');
  const restore: (() => Promise<void>)[] = [];
  const users: string[] = [], bizs: string[] = [];
  const ADMIN = id('admin');

  try {
    // Reuse a seeded 'grandfathered' / 'waived' tier when the local DB has one (the server seeder makes them);
    // the Grandfathered price is swapped for the test price and put back afterwards.
    const ensureTier = async (name: string, values: unknown[], insert: string) => {
      const ex = (await q(`SELECT id, stripe_price_id FROM subscription_tiers WHERE name = $1`, [name]))[0];
      if (ex) return { id: ex.id as string, created: false, oldPrice: ex.stripe_price_id as string | null };
      await q(insert, values);
      return { id: values[0] as string, created: true, oldPrice: null };
    };
    const gfT = await ensureTier('grandfathered', [tierGf, GF_PRICE], `INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps, stripe_price_id, sort_order, max_staff) VALUES ($1, 'grandfathered', 'Grandfathered', 4099, 800, $2, -1, 8)`);
    const freeT = await ensureTier('waived', [tierFree], `INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps, stripe_price_id, sort_order, max_staff) VALUES ($1, 'waived', 'Free plan', 0, 800, NULL, -2, NULL)`);
    restore.push(async () => {
      if (gfT.created) await q(`DELETE FROM subscription_tiers WHERE id = $1`, [gfT.id]); else await q(`UPDATE subscription_tiers SET stripe_price_id = $2 WHERE id = $1`, [gfT.id, gfT.oldPrice]);
      if (freeT.created) await q(`DELETE FROM subscription_tiers WHERE id = $1`, [freeT.id]);
    });
    await q(`UPDATE subscription_tiers SET stripe_price_id = $2, price_in_cents = 4099, is_active = true WHERE id = $1`, [gfT.id, GF_PRICE]);
    tierGf = gfT.id; tierFree = freeT.id;
    if ((await q(`SELECT count(*)::int AS n FROM subscription_tiers WHERE price_in_cents = 0 AND stripe_price_id IS NULL AND is_active IS NOT FALSE`))[0].n !== 1) throw new Error('need exactly one $0 tier locally');
    await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps, stripe_price_id, sort_order, max_staff) VALUES ($1, $2, 'Growth', 5900, 800, $3, 1, 8)`, [tierGr, `${P}-gr`, GR_PRICE]);

    async function seed(key: string, opts: { sub?: { tier: string; status: string; price?: string; collection?: string; pastDueDaysAgo?: number }; free?: { endsInDays: number | 'permanent' }; card?: 'pm_ok' | 'pm_sca' } = {}) {
      const u = id(`u-${key}`), b = id(`b-${key}`), cus = `cus_${P}_${key}`;
      await q(`INSERT INTO users (id, username, email, password, is_vendor, first_name, stripe_customer_id) VALUES ($1::varchar, $1::text, $2, 'x', true, 'Dana', $3)`, [u, `${u}@po.test`, cus]);
      await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, subscription_active) VALUES ($1::varchar, $2, $3, 'beauty', 'approved', false)`, [b, u, `Biz ${key} `]);
      customers[cus] = { id: cus, invoice_settings: { default_payment_method: null }, cards: opts.card ? [{ id: opts.card, object: 'payment_method', type: 'card', card: { brand: 'visa', last4: '4242' } }] : [] };
      let subId: string | null = null;
      if (opts.sub) {
        subId = `sub_${P}_${key}`;
        newSub(subId, opts.sub.price ?? GR_PRICE, opts.sub.status, { collection_method: opts.sub.collection ?? 'charge_automatically' });
        const pds = opts.sub.pastDueDaysAgo != null ? new Date(Date.now() - opts.sub.pastDueDaysAgo * DAY).toISOString() : null;
        await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, stripe_subscription_id, stripe_customer_id, status, current_period_start, current_period_end, past_due_since)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, now() - interval '20 days', now() + interval '10 days', $8)`, [id(`v-${key}`), u, b, opts.sub.tier, subId, cus, opts.sub.status, pds]);
      } else if (opts.free) {
        const end = opts.free.endsInDays === 'permanent' ? '2099-01-01T00:00:00Z' : new Date(Date.now() + opts.free.endsInDays * DAY).toISOString();
        await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, current_period_start, current_period_end)
                 VALUES ($1, $2, $3, $4, 'active', now(), ($5::timestamptz AT TIME ZONE 'UTC'))`, [id(`v-${key}`), u, b, tierFree, end]);
      }
      await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, status, is_active) VALUES ($1, $2, 'svc', 1000, 30, 'live', true)`, [id(`s-${key}`), b]);
      users.push(u); bizs.push(b);
      return { u, b, cus, subId, svc: id(`s-${key}`) };
    }
    const row = async (b: string) => (await q(`SELECT vs.*, t.name AS tier_name FROM vendor_subscriptions vs JOIN subscription_tiers t ON t.id = vs.tier_id WHERE business_id = $1`, [b]))[0];
    const offerRow = async (b: string) => (await q(`SELECT * FROM plan_offers WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`, [b]))[0];
    const inAppCount = async (u: string) => (await q(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [u]))[0].n;
    const offerFor = async (b: string, body: unknown) => offers.createPlanOffer({ businessId: b, adminId: ADMIN, body });
    const stripeCalls = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path));

    // ── Admin: offer, validation, one pending ──
    console.log('\nAdmin offers');
    const benny = await seed('benny');
    {
      let r = await offerFor(benny.b, { plan: 'pro' });
      assert(r.status === 400, 'unknown plan: 400', r);
      r = await offerFor(benny.b, { plan: 'free', expiresAt: '2020-01-01T00:00:00Z' });
      assert(r.status === 400, 'Free end date in the past: 400', r);
      r = await offerFor(id('nobiz'), { plan: 'grandfathered' });
      assert(r.status === 404, 'unknown business: 404', r);
      take();
      r = await offerFor(benny.b, { plan: 'grandfathered' });
      assert(r.status === 201 && (r.body as any).offer.status === 'pending' && (r.body as any).notified === true, 'Grandfathered offer saved and sent', r);
      const out = take();
      const email = out.find((o) => o.kind === 'vendor');
      assert(email?.to === `${benny.u}@po.test` && email?.subject === 'Your Grandfathered plan is ready' && !!email?.html?.includes('https://www.goutsyde.com/plan-offer'), 'owner emailed with a button to the confirm page', email?.subject);
      assert(out.some((o) => o.kind === 'push' && o.data?.type === 'plan_offer' && o.data?.screen === 'plan_offer' && !!o.data?.offerId), 'phone push typed plan_offer (not subscription_, so the app plan screen hook ignores it)', out);
      assert(out.some((o) => o.kind === 'inapp' && o.type === 'plan_offer'), 'in-app notification', out);
      assert(!out.some((o) => o.kind === 'admin'), 'no admin copy for an offer Legend sent himself');
      assert(!!(await offerRow(benny.b)).notified_at, 'notified_at saved');
      r = await offerFor(benny.b, { plan: 'free', permanent: true });
      assert(r.status === 409 && (r.body as any).error.code === 'OFFER_PENDING', 'second offer while one is pending: 409 OFFER_PENDING', r);
      const sums = await offers.getLatestOfferSummaries([benny.b]);
      assert(sums.get(benny.b)?.plan === 'grandfathered' && sums.get(benny.b)?.status === 'pending', 'admin list summary shows the pending offer', sums.get(benny.b));
    }

    // ── Owner read ──
    console.log('\nOwner reads the offer');
    {
      const r = await offers.getOwnerPlanOffer(benny.u);
      const o = (r.body as any).offer;
      assert(o && o.plan === 'grandfathered' && o.priceInCents === 4099 && o.outcome === 'start_paid' && o.dueTodayCents === 4099 && o.savedCard === null, 'owner sees the offer: Grandfathered, $40.99 today, no saved card', o);
      assert(o.businessName === 'Biz benny' && o.username === benny.u, 'business name trimmed, username shown', o);
      const stranger = await seed('stranger');
      assert((await offers.getOwnerPlanOffer(stranger.u)).body.offer === null, 'another account sees no offer');
      const acc = await offers.acceptPlanOffer({ userId: stranger.u, body: { offerId: o.id } });
      assert(acc.status === 404, 'another account cannot accept it: 404', acc);
    }

    // ── Grandfathered, no card: Checkout, reuse, withdraw ──
    console.log('\nGrandfathered with no saved card: Stripe Checkout');
    {
      const o = (await offers.getOwnerPlanOffer(benny.u)).body.offer as any;
      let r = await offers.acceptPlanOffer({ userId: benny.u, body: { offerId: o.id } });
      const url1 = (r.body as any).checkoutUrl;
      assert(r.status === 200 && /checkout\.stripe\.com/.test(url1), 'accept returns a Stripe Checkout url', r);
      const sid = (await offerRow(benny.b)).checkout_session_id;
      const sess = sessions[sid];
      assert(!!sess && sess.form.get('success_url') === 'https://www.goutsyde.com/subscription/success?session_id={CHECKOUT_SESSION_ID}' && sess.form.get('cancel_url') === 'https://www.goutsyde.com/plan-offer', 'success page gets the session id, cancel goes back to the confirm page', sess?.form?.toString());
      assert(sess.metadata.offerId === o.id && sess.metadata.type === 'vendor_subscription' && sess.metadata.tierId === tierGf && !sess.form.get('subscription_data[trial_end]'), 'checkout metadata carries the offer; no trial', sess.metadata);
      r = await offers.acceptPlanOffer({ userId: benny.u, body: { offerId: o.id } });
      assert((r.body as any).checkoutUrl === url1 && stripeCalls('POST', /^\/v1\/checkout\/sessions$/).length === 1, 'a second tap reuses the open checkout (never two payments)');
      r = await offers.withdrawPlanOffer({ businessId: benny.b, adminId: ADMIN });
      assert(r.status === 200 && (await offerRow(benny.b)).status === 'withdrawn' && sessions[sid].status === 'expired', 'withdraw: offer withdrawn and its open checkout expired', r);
      r = await offers.acceptPlanOffer({ userId: benny.u, body: { offerId: o.id } });
      assert(r.status === 409 && (r.body as any).error.code === 'OFFER_NOT_AVAILABLE', 'accept after withdraw: 409', r);
      r = await offers.withdrawPlanOffer({ businessId: benny.b, adminId: ADMIN });
      assert(r.status === 404, 'withdraw with nothing pending: 404', r);
    }

    // ── Checkout completes (webhook), replay, reconcile ──
    console.log('\nCheckout completes: access at once, announced once');
    {
      const v = await seed('checkout');
      await offerFor(v.b, { plan: 'grandfathered' });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      const sid = (await offerRow(v.b)).checkout_session_id;
      const subId = `sub_${P}_co`;
      newSub(subId, GF_PRICE, 'active');
      sessions[sid] = { ...sessions[sid], status: 'complete', subscription: subId, customer: v.cus, amount_total: 4099 };
      take();
      const inApp0 = await inAppCount(v.u);
      await WebhookHandlers.handleEvent({ type: 'checkout.session.completed', data: { object: sessions[sid] } });
      let r = await row(v.b);
      assert(r?.status === 'active' && r.tier_name === 'grandfathered' && r.stripe_subscription_id === subId, 'row active on Grandfathered', r);
      assert((await storage.isBusinessSubscriptionActive(v.b)).active === true, 'business active the moment checkout completes');
      assert((await offerRow(v.b)).status === 'accepted', 'offer accepted');
      let out = take();
      assert(out.filter((o) => o.kind === 'vendor' && o.subject === "You're live on Outsyde").length === 1 && out.some((o) => o.kind === 'push' && o.title === "You're live on Outsyde"), 'vendor gets "You\'re live" email + push', out);
      assert(out.some((o) => o.kind === 'admin' && /New plan started/.test(o.subject!)), 'Outsyde copy');
      assert(!out.some((o) => o.kind === 'inapp'), 'notice adds no in-app (the existing trigger does)');
      const inApp1 = await inAppCount(v.u);
      assert(inApp1 - inApp0 === 2, 'in-app: plan activated + payment succeeded, once', { inApp0, inApp1 });
      // Stripe retries the event, and the success page reconciles too.
      await WebhookHandlers.handleEvent({ type: 'checkout.session.completed', data: { object: sessions[sid] } });
      const rec = await offers.reconcileCheckoutSession({ userId: v.u, body: { sessionId: sid } });
      assert(rec.status === 200 && (rec.body as any).active === true, 'reconcile: active', rec);
      assert(take().length === 0 && (await inAppCount(v.u)) === inApp1, 'replay + reconcile send nothing new and add no in-app rows');
      const other = await seed('other');
      const bad = await offers.reconcileCheckoutSession({ userId: other.u, body: { sessionId: sid } });
      assert(bad.status === 404, 'reconcile by another account: 404', bad);
      assert((await offers.reconcileCheckoutSession({ userId: v.u, body: { sessionId: 'nope' } })).status === 400, 'reconcile with a bad id: 400');
    }

    console.log('\nReconcile when the webhook never arrived');
    {
      const v = await seed('recon');
      await offerFor(v.b, { plan: 'grandfathered' });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      const sid = (await offerRow(v.b)).checkout_session_id;
      let rec = await offers.reconcileCheckoutSession({ userId: v.u, body: { sessionId: sid } });
      assert(rec.status === 200 && (rec.body as any).active === false && (rec.body as any).checkoutStatus === 'open', 'still open: not active, nothing written', rec);
      const subId = `sub_${P}_rc`;
      newSub(subId, GF_PRICE, 'active');
      sessions[sid] = { ...sessions[sid], status: 'complete', subscription: subId, customer: v.cus, amount_total: 4099 };
      take();
      rec = await offers.reconcileCheckoutSession({ userId: v.u, body: { sessionId: sid } });
      assert((rec.body as any).active === true && (await row(v.b))?.stripe_subscription_id === subId && (await offerRow(v.b)).status === 'accepted', 'reconcile activates and accepts the offer', rec);
      assert(take().filter((x) => x.subject === "You're live on Outsyde").length === 1, 'announced once by reconcile');
      await WebhookHandlers.handleEvent({ type: 'checkout.session.completed', data: { object: sessions[sid] } });
      assert(take().length === 0, 'the late webhook sends nothing new');
    }

    // ── One tap with a saved card ──
    console.log('\nOne tap with a saved card');
    {
      const v = await seed('onetap', { card: 'pm_ok' });
      await offerFor(v.b, { plan: 'grandfathered' });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      assert(o.savedCard?.last4 === '4242' && o.savedCard?.brand === 'visa', 'confirm page sees the saved card', o.savedCard);
      take();
      const before = stripeCalls('POST', /^\/v1\/subscriptions$/).length;
      const r = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      assert(r.status === 200 && (r.body as any).accepted === true && !(r.body as any).checkoutUrl, 'accepted in one tap, no checkout', r);
      const create = stripeCalls('POST', /^\/v1\/subscriptions$/).slice(before)[0];
      assert(!!create && create.form.get('default_payment_method') === 'pm_ok' && create.form.get('payment_behavior') === 'allow_incomplete' && create.form.get('metadata[offerId]') === o.id && !create.form.get('trial_end'), 'subscription charged now on the saved card', create?.form?.toString());
      const rr = await row(v.b);
      assert(rr?.status === 'active' && rr.tier_name === 'grandfathered' && !!rr.stripe_subscription_id, 'row written by the route itself (no webhook needed)', rr);
      assert((await offerRow(v.b)).status === 'accepted' && (await storage.isBusinessSubscriptionActive(v.b)).active, 'offer accepted, business active');
      assert(take().filter((x) => x.subject === "You're live on Outsyde").length === 1, '"You\'re live" once');
      // Stripe's own events for that subscription arrive afterwards
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.created', data: { object: subs[rr.stripe_subscription_id] } });
      await WebhookHandlers.handleEvent({ type: 'invoice.paid', data: { object: { id: `in_${rr.stripe_subscription_id}`, object: 'invoice', billing_reason: 'subscription_create', amount_paid: 4099, parent: { type: 'subscription_details', subscription_details: { subscription: rr.stripe_subscription_id } } } } });
      assert(take().length === 0 && (await row(v.b))?.status === 'active', 'later Stripe events change nothing and send nothing');
    }

    console.log('\nOne tap needs a bank confirmation: falls back to Checkout');
    {
      const v = await seed('sca', { card: 'pm_sca' });
      await offerFor(v.b, { plan: 'grandfathered' });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      const r = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      assert(/checkout\.stripe\.com/.test((r.body as any).checkoutUrl ?? ''), 'Checkout url returned', r);
      const incomplete = Object.values(subs).find((s: any) => s.items.data[0].price.id === GF_PRICE && stripeCalls('DELETE', new RegExp(`/v1/subscriptions/${s.id}$`)).length > 0);
      assert(!!incomplete && (incomplete as any).status === 'canceled', 'the unpaid subscription was cancelled');
      assert(!(await row(v.b)), 'no row written for the unpaid attempt');
      assert((await offerRow(v.b)).status === 'pending', 'offer still pending');
      const r2 = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id, useCheckout: true } });
      assert((r2.body as any).checkoutUrl === (r.body as any).checkoutUrl, '"Change" (useCheckout) goes to the same open checkout');
    }

    // ── Grandfathered over a live paid plan ──
    console.log('\nGrandfathered over a live paid plan: paid switch');
    {
      const v = await seed('switch', { sub: { tier: tierGr, status: 'active', price: GR_PRICE } });
      await q(`UPDATE businesses SET subscription_active = true WHERE id = $1`, [v.b]);
      await offerFor(v.b, { plan: 'grandfathered' });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      assert(o.outcome === 'switch_paid' && o.dueTodayCents === 4099 && o.currentPlanName === 'Growth', 'confirm page: switch now, full price today', o);
      const r = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      assert(r.status === 200 && (r.body as any).accepted === true, 'accepted', r);
      const upd = stripeCalls('POST', new RegExp(`/v1/subscriptions/${v.subId}$`)).pop();
      assert(upd?.form.get('proration_behavior') === 'none' && upd?.form.get('billing_cycle_anchor') === 'now' && upd?.form.get('items[0][price]') === GF_PRICE, 'Stripe switch: full new price now, billing date restarts, no credit', upd?.form?.toString());
      assert((await row(v.b))?.tier_name === 'grandfathered' && (await offerRow(v.b)).status === 'accepted', 'tier switched, offer accepted');
    }

    console.log('\nGrandfathered over a Send invoice plan: refused');
    {
      const v = await seed('invoice', { sub: { tier: tierGr, status: 'active', price: GR_PRICE, collection: 'send_invoice' } });
      await offerFor(v.b, { plan: 'grandfathered' });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      assert(o.outcome === 'invoice_billed', 'confirm page knows it is billed by invoice', o.outcome);
      const r = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      assert(r.status === 400 && (r.body as any).error.code === 'NOT_SWITCHABLE' && (await offerRow(v.b)).status === 'pending' && (await row(v.b)).tier_id === tierGr, 'refused with the invoice message; nothing changed', r);
    }

    console.log('\nGrandfathered while the paid plan switch is waiting on the bank: webhook completes the offer');
    {
      const v = await seed('pendsw', { sub: { tier: tierGr, status: 'active', price: GR_PRICE } });
      await offerFor(v.b, { plan: 'grandfathered' });
      // The vendor paid on Stripe's page; Stripe sends subscription.updated with the Grandfathered price.
      subs[v.subId!].items.data[0].price.id = GF_PRICE;
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.updated', data: { object: subs[v.subId!] } });
      assert((await row(v.b)).tier_name === 'grandfathered' && (await offerRow(v.b)).status === 'accepted', 'tier saved and offer accepted from the webhook');
    }

    // ── Grandfathered over the Free plan ──
    console.log('\nGrandfathered over a dated Free plan: billing starts when it ends');
    {
      const v = await seed('overfree', { free: { endsInDays: 10 }, card: 'pm_ok' });
      await offerFor(v.b, { plan: 'grandfathered' });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      const freeEnd = new Date(String((await row(v.b)).current_period_end).replace(' ', 'T') + 'Z');
      assert(o.outcome === 'start_paid_after_free' && o.dueTodayCents === 0 && Math.abs(new Date(o.billingStartsAt).getTime() - freeEnd.getTime()) < 1000, 'confirm page: nothing due today, billing starts when Free ends', { o, freeEnd });
      take();
      const before = stripeCalls('POST', /^\/v1\/subscriptions$/).length;
      const r = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      const create = stripeCalls('POST', /^\/v1\/subscriptions$/).slice(before)[0];
      assert(r.status === 200 && Math.abs(Number(create?.form.get('trial_end')) * 1000 - freeEnd.getTime()) < 1000, 'Stripe subscription starts on a trial that ends with the Free plan', { r, trial: create?.form.get('trial_end') });
      const rr = await row(v.b);
      assert(rr.status === 'trialing' && rr.tier_name === 'grandfathered' && !!rr.stripe_subscription_id, 'row: Grandfathered, trialing, linked to Stripe', rr);
      assert((await storage.isBusinessSubscriptionActive(v.b)).active === true, 'business stays active');
      assert((await q(`SELECT subscription_active FROM businesses WHERE id = $1`, [v.b]))[0].subscription_active === true, 'search cache flag on');
      await expireComplimentarySubscriptions();
      assert((await row(v.b)).status === 'trialing', 'the Free plan expiry job leaves it alone');
      const out = take();
      const live = out.find((x) => x.subject === "You're live on Outsyde");
      assert(!!live && /billing starts on/.test(live.html ?? ''), '"You\'re live" says when billing starts', live?.subject);
      assert((await inAppCount(v.u)) >= 1, 'in-app plan activated');
      // Stripe's trialing subscription.updated must keep the search cache flag on
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.updated', data: { object: subs[rr.stripe_subscription_id] } });
      assert((await q(`SELECT subscription_active FROM businesses WHERE id = $1`, [v.b]))[0].subscription_active === true, 'a trialing subscription.updated keeps the cache flag on (was set false before)');
    }

    console.log('\nGrandfathered over a dated Free plan through Checkout');
    {
      const v = await seed('overfreeco', { free: { endsInDays: 10 } });
      await offerFor(v.b, { plan: 'grandfathered' });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      const sid = (await offerRow(v.b)).checkout_session_id;
      assert(!!sessions[sid].form.get('subscription_data[trial_end]'), 'checkout carries the trial end');
      assert((await row(v.b)).tier_name === 'waived', 'Free plan untouched until the checkout completes');
    }

    console.log('\nGrandfathered over a permanent Free plan: billing starts today');
    {
      const v = await seed('overperm', { free: { endsInDays: 'permanent' }, card: 'pm_ok' });
      await offerFor(v.b, { plan: 'grandfathered' });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      assert(o.outcome === 'replace_free_with_paid' && o.dueTodayCents === 4099 && o.billingStartsAt === null, 'confirm page: $40.99 today, Free plan ends', o);
      const before = stripeCalls('POST', /^\/v1\/subscriptions$/).length;
      await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      const create = stripeCalls('POST', /^\/v1\/subscriptions$/).slice(before)[0];
      assert(!create?.form.get('trial_end') && (await row(v.b)).status === 'active' && (await row(v.b)).tier_name === 'grandfathered', 'charged now, row Grandfathered active');
    }

    console.log('\nGrandfathered offer to a business already on it: refused');
    {
      const v = await seed('ongf', { sub: { tier: tierGf, status: 'active', price: GF_PRICE } });
      const r = await offerFor(v.b, { plan: 'grandfathered' });
      assert(r.status === 409 && (r.body as any).error.code === 'ALREADY_ON_PLAN', '409 ALREADY_ON_PLAN', r);
    }

    // ── Free offers ──
    console.log('\nFree offer, no plan: one tap');
    {
      const v = await seed('free');
      take();
      let r = await offerFor(v.b, { plan: 'free', permanent: true });
      assert(r.status === 201, 'Free offer saved', r);
      assert(take().some((x) => x.kind === 'vendor' && x.subject === 'You won a free Outsyde plan'), 'owner emailed "You won a free Outsyde plan"');
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      assert(o.outcome === 'start_free' && o.permanent === true && o.dueTodayCents === 0 && o.savedCard === null, 'confirm: free now, permanent', o);
      r = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      const rr = await row(v.b);
      assert(r.status === 200 && rr.tier_name === 'waived' && rr.status === 'active' && String(rr.current_period_end).startsWith('2099-01-01') && rr.stripe_subscription_id === null, 'Free row active until 2099, no Stripe', rr);
      assert((await offerRow(v.b)).status === 'accepted' && (await storage.isBusinessSubscriptionActive(v.b)).active, 'offer accepted, business active');
      const out = take();
      assert(out.some((x) => x.kind === 'vendor' && x.subject === 'Your free Outsyde plan is active') && out.some((x) => x.kind === 'admin' && /Free plan started/.test(x.subject!)) && out.some((x) => x.kind === 'inapp'), 'free plan active: vendor email + push + in-app, Outsyde copy', out);
      r = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      assert(r.status === 409, 'accepting twice: 409, nothing more written', r);
      const audit = await q(`SELECT action FROM audit_logs WHERE action = 'plan_offer.accept_free' AND target_id = $1`, [rr.id]);
      assert(audit.length === 1, 'one audit row for the accept');
    }

    console.log('\nFree offer over a live paid plan: paid plan cancelled now, no pause, no "plan ended"');
    {
      const v = await seed('freeoverpaid', { sub: { tier: tierGr, status: 'active', price: GR_PRICE } });
      await offerFor(v.b, { plan: 'free', expiresAt: new Date(Date.now() + 60 * DAY).toISOString() });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      assert(o.outcome === 'replace_paid_with_free', 'confirm page knows the paid plan will end', o.outcome);
      take();
      const r = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      const rr = await row(v.b);
      assert(r.status === 200 && rr.tier_name === 'waived' && rr.stripe_subscription_id === null && rr.stripe_customer_id === null, 'Free row written over the paid one', rr);
      const del = stripeCalls('DELETE', new RegExp(`/v1/subscriptions/${v.subId}$`)).pop();
      assert(!!del && del.form.get('prorate') === 'false' && del.form.get('invoice_now') === 'false' && subs[v.subId!].status === 'canceled', 'old Stripe subscription cancelled now, no proration refund', del?.form?.toString());
      take();
      await WebhookHandlers.handleEvent({ type: 'customer.subscription.deleted', data: { object: subs[v.subId!] } });
      assert((await q(`SELECT status FROM vendor_services WHERE id = $1`, [v.svc]))[0].status === 'live', 'Stripe\'s "subscription deleted" pauses nothing');
      assert(!take().some((x) => /plan has ended|Plan ended/i.test(x.subject ?? '')), 'no "plan ended" email');
      assert((await storage.isBusinessSubscriptionActive(v.b)).active === true, 'business stays active on Free');
    }

    console.log('\nFree offer to a business whose paid plan lapsed: listings come back');
    {
      const v = await seed('lapsed', { sub: { tier: tierGr, status: 'past_due', price: GR_PRICE, pastDueDaysAgo: 9 } });
      const { enforceSubscriptionAccess } = await import('./subscriptions/lifecycle');
      await enforceSubscriptionAccess(v.b, 'test');
      assert((await q(`SELECT status FROM vendor_services WHERE id = $1`, [v.svc]))[0].status === 'paused', 'setup: lapsed plan paused the service');
      await offerFor(v.b, { plan: 'free', permanent: true });
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      assert((await q(`SELECT status FROM vendor_services WHERE id = $1`, [v.svc]))[0].status === 'live', 'system paused service is live again');
      assert((await row(v.b)).past_due_since === null, 'late marker cleared');
    }

    console.log('\nFree offer that expired before it was accepted');
    {
      const v = await seed('expired');
      await offerFor(v.b, { plan: 'free', expiresAt: new Date(Date.now() + DAY).toISOString() });
      await q(`UPDATE plan_offers SET free_expires_at = now() - interval '1 hour' WHERE business_id = $1`, [v.b]);
      const o = (await offers.getOwnerPlanOffer(v.u)).body.offer as any;
      const r = await offers.acceptPlanOffer({ userId: v.u, body: { offerId: o.id } });
      assert(r.status === 409 && !(await row(v.b)), '409, nothing written', r);
    }

    console.log('\nFree offer to a business already on Free: refused');
    {
      const v = await seed('onfree', { free: { endsInDays: 30 } });
      const r = await offerFor(v.b, { plan: 'free', permanent: true });
      assert(r.status === 409 && (r.body as any).error.code === 'ALREADY_ON_PLAN' && /Extend/.test((r.body as any).error.message), '409 with "use Extend"', r);
    }

    // ── Checkout activation regressions (no offer) ──
    console.log('\nCheckout without an offer (regression of the shared activation)');
    {
      const v = await seed('plainco', { sub: { tier: tierGr, status: 'past_due', price: GR_PRICE, pastDueDaysAgo: 2 } });
      const newId = `sub_${P}_plain`;
      newSub(newId, GR_PRICE, 'active');
      await WebhookHandlers.handleEvent({ type: 'checkout.session.completed', data: { object: { id: `cs_${P}_plain`, subscription: newId, customer: v.cus, amount_total: 5900, metadata: { type: 'vendor_subscription', vendorId: v.u, businessId: v.b, tierId: tierGr } } } });
      const rr = await row(v.b);
      assert(rr.stripe_subscription_id === newId && rr.status === 'active' && rr.past_due_since === null, 'resubscribe: row moved to the new subscription, late cleared', rr);
      assert(subs[v.subId!].status === 'canceled', 'old subscription cancelled (never billed twice)');

      const n = await seed('plainnew');
      const nid = `sub_${P}_new`;
      newSub(nid, GR_PRICE, 'active');
      await WebhookHandlers.handleEvent({ type: 'checkout.session.completed', data: { object: { id: `cs_${P}_new`, subscription: nid, customer: n.cus, amount_total: 5900, metadata: { type: 'vendor_subscription', vendorId: n.u, businessId: n.b, tierId: tierGr } } } });
      assert((await row(n.b))?.stripe_subscription_id === nid && (await row(n.b))?.status === 'active', 'brand new business: row created and active');

      const f = await seed('stale', { free: { endsInDays: 30 } });
      const deadId = `sub_${P}_dead`;
      newSub(deadId, GR_PRICE, 'canceled');
      await WebhookHandlers.handleEvent({ type: 'checkout.session.completed', data: { object: { id: `cs_${P}_dead`, subscription: deadId, customer: f.cus, metadata: { type: 'vendor_subscription', vendorId: f.u, businessId: f.b, tierId: tierGr } } } });
      assert((await row(f.b)).tier_name === 'waived', 'stale checkout for a dead subscription never overwrites a Free row');
    }
  } finally {
    setSubscriptionNoticeDepsForTest(null);
    if (bizs.length) {
      await q(`DELETE FROM plan_offers WHERE business_id = ANY($1)`, [bizs]);
      await q(`DELETE FROM subscription_paused_items WHERE business_id = ANY($1)`, [bizs]);
      await q(`DELETE FROM subscription_notices WHERE vendor_subscription_id IN (SELECT id FROM vendor_subscriptions WHERE business_id = ANY($1))`, [bizs]);
      await q(`DELETE FROM benefit_allowances WHERE subscription_id IN (SELECT id FROM vendor_subscriptions WHERE business_id = ANY($1))`, [bizs]).catch(() => {});
      await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]);
      await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]);
      await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    }
    if (users.length) {
      await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [users]);
      await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    }
    await q(`DELETE FROM subscription_tiers WHERE id = $1`, [tierGr]);
    for (const f of restore) await f();
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
