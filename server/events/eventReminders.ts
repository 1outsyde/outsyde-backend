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
import { dueKind, reminderMoment, guestReminderCopy, hostReminderCopy, DAY_BEFORE_MS, type ReminderKind } from "./eventReminderRules";

const CLAIM_BATCH = 200;
const MAX_BATCHES_PER_EVENT = 50;

export type ReminderJobOptions = { batchSize?: number };
type Stats = { guestPushes: number; hostPushes: number };

export async function runEventReminderJob(now: Date = new Date(), opts: ReminderJobOptions = {}): Promise<Stats> {
  const stats: Stats = { guestPushes: 0, hostPushes: 0 };
  try {
    const nowIso = now.toISOString();
    const events = await rows<any>(sql`
      SELECT id, title, host_user_id, starts_at, timezone, city, state, published_at, host_reminder_at
      FROM events
      WHERE status = 'published'
        AND starts_at > ${nowIso}::timestamptz
        AND starts_at <= ${nowIso}::timestamptz + interval '24 hours'
        AND host_user_id IN (SELECT id FROM users WHERE is_active = true AND COALESCE(deletion_status, 'active') = 'active')`);
    for (const e of events) {
      try {
        const kind = dueKind(new Date(e.starts_at), now);
        if (!kind) continue;
        await remindGuests(e, kind, now, opts, stats);
        if (kind === "day_before" && !e.host_reminder_at) await remindHost(e, now, stats);
      } catch (err) {
        console.error(`[EventReminders] event ${e.id} failed:`, (err as Error)?.message ?? err);
      }
    }
  } catch (err) {
    console.error("[EventReminders] job failed:", (err as Error)?.message ?? err);
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
