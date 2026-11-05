/**
 * Pure tests for quotes step 4b-2a (B15): on a deposit quote the vendor picks how the rest is paid, through Outsyde
 * (held the day before, charged at Job complete) or outside Outsyde (usually cash on the day). Outside: no service
 * fee, no points and no Report protection on that part; the quote says it is paid to the business directly.
 * Legend 2026-11-05 (E5): new deposit quotes default to through Outsyde.
 * Run with: DATABASE_URL=postgresql://x:y@localhost:5432/z npx tsx server/quotes/quoteRestOutside.test.ts
 */
import { checkQuoteInput, quoteAmounts, quoteRestText } from './quoteRules';
import { windowCardText } from './quoteWindow';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const base = { title: '2 Bedroom Move', jobDate: '2026-12-01', startTime: '09:00', durationMinutes: 180, totalCents: 65000, paymentMode: 'deposit', depositCents: 10000 };

console.log('\n── who sends how the rest is paid ──');
let c = checkQuoteInput(base);
assert(c.ok && c.value.restPaid === 'outsyde', 'not sent: through Outsyde (E5 default, older senders)', c);
c = checkQuoteInput({ ...base, restPaid: 'outside' });
assert(c.ok && c.value.restPaid === 'outside', 'the vendor can pick outside Outsyde', c);
c = checkQuoteInput({ ...base, restPaid: 'outsyde' });
assert(c.ok && c.value.restPaid === 'outsyde', 'or through Outsyde', c);
c = checkQuoteInput({ ...base, restPaid: 'cash' });
assert(!c.ok && c.field === 'restPaid', 'anything else is refused', c);
c = checkQuoteInput({ ...base, paymentMode: 'full', depositCents: null, restPaid: 'outside' });
assert(!c.ok && c.field === 'restPaid', 'a full payment quote has no rest to pay outside', c);
c = checkQuoteInput({ ...base, paymentMode: 'full', depositCents: null });
assert(c.ok && c.value.restPaid === 'outsyde', 'a full payment quote is through Outsyde', c);

console.log('\n── the money ──');
let a = quoteAmounts(65000, 10000, 'outsyde');
assert(a.balanceCents === 55000 && a.balanceServiceFeeCents === 4400 && a.balanceTotalCents === 59400 && a.paidDirectlyCents === 0 && a.restPaid === 'outsyde', 'through Outsyde: balance plus its fee, as in 4a', a);
a = quoteAmounts(65000, 10000);
assert(a.balanceTotalCents === 59400 && a.restPaid === 'outsyde', 'not given: through Outsyde', a);
a = quoteAmounts(65000, 10000, 'outside');
assert(a.balanceCents === 55000 && a.balanceServiceFeeCents === 0 && a.balanceTotalCents === 0 && a.paidDirectlyCents === 55000 && a.restPaid === 'outside', 'outside: no fee on the rest, nothing held, paid directly', a);
assert(a.payNowCents === 10800 && a.serviceFeeCents === 800, 'the deposit is unchanged', a);
a = quoteAmounts(65000, null, 'outside');
assert(a.paidDirectlyCents === 0 && a.balanceTotalCents === 0, 'a full payment has nothing left either way', a);

console.log('\n── the copy (commas and periods, never the fee rate) ──');
const t1 = quoteRestText(quoteAmounts(65000, 10000, 'outside'));
assert(t1 === 'Remainder of $550.00 paid to the business directly', 'outside: paid to the business directly', t1);
const t2 = quoteRestText(quoteAmounts(65000, 10000, 'outsyde'));
assert(t2 === 'Balance, held on your card the day before', 'through Outsyde: unchanged wording', t2);
assert(quoteRestText(quoteAmounts(65000, null)) === null, 'full payment: no line');
const charged = windowCardText('job_complete', { businessName: 'Royal Elite Moving', title: 'Move', charged: true });
const notCharged = windowCardText('job_complete', { businessName: 'Royal Elite Moving', title: 'Move', charged: false });
assert(/balance was charged/.test(charged), 'Job complete with a balance: says it was charged', charged);
assert(!/charged/.test(notCharged) && /report a problem within 6 hours/i.test(notCharged), 'nothing charged at Job complete (paid in full or rest outside): never says charged', notCharged);
for (const s of [t1, t2, charged, notCharged]) assert(!/[–—]|8%/.test(s ?? ''), `no dashes or fee rate: ${s}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
