/**
 * Host Agreement version 2026-10-30 (Legend 2026-10-30: calls 19 to 26, wording approved 5:50 PM). No database.
 * Run: npx tsx server/events/hostAgreementText.test.ts
 *
 * Checks the served text matches what the code does since p4-team 4b-1 (team pay, refunds stop at the payout,
 * end time locked, $0 payouts, reminders to hosts who owe) and stays inside the markdown the app and goutsyde.com
 * parse (app utils/host/agreementText.ts, web app/events/_host/AgreementText.tsx): "## " headings, paragraphs,
 * **bold**, "- " and "1. " lists, https links, backslash escapes.
 */
import { HOST_AGREEMENT_VERSION, HOST_AGREEMENT_TEXT } from "./hostAgreement";
import { HOST_AGREEMENT_MARKDOWN } from "./hostAgreementText";

let passed = 0, failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); }
}
const t = HOST_AGREEMENT_TEXT;
const section = (id: string) => {
  const i = t.indexOf(`\n${id} **`);
  if (i < 0) return "";
  const j = t.indexOf("\n\n", i + 2);
  return t.slice(i + 1, j < 0 ? undefined : j);
};

console.log("version");
ok(HOST_AGREEMENT_VERSION === "2026-10-30", "new version 2026-10-30 (every host accepts again before publishing)", HOST_AGREEMENT_VERSION);
ok(t.includes("Version: 2026-10-30."), "served text names the version");

console.log("definitions");
ok(!/Door Team/.test(t), "Door Team is now Event Team everywhere");
ok(/\*\*Event Team\*\*: people you add on the Platform to work your Event in a role/.test(t), "Event Team defined");
ok(/\*\*Team Pay\*\*: the pay you set on the Platform for a member of your Event Team under Section 8\.7\./.test(t), "Team Pay defined");
ok(/\*\*Host Earnings\*\*: the Ticket Price of valid, paid Tickets on completed orders, minus the Host Platform Fee\./.test(t), "Host Earnings no longer include amounts owed");
ok(/\*\*Payout\*\*: what is left of your Host Earnings[^\n]*It can be \$0\./.test(t), "Payout after debt and team pay, can be $0");

console.log("sections that match the code");
ok(/Once an Event has ended, its times can no longer change\./.test(section("4.1")), "4.1 end time locked once over");
const s54 = section("5.4");
ok(/Only you and your co-hosts see every member's pay\./.test(s54) && !/never sales or payouts/.test(s54), "5.4 who sees what", s54);
const s56 = section("5.6");
ok(/Taking someone off your Event Team/.test(s56) && /must choose a reason/.test(s56) && /can no longer change/.test(s56), "5.6 new: reasons, team locked once over", s56);
const s73 = section("7.3");
ok(/until your Payout for that Event is created, 3 days after it ends/.test(s73) && !/at any time/.test(s73), "7.3 refunds stop at the payout", s73);
ok(/A Payout of \$0 is recorded but not sent\./.test(section("8.3")), "8.3 $0 payout");
const s84 = section("8.4");
ok(/first any amount you owe Outsyde under Section 9 is taken back, then Team Pay under Section 8\.7 is paid, and the rest is your Payout/.test(s84), "8.4 order: owed, team, host", s84);
ok(/all Team Pay for it is held/.test(section("8.5")), "8.5 paused event holds team pay");
ok(/Team Pay/.test(section("8.6")), "8.6 summary shows team pay");
const s87 = section("8.7");
ok(/\*\*Team Pay\.\*\*/.test(s87) && /up to \$10,000 per role/.test(s87) && /Outsyde pays no Team Pay for that Event/.test(s87)
  && /has not completed payout setup with Stripe by the time your Payout is created/.test(s87) && /never taken back from them/.test(s87), "8.7 new: team pay, all or nothing, Stripe deadline, never taken back", s87);
const s91 = section("9.1");
ok(/neither you nor a Guest can refund an order on the Platform/.test(s91) && /never taken back from your Event Team/.test(s91) && /you may keep hosting/.test(s91), "9.1 rewritten", s91);
ok(/every 7 days while any amount is owed/.test(section("9.3")), "9.3 weekly reminders");
ok(/may suspend your ability to sell paid Tickets/.test(section("9.4")), "9.4 kept as Outsyde's option (call 24)");

console.log("format the app and website can show");
ok(!/[–—]/.test(t), "no en or em dashes");
ok(!/8\s?%/.test(t) && t.includes("keeps 2% of the Ticket Price"), "2% host fee stated, never the guest fee percentage");
const bad = t.split("\n").filter((l) => /^(#{3,}|#[^#]|> |\| |\* |\+ )/.test(l));
ok(bad.length === 0, "only ## headings, paragraphs and - / 1. lists", bad);
ok((t.match(/\*\*/g) ?? []).length % 2 === 0, "bold markers are balanced");
ok(t.startsWith("## 1. About This Agreement") && t.trimEnd().endsWith("understand it, and agree to it."), "full text, start to closing line");
ok(HOST_AGREEMENT_MARKDOWN.includes("\\[VERSION\\]") && HOST_AGREEMENT_MARKDOWN.includes("\\[EFFECTIVE DATE\\]"), "version filled when served; effective date stays a placeholder (call 26)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
