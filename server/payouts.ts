// server/payouts.ts
//
// Booking payouts (business, staff, photographer) that must always reach the business.
//
// Bookings are platform charges: the customer pays Outsyde, then Outsyde sends the business its
// share (vendor net) by a separate Stripe transfer from Outsyde's balance. Stripe refuses that
// transfer when the AVAILABLE balance is short (new card payments stay pending about 2 days),
// and never retries it. Rules here (Legend 2026-10-18):
//   1. Try the transfer from the available balance (same call, key and amount as before).
//   2. Not enough balance: send what the customer's own charge covers, tied to that charge
//      (source_transaction). Stripe always accepts that and pays it once the charge's funds
//      are available, so the base pay goes through automatically.
//   3. Anything still unpaid (another Stripe error, or the part Outsyde adds when a points code
//      made the charge smaller than the payout) is saved in booking_payout_issues, retried every
//      hour, and Legend gets an email while anything is unpaid (at most once a day per issue,
//      plus right away for a new one).
//   4. Optional, off by default: OUTSYDE_AUTO_TOPUP_MAX_CENTS > 0 lets the job pull the shortfall
//      from Outsyde's bank into Stripe (a Stripe top-up), up to that cap, at most once every 3 days.
//      Stripe never lets a transfer take the balance below zero; a top-up is the closest thing.
// A booking cancelled or refunded before its payout is retried is not paid (status 'dropped').

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { stripeService } from "./stripe/stripeService";

type Kind = 'appointment' | 'shoot_booking';
type Recipient = 'business' | 'staff' | 'photographer';

async function rows<T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result: any = await db.execute(query);
  return (result?.rows ?? result ?? []) as T[];
}

function stripeErrorCode(err: any): string {
  return err?.code || err?.raw?.code || err?.type || 'error';
}

function errorText(err: any): string {
  const msg = err?.message || String(err);
  return `${stripeErrorCode(err)}: ${msg}`.slice(0, 500);
}

function isInsufficientBalance(err: any): boolean {
  return stripeErrorCode(err) === 'balance_insufficient' || /insufficient (available )?funds/i.test(err?.message ?? '');
}

export async function openPayoutIssue(input: {
  kind: Kind;
  bookingId: string;
  recipientKey: string;
  isBase: boolean;
  connectedAccountId: string;
  amountCents: number;
  error: string;
}): Promise<void> {
  if (input.amountCents <= 0) return;
  await rows(sql`
    INSERT INTO booking_payout_issues
      (id, reference_type, reference_id, recipient_key, is_base, connected_account_id, amount_cents, last_error, attempts, last_attempt_at)
    VALUES (${randomUUID()}, ${input.kind}, ${input.bookingId}, ${input.recipientKey}, ${input.isBase},
            ${input.connectedAccountId}, ${input.amountCents}::int, ${input.error}, 1, now())
    ON CONFLICT (reference_type, reference_id, recipient_key) DO NOTHING
  `);
  console.error(`[Payout] UNPAID ${input.kind} ${input.bookingId} ${input.recipientKey} ${input.amountCents}c: ${input.error}`);
}

/**
 * Pay one booking recipient. fastPath is the existing transfer from the available balance.
 * Returns the id of the transfer that paid the base payout (null when it is waiting in
 * booking_payout_issues). Never throws.
 */
export async function payBookingRecipient(input: {
  kind: Kind;
  bookingId: string;
  recipient: Recipient;
  connectedAccountId: string;
  amountCents: number;
  paymentIntentId: string | null;
  fastPath: () => Promise<{ id: string }>;
}): Promise<{ baseTransferId: string | null }> {
  const { kind, bookingId, recipient, connectedAccountId, amountCents, paymentIntentId } = input;
  try {
    const t = await input.fastPath();
    return { baseTransferId: t.id };
  } catch (err) {
    if (!isInsufficientBalance(err) || !paymentIntentId) {
      await openPayoutIssue({ kind, bookingId, recipientKey: recipient, isBase: true, connectedAccountId, amountCents, error: errorText(err) })
        .catch(e => console.error('[Payout] could not record issue:', e));
      await sendPayoutAlertIfDue().catch(e => console.error('[Payout] alert failed:', e));
      return { baseTransferId: null };
    }
  }

  // Not enough available balance: pay what the customer's own charge covers, tied to it.
  let baseTransferId: string | null = null;
  let coveredCents = 0;
  try {
    const charge = await stripeService.getPaymentIntentCharge(paymentIntentId);
    coveredCents = Math.min(amountCents, Math.max(0, charge.amountReceived - charge.amountRefunded));
    if (charge.chargeId && coveredCents > 0) {
      const t = await stripeService.createBookingTransfer({
        kind, bookingId, recipientKey: recipient, connectedAccountId,
        amountInCents: coveredCents,
        sourceTransaction: charge.chargeId,
        idempotencyKey: `transfer_${kind}_${bookingId}_${recipient}_src`,
      });
      baseTransferId = t.id;
      console.log(`[Payout] ${kind} ${bookingId} ${recipient}: ${coveredCents}c sent from the customer's charge (balance was short)`);
    } else {
      coveredCents = 0;
    }
  } catch (err) {
    coveredCents = 0;
    baseTransferId = null;
    await openPayoutIssue({ kind, bookingId, recipientKey: recipient, isBase: true, connectedAccountId, amountCents, error: errorText(err) })
      .catch(e => console.error('[Payout] could not record issue:', e));
  }

  const remainder = amountCents - coveredCents;
  if (baseTransferId && remainder > 0) {
    // The customer paid less than the payout (points code): Outsyde adds the rest from its balance.
    await openPayoutIssue({
      kind, bookingId, recipientKey: `${recipient}_rewards`, isBase: false, connectedAccountId,
      amountCents: remainder, error: 'balance_insufficient: Outsyde balance too low for the rewards part',
    }).catch(e => console.error('[Payout] could not record issue:', e));
  } else if (!baseTransferId && coveredCents === 0) {
    await openPayoutIssue({
      kind, bookingId, recipientKey: recipient, isBase: true, connectedAccountId, amountCents,
      error: 'balance_insufficient: no charge to send it from',
    }).catch(e => console.error('[Payout] could not record issue:', e));
  }
  await sendPayoutAlertIfDue().catch(e => console.error('[Payout] alert failed:', e));
  return { baseTransferId };
}

const RETRY_WINDOW_DAYS = 60;
const PAYABLE_APPOINTMENT_STATES = ['confirmed', 'completed', 'no_show'];
const PAYABLE_SHOOT_STATES = ['confirmed', 'completed', 'no_show'];

interface IssueRow {
  id: string;
  reference_type: Kind;
  reference_id: string;
  recipient_key: string;
  is_base: boolean;
  connected_account_id: string;
  amount_cents: number;
  attempts: number;
  last_error: string | null;
  alerted_at: string | null;
  topup_requested_at: string | null;
  created_at: string;
}

async function bookingState(kind: Kind, id: string): Promise<{ status: string | null; refunded: boolean }> {
  const [r] = kind === 'appointment'
    ? await rows<{ status: string; refund_amount: number | null }>(sql`SELECT status, refund_amount FROM appointments WHERE id = ${id}`)
    : await rows<{ status: string; refund_amount: number | null }>(sql`SELECT status, refund_amount FROM shoot_bookings WHERE id = ${id}`);
  return { status: r?.status ?? null, refunded: (r?.refund_amount ?? 0) > 0 };
}

async function recordBaseTransfer(issue: IssueRow, transferId: string): Promise<void> {
  if (!issue.is_base) return;
  if (issue.reference_type === 'appointment') {
    if (issue.recipient_key === 'staff') {
      await rows(sql`UPDATE appointments SET stripe_transfer_id = ${transferId}, staff_payout = ${issue.amount_cents}::int, updated_at = now()
                     WHERE id = ${issue.reference_id} AND stripe_transfer_id IS NULL`);
    } else {
      await rows(sql`UPDATE appointments SET stripe_transfer_id = ${transferId}, updated_at = now()
                     WHERE id = ${issue.reference_id} AND stripe_transfer_id IS NULL`);
    }
  } else {
    await rows(sql`UPDATE shoot_bookings SET stripe_transfer_id = ${transferId}, updated_at = now()
                   WHERE id = ${issue.reference_id} AND stripe_transfer_id IS NULL`);
  }
}

/** Retry every open payout. Runs hourly. */
export async function retryOpenPayouts(): Promise<{ paid: number; dropped: number; stillOpen: number }> {
  const open = await rows<IssueRow>(sql`
    SELECT * FROM booking_payout_issues
    WHERE status = 'open' AND created_at > now() - make_interval(days => ${RETRY_WINDOW_DAYS}::int)
    ORDER BY created_at
  `);
  let paid = 0;
  let dropped = 0;
  for (const issue of open) {
    const state = await bookingState(issue.reference_type, issue.reference_id);
    const payable = issue.reference_type === 'appointment' ? PAYABLE_APPOINTMENT_STATES : PAYABLE_SHOOT_STATES;
    if (!state.status || !payable.includes(state.status) || state.refunded) {
      await rows(sql`UPDATE booking_payout_issues SET status = 'dropped', resolved_at = now(),
                     last_error = ${`booking is ${state.status ?? 'missing'}${state.refunded ? ', refunded' : ''}; not paid`}
                     WHERE id = ${issue.id} AND status = 'open'`);
      dropped++;
      continue;
    }
    try {
      const t = await stripeService.createBookingTransfer({
        kind: issue.reference_type,
        bookingId: issue.reference_id,
        recipientKey: issue.recipient_key,
        connectedAccountId: issue.connected_account_id,
        amountInCents: issue.amount_cents,
        idempotencyKey: `transfer_${issue.reference_type}_${issue.reference_id}_${issue.recipient_key}_retry_${issue.attempts + 1}`,
      });
      await rows(sql`UPDATE booking_payout_issues SET status = 'paid', transfer_id = ${t.id}, resolved_at = now(),
                     attempts = attempts + 1, last_attempt_at = now()
                     WHERE id = ${issue.id} AND status = 'open'`);
      await recordBaseTransfer(issue, t.id);
      paid++;
      console.log(`[Payout] retried ${issue.reference_type} ${issue.reference_id} ${issue.recipient_key}: paid ${issue.amount_cents}c (${t.id})`);
    } catch (err) {
      await rows(sql`UPDATE booking_payout_issues SET attempts = attempts + 1, last_attempt_at = now(), last_error = ${errorText(err)}
                     WHERE id = ${issue.id} AND status = 'open'`);
    }
  }
  const [left] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM booking_payout_issues WHERE status = 'open'`);
  const stillOpen = Number(left?.n ?? 0);
  if (stillOpen > 0) {
    await maybeTopUp().catch(e => console.error('[Payout] top-up failed:', e));
    await sendPayoutAlertIfDue().catch(e => console.error('[Payout] alert failed:', e));
  }
  return { paid, dropped, stillOpen };
}

/** Optional automatic top-up of the shortfall (OUTSYDE_AUTO_TOPUP_MAX_CENTS, default 0 = off). */
async function maybeTopUp(): Promise<void> {
  const cap = Number(process.env.OUTSYDE_AUTO_TOPUP_MAX_CENTS || 0);
  if (!Number.isFinite(cap) || cap <= 0) return;
  const [recent] = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM booking_payout_issues WHERE topup_requested_at > now() - interval '3 days'
  `);
  if (Number(recent?.n ?? 0) > 0) return;
  const [owed] = await rows<{ cents: number }>(sql`SELECT COALESCE(SUM(amount_cents), 0)::int AS cents FROM booking_payout_issues WHERE status = 'open'`);
  const available = await stripeService.getAvailableBalanceCents();
  const shortfall = Number(owed?.cents ?? 0) - available;
  if (shortfall <= 0) return;
  const amount = Math.min(cap, shortfall);
  const topup = await stripeService.createBalanceTopUp(amount, 'Outsyde booking payouts waiting on balance', `payout_topup_${new Date().toISOString().slice(0, 10)}`);
  await rows(sql`UPDATE booking_payout_issues SET topup_id = ${topup.id}, topup_requested_at = now() WHERE status = 'open'`);
  console.log(`[Payout] requested top-up ${topup.id} for ${amount}c (shortfall ${shortfall}c)`);
}

/** Email Legend about unpaid payouts: right away for a new one, then at most once a day. */
export async function sendPayoutAlertIfDue(): Promise<boolean> {
  const open = await rows<IssueRow>(sql`SELECT * FROM booking_payout_issues WHERE status = 'open' ORDER BY created_at`);
  if (open.length === 0) return false;
  const due = open.some(r => !r.alerted_at || Date.now() - new Date(r.alerted_at).getTime() > 24 * 60 * 60 * 1000);
  if (!due) return false;
  let availableCents: number | null = null;
  try { availableCents = await stripeService.getAvailableBalanceCents(); } catch { /* shown as unknown */ }
  const { sendPayoutAlertToAdmin } = await import('./emailService');
  await sendPayoutAlertToAdmin({
    items: open.map(r => ({
      bookingType: r.reference_type,
      bookingId: r.reference_id,
      recipient: r.recipient_key,
      amountCents: r.amount_cents,
      attempts: r.attempts,
      lastError: r.last_error ?? '',
      since: r.created_at,
      topUpRequested: !!r.topup_requested_at,
    })),
    totalCents: open.reduce((s, r) => s + r.amount_cents, 0),
    availableCents,
    autoTopUpCapCents: Number(process.env.OUTSYDE_AUTO_TOPUP_MAX_CENTS || 0),
  });
  await rows(sql`UPDATE booking_payout_issues SET alerted_at = now() WHERE status = 'open'`);
  return true;
}

export function startPayoutRetryJob(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  const run = () => retryOpenPayouts().catch(err => console.error('[Payout] retry job failed:', err));
  setTimeout(run, 90 * 1000);
  return setInterval(run, intervalMs);
}
