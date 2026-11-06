/**
 * Deliverable quotes, step D1a (Legend 2026-11-06, plan calls 1 to 12 as recommended, call 5 revised): a product
 * quote (a cake, a dress) says how it gets to the customer, Pickup or Delivery. Delivery can carry its own delivery
 * fee line, inside the total. The customer adds the delivery address before paying. For this step a deliverable is
 * paid in full, or with a deposit and the rest paid directly to the business (call 7). Pure: no database, no network.
 * Run with: DATABASE_URL=postgresql://u:p@localhost.test/db npx tsx server/quotes/quoteDeliverables.test.ts (db.ts needs the variable set; nothing connects)
 */
import { checkQuoteInput, checkDeliveryAddress } from './quoteRules';
import { quotePreviewJson } from './quoteNotesRules';
import { buildQuoteEmail } from './quoteEmail';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const clean = (s: string) => !/[—–]| - |%/.test(s);

const cake = { kind: 'product', title: 'Two tier birthday cake', details: 'Vanilla, strawberry filling', totalCents: 20000, paymentMode: 'full', dueDate: '2026-11-20' };
const service = { title: '2 Bedroom Move', jobDate: '2026-11-13', startTime: '09:00', durationMinutes: 300, totalCents: 65000, paymentMode: 'full' };
const field = (raw: Record<string, unknown>) => { const r = checkQuoteInput(raw); return r.ok ? null : r.field; };
const msg = (raw: Record<string, unknown>) => { const r = checkQuoteInput(raw); return r.ok ? '' : r.message; };

console.log('\n── pickup or delivery ──');
{
  const r = checkQuoteInput(cake);
  assert(r.ok && r.value.fulfillment === 'pickup' && r.value.deliveryFeeCents === null, 'a deliverable with no choice is Pickup', r);
  const d = checkQuoteInput({ ...cake, fulfillment: 'delivery', deliveryFeeCents: 2000 });
  assert(d.ok && d.value.fulfillment === 'delivery' && d.value.deliveryFeeCents === 2000 && d.value.totalCents === 20000, 'Delivery with a delivery fee inside the total', d);
  const nofee = checkQuoteInput({ ...cake, fulfillment: 'delivery' });
  assert(nofee.ok && nofee.value.deliveryFeeCents === null, 'Delivery with no fee line', nofee);
  const zp = checkQuoteInput({ ...cake, deliveryFeeCents: 0 });
  assert(zp.ok && zp.value.deliveryFeeCents === null, 'a 0 fee on Pickup is no fee line (review 7)', zp);
  const zs = checkQuoteInput({ ...service, deliveryFeeCents: 0 });
  assert(zs.ok, 'a 0 fee on a service quote is no fee line', zs);
  const zero = checkQuoteInput({ ...cake, fulfillment: 'delivery', deliveryFeeCents: 0 });
  assert(zero.ok && zero.value.deliveryFeeCents === null, 'a delivery fee of 0 is no fee line', zero);
  assert(field({ ...cake, fulfillment: 'ship' }) === 'fulfillment', 'only Pickup or Delivery');
  assert(field({ ...cake, fulfillment: 'pickup', deliveryFeeCents: 500 }) === 'deliveryFeeCents', 'no delivery fee on Pickup');
  assert(field({ ...cake, fulfillment: 'delivery', deliveryFeeCents: 20000 }) === 'deliveryFeeCents', 'the delivery fee is less than the total');
  assert(field({ ...cake, fulfillment: 'delivery', deliveryFeeCents: 12.5 }) === 'deliveryFeeCents', 'the delivery fee is whole cents');
  assert(field({ ...cake, fulfillment: 'delivery', deliveryFeeCents: -100 }) === 'deliveryFeeCents', 'no negative delivery fee');
  assert(field({ ...cake, fulfillment: 'delivery', deliveryFeeCents: '20' }) === 'deliveryFeeCents', 'the delivery fee is a number');
}

console.log('\n── services are unchanged ──');
{
  const r = checkQuoteInput(service);
  assert(r.ok && r.value.kind === 'service' && r.value.fulfillment === null && r.value.deliveryFeeCents === null, 'a service quote has no pickup or delivery', r);
  assert(field({ ...service, fulfillment: 'pickup' }) === 'fulfillment', 'a service quote refuses pickup or delivery');
  assert(field({ ...service, deliveryFeeCents: 500 }) === 'deliveryFeeCents', 'a service quote refuses a delivery fee');
  const nulls = checkQuoteInput({ ...service, fulfillment: null, deliveryFeeCents: null });
  assert(nulls.ok, 'a service quote may send them as null (older and newer apps)', nulls);
}

console.log('\n── deposits on deliverables (call 7) ──');
{
  const dep = { ...cake, paymentMode: 'deposit', depositCents: 5000 };
  assert(field(dep) === 'restPaid', 'a deposit with the rest through Outsyde is not offered yet');
  assert(field({ ...dep, restPaid: 'outsyde' }) === 'restPaid', 'asked for directly, still refused');
  const out = checkQuoteInput({ ...dep, restPaid: 'outside' });
  assert(out.ok && out.value.restPaid === 'outside' && out.value.depositCents === 5000, 'a deposit with the rest paid directly to the business', out);
  assert(clean(msg(dep)) && /directly/.test(msg(dep)), 'the message says how to fix it, commas and periods only', msg(dep));
  const svc = checkQuoteInput({ ...service, paymentMode: 'deposit', depositCents: 10000 });
  assert(svc.ok && svc.value.restPaid === 'outsyde', 'service deposits still default to the rest through Outsyde', svc);
}

console.log('\n── the delivery address ──');
{
  const a = checkDeliveryAddress('  12 Main St,   Apt 3\n Uniondale, NY 11553 ');
  assert(a.ok && a.value === '12 Main St, Apt 3, Uniondale, NY 11553', 'trimmed, one line', a);
  assert(!checkDeliveryAddress('').ok, 'empty is refused');
  assert(!checkDeliveryAddress('12 M').ok, 'too short is refused');
  assert(!checkDeliveryAddress('x'.repeat(301)).ok, 'over 300 characters is refused');
  assert(!checkDeliveryAddress(42).ok, 'must be text');
  assert(!checkDeliveryAddress('😀😀a').ok, 'characters are counted as the database counts them (review 6)');
  const nul = checkDeliveryAddress('12 Main\u0000 St, Uniondale');
  assert(nul.ok && nul.value === '12 Main St, Uniondale', 'control characters become spaces, never a database error', nul);
  const e = checkDeliveryAddress('');
  assert(!e.ok && clean(e.message), 'the message uses commas and periods only', e);
}

console.log('\n── the signed out preview never shows the address ──');
{
  const q: any = {
    id: 'q1', status: 'sent', kind: 'product', title: 'Cake', jobDate: null, startTime: null, durationMinutes: null, timeZone: 'America/New_York',
    dueDate: '2026-11-20', totalCents: 20000, paymentMode: 'full', depositCents: null, restPaid: 'outsyde', expiresAt: new Date(Date.now() + 86400000),
    fulfillment: 'delivery', deliveryFeeCents: 2000, deliveryAddress: '12 Main St, Uniondale, NY', productId: 'p1',
  };
  const p: any = quotePreviewJson(q, { id: 'b', name: 'Jazzy', logoImage: null, coverImage: null, brandColors: null } as any);
  assert(p.fulfillment === 'delivery' && p.deliveryFeeCents === 2000, 'the preview says Delivery and the fee', p);
  assert(!JSON.stringify(p).includes('Main St') && !('deliveryAddress' in p), 'no address in the preview', p);
}

console.log('\n── the quote email for a deliverable ──');
{
  const base: any = {
    kind: 'product', title: 'Two tier birthday cake', jobDate: null, startTime: null, dueDate: '2026-11-20', totalCents: 20000, paymentMode: 'full',
    depositCents: null, restPaid: 'outsyde', fulfillment: 'delivery', deliveryFeeCents: 2000, linkCode: 'abc',
  };
  const e = buildQuoteEmail({ quote: base, businessName: 'Jazzy Sweet Tooth', businessPhone: null, customerFirstName: 'Ana', link: 'https://goutsyde.com/q/abc' });
  assert(/Ready by/.test(e.text) && /Fri, Nov 20/.test(e.text), 'says when it is ready', e.text);
  assert(/Delivery fee/.test(e.text) && /\$20\.00/.test(e.text), 'shows the delivery fee line', e.text);
  assert(/Delivery/.test(e.text) && /delivery address/i.test(e.text), 'asks for the delivery address before paying', e.text);
  assert(!/lock in your date/.test(e.text) && !/held on your card/.test(e.text), 'no date to lock and no card hold', e.text);
  assert(clean(e.text) && clean(e.subject), 'commas and periods only, no fee rate', e.text);
  const pick = buildQuoteEmail({ quote: { ...base, fulfillment: 'pickup', deliveryFeeCents: null, dueDate: null }, businessName: 'Jazzy Sweet Tooth', businessPhone: null, customerFirstName: null, link: 'x' });
  assert(/Pickup/.test(pick.text) && !/Ready by/.test(pick.text) && !/Delivery fee/.test(pick.text), 'Pickup with no date', pick.text);
  const dep = buildQuoteEmail({ quote: { ...base, paymentMode: 'deposit', depositCents: 5000, restPaid: 'outside' }, businessName: 'Jazzy Sweet Tooth', businessPhone: null, customerFirstName: null, link: 'x' });
  assert(/paid to the business directly/.test(dep.text), 'a deposit says the rest goes to the business directly', dep.text);
  const svc = buildQuoteEmail({ quote: { ...base, kind: 'service', jobDate: '2026-11-13', startTime: '09:00', dueDate: null, fulfillment: null, deliveryFeeCents: null }, businessName: 'Royal Elite', businessPhone: null, customerFirstName: null, link: 'x' });
  assert(/lock in your date/.test(svc.text) && !/Ready by|Pickup|Delivery/.test(svc.text), 'the service email is unchanged', svc.text);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
