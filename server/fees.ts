/**
 * Outsyde Platform Fee & Payout Configuration v2
 *
 * Fee ownership:
 * - Consumer service fee (3%): charged to CUSTOMER, revenue to Outsyde
 * - Product platform fee (8%): deducted from VENDOR subtotal, revenue to Outsyde
 * - Booking fee (12%): deducted from VENDOR subtotal, revenue to Outsyde
 * - Influencer commission (15%): deducted from VENDOR subtotal, paid to influencer (NOT Outsyde revenue)
 *
 * All amounts in integer cents. All calculations use Math.round() for cent precision.
 */

export const FEE_MODEL_VERSION = 'v2';

// Consumer-side fee (added ON TOP of subtotal, paid by customer)
export const CONSUMER_SERVICE_FEE_RATE = 0.03;
export const CONSUMER_SERVICE_FEE_PERCENT = 3;

// Vendor-side fees (deducted FROM subtotal)
export const PRODUCT_FEE_RATE = 0.08;
export const PRODUCT_FEE_PERCENT = 8;

export const BOOKING_FEE_RATE = 0.12;
export const BOOKING_FEE_PERCENT = 12;

// Influencer commission (deducted from vendor, paid to influencer — NOT Outsyde revenue)
export const INFLUENCER_COMMISSION_RATE = 0.15;
export const INFLUENCER_COMMISSION_PERCENT = 15;

// =====================================================
//  FEE BREAKDOWN TYPES
// =====================================================

export interface FeeBreakdown {
  subtotalCents: number;
  consumerServiceFeeCents: number;
  platformFeeCents: number;
  influencerCommissionCents: number;
  vendorNetCents: number;
  customerTotalBeforeTaxCents: number;
  outsydeGrossRevenueCents: number;
  feeModelVersion: string;
  orderType: 'product' | 'booking';
  hasInfluencer: boolean;
}

// =====================================================
//  CALCULATION FUNCTIONS
// =====================================================

/**
 * Calculate fees for a product order.
 */
export function calculateProductFees(
  subtotalCents: number,
  options?: { influencerAttributed?: boolean }
): FeeBreakdown {
  const consumerServiceFeeCents = Math.round(subtotalCents * CONSUMER_SERVICE_FEE_RATE);
  const platformFeeCents = Math.round(subtotalCents * PRODUCT_FEE_RATE);
  const hasInfluencer = options?.influencerAttributed || false;
  const influencerCommissionCents = hasInfluencer
    ? Math.round(subtotalCents * INFLUENCER_COMMISSION_RATE)
    : 0;
  const vendorNetCents = subtotalCents - platformFeeCents - influencerCommissionCents;
  const customerTotalBeforeTaxCents = subtotalCents + consumerServiceFeeCents;
  const outsydeGrossRevenueCents = consumerServiceFeeCents + platformFeeCents;

  const breakdown: FeeBreakdown = {
    subtotalCents,
    consumerServiceFeeCents,
    platformFeeCents,
    influencerCommissionCents,
    vendorNetCents,
    customerTotalBeforeTaxCents,
    outsydeGrossRevenueCents,
    feeModelVersion: FEE_MODEL_VERSION,
    orderType: 'product',
    hasInfluencer,
  };

  console.log(`[Fee] Product order: subtotal=${subtotalCents}¢, serviceFee=${consumerServiceFeeCents}¢, platformFee=${platformFeeCents}¢, influencer=${influencerCommissionCents}¢, vendorNet=${vendorNetCents}¢, customerTotal=${customerTotalBeforeTaxCents}¢, outsydeRevenue=${outsydeGrossRevenueCents}¢`);

  return breakdown;
}

/**
 * Calculate fees for a service booking.
 */
export function calculateBookingFees(subtotalCents: number): FeeBreakdown {
  const consumerServiceFeeCents = Math.round(subtotalCents * CONSUMER_SERVICE_FEE_RATE);
  const platformFeeCents = Math.round(subtotalCents * BOOKING_FEE_RATE);
  const vendorNetCents = subtotalCents - platformFeeCents;
  const customerTotalBeforeTaxCents = subtotalCents + consumerServiceFeeCents;
  const outsydeGrossRevenueCents = consumerServiceFeeCents + platformFeeCents;

  const breakdown: FeeBreakdown = {
    subtotalCents,
    consumerServiceFeeCents,
    platformFeeCents,
    influencerCommissionCents: 0,
    vendorNetCents,
    customerTotalBeforeTaxCents,
    outsydeGrossRevenueCents,
    feeModelVersion: FEE_MODEL_VERSION,
    orderType: 'booking',
    hasInfluencer: false,
  };

  console.log(`[Fee] Booking: subtotal=${subtotalCents}¢, serviceFee=${consumerServiceFeeCents}¢, bookingFee=${platformFeeCents}¢, vendorNet=${vendorNetCents}¢, customerTotal=${customerTotalBeforeTaxCents}¢, outsydeRevenue=${outsydeGrossRevenueCents}¢`);

  return breakdown;
}

// =====================================================
//  LEGACY COMPAT — simple fee calculators (used by existing routes)
// =====================================================

export function calculateProductFee(amountCents: number): number {
  return Math.round(amountCents * PRODUCT_FEE_RATE);
}

export function calculateBookingFee(amountCents: number): number {
  return Math.round(amountCents * BOOKING_FEE_RATE);
}

export function calculateConsumerServiceFee(amountCents: number): number {
  return Math.round(amountCents * CONSUMER_SERVICE_FEE_RATE);
}

export function calculateInfluencerCommission(amountCents: number): number {
  return Math.round(amountCents * INFLUENCER_COMMISSION_RATE);
}

// =====================================================
//  INFLUENCER COMMISSION STATUSES
// =====================================================

export const COMMISSION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  TRANSFER_QUEUED: 'transfer_queued',
  TRANSFER_SENT: 'transfer_sent',
  PAID: 'paid',
  REVERSED: 'reversed',
} as const;

export type CommissionStatus = typeof COMMISSION_STATUS[keyof typeof COMMISSION_STATUS];
