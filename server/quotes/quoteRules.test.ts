/**
 * Pure tests for quotes (Quotes in Messages, step 2). No database, no network.
 * Run with: npx tsx server/quotes/quoteRules.test.ts
 */
import { checkQuoteInput, quoteTiming, quoteAmounts, quoteMessageText, effectiveStatus, QUOTE_VALID_DAYS } from './quoteRules';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const base = {
  title: '  2 Bedroom Move ',
  details: 'Crew of 3, truck, up to 5 hours',
  extrasNote: 'Extra hours $50 each, only if you approve',
  jobDate: '2026-11-13',
  startTime: '09:00',
  durationMinutes: 300,
  totalCents: 65000,
  paymentMode: 'deposit',
  depositCents: 10000,
};

console.log('\n── checkQuoteInput ──');
{
  const r = checkQuoteInput(base);
  assert(r.ok === true, 'a full quote passes', r);
  if (r.ok) {
    assert(r.value.title === '2 Bedroom Move', 'title trimmed');
    assert(r.value.depositCents === 10000 && r.value.paymentMode === 'deposit', 'deposit kept');
  }
}
{
  const r = checkQuoteInput({ ...base, paymentMode: 'full', depositCents: undefined, details: '', extrasNote: '  ' });
  assert(r.ok && r.value.depositCents === null && r.value.details === null && r.value.extrasNote === null, 'full payment: no deposit; blank optional text saved as empty', r);
}
const bad = (patch: Record<string, unknown>) => checkQuoteInput({ ...base, ...patch });
const field = (patch: Record<string, unknown>) => { const r = bad(patch); return r.ok ? null : r.field; };
assert(field({ title: '  ' }) === 'title', 'title required');
assert(field({ title: 'x'.repeat(121) }) === 'title', 'title up to 120');
assert(field({ details: 'x'.repeat(2001) }) === 'details' && bad({ details: 'x'.repeat(2000) }).ok, 'details up to 2000');
assert(field({ extrasNote: 'x'.repeat(301) }) === 'extrasNote', 'extras note up to 300');
assert(field({ jobDate: '11/13/2026' }) === 'jobDate' && field({ jobDate: '2026-02-30' }) === 'jobDate', 'a date given must be real');
assert(field({ startTime: '9am' }) === 'startTime' && field({ startTime: '24:00' }) === 'startTime' && bad({ startTime: '23:59' }).ok, 'a start time given must be HH:MM');
assert(field({ durationMinutes: 10 }) === 'durationMinutes' && field({ durationMinutes: 4321 }) === 'durationMinutes' && field({ durationMinutes: 90.5 }) === 'durationMinutes' && bad({ durationMinutes: 15 }).ok && bad({ durationMinutes: 4320 }).ok, 'a length given is 15 minutes to 3 days, whole minutes');
// Step 3 (Legend 2026-11-04): the vendor picks service (date, start and length required: it becomes a booking)
// or product (no time slot, an optional due date: it becomes an order). Older clients send no kind: service.
{
  const svc = bad({});
  assert(svc.ok && svc.value.kind === 'service' && svc.value.dueDate === null, 'no kind sent: a service quote', svc);
  assert(field({ jobDate: undefined }) === 'jobDate' && field({ startTime: undefined }) === 'startTime' && field({ durationMinutes: undefined }) === 'durationMinutes', 'a service quote needs date, start and length');
  // Deliverables D1a (call 7): a deliverable's deposit has the rest paid directly to the business for now.
  const prod = bad({ kind: 'product', jobDate: undefined, startTime: undefined, durationMinutes: undefined, restPaid: 'outside' });
  assert(prod.ok && prod.value.kind === 'product' && prod.value.jobDate === null && prod.value.startTime === null && prod.value.durationMinutes === null && prod.value.dueDate === null, 'a product quote with no date passes', prod);
  const due = bad({ kind: 'product', jobDate: undefined, startTime: undefined, durationMinutes: undefined, dueDate: '2026-12-20', restPaid: 'outside' });
  assert(due.ok && due.value.dueDate === '2026-12-20', 'a product quote can have a due date', due);
  assert(field({ kind: 'product', jobDate: undefined, startTime: undefined, durationMinutes: undefined, dueDate: '12/20/2026' }) === 'dueDate', 'a due date must be a real date');
  assert(field({ kind: 'product' }) === 'jobDate', 'a product quote has no job time (use the due date)');
  assert(field({ dueDate: '2026-12-20' }) === 'dueDate', 'a service quote has no due date');
  assert(field({ kind: 'cake' }) === 'kind', 'kind is service or product');
}
assert(field({ totalCents: 699 }) === 'totalCents' && bad({ totalCents: 700, paymentMode: 'full', depositCents: null }).ok, 'total at least $7.00');
assert(field({ totalCents: 10_000_001 }) === 'totalCents', 'total at most $100,000');
assert(field({ totalCents: 650.5 }) === 'totalCents', 'total in whole cents');
assert(field({ paymentMode: 'half' }) === 'paymentMode' && field({ paymentMode: undefined }) === 'paymentMode', 'deposit or full required');
assert(field({ depositCents: undefined }) === 'depositCents' && field({ depositCents: null }) === 'depositCents', 'deposit mode needs a deposit');
assert(field({ depositCents: 699 }) === 'depositCents', 'deposit at least $7.00');
assert(field({ depositCents: 65000 }) === 'depositCents' && field({ depositCents: 70000 }) === 'depositCents', 'deposit less than the total');
assert(field({ paymentMode: 'full', depositCents: 10000 }) === 'depositCents', 'full payment takes no deposit');
assert(!checkQuoteInput(null).ok && !checkQuoteInput('x').ok, 'body must be an object');
{
  const r = bad({ title: '' });
  assert(!r.ok && typeof r.message === 'string' && !/ - | — | – /.test(r.message), 'messages are plain words without dashes', r);
}

console.log('\n── quoteTiming ──');
{
  const now = new Date('2026-11-04T14:00:00Z'); // 9:00 AM New York
  const t = quoteTiming({ jobDate: '2026-11-13', startTime: '09:00' }, 'America/New_York', now);
  assert(t.ok && t.startsAt.toISOString() === '2026-11-13T14:00:00.000Z', 'start in the business time zone', t);
  assert(t.ok && t.expiresAt.toISOString() === new Date(now.getTime() + QUOTE_VALID_DAYS * 86400000).toISOString(), 'expires 7 days after sending when the job is later', t);
  // Step 3 (Legend 2026-11-04, call 12): the day before the job, so every paid quote has its full balance hold window.
  const soon = quoteTiming({ jobDate: '2026-11-06', startTime: '10:00' }, 'America/New_York', now);
  assert(soon.ok && soon.expiresAt.toISOString() === '2026-11-05T15:00:00.000Z', 'a job sooner than 7 days: expires 24 hours before the job starts', soon);
  const edge = quoteTiming({ jobDate: '2026-11-12', startTime: '09:00' }, 'America/New_York', now);
  assert(edge.ok && edge.expiresAt.toISOString() === '2026-11-11T14:00:00.000Z', 'a job 8 days out: 24 hours before beats 7 days', edge);
  const tomorrow = quoteTiming({ jobDate: '2026-11-05', startTime: '08:00' }, 'America/New_York', now);
  assert(tomorrow.ok && tomorrow.expiresAt.toISOString() === '2026-11-05T13:00:00.000Z', 'a job less than 24 hours away: expires when the job starts (same day jobs stay payable)', tomorrow);
  const past = quoteTiming({ jobDate: '2026-11-04', startTime: '08:59' }, 'America/New_York', now);
  assert(!past.ok && past.field === 'startTime', 'a start in the past is refused', past);
  const la = quoteTiming({ jobDate: '2026-11-13', startTime: '09:00' }, 'America/Los_Angeles', now);
  assert(la.ok && la.startsAt.toISOString() === '2026-11-13T17:00:00.000Z', 'another time zone', la);
  const gap = quoteTiming({ jobDate: '2026-03-08', startTime: '02:30' }, 'America/New_York', new Date('2026-03-01T12:00:00Z'));
  assert(!gap.ok && gap.field === 'startTime' && /clock/.test(gap.message), 'a time that does not exist on clock change day is refused', gap);
  const back = quoteTiming({ jobDate: '2026-11-01', startTime: '01:30' }, 'America/New_York', new Date('2026-10-20T12:00:00Z'));
  assert(back.ok, 'a time that happens twice when clocks go back is accepted', back);
  const undated = quoteTiming({ jobDate: null, startTime: null }, 'America/New_York', now);
  assert(undated.ok && undated.startsAt === null && undated.expiresAt.toISOString() === new Date(now.getTime() + QUOTE_VALID_DAYS * 86400000).toISOString(), 'a product quote: no start, expires after 7 days', undated);
  const pastDue = quoteTiming({ jobDate: null, startTime: null, dueDate: '2026-11-03' }, 'America/New_York', now);
  assert(!pastDue.ok && pastDue.field === 'dueDate', 'a due date in the past is refused', pastDue);
  const dst = quoteTiming({ jobDate: '2026-03-09', startTime: '09:00' }, 'America/New_York', new Date('2026-03-01T12:00:00Z'));
  assert(dst.ok && dst.startsAt.toISOString() === '2026-03-09T13:00:00.000Z', 'daylight saving time handled', dst);
}

console.log('\n── quoteAmounts ──');
{
  const d = quoteAmounts(65000, 10000);
  assert(d.depositOrTotalCents === 10000 && d.balanceCents === 55000 && d.serviceFeeCents > 0 && d.payNowCents === d.depositOrTotalCents + d.serviceFeeCents, 'deposit: deposit, fee on what is paid now, pay now includes the fee, balance', d);
  assert(!('dueNowCents' in d) && !('chargeNowCents' in d), 'no ambiguous names (pay now always includes the fee)', d);
  const f = quoteAmounts(65000, null);
  assert(f.depositOrTotalCents === 65000 && f.balanceCents === 0 && f.payNowCents === 65000 + f.serviceFeeCents, 'full: everything now, no balance', f);
  assert(quoteAmounts(10000, null).serviceFeeCents === quoteAmounts(65000, 10000).serviceFeeCents, 'the fee depends only on what is paid now');
}

console.log('\n── quoteMessageText ──');
{
  const s = quoteMessageText('sent', ' 2 Bedroom Move ', 65000);
  assert(s === 'Sent a quote for 2 Bedroom Move, $650.00 total.', 'sent', s);
  assert(quoteMessageText('updated', '2 Bedroom Move', 70050) === 'Updated the quote for 2 Bedroom Move, $700.50 total.', 'updated');
  assert(quoteMessageText('withdrawn', '2 Bedroom Move', 65000) === 'Withdrew the quote for 2 Bedroom Move.', 'withdrawn');
  assert(quoteMessageText('declined', '2 Bedroom Move', 65000) === 'Declined the quote for 2 Bedroom Move.', 'declined');
  assert(quoteMessageText('expired', '2 Bedroom Move', 65000) === 'The quote for 2 Bedroom Move expired.', 'expired');
  assert(quoteMessageText('sent', 'Big', 1234567) === 'Sent a quote for Big, $12,345.67 total.', 'thousands separator');
  assert(quoteMessageText('paid', '2 Bedroom Move', 65000, 'deposit') === 'Paid the deposit for 2 Bedroom Move.', 'paid, deposit');
  assert(quoteMessageText('paid', '2 Bedroom Move', 65000, 'full') === 'Paid in full for 2 Bedroom Move, $650.00.', 'paid, full');
  for (const e of ['sent', 'updated', 'withdrawn', 'declined', 'expired', 'paid'] as const) {
    assert(!/ - | — | – /.test(quoteMessageText(e, 'A', 700)), `no dashes (${e})`);
  }
}

console.log('\n── effectiveStatus ──');
{
  const now = new Date('2026-11-04T14:00:00Z');
  assert(effectiveStatus({ status: 'sent', expiresAt: new Date('2026-11-04T13:59:59Z') }, now) === 'expired', 'a sent quote past its expiry reads expired before the job runs');
  assert(effectiveStatus({ status: 'sent', expiresAt: new Date('2026-11-04T14:00:01Z') }, now) === 'sent', 'still open');
  assert(effectiveStatus({ status: 'withdrawn', expiresAt: new Date('2026-11-01T00:00:00Z') }, now) === 'withdrawn', 'other statuses unchanged');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
