// server/promoCheckout.ts
//
// Holding a points code for one checkout at a time (rules in server/loyaltyLedger.ts).
//
//   claimPromoForCheckout   hold the code for this checkout. If an earlier, unpaid checkout holds
//                           it (an abandoned payment sheet, a second tab), that checkout's payment
//                           is cancelled and the hold moves here. A checkout that is paid, being
//                           processed, or waiting for the business to accept keeps the code.
//   confirmPromoStillHeld   run after this checkout's PaymentIntent is saved: if a newer checkout
//                           took the code in the meantime, cancel our PaymentIntent so the code
//                           can never pay for two purchases.
//
// The order of writes matters (neon-http has no transactions): a takeover moves the hold FIRST
// and then cancels the old PaymentIntent, and every checkout saves its PaymentIntent BEFORE it
// confirms it still holds the code. So either the old checkout sees the move and cancels itself,
// or the takeover sees its saved PaymentIntent and cancels (or keeps) it.

import { eq } from "drizzle-orm";
import { db } from "./db";
import { appointments, orders, shootBookings } from "@shared/schema";
import { stripeService } from "./stripe/stripeService";
import {
  movePromoReservation,
  reservePromoCode,
  isPromoReservedFor,
  type PromoCodeRow,
  type PromoRef,
} from "./loyaltyLedger";

export type ClaimResult =
  | { ok: true; code: PromoCodeRow }
  | { ok: false; status: number; code: string; error: string };

const UNPAID_STATES = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

/** The saved PaymentIntent of a checkout, or null when it has none yet. */
export async function paymentIntentIdForRef(ref: PromoRef): Promise<string | null> {
  if (ref.type === 'appointment') {
    const [r] = await db.select({ pi: appointments.stripePaymentIntentId }).from(appointments).where(eq(appointments.id, ref.id));
    return r?.pi ?? null;
  }
  if (ref.type === 'shoot_booking') {
    const [r] = await db.select({ pi: shootBookings.stripePaymentIntentId }).from(shootBookings).where(eq(shootBookings.id, ref.id));
    return r?.pi ?? null;
  }
  const [r] = await db.select({ pi: orders.stripePaymentIntentId }).from(orders).where(eq(orders.id, ref.id));
  return r?.pi ?? null;
}

function refusal(reason: string): ClaimResult {
  switch (reason) {
    case 'not_yours':
      return { ok: false, status: 400, code: 'INVALID_PROMO', error: 'This code does not belong to your account.' };
    case 'used':
      return { ok: false, status: 400, code: 'INVALID_PROMO', error: 'This code has already been used.' };
    case 'expired':
      return { ok: false, status: 400, code: 'INVALID_PROMO', error: 'This code has expired.' };
    default:
      return { ok: false, status: 400, code: 'INVALID_PROMO', error: 'Invalid or already used promo code.' };
  }
}

/**
 * Whether the checkout holding a code may give it up. Cancels its PaymentIntent when it is
 * still unpaid. Returns null when the code may move, or the refusal.
 */
async function releaseOldCheckout(piId: string | null): Promise<ClaimResult | null> {
  if (!piId) return null;
  let status: string;
  try {
    status = (await stripeService.getPaymentIntent(piId)).status;
  } catch (err: any) {
    if (err?.code === 'resource_missing' || err?.statusCode === 404) return null;
    throw err;
  }
  if (status === 'canceled') return null;
  if (UNPAID_STATES.has(status)) {
    try {
      await stripeService.cancelPaymentIntent(piId, 'abandoned');
      return null;
    } catch (err) {
      // It may have been paid or cancelled between the read and the cancel: read again.
      status = (await stripeService.getPaymentIntent(piId)).status;
      if (status === 'canceled') return null;
    }
  }
  if (status === 'requires_capture') {
    return { ok: false, status: 409, code: 'PROMO_IN_USE', error: 'This code is on another booking that is waiting for the business to accept. You can use it again if that booking is declined or cancelled.' };
  }
  return { ok: false, status: 409, code: 'PROMO_IN_USE', error: 'This code is already being used on another checkout.' };
}

export async function claimPromoForCheckout(codeId: string, userId: string, ref: PromoRef): Promise<ClaimResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await reservePromoCode(codeId, userId, ref);
    if (r.ok) return { ok: true, code: r.code };
    if (r.reason !== 'held') return refusal(r.reason);

    const from = r.heldBy;
    const moved = await movePromoReservation(codeId, from, ref);
    if (!moved) continue; // the hold changed since we read it: start over

    let refused: ClaimResult | null;
    try {
      refused = await releaseOldCheckout(await paymentIntentIdForRef(from));
    } catch (err) {
      console.error(`[Promo] Could not check checkout ${from.type} ${from.id} holding code ${codeId}:`, err);
      refused = { ok: false, status: 502, code: 'PROMO_CHECK_FAILED', error: 'We could not check your code right now. Please try again.' };
    }
    if (refused) {
      await movePromoReservation(codeId, ref, from); // give it back; a no-op if it was paid meanwhile
      return refused;
    }
    console.log(`[Promo] Code ${codeId} moved from ${from.type} ${from.id} to ${ref.type} ${ref.id}`);
    return { ok: true, code: moved };
  }
  return { ok: false, status: 409, code: 'PROMO_IN_USE', error: 'This code is already being used on another checkout.' };
}

/**
 * After this checkout's PaymentIntent is saved: true when it still holds the code. When a newer
 * checkout took it, cancels this PaymentIntent (best effort) and returns false.
 */
export async function confirmPromoStillHeld(codeId: string, ref: PromoRef, paymentIntentId: string): Promise<boolean> {
  if (await isPromoReservedFor(codeId, ref)) return true;
  try {
    await stripeService.cancelPaymentIntent(paymentIntentId, 'abandoned');
  } catch (err) {
    console.error(`[Promo] Lost code ${codeId} on ${ref.type} ${ref.id}; could not cancel PaymentIntent ${paymentIntentId}:`, err);
  }
  return false;
}

export const PROMO_TAKEN_RESPONSE = {
  error: 'This code was just used on another checkout. Please try again.',
  code: 'PROMO_IN_USE',
};
