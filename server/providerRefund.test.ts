/**
 * Provider refund amount rules — unit tests (no DB, no network).
 * Run with: npx tsx server/providerRefund.test.ts
 */
import { resolveProviderRefund, fullProviderRefundCents } from './providerRefund';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const noDeposit = { totalPrice: 10000, depositAmountCents: null };
const deposit = { totalPrice: 10000, depositAmountCents: 2000 };

console.log('Full refund amount');
eq(fullProviderRefundCents(noDeposit), 10000, 'no deposit: the service price');
eq(fullProviderRefundCents(deposit), 2000, 'deposit booking: the deposit');
eq(fullProviderRefundCents({ totalPrice: 10000, depositAmountCents: 0 }), 10000, 'deposit 0 counts as no deposit');
eq(fullProviderRefundCents({ totalPrice: null }), 0, 'missing price: 0');

console.log('No amount = full refund');
eq(resolveProviderRefund({}, noDeposit), { ok: true, refundCents: 10000, fullRefundCents: 10000, isFullRefund: true }, 'no deposit: $100');
eq(resolveProviderRefund(undefined, deposit), { ok: true, refundCents: 2000, fullRefundCents: 2000, isFullRefund: true }, 'deposit: $20, never the whole charge');

console.log('Legacy amount is dollars (what the app has always sent)');
eq(resolveProviderRefund({ amount: 25 }, noDeposit), { ok: true, refundCents: 2500, fullRefundCents: 10000, isFullRefund: false }, '$25 → 2500 cents (was 25 cents)');
eq(resolveProviderRefund({ amount: 25.5 }, noDeposit), { ok: true, refundCents: 2550, fullRefundCents: 10000, isFullRefund: false }, '$25.50 → 2550 cents (was a Stripe error)');
eq(resolveProviderRefund({ amount: 0.1 + 0.2 }, noDeposit), { ok: true, refundCents: 30, fullRefundCents: 10000, isFullRefund: false }, 'float noise rounds to the cent');
eq(resolveProviderRefund({ amount: 100 }, noDeposit), { ok: true, refundCents: 10000, fullRefundCents: 10000, isFullRefund: true }, '$100 of $100 is a full refund');
eq(resolveProviderRefund({ amount: 20 }, deposit), { ok: true, refundCents: 2000, fullRefundCents: 2000, isFullRefund: true }, '$20 of a $20 deposit is a full refund');

console.log('amountCents is cents and wins over amount');
eq(resolveProviderRefund({ amountCents: 2550 }, noDeposit), { ok: true, refundCents: 2550, fullRefundCents: 10000, isFullRefund: false }, '2550 cents');
eq(resolveProviderRefund({ amountCents: 2550, amount: 25.5 }, noDeposit), { ok: true, refundCents: 2550, fullRefundCents: 10000, isFullRefund: false }, 'both sent (new app): cents used once, not 100x');

console.log('Refused');
const tooBig = resolveProviderRefund({ amountCents: 10001 }, noDeposit);
eq([tooBig.ok, (tooBig as any).code, (tooBig as any).maxRefundCents], [false, 'REFUND_TOO_LARGE', 10000], 'more than the service price');
const tooBigDep = resolveProviderRefund({ amount: 21.6 }, deposit);
eq([tooBigDep.ok, (tooBigDep as any).code, (tooBigDep as any).maxRefundCents, (tooBigDep as any).error], [false, 'REFUND_TOO_LARGE', 2000, 'The most you can refund is $20.00.'], 'deposit booking: the service fee is never refunded');
for (const [body, label] of [
  [{ amountCents: 25.5 }, 'fractional cents'],
  [{ amountCents: 0 }, 'zero cents'],
  [{ amountCents: -100 }, 'negative cents'],
  [{ amountCents: '2500' }, 'cents as a string'],
  [{ amount: 0 }, 'zero dollars'],
  [{ amount: -5 }, 'negative dollars'],
  [{ amount: '25' }, 'dollars as a string'],
  [{ amount: Number.NaN }, 'NaN dollars'],
] as const) {
  const r = resolveProviderRefund(body as any, noDeposit);
  eq([r.ok, (r as any).code], [false, 'INVALID_REFUND_AMOUNT'], `invalid: ${label}`);
}
const nothing = resolveProviderRefund({}, { totalPrice: 0 });
eq([nothing.ok, (nothing as any).code], [false, 'REFUND_TOO_LARGE'], 'nothing refundable: refused, no $0 Stripe call');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
