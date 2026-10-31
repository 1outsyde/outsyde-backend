/**
 * p4-team step 9-0: Event team invite links (migration 092, Legend 2026-10-31 calls 66 to 71 and 67b).
 *
 * How a host invites someone who isn't on Outsyde yet. A link is for one person: a role, This event or All my events,
 * and for This event the pay the host set. Whoever signs in (or joins) and accepts first takes the spot as a normal
 * accepted team member, then the link stops working. This event links end when the event ends; All my events links
 * after 7 days. The host can cancel an open link.
 *
 * Email (67b): an email invite sends that person their own link. No account is ever matched by email, because
 * accounts don't verify their email. Phone = the host texts the link from their own phone (no text provider).
 *
 * Pure helpers here; the routes are in doorRouter.ts. Unit tests: teamLinks.test.ts; routes: teamLinks.http.test.ts.
 */
import { randomInt } from "crypto";
import { TEAM_ROLES, parseRoleLabel, type TeamRole } from "./teamRoles";
import { parsePay, type PaySetting } from "./teamPay";

/** No 0, 1, I or O, so a code read out loud or typed from a screenshot is never misread. Fits 092's [A-Z2-9]. */
export const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LINK_CODE_LENGTH = 12;
/** All my events links last this long (call 69). */
export const STANDING_LINK_DAYS = 7;

/** A new 12 character code (60 bits). `pick` is for tests; production uses crypto.randomInt. */
export function newLinkCode(pick: (n: number) => number = randomInt): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += LINK_ALPHABET[pick(LINK_ALPHABET.length)];
  return out;
}

/** A typed or pasted code, trimmed and uppercased, or null when it can't be one. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toUpperCase();
  return c.length === LINK_CODE_LENGTH && c.split("").every((ch) => LINK_ALPHABET.includes(ch)) ? c : null;
}

/** This event: when the event ends. All my events: 7 days after it was made. */
export function linkExpiry(scope: "standing" | "event", eventEndsAt: string | Date, now: Date = new Date()): Date {
  return scope === "event" ? new Date(eventEndsAt) : new Date(now.getTime() + STANDING_LINK_DAYS * 24 * 3600_000);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Trimmed and lowercased, or null when it isn't a plausible address (092 keeps it lowercase, up to 254). */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length >= 3 && e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export type LinkInput = {
  scope: "standing" | "event"; role: TeamRole; roleLabel: string | null; cohostLevel: "team" | "edit" | null;
  pay: PaySetting | null; email: string | null;
};

const LINK_KEYS = new Set(["scope", "role", "roleLabel", "cohostLevel", "pay", "email"]);

/** What a host can put on a link, with the same rules (and limits) as an invite by username and setting pay. */
export function parseLinkBody(body: unknown): { ok: true; value: LinkInput } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "body: expected an object." };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !LINK_KEYS.has(k));
  if (extra) return { ok: false, message: `${extra}: not a link field.` };
  if (b.scope !== "standing" && b.scope !== "event") return { ok: false, message: "scope: choose standing or event." };
  const scope = b.scope;
  if (typeof b.role !== "string" || !(TEAM_ROLES as readonly string[]).includes(b.role)) {
    return { ok: false, message: "role: choose door, security, host, entertainment, media, cohost or other." };
  }
  const role = b.role as TeamRole;
  const label = parseRoleLabel(role, b.roleLabel);
  if (!label.ok) return { ok: false, message: label.message };
  let cohostLevel: "team" | "edit" | null = null;
  if (b.cohostLevel !== undefined && b.cohostLevel !== null) {
    if (role !== "cohost") return { ok: false, message: "cohostLevel: only for co-hosts." };
    if (b.cohostLevel !== "team" && b.cohostLevel !== "edit") return { ok: false, message: "cohostLevel: choose team or edit." };
    cohostLevel = b.cohostLevel;
  } else if (role === "cohost") cohostLevel = "team";
  let pay: PaySetting | null = null;
  if (b.pay !== undefined && b.pay !== null) {
    if (role === "cohost") return { ok: false, message: "pay: co-hosts don't get team pay." };
    if (scope !== "event") return { ok: false, message: "pay: set pay for one event at a time. For All my events, set it on each event after they join." };
    const p = parsePay(role, b.pay);
    if (!p.ok) return { ok: false, message: `pay: ${p.message}` };
    pay = p.value;
  }
  let email: string | null = null;
  if (b.email !== undefined && b.email !== null && b.email !== "") {
    email = cleanEmail(b.email);
    if (!email) return { ok: false, message: "email: enter a full email address." };
  }
  return { ok: true, value: { scope, role, roleLabel: label.label, cohostLevel, pay, email } };
}

export type LinkStatus = "open" | "accepted" | "cancelled" | "expired";

/**
 * All my events: open until expires_at (7 days). This event: open until the event itself ends or is cancelled, read
 * from the event (e_ends_at) so a link follows the event when the host moves it. expires_at is only the fallback.
 */
export function linkStatus(r: { status: string; scope: string; expires_at: string | Date; e_status?: string | null; e_ends_at?: string | Date | null }, now: Date = new Date()): LinkStatus {
  if (r.status === "accepted") return "accepted";
  if (r.status === "cancelled") return "cancelled";
  if (r.scope === "event") {
    if (r.e_status === "cancelled") return "expired";
    const end = r.e_ends_at ?? r.expires_at;
    return new Date(end).getTime() <= now.getTime() ? "expired" : "open";
  }
  return new Date(r.expires_at).getTime() <= now.getTime() ? "expired" : "open";
}

/** When a link ends, as screens show it: the event's end for This event, else expires_at. */
export function linkEndsAt(r: { scope: string; expires_at: string | Date; e_ends_at?: string | Date | null }): Date {
  return new Date(r.scope === "event" && r.e_ends_at ? r.e_ends_at : r.expires_at);
}

/** goutsyde.com/team/CODE (call 70): opens the link page with quick sign up. */
export function linkUrl(code: string): string {
  const base = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || "https://www.goutsyde.com").replace(/\/+$/, "");
  return `${base}/team/${code}`;
}

/** The pay on a link, as the screens show it (commission as a percent). Null when none was set. */
export function linkPayJson(r: { pay_type: string | null; fixed_cents?: number | null; hourly_cents?: number | null; commission_bps?: number | null }) {
  if (!r.pay_type) return null;
  return {
    payType: r.pay_type as "none" | "fixed" | "hourly",
    fixedCents: r.fixed_cents ?? null,
    hourlyCents: r.hourly_cents ?? null,
    commissionPercent: r.commission_bps != null ? Number(r.commission_bps) / 100 : null,
  };
}
