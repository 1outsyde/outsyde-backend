/**
 * Per-category push switches: which push types each switch controls. Pure, no DB.
 * Run with: npx tsx server/push/pushCategories.test.ts
 */
import assert from "node:assert/strict";
import { PUSH_CATEGORIES, pushAllowed, pushCategoryOf } from "./pushCategories";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`ok ${n} ${name}`); };

t("the four switches", () => {
  assert.deepEqual([...PUSH_CATEGORIES], ["bookings", "messages", "orders", "events"]);
});

t("every push type sent on main 0627047 lands where Legend decided (2026-11-10)", () => {
  const expected: Record<string, string | null> = {
    // bookings and quotes
    booking_confirmed: "bookings", new_booking: "bookings", booking_accepted: "bookings", booking_declined: "bookings",
    booking_canceled: "bookings", booking_request: "bookings", booking_request_sent: "bookings",
    booking_request_reminder: "bookings", booking_expired: "bookings", new_pending: "bookings",
    quote_extra: "bookings", quote_paid: "bookings", quote_card_failed: "bookings",
    // messages
    new_message: "messages",
    // orders
    refund_issued: "orders",
    // events
    ticket_sold: "events", event_reminder: "events", address_reveal: "events", event_payout_sent: "events",
    door_team_invite: "events", door_team_accepted: "events", team_invite: "events", team_accepted: "events",
    team_time_changed: "events", team_pay_changed: "events", team_stay_longer: "events",
    // always on
    account_setup: null, vendor_subscription: null, plan_offer: null, payment_failed: null, refund_owed: null,
    refund_taken_back: null, event_payout_owed: null, event_moderation: null, referral_reward: null,
    business_referral_reward: null, new_vendor_application: null, new_photographer_application: null,
    new_influencer_application: null, new_consumer_signup: null, card: null, announcement: null,
    subscription_activated: null, subscription_canceled: null, subscription_payment_failed: null,
  };
  for (const [type, cat] of Object.entries(expected)) assert.equal(pushCategoryOf(type), cat, type);
});

t("unknown, missing or odd types are always sent", () => {
  for (const v of ["something_new", "", undefined, null, 42, {}]) assert.equal(pushCategoryOf(v), null, String(v));
  assert.equal(pushAllowed("something_new", new Set(PUSH_CATEGORIES)), true);
  assert.equal(pushAllowed(undefined, new Set(PUSH_CATEGORIES)), true);
});

t("a turned off category mutes only its own types", () => {
  const off = new Set(["bookings"]);
  assert.equal(pushAllowed("booking_request", off), false);
  assert.equal(pushAllowed("quote_paid", off), false);
  assert.equal(pushAllowed("new_message", off), true);
  assert.equal(pushAllowed("refund_owed", off), true);
  assert.equal(pushAllowed("payment_failed", new Set(PUSH_CATEGORIES)), true);
  assert.equal(pushAllowed("booking_request", new Set()), true);
});

console.log(`\n${n} passed`);
