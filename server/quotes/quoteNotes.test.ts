/**
 * Pure tests for quotes step 5a: the quote link preview (signed out) and the note emails.
 * Legend 2026-11-05 (step 5 calls 1 to 3): a signed out link shows a preview with no customer details; a different
 * account sees no details; every unread note in a quote chat is emailed, at most one email per chat and person
 * every 10 minutes, with all the new notes in it.
 * Run with: DATABASE_URL=postgresql://x:y@localhost:5432/z npx tsx server/quotes/quoteNotes.test.ts
 */
import { quotePreviewJson, noteEmailDue, buildNoteEmail, NOTE_EMAIL_EVERY_MINUTES, NOTE_EMAIL_DELAY_MINUTES } from './quoteNotesRules';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const M = 60_000;

console.log('\n── the signed out preview (call 1) ──');
const q: any = { id: 'q1', status: 'sent', kind: 'service', title: '2 Bedroom Move', details: 'Crew of 3', extrasNote: null, jobDate: '2026-11-08', startTime: '09:00', durationMinutes: 180, timeZone: 'America/New_York',
  totalCents: 65000, paymentMode: 'deposit', depositCents: 10000, restPaid: 'outsyde', expiresAt: new Date('2026-11-07T00:00:00Z'), customerId: 'cust', conversationId: 'conv', senderId: 'owner', linkCode: 'abc', appointmentId: null, payingUntil: null };
const biz: any = { id: 'b1', name: 'Royal Elite Moving', logoImage: 'https://r2/logo.png', coverImage: null, brandColors: { primary: '#123456' }, ownerId: 'owner', contactPhone: '757 555 0100' };
const p = quotePreviewJson(q, biz, new Date('2026-11-05T12:00:00Z'));
assert(p.business.name === 'Royal Elite Moving' && p.business.logoImage === 'https://r2/logo.png' && p.business.brandColors?.primary === '#123456', 'business look', p.business);
assert(p.title === '2 Bedroom Move' && p.totalCents === 65000 && p.amounts.payNowCents === 10800 && p.status === 'sent', 'title, price and what is paid now', p);
const s = JSON.stringify(p);
assert(!/cust|conv|owner|abc/.test(s), 'nothing about the customer, the chat or the link', s);
assert(!('details' in p) && !('extrasNote' in p), 'the written details wait for sign in', Object.keys(p));

console.log('\n── when a note email is due (call 3) ──');
const now = new Date('2026-11-05T12:00:00Z');
assert(NOTE_EMAIL_EVERY_MINUTES === 10 && NOTE_EMAIL_DELAY_MINUTES === 2, 'at most one every 10 minutes, after 2 minutes unread');
assert(noteEmailDue(null, now) === true, 'never emailed: due');
assert(noteEmailDue(new Date(now.getTime() - 9 * M), now) === false, 'emailed 9 minutes ago: wait');
assert(noteEmailDue(new Date(now.getTime() - 10 * M), now) === true, 'emailed 10 minutes ago: due');

console.log('\n── the email (commas and periods, no fee rate) ──');
const e = buildNoteEmail({ recipientFirstName: 'Ana', senderName: 'Royal Elite Moving', title: '2 Bedroom Move', notes: ['We will call 30 minutes before.', 'x'.repeat(900)], link: 'https://goutsyde.com/q/abc' });
assert(e.subject === 'New note from Royal Elite Moving about 2 Bedroom Move', 'subject', e.subject);
assert(e.text.includes('Hi Ana,') && e.text.includes('We will call 30 minutes before.') && e.text.includes('https://goutsyde.com/q/abc'), 'the notes and the link', e.text);
assert(!e.text.includes('x'.repeat(600)), 'long notes are shortened', e.text.length);
const many = buildNoteEmail({ recipientFirstName: null, senderName: 'Ana', title: 'Move', notes: ['1', '2', '3', '4', '5', '6', '7'], link: 'https://x' });
assert(many.text.includes('Hi,') && many.text.includes('And 2 more in the chat.') && !many.text.includes('\n6\n'), 'up to 5 notes, then "and N more"', many.text);
const esc = buildNoteEmail({ recipientFirstName: 'A', senderName: '<b>x</b>', title: 'T', notes: ['<script>'], link: 'https://x' });
assert(!esc.html.includes('<script>') && !esc.html.includes('<b>x</b>'), 'HTML is escaped', esc.html);
for (const t of [e.text, e.subject, many.text]) assert(!/[–—]|8%/.test(t), `no dashes or fee rate: ${t.slice(0, 60)}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
