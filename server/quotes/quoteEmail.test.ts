/**
 * Quote email (Quotes step 2): copy rules and the off switch. No network.
 * Run with: DATABASE_URL=postgresql://u:p@localhost.test/db npx tsx server/quotes/quoteEmail.test.ts (db.ts needs the variable set; nothing connects)
 */
import { buildQuoteEmail, quoteLink, sendQuoteEmailIfEnabled } from './quoteEmail';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
}

const quote: any = {
  id: 'q1', linkCode: 'AbC123xyz_-9', title: '2 Bedroom Move', details: 'Crew of 3, truck, up to 5 hours', extrasNote: 'Extra hours $50 each, only if you approve',
  jobDate: '2026-11-13', startTime: '09:00', totalCents: 65000, paymentMode: 'deposit', depositCents: 10000,
};
(async () => {
  const link = quoteLink(quote, 'https://goutsyde.com/');
  assert(link === 'https://goutsyde.com/q/AbC123xyz_-9', 'link on goutsyde.com/q/<code>', link);
  const e = buildQuoteEmail({ quote, businessName: 'Royal Elite Moving ', businessPhone: '(757) 944 4925', customerFirstName: 'Jordan', link });
  assert(e.subject === 'Your quote from Royal Elite Moving', 'subject', e.subject);
  for (const [name, body] of [['html', e.html], ['text', e.text]] as const) {
    assert(body.includes('$650.00') && body.includes('$100.00') && body.includes('$550.00'), `${name}: total, deposit, balance`);
    assert(body.includes(link), `${name}: has the link`);
    assert(!/\d+\s?%/.test(body.replace(/<[^>]+>/g, ' ')), `${name}: never shows a fee rate (visible text)`);
    assert(!/ - | — | – /.test(body.replace(/<[^>]+>/g, ' ')), `${name}: no dashes`);
    assert(body.includes('Outsyde loyalty rewards points'), `${name}: points named as the loyalty rewards program`);
    assert(body.includes('(757) 944 4925') && body.includes('Hi Jordan'), `${name}: business phone and greeting`);
  }
  const x = buildQuoteEmail({ quote: { ...quote, title: '<script>x</script>' }, businessName: 'A & B', businessPhone: null, customerFirstName: null, link });
  assert(!x.html.includes('<script>') && x.html.includes('&lt;script&gt;') && x.html.includes('A &amp; B'), 'html is escaped');
  const full = buildQuoteEmail({ quote: { ...quote, paymentMode: 'full', depositCents: null }, businessName: 'A', businessPhone: null, customerFirstName: null, link });
  assert(!full.text.includes('Balance') && !full.text.includes('Deposit due now'), 'full payment: no deposit or balance lines', full.text);
  delete process.env.QUOTE_EMAILS_ENABLED;
  assert((await sendQuoteEmailIfEnabled(quote, { name: 'A' } as any)) === false, 'off unless QUOTE_EMAILS_ENABLED=true');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
