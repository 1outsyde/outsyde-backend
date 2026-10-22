/**
 * Events & Ticketing: the one-time "your address is ready" notice for day-of events.
 *
 * Runs every minute from the booking cleanup job. For each published `ticket_holders_day_of` event whose reveal time
 * (addressRevealAt) has passed and that hasn't ended, it claims the valid tickets bought BEFORE the reveal time with a
 * single UPDATE ... RETURNING guarded by `address_reveal_notified_at IS NULL`, so two runs at once notify each holder
 * once (the claim is per HOLDER: every unstamped valid pre-reveal ticket of up to 200 holders is stamped in the same
 * statement, so a holder is never split across batches). Tickets bought after the reveal already see the address, so they get no notice. Each distinct holder gets one push
 * and, while the daily budget lasts, one email (REVEAL_EMAIL_DAILY_CAP, default 40 per UTC day, counted in tickets.address_reveal_emailed_at;
 * Resend's plan allows 100 emails a day). Holders past the budget get the push only. Failures are logged and never thrown (a claimed ticket is not retried: one notice at most).
 */
import { sql } from "drizzle-orm";
import { rows } from "./eventsRouter";
import { addressRevealAt } from "./eventRules";
import { noticeDeps, paced, formatEventWhen, formatEventWhere } from "./ticketNotices";

const CLAIM_BATCH = 200;
const MAX_BATCHES_PER_EVENT = 50;

export type RevealJobOptions = { batchSize?: number; emailDailyCap?: number };

function ticketsUrl(): string {
  const base = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || "https://www.goutsyde.com").replace(/\/+$/, "");
  return `${base}/tickets`;
}

function dailyCap(o: RevealJobOptions): number {
  if (o.emailDailyCap !== undefined) return o.emailDailyCap;
  const n = Number.parseInt(process.env.REVEAL_EMAIL_DAILY_CAP ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 40;
}

export async function runAddressRevealJob(now: Date = new Date(), opts: RevealJobOptions = {}): Promise<{ notified: number }> {
  const stats = { notified: 0, emailSkipped: 0 };
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
        await notifyEvent(e, revealAt, now, opts, stats);
      } catch (err) {
        console.error(`[AddressReveal] event ${e.id} failed:`, (err as Error)?.message ?? err);
      }
    }
  } catch (err) {
    console.error("[AddressReveal] job failed:", (err as Error)?.message ?? err);
  }
  if (stats.emailSkipped > 0) console.log(`[AddressReveal] daily email budget used up: ${stats.emailSkipped} holder(s) got the push only`);
  return { notified: stats.notified };
}

/**
 * Takes one email from today's budget (UTC day of `now`) for this holder by stamping one of their tickets, in one
 * statement that only stamps while fewer than `cap` are stamped today. Returns false when the budget is used up.
 */
async function takeEmailBudget(ticketId: string, now: Date, cap: number): Promise<boolean> {
  const nowIso = now.toISOString();
  const got = await rows<any>(sql`
    UPDATE tickets SET address_reveal_emailed_at = ${nowIso}::timestamptz
    WHERE id = ${ticketId} AND address_reveal_emailed_at IS NULL
      AND (SELECT count(*) FROM tickets
           WHERE address_reveal_emailed_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
             AND address_reveal_emailed_at < (date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC') < ${cap}
    RETURNING id`);
  return got.length > 0;
}

async function notifyEvent(e: any, revealAt: Date, now: Date, opts: RevealJobOptions, stats: { notified: number; emailSkipped: number }): Promise<void> {
  const d = await noticeDeps();
  const where = formatEventWhere(e);
  const event = { title: String(e.title), whenText: formatEventWhen(e.starts_at, e.timezone), whereText: where };
  const url = ticketsUrl();
  const batchSize = opts.batchSize ?? CLAIM_BATCH;
  const cap = dailyCap(opts);
  for (let batch = 0; batch < MAX_BATCHES_PER_EVENT; batch++) {
    // Per holder: pick up to batchSize holders that still have an unstamped valid pre-reveal ticket, stamp ALL of their such tickets here.
    const claimed = await rows<any>(sql`
      UPDATE tickets SET address_reveal_notified_at = now()
      WHERE event_id = ${e.id} AND status = 'valid' AND address_reveal_notified_at IS NULL
        AND created_at < ${revealAt.toISOString()}::timestamptz
        AND holder_user_id IN (
          SELECT DISTINCT holder_user_id FROM tickets
          WHERE event_id = ${e.id} AND status = 'valid' AND address_reveal_notified_at IS NULL
            AND created_at < ${revealAt.toISOString()}::timestamptz
          ORDER BY holder_user_id
          LIMIT ${batchSize})
      RETURNING id, holder_user_id`);
    if (!claimed.length) break;
    const ticketOf = new Map<string, string>();
    for (const r of claimed) if (!ticketOf.has(String(r.holder_user_id))) ticketOf.set(String(r.holder_user_id), String(r.id));
    const holderIds = Array.from(ticketOf.keys());
    const users = await rows<any>(sql`SELECT id, email, first_name FROM users WHERE id IN (${sql.join(holderIds.map((id) => sql`${id}`), sql`, `)})`);
    const byId = new Map(users.map((u) => [String(u.id), u]));
    for (const id of holderIds) {
      stats.notified++;
      await d.sendPush({
        userId: id, title: "Your event address is ready",
        body: `The address for ${e.title} is now in your tickets.`,
        data: { type: "address_reveal", eventId: e.id },
      }).catch((err) => console.error(`[AddressReveal] push failed for event ${e.id}:`, (err as Error)?.message ?? err));
      const u = byId.get(id);
      if (!u?.email) continue;
      try {
        if (!(await takeEmailBudget(ticketOf.get(id)!, now, cap))) { stats.emailSkipped++; continue; }
        await paced(() => d.sendAddressReveal({ toEmail: u.email, firstName: u.first_name ?? null, event, ticketsUrl: url }));
      } catch (err) {
        console.error(`[AddressReveal] email failed for event ${e.id}:`, (err as Error)?.message ?? err);
      }
    }
    if (holderIds.length < batchSize) break;
  }
}
