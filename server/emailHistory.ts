/**
 * Email history (migration 043): one email_sends row per admin send or setup job run, one
 * email_log row per email to one person. Powers the admin History tab ("by send" and "by person")
 * and the daily budget check.
 *
 * Logging is best effort and must never stop or delay an email: every writer here catches its own
 * errors and returns null instead of throwing. email_log stores no email address, name or rendered
 * subject (account deletion blanks the users row rather than deleting it).
 */
import { sql } from "drizzle-orm";
import { db } from "./db";

export type SendKind = "broadcast" | "broadcast_test" | "setup";
export type LogKind = "broadcast" | "broadcast_test" | "setup_claim" | "setup_steps_left";
export type LogStatus = "pending" | "sending" | "sent" | "failed" | "unknown";

/** Kinds that count toward the admin daily budget (emails started from the admin Emails page). */
export const BUDGET_KINDS: LogKind[] = ["broadcast", "broadcast_test", "setup_claim", "setup_steps_left"];

export const DEFAULT_DAILY_LIMIT = 80;

/**
 * Max emails the admin page may send per New York day, so the Resend Free plan's 100 a day
 * always leaves room for booking and receipt emails. BROADCAST_DAILY_LIMIT on Render changes it;
 * "0" or "off" turns the check off (for example after upgrading Resend).
 */
export function dailyLimit(): number | null {
  const raw = (process.env.BROADCAST_DAILY_LIMIT ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_DAILY_LIMIT;
  if (raw === "0" || raw === "off") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_LIMIT;
}

/** Postgres text[] literal for a list of ids (quotes and backslashes escaped). */
export function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

export async function createSend(params: {
  kind: SendKind; createdBy: string | null; audience?: string | null; subject?: string | null;
  html?: string | null; recipientCount?: number;
}): Promise<string | null> {
  try {
    const r = await db.execute(sql`
      INSERT INTO email_sends (kind, created_by, audience, subject, html, recipient_count)
      VALUES (${params.kind}, ${params.createdBy}, ${params.audience ?? null}, ${params.subject ?? null},
              ${params.html ?? null}, ${params.recipientCount ?? 0})
      RETURNING id
    `);
    return (r.rows[0] as { id: string } | undefined)?.id ?? null;
  } catch (err) {
    console.error("[EmailHistory] createSend failed:", err);
    return null;
  }
}

/** Records one email that was already attempted (setup emails). Never throws. */
export async function logEmail(params: {
  sendId: string | null; userId: string | null; kind: LogKind; label?: string | null;
  status: LogStatus; error?: string | null; resendId?: string | null;
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO email_log (send_id, user_id, kind, label, status, error, resend_id, sent_at)
      VALUES (${params.sendId}, ${params.userId}, ${params.kind}, ${params.label ?? null}, ${params.status},
              ${params.error ? params.error.slice(0, 500) : null}, ${params.resendId ?? null},
              ${params.status === "sent" ? sql`now()` : null})
      ON CONFLICT DO NOTHING
    `);
  } catch (err) {
    console.error("[EmailHistory] logEmail failed:", err);
  }
}

/** Recounts a send from its log rows and closes it. Never throws. */
export async function finishSend(sendId: string | null): Promise<void> {
  if (!sendId) return;
  try {
    await db.execute(sql`
      UPDATE email_sends s SET
        sent_count = c.sent, failed_count = c.failed, recipient_count = GREATEST(s.recipient_count, c.total),
        status = CASE WHEN c.open > 0 THEN 'sending' WHEN c.sent = 0 AND c.total > 0 THEN 'failed' ELSE 'done' END,
        finished_at = CASE WHEN c.open > 0 THEN NULL ELSE now() END
      FROM (
        SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
               count(*) FILTER (WHERE status IN ('failed', 'unknown'))::int AS failed,
               count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS open,
               count(*)::int AS total
        FROM email_log WHERE send_id = ${sendId}
      ) c
      WHERE s.id = ${sendId}
    `);
  } catch (err) {
    console.error("[EmailHistory] finishSend failed:", err);
  }
}

/** Start of today in New York, as a UTC Date. */
export function startOfNewYorkDay(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const elapsedMs = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - elapsedMs);
}

/** Emails started from the admin page today (New York day), including ones still going out. */
export async function sentTodayCount(now: Date = new Date()): Promise<number> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS n FROM email_log
    WHERE created_at >= ${startOfNewYorkDay(now).toISOString()}::timestamptz
      AND kind = ANY(${pgTextArray(BUDGET_KINDS)}::text[])
      AND status IN ('pending', 'sending', 'sent', 'unknown')
  `);
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
}

export interface Budget { sentToday: number; limit: number | null; remaining: number | null }

export async function getBudget(now: Date = new Date()): Promise<Budget> {
  const limit = dailyLimit();
  const sentToday = await sentTodayCount(now);
  return { sentToday, limit, remaining: limit === null ? null : Math.max(0, limit - sentToday) };
}
