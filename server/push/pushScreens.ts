/**
 * Admin push announcements: the app screens a push can open when tapped.
 *
 * Every key here must match services/announcementPush.ts in OutsydeCapture (which maps it to a
 * registered screen). The app checks the role again on tap and opens Activity when it doesn't fit,
 * so these rules only decide what the admin page offers for each audience.
 * Pure (no DB) so the rules are testable. Vault: Features/Notifications & Push.
 */
import type { PushAudience } from "./pushAudience";

/** Who a screen fits. "everyone" works for any signed in account. */
export type ScreenFit = "everyone" | "business" | "photographer" | "staff";

export interface PushScreen {
  key: string;
  label: string;
  fit: ScreenFit;
}

export const PUSH_SCREENS: readonly PushScreen[] = [
  { key: "activity", label: "Activity", fit: "everyone" },
  { key: "home", label: "Home", fit: "everyone" },
  { key: "events", label: "Events", fit: "everyone" },
  { key: "search", label: "Search", fit: "everyone" },
  { key: "messages", label: "Messages", fit: "everyone" },
  { key: "create_post", label: "Create a post", fit: "everyone" },
  { key: "account", label: "My account", fit: "everyone" },
  { key: "edit_profile", label: "Edit profile", fit: "everyone" },
  { key: "points", label: "Outsyde points", fit: "everyone" },
  { key: "settings", label: "Settings", fit: "everyone" },
  { key: "cart_bookings", label: "Cart and bookings", fit: "everyone" },
  { key: "favorites", label: "Favorites", fit: "everyone" },
  { key: "finish_setup", label: "Finish account setup", fit: "everyone" },
  { key: "business_dashboard", label: "Business dashboard", fit: "business" },
  { key: "business_bookings", label: "Business bookings", fit: "business" },
  { key: "business_orders", label: "Business orders", fit: "business" },
  { key: "analytics", label: "Analytics", fit: "business" },
  { key: "storefront", label: "Storefront editor", fit: "business" },
  { key: "subscription", label: "Subscription plan", fit: "business" },
  { key: "staff_management", label: "Staff management", fit: "business" },
  { key: "photographer_dashboard", label: "Photographer dashboard", fit: "photographer" },
  { key: "photographer_bookings", label: "Photographer bookings", fit: "photographer" },
  { key: "staff_dashboard", label: "Staff dashboard", fit: "staff" },
  { key: "link", label: "A goutsyde.com link", fit: "everyone" },
];

export const DEFAULT_SCREEN = "activity";
export const MAX_URL = 500;
const URL_HOSTS = new Set(["goutsyde.com", "www.goutsyde.com"]);

/** Audiences each fit may be sent to. Picked people can be anyone, so every fit allows it. */
const FIT_AUDIENCES: Record<ScreenFit, readonly PushAudience[]> = {
  everyone: ["picked", "vendors", "photographers", "consumers", "all"],
  business: ["picked", "vendors"],
  photographer: ["picked", "photographers"],
  staff: ["picked", "all"],
};

export function findScreen(key: string): PushScreen | undefined {
  return PUSH_SCREENS.find((s) => s.key === key);
}

export function screenFitsAudience(key: string, audience: PushAudience): boolean {
  const s = findScreen(key);
  return !!s && FIT_AUDIENCES[s.fit].includes(audience);
}

/** The screens offered for one audience, in list order. */
export function screensForAudience(audience: PushAudience): PushScreen[] {
  return PUSH_SCREENS.filter((s) => FIT_AUDIENCES[s.fit].includes(audience));
}

/** https on goutsyde.com or www.goutsyde.com only, no credentials, at most 500 characters. */
export function isAllowedPushUrl(raw: string): boolean {
  if (raw.length > MAX_URL) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === "https:" && URL_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password && !u.port;
}

/**
 * Checks { screen, url } for an audience. Returns the cleaned values or an error message.
 * No screen means Activity. A url is only allowed (and required) with the link screen.
 */
export function checkTarget(body: unknown, audience: PushAudience): { screen: string; url: string | null } | string {
  const b = (body ?? {}) as { screen?: unknown; url?: unknown };
  const screen = b.screen === undefined || b.screen === null || b.screen === "" ? DEFAULT_SCREEN : b.screen;
  if (typeof screen !== "string" || !findScreen(screen)) return "Pick a screen to open from the list.";
  if (!screenFitsAudience(screen, audience)) return "That screen doesn't fit who you're sending to. Pick another one.";
  const url = typeof b.url === "string" ? b.url.trim() : "";
  if (screen === "link") {
    if (!url) return "Add the goutsyde.com link to open.";
    if (!isAllowedPushUrl(url)) return "The link must start with https://goutsyde.com.";
    return { screen, url };
  }
  if (url) return "A link only works with the \"A goutsyde.com link\" screen.";
  return { screen, url: null };
}
