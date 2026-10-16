/**
 * Public identity rule (messaging) — pure tests, no DB, no network.
 * Run with: npx tsx server/publicIdentity.test.ts
 *
 * Mutation check: in pickPublicIdentity, swap `clean(business.name) || personalName(user)` for
 * `personalName(user)` → the "business owner shows business name" assertions fail.
 */
import { pickPublicIdentity } from "./publicIdentity";

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}\n     expected ${JSON.stringify(expected)}\n     got      ${JSON.stringify(actual)}`); }
}

const baseUser = {
  id: "u1", name: "Jane Legal", firstName: "Jane", username: "janedoe",
  profileImageUrl: null as string | null, isVendor: false, isPhotographer: false,
};

console.log("business owner");
{
  const u = { ...baseUser, isVendor: true };
  const who = pickPublicIdentity(u, { id: "b1", name: "Braids With Love ", logoImage: "https://cdn/logo.png" });
  eq(who.publicName, "Braids With Love", "shows business name (trimmed), never legal name");
  eq(who.avatarUrl, "https://cdn/logo.png", "shows business logo");
  eq(who.kind, "business", "kind = business");
  eq(who.businessId, "b1", "businessId set");
}
{
  const u = { ...baseUser, isVendor: true, profileImageUrl: "https://cdn/me.jpg" };
  const who = pickPublicIdentity(u, { id: "b1", name: "Shop", logoImage: null });
  eq(who.avatarUrl, "https://cdn/me.jpg", "no logo → falls back to user photo (same as feed)");
}
{
  const u = { ...baseUser, isVendor: true };
  const who = pickPublicIdentity(u, { id: "b1", name: "   ", logoImage: "" });
  eq(who.publicName, "Jane Legal", "blank business name → user name (same as feed)");
  eq(who.avatarUrl, null, "blank logo and no photo → null (app shows initial)");
}
{
  const u = { ...baseUser, isVendor: false };
  const who = pickPublicIdentity(u, { id: "b1", name: "Owned Biz", logoImage: null });
  eq(who.publicName, "Owned Biz", "owns a business without the vendor flag → still business name");
}

console.log("photographer");
{
  const u = { ...baseUser, isPhotographer: true };
  const who = pickPublicIdentity(u, null, { id: "p1", displayName: "Gicasso Films", logoImage: "https://cdn/g.png" });
  eq(who.publicName, "Gicasso Films", "shows photographer display name");
  eq(who.avatarUrl, "https://cdn/g.png", "shows photographer logo");
  eq(who.kind, "photographer", "kind = photographer");
  eq(who.photographerId, "p1", "photographerId set");
}
{
  const u = { ...baseUser, isPhotographer: false };
  const who = pickPublicIdentity(u, null, { id: "p1", displayName: "Not Flagged", logoImage: null });
  eq(who.kind, "consumer", "photographer row without the flag is ignored (feed keys on authorType)");
}

console.log("consumer");
{
  const who = pickPublicIdentity({ ...baseUser, profileImageUrl: "https://cdn/c.jpg" });
  eq(who.publicName, "Jane Legal", "consumer → users.name (same as feed)");
  eq(who.avatarUrl, "https://cdn/c.jpg", "consumer → own photo");
  eq(who.kind, "consumer", "kind = consumer");
}
{
  const who = pickPublicIdentity({ ...baseUser, name: null, firstName: "  " });
  eq(who.publicName, "@janedoe", "no name → @username");
}
{
  const who = pickPublicIdentity({ ...baseUser, name: null, firstName: null, username: null as any });
  eq(who.publicName, "Outsyde member", "nothing at all → neutral label");
}
{
  const who = pickPublicIdentity({ ...baseUser, isVendor: true });
  eq(who.kind, "business", "vendor flag with no business row keeps old type value");
  eq(who.publicName, "Jane Legal", "and falls back to user name");
}
{
  const who: any = pickPublicIdentity({ ...baseUser, isVendor: true }, { id: "b1", name: "B", logoImage: null });
  eq(Object.keys(who).sort(), ["avatarUrl", "businessId", "kind", "photographerId", "publicName"], "never returns email/phone/last name");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
