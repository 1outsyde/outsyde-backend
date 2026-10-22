/**
 * Events & Ticketing: the one-time "your address is ready" notice for day-of events.
 *
 * Runs every minute from the booking cleanup job. For each published `ticket_holders_day_of` event whose reveal time
 * (addressRevealAt) has passed and that hasn't ended, it claims the valid tickets bought BEFORE the reveal time with a
 * single UPDATE ... RETURNING guarded by `address_reveal_notified_at IS NULL`, so two runs at once notify each holder
 * once. Tickets bought after the reveal already see the address, so they get no notice. Each distinct holder gets one push
 * and one email. Failures are logged and never thrown (a claimed ticket is not retried: one notice at most).
 */
import { sql } from "drizzle-orm";
import { rows } from "./eventsRouter";
import { addressRevealAt } from "./eventRules";
import { noticeDeps, paced, formatEventWhen, formatEventWhere } from "./ticketNotices";

const CLAIM_BATCH = 200;
const MAX_BATCHES_PER_EVENT = 50;

function ticketsUrl(): string {
  const base = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || "https://www.goutsyde.com").replace(/\/+$/, "");
  return `${base}/tickets`;
}

export async function runAddressRevealJob(now: Date = new Date()): Promise<{ notified: number }> {
  let notified = 0;
  try {
    const nowIso = now.toISOString();
    const events = await rows<any>(sql`
      SELECT id, title, starts_at, timezone, venue_name, address_line1, address_line2, city, state, postal_code
      FROM events
      WHERE status = 'published' AND address_visibility = 'ticket_holders_day_of'
        AND ends_at > ${nowIso}::timestamptz
        AND starts_at <= ${nowIso}::timestamptz + interval '18 hours'`);
    for (const e of events) {
      try {
        const revealAt = addressRevealAt(new Date(e.starts_at), e.timezone);
        if (revealAt.getTime() > now.getTime()) continue;
        notified += await notifyEvent(e, revealAt);
      } catch (err) {
        console.error(`[AddressReveal] event ${e.id} failed:`, (err as Error)?.message ?? err);
      }
    }
  } catch (err) {
    console.error("[AddressReveal] job failed:", (err as Error)?.message ?? err);
  }
  return { notified };
}

async function notifyEvent(e: any, revealAt: Date): Promise<number> {
  const d = await noticeDeps();
  const where = formatEventWhere(e);
  const event = { title: String(e.title), whenText: formatEventWhen(e.starts_at, e.timezone), whereText: where };
  const url = ticketsUrl();
  let count = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_EVENT; batch++) {
    const claimed = await rows<any>(sql`
      UPDATE tickets SET address_reveal_notified_at = now()
      WHERE id IN (
        SELECT id FROM tickets
        WHERE event_id = ${e.id} AND status = 'valid' AND address_reveal_notified_at IS NULL
          AND created_at < ${revealAt.toISOString()}::timestamptz
        LIMIT ${CLAIM_BATCH})
        AND address_reveal_notified_at IS NULL
      RETURNING holder_user_id`);
    if (!claimed.length) break;
    const holderIds = Array.from(new Set(claimed.map((r) => String(r.holder_user_id))));
    const users = await rows<any>(sql`SELECT id, email, first_name FROM users WHERE id IN (${sql.join(holderIds.map((id) => sql`${id}`), sql`, `)})`);
    const byId = new Map(users.map((u) => [String(u.id), u]));
    for (const id of holderIds) {
      count++;
      await d.sendPush({
        userId: id, title: "Your event address is ready",
        body: `The address for ${e.title} is now in your tickets.`,
        data: { type: "address_reveal", eventId: e.id },
      }).catch((err) => console.error(`[AddressReveal] push failed for event ${e.id}:`, (err as Error)?.message ?? err));
      const u = byId.get(id);
      if (u?.email) {
        await paced(() => d.sendAddressReveal({ toEmail: u.email, firstName: u.first_name ?? null, event, ticketsUrl: url }))
          .catch((err) => console.error(`[AddressReveal] email failed for event ${e.id}:`, (err as Error)?.message ?? err));
      }
    }
    if (claimed.length < CLAIM_BATCH) break;
  }
  return count;
}
