/**
 * Hidden-plan purchase guard — run with: npx tsx server/tierPurchase.test.ts
 * Pure logic only (no database, no Stripe). The HTTP behaviour of the three routes is covered by
 * server/tierPurchase.http.test.ts against a local scratch server.
 */

import { createHmac } from 'crypto';
// The real grant-token module reads its secret at import time (complimentary.ts imports it), so the
// test secret must be set BEFORE anything is imported: everything below is imported dynamically.
process.env.GRANT_LINK_SECRET = 'unit-test-grant-secret';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

const STARTER = { id: 'tier-starter', sortOrder: 0, isActive: true };
const PRO = { id: 'tier-pro', sortOrder: 2, isActive: true };
const GF = { id: 'tier-gf', sortOrder: -1, isActive: true };
const WAIVED = { id: 'tier-waived', sortOrder: -2, isActive: true };
const B1 = 'biz-1';
const B2 = 'biz-2';
const ALLOW = 'allow';

(async () => {
  const { TIER_NOT_AVAILABLE, TIER_NOT_AVAILABLE_MESSAGE, tierPurchaseDecision, verifyGrantSafely } = await import('./complimentary');
  const decide = (tier: { id: string; sortOrder?: number | null; isActive?: boolean | null }, row: string | null, grant: { businessId: string; tierId: string } | null = null, biz = B1) =>
    tierPurchaseDecision({ tier, currentRowTierId: row, businessId: biz, grantPayload: grant });

  console.log('\nTest 1: visible plans');
  assert(decide(STARTER, null) === ALLOW && decide(PRO, null) === ALLOW, 'visible plans (sortOrder >= 0) are allowed for anyone, with no row');
  assert(decide(STARTER, 'tier-pro') === ALLOW, 'visible plan, caller on another plan');
  assert(decide({ id: 'x', sortOrder: null, isActive: true }, null) === ALLOW && decide({ id: 'x' }, null) === ALLOW, 'null / missing sortOrder counts as 0 → visible');
  assert(decide({ id: 'x', sortOrder: 0, isActive: null }, null) === ALLOW, 'isActive null is not "false" → visible');
  assert(decide({ id: 'x', sortOrder: 0, isActive: false }, null) === TIER_NOT_AVAILABLE, 'inactive visible plan → refused');
  assert(decide({ id: 'x', sortOrder: 1, isActive: false }, 'other') === TIER_NOT_AVAILABLE, 'inactive visible plan → refused even with another row');

  console.log('\nTest 2: hidden plans');
  assert(decide(GF, null) === TIER_NOT_AVAILABLE, 'hidden, no row, no grant → refused (new vendor)');
  assert(decide(GF, 'tier-pro') === TIER_NOT_AVAILABLE, 'hidden, on Pro, no grant → refused');
  assert(decide(GF, 'tier-waived') === TIER_NOT_AVAILABLE, 'hidden, on the waived plan, no grant → refused');
  assert(decide(WAIVED, null) === TIER_NOT_AVAILABLE, 'the complimentary tier is hidden too');
  assert(decide({ id: 'gf', sortOrder: -1, isActive: false }, null) === TIER_NOT_AVAILABLE, 'hidden + inactive → refused');

  console.log('\nTest 3: own tier, any status (the row status is not an input)');
  assert(decide(GF, 'tier-gf') === ALLOW, 'own tier → allowed (works for active, canceled and past_due alike: only the row tier id matters)');
  assert(decide({ id: 'gf', sortOrder: -1, isActive: false }, 'gf') === ALLOW, 'own tier stays allowed even if the plan was deactivated');
  assert(decide(GF, '') === TIER_NOT_AVAILABLE && decide(GF, null) === TIER_NOT_AVAILABLE, 'an empty row tier id never matches');
  assert(decide(GF, 'tier-gf-other') === TIER_NOT_AVAILABLE, 'a different row tier does not match');

  console.log('\nTest 4: grant matrix');
  assert(decide(GF, null, { businessId: B1, tierId: GF.id }) === ALLOW, 'valid grant: this business + this tier → allowed');
  assert(decide(GF, 'tier-pro', { businessId: B1, tierId: GF.id }) === ALLOW, 'valid grant for a business on another plan → allowed');
  assert(decide(GF, null, { businessId: B2, tierId: GF.id }) === TIER_NOT_AVAILABLE, 'wrong business → refused');
  assert(decide(GF, null, { businessId: B1, tierId: 'tier-other' }) === TIER_NOT_AVAILABLE, 'wrong tier → refused');
  assert(decide(GF, null, null) === TIER_NOT_AVAILABLE, 'no grant → refused');
  assert(decide(GF, null, { businessId: '', tierId: GF.id }, '') === TIER_NOT_AVAILABLE, 'an empty business id never matches an empty grant business');
  assert(decide(WAIVED, null, { businessId: B1, tierId: WAIVED.id }) === ALLOW, 'the decision itself does not special-case complimentary tiers (routes refuse them earlier, by price)');
  assert(TIER_NOT_AVAILABLE === 'TIER_NOT_AVAILABLE' && TIER_NOT_AVAILABLE_MESSAGE === "This plan isn't available for your account.", 'refusal code and static message');

  console.log('\nTest 5: verifyGrantSafely with the REAL grant token module');
  const { grantToken } = await import('./utils/grantToken');
  const good = grantToken.generate(B1, GF.id);
  const p = verifyGrantSafely(good);
  assert(!!p && p.businessId === B1 && p.tierId === GF.id, 'a valid token → { businessId, tierId }');
  assert(decide(GF, null, verifyGrantSafely(good)) === ALLOW, 'valid token + decision → allowed');
  assert(decide(GF, null, verifyGrantSafely(grantToken.generate(B2, GF.id))) === TIER_NOT_AVAILABLE, "another business's token → refused");
  assert(decide(GF, null, verifyGrantSafely(grantToken.generate(B1, 'tier-other'))) === TIER_NOT_AVAILABLE, "a token for another tier → refused");

  const sign = (payload: object) => {
    const enc = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${enc}.${createHmac('sha256', 'unit-test-grant-secret').update(enc).digest('base64url')}`;
  };
  const expired = sign({ businessId: B1, tierId: GF.id, exp: Date.now() - 1000 });
  assert(verifyGrantSafely(expired) === null, 'expired (TOKEN_EXPIRED) → null');
  const [enc, sig] = good.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ businessId: B2, tierId: GF.id, exp: Date.now() + 1e9 })).toString('base64url');
  assert(verifyGrantSafely(`${tamperedPayload}.${sig}`) === null, 'tampered payload with the old signature → null');
  assert(verifyGrantSafely(`${enc}.${sig.slice(0, -2)}xx`) === null, 'tampered signature → null');
  assert(verifyGrantSafely(good.replace('.', '')) === null && verifyGrantSafely(`${good}.extra`) === null, 'wrong number of parts → null');
  const wrongSecret = (() => { const e = Buffer.from(JSON.stringify({ businessId: B1, tierId: GF.id, exp: Date.now() + 1e9 })).toString('base64url'); return `${e}.${createHmac('sha256', 'other').update(e).digest('base64url')}`; })();
  assert(verifyGrantSafely(wrongSecret) === null, 'signed with another secret → null');
  assert(verifyGrantSafely(sign({ businessId: 5, tierId: GF.id, exp: Date.now() + 1e9 })) === null, 'a validly-signed payload with a non-string businessId → null');
  for (const bad of [undefined, null, '', 123, true, {}, [], ['a.b'], 0]) {
    let threw = false;
    let out: unknown = 'x';
    try { out = verifyGrantSafely(bad as unknown); } catch { threw = true; }
    assert(!threw && out === null, `missing / non-string ${JSON.stringify(bad)} → null, no throw`);
  }
  assert(verifyGrantSafely('not-a-token') === null && verifyGrantSafely('a.b') === null && verifyGrantSafely('.') === null, 'garbage strings → null');
  const originalSecret = process.env.GRANT_LINK_SECRET;
  assert(verifyGrantSafely(good, () => { throw new Error('boom'); }) === null, 'a throwing verifier → null');
  assert(verifyGrantSafely(good, () => null as unknown as { businessId: string; tierId: string }) === null, 'a verifier returning nothing → null');
  assert(process.env.GRANT_LINK_SECRET === originalSecret, 'the environment is untouched');

  const errors: unknown[][] = [];
  const realError = console.error; const realLog = console.log; const realWarn = console.warn;
  console.error = (...a: unknown[]) => { errors.push(a); };
  console.warn = (...a: unknown[]) => { errors.push(a); };
  const logged: unknown[][] = [];
  console.log = (...a: unknown[]) => { logged.push(a); };
  verifyGrantSafely(good); verifyGrantSafely(expired); verifyGrantSafely('garbage.token');
  console.error = realError; console.log = realLog; console.warn = realWarn;
  assert(errors.length === 0 && logged.length === 0, 'verifyGrantSafely writes nothing to the console (the token is never logged)');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
