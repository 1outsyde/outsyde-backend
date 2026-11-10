/**
 * Pure tests for the extra estimate request recipients (migration 111). No database, no network.
 * Run with: npx tsx server/estimates/requestRecipients.test.ts
 */
import { cleanRecipients, extraRecipientsFor, MAX_REQUEST_RECIPIENTS } from './requestRecipients';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const OWNER = 'Info.RoyalEliteMoving@gmail.com';
const ADMIN = 'info@goutsyde.com';

console.log('\n── cleanRecipients ──');
let r = cleanRecipients(['  JDMYMY86@gmail.com ', 'jdmymy86@gmail.com'], OWNER, ADMIN);
assert('emails' in r && same(r.emails, ['jdmymy86@gmail.com']), 'trim, lowercase, drop duplicates', r);
r = cleanRecipients(['info.royalelitemoving@GMAIL.com', 'a@b.co'], OWNER, ADMIN);
assert('emails' in r && same(r.emails, ['a@b.co']), "owner's own email is dropped (always gets a copy)", r);
r = cleanRecipients(['INFO@goutsyde.com', 'a@b.co'], OWNER, ADMIN);
assert('emails' in r && same(r.emails, ['a@b.co']), "Outsyde's address is dropped (always gets a copy)", r);
r = cleanRecipients(['', '   ', 'a@b.co'], OWNER, ADMIN);
assert('emails' in r && same(r.emails, ['a@b.co']), 'blank lines are ignored', r);
r = cleanRecipients([], OWNER, ADMIN);
assert('emails' in r && same(r.emails, []), 'an empty list clears it', r);
r = cleanRecipients(['a@b.co', 'c@d.co', 'e@f.co', 'g@h.co', 'i@j.co'], null, ADMIN);
assert('emails' in r && r.emails.length === MAX_REQUEST_RECIPIENTS && MAX_REQUEST_RECIPIENTS === 5, '5 allowed', r);
r = cleanRecipients(['a@b.co', 'c@d.co', 'e@f.co', 'g@h.co', 'i@j.co', 'k@l.co'], null, ADMIN);
assert('error' in r && r.error === 'You can add up to 5 emails.', '6 refused with a clear message', r);
r = cleanRecipients(['a@b.co', 'a@b.co', 'c@d.co', 'e@f.co', 'g@h.co', 'i@j.co'], null, ADMIN);
assert('emails' in r && r.emails.length === 5, 'duplicates do not count toward the 5', r);
r = cleanRecipients(['bob'], OWNER, ADMIN);
assert('error' in r && r.error === '"bob" is not an email address.', 'a non email is refused by name', r);
r = cleanRecipients(['a@b'], OWNER, ADMIN);
assert('error' in r, 'an address with no dot in the domain is refused', r);
r = cleanRecipients(['a b@c.co'], OWNER, ADMIN);
assert('error' in r, 'an address with a space is refused', r);
r = cleanRecipients(['x'.repeat(250) + '@b.co'], OWNER, ADMIN);
assert('error' in r, 'an address over 254 characters is refused', r);
r = cleanRecipients('a@b.co' as unknown, OWNER, ADMIN);
assert('error' in r && r.error === 'Send a list of emails.', 'a string instead of a list is refused', r);
r = cleanRecipients([42] as unknown, OWNER, ADMIN);
assert('error' in r, 'a non text item is refused', r);

console.log('\n── extraRecipientsFor (at send time) ──');
assert(same(extraRecipientsFor(['jdmymy86@gmail.com'], OWNER, ADMIN), ['jdmymy86@gmail.com']), 'saved list is used');
assert(same(extraRecipientsFor(null, OWNER, ADMIN), []), 'nothing saved = no extra emails');
assert(same(extraRecipientsFor(['Info.RoyalEliteMoving@gmail.com', 'info@goutsyde.com', 'x@y.co'], OWNER, ADMIN), ['x@y.co']), 'never doubles the owner or Outsyde copy, even if the owner later changes email');
assert(same(extraRecipientsFor(['x@y.co', 'X@Y.co'], OWNER, ADMIN), ['x@y.co']), 'never sends twice to one address');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
