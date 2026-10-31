/**
 * p4-team step 7 (migration 091): the host asks a team member to stay longer. Legend decision 12 (canvas 55 to 57) and
 * calls 41 to 48 (2026-10-30, call 45 changed at 11:35 PM):
 *   41 Admissions, Security, Entertainment, Media, Other can be asked; never Promoters (role 'host') or co-hosts.
 *   42 Only the host asks (co-hosts and members get 404, like other host only screens).
 *   43 Hourly members: At their hourly rate (default on the screens), No extra pay or To be discussed, never a Fixed
 *      amount on top of hourly pay. Everyone else: Fixed, No extra pay or To be discussed.
 *   44 From the event start until their current end. One open request per person; again once it's answered.
 *   45 Open until the later of their current end and 30 minutes after it was sent. Accepting in that time still
 *      counts from the end it was asked from. Then it expires and the host is told.
 *   46 30 minutes to 6 hours a request, ending no later than 12 hours after the event ends; Fixed up to $1,000; the
 *      role's fixed or hourly pay plus extras stays within $10,000.
 *   47 To be discussed: the host enters the amount until the payout is worked out (3 days after the event), with a
 *      push the morning after the event and the day before payout day. Not entered = $0.
 *   48 Accept moves their end time and adds the extra to their pay (teamPay.ts eventPay); decline changes nothing.
 *      The host is told either way.
 * Nothing here changes event_team_schedules: their current end is the latest accepted new end, else their shift end,
 * else the event end.
 */
import { sql } from "drizzle-orm";

export const STAY_LONGER_ROLES: readonly string[] = ["door", "security", "entertainment", "media", "other"];
export const STAY_LIMITS = { minMinutes: 30, maxMinutes: 360, fixedMaxCents: 100_000, openAtLeastMs: 30 * 60_000, afterEventMs: 12 * 3600_000 };
/** The payout is worked out 3 days after the event ends (eventPayouts.ts). */
const PAYOUT_AFTER_MS = 3 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

export type PayKind = "fixed" | "none" | "tbd" | "hourly";
export type AskBody = { minutes: number | null; endAt: Date | null; pay: PayKind; fixedCents: number | null };

// ─── Pure rules (tested in teamExtensionRules.test.ts) ──────────────────────

/** "30 more minutes", "1 more hour", "1 more hour and 30 minutes", "2 more hours". */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} more minutes`;
  const hours = `${h} more ${h === 1 ? "hour" : "hours"}`;
  return m ? `${hours} and ${m} minutes` : hours;
}

/** "$50.00", "$1,000.00". */
export const moneyText = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const zoneOf = (tz: string | null | undefined) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }).format(0); return String(tz); } catch { return "America/New_York"; }
};
export const clockText = (d: Date, tz: string | null | undefined) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zoneOf(tz), hour: "numeric", minute: "2-digit" }).format(d);
const dayClockText = (d: Date, tz: string | null | undefined) =>
  `${new Intl.DateTimeFormat("en-US", { timeZone: zoneOf(tz), weekday: "long" }).format(d)} at ${clockText(d, tz)}`;

/** What the extra pay reads as in the member's push: "$50.00 extra", "no extra pay", ... */
export function payText(kind: PayKind, fixedCents: number | null): string {
  if (kind === "fixed") return `${moneyText(Number(fixedCents ?? 0))} extra`;
  if (kind === "hourly") return "paid at your hourly rate";
  if (kind === "tbd") return "extra pay to be discussed";
  return "no extra pay";
}

/** Call 45: open until the later of their current end and 30 minutes after it was sent. */
export const expiryFor = (currentEnd: Date, sentAt: Date) =>
  new Date(Math.max(currentEnd.getTime(), sentAt.getTime() + STAY_LIMITS.openAtLeastMs));

/** Validates what the host sends: { minutes } or { endAt }, a pay choice, and an amount only with Fixed. */
export function parseAsk(body: unknown): { ok: true; value: AskBody } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "body: expected an object." };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !["minutes", "endAt", "pay", "fixedCents"].includes(k));
  if (extra) return { ok: false, message: `${extra}: not a stay longer field.` };
  const has = (k: string) => b[k] !== undefined && b[k] !== null;
  if (has("minutes") === has("endAt")) return { ok: false, message: "Send minutes or endAt, one of them." };
  let minutes: number | null = null;
  let endAt: Date | null = null;
  if (has("minutes")) {
    if (typeof b.minutes !== "number" || !Number.isInteger(b.minutes)) return { ok: false, message: "minutes: a whole number of minutes." };
    minutes = b.minutes;
  } else {
    endAt = typeof b.endAt === "string" ? new Date(b.endAt) : new Date(NaN);
    if (!Number.isFinite(endAt.getTime())) return { ok: false, message: "endAt: a date and time." };
  }
  const pay = b.pay;
  if (pay !== "fixed" && pay !== "none" && pay !== "tbd" && pay !== "hourly") return { ok: false, message: "pay: choose fixed, none, tbd or hourly." };
  let fixedCents: number | null = null;
  if (pay === "fixed") {
    const c = b.fixedCents;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > STAY_LIMITS.fixedMaxCents) return { ok: false, message: "fixedCents: whole cents from 1 up to $1,000." };
    fixedCents = c;
  } else if (has("fixedCents")) return { ok: false, message: "fixedCents: only with a Fixed amount." };
  return { ok: true, value: { minutes, endAt, pay, fixedCents } };
}

/** The 10:00 AM (event time) at least 4 hours after the end: the "morning after" reminder (call 47). */
export function morningAfter(endsAt: Date, tz: string | null | undefined): Date {
  const zone = zoneOf(tz);
  const from = new Date(endsAt.getTime() + 4 * 3600_000);
  for (let add = 0; add < 3; add++) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(from.getTime() + add * DAY_MS));
    const at = atLocal(day, 10, zone);
    if (at.getTime() >= from.getTime()) return at;
  }
  return new Date(from.getTime() + DAY_MS);
}

/** "YYYY-MM-DD" at `hour`:00 in `zone`, as a moment. */
function atLocal(day: string, hour: number, zone: string): Date {
  const [y, mo, d] = day.split("-").map(Number);
  let guess = Date.UTC(y, mo - 1, d, hour);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    guess += Date.UTC(y, mo - 1, d, hour) - shown;
  }
  return new Date(guess);
}

/** Call 47: which To be discussed reminder is due now ("eve" = the day before payout day wins over a late morning one). */
export function amountReminderDue(endsAt: Date, tz: string | null | undefined, now: Date, sent: { morning: boolean; eve: boolean }): "morning" | "eve" | null {
  const payoutAt = endsAt.getTime() + PAYOUT_AFTER_MS;
  if (now.getTime() >= payoutAt) return null;
  if (now.getTime() >= payoutAt - DAY_MS) return sent.eve ? null : "eve";
  if (now.getTime() >= morningAfter(endsAt, tz).getTime()) return sent.morning ? null : "morning";
  return null;
}

// ─── Database ───────────────────────────────────────────────────────────────

type Fail = { ok: false; status: number; code: string; message: string };
const no = (status: number, code: string, message: string): Fail => ({ ok: false, status, code, message });
const isoOf = (d: any) => (d ? new Date(d).toISOString() : null);

export function requestJson(r: any) {
  return {
    id: String(r.id), eventId: String(r.event_id), memberUserId: String(r.member_user_id), role: r.role,
    extraMinutes: Number(r.extra_minutes), fromEndAt: isoOf(r.from_end_at), newEndAt: isoOf(r.new_end_at),
    payKind: r.pay_kind as PayKind, fixedCents: r.fixed_cents ?? null, finalCents: r.final_cents ?? null,
    status: r.status, expiresAt: isoOf(r.expires_at), answeredAt: isoOf(r.answered_at), createdAt: isoOf(r.created_at),
  };
}

async function db() {
  const { rows, hostIdentity } = await import("./eventsRouter");
  const { noticeDeps } = await import("./ticketNotices");
  return { rows, hostIdentity, noticeDeps };
}

const personName = (u: { first_name?: string | null; username?: string | null } | undefined) =>
  (u?.first_name && String(u.first_name).trim()) || (u?.username ? `@${u.username}` : "Someone");

/** Their current end in this role: the latest accepted new end, else their shift end, else the event end. */
export async function currentEnd(event: { id: string; ends_at: any }, memberId: string, role: string): Promise<Date> {
  const { rows } = await db();
  const [r] = await rows<any>(sql`
    SELECT (SELECT max(new_end_at) FROM event_team_extensions WHERE event_id = ${event.id} AND member_user_id = ${memberId} AND role = ${role} AND status = 'accepted') AS accepted_end,
           (SELECT ends_at FROM event_team_schedules WHERE event_id = ${event.id} AND member_user_id = ${memberId} AND role = ${role}) AS shift_end`);
  return new Date(r?.accepted_end ?? r?.shift_end ?? event.ends_at);
}

/** Push + Activity. Never throws. */
async function tell(userId: string, copy: { title: string; body: string }, data: Record<string, unknown>, activity: { message: string; eventId: string; by: string | null } | null) {
  try {
    const { noticeDeps } = await db();
    const d = await noticeDeps();
    await d.sendPush({ userId, title: copy.title, body: copy.body, data });
    if (activity && d.createActivity) {
      await d.createActivity({
        userId, type: String(data.type), title: copy.title, message: activity.message, referenceType: "event", referenceId: activity.eventId,
        metadata: { ...data, eventId: activity.eventId }, triggeredByUserId: activity.by,
      });
    }
  } catch (err) {
    console.error(`[StayLonger] notice failed for ${userId}:`, (err as Error)?.message ?? err);
  }
}

/**
 * The host asks. `event` is the host's event (doorRouter teamManager, host only); `isOnTeam` checks the member is
 * accepted in this role. Returns the new request or why not.
 */
export async function askStayLonger(p: { event: any; hostUserId: string; memberId: string; role: string; body: unknown; isOnTeam: () => Promise<boolean>; now?: Date }):
  Promise<{ ok: true; request: ReturnType<typeof requestJson> } | Fail> {
  const { rows, hostIdentity } = await db();
  const parsed = parseAsk(p.body);
  if (!parsed.ok) return no(400, "INVALID_REQUEST", parsed.message);
  const b = parsed.value;
  const e = p.event;
  const now = p.now ?? new Date();
  if (!STAY_LONGER_ROLES.includes(p.role)) return no(409, "CANT_STAY_LONGER", "Promoters and co-hosts can't be asked to stay longer.");
  if (e.status === "cancelled") return no(409, "EVENT_ENDED", "This event was cancelled.");
  if (!(await p.isOnTeam())) return no(404, "NOT_ON_TEAM", "That person isn't on your Event team in that role.");
  if (now.getTime() < new Date(e.starts_at).getTime()) return no(409, "NOT_STARTED", "You can ask once the event starts.");
  const from = await currentEnd(e, p.memberId, p.role);
  if (from.getTime() <= now.getTime()) return no(409, "SHIFT_OVER", "Their time is already over.");
  const [setting] = await rows<any>(sql`SELECT pay_type, hourly_cents FROM event_team_pay WHERE event_id = ${e.id} AND member_user_id = ${p.memberId} AND role = ${p.role}`);
  const hourly = setting?.pay_type === "hourly";
  if (hourly && b.pay === "fixed") return no(400, "FIXED_ON_HOURLY", "They're paid hourly: choose At their hourly rate, No extra pay or To be discussed.");
  if (!hourly && b.pay === "hourly") return no(400, "NOT_HOURLY", "At their hourly rate is only for people paid hourly.");
  const minutes = b.minutes ?? Math.round((b.endAt!.getTime() - from.getTime()) / 60_000);
  const newEnd = new Date(from.getTime() + minutes * 60_000);
  if (newEnd.getTime() > new Date(e.ends_at).getTime() + STAY_LIMITS.afterEventMs) {
    return no(400, "TOO_LATE", "It has to end no later than 12 hours after the event ends.");
  }
  if (minutes < STAY_LIMITS.minMinutes || minutes > STAY_LIMITS.maxMinutes) return no(400, "INVALID_REQUEST", "Ask for 30 minutes up to 6 hours.");
  // The role's fixed or hourly pay with its extras stays within $10,000 (call 46).
  const { eventPay, HOURLY_ROLE_CAP_CENTS } = await import("./teamPay");
  const rp = (await eventPay(e)).byRole.get(`${p.memberId}:${p.role}`);
  const adds = b.pay === "fixed" ? Number(b.fixedCents) : b.pay === "hourly" ? Math.round((Number(setting?.hourly_cents ?? 0) * minutes) / 60) : 0;
  const so_far = (rp?.fixedCents ?? 0) + (rp?.hourlyCents ?? 0) + (rp?.extraCents ?? 0);
  if (adds > 0 && so_far + adds > HOURLY_ROLE_CAP_CENTS) {
    return no(409, "OVER_ROLE_CAP", `That would take their pay for this role past $10,000. They can get up to ${moneyText(Math.max(0, HOURLY_ROLE_CAP_CENTS - so_far))} more.`);
  }
  const [open] = await rows<any>(sql`SELECT 1 AS x FROM event_team_extensions WHERE event_id = ${e.id} AND member_user_id = ${p.memberId} AND status = 'open'`);
  if (open) return no(409, "REQUEST_OPEN", "You already asked them. Wait for their answer.");
  let saved: any;
  try {
    [saved] = await rows<any>(sql`
      INSERT INTO event_team_extensions (event_id, member_user_id, role, requested_by_user_id, extra_minutes, from_end_at, new_end_at, pay_kind, fixed_cents, expires_at)
      VALUES (${e.id}, ${p.memberId}, ${p.role}, ${p.hostUserId}, ${minutes}, ${from.toISOString()}::timestamptz,
        ${from.toISOString()}::timestamptz + make_interval(mins => ${minutes}::int), ${b.pay}, ${b.fixedCents}, ${expiryFor(from, now).toISOString()}::timestamptz)
      RETURNING *`);
  } catch (err: any) {
    if ((err?.code ?? err?.cause?.code) === "23505") return no(409, "REQUEST_OPEN", "You already asked them. Wait for their answer.");
    throw err;
  }
  // The full row: loadEventForDoor leaves out the business or photographer a host can post as.
  const [full] = await rows<any>(sql`SELECT * FROM events WHERE id = ${e.id}`);
  const host = (await hostIdentity(full ?? e)).publicName;
  const copy = {
    title: `${host} asked you to stay ${durationText(minutes)}`,
    body: `Until ${clockText(new Date(saved.new_end_at), e.timezone)}, ${payText(b.pay, b.fixedCents)}. Tap to accept or decline.`,
  };
  await tell(p.memberId, copy, { type: "team_stay_longer", eventId: String(e.id), requestId: String(saved.id) },
    { message: `${String(e.title)}: until ${clockText(new Date(saved.new_end_at), e.timezone)}, ${payText(b.pay, b.fixedCents)}. Waiting for your answer.`, eventId: String(e.id), by: p.hostUserId });
  return { ok: true, request: requestJson(saved) };
}

/** The member answers their own open request, in time and still on the team. */
export async function answerStayLonger(p: { eventId: string; userId: string; requestId: string; answer: "accept" | "decline"; isOnTeam: (event: any, role: string) => Promise<boolean> }):
  Promise<{ ok: true; request: ReturnType<typeof requestJson> } | Fail> {
  const { rows, noticeDeps: _n } = await db();
  const [x] = await rows<any>(sql`
    SELECT x.*, e.title, e.timezone, e.host_user_id, e.status AS event_status FROM event_team_extensions x JOIN events e ON e.id = x.event_id
    WHERE x.id = ${p.requestId} AND x.event_id = ${p.eventId} AND x.member_user_id = ${p.userId}`);
  if (!x) return no(404, "NOT_FOUND", "Request not found.");
  if (x.status !== "open") return no(409, "ALREADY_ANSWERED", "You already answered this.");
  if (new Date(x.expires_at).getTime() < Date.now()) return no(409, "EXPIRED", "This request expired.");
  if (x.event_status === "cancelled" || !(await p.isOnTeam({ id: x.event_id, host_user_id: x.host_user_id }, x.role))) {
    return no(409, "NOT_ON_TEAM", "You're no longer on this Event team.");
  }
  const status = p.answer === "accept" ? "accepted" : "declined";
  // Decided in the update itself, so a double tap or a late tap can't answer twice or answer after it expired.
  const [saved] = await rows<any>(sql`
    UPDATE event_team_extensions SET status = ${status}, answered_at = now(), updated_at = now()
    WHERE id = ${p.requestId} AND status = 'open' AND expires_at >= now() RETURNING *`);
  if (!saved) {
    const [now] = await rows<any>(sql`SELECT status FROM event_team_extensions WHERE id = ${p.requestId}`);
    return now?.status === "open" ? no(409, "EXPIRED", "This request expired.") : no(409, "ALREADY_ANSWERED", "You already answered this.");
  }
  void (async () => {
    const [u] = await rows<any>(sql`SELECT first_name, username FROM users WHERE id = ${p.userId}`);
    const name = personName(u);
    const until = clockText(new Date(saved.new_end_at), x.timezone);
    const copy = status === "accepted"
      ? { title: `${name} will stay ${durationText(Number(saved.extra_minutes))}`, body: `Until ${until} at ${String(x.title)}.` }
      : { title: `${name} can't stay longer`, body: `Their time at ${String(x.title)} stays the same.` };
    await tell(String(x.host_user_id), copy, { type: "team_stay_longer_answer", eventId: String(x.event_id), requestId: String(saved.id), answer: status }, null);
    if (status === "accepted" && (saved.pay_kind === "fixed" || saved.pay_kind === "hourly")) {
      const { notifySetupForExtra } = await import("./teamSend");
      await notifySetupForExtra({ eventId: String(x.event_id), memberUserId: p.userId, hostUserId: String(x.host_user_id) });
    }
  })().catch(() => {});
  return { ok: true, request: requestJson(saved) };
}

/** Call 47: the host enters the To be discussed amount, until the payout is worked out. */
export async function setStayLongerAmount(p: { event: any; requestId: string; body: unknown }): Promise<{ ok: true; request: ReturnType<typeof requestJson> } | Fail> {
  const { rows } = await db();
  const b = p.body as any;
  if (!b || typeof b !== "object" || Object.keys(b).some((k) => k !== "cents")) return no(400, "INVALID_REQUEST", "Send { cents }.");
  const cents = b.cents;
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents < 0 || cents > STAY_LIMITS.fixedMaxCents) {
    return no(400, "INVALID_REQUEST", "cents: whole cents from $0 up to $1,000.");
  }
  const [x] = await rows<any>(sql`SELECT * FROM event_team_extensions WHERE id = ${p.requestId} AND event_id = ${p.event.id}`);
  if (!x) return no(404, "NOT_FOUND", "Request not found.");
  if (x.pay_kind !== "tbd") return no(409, "NOT_TBD", "Only To be discussed pay is entered later.");
  if (x.status !== "accepted") return no(409, "NOT_ACCEPTED", "They haven't accepted this request.");
  const [ev] = await rows<any>(sql`SELECT team_pay_fixed_at, ends_at FROM events WHERE id = ${p.event.id}`);
  if (ev?.team_pay_fixed_at || Date.now() >= new Date(ev?.ends_at ?? p.event.ends_at).getTime() + PAYOUT_AFTER_MS) {
    return no(409, "PAY_FIXED", "The payout is already worked out, so this can't change.");
  }
  const { eventPay, HOURLY_ROLE_CAP_CENTS } = await import("./teamPay");
  const rp = (await eventPay(p.event)).byRole.get(`${x.member_user_id}:${x.role}`);
  const others = (rp?.extras ?? []).filter((l) => l.id !== String(x.id)).reduce((n, l) => n + (l.cents ?? 0), 0);
  const so_far = (rp?.fixedCents ?? 0) + (rp?.hourlyCents ?? 0) + others;
  if (cents > 0 && so_far + cents > HOURLY_ROLE_CAP_CENTS) {
    return no(409, "OVER_ROLE_CAP", `That would take their pay for this role past $10,000. They can get up to ${moneyText(Math.max(0, HOURLY_ROLE_CAP_CENTS - so_far))} more.`);
  }
  // The payout statement sets team_pay_fixed_at; checking it in the update keeps a late save from landing after it.
  const [saved] = await rows<any>(sql`
    UPDATE event_team_extensions x SET final_cents = ${cents}, amount_set_at = now(), updated_at = now()
    WHERE x.id = ${p.requestId} AND x.pay_kind = 'tbd' AND x.status = 'accepted'
      AND EXISTS (SELECT 1 FROM events e WHERE e.id = x.event_id AND e.team_pay_fixed_at IS NULL AND e.ends_at + interval '3 days' > now())
    RETURNING x.*`);
  if (!saved) return no(409, "PAY_FIXED", "The payout is already worked out, so this can't change.");
  const { notifyTeamPayChanged } = await import("./ticketNotices");
  void notifyTeamPayChanged({ memberUserId: String(x.member_user_id), eventId: String(p.event.id), eventTitle: String(p.event.title ?? "your event") });
  return { ok: true, request: requestJson(saved) };
}

/** Every request at this event, for the host and co-hosts, newest first. */
export async function listStayLonger(eventId: string) {
  const { rows } = await db();
  const list = await rows<any>(sql`
    SELECT x.*, u.first_name, u.username FROM event_team_extensions x JOIN users u ON u.id = x.member_user_id
    WHERE x.event_id = ${eventId} ORDER BY x.created_at DESC LIMIT 200`);
  return list.map((r) => ({ ...requestJson(r), member: { firstName: r.first_name ?? null, username: r.username ?? null } }));
}

/** One member's requests at this event (their event screen), newest first. */
export async function myStayLonger(eventId: string, userId: string) {
  const { rows } = await db();
  const list = await rows<any>(sql`
    SELECT * FROM event_team_extensions WHERE event_id = ${eventId} AND member_user_id = ${userId} ORDER BY created_at DESC LIMIT 50`);
  return list.map(requestJson);
}

/**
 * Step 7: what's already promised for this role is fixed. While a request is open or accepted, the host can't switch the
 * role between hourly and other pay (call 43 would no longer hold), take the role past $10,000 with its extras, or
 * move their end (the extra already covers that time, so hourly would pay twice). Null = allowed.
 */
export async function lockedByStayLonger(p: { eventId: string; memberId: string; role: string; nextPay?: { payType: string; fixedCents: number | null; hourlyCents: number | null } }):
  Promise<{ code: string; message: string } | null> {
  const { rows } = await db();
  const list = await rows<any>(sql`
    SELECT status, pay_kind, extra_minutes, fixed_cents, final_cents FROM event_team_extensions
    WHERE event_id = ${p.eventId} AND member_user_id = ${p.memberId} AND role = ${p.role} AND status IN ('open', 'accepted')`);
  if (!list.length) return null;
  if (!p.nextPay) return { code: "STAY_LONGER_SET", message: "They agreed to stay longer, so their end time is set by that. Ask them to stay longer again instead." };
  const [cur] = await rows<any>(sql`SELECT pay_type FROM event_team_pay WHERE event_id = ${p.eventId} AND member_user_id = ${p.memberId} AND role = ${p.role}`);
  const wasHourly = cur?.pay_type === "hourly";
  if (wasHourly !== (p.nextPay.payType === "hourly")) {
    return { code: "STAY_LONGER_SET", message: "They were asked to stay longer on this pay, so it can't switch between hourly and other pay now." };
  }
  if (p.nextPay.payType === "fixed") {
    const extras = list.reduce((n, x) => n + (x.pay_kind === "fixed" ? Number(x.fixed_cents) : x.pay_kind === "tbd" ? Number(x.final_cents ?? 0) : 0), 0);
    if (Number(p.nextPay.fixedCents ?? 0) + extras > STAY_LIMITS_ROLE_CAP) {
      return { code: "OVER_ROLE_CAP", message: `With what they get for staying longer, this role would pass $10,000. Set up to ${moneyText(Math.max(0, STAY_LIMITS_ROLE_CAP - extras))}.` };
    }
  }
  return null;
}
const STAY_LIMITS_ROLE_CAP = 1_000_000;

/**
 * After someone is taken off the team or leaves: their open requests close quietly (no "didn't answer" push to the
 * host, and the host can ask again if they're added back). Accepted ones stay: that time was worked.
 */
export async function closeStayLongerOffTeam(memberId: string): Promise<void> {
  try {
    const { rows } = await db();
    await rows(sql`
      UPDATE event_team_extensions x SET status = 'expired', answered_at = now(), host_notified_at = now(), updated_at = now()
      FROM events e
      WHERE e.id = x.event_id AND x.member_user_id = ${memberId} AND x.status = 'open'
        AND NOT EXISTS (SELECT 1 FROM event_door_members m WHERE m.event_id = x.event_id AND m.member_user_id = x.member_user_id AND m.role = x.role
                          AND m.removed_at IS NULL AND m.accepted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM event_door_team t WHERE t.host_user_id = e.host_user_id AND t.member_user_id = x.member_user_id AND t.role = x.role
                          AND t.removed_at IS NULL AND t.accepted_at IS NOT NULL)`);
  } catch (err) {
    console.error(`[StayLonger] closing open requests failed for ${memberId}:`, (err as Error)?.message ?? err);
  }
}

/** Job (every minute): open requests past their time expire, and the host is told once. Returns how many. */
export async function expireStayLonger(now: Date = new Date()): Promise<number> {
  const { rows } = await db();
  const done = await rows<any>(sql`
    UPDATE event_team_extensions x SET status = 'expired', answered_at = now(), host_notified_at = now(), updated_at = now()
    WHERE x.id IN (SELECT id FROM event_team_extensions WHERE status = 'open' AND expires_at < ${now.toISOString()}::timestamptz ORDER BY expires_at LIMIT 200)
      AND x.status = 'open'
    RETURNING x.id, x.event_id, x.member_user_id, x.requested_by_user_id`);
  for (const r of done) {
    try {
      const [info] = await rows<any>(sql`
        SELECT e.title, e.host_user_id, u.first_name, u.username FROM events e, users u WHERE e.id = ${r.event_id} AND u.id = ${r.member_user_id}`);
      if (!info) continue;
      await tell(String(info.host_user_id),
        { title: `Your request to ${personName(info)} expired`, body: `They didn't answer in time. Their time at ${String(info.title)} stays the same.` },
        { type: "team_stay_longer_expired", eventId: String(r.event_id), requestId: String(r.id) }, null);
    } catch (err) {
      console.error(`[StayLonger] expiry notice failed for ${r.id}:`, (err as Error)?.message ?? err);
    }
  }
  return done.length;
}

/** Job: To be discussed amounts the host hasn't entered, the morning after the event and the day before payout day. */
export async function remindStayLongerAmounts(now: Date = new Date()): Promise<number> {
  const { rows } = await db();
  const nowIso = now.toISOString();
  const due = await rows<any>(sql`
    SELECT x.id, x.event_id, x.extra_minutes, x.tbd_morning_reminded_at, x.tbd_eve_reminded_at,
           e.title, e.timezone, e.ends_at, e.host_user_id, u.first_name, u.username
    FROM event_team_extensions x JOIN events e ON e.id = x.event_id JOIN users u ON u.id = x.member_user_id
    WHERE x.pay_kind = 'tbd' AND x.status = 'accepted' AND x.final_cents IS NULL AND x.new_end_at <= ${nowIso}::timestamptz
      AND (x.tbd_morning_reminded_at IS NULL OR x.tbd_eve_reminded_at IS NULL)
      AND e.team_pay_fixed_at IS NULL AND e.status <> 'cancelled'
      AND e.ends_at <= ${nowIso}::timestamptz AND e.ends_at > ${nowIso}::timestamptz - interval '3 days'
    ORDER BY e.ends_at LIMIT 500`);
  let sent = 0;
  for (const x of due) {
    const end = new Date(x.ends_at);
    const kind = amountReminderDue(end, x.timezone, now, { morning: !!x.tbd_morning_reminded_at, eve: !!x.tbd_eve_reminded_at });
    if (!kind) continue;
    // Claimed before sending, so two job runs never push twice. A late morning one is skipped once the eve one is due.
    const [claimed] = kind === "eve"
      ? await rows<any>(sql`UPDATE event_team_extensions SET tbd_eve_reminded_at = now(), tbd_morning_reminded_at = COALESCE(tbd_morning_reminded_at, now())
          WHERE id = ${x.id} AND tbd_eve_reminded_at IS NULL AND final_cents IS NULL RETURNING id`)
      : await rows<any>(sql`UPDATE event_team_extensions SET tbd_morning_reminded_at = now()
          WHERE id = ${x.id} AND tbd_morning_reminded_at IS NULL AND final_cents IS NULL RETURNING id`);
    if (!claimed) continue;
    sent++;
    const deadline = dayClockText(new Date(end.getTime() + PAYOUT_AFTER_MS), x.timezone);
    const body = kind === "eve"
      ? `Payout is tomorrow. Enter what ${personName(x)} gets for staying ${durationText(Number(x.extra_minutes))} at ${String(x.title)}, or it's $0.`
      : `${personName(x)} stayed ${durationText(Number(x.extra_minutes))} at ${String(x.title)}. Enter it by ${deadline}, or it's $0.`;
    await tell(String(x.host_user_id), { title: "Enter the extra pay", body },
      { type: "team_stay_longer_amount", eventId: String(x.event_id), requestId: String(x.id), kind }, null);
  }
  return sent;
}
