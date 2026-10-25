/**
 * Admin push announcements (goutsyde.com/admin/emails?tab=push). Migration 073.
 *
 * A send is one push_sends row plus one push_log row per recipient account, created in one statement.
 * Rows are claimed (pending -> sending) before their push goes out and closed as sent, failed or
 * skipped, so a retry or a restart never pushes anyone twice. One push per phone: a second account
 * on the same token is logged as skipped (duplicate_device) and still gets the Activity row.
 * About 15 minutes later the Expo receipts are read (a dead token usually shows up only there).
 *
 * This module has its own Expo client. It never calls or changes sendExpoPush (expoPushService.ts),
 * so booking, message, subscription, plan offer, account setup, event and referral pushes are untouched.
 * push_log and the console logs never hold a push token or the message text.
 */
import { createHash } from "crypto";
import Expo, { type ExpoPushMessage, type ExpoPushReceipt, type ExpoPushTicket } from "expo-server-sdk";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { pgTextArray } from "../emailHistory";
import {
  PUSH_DISPLAY_NAME, PUSH_ELIGIBLE, PUSH_ROLE, countPushRecipients, pushAudienceFilter, type PushAudience,
} from "./pushAudience";

export const MAX_TITLE = 65;
export const MAX_BODY = 178;
export const PUSH_DAILY_LIMIT = 3;
export const DUPLICATE_WINDOW_MINUTES = 10;
export const MAX_CLIENT_KEY = 100;
/** Expo allows 100 messages per request. */
export const BATCH_SIZE = 100;
export const RECEIPT_DELAY_MINUTES = 15;
const RECEIPT_CHUNK = 300;
const NY = "America/New_York";

// ── Expo (injectable so tests never reach exp.host) ─────────────────────────

export interface PushDeps {
  sendChunk: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;
  getReceipts: (ids: string[]) => Promise<Record<string, ExpoPushReceipt>>;
}

let expoClient: Expo | null = null;
const expo = () => (expoClient ??= new Expo());

export const defaultPushDeps: PushDeps = {
  sendChunk: (messages) => expo().sendPushNotificationsAsync(messages),
  getReceipts: (ids) => expo().getPushNotificationReceiptsAsync(ids),
};

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Clears a dead token, but only when the account still has that exact token (never a newer one). */
async function clearTokenIfUnchanged(userId: string, hash: string | null): Promise<void> {
  if (!hash) return;
  await db.execute(sql`
    UPDATE users SET expo_push_token = NULL
    WHERE id = ${userId} AND expo_push_token IS NOT NULL
      AND encode(sha256(convert_to(expo_push_token, 'UTF8')), 'hex') = ${hash}
  `);
}

// ── content and limits ───────────────────────────────────────────────────────

export function checkPushContent(body: unknown): { title: string; body: string } | string {
  const b = (body ?? {}) as { title?: unknown; body?: unknown };
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const text = typeof b.body === "string" ? b.body.trim() : "";
  if (!title) return "Add a title.";
  if (title.length > MAX_TITLE) return `Keep the title to ${MAX_TITLE} characters.`;
  if (/[\r\n]/.test(title)) return "The title must be one line.";
  if (!text) return "Add a message.";
  if (text.length > MAX_BODY) return `Keep the message to ${MAX_BODY} characters.`;
  return { title, body: text };
}

/** New York hour (0 to 23) for a moment. */
export function newYorkHour(now: Date): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", hourCycle: "h23" }).format(now);
  return Number(h) % 24;
}

/** Before 9 AM or from 9 PM in New York. Only a warning on the admin page, never a block. */
export function isQuietHours(now: Date): boolean {
  const h = newYorkHour(now);
  return h < 9 || h >= 21;
}

const NY_DAY_START = sql`(date_trunc('day', now() AT TIME ZONE ${NY}) AT TIME ZONE ${NY})`;

export interface PushLimits {
  sentToday: number; max: number; remaining: number; quietHours: boolean; nowNewYork: string;
}

export async function getPushLimits(now: Date = new Date()): Promise<PushLimits> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS n FROM push_sends WHERE kind = 'announcement' AND created_at >= ${NY_DAY_START}
  `);
  const sentToday = Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
  const nowNewYork = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit" }).format(now);
  return { sentToday, max: PUSH_DAILY_LIMIT, remaining: Math.max(PUSH_DAILY_LIMIT - sentToday, 0), quietHours: isQuietHours(now), nowNewYork };
}

// ── starting a send ──────────────────────────────────────────────────────────

export type StartResult =
  | { ok: true; sendId: string; recipients: number; existing: boolean }
  | { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> };

const running = new Set<string>();

async function findByClientKey(clientKey: string): Promise<{ id: string; recipient_count: number } | undefined> {
  const r = await db.execute(sql`SELECT id, recipient_count FROM push_sends WHERE client_key = ${clientKey}`);
  return r.rows[0] as { id: string; recipient_count: number } | undefined;
}

function pgCode(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return { code: e?.code ?? e?.cause?.code, constraint: e?.constraint ?? e?.cause?.constraint };
}

export async function startPushSend(p: {
  audience: PushAudience; userIds?: string[]; title: string; body: string;
  screen: string; url: string | null; clientKey: string; createdBy: string;
}, deps: PushDeps = defaultPushDeps): Promise<StartResult> {
  const existing = await findByClientKey(p.clientKey);
  if (existing) return { ok: true, sendId: existing.id, recipients: Number(existing.recipient_count), existing: true };

  const dup = await db.execute(sql`
    SELECT 1 FROM push_sends
    WHERE kind = 'announcement' AND title = ${p.title} AND body = ${p.body}
      AND created_at > now() - make_interval(mins => ${DUPLICATE_WINDOW_MINUTES})
    LIMIT 1
  `);
  if (dup.rows.length > 0) {
    return { ok: false, status: 409, code: "DUPLICATE_SEND", message: "You sent this same push in the last 10 minutes." };
  }
  const limits = await getPushLimits();
  if (limits.remaining < 1) {
    return { ok: false, status: 429, code: "OVER_DAILY_LIMIT", message: `You've sent ${PUSH_DAILY_LIMIT} pushes today. Send it tomorrow.`, extra: { limits } };
  }
  const recipients = await countPushRecipients(p.audience, p.userIds);
  if (recipients === 0) {
    return { ok: false, status: 400, code: "NO_RECIPIENTS", message: "Nobody in this group can get a push right now." };
  }

  let sendId: string;
  let logged: number;
  try {
    const r = await db.execute(sql`
      WITH s AS (
        INSERT INTO push_sends (kind, created_by, audience, title, body, screen, url, client_key, status)
        VALUES ('announcement', ${p.createdBy}, ${p.audience}, ${p.title}, ${p.body}, ${p.screen}, ${p.url}, ${p.clientKey}, 'sending')
        RETURNING id
      ), r AS (
        SELECT u.id AS user_id,
               encode(sha256(convert_to(u.expo_push_token, 'UTF8')), 'hex') AS th,
               row_number() OVER (PARTITION BY u.expo_push_token ORDER BY u.created_at, u.id) AS rn
        FROM users u WHERE ${PUSH_ELIGIBLE} AND ${pushAudienceFilter(p.audience, p.userIds)}
      ), l AS (
        INSERT INTO push_log (send_id, user_id, token_hash, status, error)
        SELECT s.id, r.user_id, r.th,
               CASE WHEN r.rn = 1 THEN 'pending' ELSE 'skipped' END,
               CASE WHEN r.rn = 1 THEN NULL ELSE 'duplicate_device' END
        FROM s, r
        RETURNING 1
      )
      SELECT (SELECT id FROM s) AS id, (SELECT count(*)::int FROM l) AS n
    `);
    const row = r.rows[0] as { id: string; n: number };
    sendId = row.id;
    logged = Number(row.n);
  } catch (err) {
    const { code, constraint } = pgCode(err);
    if (code === "23505" && constraint === "push_sends_client_key_uq") {
      const again = await findByClientKey(p.clientKey);
      if (again) return { ok: true, sendId: again.id, recipients: Number(again.recipient_count), existing: true };
    }
    if (code === "23505" && constraint === "push_sends_one_active_uq") {
      return { ok: false, status: 409, code: "SEND_IN_PROGRESS", message: "Another push is still sending. Try again when it finishes." };
    }
    throw err;
  }
  await db.execute(sql`UPDATE push_sends SET recipient_count = ${logged} WHERE id = ${sendId}`);
  setImmediate(() => { void processPushSend(sendId, deps); });
  return { ok: true, sendId, recipients: logged, existing: false };
}

// ── sending ──────────────────────────────────────────────────────────────────

interface ClaimedRow { id: string; user_id: string }

function ticketError(t: ExpoPushTicket): string {
  const e = t as { details?: { error?: string }; message?: string };
  return (e.details?.error || "error").slice(0, 100);
}

/** Sends every pending push of one send, 100 at a time. Safe to call again (never pushes twice). */
export async function processPushSend(sendId: string, deps: PushDeps = defaultPushDeps): Promise<void> {
  if (running.has(sendId)) return;
  running.add(sendId);
  try {
    const s = await db.execute(sql`SELECT id, kind, title, body, screen, url FROM push_sends WHERE id = ${sendId}`);
    const send = s.rows[0] as { id: string; kind: string; title: string; body: string; screen: string | null; url: string | null } | undefined;
    if (!send) return;
    const data: Record<string, string> = { type: "announcement", sendId, screen: send.screen || "activity" };
    if (send.url) data.url = send.url;
    const seen = new Set<string>();

    for (;;) {
      const claimed = await db.execute(sql`
        UPDATE push_log SET status = 'sending'
        WHERE id IN (
          SELECT id FROM push_log WHERE send_id = ${sendId} AND status = 'pending'
          ORDER BY created_at, id LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
        ) AND status = 'pending'
        RETURNING id, user_id
      `);
      const rows = claimed.rows as unknown as ClaimedRow[];
      if (rows.length === 0) break;

      const ids = rows.map((r) => r.user_id);
      const eligibility = send.kind === "test" ? sql`true` : PUSH_ELIGIBLE;
      const u = await db.execute(sql`
        SELECT u.id, u.expo_push_token, (${eligibility}) AS ok
        FROM users u WHERE u.id = ANY(${pgTextArray(ids)}::varchar[])
      `);
      const users = new Map((u.rows as { id: string; expo_push_token: string | null; ok: boolean }[]).map((x) => [x.id, x]));

      const out: { row: ClaimedRow; hash: string; message: ExpoPushMessage }[] = [];
      for (const row of rows) {
        const user = users.get(row.user_id);
        let skip: string | null = null;
        if (!user || user.ok !== true) skip = "no_longer_eligible";
        else if (!user.expo_push_token) skip = "no_token";
        if (skip) {
          await db.execute(sql`UPDATE push_log SET status = 'skipped', error = ${skip} WHERE id = ${row.id}`);
          continue;
        }
        const token = user!.expo_push_token!;
        const hash = tokenHash(token);
        if (!Expo.isExpoPushToken(token)) {
          await db.execute(sql`UPDATE push_log SET status = 'failed', error = 'invalid_token', token_hash = ${hash} WHERE id = ${row.id}`);
          continue;
        }
        if (seen.has(hash)) {
          await db.execute(sql`UPDATE push_log SET status = 'skipped', error = 'duplicate_device', token_hash = ${hash} WHERE id = ${row.id}`);
          continue;
        }
        seen.add(hash);
        // No channelId: same as every other Outsyde push (expoPushService.ts), so Android shows it the same way.
        out.push({ row, hash, message: { to: token, sound: "default", title: send.title, body: send.body, data } });
      }
      if (out.length === 0) continue;

      let tickets: ExpoPushTicket[];
      try {
        tickets = await deps.sendChunk(out.map((o) => o.message));
      } catch (err) {
        // The request failed: Expo may or may not have taken it, so never retry these rows.
        for (const o of out) {
          await db.execute(sql`UPDATE push_log SET status = 'unknown', error = 'send_error', token_hash = ${o.hash} WHERE id = ${o.row.id}`);
        }
        console.error(`[PushBroadcast] send ${sendId}: Expo request failed:`, err instanceof Error ? err.message : String(err));
        continue;
      }
      for (let i = 0; i < out.length; i++) {
        const o = out[i];
        const t = tickets[i];
        if (t && t.status === "ok") {
          await db.execute(sql`UPDATE push_log SET status = 'sent', ticket_id = ${t.id}, token_hash = ${o.hash}, sent_at = now() WHERE id = ${o.row.id}`);
        } else {
          const code = t ? ticketError(t) : "no_ticket";
          await db.execute(sql`UPDATE push_log SET status = 'failed', error = ${code}, token_hash = ${o.hash} WHERE id = ${o.row.id}`);
          if (code === "DeviceNotRegistered") await clearTokenIfUnchanged(o.row.user_id, o.hash);
        }
      }
    }
    if (send.kind === "announcement") await writeActivityRows(sendId);
  } catch (err) {
    console.error(`[PushBroadcast] send ${sendId} stopped:`, err instanceof Error ? err.message : String(err));
  } finally {
    await finishPushSend(sendId).catch((e) => console.error(`[PushBroadcast] finish ${sendId} failed:`, e));
    running.delete(sendId);
  }
}

/**
 * One Activity (notifications) row per recipient account, so people who miss the push still see it.
 * Written for every account the push was meant for, including a second account on the same phone,
 * but not for people who opted out or became ineligible during the send. Never twice per send.
 */
export async function writeActivityRows(sendId: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id, metadata)
    SELECT pl.user_id, 'announcement', s.title, s.body, 'push_send', s.id,
           jsonb_strip_nulls(jsonb_build_object('screen', COALESCE(s.screen, 'activity'), 'url', s.url, 'sendId', s.id))
    FROM push_log pl JOIN push_sends s ON s.id = pl.send_id
    WHERE pl.send_id = ${sendId} AND s.kind = 'announcement' AND pl.user_id IS NOT NULL
      AND (pl.status IN ('sent', 'failed', 'unknown') OR (pl.status = 'skipped' AND pl.error = 'duplicate_device'))
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = pl.user_id AND n.reference_type = 'push_send' AND n.reference_id = s.id
      )
    RETURNING id
  `);
  return r.rows.length;
}

/** Closes a send: rows never tried become failed (not_sent), counts are stored, status done. */
export async function finishPushSend(sendId: string): Promise<void> {
  await db.execute(sql`UPDATE push_log SET status = 'failed', error = 'not_sent' WHERE send_id = ${sendId} AND status IN ('pending', 'sending')`);
  await db.execute(sql`
    UPDATE push_sends SET
      sent_count = (SELECT count(*)::int FROM push_log WHERE send_id = ${sendId} AND status = 'sent'),
      failed_count = (SELECT count(*)::int FROM push_log WHERE send_id = ${sendId} AND status IN ('failed', 'unknown')),
      status = 'done',
      finished_at = COALESCE(finished_at, now())
    WHERE id = ${sendId}
  `);
}

// ── receipts ─────────────────────────────────────────────────────────────────

/** Reads Expo receipts for one finished send: failed pushes are marked, dead tokens cleared. */
export async function checkPushReceipts(sendId: string, deps: PushDeps = defaultPushDeps): Promise<{ checked: number; failed: number }> {
  const r = await db.execute(sql`
    SELECT id, user_id, ticket_id, token_hash FROM push_log WHERE send_id = ${sendId} AND status = 'sent' AND ticket_id IS NOT NULL
  `);
  const rows = r.rows as { id: string; user_id: string; ticket_id: string; token_hash: string | null }[];
  let failed = 0;
  for (let i = 0; i < rows.length; i += RECEIPT_CHUNK) {
    const part = rows.slice(i, i + RECEIPT_CHUNK);
    const receipts = await deps.getReceipts(part.map((x) => x.ticket_id));
    for (const row of part) {
      const rec = receipts[row.ticket_id] as (ExpoPushReceipt & { details?: { error?: string } }) | undefined;
      if (!rec || rec.status !== "error") continue;
      const code = (rec.details?.error || "error").slice(0, 100);
      await db.execute(sql`UPDATE push_log SET status = 'failed', error = ${code} WHERE id = ${row.id}`);
      failed++;
      if (code === "DeviceNotRegistered") await clearTokenIfUnchanged(row.user_id, row.token_hash);
    }
  }
  await db.execute(sql`
    UPDATE push_sends SET
      sent_count = (SELECT count(*)::int FROM push_log WHERE send_id = ${sendId} AND status = 'sent'),
      failed_count = (SELECT count(*)::int FROM push_log WHERE send_id = ${sendId} AND status IN ('failed', 'unknown')),
      receipts_checked_at = now()
    WHERE id = ${sendId}
  `);
  return { checked: rows.length, failed };
}

/** Every finished send from the last 24 hours whose receipts are due and not read yet. */
export async function checkDueReceipts(deps: PushDeps = defaultPushDeps, delayMinutes = RECEIPT_DELAY_MINUTES): Promise<number> {
  const due = await db.execute(sql`
    SELECT id FROM push_sends
    WHERE status = 'done' AND receipts_checked_at IS NULL
      AND finished_at <= now() - make_interval(mins => ${delayMinutes})
      AND finished_at > now() - interval '24 hours'
    ORDER BY finished_at
  `);
  let n = 0;
  for (const row of due.rows as { id: string }[]) {
    try { await checkPushReceipts(row.id, deps); n++; }
    catch (err) { console.error(`[PushBroadcast] receipts for ${row.id} failed:`, err instanceof Error ? err.message : String(err)); }
  }
  return n;
}

/**
 * At boot: pushes caught mid send by a restart may or may not have gone out, so they become
 * 'unknown' (never re-sent). Pending pushes of unfinished sends are then sent.
 */
export async function resumePushSends(deps: PushDeps = defaultPushDeps): Promise<void> {
  try {
    await db.execute(sql`UPDATE push_log SET status = 'unknown', error = 'server_restarted' WHERE status = 'sending'`);
    const open = await db.execute(sql`SELECT id FROM push_sends WHERE status = 'sending'`);
    for (const r of open.rows as { id: string }[]) void processPushSend(r.id, deps);
  } catch (err) {
    console.error("[PushBroadcast] resume failed:", err instanceof Error ? err.message : String(err));
  }
}

let receiptTimer: NodeJS.Timeout | null = null;
/** Reads due receipts every 5 minutes. */
export function startPushReceiptJob(intervalMs = 5 * 60 * 1000): void {
  if (receiptTimer) return;
  receiptTimer = setInterval(() => { void checkDueReceipts(); }, intervalMs);
  receiptTimer.unref?.();
}

// ── test to the admin's own phone ───────────────────────────────────────────

export type TestResult =
  | { ok: true; sendId: string; status: "sent" | "failed"; error: string | null }
  | { ok: false; status: number; code: string; message: string };

/** Pushes to the signed in admin's own phone only. Logged as kind 'test', no Activity row, not counted in the limit. */
export async function sendPushTest(p: {
  adminId: string; title: string; body: string; screen: string; url: string | null;
}, deps: PushDeps = defaultPushDeps): Promise<TestResult> {
  const u = await db.execute(sql`SELECT expo_push_token FROM users WHERE id = ${p.adminId}`);
  const token = (u.rows[0] as { expo_push_token: string | null } | undefined)?.expo_push_token ?? null;
  if (!token || !Expo.isExpoPushToken(token)) {
    return { ok: false, status: 400, code: "NO_TOKEN", message: "Your account has no phone set up for notifications. Sign in on the app and allow notifications." };
  }
  const created = await db.execute(sql`
    WITH s AS (
      INSERT INTO push_sends (kind, created_by, audience, title, body, screen, url, status, recipient_count)
      VALUES ('test', ${p.adminId}, 'me', ${p.title}, ${p.body}, ${p.screen}, ${p.url}, 'sending', 1)
      RETURNING id
    ), l AS (
      INSERT INTO push_log (send_id, user_id, token_hash, status) SELECT s.id, ${p.adminId}, ${tokenHash(token)}, 'pending' FROM s RETURNING 1
    )
    SELECT (SELECT id FROM s) AS id
  `);
  const sendId = (created.rows[0] as { id: string }).id;
  await processPushSend(sendId, deps);
  const r = await db.execute(sql`SELECT status, error FROM push_log WHERE send_id = ${sendId} LIMIT 1`);
  const row = r.rows[0] as { status: string; error: string | null } | undefined;
  return { ok: true, sendId, status: row?.status === "sent" ? "sent" : "failed", error: row?.error ?? null };
}

// ── history ──────────────────────────────────────────────────────────────────

export interface PushSendRow {
  id: string; kind: string; audience: string; title: string; body: string; screen: string | null; url: string | null;
  status: string; recipientCount: number; sentCount: number; failedCount: number; skippedCount: number;
  createdBy: string | null; createdByName: string | null; createdAt: string; finishedAt: string | null; receiptsCheckedAt: string | null;
}

function toSendRow(x: Record<string, unknown>): PushSendRow {
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  return {
    id: String(x.id), kind: String(x.kind), audience: String(x.audience), title: String(x.title), body: String(x.body),
    screen: (x.screen as string | null) ?? null, url: (x.url as string | null) ?? null, status: String(x.status),
    recipientCount: Number(x.recipient_count ?? 0), sentCount: Number(x.sent_count ?? 0), failedCount: Number(x.failed_count ?? 0),
    skippedCount: Number(x.skipped_count ?? 0), createdBy: (x.created_by as string | null) ?? null,
    createdByName: (x.created_by_name as string | null) ?? null, createdAt: iso(x.created_at)!, finishedAt: iso(x.finished_at),
    receiptsCheckedAt: iso(x.receipts_checked_at),
  };
}

const SEND_COLUMNS = sql`s.id, s.kind, s.audience, s.title, s.body, s.screen, s.url, s.status, s.recipient_count, s.sent_count,
  s.failed_count, s.created_by, s.created_at, s.finished_at, s.receipts_checked_at,
  (SELECT count(*)::int FROM push_log pl WHERE pl.send_id = s.id AND pl.status = 'skipped') AS skipped_count,
  (SELECT COALESCE(cu.name, cu.username) FROM users cu WHERE cu.id = s.created_by) AS created_by_name`;

export async function listPushSends(limit = 50, before?: Date): Promise<PushSendRow[]> {
  const n = Math.min(Math.max(limit, 1), 100);
  const r = await db.execute(sql`
    SELECT ${SEND_COLUMNS} FROM push_sends s
    WHERE ${before ? sql`s.created_at < ${before.toISOString()}` : sql`true`}
    ORDER BY s.created_at DESC LIMIT ${n}
  `);
  return (r.rows as Record<string, unknown>[]).map(toSendRow);
}

export interface PushRecipientRow { userId: string | null; name: string | null; role: string | null; status: string; error: string | null; sentAt: string | null }

export async function getPushSend(id: string): Promise<{ send: PushSendRow; recipients: PushRecipientRow[] } | null> {
  const s = await db.execute(sql`SELECT ${SEND_COLUMNS} FROM push_sends s WHERE s.id = ${id}`);
  if (s.rows.length === 0) return null;
  const r = await db.execute(sql`
    SELECT pl.user_id, pl.status, pl.error, pl.sent_at,
           (SELECT ${PUSH_DISPLAY_NAME} FROM users u WHERE u.id = pl.user_id) AS name,
           (SELECT ${PUSH_ROLE} FROM users u WHERE u.id = pl.user_id) AS role
    FROM push_log pl WHERE pl.send_id = ${id}
    ORDER BY pl.created_at, pl.id LIMIT 1000
  `);
  return {
    send: toSendRow(s.rows[0] as Record<string, unknown>),
    recipients: (r.rows as Record<string, unknown>[]).map((x) => ({
      userId: (x.user_id as string | null) ?? null, name: (x.name as string | null) ?? null, role: (x.role as string | null) ?? null,
      status: String(x.status), error: (x.error as string | null) ?? null,
      sentAt: x.sent_at == null ? null : new Date(x.sent_at as string).toISOString(),
    })),
  };
}

// ── "Outsyde news and offers" (the app switch) ──────────────────────────────

export async function getNewsPreference(userId: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM push_news_optouts WHERE user_id = ${userId}`);
  return r.rows.length === 0;
}

export async function setNewsPreference(userId: string, news: boolean): Promise<boolean> {
  if (news) await db.execute(sql`DELETE FROM push_news_optouts WHERE user_id = ${userId}`);
  else await db.execute(sql`INSERT INTO push_news_optouts (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`);
  return getNewsPreference(userId);
}
