/**
 * Admin referrals (referral Step 5b, decided by Legend 2026-10-24): goutsyde.com/admin/referrals.
 *
 * The $25 business payout still pays itself 7 days after qualifying (businessReferrals.ts). Admin can:
 *   Pause    pending or held -> held with hold_reason 'admin_paused' (the payout job never claims it)
 *   Release  admin_paused    -> pending, due now (the job sends it on its next run if the 7 days have passed)
 *   Cancel   pending, held (paused too) or review -> cancelled; no money goes out; can't be undone
 *   Retry    review          -> pending, attempts 0
 * Friend referrals (points) are view only.
 *
 * Mid send guard: the job's claim sets next_attempt_at = now() + 10 minutes and touches updated_at; Stripe may be
 * creating the transfer during that window. Pause and Cancel are refused (PAYOUT_SENDING) while a row looks claimed:
 * pending or held, touched in the last 10 minutes, next try in the future and no more than 10 minutes after the touch.
 * That also covers the first 10 minute backoff after a failure, which is fine: the admin tries again shortly. The job's
 * own ownership check (updated_at tag) is the second layer.
 *
 * Each action is ONE statement with its audit_logs row (neon-http has no transactions). No response carries an email
 * address, a real name or a full Stripe id.
 */
import { sql } from "drizzle-orm";
import { rows } from "../events/eventsRouter";

export const ADMIN_PAUSE_REASON = "admin_paused";
export const ACTION_PAUSE = "referral_payout.pause";
export const ACTION_RELEASE = "referral_payout.release";
export const ACTION_CANCEL = "referral_payout.cancel";
export const ACTION_RETRY = "referral_payout.retry";
const LIST_LIMIT = 500;

/** SQL for "this row may be mid send" (alias p). */
// COALESCE: a NULL next_attempt_at (paused, released, due now) means not sending, never "unknown".
const SENDING = sql`COALESCE(p.status IN ('pending', 'held') AND p.next_attempt_at > now()
  AND p.updated_at > now() - interval '10 minutes'
  AND p.next_attempt_at <= p.updated_at + interval '10 minutes 5 seconds', false)`;

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const mask = (v: unknown): string | null => (typeof v === "string" && v.length > 4 ? `…${v.slice(-4)}` : null);

export type AdminActionResult =
  | { ok: true; payout: { id: string; status: string; holdReason: string | null; attempts: number } }
  | { ok: false; code: "PAYOUT_NOT_FOUND" | "PAYOUT_SENDING" | "NOT_PAUSABLE" | "NOT_PAUSED" | "NOT_CANCELLABLE" | "NOT_IN_REVIEW" };

type Kind = "pause" | "release" | "cancel" | "retry";

/** Runs one admin action as a single statement (cur -> upd -> audit). */
async function act(kind: Kind, payoutId: string, adminId: string): Promise<AdminActionResult> {
  const action = { pause: ACTION_PAUSE, release: ACTION_RELEASE, cancel: ACTION_CANCEL, retry: ACTION_RETRY }[kind];
  const set = {
    pause: sql`status = 'held', hold_reason = ${ADMIN_PAUSE_REASON}, next_attempt_at = NULL, updated_at = now()`,
    release: sql`status = 'pending', hold_reason = NULL, next_attempt_at = NULL, updated_at = now()`,
    cancel: sql`status = 'cancelled', next_attempt_at = NULL, last_error = 'cancelled by admin', updated_at = now()`,
    retry: sql`status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, hold_reason = NULL, alerted_at = NULL, updated_at = now()`,
  }[kind];
  const allowed = {
    pause: sql`p.status IN ('pending', 'held') AND p.hold_reason IS DISTINCT FROM ${ADMIN_PAUSE_REASON} AND NOT ${SENDING}`,
    release: sql`p.status = 'held' AND p.hold_reason = ${ADMIN_PAUSE_REASON}`,
    cancel: sql`p.status IN ('pending', 'held', 'review') AND NOT ${SENDING}`,
    retry: sql`p.status = 'review'`,
  }[kind];

  const [r] = await rows<any>(sql`
    WITH cur AS (
      SELECT p.id, p.status, p.hold_reason, p.attempts, p.last_error, p.business_referral_id, ${SENDING} AS sending
      FROM referral_payouts p WHERE p.id = ${payoutId}
    ),
    upd AS (
      UPDATE referral_payouts p SET ${set}
      WHERE p.id = ${payoutId} AND ${allowed}
      RETURNING p.id, p.status, p.hold_reason, p.attempts, p.last_error
    ),
    aud AS (
      INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, before_state, after_state, metadata)
      SELECT ${adminId}::varchar, 'admin', ${action}::text, 'referral_payout', upd.id,
             jsonb_build_object('status', cur.status, 'hold_reason', cur.hold_reason, 'attempts', cur.attempts, 'last_error', cur.last_error),
             jsonb_build_object('status', upd.status, 'hold_reason', upd.hold_reason, 'attempts', upd.attempts, 'last_error', upd.last_error),
             jsonb_build_object('business_referral_id', cur.business_referral_id)
      FROM upd JOIN cur ON cur.id = upd.id
      RETURNING id
    )
    SELECT (SELECT count(*) FROM cur)::int AS found, (SELECT status FROM cur) AS cur_status,
           (SELECT hold_reason FROM cur) AS cur_hold, (SELECT sending FROM cur) AS cur_sending,
           upd.id, upd.status, upd.hold_reason, upd.attempts, (SELECT count(*) FROM aud)::int AS audited
    FROM (SELECT 1) one LEFT JOIN upd ON true`);

  if (!r || !r.found) return { ok: false, code: "PAYOUT_NOT_FOUND" };
  if (!r.id) {
    const sending = r.cur_sending === true || r.cur_sending === "t";
    if (kind === "pause") return { ok: false, code: sending && r.cur_hold !== ADMIN_PAUSE_REASON ? "PAYOUT_SENDING" : "NOT_PAUSABLE" };
    if (kind === "cancel") return { ok: false, code: sending ? "PAYOUT_SENDING" : "NOT_CANCELLABLE" };
    if (kind === "release") return { ok: false, code: "NOT_PAUSED" };
    return { ok: false, code: "NOT_IN_REVIEW" };
  }
  return { ok: true, payout: { id: r.id, status: r.status, holdReason: r.hold_reason ?? null, attempts: Number(r.attempts) } };
}

export const pauseReferralPayout = (id: string, adminId: string) => act("pause", id, adminId);
export const releaseReferralPayout = (id: string, adminId: string) => act("release", id, adminId);
export const cancelReferralPayout = (id: string, adminId: string) => act("cancel", id, adminId);
export const retryReferralPayout = (id: string, adminId: string) => act("retry", id, adminId);

// ─── Read model ──────────────────────────────────────────────────────────────

export interface AdminBusinessReferral {
  id: string;
  businessName: string;
  referrer: { id: string; username: string | null };
  owner: { username: string | null };
  status: string;
  blockReason: string | null;
  createdAt: string | null;
  qualifiedAt: string | null;
  expiresAt: string | null;
  payout: null | {
    id: string; status: string; paused: boolean; holdReason: string | null; amountCents: number; payableAfter: string | null;
    attempts: number; lastError: string | null; nextAttemptAt: string | null; paidAt: string | null;
    destinationType: string | null; account: string | null; transfer: string | null; sending: boolean;
  };
}
export interface AdminFriendReferral {
  id: string;
  referrer: { id: string; username: string | null };
  friend: { username: string | null };
  status: string;
  referrerPoints: number;
  friendPoints: number;
  firstPurchaseType: string | null;
  createdAt: string | null;
  paidAt: string | null;
}
export interface AttentionItem {
  kind: "review" | "paused" | "waiting_setup" | "waiting_balance";
  payoutId: string;
  businessName: string;
  referrer: string | null;
  since: string | null;
  detail: string | null;
}

export async function listAdminReferrals(): Promise<{
  totals: {
    business: { invited: number; pending: number; qualified: number; expired: number; blocked: number };
    payouts: { paidCents: number; upcomingCents: number; pausedCents: number; reviewCents: number; cancelled: number };
    friends: { total: number; waiting: number; completed: number; pointsAwarded: number };
  };
  attention: AttentionItem[];
  business: AdminBusinessReferral[];
  friends: AdminFriendReferral[];
}> {
  const [biz, fr] = await Promise.all([
    rows<any>(sql`
      SELECT r.id, r.status, r.block_reason, r.created_at, r.qualified_at, r.expires_at, r.referrer_user_id,
             b.name AS business_name, ru.username AS referrer_username, ou.username AS owner_username,
             p.id AS payout_id, p.status AS payout_status, p.hold_reason, p.amount_cents, p.payable_after, p.attempts,
             p.last_error, p.next_attempt_at, p.paid_at, p.destination_type, p.connected_account_id, p.transfer_id,
             p.updated_at AS payout_updated_at, (p.id IS NOT NULL AND ${SENDING}) AS sending
      FROM business_referrals r
      JOIN businesses b ON b.id = r.business_id
      LEFT JOIN users ru ON ru.id = r.referrer_user_id
      LEFT JOIN users ou ON ou.id = r.referred_owner_user_id
      LEFT JOIN referral_payouts p ON p.business_referral_id = r.id
      ORDER BY r.created_at DESC LIMIT ${LIST_LIMIT}`),
    rows<any>(sql`
      SELECT f.id, f.status, f.referrer_bonus_points, f.referred_bonus_points, f.first_transaction_type,
             f.created_at, f.referrer_bonus_paid_at, f.referrer_id, ru.username AS referrer_username, du.username AS friend_username
      FROM referrals f
      LEFT JOIN users ru ON ru.id = f.referrer_id
      LEFT JOIN users du ON du.id = f.referred_user_id
      ORDER BY f.created_at DESC LIMIT ${LIST_LIMIT}`),
  ]);

  const business: AdminBusinessReferral[] = biz.map((x) => ({
    id: x.id,
    businessName: x.business_name,
    referrer: { id: x.referrer_user_id, username: x.referrer_username ?? null },
    owner: { username: x.owner_username ?? null },
    status: x.status,
    blockReason: x.block_reason ?? null,
    createdAt: iso(x.created_at),
    qualifiedAt: iso(x.qualified_at),
    expiresAt: iso(x.expires_at),
    payout: x.payout_id ? {
      id: x.payout_id,
      status: x.payout_status,
      paused: x.payout_status === "held" && x.hold_reason === ADMIN_PAUSE_REASON,
      holdReason: x.hold_reason ?? null,
      amountCents: Number(x.amount_cents),
      payableAfter: iso(x.payable_after),
      attempts: Number(x.attempts ?? 0),
      lastError: x.last_error ?? null,
      nextAttemptAt: iso(x.next_attempt_at),
      paidAt: iso(x.paid_at),
      destinationType: x.destination_type ?? null,
      account: mask(x.connected_account_id),
      transfer: mask(x.transfer_id),
      sending: x.sending === true || x.sending === "t",
    } : null,
  }));

  const friends: AdminFriendReferral[] = fr.map((x) => ({
    id: x.id,
    referrer: { id: x.referrer_id, username: x.referrer_username ?? null },
    friend: { username: x.friend_username ?? null },
    status: x.status,
    referrerPoints: Number(x.referrer_bonus_points ?? 0),
    friendPoints: Number(x.referred_bonus_points ?? 0),
    firstPurchaseType: x.first_transaction_type ?? null,
    createdAt: iso(x.created_at),
    paidAt: iso(x.referrer_bonus_paid_at),
  }));

  const attention: AttentionItem[] = [];
  const weekAgo = Date.now() - 7 * 86400000;
  for (const b of business) {
    const p = b.payout;
    if (!p) continue;
    const base = { payoutId: p.id, businessName: b.businessName, referrer: b.referrer.username };
    if (p.status === "review") attention.push({ ...base, kind: "review", since: p.payableAfter, detail: p.lastError });
    else if (p.paused) attention.push({ ...base, kind: "paused", since: null, detail: null });
    else if (p.status === "held" && (p.holdReason === "no_account" || p.holdReason === "not_complete")
      && p.payableAfter && Date.parse(p.payableAfter) < weekAgo) {
      attention.push({ ...base, kind: "waiting_setup", since: p.payableAfter, detail: p.holdReason });
    } else if (p.status === "pending" && /insufficient/i.test(p.lastError ?? "")) {
      attention.push({ ...base, kind: "waiting_balance", since: p.payableAfter, detail: null });
    }
  }

  const count = (s: string) => business.filter((b) => b.status === s).length;
  const sumPay = (f: (p: NonNullable<AdminBusinessReferral["payout"]>) => boolean) =>
    business.reduce((a, b) => a + (b.payout && f(b.payout) ? b.payout.amountCents : 0), 0);
  return {
    totals: {
      business: { invited: business.length, pending: count("pending"), qualified: count("qualified"), expired: count("expired"), blocked: count("blocked") },
      payouts: {
        paidCents: sumPay((p) => p.status === "paid"),
        upcomingCents: sumPay((p) => (p.status === "pending" || p.status === "held") && !p.paused),
        pausedCents: sumPay((p) => p.paused),
        reviewCents: sumPay((p) => p.status === "review"),
        cancelled: business.filter((b) => b.payout?.status === "cancelled").length,
      },
      friends: {
        total: friends.length,
        waiting: friends.filter((f) => f.status === "pending" || f.status === "qualifying").length,
        completed: friends.filter((f) => f.status === "completed").length,
        pointsAwarded: friends.reduce((a, f) => a + (f.status === "completed" ? f.referrerPoints + f.friendPoints : 0), 0),
      },
    },
    attention,
    business,
    friends,
  };
}
