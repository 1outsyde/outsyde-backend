/**
 * Admin events money actions (goutsyde.com/admin/events): Try again, Mark collected, Write off, Email the host.
 * Design: docs/superpowers/specs/2026-10-23-admin-events-money-design.md (actions section).
 *
 * neon-http has no transactions, so each change is ONE statement: the guarded UPDATE (or the email claim) plus its
 * audit_logs row in a CTE. The audit row is inserted from the UPDATE's RETURNING, so it exists only when the update
 * matched. The same statement reads the row as it was (a `cur` CTE sees the statement's snapshot, before the update)
 * to tell "not found" (404) from "not in the right state" (409), and to fill before_state.
 *
 * Audit rows: actor_type 'admin', actor_id = the admin's user id, target_type 'event_payout' or
 * 'event_payout_recovery', target_id = the row id, before_state/after_state = { status, attempts, last_error }.
 * Actions: 'event_payout.retry', 'event_payout_recovery.collected', 'event_payout_recovery.written_off',
 * 'event_payout.email_host'. No email address is ever written to audit_logs, returned or logged.
 */
import { sql } from "drizzle-orm";
import { rows } from "./eventsRouter";
import { startOfNewYorkDay } from "../emailHistory";

export const ACTION_RETRY = "event_payout.retry";
export const ACTION_EMAIL_HOST = "event_payout.email_host";
export const RECOVERY_ACTIONS = ["collected", "written_off"] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];
/** Same total budget as the address reveal job (addressReveal.ts TOTAL_EMAIL_DAILY_CEILING): New York day, all email_log rows. */
export const HOST_EMAIL_DAILY_CEILING = 70;
export const HOST_EMAIL_COOLDOWN_HOURS = 24;

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

export type RetryResult =
  | { ok: true; payout: { id: string; status: string; attempts: number; nextAttemptAt: string | null } }
  | { ok: false; code: "PAYOUT_NOT_FOUND" | "NOT_IN_REVIEW" | "EVENT_NOT_PUBLISHED" };

/**
 * review -> pending, attempts 0, due now, only while the event is published. last_error is cleared: an old text with
 * "insufficient" on a pending row would hold back the daily bank payout (bankPayout.ts computeHeld
 * event_payouts_waiting_balance), and the old text is kept in before_state. hold_reason is cleared (a row held
 * before it went to review keeps it), and alerted_at too, so this new round of tries gets its own hold or balance
 * email. Amount, gross, deducted and transfer_id are never touched (a resent transfer must match one Stripe may have).
 * Nobody can be sending a review row: the job's claim only takes pending or held rows.
 */
export async function retryPayout(payoutId: string, adminId: string): Promise<RetryResult> {
  const [r] = await rows<any>(sql`
    WITH cur AS (
      SELECT p.id, p.status, p.attempts, p.last_error, p.event_id, e.status AS event_status
      FROM event_payouts p JOIN events e ON e.id = p.event_id
      WHERE p.id = ${payoutId}
    ),
    upd AS (
      UPDATE event_payouts p
      SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, hold_reason = NULL,
          alerted_at = NULL, updated_at = now()
      WHERE p.id = ${payoutId} AND p.status = 'review'
        AND EXISTS (SELECT 1 FROM events e WHERE e.id = p.event_id AND e.status = 'published')
      RETURNING p.id, p.status, p.attempts, p.last_error, p.next_attempt_at
    ),
    aud AS (
      INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, before_state, after_state, metadata)
      SELECT ${adminId}::varchar, 'admin', ${ACTION_RETRY}::text, 'event_payout', upd.id,
             jsonb_build_object('status', cur.status, 'attempts', cur.attempts, 'last_error', cur.last_error),
             jsonb_build_object('status', upd.status, 'attempts', upd.attempts, 'last_error', upd.last_error),
             jsonb_build_object('event_id', cur.event_id)
      FROM upd JOIN cur ON cur.id = upd.id
      RETURNING id
    )
    SELECT (SELECT count(*) FROM cur)::int AS found, (SELECT status FROM cur) AS cur_status,
           (SELECT event_status FROM cur) AS event_status,
           upd.id, upd.status, upd.attempts, upd.next_attempt_at, (SELECT count(*) FROM aud)::int AS audited
    FROM (SELECT 1) one LEFT JOIN upd ON true`);
  if (!r || !r.found) return { ok: false, code: "PAYOUT_NOT_FOUND" };
  if (!r.id) {
    // Cancelled or paused events can't be paid: the job would put it straight back in review (or on hold).
    if (r.cur_status === "review" && r.event_status !== "published") return { ok: false, code: "EVENT_NOT_PUBLISHED" };
    return { ok: false, code: "NOT_IN_REVIEW" };
  }
  return { ok: true, payout: { id: r.id, status: r.status, attempts: Number(r.attempts), nextAttemptAt: iso(r.next_attempt_at) } };
}

export type ResolveResult =
  | { ok: true; recovery: { id: string; status: string; resolvedAt: string | null } }
  | { ok: false; code: "RECOVERY_NOT_FOUND" | "NOT_OWED" };

/**
 * owed -> collected or written_off. Every reader that deducts or alerts matches status 'owed' only
 * (createDuePayouts ow/rec, alertOldOwed, notifyOwedSellers), so a resolved row drops out of the next payout's
 * deduction. A payout being created at the same moment either took the row first (this matches 0 rows: 409) or
 * its GUARD_PAYOUT_DEDUCT undoes that payout statement and the next run recomputes without it.
 */
export async function resolveRecovery(recoveryId: string, action: RecoveryAction, adminId: string): Promise<ResolveResult> {
  const [r] = await rows<any>(sql`
    WITH cur AS (
      SELECT r.id, r.status, r.attempts, r.last_error, r.payout_id FROM event_payout_recoveries r WHERE r.id = ${recoveryId}
    ),
    upd AS (
      UPDATE event_payout_recoveries
      SET status = ${action}::text, resolved_at = now(), resolved_by = ${adminId}::varchar, next_attempt_at = NULL, updated_at = now()
      WHERE id = ${recoveryId} AND status = 'owed'
      RETURNING id, status, attempts, last_error, resolved_at
    ),
    aud AS (
      INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, before_state, after_state, metadata)
      SELECT ${adminId}::varchar, 'admin', 'event_payout_recovery.' || upd.status, 'event_payout_recovery', upd.id,
             jsonb_build_object('status', cur.status, 'attempts', cur.attempts, 'last_error', cur.last_error),
             jsonb_build_object('status', upd.status, 'attempts', upd.attempts, 'last_error', upd.last_error),
             jsonb_build_object('payout_id', cur.payout_id)
      FROM upd JOIN cur ON cur.id = upd.id
      RETURNING id
    )
    SELECT (SELECT count(*) FROM cur)::int AS found, upd.id, upd.status, upd.resolved_at, (SELECT count(*) FROM aud)::int AS audited
    FROM (SELECT 1) one LEFT JOIN upd ON true`);
  if (!r || !r.found) return { ok: false, code: "RECOVERY_NOT_FOUND" };
  if (!r.id) return { ok: false, code: "NOT_OWED" };
  return { ok: true, recovery: { id: r.id, status: r.status, resolvedAt: iso(r.resolved_at) } };
}

/** The payout, its event and the host's account email (server side only: never returned or logged). */
export async function loadHostEmailTarget(payoutId: string): Promise<{
  id: string; status: string; eventId: string; title: string; toEmail: string | null; toUserId: string | null;
} | null> {
  // Recipient by host type, same branching as the payout job's destination (createDuePayouts dst): the business
  // owner's user, the photographer's user, otherwise the host user.
  const [r] = await rows<any>(sql`
    SELECT p.id, p.status, e.id AS event_id, e.title,
           CASE WHEN e.host_type = 'business' AND e.host_business_id IS NOT NULL THEN bo.email
                WHEN e.host_type = 'photographer' AND e.host_photographer_id IS NOT NULL THEN pu.email
                ELSE hu.email END AS to_email,
           CASE WHEN e.host_type = 'business' AND e.host_business_id IS NOT NULL THEN bo.id
                WHEN e.host_type = 'photographer' AND e.host_photographer_id IS NOT NULL THEN pu.id
                ELSE hu.id END AS to_user_id
    FROM event_payouts p
    JOIN events e ON e.id = p.event_id
    LEFT JOIN users hu ON hu.id = e.host_user_id
    LEFT JOIN businesses b ON b.id = e.host_business_id
    LEFT JOIN users bo ON bo.id = b.owner_id
    LEFT JOIN photographers ph ON ph.id = e.host_photographer_id
    LEFT JOIN users pu ON pu.id = ph.user_id
    WHERE p.id = ${payoutId}`);
  if (!r) return null;
  return {
    id: r.id, status: r.status, eventId: r.event_id, title: r.title,
    toEmail: r.to_email ? String(r.to_email).trim() || null : null, toUserId: r.to_user_id ?? null,
  };
}

export type EmailClaim =
  | { ok: true; auditId: string }
  | { ok: false; code: "NOT_HELD_OR_REVIEW" | "EMAIL_RECENTLY_SENT" | "EMAIL_BUDGET" };

/**
 * Takes the right to send one host email for this payout, BEFORE sending, in one statement: inserts the audit row
 * only while the payout is held or in review, no email_host row for it exists in the last 24 hours, and today's
 * email_log total (New York day, all kinds, the address reveal rule) is under 70.
 *
 * Double click: the audit row's id is derived from the payout id and the id of the newest earlier email_host row
 * for it (or "first"). Two requests at the same moment read the same newest row, so they build the same id and the
 * primary key lets exactly one insert land (the other waits for it, then ON CONFLICT DO NOTHING inserts nothing and
 * gets 429). A row with that id can't exist already: it would be newer than the newest row.
 */
export async function claimHostEmail(payoutId: string, adminId: string, kind: string, now: Date = new Date()): Promise<EmailClaim> {
  const dayStart = startOfNewYorkDay(now).toISOString();
  const [r] = await rows<any>(sql`
    WITH p AS (
      SELECT id, status, attempts, last_error, event_id FROM event_payouts WHERE id = ${payoutId} AND status IN ('held', 'review')
    ),
    prev AS (
      SELECT id, created_at FROM audit_logs
      WHERE action = ${ACTION_EMAIL_HOST}::text AND target_type = 'event_payout' AND target_id = ${payoutId}
      ORDER BY created_at DESC, id DESC LIMIT 1
    ),
    recent AS (
      SELECT 1 FROM prev
      WHERE prev.created_at > (now() AT TIME ZONE 'UTC') - make_interval(hours => ${HOST_EMAIL_COOLDOWN_HOURS}::int)
    ),
    sent AS (
      SELECT count(*)::int AS n FROM email_log
      WHERE created_at >= ${dayStart}::timestamptz AND created_at < ${dayStart}::timestamptz + interval '1 day'
    ),
    ins AS (
      INSERT INTO audit_logs (id, actor_id, actor_type, action, target_type, target_id, before_state, after_state, metadata)
      SELECT md5('event_payout.email_host:' || p.id || ':' || COALESCE((SELECT id FROM prev), 'first'))::uuid::text,
             ${adminId}::varchar, 'admin', ${ACTION_EMAIL_HOST}::text, 'event_payout', p.id,
             jsonb_build_object('status', p.status, 'attempts', p.attempts, 'last_error', p.last_error),
             jsonb_build_object('status', p.status, 'attempts', p.attempts, 'last_error', p.last_error),
             jsonb_build_object('event_id', p.event_id, 'notice', ${kind}::text)
      FROM p
      WHERE NOT EXISTS (SELECT 1 FROM recent) AND (SELECT n FROM sent) < ${HOST_EMAIL_DAILY_CEILING}
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    SELECT (SELECT id FROM ins) AS audit_id, EXISTS (SELECT 1 FROM p) AS eligible, EXISTS (SELECT 1 FROM recent) AS recent,
           (SELECT n FROM sent) AS sent_today`);
  if (r?.audit_id) return { ok: true, auditId: String(r.audit_id) };
  if (!r?.eligible) return { ok: false, code: "NOT_HELD_OR_REVIEW" };
  if (r.recent) return { ok: false, code: "EMAIL_RECENTLY_SENT" };
  if (Number(r.sent_today) >= HOST_EMAIL_DAILY_CEILING) return { ok: false, code: "EMAIL_BUDGET" };
  // Lost the race to a request that inserted the same id at the same moment.
  return { ok: false, code: "EMAIL_RECENTLY_SENT" };
}

/** The send failed: give the claim back so the admin can try again. */
export async function releaseHostEmail(auditId: string): Promise<void> {
  await rows<any>(sql`DELETE FROM audit_logs WHERE id = ${auditId} AND action = ${ACTION_EMAIL_HOST}::text RETURNING id`);
}

/** Subject and body by payout state (spec copy: real punctuation, no dashes, no fee percentage). */
export function hostEmailCopy(status: "held" | "review", eventTitle: string): { subject: string; text: string } {
  const title = eventTitle.trim();
  if (status === "held") {
    return {
      subject: `Your payout for ${title} is waiting`,
      text: `Your payout for ${title} is waiting. Finish your payout setup so we can send your earnings.`,
    };
  }
  return {
    subject: `We couldn't send your payout for ${title}`,
    text: `We couldn't send your payout for ${title}. Please check your payout account details in Stripe, then reply to this email.`,
  };
}
