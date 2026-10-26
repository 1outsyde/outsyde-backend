/**
 * Admin broadcasts: Legend writes his own HTML on goutsyde.com/admin/emails and sends it to an
 * audience through Resend. No AI writes anything, nothing is automatic.
 *
 * Audiences (decided 2026-10-15/16, see vault "Admin Email Pages, Design"):
 *   picked        accounts Legend ticked
 *   vendors       owners of a non demo business that isn't rejected
 *   photographers anyone with a photographers row
 *   consumers     no business, no photographer row, not vendor/photographer flagged, not active staff
 *   all           everyone below
 * Always skipped: no email, inactive, deletion not 'active', admins, demo accounts, and anyone in
 * broadcast_optouts (announcements unsubscribe, separate from account_setup_optouts).
 *
 * Sending runs in the background (the request returns right away with the send id). Each person
 * gets an email_log row first ('pending'); a row is claimed ('sending') before its email goes out
 * and closed as 'sent' or 'failed', so a retry or a restart can never email anyone twice.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { sendViaResend } from "../accountSetup/emails";
import { createSend, finishSend, logEmail, pgTextArray } from "../emailHistory";

export const AUDIENCES = ["picked", "vendors", "photographers", "consumers", "all"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const MAX_SUBJECT = 200;
export const MAX_HTML = 200_000;
export const MAX_PICKED = 500;
/** Pause between emails: about 5 a second, half of Resend's 10 requests a second. */
export const SEND_GAP_MS = 200;

// ── unsubscribe (announcements only) ─────────────────────────────────────────

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("[broadcasts] JWT_SECRET not set");
  return s;
}

export function broadcastUnsubSig(userId: string): string {
  return createHmac("sha256", secret()).update(`broadcast-unsub:${userId}`).digest("hex").slice(0, 32);
}

export function verifyBroadcastUnsubSig(userId: string, sig: string): boolean {
  if (typeof userId !== "string" || typeof sig !== "string" || sig.length !== 32 || !userId) return false;
  const a = Buffer.from(broadcastUnsubSig(userId));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Base for links inside emails (unsubscribe). EMAIL_LINK_BASE_URL points them at our own domain
 * (https://www.goutsyde.com, which relays /api/account-setup/unsubscribe and /api/broadcasts/unsubscribe
 * to this backend) so spam filters don't see links to a different host than the sender. Falls back to
 * API_BASE_URL, so nothing changes until the variable is set. Links already sent keep working because
 * this backend still serves both unsubscribe routes directly.
 */
function emailLinkBaseUrl(): string {
  return (process.env.EMAIL_LINK_BASE_URL || process.env.API_BASE_URL || "https://outsyde-backend.onrender.com").replace(/\/+$/, "");
}

export function broadcastUnsubUrl(userId: string): string {
  return `${emailLinkBaseUrl()}/api/broadcasts/unsubscribe?u=${encodeURIComponent(userId)}&s=${broadcastUnsubSig(userId)}`;
}

// ── rendering ────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** {{first_name}} (any spacing or case) becomes the person's first name, or "there". */
export function personalize(template: string, firstName: string | null, escape: boolean): string {
  const name = (firstName || "").trim() || "there";
  return template.replace(/\{\{\s*first_name\s*\}\}/gi, escape ? escapeHtml(name) : name);
}

/** Rough plain text version of Legend's HTML for the text part of the email. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function unsubscribeFooter(unsubUrl: string): string {
  return `<div style="margin:24px auto 0;max-width:600px;padding:16px 24px;text-align:center;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;line-height:1.6;color:#888888;">You're getting this because you have an Outsyde account. <a href="${unsubUrl}" style="color:#888888;text-decoration:underline;">Unsubscribe from announcements</a>. Booking, order and account emails will still arrive.<br>Outsyde LLC, 54 State Street, Ste 804 #13315, Albany, New York 12207, US</div>`;
}

/** Legend's HTML with the person's name filled in and the unsubscribe footer added. */
export function renderBroadcast(params: { subject: string; html: string; firstName: string | null; unsubUrl: string }): { subject: string; html: string; text: string } {
  const body = personalize(params.html, params.firstName, true);
  const footer = unsubscribeFooter(params.unsubUrl);
  const html = /<\/body>/i.test(body) ? body.replace(/<\/body>/i, `${footer}</body>`) : `${body}${footer}`;
  const text = `${htmlToText(body)}\n\nUnsubscribe from announcements: ${params.unsubUrl}`;
  return { subject: personalize(params.subject, params.firstName, false), html, text };
}

// ── audiences ────────────────────────────────────────────────────────────────

/** Accounts that may receive a broadcast at all (before the audience filter). */
const ELIGIBLE = sql`
  u.email IS NOT NULL
  AND u.is_active = true
  AND u.deletion_status = 'active'
  AND u.is_admin = false
  AND u.id NOT ILIKE 'demo%'
  AND NOT EXISTS (SELECT 1 FROM businesses bd WHERE bd.owner_id = u.id AND COALESCE(bd.is_demo, false) = true)
  AND NOT EXISTS (SELECT 1 FROM photographers pd WHERE pd.user_id = u.id AND COALESCE(pd.is_demo, false) = true)
  AND NOT EXISTS (SELECT 1 FROM broadcast_optouts o WHERE o.user_id = u.id)
`;

export const IS_VENDOR = sql`EXISTS (SELECT 1 FROM businesses b WHERE b.owner_id = u.id AND COALESCE(b.approval_status, 'pending') <> 'rejected')`;
export const IS_PHOTOGRAPHER = sql`EXISTS (SELECT 1 FROM photographers p WHERE p.user_id = u.id)`;
const IS_STAFF = sql`EXISTS (SELECT 1 FROM staff_members s WHERE s.user_id = u.id AND s.status = 'active')`;
export const IS_CONSUMER = sql`(
  NOT EXISTS (SELECT 1 FROM businesses b WHERE b.owner_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM photographers p WHERE p.user_id = u.id)
  AND COALESCE(u.is_vendor, false) = false
  AND COALESCE(u.is_photographer, false) = false
  AND NOT ${IS_STAFF}
)`;

export function audienceFilter(audience: Audience, userIds?: string[]): SQL {
  switch (audience) {
    case "picked": return sql`u.id = ANY(${pgTextArray(userIds ?? [])}::varchar[])`;
    case "vendors": return IS_VENDOR;
    case "photographers": return IS_PHOTOGRAPHER;
    case "consumers": return IS_CONSUMER;
    case "all": return sql`true`;
  }
}

export async function audienceCounts(): Promise<Record<Exclude<Audience, "picked">, number>> {
  const r = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE ${IS_VENDOR})::int AS vendors,
      count(*) FILTER (WHERE ${IS_PHOTOGRAPHER})::int AS photographers,
      count(*) FILTER (WHERE ${IS_CONSUMER})::int AS consumers,
      count(*)::int AS "all"
    FROM users u WHERE ${ELIGIBLE}
  `);
  const row = (r.rows[0] ?? {}) as Record<string, number>;
  return { vendors: Number(row.vendors ?? 0), photographers: Number(row.photographers ?? 0), consumers: Number(row.consumers ?? 0), all: Number(row.all ?? 0) };
}

export async function countRecipients(audience: Audience, userIds?: string[]): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM users u WHERE ${ELIGIBLE} AND ${audienceFilter(audience, userIds)}`);
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
}

const ROLE = sql`CASE
  WHEN EXISTS (SELECT 1 FROM businesses b WHERE b.owner_id = u.id) THEN 'business'
  WHEN EXISTS (SELECT 1 FROM photographers p WHERE p.user_id = u.id) THEN 'photographer'
  WHEN ${IS_STAFF} THEN 'staff'
  ELSE 'consumer' END`;

const DISPLAY_NAME = sql`COALESCE(
  (SELECT b.name FROM businesses b WHERE b.owner_id = u.id LIMIT 1),
  (SELECT p.display_name FROM photographers p WHERE p.user_id = u.id LIMIT 1),
  u.name)`;

export interface PersonRow {
  id: string; email: string | null; name: string | null; role: string;
  canBroadcast: boolean; unsubscribed: boolean;
}

/** Search accounts by name, business name, username or email (for picking and History by person). */
export async function searchPeople(q: string, limit = 20): Promise<PersonRow[]> {
  const term = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const r = await db.execute(sql`
    SELECT u.id, u.email, ${DISPLAY_NAME} AS name, ${ROLE} AS role,
           (${ELIGIBLE}) AS can_broadcast,
           EXISTS (SELECT 1 FROM broadcast_optouts o WHERE o.user_id = u.id) AS unsubscribed
    FROM users u
    WHERE u.deletion_status = 'active'
      AND (u.email ILIKE ${term} OR u.name ILIKE ${term} OR u.username ILIKE ${term}
           OR EXISTS (SELECT 1 FROM businesses b WHERE b.owner_id = u.id AND b.name ILIKE ${term})
           OR EXISTS (SELECT 1 FROM photographers p WHERE p.user_id = u.id AND p.display_name ILIKE ${term}))
    ORDER BY u.created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `);
  return (r.rows as Record<string, unknown>[]).map((x) => ({
    id: String(x.id), email: (x.email as string | null) ?? null, name: (x.name as string | null) ?? null,
    role: String(x.role), canBroadcast: x.can_broadcast === true, unsubscribed: x.unsubscribed === true,
  }));
}

// ── sending ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = new Set<string>();

/**
 * Creates the send and one pending email_log row per recipient in one statement, then sends in
 * the background. Returns the send id and how many people it will go to.
 */
export async function startBroadcast(params: {
  audience: Audience; userIds?: string[]; subject: string; html: string; createdBy: string;
}): Promise<{ sendId: string; recipients: number }> {
  const created = await db.execute(sql`
    INSERT INTO email_sends (kind, created_by, audience, subject, html, status)
    VALUES ('broadcast', ${params.createdBy}, ${params.audience}, ${params.subject}, ${params.html}, 'sending')
    RETURNING id
  `);
  const sendId = (created.rows[0] as { id: string }).id;
  const inserted = await db.execute(sql`
    INSERT INTO email_log (send_id, user_id, kind, status)
    SELECT ${sendId}, u.id, 'broadcast', 'pending'
    FROM users u WHERE ${ELIGIBLE} AND ${audienceFilter(params.audience, params.userIds)}
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const recipients = inserted.rows.length;
  await db.execute(sql`UPDATE email_sends SET recipient_count = ${recipients} WHERE id = ${sendId}`);
  setImmediate(() => { void processSend(sendId); });
  return { sendId, recipients };
}

/** Sends every pending email of one broadcast, one at a time. Safe to call again (no double send). */
export async function processSend(sendId: string, gapMs = SEND_GAP_MS): Promise<void> {
  if (running.has(sendId)) return;
  running.add(sendId);
  try {
    const s = await db.execute(sql`SELECT subject, html FROM email_sends WHERE id = ${sendId} AND kind = 'broadcast'`);
    const send = s.rows[0] as { subject: string; html: string } | undefined;
    if (!send) return;
    for (;;) {
      const claimed = await db.execute(sql`
        UPDATE email_log SET status = 'sending'
        WHERE id = (SELECT id FROM email_log WHERE send_id = ${sendId} AND status = 'pending' ORDER BY created_at, id LIMIT 1)
          AND status = 'pending'
        RETURNING id, user_id
      `);
      const row = claimed.rows[0] as { id: string; user_id: string } | undefined;
      if (!row) break;
      const u = await db.execute(sql`
        SELECT u.email, COALESCE(u.first_name, split_part(u.name, ' ', 1)) AS first_name,
               (${ELIGIBLE}) AS still_eligible
        FROM users u WHERE u.id = ${row.user_id}
      `);
      const person = u.rows[0] as { email: string | null; first_name: string | null; still_eligible: boolean } | undefined;
      if (!person?.email || person.still_eligible !== true) {
        // Unsubscribed, deactivated or deleted since the send started: skip, never email.
        await db.execute(sql`UPDATE email_log SET status = 'failed', error = 'skipped: no longer eligible' WHERE id = ${row.id}`);
        continue;
      }
      try {
        const unsub = broadcastUnsubUrl(row.user_id);
        const built = renderBroadcast({ subject: send.subject, html: send.html, firstName: person.first_name, unsubUrl: unsub });
        const resendId = await sendViaResend({ to: person.email, ...built, unsubscribe: unsub });
        await db.execute(sql`UPDATE email_log SET status = 'sent', resend_id = ${resendId}, sent_at = now() WHERE id = ${row.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.execute(sql`UPDATE email_log SET status = 'failed', error = ${msg.slice(0, 500)} WHERE id = ${row.id}`);
        console.error(`[Broadcasts] email failed for ${row.user_id}:`, msg);
      }
      if (gapMs > 0) await sleep(gapMs);
    }
  } catch (err) {
    console.error(`[Broadcasts] send ${sendId} stopped:`, err);
  } finally {
    await finishSend(sendId);
    running.delete(sendId);
  }
}

/**
 * At boot: emails caught mid send by a restart may or may not have gone out, so they become
 * 'unknown' (never re-sent). Pending emails of unfinished broadcasts are then sent.
 */
export async function resumeBroadcasts(): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE email_log SET status = 'unknown', error = 'server restarted while sending'
      WHERE status = 'sending' AND kind = 'broadcast'
    `);
    const open = await db.execute(sql`
      SELECT DISTINCT send_id FROM email_log WHERE status = 'pending' AND kind = 'broadcast' AND send_id IS NOT NULL
    `);
    for (const r of open.rows as { send_id: string }[]) void processSend(r.send_id);
    const stale = await db.execute(sql`SELECT id FROM email_sends WHERE status = 'sending' AND kind = 'broadcast'`);
    for (const r of stale.rows as { id: string }[]) await finishSend(r.id);
  } catch (err) {
    console.error("[Broadcasts] resume failed:", err);
  }
}

/** Sends the broadcast to the admin only, so he can check it in his inbox. Logged as a test. */
export async function sendBroadcastTest(params: { subject: string; html: string; admin: { id: string; email: string; firstName: string | null } }): Promise<{ sendId: string | null }> {
  const sendId = await createSend({ kind: "broadcast_test", createdBy: params.admin.id, audience: "test", subject: params.subject, recipientCount: 1 });
  const unsub = broadcastUnsubUrl(params.admin.id);
  const built = renderBroadcast({ subject: `[Test] ${params.subject}`, html: params.html, firstName: params.admin.firstName, unsubUrl: unsub });
  try {
    const resendId = await sendViaResend({ to: params.admin.email, ...built, unsubscribe: unsub });
    await logEmail({ sendId, userId: params.admin.id, kind: "broadcast_test", label: "Test", status: "sent", resendId });
  } catch (err) {
    await logEmail({ sendId, userId: params.admin.id, kind: "broadcast_test", label: "Test", status: "failed", error: err instanceof Error ? err.message : String(err) });
    await finishSend(sendId);
    throw err;
  }
  await finishSend(sendId);
  return { sendId };
}
