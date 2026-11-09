/**
 * Pure tests for service cities and the estimate request email (migration 068). No database, no network.
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
assert(email.subject === 'New request from Ana <script>', 'subject names the customer (plain text header)', email.subject);
assert(!email.html.includes('<script>') && email.html.includes('Ana &lt;script&gt;'), 'customer text is escaped in the html');
assert(email.html.includes('Piano &amp; &quot;glass&quot;') && email.html.includes('2 Bedroom') && email.html.includes('kept'), 'details shown, unknown keys kept');
assert(email.html.includes('54 State Street'), 'CAN-SPAM footer included');
assert(!/[–—]| - /.test(email.text) && !/[–—]/.test(email.html), 'no dashes (copy rule)', email.text);
assert(!/8\s?%/.test(email.html), 'no fee percentage');
assert(email.text.includes('Pickup address') === false && email.text.includes('Home size: 2 Bedroom'), 'empty fields left out, known labels used');

console.log('\n── request email for every vendor (Request forms F2, call 12) ──');
const pe = buildEstimateRequestEmail({
  businessName: 'Lens and Light Studio',
  request: {
    customerName: 'Tasha M.', customerEmail: 't@x.test', customerPhone: '516 555 0142', city: null,
    serviceName: 'Wedding day coverage', preferredDate: '2027-06-13', details: {},
    answers: [
      { questionId: 'b_a1', label: 'What kind of day is it?', type: 'choice', value: 'Wedding' },
      { questionId: 'b_a2', label: 'Looks you love', type: 'photos', value: ['https://cdn.x/requests/a.jpg', 'https://cdn.x/requests/b".jpg'] },
      { questionId: 's_a3', label: 'Extras', type: 'choice', value: ['Second shooter', 'Album'] },
    ],
  },
});
assert(pe.subject === 'New request from Tasha M.' && pe.html.includes('New request') && !/estimate/i.test(pe.html + pe.text + pe.subject), 'general wording, no "estimate" anywhere', pe.subject);
assert(pe.html.includes('Lens and Light Studio') && pe.text.startsWith('New request for Lens and Light Studio.'), "the vendor's name (a photographer here)");
assert(pe.html.includes('>Service<') && pe.html.includes('Wedding day coverage') && !pe.html.includes('>Plan<'), 'the service row is called Service');
assert((pe.html.match(/<img /g) ?? []).length === 2 && pe.html.includes('src="https://cdn.x/requests/a.jpg"'), 'photos shown as images');
assert(pe.html.includes('b&quot;.jpg') && !pe.html.includes('b".jpg'), 'photo links escaped');
assert(pe.text.includes('Looks you love: 2 photos: https://cdn.x/requests/a.jpg'), 'the text version lists the photo links');
assert(pe.text.includes('Extras: Second shooter, Album') && pe.text.includes('What kind of day is it?: Wedding'), 'every answer, several choices joined');
assert(pe.html.includes('under Requests'), 'footer points to Requests in the app');
assert(!/[–—]| - /.test(pe.text) && !/[–—]/.test(pe.html), 'no dashes (copy rule)', pe.text);

assert(escapeHtml(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#x27;&amp;', 'escapeHtml');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
