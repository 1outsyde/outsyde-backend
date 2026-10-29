/** Unit tests for event team roles (p4-team step 1). No database: npx tsx server/events/teamRoles.test.ts */
import { TEAM_ROLES, inviteTitle, joinedCopy, inviteEmailCopy, duplicateMessage, pushTypes } from "./teamRoles";

let passed = 0, failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.error(`  ❌ ${name}`, JSON.stringify(actual), "expected", JSON.stringify(expected)); }
}

console.log("roles");
eq(TEAM_ROLES, ["door", "security", "host"], "the three roles, same words as the database check (075)");

console.log("invite title (push and Activity)");
eq(inviteTitle("Hosty", "door"), "Hosty invited you to their door team", "door: unchanged until the app and site say Admissions");
eq(inviteTitle("Hosty", "security"), "Hosty invited you to their Security team", "security");
eq(inviteTitle("Hosty", "host"), "Hosty invited you to host and promote with them", "host / promoter");

console.log("joined (push to the host)");
eq(joinedCopy("Ana", "door", "Late Night"), { title: "Ana joined your door team", body: "They can scan tickets for Late Night." }, "door: unchanged");
eq(joinedCopy("Ana", "security", "Late Night"), { title: "Ana joined your Security team", body: "They'll see when to arrive and where to go for Late Night." }, "security");
eq(joinedCopy("Ana", "host", "Late Night"), { title: "Ana is hosting and promoting with you", body: "They'll get their own link for Late Night." }, "host / promoter");

console.log("invite email copy");
const door = inviteEmailCopy("door", "Club & Co", "<strong>X</strong>");
eq(door.subject, "Club & Co invited you to their door team", "door subject unchanged");
eq(door.heading, "you're invited to the door team", "door heading unchanged");
eq(door.intro, "Club & Co invited you to their door team.", "door intro unchanged");
eq(door.lines, [
  "Club & Co wants you to help check guests in at the door for <strong>X</strong>.",
  "If you accept, you can scan tickets and see the guest list in the Outsyde app or on goutsyde.com. You won't see sales, earnings or anyone's contact details.",
], "door lines unchanged");
const sec = inviteEmailCopy("security", "Club & Co", "their events");
eq(sec.subject, "Club & Co invited you to their Security team", "security subject");
eq(sec.lines[1], "If you accept, you'll see when to arrive and where to go in the Outsyde app or on goutsyde.com. You won't see sales, the guest list or anyone's contact details.", "security: no scanner, no guest list");
const host = inviteEmailCopy("host", "Club & Co", "their events");
eq(host.subject, "Club & Co invited you to host and promote with them", "host subject");
eq(host.lines[1], "If you accept, you'll get your own link to share and see the tickets sold through it. You won't see anyone's contact details.", "host: own link, own sales");
const all = [door, sec, host].flatMap((c) => [c.subject, c.heading, c.intro, ...c.lines]).join(" ");
eq(/[–—]/.test(all) || / - /.test(all) || /%/.test(all), false, "no dashes, no percentages in any copy");

console.log("duplicate messages");
eq(duplicateMessage("door", "ALREADY_INVITED"), "You already invited them. They can scan once they accept.", "door invited: unchanged");
eq(duplicateMessage("door", "ALREADY_ON_TEAM"), "They are already on your door team.", "door on team: unchanged");
eq(duplicateMessage("security", "ALREADY_INVITED"), "You already invited them for that role.", "security invited");
eq(duplicateMessage("host", "ALREADY_ON_TEAM"), "They already have that role on your team.", "host on team");

console.log("push types");
eq(pushTypes("door"), { invite: "door_team_invite", accepted: "door_team_accepted" }, "door: unchanged types");
eq(pushTypes("security"), { invite: "team_invite", accepted: "team_accepted" }, "security: new types old apps don't route to the door screen");
eq(pushTypes("host"), { invite: "team_invite", accepted: "team_accepted" }, "host: new types");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
