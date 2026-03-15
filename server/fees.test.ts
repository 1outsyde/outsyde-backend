/**
 * Fee calculation tests — run with: npx tsx server/fees.test.ts
 */

import {
  calculateProductFees,
  calculateBookingFees,
  calculateProductFee,
  calculateBookingFee,
  calculateConsumerServiceFee,
  calculateInfluencerCommission,
  FEE_MODEL_VERSION,
} from './fees';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

console.log('\n=== Fee Calculation Tests ===\n');

// Test 1: Standard product order without influencer
console.log('Test 1: Product order, no influencer (subtotal = $100)');
{
  const b = calculateProductFees(10000);
  assert(b.subtotalCents === 10000, 'subtotal = 10000');
  assert(b.consumerServiceFeeCents === 300, 'consumer service fee = 300 (3%)');
  assert(b.platformFeeCents === 800, 'platform fee = 800 (8%)');
  assert(b.influencerCommissionCents === 0, 'influencer commission = 0');
  assert(b.vendorNetCents === 9200, 'vendor net = 9200');
  assert(b.customerTotalBeforeTaxCents === 10300, 'customer total before tax = 10300');
  assert(b.outsydeGrossRevenueCents === 1100, 'Outsyde gross revenue = 1100 ($3 + $8)');
  assert(b.feeModelVersion === 'v2', 'fee model = v2');
  assert(b.hasInfluencer === false, 'no influencer');
}

// Test 2: Influencer-attributed product order
console.log('\nTest 2: Product order, influencer attributed (subtotal = $100)');
{
  const b = calculateProductFees(10000, { influencerAttributed: true });
  assert(b.consumerServiceFeeCents === 300, 'consumer service fee = 300 (3%)');
  assert(b.platformFeeCents === 800, 'platform fee = 800 (8%)');
  assert(b.influencerCommissionCents === 1500, 'influencer commission = 1500 (15%)');
  assert(b.vendorNetCents === 7700, 'vendor net = 7700 ($100 - $8 - $15)');
  assert(b.customerTotalBeforeTaxCents === 10300, 'customer total = 10300');
  assert(b.outsydeGrossRevenueCents === 1100, 'Outsyde revenue = 1100 (NOT including influencer)');
}

// Test 3: Service booking
console.log('\nTest 3: Service booking (subtotal = $100)');
{
  const b = calculateBookingFees(10000);
  assert(b.consumerServiceFeeCents === 300, 'consumer service fee = 300 (3%)');
  assert(b.platformFeeCents === 1200, 'booking fee = 1200 (12%)');
  assert(b.influencerCommissionCents === 0, 'no influencer commission');
  assert(b.vendorNetCents === 8800, 'vendor net = 8800');
  assert(b.customerTotalBeforeTaxCents === 10300, 'customer total = 10300');
  assert(b.outsydeGrossRevenueCents === 1500, 'Outsyde revenue = 1500 ($3 + $12)');
}

// Test 4: Rounding behavior
console.log('\nTest 4: Rounding (subtotal = $33.33)');
{
  const b = calculateProductFees(3333, { influencerAttributed: true });
  assert(b.consumerServiceFeeCents === 100, 'service fee rounds to 100');
  assert(b.platformFeeCents === 267, 'platform fee rounds to 267');
  assert(b.influencerCommissionCents === 500, 'influencer rounds to 500');
  assert(b.vendorNetCents === 2566, 'vendor net = 3333 - 267 - 500 = 2566');
}

// Test 5: Legacy compat functions
console.log('\nTest 5: Legacy compat functions');
{
  assert(calculateProductFee(10000) === 800, 'calculateProductFee(10000) = 800');
  assert(calculateBookingFee(10000) === 1200, 'calculateBookingFee(10000) = 1200');
  assert(calculateConsumerServiceFee(10000) === 300, 'calculateConsumerServiceFee(10000) = 300');
  assert(calculateInfluencerCommission(10000) === 1500, 'calculateInfluencerCommission(10000) = 1500');
}

// Test 6: Consumer service fee NOT deducted from vendor
console.log('\nTest 6: Consumer fee does NOT reduce vendor payout');
{
  const b = calculateProductFees(10000);
  assert(b.vendorNetCents === 10000 - b.platformFeeCents, 'vendorNet = subtotal - platformFee only');
  assert(b.vendorNetCents === 9200, 'vendor gets $92, not $89');
}

// Test 7: Influencer commission NOT counted as Outsyde revenue
console.log('\nTest 7: Influencer commission NOT in Outsyde revenue');
{
  const b = calculateProductFees(10000, { influencerAttributed: true });
  assert(b.outsydeGrossRevenueCents === b.consumerServiceFeeCents + b.platformFeeCents,
    'Outsyde revenue = serviceFee + platformFee (no influencer)');
  assert(b.outsydeGrossRevenueCents === 1100, 'Outsyde revenue = $11, not $26');
}

// Test 8: Zero subtotal edge case
console.log('\nTest 8: Zero subtotal');
{
  const b = calculateProductFees(0);
  assert(b.vendorNetCents === 0, 'vendor net = 0');
  assert(b.consumerServiceFeeCents === 0, 'service fee = 0');
  assert(b.outsydeGrossRevenueCents === 0, 'Outsyde revenue = 0');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
