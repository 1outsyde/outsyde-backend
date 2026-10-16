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
/**
 * Booking, shoot, order, staff and account emails the backend sends on its own (PR C2). They are
 * logged one row per email with a plain label and never count toward the admin daily budget.
 * Internal alerts to ADMIN_NOTIFICATION_EMAIL and password or claim code emails are never logged
 * (decided by Legend 2026-10-16): only senders that pass an EmailLogTag are logged.
 */
export type TransactionalKind = "booking" | "shoot" | "order" | "staff" | "account";
export type LogKind = "broadcast" | "broadcast_test" | "setup_claim" | "setup_steps_left" | TransactionalKind;
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

// ── transactional emails (PR C2) ─────────────────────────────────────────────

/** What a sender passes to have its email logged: an area (kind) and a plain label, no personal data. */
export interface EmailLogTag { kind: TransactionalKind; label: string }

/**
 * The one account that uses this address (case insensitive), or null when none or more than one
 * match. users.email is unique but case sensitive (shared/schema.ts).
 */
export async function findUserIdByEmail(address: string): Promise<string | null> {
  const email = address.trim().toLowerCase();
  if (!email) return null;
  const r = await db.execute(sql`SELECT id FROM users WHERE lower(email) = ${email} LIMIT 2`);
  return r.rows.length === 1 ? String((r.rows[0] as { id: string }).id) : null;
}

/** Error text without any email address in it (email_log never stores addresses). */
export function scrubError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  return String(raw ?? "Send failed").replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, "[address]").slice(0, 500);
}

/**
 * Logs one transactional email after the send was attempted. Fire and forget: returns at once,
 * never throws and never changes what the sender returns or throws. No tag or no address = no log.
 * The address is only used to find the account; it is not stored. No matching account = the row is
 * kept without a person (decided by Legend 2026-10-16).
 */
export function logTransactionalEmail(
  tag: EmailLogTag | undefined,
  to: string | null | undefined,
  outcome: { resendId?: string | null; error?: unknown },
): void {
  if (!tag || !to) return;
  void (async () => {
    try {
      const userId = await findUserIdByEmail(to);
      const failed = outcome.error !== undefined && outcome.error !== null;
      await logEmail({
        sendId: null, userId, kind: tag.kind, label: tag.label,
        status: failed ? "failed" : "sent",
        error: failed ? scrubError(outcome.error) : null,
        resendId: outcome.resendId ?? null,
      });
    } catch (err) {
      console.error("[EmailHistory] logTransactionalEmail failed:", err);
    }
  })();
}

// ── Resend account usage (decision 4a) ───────────────────────────────────────

/** Every email on the Resend account today (backend, goutsyde.com, forms), per Resend's own count. */
export interface ResendUsage { used: number; limit: number | null; resetsAt: string | null }

const USAGE_CACHE_MS = 60_000;
let usageCache: { at: number; value: ResendUsage | null } | null = null;

/**
 * GET {RESEND_BASE_URL or https://api.resend.com}/usage with RESEND_API_KEY (needs a full access
 * key; Render's is full access, Legend 2026-10-16). Cached for a minute. Returns null on any
 * problem so the admin page just hides the line. Never throws.
 */
export async function getResendUsage(now: number = Date.now()): Promise<ResendUsage | null> {
  if (usageCache && now - usageCache.at < USAGE_CACHE_MS) return usageCache.value;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  const base = (process.env.RESEND_BASE_URL || "https://api.resend.com").replace(/\/+$/, "");
  let value: ResendUsage | null = null;
  try {
    const res = await fetch(`${base}/usage`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const body = (await res.json()) as { emails?: { daily?: { used?: unknown; limit?: unknown; resets_at?: unknown } } };
      const daily = body?.emails?.daily;
      if (daily && typeof daily.used === "number") {
        value = {
          used: daily.used,
          limit: typeof daily.limit === "number" ? daily.limit : null,
          resetsAt: typeof daily.resets_at === "string" ? daily.resets_at : null,
        };
      }
    } else {
      console.warn(`[EmailHistory] Resend usage returned ${res.status}`);
    }
  } catch (err) {
    console.warn("[EmailHistory] Resend usage failed:", err instanceof Error ? err.message : err);
  }
  usageCache = { at: now, value };
  return value;
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
