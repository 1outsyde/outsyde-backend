/**
 * Real name vs display name rule — run with: npx tsx server/personName.test.ts
 */
import { splitFullName, namesForNewAccount, realName, publicDisplayName, cleanName } from "./personName";

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, JSON.stringify({ actual, expected })); }
}

console.log("cleanName / splitFullName");
eq(cleanName("  Jasmine   Carter "), "Jasmine Carter", "trims and collapses spaces");
eq(cleanName(""), null, "empty → null");
eq(cleanName(5 as any), null, "non-string → null");
eq(splitFullName("Jasmine Carter"), { firstName: "Jasmine", lastName: "Carter" }, "two words");
eq(splitFullName("Mary Ann Smith"), { firstName: "Mary", lastName: "Ann Smith" }, "three words: rest is last name");
eq(splitFullName("Cher"), { firstName: "Cher", lastName: null }, "one word");
eq(splitFullName("   "), { firstName: null, lastName: null }, "blank");

console.log("namesForNewAccount (what signup stores)");
eq(namesForNewAccount({ name: "Jasmine Carter", firstName: "Jasmine", lastName: "Carter" }),
  { name: "Jasmine", firstName: "Jasmine", lastName: "Carter" }, "app/site consumer signup: display = first name, real name kept");
eq(namesForNewAccount({ name: "Jasmine Carter" }),
  { name: "Jasmine", firstName: "Jasmine", lastName: "Carter" }, "vendor/photographer/invite signup (name only): split");
eq(namesForNewAccount({ name: "Mary Ann Smith", email: "m@x.com" }),
  { name: "Mary", firstName: "Mary", lastName: "Ann Smith" }, "middle name stays with the last name");
eq(namesForNewAccount({ firstName: " Jo ", lastName: " Lee " }),
  { name: "Jo", firstName: "Jo", lastName: "Lee" }, "first/last only, trimmed");
eq(namesForNewAccount({ name: "Jo Lee", lastName: "Lee" }),
  { name: "Jo", firstName: "Jo", lastName: "Lee" }, "last name given without first: first from name");
eq(namesForNewAccount({ email: "kay@x.com" }),
  { name: "kay", firstName: null, lastName: null }, "no name at all: email prefix as before");
eq(namesForNewAccount({}), { name: "Outsyde member", firstName: null, lastName: null }, "nothing at all");
eq(namesForNewAccount({ email: "jane.smith1987@x.com", username: "janes" }),
  { name: "janes", firstName: null, lastName: null }, "no name: username before the email's local part");
eq(namesForNewAccount({ name: "Mary Ann Smith", firstName: "Mary" }),
  { name: "Mary", firstName: "Mary", lastName: "Ann Smith" }, "first given, last missing: rest of name is the last name");
eq(namesForNewAccount({ name: "Jo", firstName: "Mary" }),
  { name: "Mary", firstName: "Mary", lastName: null }, "first given, name doesn't start with it: no guessing");

console.log("realName (transactions, admin)");
eq(realName({ name: "Jasmine", firstName: "Jasmine", lastName: "Carter" }), "Jasmine Carter", "first + last");
eq(realName({ name: "Jas", firstName: null, lastName: null }), "Jas", "no real name stored: display name (old behaviour)");
eq(realName({ name: "Jasmine Carter", firstName: null, lastName: null }), "Jasmine Carter", "older accounts unchanged");
eq(realName({ name: null, firstName: "Jasmine", lastName: null }), "Jasmine", "first only");
eq(realName(null), null, "no user");
eq(realName({ name: "  ", firstName: " ", lastName: "" }), null, "all blank → null");

console.log("publicDisplayName (everyone else)");
eq(publicDisplayName({ name: "Jas", firstName: "Jasmine", lastName: "Carter", username: "jas" }), "Jas", "display name");
eq(publicDisplayName({ name: "", firstName: "Jasmine", lastName: "Carter", username: "jas" }), "@jas", "empty display name → @username, never first name");
eq(publicDisplayName({ name: null, firstName: "Jasmine", username: null }), null, "nothing public → null");
eq(publicDisplayName({ name: "Jas", email: "jasmine@x.com" } as any), "Jas", "never email");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
