/**
 * Per-category push switches (Activity step 3a, Legend 2026-11-10). Migration 110.
 *
 * Every Expo push except announcements goes through sendExpoPush (expoPushService.ts), which asks
 * pushAllowedFor() first. A person who turned a category off in the app (Notification settings)
 * gets no push for it; the Activity row and any email still go out.
 *
 * Rules (Legend 2026-11-10):
 *  - Money, account and admin pushes are ALWAYS sent (not in any category).
 *  - Businesses and photographers may turn Bookings off too.
 *  - Followers has no switch until a follow push exists.
 *  - A type not listed here is ALWAYS sent, so nothing is silenced by mistake. When a new push
 *    type is added, put it in a category here if people should be able to turn it off
 *    (pushCategories.test.ts locks the list).
 * Announcements use push_news_optouts ("Outsyde news and offers"), not this file.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";

export const PUSH_CATEGORIES = ["bookings", "messages", "orders", "events"] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

const EXACT: Record<string, PushCategory> = {
  // Bookings and quotes
  booking_confirmed: "bookings",
  new_booking: "bookings",
  booking_accepted: "bookings",
  booking_declined: "bookings",
  booking_canceled: "bookings",
  booking_request: "bookings",
  booking_request_sent: "bookings",
  booking_request_reminder: "bookings",
  booking_expired: "bookings",
  new_pending: "bookings",
  // Messages (incl. event team chats, which push as new_message)
  new_message: "messages",
  // Orders and refunds
  refund_issued: "orders",
  order_confirmed: "orders",
  order_shipped: "orders",
  new_order: "orders",
  // Events and tickets
  ticket_sold: "events",
  event_reminder: "events",
  address_reveal: "events",
  event_payout_sent: "events",
  door_team_invite: "events",
  door_team_accepted: "events",
};

/** Types that are never muted even if a prefix below would match. */
const ALWAYS: ReadonlySet<string> = new Set([
  "account_setup",
  "vendor_subscription",
  "plan_offer",
  "payment_failed",
  "refund_owed",
  "refund_taken_back",
  "event_payout_owed",
  "event_moderation",
  "referral_reward",
  "business_referral_reward",
  "new_vendor_application",
  "new_photographer_application",
  "new_influencer_application",
  "new_consumer_signup",
  "card",
  "announcement",
]);

/** The switch that controls a push type, or null when it is always sent. */
export function pushCategoryOf(type: unknown): PushCategory | null {
  if (typeof type !== "string" || !type) return null;
  if (ALWAYS.has(type) || type.startsWith("subscription_")) return null;
  if (EXACT[type]) return EXACT[type];
  if (type.startsWith("quote_")) return "bookings";
  if (type.startsWith("team_")) return "events";
  return null;
}

/** Pure decision, for tests: allowed unless the type's category is in the person's turned off list. */
export function pushAllowed(type: unknown, turnedOff: ReadonlySet<string>): boolean {
  const c = pushCategoryOf(type);
  return c === null || !turnedOff.has(c);
}

export type CategoryPrefs = Record<PushCategory, boolean>;

export async function getCategoryPreferences(userId: string): Promise<CategoryPrefs> {
  const r = await db.execute(sql`SELECT category FROM push_category_optouts WHERE user_id = ${userId}`);
  const off = new Set((r.rows as { category: string }[]).map((x) => x.category));
  const out = {} as CategoryPrefs;
  for (const c of PUSH_CATEGORIES) out[c] = !off.has(c);
  return out;
}

/** Saves only the categories given; returns all of them after the save. */
export async function setCategoryPreferences(
  userId: string,
  changes: Partial<CategoryPrefs>,
): Promise<CategoryPrefs> {
  for (const c of PUSH_CATEGORIES) {
    const v = changes[c];
    if (v === true) {
      await db.execute(sql`DELETE FROM push_category_optouts WHERE user_id = ${userId} AND category = ${c}`);
    } else if (v === false) {
      await db.execute(sql`
        INSERT INTO push_category_optouts (user_id, category) VALUES (${userId}, ${c})
        ON CONFLICT (user_id, category) DO NOTHING`);
    }
  }
  return getCategoryPreferences(userId);
}

/**
 * Used by sendExpoPush. Always-on types skip the lookup. If the lookup fails the push is sent:
 * a missed booking push is worse than an unwanted one.
 */
export async function pushAllowedFor(userId: string, type: unknown): Promise<boolean> {
  const c = pushCategoryOf(type);
  if (c === null) return true;
  try {
    const r = await db.execute(
      sql`SELECT 1 FROM push_category_optouts WHERE user_id = ${userId} AND category = ${c} LIMIT 1`,
    );
    return r.rows.length === 0;
  } catch (err) {
    console.error("[PushCategories] lookup failed, sending anyway:", String((err as Error)?.message ?? err).slice(0, 200));
    return true;
  }
}
