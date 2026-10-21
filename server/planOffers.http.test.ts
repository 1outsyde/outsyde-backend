/**
 * Hidden plan offers, HTTP: auth and wiring of the new routes. Run with: npx tsx server/planOffers.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema + 060 + 062)
 * and the same JWT_SECRET in this process:
 *   OFFERS_TEST_BASE_URL  e.g. http://localhost:5071   (must be localhost)
 *   OFFERS_TEST_PG_URL    the SAME scratch database (localhost only; seeds + cleans up)
 * Skips (exit 0) when OFFERS_TEST_BASE_URL is unset and refuses any non-local host. The accept paths that reach
 * Stripe are covered in-process by server/planOffers.test.ts; this file only uses the Free plan (no Stripe).
 */
const BASE = process.env.OFFERS_TEST_BASE_URL;
const PG_URL = process.env.OFFERS_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) { console.log('⏭  skipped: set OFFERS_TEST_BASE_URL (+ OFFERS_TEST_PG_URL)'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: base URL and database must both be local scratch instances');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-jwt-secret';

  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `ph${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`.slice(0, 36);
  let tierGf = '', tierFree = '';
  const users: string[] = [], bizs: string[] = [];
  let ipSeq = 0;
  async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json };
  }

  try {
    // The server seeder makes 'grandfathered' and 'waived'; reuse them (nothing here reaches Stripe).
    const t = async (name: string) => (await q(`SELECT id FROM subscription_tiers WHERE name = $1`, [name]))[0]?.id as string | undefined;
    tierGf = (await t('grandfathered')) ?? ''; tierFree = (await t('waived')) ?? '';
    if (!tierGf || !tierFree) throw new Error('boot the server once so its seeder creates the grandfathered and waived tiers');
    const mk = async (key: string, opts: { email?: string; admin?: boolean } = {}) => {
      const u = id(`u-${key}`), b = id(`b-${key}`);
      await q(`INSERT INTO users (id, username, email, password, is_vendor, is_admin, first_name) VALUES ($1::varchar, $1::text, $2, 'x', true, $3, 'Dana')`, [u, opts.email ?? `${u}@ph.test`, !!opts.admin]);
      await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1::varchar, $2, $3, 'beauty', 'approved')`, [b, u, `Biz ${key}`]);
      users.push(u); bizs.push(b);
      return { u, b, jwt: generateAccessToken({ userId: u, isVendor: true, isAdmin: !!opts.admin } as any) };
    };
    const existingAdmin = (await q(`SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com'`))[0];
    if (existingAdmin) throw new Error('local DB already has info@goutsyde.com; use a clean scratch database');
    const admin = await mk('admin', { email: 'info@goutsyde.com', admin: true });
    const owner = await mk('owner');
    const other = await mk('other');
    const fakeAdmin = await mk('fake', { admin: true }); // is_admin but not an allowed admin email

    console.log('\nAdmin routes');
    const path = `/api/admin/businesses/${owner.b}/plan-offer`;
    let r = await call('POST', path, { body: { plan: 'free', permanent: true } });
    assert(r.status === 401, 'no token: 401', r);
    r = await call('POST', path, { token: owner.jwt, body: { plan: 'free', permanent: true } });
    assert(r.status === 403, 'vendor token: 403', r);
    r = await call('POST', path, { token: fakeAdmin.jwt, body: { plan: 'free', permanent: true } });
    assert(r.status === 403, 'is_admin without an allowed admin email: 403', r);
    r = await call('POST', path, { token: admin.jwt, body: { plan: 'free', permanent: true } });
    assert(r.status === 201 && r.body?.offer?.plan === 'free' && r.body?.offer?.permanent === true, 'admin: offer saved (201)', r);
    r = await call('POST', path, { token: admin.jwt, body: { plan: 'free', expiresAt: new Date(Date.now() + 9 * 86400000).toISOString() } });
    assert(r.status === 409 && r.body?.error?.code === 'OFFER_PENDING', 'second offer: 409', r);
    r = await call('GET', `/api/admin/businesses?search=${encodeURIComponent(`Biz owner`)}&limit=200`, { token: admin.jwt });
    const listed = (r.body?.businesses ?? []).find((b: any) => b.id === owner.b);
    assert(r.status === 200 && listed?.planOffer?.status === 'pending' && listed?.ownerUsername === owner.u && 'subscription' in listed, 'admin list: additive planOffer + ownerUsername, existing fields kept', listed);

    console.log('\nOwner routes');
    r = await call('GET', '/api/vendor/plan-offer');
    assert(r.status === 401, 'read without a token: 401', r);
    r = await call('GET', '/api/vendor/plan-offer', { token: other.jwt });
    assert(r.status === 200 && r.body?.offer === null, 'another owner: no offer', r);
    r = await call('GET', '/api/vendor/plan-offer', { token: owner.jwt });
    const offer = r.body?.offer;
    assert(r.status === 200 && offer?.plan === 'free' && offer?.outcome === 'start_free' && offer?.dueTodayCents === 0, 'owner: sees the Free offer', r);
    r = await call('GET', '/api/subscription-tiers', { token: owner.jwt });
    assert(r.status === 200 && !(r.body?.tiers ?? []).some((t: any) => t.id === tierFree || t.id === tierGf), 'a pending offer never makes a hidden plan show in the plan list', r.body?.tiers?.map((t: any) => t.name));
    r = await call('POST', '/api/vendor/plan-offer/accept', { body: { offerId: offer.id } });
    assert(r.status === 401, 'accept without a token: 401', r);
    r = await call('POST', '/api/vendor/plan-offer/accept', { token: other.jwt, body: { offerId: offer.id } });
    assert(r.status === 404, 'accept by another owner: 404', r);
    r = await call('POST', '/api/vendor/plan-offer/accept', { token: owner.jwt, body: {} });
    assert(r.status === 400, 'accept without offerId: 400', r);
    r = await call('POST', '/api/vendor/plan-offer/accept', { token: owner.jwt, body: { offerId: offer.id } });
    assert(r.status === 200 && r.body?.accepted === true && r.body?.permanent === true, 'owner accepts the Free plan', r);
    r = await call('GET', '/api/vendor/subscription', { token: owner.jwt });
    assert(r.status === 200 && (r.body?.subscription?.status ?? r.body?.status) === 'active', 'GET /api/vendor/subscription shows the active plan', r.body);
    r = await call('GET', '/api/vendor/plan-offer', { token: owner.jwt });
    assert(r.body?.offer === null, 'accepted offer no longer shows', r);

    console.log('\nWithdraw and reconcile');
    const second = await mk('second');
    await call('POST', `/api/admin/businesses/${second.b}/plan-offer`, { token: admin.jwt, body: { plan: 'free', expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() } });
    r = await call('DELETE', `/api/admin/businesses/${second.b}/plan-offer`, { token: owner.jwt });
    assert(r.status === 403, 'withdraw by a vendor: 403', r);
    r = await call('DELETE', `/api/admin/businesses/${second.b}/plan-offer`, { token: admin.jwt });
    assert(r.status === 200 && r.body?.offer?.status === 'withdrawn', 'admin withdraws', r);
    r = await call('DELETE', `/api/admin/businesses/${second.b}/plan-offer`, { token: admin.jwt });
    assert(r.status === 404, 'nothing left to withdraw: 404', r);
    r = await call('POST', '/api/vendor/subscription/reconcile', { body: { sessionId: 'cs_x' } });
    assert(r.status === 401, 'reconcile without a token: 401', r);
    r = await call('POST', '/api/vendor/subscription/reconcile', { token: owner.jwt, body: { sessionId: 'bad id' } });
    assert(r.status === 400, 'reconcile with a bad id: 400', r);
  } finally {
    if (bizs.length) {
      await q(`DELETE FROM plan_offers WHERE business_id = ANY($1)`, [bizs]);
      await q(`DELETE FROM audit_logs WHERE target_id = ANY($1) OR target_id IN (SELECT id FROM vendor_subscriptions WHERE business_id = ANY($1))`, [bizs]).catch(() => {});
      await q(`DELETE FROM subscription_notices WHERE vendor_subscription_id IN (SELECT id FROM vendor_subscriptions WHERE business_id = ANY($1))`, [bizs]);
      await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]);
      await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    }
    if (users.length) {
      await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [users]);
      await q(`DELETE FROM refresh_tokens WHERE user_id = ANY($1)`, [users]).catch(() => {});
      await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    }
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
