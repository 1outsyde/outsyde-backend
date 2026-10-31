/**
 * Unit tests for Event team invite links (p4-team step 9-0, migration 092). No database:
 *   npx tsx server/events/teamLinks.test.ts
 *
 * Mutation checks (each must turn a test red):
 *  - let newLinkCode use 0, 1, I or O → "codes never use 0 1 I O" fails.
 *  - drop the trim/uppercase in normalizeCode → "a typed code is cleaned" fails.
 *  - give standing links the event end as expiry → "standing links last 7 days" fails.
 *  - accept pay on a standing link → "pay only on This event" fails.
 *  - drop the lowercase in cleanEmail → "emails are stored lowercase" fails.
 *  - let linkStatus report open after expires_at → "past its end is expired" fails.
 */
import {
  LINK_ALPHABET, LINK_CODE_LENGTH, STANDING_LINK_DAYS, newLinkCode, normalizeCode, linkExpiry, cleanEmail, parseLinkBody,
  linkStatus, linkUrl, linkPayJson,
} from "./teamLinks";

let passed = 0, failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.error(`  ❌ ${name}`, JSON.stringify(actual), "expected", JSON.stringify(expected)); }
}

console.log("codes");
eq(LINK_CODE_LENGTH, 12, "12 characters (migration 092 check)");
eq(/[01IO]/.test(LINK_ALPHABET), false, "codes never use 0 1 I O (easy to misread)");
eq(/^[A-Z2-9]+$/.test(LINK_ALPHABET), true, "alphabet fits the database check [A-Z2-9]");
const many = Array.from({ length: 500 }, () => newLinkCode());
eq(many.every((c) => /^[A-Z2-9]{12}$/.test(c) && !/[01IO]/.test(c)), true, "every new code fits the check and skips 0 1 I O");
eq(new Set(many).size, 500, "500 new codes are all different");
eq(newLinkCode(() => 0), "A".repeat(12), "uses the random source it is given (first letter)");
eq(newLinkCode(() => LINK_ALPHABET.length - 1), "9".repeat(12), "uses the random source it is given (last letter)");

console.log("typed or pasted codes");
eq(normalizeCode(" k7q2m9abcdef "), "K7Q2M9ABCDEF", "a typed code is cleaned (trimmed, uppercase)");
eq(normalizeCode("K7Q2M9ABCDE"), null, "11 characters is not a code");
eq(normalizeCode("K7Q2M9ABCDEO"), null, "an O is never in a code");
eq(normalizeCode("K7Q2M9ABCD-F"), null, "punctuation is not a code");
eq(normalizeCode(undefined), null, "nothing is not a code");

console.log("when a link ends");
const now = new Date("2026-11-01T12:00:00.000Z");
const ends = "2026-11-08T07:00:00.000Z";
eq(linkExpiry("event", ends, now).toISOString(), ends, "This event links end when the event ends");
eq(STANDING_LINK_DAYS, 7, "standing links last 7 days (call 69)");
eq(linkExpiry("standing", ends, now).toISOString(), "2026-11-08T12:00:00.000Z", "standing links last 7 days from when they were made");

console.log("emails");
eq(cleanEmail("  Jay@Example.COM "), "jay@example.com", "emails are stored lowercase and trimmed");
eq(cleanEmail("jay@example"), null, "no dot after the @ is not an email");
eq(cleanEmail("jay example.com"), null, "no @ is not an email");
eq(cleanEmail("a b@example.com"), null, "a space inside is not an email");
eq(cleanEmail(`${"a".repeat(250)}@x.co`), null, "longer than 254 is refused");
eq(cleanEmail(42), null, "a number is not an email");

console.log("what a host can put on a link");
const ok = (b: unknown) => parseLinkBody(b);
eq(ok({ scope: "event", role: "security" }), { ok: true, value: { scope: "event", role: "security", roleLabel: null, cohostLevel: null, pay: null, email: null } }, "role and scope only");
eq(ok({ scope: "event", role: "security", pay: { payType: "fixed", fixedCents: 16000 } }),
  { ok: true, value: { scope: "event", role: "security", roleLabel: null, cohostLevel: null, pay: { payType: "fixed", fixedCents: 16000, hourlyCents: null, commissionBps: null }, email: null } },
  "fixed pay on This event");
eq(ok({ scope: "event", role: "host", pay: { payType: "none", commissionPercent: 10 } }),
  { ok: true, value: { scope: "event", role: "host", roleLabel: null, cohostLevel: null, pay: { payType: "none", fixedCents: null, hourlyCents: null, commissionBps: 1000 }, email: null } },
  "commission for a Promoter");
eq(ok({ scope: "event", role: "other", roleLabel: "  Coat   check " }),
  { ok: true, value: { scope: "event", role: "other", roleLabel: "Coat check", cohostLevel: null, pay: null, email: null } }, "Other with its name");
eq(ok({ scope: "standing", role: "cohost", cohostLevel: "edit" }),
  { ok: true, value: { scope: "standing", role: "cohost", roleLabel: null, cohostLevel: "edit", pay: null, email: null } }, "a co-host link with its level");
eq(ok({ scope: "event", role: "cohost" }),
  { ok: true, value: { scope: "event", role: "cohost", roleLabel: null, cohostLevel: "team", pay: null, email: null } }, "a co-host link without a level is Team");
eq(ok({ scope: "event", role: "door", email: " Jay@Example.com" }),
  { ok: true, value: { scope: "event", role: "door", roleLabel: null, cohostLevel: null, pay: null, email: "jay@example.com" } }, "sent by email (67b)");
const bad = (b: unknown) => { const r = parseLinkBody(b); return r.ok ? "accepted" : r.message; };
eq(bad({ scope: "standing", role: "security", pay: { payType: "fixed", fixedCents: 16000 } }), "pay: set pay for one event at a time. For All my events, set it on each event after they join.", "pay only on This event");
eq(bad({ scope: "event", role: "cohost", pay: { payType: "none" } }), "pay: co-hosts don't get team pay.", "no pay for co-hosts");
eq(bad({ scope: "event", role: "security", pay: { payType: "fixed", fixedCents: 0 } }), "pay: fixedCents: whole cents from 1 up to $10,000.", "pay uses the same limits as setting pay");
eq(bad({ scope: "event", role: "security", pay: { payType: "none", commissionPercent: 10 } }), "pay: commissionPercent: only Promoters and Entertainment earn commission.", "commission only for link roles");
eq(bad({ scope: "event", role: "security", cohostLevel: "edit" }), "cohostLevel: only for co-hosts.", "level only for co-hosts");
eq(bad({ scope: "event", role: "other" }), "roleLabel: type a name for this role (up to 40 characters).", "Other needs its name");
eq(bad({ scope: "event", role: "security", email: "not an email" }), "email: enter a full email address.", "a bad email is refused");
eq(bad({ scope: "always", role: "security" }), "scope: choose standing or event.", "scope is standing or event");
eq(bad({ scope: "event", role: "dj" }), "role: choose door, security, host, entertainment, media, cohost or other.", "role is one of the seven");
eq(bad({ scope: "event", role: "security", username: "jay" }), "username: not a link field.", "unknown keys are refused");
eq(bad(null), "body: expected an object.", "no body");

console.log("link status");
const row = (o: Record<string, unknown> = {}) => ({ status: "open", scope: "event", expires_at: "2026-11-08T07:00:00.000Z", e_status: "published", e_ends_at: "2026-11-08T07:00:00.000Z", ...o });
eq(linkStatus(row(), now), "open", "open before its end");
eq(linkStatus(row({ expires_at: "2026-11-01T11:59:59.000Z" }), now), "expired", "past its end is expired");
eq(linkStatus(row({ e_status: "cancelled" }), now), "expired", "a cancelled event's link is over");
eq(linkStatus(row({ status: "accepted" }), now), "accepted", "accepted stays accepted");
eq(linkStatus(row({ status: "cancelled" }), now), "cancelled", "cancelled stays cancelled");
eq(linkStatus(row({ scope: "standing", e_status: "cancelled", expires_at: "2026-11-05T00:00:00.000Z" }), now), "open", "a standing link doesn't end with the event it was made from");

console.log("link address and pay");
process.env.FRONTEND_URL = "https://goutsyde.test/";
eq(linkUrl("K7Q2M9ABCDEF"), "https://goutsyde.test/team/K7Q2M9ABCDEF", "goutsyde.com/team/CODE (call 70)");
eq(linkPayJson({ pay_type: null }), null, "no pay set");
eq(linkPayJson({ pay_type: "hourly", fixed_cents: null, hourly_cents: 2500, commission_bps: 1050 }),
  { payType: "hourly", fixedCents: null, hourlyCents: 2500, commissionPercent: 10.5 }, "pay as the screens show it");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
