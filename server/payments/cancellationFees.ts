/**
 * R39 (Quotes step 3, migration 098): a cancellation fee is charged at most once per booking.
 *
 * Before: stripeService.chargeSavedPaymentMethod created an off session PaymentIntent with no idempotency key and
 * kept no record, so a retry (SDK retry, a lost reply, a second cancel) could charge the fee twice.
 *
 * Now (the money rules in the vault, Stripe Complete Reference section 8):
 *   - one row per booking in cancellation_fee_charges (unique reference), claimed with a guarded UPDATE before
 *     every try (a claim older than 10 minutes can be retaken);
 *   - before creating, look at Stripe for an earlier fee PaymentIntent for this booking (metadata match), because
 *     idempotency keys only last 24 hours and a failed try may still have landed;
 *   - one idempotency key per try (the claim tag), bounded call (30 s, 1 retry);
 *   - never decide "it didn't happen" in the try whose call failed: a network error leaves the row "charging" so
 *     the next try looks it up. Only a card decline marks it failed.
 */
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { getUncachableStripeClient } from "../stripe/stripeClient";

export type FeeReference = { type: "appointment" | "shoot_booking"; id: string };
export type FeeChargeResult =
  | { outcome: "charged"; paymentIntentId: string; chargeId: string | null; alreadyCharged: boolean }
  | { outcome: "declined"; error: string }
  | { outcome: "unknown"; error: string }      // in flight or the call failed: collected later or by the provider
  | { outcome: "busy" };                       // another try holds the claim right now

const CLAIM_MINUTES = 10;
const BOUND = { timeout: 30_000, maxNetworkRetries: 1 } as const;

async function rows<T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result: any = await db.execute(query);
  return (result?.rows ?? result ?? []) as T[];
}

const metaKey = (ref: FeeReference) => (ref.type === "appointment" ? "appointmentId" : "shootBookingId");
const isLanded = (status: string | undefined) => status === "succeeded" || status === "processing";
const chargeIdOf = (pi: any): string | null => (typeof pi?.latest_charge === "string" ? pi.latest_charge : pi?.latest_charge?.id ?? null);

/** Looks for an earlier fee PaymentIntent for this booking that went through (or is going through). */
async function findEarlierFee(stripe: any, customerId: string, ref: FeeReference, sinceUnix: number): Promise<any | null> {
  let startingAfter: string | undefined;
  for (let page = 0; page < 5; page++) {
    const list = await stripe.paymentIntents.list(
      { customer: customerId, created: { gte: sinceUnix }, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      BOUND,
    );
    const hit = (list?.data ?? []).find((pi: any) => pi?.metadata?.type === "cancellation_fee" && pi?.metadata?.[metaKey(ref)] === ref.id && isLanded(pi.status));
    if (hit) return hit;
    if (!list?.has_more || !list.data?.length) return null;
    startingAfter = list.data[list.data.length - 1].id;
  }
  return null;
}

export async function chargeCancellationFeeOnce(input: {
  ref: FeeReference;
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  metadata: Record<string, string>;
  description: string;
}): Promise<FeeChargeResult> {
  const { ref, customerId, amountCents } = input;
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { outcome: "declined", error: "no fee to charge" };

  await rows(sql`
    INSERT INTO cancellation_fee_charges (id, reference_type, reference_id, customer_id, amount_cents)
    VALUES (${randomUUID()}, ${ref.type}, ${ref.id}, ${customerId}, ${amountCents}::int)
    ON CONFLICT (reference_type, reference_id) DO NOTHING
  `);
  const tag = randomUUID();
  const [claimed] = await rows<{ id: string; created_at: string; attempts: number }>(sql`
    UPDATE cancellation_fee_charges
       SET status = 'charging', attempts = attempts + 1, claim_tag = ${tag}, updated_at = now()
     WHERE reference_type = ${ref.type} AND reference_id = ${ref.id}
       AND (status IN ('pending', 'failed') OR (status = 'charging' AND updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
     RETURNING id, created_at, attempts
  `);
  if (!claimed) {
    const [row] = await rows<{ status: string; stripe_payment_intent_id: string | null; stripe_charge_id: string | null }>(sql`
      SELECT status, stripe_payment_intent_id, stripe_charge_id FROM cancellation_fee_charges WHERE reference_type = ${ref.type} AND reference_id = ${ref.id}
    `);
    if (row?.status === "charged" && row.stripe_payment_intent_id) {
      return { outcome: "charged", paymentIntentId: row.stripe_payment_intent_id, chargeId: row.stripe_charge_id, alreadyCharged: true };
    }
    return { outcome: "busy" };
  }

  const markCharged = async (pi: any) => {
    await rows(sql`
      UPDATE cancellation_fee_charges SET status = 'charged', stripe_payment_intent_id = ${pi.id}, stripe_charge_id = ${chargeIdOf(pi)}, last_error = NULL, updated_at = now()
       WHERE id = ${claimed.id} AND claim_tag = ${tag}
    `);
  };

  const stripe: any = await getUncachableStripeClient();
  try {
    // Any earlier try (even one whose reply was lost) shows up here. Look back to an hour before the row.
    const since = Math.floor(new Date(claimed.created_at).getTime() / 1000) - 3600;
    const earlier = await findEarlierFee(stripe, customerId, ref, since);
    if (earlier) {
      await markCharged(earlier);
      return { outcome: "charged", paymentIntentId: earlier.id, chargeId: chargeIdOf(earlier), alreadyCharged: true };
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    await rows(sql`UPDATE cancellation_fee_charges SET last_error = ${`lookup: ${msg}`.slice(0, 500)}, updated_at = now() WHERE id = ${claimed.id} AND claim_tag = ${tag}`);
    return { outcome: "unknown", error: msg };
  }

  try {
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      customer: customerId,
      payment_method: input.paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: { ...input.metadata, type: "cancellation_fee", [metaKey(ref)]: ref.id },
      description: input.description,
    }, { idempotencyKey: `cancel_fee_${ref.type}_${ref.id}_${tag}`, ...BOUND });
    if (isLanded(pi?.status)) {
      await markCharged(pi);
      return { outcome: "charged", paymentIntentId: pi.id, chargeId: chargeIdOf(pi), alreadyCharged: false };
    }
    // requires_action or requires_payment_method: the card needs the customer; nothing was taken.
    await rows(sql`UPDATE cancellation_fee_charges SET status = 'failed', stripe_payment_intent_id = ${pi?.id ?? null}, last_error = ${`status ${pi?.status}`}, updated_at = now() WHERE id = ${claimed.id} AND claim_tag = ${tag}`);
    return { outcome: "declined", error: `status ${pi?.status}` };
  } catch (err: any) {
    const msg = (err?.message || String(err)).slice(0, 500);
    if (err?.type === "StripeCardError" || err?.rawType === "card_error") {
      await rows(sql`UPDATE cancellation_fee_charges SET status = 'failed', last_error = ${msg}, updated_at = now() WHERE id = ${claimed.id} AND claim_tag = ${tag}`);
      return { outcome: "declined", error: msg };
    }
    // It may still have landed: leave the claim, the next try looks it up first.
    await rows(sql`UPDATE cancellation_fee_charges SET last_error = ${msg}, updated_at = now() WHERE id = ${claimed.id} AND claim_tag = ${tag}`);
    return { outcome: "unknown", error: msg };
  }
}

/**
 * Later try for fees whose call failed (outcome "unknown"): look at Stripe once the claim is older than 15 minutes.
 * Found: recorded as charged (and the booking's kept fee, or a quote's vendor share, is settled). Not found: failed,
 * so the provider collects it (the cancel response already said so). Never charges.
 */
export async function resolveStaleFeeCharges(): Promise<number> {
  const stale = await rows<{ id: string; reference_type: "appointment" | "shoot_booking"; reference_id: string; customer_id: string; amount_cents: number; created_at: string; claim_tag: string }>(sql`
    SELECT id, reference_type, reference_id, customer_id, amount_cents, created_at, claim_tag FROM cancellation_fee_charges
     WHERE status = 'charging' AND updated_at < now() - interval '15 minutes' AND created_at > now() - interval '7 days'
     ORDER BY created_at LIMIT 20
  `);
  if (!stale.length) return 0;
  const stripe: any = await getUncachableStripeClient();
  let resolved = 0;
  for (const r of stale) {
    const ref: FeeReference = { type: r.reference_type, id: r.reference_id };
    try {
      const since = Math.floor(new Date(r.created_at).getTime() / 1000) - 3600;
      const found = await findEarlierFee(stripe, r.customer_id, ref, since);
      if (found) {
        const [done] = await rows<{ id: string }>(sql`UPDATE cancellation_fee_charges SET status = 'charged', stripe_payment_intent_id = ${found.id}, stripe_charge_id = ${chargeIdOf(found)}, updated_at = now() WHERE id = ${r.id} AND claim_tag = ${r.claim_tag} AND status = 'charging' RETURNING id`);
        if (done) {
          if (ref.type === "appointment") {
            const [a] = await rows<{ quote_id: string | null }>(sql`SELECT quote_id FROM appointments WHERE id = ${ref.id}`);
            if (a?.quote_id) {
              const { payQuoteCancelFeeShare } = await import("../quotes/quotePaid");
              const { storage } = await import("../storage");
              const appt = await storage.getAppointment(ref.id);
              if (appt) await payQuoteCancelFeeShare(appt, r.amount_cents, chargeIdOf(found));
            } else {
              await rows(sql`UPDATE appointments SET cancellation_fee_kept_cents = ${r.amount_cents}::int WHERE id = ${ref.id} AND cancellation_fee_kept_cents IS NULL`);
            }
          } else {
            await rows(sql`UPDATE shoot_bookings SET cancellation_fee_kept_cents = ${r.amount_cents}::int WHERE id = ${ref.id} AND cancellation_fee_kept_cents IS NULL`);
          }
          console.log(`[CancelFee] ${ref.type} ${ref.id}: fee found at Stripe (${found.id}), recorded`);
        }
      } else {
        await rows(sql`UPDATE cancellation_fee_charges SET status = 'failed', last_error = COALESCE(last_error, '') || ' | not found at Stripe on the later check', updated_at = now() WHERE id = ${r.id} AND claim_tag = ${r.claim_tag} AND status = 'charging'`);
      }
      resolved++;
    } catch (err) {
      console.error(`[CancelFee] later check failed for ${ref.type} ${ref.id}:`, err);
    }
  }
  return resolved;
}
