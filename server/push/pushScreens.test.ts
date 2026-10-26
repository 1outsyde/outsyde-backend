/**
 * Push tap screens: list, fit rules and link rules. Pure, no DB.
 * Run with: npx tsx server/push/pushScreens.test.ts
 */
import assert from "node:assert/strict";
import { PUSH_SCREENS, checkTarget, findScreen, isAllowedPushUrl, screenFitsAudience, screensForAudience, DEFAULT_SCREEN } from "./pushScreens";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`ok ${n} ${name}`); };

t("keys are unique and match the app map", () => {
  const keys = PUSH_SCREENS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, [
    "activity", "home", "events", "search", "messages", "create_post", "account", "edit_profile", "points", "settings",
    "cart_bookings", "favorites", "finish_setup", "business_dashboard", "business_bookings", "business_orders", "analytics",
    "storefront", "subscription", "staff_management", "photographer_dashboard", "photographer_bookings", "staff_dashboard", "link",
  ]);
  assert.equal(DEFAULT_SCREEN, "activity");
});

t("labels have no dashes", () => {
  for (const s of PUSH_SCREENS) assert.ok(!/[–—-]/.test(s.label), s.label);
});

t("everyone screens fit every audience", () => {
  for (const a of ["picked", "vendors", "photographers", "consumers", "all"] as const) {
    for (const k of ["activity", "home", "events", "edit_profile", "points", "link"]) assert.ok(screenFitsAudience(k, a), `${k} ${a}`);
  }
});

t("business screens only for vendors and picked", () => {
  for (const k of ["business_dashboard", "business_bookings", "business_orders", "analytics", "storefront", "subscription", "staff_management"]) {
    assert.ok(screenFitsAudience(k, "vendors"));
    assert.ok(screenFitsAudience(k, "picked"));
    assert.ok(!screenFitsAudience(k, "consumers"));
    assert.ok(!screenFitsAudience(k, "photographers"));
    assert.ok(!screenFitsAudience(k, "all"));
  }
});

t("photographer screens only for photographers and picked", () => {
  for (const k of ["photographer_dashboard", "photographer_bookings"]) {
    assert.ok(screenFitsAudience(k, "photographers"));
    assert.ok(screenFitsAudience(k, "picked"));
    assert.ok(!screenFitsAudience(k, "vendors"));
    assert.ok(!screenFitsAudience(k, "all"));
  }
});

t("staff dashboard only for all and picked", () => {
  assert.ok(screenFitsAudience("staff_dashboard", "all"));
  assert.ok(screenFitsAudience("staff_dashboard", "picked"));
  assert.ok(!screenFitsAudience("staff_dashboard", "vendors"));
  assert.ok(!screenFitsAudience("staff_dashboard", "consumers"));
});

t("unknown keys never fit", () => {
  assert.equal(findScreen("dashboard"), undefined);
  assert.ok(!screenFitsAudience("bookings", "all"));
});

t("screensForAudience counts", () => {
  assert.equal(screensForAudience("consumers").length, 14);
  assert.equal(screensForAudience("vendors").length, 21);
  assert.equal(screensForAudience("photographers").length, 16);
  assert.equal(screensForAudience("all").length, 15);
  assert.equal(screensForAudience("picked").length, 24);
});

t("link rules", () => {
  assert.ok(isAllowedPushUrl("https://goutsyde.com/events"));
  assert.ok(isAllowedPushUrl("https://www.goutsyde.com/partner-kit?x=1"));
  assert.ok(!isAllowedPushUrl("http://goutsyde.com/events"));
  assert.ok(!isAllowedPushUrl("https://goutsyde.com.evil.com/"));
  assert.ok(!isAllowedPushUrl("https://evil.com/goutsyde.com"));
  assert.ok(!isAllowedPushUrl("https://user:pw@goutsyde.com/"));
  assert.ok(!isAllowedPushUrl("https://goutsyde.com:8443/"));
  assert.ok(!isAllowedPushUrl("javascript:alert(1)"));
  assert.ok(!isAllowedPushUrl(`https://goutsyde.com/${"a".repeat(500)}`));
});

t("checkTarget", () => {
  assert.deepEqual(checkTarget({}, "all"), { screen: "activity", url: null });
  assert.deepEqual(checkTarget({ screen: "events" }, "consumers"), { screen: "events", url: null });
  assert.equal(typeof checkTarget({ screen: "business_dashboard" }, "consumers"), "string");
  assert.equal(typeof checkTarget({ screen: "nope" }, "all"), "string");
  assert.equal(typeof checkTarget({ screen: "link" }, "all"), "string");
  assert.equal(typeof checkTarget({ screen: "link", url: "https://evil.com" }, "all"), "string");
  assert.deepEqual(checkTarget({ screen: "link", url: " https://goutsyde.com/events " }, "all"), { screen: "link", url: "https://goutsyde.com/events" });
  assert.equal(typeof checkTarget({ screen: "home", url: "https://goutsyde.com/" }, "all"), "string");
});

console.log(`\n${n} passed`);
