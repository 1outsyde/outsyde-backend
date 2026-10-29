/** Unit tests for event team roles (p4-team steps 1 and 2). No database: npx tsx server/events/teamRoles.test.ts */
import {
  TEAM_ROLES, roleName, roleInfo, parseRoleLabel, inviteTitle, joinedCopy, inviteEmailCopy, duplicateMessage, pushTypes,
} from "./teamRoles";

let passed = 0, failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.error(`  ❌ ${name}`, JSON.stringify(actual), "expected", JSON.stringify(expected)); }
}

console.log("roles");
eq(TEAM_ROLES, ["door", "security", "host", "entertainment", "media", "cohost", "other"], "every role, same words as the database check (083)");

console.log("role names (what screens and copy call each section)");
eq(roleName("door"), "Admissions", "door is Admissions");
eq(roleName("security"), "Security", "security");
eq(roleName("host"), "Promoter", "host is Promoter");
eq(roleName("entertainment"), "Entertainment", "entertainment");
eq(roleName("media"), "Media", "media");
eq(roleName("cohost"), "Co-host", "co-host");
eq(roleName("other", "Bartender"), "Bartender", "other uses the name the host typed");
eq(roleName("other", null), "Event team", "other with no name falls back");

console.log("role label (other only)");
eq(parseRoleLabel("other", "  Coat   check "), { ok: true, label: "Coat check" }, "trimmed, inner spaces squeezed");
eq(parseRoleLabel("other", ""), { ok: false, message: "roleLabel: type a name for this role (up to 40 characters)." }, "other needs a name");
eq(parseRoleLabel("other", undefined), { ok: false, message: "roleLabel: type a name for this role (up to 40 characters)." }, "other without a name refused");
eq(parseRoleLabel("other", "x".repeat(41)), { ok: false, message: "roleLabel: type a name for this role (up to 40 characters)." }, "41 characters refused");
eq(parseRoleLabel("other", "<b>Bar</b>"), { ok: false, message: "roleLabel: letters, numbers, spaces and & ' . , / ( ) only." }, "no markup");
eq(parseRoleLabel("security", "Bouncer"), { ok: false, message: "roleLabel: only for the Other role." }, "label only for other");
eq(parseRoleLabel("security", undefined), { ok: true, label: null }, "no label for other roles");

console.log("role info for the host's team list");
eq(roleInfo("door"), { name: "Admissions", description: "Scans tickets and sees the guest list." }, "door");
eq(roleInfo("security"), { name: "Security", description: "Sees their call time, where to go and your notes." }, "security");
eq(roleInfo("host"), { name: "Promoter", description: "Gets their own link and sees the tickets sold through it." }, "promoter");
eq(roleInfo("entertainment"), { name: "Entertainment", description: "Sees their set time, load in and your notes." }, "entertainment");
eq(roleInfo("media"), { name: "Media", description: "Sees their call time, where to go and your notes." }, "media");
eq(roleInfo("cohost"), { name: "Co-host", description: "Sees everything you see for the event, including sales, the guest list and the team." }, "co-host sees all the host sees");
eq(roleInfo("other", "Bartender"), { name: "Bartender", description: "Sees their times, where to go and your notes." }, "other");

console.log("invite title (push and Activity)");
eq(inviteTitle("Hosty", "door"), "Hosty invited you to their Event team for Admissions", "door");
eq(inviteTitle("Hosty", "security"), "Hosty invited you to their Event team for Security", "security");
eq(inviteTitle("Hosty", "host"), "Hosty invited you to their Event team as a Promoter", "promoter");
eq(inviteTitle("Hosty", "entertainment"), "Hosty invited you to their Event team for Entertainment", "entertainment");
eq(inviteTitle("Hosty", "media"), "Hosty invited you to their Event team for Media", "media");
eq(inviteTitle("Hosty", "cohost"), "Hosty invited you to co-host with them", "co-host");
eq(inviteTitle("Hosty", "other", "Coat check"), "Hosty invited you to their Event team for Coat check", "other");

console.log("joined (push to the host)");
eq(joinedCopy("Ana", "door", "Late Night"), { title: "Ana joined your Event team for Admissions", body: "They can scan tickets for Late Night." }, "door");
eq(joinedCopy("Ana", "security", "Late Night"), { title: "Ana joined your Event team for Security", body: "They'll see their call time and where to go for Late Night." }, "security");
eq(joinedCopy("Ana", "host", "Late Night"), { title: "Ana joined your Event team as a Promoter", body: "They'll get their own link for Late Night." }, "promoter");
eq(joinedCopy("Ana", "entertainment", "Late Night"), { title: "Ana joined your Event team for Entertainment", body: "They'll see their set time and load in for Late Night." }, "entertainment");
eq(joinedCopy("Ana", "media", "Late Night"), { title: "Ana joined your Event team for Media", body: "They'll see their call time and where to go for Late Night." }, "media");
eq(joinedCopy("Ana", "cohost", "Late Night"), { title: "Ana is co-hosting with you", body: "They see everything you see for Late Night." }, "co-host");
eq(joinedCopy("Ana", "other", "all your events", "Coat check"), { title: "Ana joined your Event team for Coat check", body: "They'll see their times and where to go for all your events." }, "other");

console.log("invite email copy");
const door = inviteEmailCopy("door", "Club &amp; Co", "<strong>X</strong>");
eq(door.subject, "Club &amp; Co invited you to their Event team for Admissions", "door subject");
eq(door.heading, "you're invited to the Event team", "door heading");
eq(door.lines, [
  "Club &amp; Co wants you on Admissions for <strong>X</strong>, checking guests in at the door.",
  "If you accept, you can scan tickets and see the guest list in the Outsyde app or on goutsyde.com.",
], "door lines (no \"you won't see\" line)");
const sec = inviteEmailCopy("security", "H", "their events");
eq(sec.lines, [
  "H wants you on Security for their events.",
  "If you accept, you'll see your call time, where to go and the host's notes in the Outsyde app or on goutsyde.com.",
], "security lines");
const promo = inviteEmailCopy("host", "H", "their events");
eq(promo.lines[0], "H wants you to promote their events.", "promoter line");
const co = inviteEmailCopy("cohost", "H", "their events");
eq(co.subject, "H invited you to co-host with them", "co-host subject");
eq(co.heading, "you're invited to co-host", "co-host heading");
eq(co.lines[1], "If you accept, you'll see everything the host sees for the event, including sales, the guest list and the team, in the Outsyde app or on goutsyde.com.", "co-host sees all the host sees");
const other = inviteEmailCopy("other", "H", "their events", "Coat check");
eq(other.lines[0], "H wants you on their Event team as Coat check for their events.", "other line");
const ent = inviteEmailCopy("entertainment", "H", "their events");
const media = inviteEmailCopy("media", "H", "their events");
const all = [door, sec, promo, co, other, ent, media].flatMap((c) => [c.subject, c.heading, c.intro, ...c.lines]).join(" ");
eq(/[–—]/.test(all) || / - /.test(all) || /%/.test(all), false, "no dashes, no percentages in any copy");
eq(/won't see/.test(all), false, "no \"you won't see\" lines (decision 7)");

console.log("duplicate messages");
eq(duplicateMessage("door", "ALREADY_INVITED"), "You already invited them for Admissions.", "door invited");
eq(duplicateMessage("door", "ALREADY_ON_TEAM"), "They are already on your Event team for Admissions.", "door on team");
eq(duplicateMessage("cohost", "ALREADY_ON_TEAM"), "They are already on your Event team as a Co-host.", "co-host on team");
eq(duplicateMessage("other", "ALREADY_INVITED", "Coat check"), "You already invited them for Coat check.", "other invited");

console.log("push types");
eq(pushTypes("door"), { invite: "door_team_invite", accepted: "door_team_accepted" }, "door: unchanged types (old apps open the door screens)");
for (const r of ["security", "host", "entertainment", "media", "cohost", "other"] as const) {
  eq(pushTypes(r), { invite: "team_invite", accepted: "team_accepted" }, `${r}: team types old apps don't route to the door screen`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
