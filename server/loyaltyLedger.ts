// server/loyaltyLedger.ts
//
// Outsyde loyalty points: the rules and every write to balances.
//
// Rules (decided by Legend 2026-10-17):
//   - Points are worth half the service fee the customer paid through Outsyde
//     (= 4% of the base price). Tiers are 500 points per $1 (2500 = $5 ... 50000 = $100),
//     so points = gross charged x 20 / 108 (gross = base + service fee, before any code discount).
//   - Bookings (appointments, staff, photographer shoots) earn as PENDING. Pending points are
//     released when the business marks the booking complete, or automatically 3 days after the
//     appointment / shoot time if it was not cancelled. Any cancel, decline, expiry or no-show
//     rejects them.
//   - Product orders credit right away (refunds reverse them).
//   - Referrals (rules decided by Legend 2026-10-23): when the referred friend's first paid
//     purchase of at least $10 (base) is final, both people get 2,500 points ($5 each). A code can
//     be applied once per person, within 30 days of signing up, and only by a new customer (no
//     standing $10+ purchase and no paid event ticket yet; refunded or cancelled purchases and
//     purchases under $10 don't count). A purchase only qualifies if no earlier standing $10+
//     purchase exists. Nothing is paid if they buy from the referrer's own business, staff profile
//     or photographer profile. Max 50 successful referrals per referrer.
//   - Product orders: a promo code can only be used when the order base is at least 10x the code
//     value, so the discount never cuts into the vendor's payout (product charges are destination
//     charges: the charge must cover the transfer).
//   - Bookings (decided 2026-10-18, replaces the 2026-10-17 "$1 now" rule): the same 10x rule,
//     measured on what is paid online now before the service fee (the deposit, or the full price
//     when there is no deposit). A $30 deposit takes no code; a $50 deposit takes up to $5. So the
//     discount always fits inside Outsyde's 10% of that charge and never needs Outsyde's balance.
//     Booking charges land on the platform balance and the seller is paid its full share by a
//     separate transfer, so the discount never touches the seller either way.
//   - A code is held by one checkout at a time ('reserved'), marked 'used' when that payment
//     succeeds, and given back ('active') when the checkout is abandoned, voided, or the purchase
//     is cancelled with a full refund.
//
// Why raw SQL: the neon-http driver has no transactions (db.transaction() always throws, R2).
// Every balance change below is ONE SQL statement (data-modifying CTEs), so it either fully
// happens or not at all. Duplicates are blocked by uq_point_tx_earn_redeem_ref (migration 048):
// a retried webhook hits a unique violation, the whole statement rolls back, and we report
// "already done" instead of crediting twice.

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";

// ── Rules ────────────────────────────────────────────────────────────────

export const POINTS_PER_DOLLAR = 500;
export const REFERRAL_BONUS_POINTS = 2500;
export const MAX_SUCCESSFUL_REFERRALS = 50;
export const REFERRAL_MIN_BASE_CENTS = 1000;
export const REFERRAL_APPLY_WINDOW_DAYS = 30;
export const AUTO_RELEASE_DAYS = 3;
export const PROMO_MIN_BASE_MULTIPLIER = 10;
export const REDEMPTION_TIERS: ReadonlyArray<{ points: number; valueCents: number }> = [
  { points: 2500, valueCents: 500 },
  { points: 5000, valueCents: 1000 },
  { points: 12500, valueCents: 2500 },
  { points: 25000, valueCents: 5000 },
  { points: 50000, valueCents: 10000 },
];
export const PROMO_CODE_DAYS = 30;
/** Kept for imports; no longer the booking rule (bookings use the 10x rule since 2026-10-18). */
export const BOOKING_MIN_CHARGE_CENTS = 100;

/**
 * Largest code (cents) a booking charging dueNowCents now can take: a tenth of what is paid
 * online before the service fee. dueNowCents = base + round(base x 8%) (quoteDeposit), and
 * baseFromGrossCents recovers that base exactly for every whole-cent base (tested).
 */
export function bookingMaxDiscountCents(dueNowCents: number): number {
  if (!Number.isFinite(dueNowCents) || dueNowCents <= 0) return 0;
  return Math.floor(baseFromGrossCents(dueNowCents) / PROMO_MIN_BASE_MULTIPLIER);
}

/** Points for a purchase: half the service fee, at 500 points per $1. gross = base + 8% fee. */
export function pointsForGrossCents(grossCents: number): number {
  if (!Number.isFinite(grossCents) || grossCents <= 0) return 0;
  return Math.round(grossCents * 20 / 108);
}

/** Dollar value (cents) of a points amount: 500 points = 100 cents. */
export function pointsValueCents(points: number): number {
  return Math.floor((points * 100) / POINTS_PER_DOLLAR);
}

/** Base price (before the service fee) from a gross charge. */
export function baseFromGrossCents(grossCents: number): number {
  return Math.round(grossCents / 1.08);
}

/** Smallest order base (cents) a code of this value may be used on. */
export function promoMinimumBaseCents(discountCents: number): number {
  return discountCents * PROMO_MIN_BASE_MULTIPLIER;
}

/** When pending booking points may auto-release: the booking date/time + AUTO_RELEASE_DAYS. */
export function releaseAfterForBooking(date: string | null | undefined, time: string | null | undefined): Date {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date! : null;
  const hhmm = /^\d{2}:\d{2}/.test(time ?? '') ? time!.slice(0, 5) : '23:59';
  const base = day ? new Date(`${day}T${hhmm}:00Z`) : new Date();
  const when = Number.isNaN(base.getTime()) ? new Date() : base;
  return new Date(when.getTime() + AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

async function rows<T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result: any = await db.execute(query);
  return (result?.rows ?? result ?? []) as T[];
}

// ── Credits ──────────────────────────────────────────────────────────────

export interface CreditInput {
  userId: string;
  points: number;
  dollarAmountCents: number;
  businessId?: string | null;
  businessName?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  description?: string | null;
}

/**
 * Add points to a user's balance and write the 'earn' ledger row, in one statement.
 * Returns the new ledger row id, or null when this reference was already credited.
 */
export async function creditPoints(input: CreditInput): Promise<{ id: string; balanceAfter: number } | null> {
  const points = Math.trunc(input.points);
  if (points <= 0) return null;
  const id = randomUUID();
  try {
    const result = await rows<{ id: string; balance_after: number }>(sql`
      WITH upd AS (
        UPDATE users SET loyalty_points = loyalty_points + ${points}
        WHERE id = ${input.userId}
        RETURNING loyalty_points
      ), ins AS (
        INSERT INTO point_transactions
          (id, user_id, type, points, dollar_amount_cents, business_id, business_name,
           reference_type, reference_id, balance_after, description, capped)
        SELECT ${id}, ${input.userId}, 'earn', ${points}, ${Math.trunc(input.dollarAmountCents)},
               ${input.businessId ?? null}, ${input.businessName ?? null},
               ${input.referenceType ?? null}, ${input.referenceId ?? null},
               upd.loyalty_points, ${input.description ?? `Earned ${points} points`}, false
        FROM upd
        RETURNING id, balance_after
      )
      SELECT id, balance_after FROM ins
    `);
    if (!result[0]) throw new Error(`User ${input.userId} not found`);
    return { id: result[0].id, balanceAfter: Number(result[0].balance_after) };
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

// ── Redemption ───────────────────────────────────────────────────────────

function newPromoCode(discountCents: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let random = '';
  for (let i = 0; i < 4; i++) random += chars[Math.floor(Math.random() * chars.length)];
  return `OP-${random}-${discountCents / 100}`;
}

export type RedeemResult =
  | { ok: true; code: string; codeId: string; discountCents: number; expiresAt: Date; newBalance: number; transactionId: string }
  | { ok: false; error: string };

/**
 * Trade points for a single-use code: takes the points, writes the 'redeem' ledger row and creates
 * the code in one statement. Refuses (and takes nothing) if the balance is short or the user
 * already has an unexpired active code of the same value.
 */
export async function redeemPointsForCode(userId: string, points: number): Promise<RedeemResult> {
  const tier = REDEMPTION_TIERS.find(t => t.points === points);
  if (!tier) {
    return { ok: false, error: `Invalid redemption amount. Points must be one of: ${REDEMPTION_TIERS.map(t => t.points).join(', ')}` };
  }
  const expiresAt = new Date(Date.now() + PROMO_CODE_DAYS * 24 * 60 * 60 * 1000);

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newPromoCode(tier.valueCents);
    const txId = randomUUID();
    try {
      const result = await rows<{ balance: number; code_id: string; code: string }>(sql`
        WITH upd AS (
          UPDATE users SET loyalty_points = loyalty_points - ${tier.points}
          WHERE id = ${userId}
            AND loyalty_points >= ${tier.points}
            AND NOT EXISTS (
              SELECT 1 FROM promo_codes
              WHERE user_id = ${userId} AND discount_cents = ${tier.valueCents}
                AND status IN ('active', 'reserved') AND expires_at > now()
            )
          RETURNING loyalty_points
        ), pc AS (
          INSERT INTO promo_codes (code, user_id, points_cost, discount_cents, status, expires_at)
          SELECT ${code}, ${userId}, ${tier.points}, ${tier.valueCents}, 'active', ${expiresAt.toISOString()}::timestamp
          FROM upd
          RETURNING id, code
        ), tx AS (
          INSERT INTO point_transactions
            (id, user_id, type, points, dollar_amount_cents, reference_type, reference_id,
             balance_after, description, capped)
          SELECT ${txId}, ${userId}, 'redeem', ${tier.points}, ${tier.valueCents}, 'promo_code', pc.id,
                 upd.loyalty_points,
                 ${`Redeemed ${tier.points} points for a $${(tier.valueCents / 100).toFixed(2)} code`}, false
          FROM upd, pc
          RETURNING id
        )
        SELECT upd.loyalty_points AS balance, pc.id AS code_id, pc.code AS code FROM upd, pc, tx
      `);
      if (result[0]) {
        return {
          ok: true,
          code: result[0].code,
          codeId: result[0].code_id,
          discountCents: tier.valueCents,
          expiresAt,
          newBalance: Number(result[0].balance),
          transactionId: txId,
        };
      }
      // Nothing changed: work out why (read-only).
      const [state] = await rows<{ balance: number | null; active_code: string | null }>(sql`
        SELECT (SELECT loyalty_points FROM users WHERE id = ${userId}) AS balance,
               (SELECT code FROM promo_codes
                 WHERE user_id = ${userId} AND discount_cents = ${tier.valueCents}
                   AND status IN ('active', 'reserved') AND expires_at > now()
                 ORDER BY created_at DESC LIMIT 1) AS active_code
      `);
      if (state?.balance === null || state?.balance === undefined) return { ok: false, error: 'User not found' };
      if (state.active_code) {
        return { ok: false, error: `You already have an active $${tier.valueCents / 100} code: ${state.active_code}. Use it before generating a new one.` };
      }
      return { ok: false, error: `Insufficient points. You have ${Number(state.balance)} points but tried to redeem ${tier.points}` };
    } catch (err) {
      // A random code that already exists: the whole statement rolled back, try a new code.
      if (isUniqueViolation(err) && attempt < 2) continue;
      throw err;
    }
  }
  return { ok: false, error: 'Could not create a code. Please try again.' };
}

export type PromoRefType = 'order' | 'appointment' | 'shoot_booking';
export interface PromoRef { type: PromoRefType; id: string }

/**
 * Mark a code used and copy it onto the order / appointment / shoot booking, in one statement.
 * Called when the payment that carried the code succeeds. The code is consumed by that payment,
 * so it is accepted while active or reserved (by any checkout), and a repeat for the same
 * reference is a no-op success. Throws 'Code is no longer valid' if it was already used elsewhere
 * or given back.
 */
export async function applyPromoCodeAtomic(
  codeId: string,
  referenceType: PromoRefType,
  referenceId: string,
): Promise<void> {
  const result = await rows<{ n: number }>(sql`
    WITH used AS (
      UPDATE promo_codes
      SET status = 'used',
          used_at = CASE WHEN status = 'used' THEN used_at ELSE now() END,
          used_on_order_id = ${referenceId}, used_on_reference_type = ${referenceType}
      WHERE id = ${codeId}
        AND (status IN ('active', 'reserved')
          OR (status = 'used' AND used_on_order_id = ${referenceId} AND used_on_reference_type = ${referenceType}))
      RETURNING code, discount_cents, points_cost
    ), o AS (
      UPDATE orders SET promo_code_used = used.code, discount_amount_cents = used.discount_cents, points_redeemed = used.points_cost
      FROM used WHERE orders.id = ${referenceId} AND ${referenceType}::text = 'order'
      RETURNING orders.id
    ), a AS (
      UPDATE appointments SET promo_code_used = used.code, discount_amount_cents = used.discount_cents, points_redeemed = used.points_cost
      FROM used WHERE appointments.id = ${referenceId} AND ${referenceType}::text = 'appointment'
      RETURNING appointments.id
    ), s AS (
      UPDATE shoot_bookings SET promo_code_used = used.code, discount_amount_cents = used.discount_cents, points_redeemed = used.points_cost
      FROM used WHERE shoot_bookings.id = ${referenceId} AND ${referenceType}::text = 'shoot_booking'
      RETURNING shoot_bookings.id
    )
    SELECT (SELECT count(*) FROM used)::int AS n
  `);
  if (!result[0] || Number(result[0].n) === 0) throw new Error('Code is no longer valid');
}

// ── Code holds (one checkout at a time) ──────────────────────────────────

export interface PromoCodeRow {
  id: string;
  code: string;
  userId: string;
  discountCents: number;
  pointsCost: number;
  status: string;
  expiresAt: Date;
  refType: string | null;
  refId: string | null;
}

function toPromoRow(r: any): PromoCodeRow {
  return {
    id: r.id,
    code: r.code,
    userId: r.user_id,
    discountCents: Number(r.discount_cents),
    pointsCost: Number(r.points_cost),
    status: r.status,
    expiresAt: new Date(r.expires_at),
    refType: r.used_on_reference_type ?? null,
    refId: r.used_on_order_id ?? null,
  };
}

export async function getPromoCodeRow(codeId: string): Promise<PromoCodeRow | undefined> {
  const [r] = await rows(sql`
    SELECT id, code, user_id, discount_cents, points_cost, status, expires_at, used_on_reference_type, used_on_order_id
    FROM promo_codes WHERE id = ${codeId}
  `);
  return r ? toPromoRow(r) : undefined;
}

export async function getPromoCodeRowByCode(code: string): Promise<PromoCodeRow | undefined> {
  const [r] = await rows(sql`
    SELECT id, code, user_id, discount_cents, points_cost, status, expires_at, used_on_reference_type, used_on_order_id
    FROM promo_codes WHERE code = ${code}
  `);
  return r ? toPromoRow(r) : undefined;
}

export type ReserveResult =
  | { ok: true; code: PromoCodeRow }
  | { ok: false; reason: 'not_found' | 'not_yours' | 'expired' | 'used' }
  | { ok: false; reason: 'held'; heldBy: PromoRef; code: PromoCodeRow };

/**
 * Hold a code for one checkout (an order, appointment or shoot booking). Succeeds when the code
 * is the user's, unexpired, and active or already held by this same checkout. When another
 * checkout holds it, reports which one (the caller decides whether it can take it over).
 */
export async function reservePromoCode(codeId: string, userId: string, ref: PromoRef): Promise<ReserveResult> {
  const [r] = await rows(sql`
    UPDATE promo_codes
    SET status = 'reserved', used_on_reference_type = ${ref.type}, used_on_order_id = ${ref.id}
    WHERE id = ${codeId} AND user_id = ${userId} AND expires_at > now()
      AND (status = 'active'
        OR (status = 'reserved' AND used_on_reference_type = ${ref.type} AND used_on_order_id = ${ref.id}))
    RETURNING id, code, user_id, discount_cents, points_cost, status, expires_at, used_on_reference_type, used_on_order_id
  `);
  if (r) return { ok: true, code: toPromoRow(r) };
  const row = await getPromoCodeRow(codeId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.userId !== userId) return { ok: false, reason: 'not_yours' };
  if (row.status === 'used') return { ok: false, reason: 'used' };
  if (row.expiresAt.getTime() <= Date.now() || row.status === 'expired') return { ok: false, reason: 'expired' };
  if (row.status === 'reserved' && row.refType && row.refId) {
    return { ok: false, reason: 'held', heldBy: { type: row.refType as PromoRefType, id: row.refId }, code: row };
  }
  return { ok: false, reason: 'not_found' };
}

/** Move a hold from one checkout to another, only if `from` still holds it. */
export async function movePromoReservation(codeId: string, from: PromoRef, to: PromoRef): Promise<PromoCodeRow | null> {
  const [r] = await rows(sql`
    UPDATE promo_codes
    SET used_on_reference_type = ${to.type}, used_on_order_id = ${to.id}
    WHERE id = ${codeId} AND status = 'reserved'
      AND used_on_reference_type = ${from.type} AND used_on_order_id = ${from.id}
    RETURNING id, code, user_id, discount_cents, points_cost, status, expires_at, used_on_reference_type, used_on_order_id
  `);
  return r ? toPromoRow(r) : null;
}

/** True while this checkout still holds the code. */
export async function isPromoReservedFor(codeId: string, ref: PromoRef): Promise<boolean> {
  const [r] = await rows(sql`
    SELECT 1 AS ok FROM promo_codes
    WHERE id = ${codeId} AND status = 'reserved'
      AND used_on_reference_type = ${ref.type} AND used_on_order_id = ${ref.id}
  `);
  return !!r;
}

/**
 * Give back a code this checkout holds but never paid with (abandoned, voided, declined,
 * expired). A code that was used is untouched. Optional codeId limits it to one code.
 * Returns the codes given back.
 */
export async function releasePromoReservation(ref: PromoRef, codeId?: string): Promise<string[]> {
  const result = await rows<{ id: string }>(sql`
    UPDATE promo_codes
    SET status = 'active', used_on_reference_type = NULL, used_on_order_id = NULL
    WHERE status = 'reserved'
      AND used_on_reference_type = ${ref.type} AND used_on_order_id = ${ref.id}
      AND (${codeId ?? null}::varchar IS NULL OR id = ${codeId ?? null}::varchar)
    RETURNING id
  `);
  return result.map(r => r.id);
}

/** True when this checkout holds at least one code. */
export async function refHoldsAnyPromo(ref: PromoRef): Promise<boolean> {
  const [r] = await rows(sql`
    SELECT 1 AS ok FROM promo_codes
    WHERE status = 'reserved' AND used_on_reference_type = ${ref.type} AND used_on_order_id = ${ref.id}
    LIMIT 1
  `);
  return !!r;
}

/** Give back every code this checkout holds except keepCodeId (null = give back all of them). */
export async function releasePromoReservationsExcept(ref: PromoRef, keepCodeId: string | null): Promise<string[]> {
  const result = await rows<{ id: string }>(sql`
    UPDATE promo_codes
    SET status = 'active', used_on_reference_type = NULL, used_on_order_id = NULL
    WHERE status = 'reserved'
      AND used_on_reference_type = ${ref.type} AND used_on_order_id = ${ref.id}
      AND (${keepCodeId}::varchar IS NULL OR id <> ${keepCodeId}::varchar)
    RETURNING id
  `);
  return result.map(r => r.id);
}

/**
 * Give the customer back the code used on a purchase that was cancelled with a full refund (or
 * a hold that never got paid). The code becomes active again with at least PROMO_CODE_DAYS left.
 * Only touches the code tied to this reference. Returns the codes given back.
 */
export async function restorePromoForReference(ref: PromoRef): Promise<string[]> {
  const result = await rows<{ id: string }>(sql`
    UPDATE promo_codes
    SET status = 'active', used_at = NULL, used_on_reference_type = NULL, used_on_order_id = NULL,
        expires_at = GREATEST(expires_at, now() + make_interval(days => ${PROMO_CODE_DAYS}::int))
    WHERE status IN ('used', 'reserved')
      AND used_on_reference_type = ${ref.type} AND used_on_order_id = ${ref.id}
    RETURNING id
  `);
  return result.map(r => r.id);
}

/** Total value (cents) and count of codes currently used on purchases (given-back codes excluded). */
export async function rewardsRedeemedTotals(): Promise<{ cents: number; count: number }> {
  const [r] = await rows<{ cents: number; count: number }>(sql`
    SELECT COALESCE(SUM(discount_cents), 0)::int AS cents, count(*)::int AS count
    FROM promo_codes WHERE status = 'used'
  `);
  return { cents: Number(r?.cents ?? 0), count: Number(r?.count ?? 0) };
}

// ── Reversals ────────────────────────────────────────────────────────────

/**
 * Take back points earned on a refunded/cancelled purchase. Never takes more than was earned on
 * that reference (minus what earlier refunds already took back), and never takes the balance
 * below 0. The ledger row records what was actually taken.
 *
 * Concurrency: the totals are read, then the write only applies if the balance is still exactly
 * what was read (compare-and-swap, re-checked by Postgres under the row lock). If anything changed
 * the balance in between (e.g. a second refund of the same booking), it reads again and retries,
 * so two refunds can never both take back the same points.
 */
export async function reversePointsForReference(
  userId: string,
  referenceType: string,
  referenceId: string,
  opts?: { refundFraction?: number; description?: string },
): Promise<{ reversed: boolean; pointsReversed: number; shortfall: number }> {
  const fraction = opts?.refundFraction !== undefined ? Math.min(1, Math.max(0, opts.refundFraction)) : 1;
  const description = opts?.description
    || (fraction < 1 ? `Points reversed from partial refund (${referenceType})` : `Points reversed from refund (${referenceType})`);

  for (let attempt = 0; attempt < 5; attempt++) {
    const [state] = await rows<{ balance: number | null; earned: number; already: number }>(sql`
      SELECT
        (SELECT loyalty_points FROM users WHERE id = ${userId}) AS balance,
        COALESCE((SELECT SUM(points) FROM point_transactions
          WHERE user_id = ${userId} AND type = 'earn'
            AND reference_type = ${referenceType} AND reference_id = ${referenceId}), 0)::int AS earned,
        COALESCE((SELECT SUM(-points) FROM point_transactions
          WHERE user_id = ${userId} AND type = 'reversal'
            AND reference_type = 'refund_reversal' AND reference_id = ${referenceId}), 0)::int AS already
    `);
    if (!state || state.balance === null || state.balance === undefined) return { reversed: false, pointsReversed: 0, shortfall: 0 };
    const balance = Number(state.balance);
    const earned = Number(state.earned);
    const already = Number(state.already);
    if (earned <= 0) return { reversed: false, pointsReversed: 0, shortfall: 0 };

    const wanted = Math.min(Math.round(earned * fraction), Math.max(0, earned - already));
    if (wanted <= 0) return { reversed: false, pointsReversed: 0, shortfall: 0 };
    const taken = Math.min(balance, wanted);
    const shortfall = wanted - taken;

    const result = await rows<{ id: string }>(sql`
      WITH upd AS (
        UPDATE users SET loyalty_points = loyalty_points - ${taken}::int
        WHERE id = ${userId} AND loyalty_points = ${balance}::int
        RETURNING loyalty_points AS after
      ), ins AS (
        INSERT INTO point_transactions
          (id, user_id, type, points, dollar_amount_cents, reference_type, reference_id,
           balance_after, description, capped)
        SELECT ${randomUUID()}, ${userId}, 'reversal', ${-taken}::int, 0, 'refund_reversal', ${referenceId},
               upd.after, ${shortfall > 0 ? `${description} (${shortfall} points could not be taken back)` : description}, false
        FROM upd
        RETURNING id
      )
      SELECT id FROM ins
    `);
    if (!result[0]) continue; // balance moved since the read: read again
    if (shortfall > 0) {
      console.warn(`[Points] Clawback shortfall for user ${userId} on ${referenceType} ${referenceId}: wanted ${wanted}, balance allowed ${taken}.`);
    }
    return { reversed: taken > 0, pointsReversed: taken, shortfall };
  }
  throw new Error(`Points reversal for ${referenceType} ${referenceId} kept conflicting; try again`);
}

/**
 * Add (delta > 0) or remove (delta < 0, never below 0) points with a ledger row, in one statement.
 * The row records the change actually applied. Used by the internal rewards events endpoint.
 * A positive delta with a referenceId is credited once per reference (duplicate -> null).
 */
export async function adjustPoints(input: {
  userId: string;
  delta: number;
  referenceType: string;
  referenceId: string | null;
  description: string;
}): Promise<{ id: string; balanceAfter: number } | null> {
  const delta = Math.trunc(input.delta);
  if (delta > 0) {
    return creditPoints({
      userId: input.userId,
      points: delta,
      dollarAmountCents: 0,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
    });
  }
  const result = await rows<{ id: string; balance_after: number }>(sql`
    WITH cur AS (
      SELECT id, loyalty_points FROM users WHERE id = ${input.userId} FOR UPDATE
    ), upd AS (
      UPDATE users SET loyalty_points = GREATEST(0, cur.loyalty_points + ${delta}::int)
      FROM cur WHERE users.id = cur.id
      RETURNING users.loyalty_points AS after, cur.loyalty_points AS before
    ), ins AS (
      INSERT INTO point_transactions
        (id, user_id, type, points, dollar_amount_cents, reference_type, reference_id,
         balance_after, description, capped)
      SELECT ${randomUUID()}, ${input.userId}, 'reversal', upd.after - upd.before, 0,
             ${input.referenceType}, ${input.referenceId}, upd.after, ${input.description}, false
      FROM upd
      RETURNING id, balance_after
    )
    SELECT id, balance_after FROM ins
  `);
  if (!result[0]) throw new Error(`User ${input.userId} not found`);
  return { id: result[0].id, balanceAfter: Number(result[0].balance_after) };
}

/** Reverse one ledger row (earn or redeem) by id, once. Used by no route today; kept atomic. */
export async function reverseLedgerRow(userId: string, originalTransactionId: string, reason: string): Promise<{ id: string } | { error: string }> {
  const result = await rows<{ id: string }>(sql`
    WITH orig AS (
      SELECT * FROM point_transactions
      WHERE id = ${originalTransactionId} AND user_id = ${userId} AND type IN ('earn', 'redeem')
        AND NOT EXISTS (
          SELECT 1 FROM point_transactions r
          WHERE r.reference_type = 'reversal' AND r.reference_id = ${originalTransactionId}
        )
    ), cur AS (
      SELECT users.id, users.loyalty_points FROM users JOIN orig ON orig.user_id = users.id FOR UPDATE OF users
    ), upd AS (
      UPDATE users SET loyalty_points = GREATEST(0, cur.loyalty_points
        + CASE WHEN orig.type = 'earn' THEN -orig.points ELSE orig.points END)
      FROM cur, orig WHERE users.id = cur.id
      RETURNING users.loyalty_points AS after, cur.loyalty_points AS before,
        orig.dollar_amount_cents, orig.business_id, orig.business_name
    ), ins AS (
      INSERT INTO point_transactions
        (id, user_id, type, points, dollar_amount_cents, business_id, business_name,
         reference_type, reference_id, balance_after, description, capped)
      SELECT ${randomUUID()}, ${userId}, 'reversal', upd.after - upd.before, upd.dollar_amount_cents, upd.business_id,
             upd.business_name, 'reversal', ${originalTransactionId}, upd.after, ${`Reversal: ${reason}`}, false
      FROM upd
      RETURNING id
    )
    SELECT id FROM ins
  `);
  if (!result[0]) return { error: 'Original transaction not found, not reversible, or already reversed' };
  return { id: result[0].id };
}

// ── Pending points (bookings + referral bonuses) ─────────────────────────

export interface PendingInput {
  userId: string;
  points: number;
  dollarAmountCents: number;
  transactionType: 'photographer_booking' | 'business_transaction' | 'bonus';
  referenceType: string;
  referenceId: string;
  releaseAfter: Date | null;
  businessId?: string | null;
  businessName?: string | null;
  description?: string | null;
}

/**
 * Hold points until the booking is final. Returns false if this reference already has a row.
 * reviveRejected: a REJECTED row for the same reference is put back to pending with the new
 * values (used when a referral re-qualifies after its first purchase was cancelled). Pending or
 * approved rows are never touched.
 */
export async function createPending(input: PendingInput, opts?: { reviveRejected?: boolean }): Promise<boolean> {
  const points = Math.trunc(input.points);
  if (points <= 0) return false;
  if (opts?.reviveRejected) {
    const revived = await rows<{ id: string }>(sql`
      INSERT INTO pending_points_transactions
        (id, user_id, dollar_amount_cents, transaction_type, points_earned, outsyde_revenue_cents,
         business_id, business_name, reference_type, reference_id, description, status, release_after)
      VALUES (${randomUUID()}, ${input.userId}, ${Math.trunc(input.dollarAmountCents)}, ${input.transactionType},
              ${points}, ${pointsValueCents(points)}, ${input.businessId ?? null}, ${input.businessName ?? null},
              ${input.referenceType}, ${input.referenceId}, ${input.description ?? `Pending ${points} points`},
              'pending', ${input.releaseAfter ? input.releaseAfter.toISOString() : null}::timestamptz)
      ON CONFLICT (reference_type, reference_id) DO UPDATE
        SET status = 'pending', points_earned = EXCLUDED.points_earned,
            outsyde_revenue_cents = EXCLUDED.outsyde_revenue_cents, release_after = EXCLUDED.release_after,
            reviewed_at = NULL, reviewed_by = NULL, review_note = NULL, live_transaction_id = NULL, updated_at = now()
        WHERE pending_points_transactions.status = 'rejected'
      RETURNING id
    `);
    return revived.length > 0;
  }
  const result = await rows<{ id: string }>(sql`
    INSERT INTO pending_points_transactions
      (id, user_id, dollar_amount_cents, transaction_type, points_earned, outsyde_revenue_cents,
       business_id, business_name, reference_type, reference_id, description, status, release_after)
    VALUES (${randomUUID()}, ${input.userId}, ${Math.trunc(input.dollarAmountCents)}, ${input.transactionType},
            ${points}, ${pointsValueCents(points)}, ${input.businessId ?? null}, ${input.businessName ?? null},
            ${input.referenceType}, ${input.referenceId}, ${input.description ?? `Pending ${points} points`},
            'pending', ${input.releaseAfter ? input.releaseAfter.toISOString() : null}::timestamptz)
    ON CONFLICT (reference_type, reference_id) DO NOTHING
    RETURNING id
  `);
  return result.length > 0;
}

export interface ReleasedPending {
  id: string;
  userId: string;
  referenceType: string | null;
  referenceId: string | null;
  pointsEarned: number;
  dollarAmountCents: number;
  liveTransactionId: string;
}

/**
 * Release one pending row: mark it approved, add the points and write the ledger row, in one
 * statement. Returns null if the row isn't pending any more. If the same reference was already
 * credited some other way, the row is rejected instead (no double credit).
 */
export async function releasePendingRow(pendingId: string, reviewerId: string, note?: string): Promise<ReleasedPending | null> {
  const liveId = randomUUID();
  try {
    const result = await rows<any>(sql`
      WITH p AS (
        UPDATE pending_points_transactions
        SET status = 'approved', reviewed_at = now(), reviewed_by = ${reviewerId},
            review_note = ${note ?? null}, live_transaction_id = ${liveId}, updated_at = now()
        WHERE id = ${pendingId} AND status = 'pending'
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = pending_points_transactions.user_id)
        RETURNING *
      ), upd AS (
        UPDATE users SET loyalty_points = users.loyalty_points + p.points_earned
        FROM p WHERE users.id = p.user_id
        RETURNING users.loyalty_points
      ), ins AS (
        INSERT INTO point_transactions
          (id, user_id, type, points, dollar_amount_cents, business_id, business_name,
           reference_type, reference_id, balance_after, description, capped)
        SELECT ${liveId}, p.user_id, 'earn', p.points_earned, p.dollar_amount_cents, p.business_id, p.business_name,
               p.reference_type, p.reference_id, upd.loyalty_points,
               COALESCE(p.description, 'Earned ' || p.points_earned || ' points'), false
        FROM p, upd
        RETURNING id
      )
      SELECT p.id, p.user_id, p.reference_type, p.reference_id, p.points_earned, p.dollar_amount_cents
      FROM p, ins
    `);
    if (!result[0]) return null;
    const r = result[0];
    return {
      id: r.id,
      userId: r.user_id,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      pointsEarned: Number(r.points_earned),
      dollarAmountCents: Number(r.dollar_amount_cents),
      liveTransactionId: liveId,
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      await rejectPendingRow(pendingId, reviewerId, 'Already credited for this reference');
      return null;
    }
    throw err;
  }
}

/** Reject one pending row (no points). Returns false if it wasn't pending. */
export async function rejectPendingRow(pendingId: string, reviewerId: string, note?: string): Promise<boolean> {
  const result = await rows<{ id: string }>(sql`
    UPDATE pending_points_transactions
    SET status = 'rejected', reviewed_at = now(), reviewed_by = ${reviewerId},
        review_note = ${note ?? null}, updated_at = now()
    WHERE id = ${pendingId} AND status = 'pending'
    RETURNING id
  `);
  return result.length > 0;
}

/** Reject the pending points of a booking (cancel, decline, expiry, no-show). Safe to call twice. */
export async function rejectPendingForReference(referenceType: string, referenceId: string, reason: string): Promise<number> {
  const result = await rows<{ id: string }>(sql`
    UPDATE pending_points_transactions
    SET status = 'rejected', reviewed_at = now(), reviewed_by = 'system',
        review_note = ${reason}, updated_at = now()
    WHERE reference_type = ${referenceType} AND reference_id = ${referenceId} AND status = 'pending'
    RETURNING id
  `);
  return result.length;
}

/** Release the pending points of a booking now (business marked it complete). */
export async function releasePendingForReference(referenceType: string, referenceId: string, reviewerId: string): Promise<ReleasedPending | null> {
  const [row] = await rows<{ id: string }>(sql`
    SELECT id FROM pending_points_transactions
    WHERE reference_type = ${referenceType} AND reference_id = ${referenceId} AND status = 'pending'
    LIMIT 1
  `);
  if (!row) return null;
  const released = await releasePendingRow(row.id, reviewerId);
  if (released) await afterRelease(released);
  return released;
}

// ── Referrals ────────────────────────────────────────────────────────────

type QualifyingType = 'order' | 'multi_vendor_order' | 'appointment' | 'shoot_booking';

/** Is the purchase still standing (not cancelled / refunded / no-show)? */
async function purchaseStillValid(type: string | null, id: string | null): Promise<boolean> {
  if (!type || !id) return false;
  let result: Array<{ ok: boolean }> = [];
  if (type === 'order') {
    result = await rows(sql`SELECT EXISTS (SELECT 1 FROM orders WHERE id = ${id} AND status NOT IN ('cancelled', 'refunded', 'pending')) AS ok`);
  } else if (type === 'multi_vendor_order') {
    result = await rows(sql`SELECT EXISTS (SELECT 1 FROM orders WHERE order_group_id = ${id} AND status NOT IN ('cancelled', 'refunded', 'pending')) AS ok`);
  } else if (type === 'appointment') {
    result = await rows(sql`SELECT EXISTS (SELECT 1 FROM appointments WHERE id = ${id} AND status IN ('confirmed', 'completed')) AS ok`);
  } else if (type === 'shoot_booking') {
    result = await rows(sql`SELECT EXISTS (SELECT 1 FROM shoot_bookings WHERE id = ${id} AND status IN ('confirmed', 'completed')) AS ok`);
  }
  const ok = result[0]?.ok as unknown;
  return ok === true || ok === 't' || ok === 'true';
}

/** Users who would be paid by this purchase (business owner, staff member, photographer). */
async function sellerUserIds(type: QualifyingType, id: string): Promise<string[]> {
  let result: Array<{ user_id: string | null }> = [];
  if (type === 'order') {
    result = await rows(sql`SELECT b.owner_id AS user_id FROM orders o JOIN businesses b ON b.id = o.business_id WHERE o.id = ${id}`);
  } else if (type === 'multi_vendor_order') {
    result = await rows(sql`SELECT b.owner_id AS user_id FROM orders o JOIN businesses b ON b.id = o.business_id WHERE o.order_group_id = ${id}`);
  } else if (type === 'appointment') {
    result = await rows(sql`
      SELECT b.owner_id AS user_id FROM appointments a JOIN businesses b ON b.id = a.business_id WHERE a.id = ${id}
      UNION ALL
      SELECT s.user_id FROM appointments a JOIN staff_members s ON s.id = a.staff_member_id WHERE a.id = ${id}
    `);
  } else if (type === 'shoot_booking') {
    result = await rows(sql`SELECT p.user_id FROM shoot_bookings sb JOIN photographers p ON p.id = sb.photographer_id WHERE sb.id = ${id}`);
  }
  return result.map(r => r.user_id).filter((v): v is string => Boolean(v));
}

/**
 * Does the user already have a standing purchase of at least REFERRAL_MIN_BASE_CENTS (base)?
 * Standing = not pending, cancelled or refunded (orders) / confirmed or completed (bookings), the
 * same rule as purchaseStillValid. Multi-shop carts count as one purchase (their orders summed).
 * exclude: leave this purchase out, and only count purchases created before it.
 */
async function hasStandingQualifyingPurchase(
  userId: string,
  opts: { exclude?: { type: QualifyingType; id: string } } = {},
): Promise<boolean> {
  const ex = opts.exclude;
  const exId = ex?.id ?? null;
  // Created time of the excluded purchase; only purchases made before it count. None = no limit.
  const beforeSql = !ex
    ? sql`'infinity'::timestamp`
    : ex.type === 'order'
      ? sql`COALESCE((SELECT created_at FROM orders WHERE id = ${exId}), 'infinity'::timestamp)`
      : ex.type === 'multi_vendor_order'
        ? sql`COALESCE((SELECT min(created_at) FROM orders WHERE order_group_id = ${exId}), 'infinity'::timestamp)`
        : ex.type === 'appointment'
          ? sql`COALESCE((SELECT created_at FROM appointments WHERE id = ${exId}), 'infinity'::timestamp)`
          : sql`COALESCE((SELECT created_at FROM shoot_bookings WHERE id = ${exId}), 'infinity'::timestamp)`;
  const [r] = await rows<{ found: unknown }>(sql`
    WITH lim AS (SELECT ${beforeSql} AS before)
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT COALESCE(order_group_id, id) AS k, SUM(total_amount) AS amt, min(created_at) AS created
        FROM orders
        WHERE customer_id = ${userId} AND status NOT IN ('pending', 'cancelled', 'refunded')
        GROUP BY 1
      ) o, lim
      WHERE o.amt >= ${REFERRAL_MIN_BASE_CENTS} AND o.k IS DISTINCT FROM ${exId} AND o.created < lim.before
      UNION ALL
      SELECT 1 FROM appointments a, lim
      WHERE a.client_id = ${userId} AND a.status IN ('confirmed', 'completed') AND a.total_price >= ${REFERRAL_MIN_BASE_CENTS}
        AND a.id IS DISTINCT FROM ${exId} AND a.created_at < lim.before
      UNION ALL
      SELECT 1 FROM shoot_bookings s, lim
      WHERE s.client_id = ${userId} AND s.status IN ('confirmed', 'completed') AND s.total_price >= ${REFERRAL_MIN_BASE_CENTS}
        AND s.id IS DISTINCT FROM ${exId} AND s.created_at < lim.before
    ) AS found
  `);
  const v = r?.found;
  return v === true || v === 't' || v === 'true';
}

/**
 * Why this user can't apply a referral code right now, or null when they can.
 * too_late: more than REFERRAL_APPLY_WINDOW_DAYS since signing up.
 * not_new: a standing $10+ purchase or any paid event ticket already.
 */
export async function referralApplyBlocker(userId: string): Promise<null | 'too_late' | 'not_new'> {
  const [u] = await rows<{ late: unknown; ticket: unknown }>(sql`
    SELECT (u.created_at < now() - make_interval(days => ${REFERRAL_APPLY_WINDOW_DAYS})) AS late,
           EXISTS (SELECT 1 FROM ticket_orders t WHERE t.buyer_user_id = u.id AND t.status = 'completed' AND t.total_cents > 0) AS ticket
    FROM users u WHERE u.id = ${userId}
  `);
  const yes = (v: unknown) => v === true || v === 't' || v === 'true';
  if (!u || yes(u.late)) return 'too_late';
  if (yes(u.ticket) || (await hasStandingQualifyingPurchase(userId))) return 'not_new';
  return null;
}

/**
 * Tie a new friend to a referrer: one statement, so the referral row and users.referred_by are
 * written together. uq_referrals_referred_user (migration 071) makes a second code for the same
 * person a no-op, even when two arrive at the same moment. Returns false when nothing was written.
 */
export async function createReferralAtomic(referredUserId: string, referrerId: string): Promise<boolean> {
  const id = randomUUID();
  const res = await rows<{ id: string }>(sql`
    WITH ins AS (
      INSERT INTO referrals (id, referrer_id, referred_user_id, status, referrer_bonus_points, referred_bonus_points)
      SELECT ${id}, ${referrerId}, ${referredUserId}, 'pending', ${REFERRAL_BONUS_POINTS}, ${REFERRAL_BONUS_POINTS}
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = ${referredUserId} AND referred_by IS NOT NULL)
      ON CONFLICT (referred_user_id) DO NOTHING
      RETURNING id
    )
    UPDATE users SET referred_by = ${referrerId}
    WHERE id = ${referredUserId} AND referred_by IS NULL AND EXISTS (SELECT 1 FROM ins)
    RETURNING id
  `);
  return res.length === 1;
}

/**
 * Called when the referred user makes a paid purchase. If they have a pending referral and this
 * purchase qualifies (base >= $10, no earlier standing $10+ purchase, not from the referrer's own
 * business/profile, referrer under the cap), the referral moves to 'qualifying' and both 2,500-point
 * bonuses are held as pending.
 * final = true (a booking whose points were just released): the bonuses are released now.
 * final = false (a product order): they release after AUTO_RELEASE_DAYS if the order still stands.
 */
export async function qualifyReferral(
  referredUserId: string,
  purchase: { type: QualifyingType; id: string; grossCents: number; final: boolean },
): Promise<'qualified' | 'skipped'> {
  if (baseFromGrossCents(purchase.grossCents) < REFERRAL_MIN_BASE_CENTS) return 'skipped';

  const [referral] = await rows<{ id: string; referrer_id: string }>(sql`
    SELECT id, referrer_id FROM referrals WHERE referred_user_id = ${referredUserId} AND status = 'pending' LIMIT 1
  `);
  if (!referral) return 'skipped';

  const sellers = await sellerUserIds(purchase.type, purchase.id);
  if (sellers.includes(referral.referrer_id) || sellers.includes(referredUserId)) return 'skipped';

  // Only the friend's first $10+ purchase counts: an earlier one that still stands means this
  // isn't it (that earlier booking qualifies itself when it is final).
  if (await hasStandingQualifyingPurchase(referredUserId, { exclude: { type: purchase.type, id: purchase.id } })) return 'skipped';

  const [count] = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM referrals WHERE referrer_id = ${referral.referrer_id} AND status IN ('qualifying', 'completed')
  `);
  if (Number(count?.n ?? 0) >= MAX_SUCCESSFUL_REFERRALS) return 'skipped';

  const claimed = await rows<{ id: string }>(sql`
    UPDATE referrals
    SET status = 'qualifying', first_transaction_id = ${purchase.id}, first_transaction_type = ${purchase.type},
        referrer_bonus_points = ${REFERRAL_BONUS_POINTS}, referred_bonus_points = ${REFERRAL_BONUS_POINTS}
    WHERE id = ${referral.id} AND status = 'pending'
    RETURNING id
  `);
  if (!claimed[0]) return 'skipped';

  const releaseAfter = purchase.final ? new Date() : new Date(Date.now() + AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000);
  await createPending({
    userId: referral.referrer_id,
    points: REFERRAL_BONUS_POINTS,
    dollarAmountCents: 0,
    transactionType: 'bonus',
    referenceType: 'referral_referrer',
    referenceId: referral.id,
    releaseAfter,
    description: 'Referral reward: your friend made their first purchase',
  }, { reviveRejected: true });
  await createPending({
    userId: referredUserId,
    points: REFERRAL_BONUS_POINTS,
    dollarAmountCents: 0,
    transactionType: 'bonus',
    referenceType: 'referral_referred',
    referenceId: referral.id,
    releaseAfter,
    description: 'Referral reward: welcome to Outsyde',
  }, { reviveRejected: true });

  if (purchase.final) await releaseReferralBonuses(referral.id, 'system');
  return 'qualified';
}

/** Release (or, if the qualifying purchase was undone, reject) both bonuses of a referral. */
async function releaseReferralBonuses(referralId: string, reviewerId: string): Promise<void> {
  const [referral] = await rows<{ id: string; status: string; first_transaction_type: string | null; first_transaction_id: string | null }>(sql`
    SELECT id, status, first_transaction_type, first_transaction_id FROM referrals WHERE id = ${referralId}
  `);
  if (!referral || referral.status !== 'qualifying') return;

  const pending = await rows<{ id: string }>(sql`
    SELECT id FROM pending_points_transactions
    WHERE reference_type IN ('referral_referrer', 'referral_referred') AND reference_id = ${referralId} AND status = 'pending'
  `);

  if (!(await purchaseStillValid(referral.first_transaction_type, referral.first_transaction_id))) {
    for (const p of pending) await rejectPendingRow(p.id, reviewerId, 'Qualifying purchase was cancelled or refunded');
    // The friend can still qualify with a later purchase.
    await rows(sql`
      UPDATE referrals SET status = 'pending', first_transaction_id = NULL, first_transaction_type = NULL
      WHERE id = ${referralId} AND status = 'qualifying'
    `);
    return;
  }

  for (const p of pending) await releasePendingRow(p.id, reviewerId);
  const done = await rows<{ id: string }>(sql`
    UPDATE referrals
    SET status = 'completed', referrer_bonus_paid_at = now(), referred_bonus_paid_at = now()
    WHERE id = ${referralId} AND status = 'qualifying'
      AND (
        SELECT count(*) FROM pending_points_transactions
        WHERE reference_type IN ('referral_referrer', 'referral_referred') AND reference_id = ${referralId} AND status = 'approved'
      ) = 2
    RETURNING id
  `);
  if (done[0]) await notifyReferralReward(referralId);
}

/**
 * Tell both people their referral reward landed. Called only by the call that moved the referral
 * to 'completed' (UPDATE ... RETURNING), so it runs once. Never throws: a failed notice must not
 * undo or retry the points.
 */
async function notifyReferralReward(referralId: string): Promise<void> {
  try {
    const [r] = await rows<{ referrer_id: string; referred_user_id: string; referrer_bonus_points: number }>(sql`
      SELECT referrer_id, referred_user_id, referrer_bonus_points FROM referrals WHERE id = ${referralId}
    `);
    if (!r) return;
    const { NotificationTriggers } = await import("./notificationService");
    await NotificationTriggers.referralReward({
      referralId,
      referrerId: r.referrer_id,
      friendId: r.referred_user_id,
      points: Number(r.referrer_bonus_points) || REFERRAL_BONUS_POINTS,
    });
  } catch (err) {
    console.error(`[Points] referral reward notice for ${referralId} failed:`, err);
  }
}

/** After a booking's pending points are released, the booking is final: it can qualify a referral. */
async function afterRelease(released: ReleasedPending): Promise<void> {
  if ((released.referenceType === 'appointment' || released.referenceType === 'shoot_booking') && released.referenceId) {
    try {
      await qualifyReferral(released.userId, {
        type: released.referenceType,
        id: released.referenceId,
        grossCents: released.dollarAmountCents,
        final: true,
      });
    } catch (err) {
      console.error(`[Points] referral check after release of ${released.id} failed:`, err);
    }
  }
}

/** Release a pending row by id (admin approve route) and run the referral check. */
export async function releasePendingById(pendingId: string, reviewerId: string, note?: string): Promise<ReleasedPending | null> {
  const released = await releasePendingRow(pendingId, reviewerId, note);
  if (released) {
    if (released.referenceType === 'referral_referrer' || released.referenceType === 'referral_referred') {
      const done = await rows<{ id: string }>(sql`
        UPDATE referrals SET status = 'completed', referrer_bonus_paid_at = now(), referred_bonus_paid_at = now()
        WHERE id = ${released.referenceId} AND status = 'qualifying'
          AND (
            SELECT count(*) FROM pending_points_transactions
            WHERE reference_type IN ('referral_referrer', 'referral_referred') AND reference_id = ${released.referenceId} AND status = 'approved'
          ) = 2
        RETURNING id
      `);
      if (done[0] && released.referenceId) await notifyReferralReward(released.referenceId);
    } else {
      await afterRelease(released);
    }
  }
  return released;
}

// ── Auto-release job ─────────────────────────────────────────────────────

/**
 * Release every pending row whose release time has passed, if its booking still stands
 * (confirmed or completed). Bookings that ended any other way are rejected. Referral bonuses are
 * released together once their qualifying purchase is final.
 */
export async function releaseDuePendingPoints(limit = 200): Promise<{ released: number; rejected: number }> {
  const due = await rows<{ id: string; reference_type: string | null; reference_id: string | null }>(sql`
    SELECT id, reference_type, reference_id FROM pending_points_transactions
    WHERE status = 'pending' AND release_after IS NOT NULL AND release_after <= now()
    ORDER BY release_after
    LIMIT ${limit}
  `);
  let released = 0;
  let rejected = 0;
  const referralsSeen = new Set<string>();

  for (const row of due) {
    try {
      if (row.reference_type === 'referral_referrer' || row.reference_type === 'referral_referred') {
        if (row.reference_id && !referralsSeen.has(row.reference_id)) {
          referralsSeen.add(row.reference_id);
          await releaseReferralBonuses(row.reference_id, 'system');
        }
        continue;
      }
      if (await purchaseStillValid(row.reference_type, row.reference_id)) {
        const r = await releasePendingRow(row.id, 'system', `Auto-released ${AUTO_RELEASE_DAYS} days after the booking`);
        if (r) {
          released++;
          await afterRelease(r);
        }
      } else if (await rejectPendingRow(row.id, 'system', 'Booking did not go ahead')) {
        rejected++;
      }
    } catch (err) {
      console.error(`[Points] auto-release of pending ${row.id} failed:`, err);
    }
  }
  if (due.length) console.log(`[Points] auto-release: ${released} released, ${rejected} rejected, ${due.length} due`);
  return { released, rejected };
}

export function startPointsReleaseJob(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  const run = () => releaseDuePendingPoints().catch(err => console.error('[Points] auto-release job failed:', err));
  setTimeout(run, 30 * 1000);
  return setInterval(run, intervalMs);
}
