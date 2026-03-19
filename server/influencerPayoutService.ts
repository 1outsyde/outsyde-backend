/**
 * Influencer Commission Payout Service
 *
 * Processes influencer commissions on successful payments.
 * Purely additive — does not modify payment intent creation or platform fees.
 */

import { db } from "./db";
import { storage } from "./storage";
import {
  influencerPayouts,
  influencerAttributions,
  orders,
} from "@shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { stripeService } from "./stripe/stripeService";
import { randomUUID } from "crypto";
import { trackAttributedPurchase, getInfluencerStatsById } from "./influencerTrackingService";

const ATTRIBUTION_WINDOW_DAYS = 30;

export interface CommissionResult {
  success: boolean;
  commissionAmountCents: number;
  transferId: string | null;
  status: 'completed' | 'pending' | 'skipped';
  reason?: string;
}

/**
 * Process influencer commission for a completed order.
 * Called from payment_intent.succeeded or checkout.session.completed webhook.
 *
 * This function is idempotent — it checks for existing payouts before creating new ones.
 */
export async function processInfluencerCommission(
  orderId: string,
  paymentIntentId: string
): Promise<CommissionResult> {
  // 1. Look up order
  const order = await storage.getOrder(orderId);
  if (!order) {
    return { success: false, commissionAmountCents: 0, transferId: null, status: 'skipped', reason: 'Order not found' };
  }

  const refCode = order.influencerCodeUsed;
  const influencerId = order.attributedInfluencerId;
  const commissionAmount = order.influencerCommission;

  if (!refCode || !influencerId || !commissionAmount || commissionAmount <= 0) {
    return { success: false, commissionAmountCents: 0, transferId: null, status: 'skipped', reason: 'No influencer attribution' };
  }

  // 2. Check idempotency — don't double-pay
  const existingPayouts = await db.select()
    .from(influencerPayouts)
    .where(and(
      eq(influencerPayouts.influencerId, influencerId),
      eq((influencerPayouts as any).sourceRefId, orderId),
    ))
    .limit(1);

  if (existingPayouts.length > 0) {
    console.log(`[InfluencerPayout] Already processed for order ${orderId}, skipping`);
    return { success: true, commissionAmountCents: commissionAmount, transferId: null, status: 'completed', reason: 'Already processed' };
  }

  // 3. Validate attribution is within 30-day window
  const [attribution] = await db.select()
    .from(influencerAttributions)
    .where(and(
      eq(influencerAttributions.userId, order.customerId),
      eq(influencerAttributions.influencerId, influencerId),
      gte(influencerAttributions.expiresAt, new Date()),
    ))
    .limit(1);

  if (!attribution) {
    console.log(`[InfluencerPayout] Attribution expired or not found for order ${orderId}`);
    return { success: false, commissionAmountCents: 0, transferId: null, status: 'skipped', reason: 'Attribution expired' };
  }

  // 4. Get influencer profile
  const influencerProfile = await storage.getInfluencerProfile(influencerId);
  if (!influencerProfile) {
    return { success: false, commissionAmountCents: 0, transferId: null, status: 'skipped', reason: 'Influencer profile not found' };
  }

  // 5. Attempt Stripe transfer if influencer has Connect account
  let transferId: string | null = null;
  let payoutStatus: string = 'pending';

  if (influencerProfile.stripeAccountId) {
    try {
      const transfer = await stripeService.transferToVendor({
        amountInCents: commissionAmount,
        connectedAccountId: influencerProfile.stripeAccountId,
        orderId,
      });
      transferId = transfer.id;
      payoutStatus = 'completed';
      console.log(`[InfluencerPayout] Transfer ${transfer.id}: ${commissionAmount}¢ → influencer ${influencerId} for order ${orderId}`);
    } catch (err) {
      console.error(`[InfluencerPayout] Transfer failed for order ${orderId}:`, err);
      payoutStatus = 'pending';
    }
  } else {
    console.log(`[InfluencerPayout] No Stripe account for influencer ${influencerId} — holding commission as pending`);
    payoutStatus = 'pending';
  }

  // 6. Log to influencer_payouts (earning ledger)
  await storage.createInfluencerEarningLedger({
    influencerId,
    sourceType: 'commission',
    sourceRefId: orderId,
    amountCents: commissionAmount,
    description: `Commission on order ${orderId} (ref: ${refCode})${transferId ? ` [transfer: ${transferId}]` : ''}`,
    status: payoutStatus,
  });

  // 7. Update order with transfer status
  await storage.updateOrder(orderId, {
    influencerTransferStatus: payoutStatus === 'completed' ? 'transfer_sent' : 'pending',
    commissionStatus: payoutStatus === 'completed' ? 'transfer_sent' : 'approved',
  });

  // 8. Track the purchase event for influencer stats
  try {
    await trackAttributedPurchase(order.customerId, orderId, order.totalAmount);
  } catch (trackErr) {
    console.error(`[InfluencerPayout] Failed to track purchase event:`, trackErr);
  }

  console.log(`[InfluencerPayout] Processed: order=${orderId}, commission=${commissionAmount}¢, status=${payoutStatus}, transfer=${transferId || 'none'}`);

  return {
    success: true,
    commissionAmountCents: commissionAmount,
    transferId,
    status: payoutStatus === 'completed' ? 'completed' : 'pending',
  };
}

/**
 * Reverse influencer commission on refund.
 * If transfer was already sent, creates a reversal record.
 */
export async function reverseInfluencerCommission(
  orderId: string,
  refundAmountCents: number,
  fullRefund: boolean = true
): Promise<void> {
  const order = await storage.getOrder(orderId);
  if (!order?.attributedInfluencerId || !order.influencerCommission || order.influencerCommission <= 0) {
    return;
  }

  // Calculate reversal amount (full or proportional)
  const reversalAmount = fullRefund
    ? order.influencerCommission
    : Math.round(order.influencerCommission * (refundAmountCents / order.totalAmount));

  // Create reversal ledger entry
  await storage.createInfluencerEarningLedger({
    influencerId: order.attributedInfluencerId,
    sourceType: 'commission_reversal',
    sourceRefId: orderId,
    amountCents: -reversalAmount,
    description: `Commission reversal for refunded order ${orderId} (${fullRefund ? 'full' : 'partial'})`,
    status: 'completed',
  });

  // Update order status
  await storage.updateOrder(orderId, {
    influencerTransferStatus: 'reversed',
    commissionStatus: 'reversed',
  });

  console.log(`[InfluencerPayout] Reversed ${reversalAmount}¢ commission for order ${orderId} (${fullRefund ? 'full' : 'partial'} refund)`);
}
