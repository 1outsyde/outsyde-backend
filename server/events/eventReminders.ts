/**
 * Events & Ticketing: event reminder pushes (Events canvas screen 36, approved by Legend 2026-10-26).
 *
 * Runs every minute from the booking cleanup job, after the address reveal. For each published event with an active
 * host that starts within 24 hours:
 *  - Guests: in the day before window (24 hours to 2 hours before the start) and the soon window (2 hours to the
 *    start), each holder of a valid ticket created BEFORE that window's moment gets one push. The claim is per
 *    holder in one UPDATE ... RETURNING guarded by `<column> IS NULL` (like addressReveal.ts), so two runs at once
 *    push each holder once, and a holder with several tickets is never split across batches.
 *  - The host: one push in the day before window, only for events published before the day before moment, claimed
 *    with `events.host_reminder_at IS NULL`. "[N] going" = valid tickets on completed orders (the door guest list).
 * Push only, no email. Failures are logged and never thrown; a claimed reminder is never retried (one push at most).
 * Push data: { type: "event_reminder", kind: "day_before" | "soon" | "host_day_before", eventId }.
 */
import { sql } from "drizzle-orm";
import { rows } from "./eventsRouter";
import { noticeDeps } from "./ticketNotices";
import {
  dueKind, reminderMoment, guestReminderCopy, hostReminderCopy, DAY_BEFORE_MS, type ReminderKind,
  dueAnchored, doorsDue, momentOfKind, teamAnchor, guestWeekCopy, guestStartCopy, hostCopy, teamReminderCopy,
  WEEK_MS, START_LATE_MS, type AnyReminderKind, type TeamTimes,
} from "./eventReminderRules";

const CLAIM_BATCH = 200;
const MAX_BATCHES_PER_EVENT = 50;

export type ReminderJobOptions = { batchSize?: number };
type Stats = { guestPushes: number; hostPushes: number; teamPushes?: number };

export async function runEventReminderJob(now: Date = new Date(), opts: ReminderJobOptions = {}): Promise<Stats> {
  const stats: Stats = { guestPushes: 0, hostPushes: 0, teamPushes: 0 };
  try {
    const nowIso = now.toISOString();
    // Step 6: from 30 minutes after the start (doors open) to 8 days out (a team time can be up to a day before the
    // start, and its 7 day reminder counts from that time).
    const events = await rows<any>(sql`
      SELECT id, title, host_user_id, starts_at, ends_at, timezone, city, state, venue_name, published_at, host_reminder_at,
             host_reminder_week_at, host_reminder_soon_at, host_reminder_start_at
      FROM events
      WHERE status = 'published'
        -- Team times can be up to 12 hours after the end (doorRouter SCHEDULE_AFTER_MS), so those events stay in.
        AND COALESCE(ends_at, starts_at) + interval '12 hours' >= ${nowIso}::timestamptz
        AND starts_at <= ${nowIso}::timestamptz + make_interval(secs => ${(WEEK_MS + DAY_BEFORE_MS) / 1000}::int)
        AND host_user_id IN (SELECT id FROM users WHERE is_active = true AND COALESCE(deletion_status, 'active') = 'active')`);
    for (const e of events) {
      try {
        const start = new Date(e.starts_at);
        // Ticket holders and the host, from the event start (day before and 2 hours: as before).
        const kind = dueKind(start, now);
        if (kind) {
          await remindGuests(e, kind, now, opts, stats);
          if (kind === "day_before" && !e.host_reminder_at) await remindHost(e, now, stats);
        }
        const anchored = dueAnchored(start, now);
        if (anchored === "week") {
          await remindGuestsExtra(e, "week", now, opts, stats);
          await remindHostExtra(e, "week", now, stats);
        }
        if (anchored === "soon") await remindHostExtra(e, "soon", now, stats);
        if (doorsDue(start, now)) {
          await remindGuestsExtra(e, "start", now, opts, stats);
          await remindHostExtra(e, "start", now, stats);
        }
        // Step 6: the team, each from their own time.
        await remindTeam(e, now, stats);
      } catch (err) {
        console.error(`[EventReminders] event ${e.id} failed:`, (err as Error)?.message ?? err);
      }
    }
  } catch (err) {
    console.error("[EventReminders] job failed:", (err as Error)?.message ?? err);
  }
  // Step 7: requests to stay longer that ran out, and To be discussed amounts still to enter. Their own catch.
  try {
    const ext = await import("./teamExtensions");
    await ext.expireStayLonger(now);
    await ext.remindStayLongerAmounts(now);
  } catch (err) {
    console.error("[EventReminders] stay longer job failed:", (err as Error)?.message ?? err);
  }
  return stats;
}

async function remindGuests(e: any, kind: ReminderKind, now: Date, opts: ReminderJobOptions, stats: Stats): Promise<void> {
  const d = await noticeDeps();
  const moment = reminderMoment(new Date(e.starts_at), kind).toISOString();
  const col = kind === "day_before" ? sql.raw("reminder_day_before_at") : sql.raw("reminder_soon_at");
  const copy = guestReminderCopy(kind, e, now);
  const batchSize = opts.batchSize ?? CLAIM_BATCH;
  for (let batch = 0; batch < MAX_BATCHES_PER_EVENT; batch++) {
    const claimed = await rows<any>(sql`
      UPDATE tickets SET ${col} = now()
      WHERE event_id = ${e.id} AND status = 'valid' AND ${col} IS NULL
        AND created_at < ${moment}::timestamptz
        AND holder_user_id IN (
          SELECT DISTINCT holder_user_id FROM tickets
          WHERE event_id = ${e.id} AND status = 'valid' AND ${col} IS NULL
            AND created_at < ${moment}::timestamptz
          ORDER BY holder_user_id
          LIMIT ${batchSize})
      RETURNING holder_user_id`);
    if (!claimed.length) break;
    const holderIds = Array.from(new Set(claimed.map((r) => String(r.holder_user_id))));
    for (const id of holderIds) {
      stats.guestPushes++;
      await d.sendPush({ userId: id, title: copy.title, body: copy.body, data: { type: "event_reminder", kind, eventId: e.id } })
        .catch((err) => console.error(`[EventReminders] push failed for event ${e.id}:`, (err as Error)?.message ?? err));
    }
    if (holderIds.length < batchSize) break;
  }
}

async function remindHost(e: any, now: Date, stats: Stats): Promise<void> {
  const moment = new Date(new Date(e.starts_at).getTime() - DAY_BEFORE_MS).toISOString();
  const [claimed] = await rows<any>(sql`
    UPDATE events SET host_reminder_at = now()
    WHERE id = ${e.id} AND host_reminder_at IS NULL
      AND published_at IS NOT NULL AND published_at < ${moment}::timestamptz
    RETURNING host_user_id`);
  if (!claimed) return;
  const [g] = await rows<any>(sql`
    SELECT count(*)::int AS n
    FROM tickets t JOIN ticket_orders o ON o.id = t.order_id AND o.status = 'completed'
    WHERE t.event_id = ${e.id} AND t.status = 'valid'`);
  const copy = hostReminderCopy(e, Number(g?.n ?? 0), now);
  const d = await noticeDeps();
  stats.hostPushes++;
  await d.sendPush({ userId: String(claimed.host_user_id), title: copy.title, body: copy.body, data: { type: "event_reminder", kind: "host_day_before", eventId: e.id } })
    .catch((err) => console.error(`[EventReminders] host push failed for event ${e.id}:`, (err as Error)?.message ?? err));
}

// ─── p4-team step 6: 7 days, doors open, the host's extra ones, and the team ──────────────────────────────────

async function goingCount(eventId: string): Promise<number> {
  const [g] = await rows<any>(sql`
    SELECT count(*)::int AS n
    FROM tickets t JOIN ticket_orders o ON o.id = t.order_id AND o.status = 'completed'
    WHERE t.event_id = ${eventId} AND t.status = 'valid'`);
  return Number(g?.n ?? 0);
}

/** Ticket holders' 7 day and doors open pushes. Same claim rules as remindGuests (per holder, ticket before the moment). */
async function remindGuestsExtra(e: any, kind: "week" | "start", now: Date, opts: ReminderJobOptions, stats: Stats): Promise<void> {
  const d = await noticeDeps();
  const start = new Date(e.starts_at);
  const moment = momentOfKind(kind, start, start).toISOString();
  const col = kind === "week" ? sql.raw("reminder_week_at") : sql.raw("reminder_start_at");
  const copy = kind === "week" ? guestWeekCopy(e, now) : guestStartCopy(e);
  const batchSize = opts.batchSize ?? CLAIM_BATCH;
  for (let batch = 0; batch < MAX_BATCHES_PER_EVENT; batch++) {
    const claimed = await rows<any>(sql`
      UPDATE tickets SET ${col} = now()
      WHERE event_id = ${e.id} AND status = 'valid' AND ${col} IS NULL
        AND created_at < ${moment}::timestamptz
        AND holder_user_id IN (
          SELECT DISTINCT holder_user_id FROM tickets
          WHERE event_id = ${e.id} AND status = 'valid' AND ${col} IS NULL
            AND created_at < ${moment}::timestamptz
          ORDER BY holder_user_id
          LIMIT ${batchSize})
      RETURNING holder_user_id`);
    if (!claimed.length) break;
    const holderIds = Array.from(new Set(claimed.map((r) => String(r.holder_user_id))));
    for (const id of holderIds) {
      stats.guestPushes++;
      await d.sendPush({ userId: id, title: copy.title, body: copy.body, data: { type: "event_reminder", kind, eventId: e.id } })
        .catch((err) => console.error(`[EventReminders] push failed for event ${e.id}:`, (err as Error)?.message ?? err));
    }
    if (holderIds.length < batchSize) break;
  }
}

/** Accepted team members, a count for the host's 2 hour push (same people as teamSpots: active, not the host). */
async function teamSize(e: any): Promise<number> {
  const [n] = await rows<any>(sql`
    SELECT count(DISTINCT a.member_user_id)::int AS n FROM (
      SELECT member_user_id FROM event_door_members WHERE event_id = ${e.id} AND removed_at IS NULL AND accepted_at IS NOT NULL
      UNION ALL
      SELECT member_user_id FROM event_door_team WHERE host_user_id = ${e.host_user_id} AND removed_at IS NULL AND accepted_at IS NOT NULL
    ) a JOIN users u ON u.id = a.member_user_id AND u.is_active = true AND COALESCE(u.deletion_status, 'active') = 'active'
    WHERE a.member_user_id <> ${e.host_user_id}`);
  return Number(n?.n ?? 0);
}

/** The host's 7 day, 2 hour and doors open pushes, each claimed once on events (published before the moment). */
async function remindHostExtra(e: any, kind: "week" | "soon" | "start", now: Date, stats: Stats): Promise<void> {
  const start = new Date(e.starts_at);
  const moment = momentOfKind(kind, start, start).toISOString();
  const col = sql.raw(kind === "week" ? "host_reminder_week_at" : kind === "soon" ? "host_reminder_soon_at" : "host_reminder_start_at");
  const [claimed] = await rows<any>(sql`
    UPDATE events SET ${col} = now()
    WHERE id = ${e.id} AND ${col} IS NULL AND published_at IS NOT NULL AND published_at < ${moment}::timestamptz
    RETURNING host_user_id`);
  if (!claimed) return;
  const copy = hostCopy(kind, e, await goingCount(e.id), await teamSize(e), now);
  const d = await noticeDeps();
  stats.hostPushes++;
  await d.sendPush({ userId: String(claimed.host_user_id), title: copy.title, body: copy.body, data: { type: "event_reminder", kind: `host_${kind}`, eventId: e.id } })
    .catch((err) => console.error(`[EventReminders] host push failed for event ${e.id}:`, (err as Error)?.message ?? err));
}

type Spot = { userId: string; role: string; roleLabel: string | null; acceptedAt: Date; times: TeamTimes | null; anchor: Date };

/**
 * Every accepted team member (this event and the host's standing team, not the host), each with the role that starts
 * first and that role's time (call 35). Co-hosts count from the event start and get the host's wording.
 */
async function teamSpots(e: any): Promise<Spot[]> {
  const start = new Date(e.starts_at);
  const list = await rows<any>(sql`
    SELECT a.member_user_id, a.role, a.role_label, a.accepted_at,
           s.starts_at, s.ends_at, s.call_at, s.load_in_at, s.place_note
    FROM (
      SELECT m.member_user_id, m.role, m.role_label, m.accepted_at FROM event_door_members m
      WHERE m.event_id = ${e.id} AND m.removed_at IS NULL AND m.accepted_at IS NOT NULL
      UNION ALL
      SELECT t.member_user_id, t.role, t.role_label, t.accepted_at FROM event_door_team t
      WHERE t.host_user_id = ${e.host_user_id} AND t.removed_at IS NULL AND t.accepted_at IS NOT NULL
    ) a
    JOIN users u ON u.id = a.member_user_id AND u.is_active = true AND COALESCE(u.deletion_status, 'active') = 'active'
    LEFT JOIN event_team_schedules s ON s.event_id = ${e.id} AND s.member_user_id = a.member_user_id AND s.role = a.role
    WHERE a.member_user_id <> ${e.host_user_id}`);
  const best = new Map<string, Spot>();
  for (const r of list) {
    const times: TeamTimes | null = r.starts_at || r.ends_at || r.call_at || r.load_in_at || r.place_note
      ? { startsAt: r.starts_at ? new Date(r.starts_at) : null, endsAt: r.ends_at ? new Date(r.ends_at) : null,
          callAt: r.call_at ? new Date(r.call_at) : null, loadInAt: r.load_in_at ? new Date(r.load_in_at) : null, placeNote: r.place_note ?? null }
      : null;
    const spot: Spot = { userId: String(r.member_user_id), role: String(r.role), roleLabel: r.role_label ?? null, acceptedAt: new Date(r.accepted_at), times, anchor: teamAnchor(String(r.role), times, start) };
    const prev = best.get(spot.userId);
    // Two roles: the one that starts first. A tie goes to the earlier acceptance (stable).
    if (!prev || spot.anchor.getTime() < prev.anchor.getTime() || (spot.anchor.getTime() === prev.anchor.getTime() && spot.acceptedAt < prev.acceptedAt)) best.set(spot.userId, spot);
  }
  return Array.from(best.values());
}

/** Team reminders: claimed per person per kind in event_team_reminders, only if they were on the team by the moment. */
async function remindTeam(e: any, now: Date, stats: Stats): Promise<void> {
  const start = new Date(e.starts_at);
  const spots = await teamSpots(e);
  if (!spots.length) return;
  // What was already sent, read once: most minutes nothing is due and no claim is tried.
  const sent = new Set((await rows<any>(sql`SELECT member_user_id, kind FROM event_team_reminders WHERE event_id = ${e.id}`))
    .map((r) => `${r.member_user_id}:${r.kind}`));
  const d = await noticeDeps();
  let going: number | null = null, size: number | null = null;
  let links: Map<string, { tickets: number; rsvps: number }> | null = null;
  for (const sp of spots) {
    const kinds: AnyReminderKind[] = [];
    const k = dueAnchored(sp.anchor, now);
    if (k) kinds.push(k);
    if (doorsDue(start, now)) kinds.push("start");
    for (const kind of kinds) {
      if (sent.has(`${sp.userId}:${kind}`)) continue;
      try {
        const moment = momentOfKind(kind, sp.anchor, start);
        if (sp.acceptedAt.getTime() >= moment.getTime()) continue; // joined after this reminder's moment (call 36)
        const [claimed] = await rows<any>(sql`
          INSERT INTO event_team_reminders (event_id, member_user_id, kind, role) VALUES (${e.id}, ${sp.userId}, ${kind}, ${sp.role})
          ON CONFLICT DO NOTHING RETURNING 1 AS x`);
        if (!claimed) continue;
        let copy: { title: string; body: string };
        if (sp.role === "cohost") {
          if (going === null) going = await goingCount(e.id);
          if (size === null) size = await teamSize(e);
          copy = hostCopy(kind, e, going, size, now);
        } else {
          if (sp.role === "host" && !links) {
            const { promoterLinkStats } = await import("./promoterLinks");
            links = new Map((await promoterLinkStats(String(e.id))).map((l: any) => [String(l.userId), { tickets: Number(l.ticketsSold ?? 0), rsvps: Number(l.rsvps ?? 0) }]));
          }
          copy = teamReminderCopy(kind, sp.role, {
            title: e.title, timezone: e.timezone, eventStart: start, anchor: kind === "start" ? start : sp.anchor,
            venueName: e.venue_name ?? null, roleLabel: sp.roleLabel, schedule: sp.times,
            linkSold: sp.role === "host" ? links?.get(sp.userId)?.tickets ?? 0 : null,
            linkRsvps: sp.role === "host" ? links?.get(sp.userId)?.rsvps ?? 0 : null, now,
          });
        }
        stats.teamPushes = (stats.teamPushes ?? 0) + 1;
        await d.sendPush({ userId: sp.userId, title: copy.title, body: copy.body, data: { type: "event_reminder", kind: `team_${kind}`, eventId: e.id, role: sp.role } })
          .catch((err) => console.error(`[EventReminders] team push failed for event ${e.id}:`, (err as Error)?.message ?? err));
        // Team reminders also land in Activity (call 39, screen 57).
        if (d.createActivity) {
          await d.createActivity({
            userId: sp.userId, type: "event_reminder", title: copy.title, message: copy.body, referenceType: "event", referenceId: String(e.id),
            metadata: { eventId: String(e.id), kind: `team_${kind}`, role: sp.role }, triggeredByUserId: null,
          }).catch((err) => console.error(`[EventReminders] team activity failed for event ${e.id}:`, (err as Error)?.message ?? err));
        }
      } catch (err) {
        console.error(`[EventReminders] team reminder for ${sp.userId} at ${e.id} failed:`, (err as Error)?.message ?? err);
      }
    }
  }
}
