/**
 * Pure tests for service cities and the estimate request email (migration 066). No database, no network.
 * Run with: npx tsx server/estimates/estimates.test.ts
 */
import { normalizeCityList, serviceCitiesInput, isServiceOfferedInCity, isBusinessCity, cityKey } from './serviceCities';
import { buildEstimateRequestEmail, escapeHtml } from './estimateEmail';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

console.log('\n── city lists ──');
assert(JSON.stringify(normalizeCityList(['  Norfolk ', 'norfolk', 'Virginia   Beach', '', '   '])) === '["Norfolk","Virginia Beach"]', 'trim, collapse spaces, drop blanks and duplicates, first spelling wins');
assert(cityKey(' Virginia  BEACH ') === 'virginia beach', 'comparison key');
assert(serviceCitiesInput.safeParse(Array.from({ length: 50 }, (_, i) => `C${i}`)).success, '50 cities allowed');
assert(!serviceCitiesInput.safeParse(Array.from({ length: 51 }, (_, i) => `C${i}`)).success, '51 refused');
assert(!serviceCitiesInput.safeParse(['x'.repeat(61)]).success, 'name over 60 characters refused');
assert(!serviceCitiesInput.safeParse('Norfolk').success, 'a string is not a list');
assert(isServiceOfferedInCity([], 'Anywhere') && isServiceOfferedInCity(null, 'Anywhere'), 'empty service list = every city');
assert(isServiceOfferedInCity(['Norfolk'], ' norfolk ') && !isServiceOfferedInCity(['Norfolk'], 'Suffolk'), 'service list match ignores case and spaces');
assert(isBusinessCity([], 'Anywhere') && isBusinessCity(['Chesapeake'], 'CHESAPEAKE') && !isBusinessCity(['Chesapeake'], 'Richmond'), 'business list');

console.log('\n── estimate email ──');
const email = buildEstimateRequestEmail({
  businessName: 'Benny Provision Foundation ',
  request: {
    customerName: 'Ana <script>', customerEmail: 'ana@x.test', customerPhone: '757 555 0100', city: 'Norfolk',
    serviceName: 'Standard Move', preferredDate: '2026-12-01',
    details: { moveType: 'Standard Move', homeSize: '2 Bedroom', notes: 'Piano & "glass"', custom: 'kept' },
  },
});
assert(email.subject === 'New estimate request from Ana <script>', 'subject names the customer (plain text header)', email.subject);
assert(!email.html.includes('<script>') && email.html.includes('Ana &lt;script&gt;'), 'customer text is escaped in the html');
assert(email.html.includes('Piano &amp; &quot;glass&quot;') && email.html.includes('2 Bedroom') && email.html.includes('kept'), 'details shown, unknown keys kept');
assert(email.html.includes('54 State Street'), 'CAN-SPAM footer included');
assert(!/[–—]| - /.test(email.text) && !/[–—]/.test(email.html), 'no dashes (copy rule)', email.text);
assert(!/8\s?%/.test(email.html), 'no fee percentage');
assert(email.text.includes('Pickup address') === false && email.text.includes('Home size: 2 Bedroom'), 'empty fields left out, known labels used');
assert(escapeHtml(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#x27;&amp;', 'escapeHtml');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
