/**
 * p4-team step 4a: Event team pay (migration 086). What the host sets and what it adds up to. No money moves here;
 * step 4b pays it out of the host's payout 3 days after the event.
 *
 * Rules (Legend 2026-10-29 / 2026-10-30):
 *   - Pay per person per role: no pay, fixed, or hourly. Hourly = exact hours of the shift the host set x the rate
 *     (4.5 h x $50 = $225); no shift times = $0 until they're set.
 *   - Commission for Promoters (role 'host') and Entertainment (DJs, performers, MCs): a percent of the ticket price
 *     of paid tickets sold through their own link (valid tickets on completed orders, the host summary's rule).
 *   - Limits: fixed up to $10,000 per role, hourly up to $1,000 an hour, commission 1% to 50% (two decimals at most).
 *   - All or nothing: if the team is owed more than the host's earnings (ticket price minus Outsyde's fee, refunds
 *     out), Outsyde pays the team $0 and the host keeps everything. A free event can't cover any pay.
 *   - Only accepted, not removed team members count. A pending invite shows the pay offered but adds nothing.
 *   - Each person sees only their own pay; the host and co-hosts see everyone's.
 */
import { sql } from "drizzle-orm";

/** Roles that get a link and can earn commission. */
export const LINK_ROLES: readonly string[] = ["host", "entertainment"];

export const PAY_LIMITS = { fixedMaxCents: 1_000_000, hourlyMaxCents: 100_000, commissionMinBps: 100, commissionMaxBps: 5000 };

export type PayType = "none" | "fixed" | "hourly";
export type PaySetting = { payType: PayType; fixedCents: number | null; hourlyCents: number | null; commissionBps: number | null };
export type Shift = { startsAt: string | Date | null; endsAt: string | Date | null } | null;

export type RolePay = {
  payType: PayType;
  fixedCents: number;
  hourlyRateCents: number | null;
  hours: number | null;
  hourlyCents: number;
  commissionPercent: number | null;
  commissionCents: number;
  totalCents: number;
  needsShift: boolean;
};

/** Hours to two decimals, for showing (the pay itself uses the exact length). */
const hoursShown = (ms: number) => Math.round((ms / 3600000) * 100) / 100;

/** What one role pays, from its setting, its shift and the ticket price sold through the person's link. */
export function computeRolePay(p: PaySetting, shift: Shift, linkSalesCents: number): RolePay {
  const fixedCents = p.payType === "fixed" ? Number(p.fixedCents ?? 0) : 0;
  let hours: number | null = null;
  let hourlyCents = 0;
  let needsShift = false;
  if (p.payType === "hourly") {
    const start = shift?.startsAt ? new Date(shift.startsAt).getTime() : NaN;
    const end = shift?.endsAt ? new Date(shift.endsAt).getTime() : NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      hours = hoursShown(end - start);
      hourlyCents = Math.round(((end - start) * Number(p.hourlyCents ?? 0)) / 3600000);
    } else {
      needsShift = true;
    }
  }
  const commissionCents = p.commissionBps ? Math.round((Math.max(0, linkSalesCents) * p.commissionBps) / 10000) : 0;
  return {
    payType: p.payType, fixedCents,
    hourlyRateCents: p.payType === "hourly" ? Number(p.hourlyCents ?? 0) : null,
    hours, hourlyCents,
    commissionPercent: p.commissionBps ? p.commissionBps / 100 : null,
    commissionCents,
    totalCents: fixedCents + hourlyCents + commissionCents,
    needsShift,
  };
}

/** All or nothing: whether Outsyde can pay the team out of the host's earnings, and what each side gets. */
export function coverage(teamTotalCents: number, hostEarningsCents: number): { covered: boolean; teamPaidCents: number; hostTakeHomeCents: number } {
  const earnings = Math.max(0, hostEarningsCents);
  const covered = teamTotalCents <= earnings;
  return covered
    ? { covered: true, teamPaidCents: teamTotalCents, hostTakeHomeCents: earnings - teamTotalCents }
    : { covered: false, teamPaidCents: 0, hostTakeHomeCents: earnings };
}

const PAY_KEYS = new Set(["payType", "fixedCents", "hourlyCents", "commissionPercent"]);
const isWholeCents = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;

/** Validates what the host sends. Commission percent may have at most two decimals (12.5% = 1250 bps). */
export function parsePay(role: string, body: unknown): { ok: true; value: PaySetting } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "body: expected an object." };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !PAY_KEYS.has(k));
  if (extra) return { ok: false, message: `${extra}: not a pay field.` };
  const payType = b.payType;
  if (payType !== "none" && payType !== "fixed" && payType !== "hourly") return { ok: false, message: "payType: choose none, fixed or hourly." };
  const has = (k: string) => b[k] !== undefined && b[k] !== null;
  let fixedCents: number | null = null;
  let hourlyCents: number | null = null;
  if (payType === "fixed") {
    if (!isWholeCents(b.fixedCents, PAY_LIMITS.fixedMaxCents)) return { ok: false, message: "fixedCents: whole cents from 1 up to $10,000." };
    fixedCents = b.fixedCents;
  } else if (has("fixedCents")) return { ok: false, message: "fixedCents: only with fixed pay." };
  if (payType === "hourly") {
    if (!isWholeCents(b.hourlyCents, PAY_LIMITS.hourlyMaxCents)) return { ok: false, message: "hourlyCents: whole cents from 1 up to $1,000 an hour." };
    hourlyCents = b.hourlyCents;
  } else if (has("hourlyCents")) return { ok: false, message: "hourlyCents: only with hourly pay." };
  let commissionBps: number | null = null;
  if (has("commissionPercent")) {
    if (!LINK_ROLES.includes(role)) return { ok: false, message: "commissionPercent: only Promoters and Entertainment earn commission." };
    const pct = b.commissionPercent;
    const bps = typeof pct === "number" ? Math.round(pct * 100) : NaN;
    if (typeof pct !== "number" || !Number.isFinite(pct) || Math.abs(bps - pct * 100) > 1e-6
        || bps < PAY_LIMITS.commissionMinBps || bps > PAY_LIMITS.commissionMaxBps) {
      return { ok: false, message: "commissionPercent: from 1 to 50, at most two decimals." };
    }
    commissionBps = bps;
  }
  return { ok: true, value: { payType, fixedCents, hourlyCents, commissionBps } };
}

/** One event_team_pay row as a setting. */
export const settingOf = (r: any): PaySetting => ({
  payType: (r?.pay_type ?? "none") as PayType,
  fixedCents: r?.fixed_cents ?? null, hourlyCents: r?.hourly_cents ?? null, commissionBps: r?.commission_bps ?? null,
});
const NO_PAY: PaySetting = { payType: "none", fixedCents: null, hourlyCents: null, commissionBps: null };

export type EventPay = {
  /** "memberId:role" -> that role's pay (every pay row, pending invites included). */
  byRole: Map<string, RolePay>;
  /** Accepted, not removed people only. */
  members: Array<{ userId: string; username: string | null; firstName: string | null; totalCents: number; needsShift: boolean }>;
  teamTotalCents: number;
  hostEarningsCents: number;
} & ReturnType<typeof coverage>;

/**
 * Everyone's pay at this event with what it adds up to. Shifts come from event_team_schedules, link sales from the
 * promoter link counts. Team members are accepted, not removed rows of this event or the host's standing team.
 */
export async function eventPay(event: { id: string; host_user_id: string }): Promise<EventPay> {
  const eventId = String(event.id);
  // Loaded here so the pure helpers above stay importable without a database (teamPay.test.ts).
  const { rows } = await import("./eventsRouter");
  const { promoterLinkStats } = await import("./promoterLinks");
  const [pays, shifts, active, links, earned] = await Promise.all([
    rows<any>(sql`SELECT member_user_id, role, pay_type, fixed_cents, hourly_cents, commission_bps FROM event_team_pay WHERE event_id = ${eventId}`),
    rows<any>(sql`SELECT member_user_id, role, starts_at, ends_at FROM event_team_schedules WHERE event_id = ${eventId}`),
    rows<any>(sql`
      SELECT a.member_user_id AS member_id, a.role AS member_role, u.username AS member_username, u.first_name AS member_first_name
      FROM (
        SELECT m.member_user_id, m.role FROM event_door_members m
        WHERE m.event_id = ${eventId} AND m.removed_at IS NULL AND m.accepted_at IS NOT NULL
        UNION
        SELECT t.member_user_id, t.role FROM event_door_team t
        WHERE t.host_user_id = ${event.host_user_id} AND t.removed_at IS NULL AND t.accepted_at IS NOT NULL
      ) a JOIN users u ON u.id = a.member_user_id`),
    promoterLinkStats(eventId),
    rows<any>(sql`
      SELECT COALESCE(sum(t.host_net_cents), 0)::int AS host_net FROM tickets t JOIN ticket_orders o ON o.id = t.order_id
      WHERE t.event_id = ${eventId} AND t.status = 'valid' AND o.status = 'completed'`),
  ]);
  const shiftOf = new Map(shifts.map((s) => [`${s.member_user_id}:${s.role}`, { startsAt: s.starts_at, endsAt: s.ends_at }]));
  const salesOf = new Map(links.map((l) => [l.userId, l.salesCents]));
  const settingFor = new Map(pays.map((p) => [`${p.member_user_id}:${p.role}`, settingOf(p)]));
  // One link per person per event, so its sales earn commission once: the first link role with a commission gets them
  // (the pay route also refuses a second one, COMMISSION_ON_OTHER_ROLE).
  const commissionRoleOf = new Map<string, string>();
  for (const role of LINK_ROLES) {
    for (const p of pays) {
      if (p.role === role && p.commission_bps && !commissionRoleOf.has(String(p.member_user_id))) commissionRoleOf.set(String(p.member_user_id), role);
    }
  }
  const byRole = new Map<string, RolePay>();
  const keys = new Set<string>(Array.from(settingFor.keys()).concat(active.map((a) => `${a.member_id}:${a.member_role}`)));
  for (const key of Array.from(keys)) {
    const [memberId, role] = key.split(":");
    const setting = settingFor.get(key) ?? NO_PAY;
    const sales = commissionRoleOf.get(memberId) === role ? salesOf.get(memberId) ?? 0 : 0;
    byRole.set(key, computeRolePay(setting, shiftOf.get(key) ?? null, sales));
  }
  const people = new Map<string, { userId: string; username: string | null; firstName: string | null; totalCents: number; needsShift: boolean; hasPay: boolean }>();
  for (const a of active) {
    const id = String(a.member_id);
    const key = `${id}:${a.member_role}`;
    const person = people.get(id) ?? { userId: id, username: a.member_username ?? null, firstName: a.member_first_name ?? null, totalCents: 0, needsShift: false, hasPay: false };
    const rp = byRole.get(key);
    const s = settingFor.get(key);
    person.totalCents += rp?.totalCents ?? 0;
    person.needsShift = person.needsShift || !!rp?.needsShift;
    person.hasPay = person.hasPay || (!!s && (s.payType !== "none" || !!s.commissionBps));
    people.set(id, person);
  }
  // Everyone the host has set pay for (a $0 hourly still waiting for a shift too), not people with no pay at all.
  const members = Array.from(people.values()).filter((m) => m.hasPay).map(({ hasPay: _h, ...m }) => m);
  const teamTotalCents = members.reduce((n, m) => n + m.totalCents, 0);
  const hostEarningsCents = Number(earned[0]?.host_net ?? 0);
  return { byRole, members, teamTotalCents, hostEarningsCents, ...coverage(teamTotalCents, hostEarningsCents) };
}

/** A role's pay as JSON (one shape everywhere). */
export function rolePayJson(p: RolePay | undefined) {
  const r = p ?? computeRolePay(NO_PAY, null, 0);
  return {
    payType: r.payType,
    fixedCents: r.payType === "fixed" ? r.fixedCents : null,
    hourlyRateCents: r.hourlyRateCents,
    hours: r.hours,
    hourlyCents: r.payType === "hourly" ? r.hourlyCents : null,
    commissionPercent: r.commissionPercent,
    commissionCents: r.commissionPercent ? r.commissionCents : null,
    earnedCents: r.totalCents,
    needsShift: r.needsShift,
  };
}
