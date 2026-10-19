/**
 * Outsyde Platform Fee & Payout Configuration v2
 *
 * Fee ownership:
 * - Consumer service fee (8%): charged to CUSTOMER, revenue to Outsyde
 * - Product platform fee (2%): deducted from VENDOR subtotal, revenue to Outsyde
 * - Booking fee (2%): deducted from VENDOR subtotal, revenue to Outsyde
 * - Influencer commission (15%): deducted from VENDOR subtotal, paid to influencer (NOT Outsyde revenue)
 *
 * All amounts in integer cents. All calculations use Math.round() for cent precision.
 */

export const FEE_MODEL_VERSION = 'v2';

// Consumer-side fee (added ON TOP of subtotal, paid by customer)
export const CONSUMER_SERVICE_FEE_RATE = 0.08;
export const CONSUMER_SERVICE_FEE_PERCENT = 8;

// Vendor-side fees (deducted FROM subtotal)
export const PRODUCT_FEE_RATE = 0.02;
export const PRODUCT_FEE_PERCENT = 2;

export const BOOKING_FEE_RATE = 0.02;
export const BOOKING_FEE_PERCENT = 2;

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

export interface DepositQuote {
  serviceTotalCents: number;
  depositAmountCents: number | null;
  chargeAmountCents: number;
  dueNowCents: number;
  dueAtAppointmentCents: number;
  depositNonRefundable: boolean;
  feeBreakdown: FeeBreakdown;
}

/**
 * What a booking charges now versus in person. Deposit bookings charge the
 * deposit plus the consumer fee now; the rest of the service price is paid at
 * the appointment with no Outsyde fee.
 * Read-only: mirrors the booking PaymentIntent exactly (any stored number is
 * the charge base, as in create-payment-intent), so dueNowCents always equals
 * the amount that PaymentIntent charges. Deposit writes now store 0 as null.
 */
export function quoteDeposit(serviceTotalCents: number, depositAmountCents: number | null | undefined): DepositQuote {
  const deposit = typeof depositAmountCents === 'number' ? depositAmountCents : null;
  const chargeAmountCents = deposit !== null ? deposit : serviceTotalCents;
  const feeBreakdown = calculateBookingFees(chargeAmountCents);
  return {
    serviceTotalCents,
    depositAmountCents: deposit,
    chargeAmountCents,
    dueNowCents: feeBreakdown.customerTotalBeforeTaxCents,
    dueAtAppointmentCents: deposit !== null ? Math.max(0, serviceTotalCents - deposit) : 0,
    depositNonRefundable: deposit !== null,
    feeBreakdown,
  };
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

// =====================================================
//  PARTIAL REFUND PRORATION
// =====================================================

/**
 * Calculate prorated fee adjustments for a partial refund.
 *
 * Proration rule: each fee is reduced proportionally to the refund ratio.
 * refundRatio = refundAmountCents / originalSubtotalCents
 *
 * Full refund: all fees reversed in full.
 * Partial refund: each fee reduced by (refundAmount / subtotal) ratio.
 *
 * The consumer service fee reversal goes back to the customer.
 * The platform fee reversal reduces Outsyde revenue.
 * The influencer commission reversal reduces influencer payout.
 * Vendor net adjustment = refundAmount - (platformFee reversal + influencerCommission reversal)
 */
export function calculateRefundAdjustments(params: {
  originalSubtotalCents: number;
  refundAmountCents: number;
  originalConsumerServiceFeeCents: number;
  originalPlatformFeeCents: number;
  originalInfluencerCommissionCents: number;
}): {
  consumerServiceFeeReversalCents: number;
  platformFeeReversalCents: number;
  influencerCommissionReversalCents: number;
  vendorRefundCents: number;
  outsydeRevenueReductionCents: number;
  isFullRefund: boolean;
} {
  const ratio = params.originalSubtotalCents > 0
    ? params.refundAmountCents / params.originalSubtotalCents
    : 1;
  const isFullRefund = ratio >= 1;
  const r = isFullRefund ? 1 : ratio;

  const consumerServiceFeeReversalCents = Math.round(params.originalConsumerServiceFeeCents * r);
  const platformFeeReversalCents = Math.round(params.originalPlatformFeeCents * r);
  const influencerCommissionReversalCents = Math.round(params.originalInfluencerCommissionCents * r);
  const vendorRefundCents = params.refundAmountCents - platformFeeReversalCents - influencerCommissionReversalCents;
  const outsydeRevenueReductionCents = consumerServiceFeeReversalCents + platformFeeReversalCents;

  return {
    consumerServiceFeeReversalCents,
    platformFeeReversalCents,
    influencerCommissionReversalCents,
    vendorRefundCents: Math.max(0, vendorRefundCents),
    outsydeRevenueReductionCents,
    isFullRefund,
  };
}

// =====================================================
// EVENT TICKETS (decided 2026-10-18)
// =====================================================
// Buyer pays the ticket price + the consumer service fee (8%) + a flat $0.99 per paid ticket.
// Host pays the 2% platform fee. Worked out PER TICKET and saved on each ticket at sale; the host is
// paid once per event. Free tickets carry no fees.

export const TICKET_PER_TICKET_FEE_CENTS = 99;
export const TICKET_PLATFORM_FEE_RATE = 0.02;
export const TICKET_FEE_MODEL_VERSION = 'tickets-v1';

export interface TicketFeeBreakdown {
  /** One ticket */
  unitPriceCents: number;
  unitServiceFeeCents: number;
  unitPerTicketFeeCents: number;
  unitPlatformFeeCents: number;
  unitHostNetCents: number;
  unitBuyerTotalCents: number;
  /** Whole order (unit x quantity, so the order always equals the sum of its tickets) */
  quantity: number;
  subtotalCents: number;
  serviceFeeCents: number;
  perTicketFeeCents: number;
  platformFeeCents: number;
  hostNetCents: number;
  totalCents: number;
  outsydeGrossRevenueCents: number;
  feeModelVersion: string;
}

export function calculateTicketFees(unitPriceCents: number, quantity: number): TicketFeeBreakdown {
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) throw new Error('unitPriceCents must be a non-negative integer');
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('quantity must be a positive integer');
  const free = unitPriceCents === 0;
  const unitServiceFeeCents = free ? 0 : Math.round(unitPriceCents * CONSUMER_SERVICE_FEE_RATE);
  const unitPerTicketFeeCents = free ? 0 : TICKET_PER_TICKET_FEE_CENTS;
  const unitPlatformFeeCents = free ? 0 : Math.round(unitPriceCents * TICKET_PLATFORM_FEE_RATE);
  const unitHostNetCents = unitPriceCents - unitPlatformFeeCents;
  const unitBuyerTotalCents = unitPriceCents + unitServiceFeeCents + unitPerTicketFeeCents;
  return {
    unitPriceCents, unitServiceFeeCents, unitPerTicketFeeCents, unitPlatformFeeCents, unitHostNetCents, unitBuyerTotalCents,
    quantity,
    subtotalCents: unitPriceCents * quantity,
    serviceFeeCents: unitServiceFeeCents * quantity,
    perTicketFeeCents: unitPerTicketFeeCents * quantity,
    platformFeeCents: unitPlatformFeeCents * quantity,
    hostNetCents: unitHostNetCents * quantity,
    totalCents: unitBuyerTotalCents * quantity,
    outsydeGrossRevenueCents: (unitServiceFeeCents + unitPerTicketFeeCents + unitPlatformFeeCents) * quantity,
    feeModelVersion: TICKET_FEE_MODEL_VERSION,
  };
}
