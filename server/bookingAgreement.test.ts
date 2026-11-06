/**
 * Booking agreement (migration 105): parsing what the client sends.
 * Run with: DATABASE_URL=... NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/bookingAgreement.test.ts
 * (bookingAgreement imports db; no query runs in these tests.)
 */
import { parseBookingAgreement, vendorTermsCopy, OUTSYDE_TERMS_VERSION, MAX_VENDOR_TERMS_COPY } from './bookingAgreement';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

console.log('\n=== parseBookingAgreement ===');
assert(parseBookingAgreement(undefined) === null, 'no body → null');
assert(parseBookingAgreement({}) === null, 'no agreement (old app, vendor sites) → null');
assert(parseBookingAgreement({ agreement: null }) === null, 'agreement null → null');
assert(parseBookingAgreement({ agreement: true }) === null, 'agreement true (not an object) → null');
assert(parseBookingAgreement({ agreement: { agreed: false } }) === null, 'agreed false → null');
assert(parseBookingAgreement({ agreement: { agreed: 'true' } }) === null, 'agreed "true" string → null');
assert(parseBookingAgreement({ agreement: { agreed: true } })?.termsVersion === OUTSYDE_TERMS_VERSION, 'agreed, no version → server version');
assert(parseBookingAgreement({ agreement: { agreed: true, termsVersion: '2026-11' } })?.termsVersion === '2026-11', 'version 2026-11 kept');
assert(parseBookingAgreement({ agreement: { agreed: true, termsVersion: '2027-02' } })?.termsVersion === '2027-02', 'a later valid version kept');
assert(parseBookingAgreement({ agreement: { agreed: true, termsVersion: 'x'.repeat(500) } })?.termsVersion === OUTSYDE_TERMS_VERSION, 'junk version → server version');
assert(parseBookingAgreement({ agreement: { agreed: true, termsVersion: 202611 } })?.termsVersion === OUTSYDE_TERMS_VERSION, 'number version → server version');
assert(OUTSYDE_TERMS_VERSION === '2026-11', 'server version matches the Terms "Last Updated: November 2026"');

console.log('\n=== vendorTermsCopy ===');
assert(vendorTermsCopy(null) === null, 'null → null');
assert(vendorTermsCopy('   \n ') === null, 'blank → null');
assert(vendorTermsCopy('  No refunds on deposits.  ') === 'No refunds on deposits.', 'trimmed copy');
assert(vendorTermsCopy('a'.repeat(MAX_VENDOR_TERMS_COPY + 50))?.length === MAX_VENDOR_TERMS_COPY, 'very long terms capped');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
