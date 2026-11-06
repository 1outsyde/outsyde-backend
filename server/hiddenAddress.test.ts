/**
 * R40 hidden business address: pure rules.
 * Run with: DATABASE_URL=... NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/hiddenAddress.test.ts
 *
 * Mutation check: drop `hideStreet ? null :` from address in toPublicBusinessDTO → "hidden: no street" fails;
 * add 'expired' to ADDRESS_VISIBLE_STATUSES → "expired booking: no hidden address" fails.
 */
import { toPublicBusinessDTO } from './serializers/business';
import { businessAddressForCustomer, ADDRESS_VISIBLE_STATUSES } from './serializers/hiddenAddress';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

const biz = (showAddress: boolean | null) => ({
  id: 'b1', ownerId: 'u1', name: 'Biz', showAddress,
  address: '12 Main St', city: 'Freeport', state: 'NY', zipCode: '11520', country: 'US',
  latitude: 40.657, longitude: -73.583,
}) as any;
const opts = { followerCount: 0, followingCount: 0 };

console.log('\n=== toPublicBusinessDTO ===');
const shown = toPublicBusinessDTO(biz(true), opts);
assert(shown.address === '12 Main St' && shown.zipCode === '11520' && shown.latitude === 40.657 && shown.longitude === -73.583, 'shown: street, zip and map spot sent');
const hidden = toPublicBusinessDTO(biz(false), opts);
assert(hidden.address === null, 'hidden: no street');
assert(hidden.zipCode === null, 'hidden: no zip');
assert(hidden.latitude === null && hidden.longitude === null, 'hidden: no map spot');
assert(hidden.city === 'Freeport' && hidden.state === 'NY', 'hidden: city and state stay');
assert(hidden.showAddress === false, 'hidden: showAddress still sent so screens know');
const unset = toPublicBusinessDTO(biz(null), opts);
assert(unset.address === '12 Main St', 'showAddress null (old rows) → treated as shown, same as the apps');

console.log('\n=== businessAddressForCustomer ===');
for (const s of ['confirmed', 'completed', 'no_show']) {
  assert(businessAddressForCustomer('12 Main St', false, s) === '12 Main St', `${s} booking: hidden address shared`);
}
for (const s of ['draft', 'pending_payment', 'pending_provider', 'expired', 'canceled', 'declined', '', null]) {
  assert(businessAddressForCustomer('12 Main St', false, s as any) === null, `${s || 'no status'} booking: no hidden address`);
}
assert(businessAddressForCustomer('12 Main St', true, 'expired') === '12 Main St', 'shown address: any status keeps it (unchanged)');
assert(businessAddressForCustomer('12 Main St', null, 'expired') === '12 Main St', 'showAddress null: unchanged');
assert(businessAddressForCustomer(null, false, 'confirmed') === null && businessAddressForCustomer('', true, 'confirmed') === null, 'no address → null');
assert(ADDRESS_VISIBLE_STATUSES.length === 3, 'exactly three statuses unlock it');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
