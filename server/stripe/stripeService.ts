// Stripe service for Outsyde marketplace
// Handles Stripe Connect + checkout (core only)

import { getUncachableStripeClient } from "./stripeClient";
import { db } from "../db";
import { subscriptionTiers } from "@shared/schema";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";

function idempotencyKey(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Per-request bound for the event payout job's Stripe calls (only the fields given are set). */
function eventPayoutRequestOptions(o: { timeoutMs?: number; maxNetworkRetries?: number }): { timeout?: number; maxNetworkRetries?: number } {
  return {
    ...(o.timeoutMs !== undefined ? { timeout: o.timeoutMs } : {}),
    ...(o.maxNetworkRetries !== undefined ? { maxNetworkRetries: o.maxNetworkRetries } : {}),
  };
}

/** Bound for the bank payout calls: eventPayoutRequestOptions plus defaults of 30 s and 1 network retry for missing fields. */
function boundedPayoutOptions(o: { timeoutMs?: number; maxNetworkRetries?: number }): { timeout: number; maxNetworkRetries: number } {
  const set = eventPayoutRequestOptions(o);
  return { timeout: set.timeout ?? 30000, maxNetworkRetries: set.maxNetworkRetries ?? 1 };
}

export class StripeService {
  // =========================
  // CUSTOMERS
  // =========================

  async createCustomer(email: string, userId: string, name?: string) {
    const stripe = await getUncachableStripeClient();
    return stripe.customers.create({
      email,
      name,
      metadata: { userId },
    });
  }

  /**
   * Read-through helper: returns an existing Stripe Customer ID if valid, or
   * creates a new one. Handles the edge case where a Customer was deleted
   * directly in the Stripe Dashboard (retrieve throws a "No such customer" error).
   * Callers are responsible for persisting the returned ID to the users table
   * if it differs from existingStripeCustomerId.
   */
  async getOrCreateStripeCustomer(params: {
    userId: string;
    email: string;
    name?: string;
    existingStripeCustomerId?: string | null;
  }): Promise<string> {
    const stripe = await getUncachableStripeClient();

    if (params.existingStripeCustomerId) {
      try {
        const existing = await stripe.customers.retrieve(params.existingStripeCustomerId);
        if (!('deleted' in existing) || !existing.deleted) {
          return existing.id;
        }
        // Customer was deleted on Stripe side — fall through to create
      } catch (err: any) {
        if (err?.code !== 'resource_missing') throw err;
        // Customer doesn't exist on Stripe — fall through to create
      }
    }

    const customer = await stripe.customers.create({
      email: params.email,
      name: params.name,
      metadata: { userId: params.userId },
    });
    return customer.id;
  }

  // =========================
  // STRIPE CONNECT (VENDORS)
  // =========================

  /**
   * Create a Stripe Express account for a photographer
   */
  async createPhotographerConnectAccount(
    email: string,
    photographerId: string,
    displayName: string
  ) {
    const stripe = await getUncachableStripeClient();

    return stripe.accounts.create({
      type: "express",
      email,
      business_type: "individual",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        name: displayName,
        mcc: "7221", // Photography
      },
      metadata: {
        photographerId,
        role: "photographer",
      },
    });
  }

  /**
   * Create a Stripe Express account for a business vendor
   */
  async createBusinessConnectAccount(
    email: string,
    businessId: string,
    businessName: string,
    category?: string
  ) {
    const stripe = await getUncachableStripeClient();

    // Map category to MCC code (default to general retail)
    const mccCodes: Record<string, string> = {
      'food': '5812', // Eating places and restaurants
      'restaurant': '5812',
      'retail': '5999', // Miscellaneous retail stores
      'clothing': '5651', // Family clothing stores
      'beauty': '7230', // Beauty shops
      'health': '8099', // Health and allied services
      'fitness': '7997', // Membership clubs (sports/recreation)
      'services': '7299', // Miscellaneous personal services
      'home': '5722', // Household appliance stores
      'art': '5971', // Art dealers and galleries
      'automotive': '5533', // Automotive parts
    };
    const mcc = category ? (mccCodes[category.toLowerCase()] || '5999') : '5999';

    return stripe.accounts.create({
      type: "express",
      email,
      business_type: "company",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        name: businessName,
        mcc,
      },
      metadata: {
        businessId,
        role: "business",
      },
    });
  }

  /**
   * Create a Stripe Express account for an influencer
   * Influencers only receive transfers (payouts), never process payments
   */
  async createInfluencerConnectAccount(
    email: string,
    influencerId: string,
    displayName: string
  ) {
    const stripe = await getUncachableStripeClient();

    return stripe.accounts.create({
      type: "express",
      email,
      business_type: "individual",
      capabilities: {
        transfers: { requested: true },
      },
      business_profile: {
        name: displayName,
        mcc: "7311", // Advertising services
      },
      metadata: {
        influencerId,
        role: "influencer",
      },
    });
  }

  /**
   * Create a transfer to an influencer's connected account
   * This is how influencers get paid - via direct transfers, not through checkout sessions
   */
  async createInfluencerPayout(
    destinationAccountId: string,
    amountInCents: number,
    metadata: Record<string, string>
  ) {
    const stripe = await getUncachableStripeClient();

    return stripe.transfers.create({
      amount: amountInCents,
      currency: "usd",
      destination: destinationAccountId,
      metadata,
    });
  }

  /**
   * Create onboarding link for any Connect account (business or photographer)
   */
  async createConnectOnboardingLink(
    accountId: string,
    refreshUrl: string,
    returnUrl: string
  ) {
    const stripe = await getUncachableStripeClient();

    return stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });
  }

  /**
   * Get the status of a Connect account
   */
  async getConnectAccountStatus(accountId: string) {
    const stripe = await getUncachableStripeClient();
    const account = await stripe.accounts.retrieve(accountId);

    return {
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements,
    };
  }

  /**
   * Check if a Connect account has completed onboarding by fetching from Stripe API.
   * Returns true if charges_enabled AND payouts_enabled are both true.
   * This is the source of truth for onboarding completion.
   */
  async isOnboardingComplete(accountId: string): Promise<boolean> {
    try {
      const status = await this.getConnectAccountStatus(accountId);
      return status.chargesEnabled === true && status.payoutsEnabled === true;
    } catch (error) {
      console.error(`[Stripe] Failed to check onboarding status for ${accountId}:`, error);
      return false;
    }
  }

  /**
   * Self-healing sync: Check Stripe API and update local database if onboarding is complete.
   * Use this before blocking publish attempts or returning onboarding status.
   * 
   * @param entityType - 'photographer' | 'business'
   * @param entityId - The photographer or business ID
   * @param stripeAccountId - The Stripe Connect account ID
   * @param currentOnboardingComplete - Current local database value
   * @param updateFn - Function to update the entity in the database
   * @returns Updated onboarding complete status
   */
  async syncOnboardingStatus(params: {
    entityType: 'photographer' | 'business';
    entityId: string;
    stripeAccountId: string;
    currentOnboardingComplete: boolean;
    updateFn: (id: string, data: { stripeOnboardingComplete: boolean }) => Promise<any>;
  }): Promise<boolean> {
    // If already marked complete locally, trust it
    if (params.currentOnboardingComplete) {
      return true;
    }

    // If no Stripe account ID, can't be complete
    if (!params.stripeAccountId) {
      return false;
    }

    // Fetch from Stripe API
    const isComplete = await this.isOnboardingComplete(params.stripeAccountId);

    // If Stripe says complete but local says not, sync the database
    if (isComplete && !params.currentOnboardingComplete) {
      console.log(`[Stripe] Self-healing: ${params.entityType} ${params.entityId} onboarding is complete in Stripe, updating local database`);
      await params.updateFn(params.entityId, { stripeOnboardingComplete: true });
    }

    return isComplete;
  }

  /**
   * Create a Stripe Express account for a staff member.
   * Requests card_payments + transfers, same as photographers. Transfers-only is rejected
   * in live mode ("Your platform needs approval for accounts to have requested the
   * `transfers` capability without the `card_payments` capability", Render 2026-10-17),
   * and the staff account.updated branch only marks onboarding complete when
   * charges_enabled is true, which a transfers-only account never reaches.
   */
  async createStaffConnectAccount(
    email: string,
    staffId: string,
    businessId: string,
    displayName: string,
  ) {
    const stripe = await getUncachableStripeClient();

    return stripe.accounts.create({
      type: "express",
      email,
      business_type: "individual",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        name: displayName,
        mcc: "7299", // Miscellaneous personal services
      },
      metadata: {
        staffId,
        businessId,
        role: "staff",
      },
    });
  }

  /**
   * Legacy alias for createPhotographerConnectAccount
   */
  async createConnectAccount(
    email: string,
    photographerId: string,
    displayName: string
  ) {
    return this.createPhotographerConnectAccount(email, photographerId, displayName);
  }

  // =========================
  // CHECKOUT (DESTINATION CHARGES)
  // =========================

  async createCheckoutSession(params: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    connectedAccountId: string;
    platformFeeInCents: number;
    metadata?: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    return stripe.checkout.sessions.create({
      customer: params.customerId,
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price: params.priceId,
          quantity: 1,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      payment_intent_data: {
        application_fee_amount: params.platformFeeInCents,
        transfer_data: {
          destination: params.connectedAccountId,
        },
      },
      metadata: params.metadata,
    }, { idempotencyKey: idempotencyKey('checkout') });
  }

  // =========================
  // PAYMENT INTENTS (BOOKING PAYMENTS)
  // =========================

  /**
   * Create a PaymentIntent for a booking with destination charges (Stripe Connect)
   * 
   * @param captureMethod - "automatic" for immediate capture, "manual" for auth-only (pending provider approval)
   * @param connectedAccountId - The vendor's Stripe Connect account ID
   * @param applicationFeeAmount - Platform fee in cents
   */
  async createBookingPaymentIntent(params: {
    totalChargedCents: number;
    vendorPayoutCents: number;
    currency?: string;
    customerId?: string;
    connectedAccountId: string;
    captureMethod: 'automatic' | 'manual';
    metadata: Record<string, string>;
    description?: string;
    saveForFutureUse?: boolean;
  }) {
    const stripe = await getUncachableStripeClient();

    const paymentIntentData: Record<string, unknown> = {
      amount: params.totalChargedCents,
      currency: params.currency || 'usd',
      capture_method: params.captureMethod,
      transfer_data: {
        destination: params.connectedAccountId,
        amount: params.vendorPayoutCents,
      },
      metadata: params.metadata,
      description: params.description,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never',
      },
    };

    if (params.customerId) {
      paymentIntentData.customer = params.customerId;
    }

    if (params.saveForFutureUse) {
      paymentIntentData.setup_future_usage = 'off_session';
    }

    return stripe.paymentIntents.create(paymentIntentData as any, {
      idempotencyKey: idempotencyKey('pi'),
    });
  }

  /**
   * Create a plain PaymentIntent for the full charge amount, with NO
   * transfer_data / application_fee_amount at all. Funds land on the
   * platform's own Stripe balance, not sent to any connected account.
   *
   * Used by the hold-based business/staff booking flow: at this point we
   * don't yet know the real split (staff vs. business booth-cut, Model A),
   * so the split is computed and paid out later, asynchronously, via
   * separate stripe.transfers.create() calls once the charge succeeds
   * (see webhookHandlers.ts handlePaymentIntentSucceeded, type 'appointment').
   */
  async createPlatformPaymentIntent(params: {
    amountCents: number;
    currency?: string;
    customerId?: string;
    captureMethod: 'automatic' | 'manual';
    metadata: Record<string, string>;
    description?: string;
    saveForFutureUse?: boolean;
    // Deterministic key so a retry returns the PaymentIntent an earlier
    // attempt created instead of creating a second one. Stripe rejects a
    // reused key sent with different parameters. Default: random per call.
    idempotencyKey?: string;
  }) {
    const stripe = await getUncachableStripeClient();

    const paymentIntentData: Record<string, unknown> = {
      amount: params.amountCents,
      currency: params.currency || 'usd',
      capture_method: params.captureMethod,
      metadata: params.metadata,
      description: params.description,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never',
      },
    };

    if (params.customerId) {
      paymentIntentData.customer = params.customerId;
    }

    if (params.saveForFutureUse) {
      paymentIntentData.setup_future_usage = 'off_session';
    }

    return stripe.paymentIntents.create(paymentIntentData as any, {
      idempotencyKey: params.idempotencyKey ?? idempotencyKey('pi'),
    });
  }

  /**
   * Transfer a booking payout from the platform balance to a connected
   * account (staff member or business), after a plain platform-balance
   * charge (createPlatformPaymentIntent) has succeeded. Separate-transfer
   * pattern, not a destination charge -- mirrors transferToVendor() below,
   * with booking-specific metadata for reconciliation.
   */
  async transferBookingPayout(params: {
    amountInCents: number;
    connectedAccountId: string;
    appointmentId: string;
    recipient: 'staff' | 'business';
  }) {
    const stripe = await getUncachableStripeClient();
    const transferGroup = `appointment_${params.appointmentId}`;

    // Stripe keeps idempotency keys for 24h only, so also look for an earlier
    // transfer to this recipient in the appointment's transfer group.
    const existing = await stripe.transfers.list({ transfer_group: transferGroup, limit: 10 });
    const prior = existing.data.find(t => t.metadata?.recipient === params.recipient);
    if (prior) {
      return prior;
    }

    // Deterministic key: must be stable across retries, so not the
    // idempotencyKey() helper (it appends randomUUID()).
    return stripe.transfers.create({
      amount: params.amountInCents,
      currency: "usd",
      destination: params.connectedAccountId,
      transfer_group: transferGroup,
      metadata: {
        appointmentId: params.appointmentId,
        recipient: params.recipient,
        type: 'appointment_booking_payout',
      },
    }, { idempotencyKey: `transfer_appt_${params.appointmentId}_${params.recipient}` });
  }

  /**
   * One transfer for a booking payout, with the same transfer_group and metadata shape as
   * transferBookingPayout / transferShootBookingPayout, so their "already paid?" lookups see it.
   * recipientKey is the metadata recipient ('business', 'staff', 'photographer', or
   * '<recipient>_rewards' for the part Outsyde adds after a points code). With sourceTransaction
   * the transfer is tied to that charge: Stripe accepts it even when the available balance is
   * short and sends the money once the charge's funds are available.
   */
  async createBookingTransfer(params: {
    kind: 'appointment' | 'shoot_booking';
    bookingId: string;
    recipientKey: string;
    connectedAccountId: string;
    amountInCents: number;
    sourceTransaction?: string;
    idempotencyKey: string;
  }) {
    const stripe = await getUncachableStripeClient();
    const transferGroup = params.kind === 'appointment' ? `appointment_${params.bookingId}` : `shoot_booking_${params.bookingId}`;
    const existing = await stripe.transfers.list({ transfer_group: transferGroup, limit: 20 });
    const prior = existing.data.find(t => t.metadata?.recipient === params.recipientKey);
    if (prior) return prior;
    const metadata: Record<string, string> = params.kind === 'appointment'
      ? { appointmentId: params.bookingId, recipient: params.recipientKey, type: 'appointment_booking_payout' }
      : { bookingId: params.bookingId, recipient: params.recipientKey, type: 'shoot_booking_payout' };
    return stripe.transfers.create({
      amount: params.amountInCents,
      currency: 'usd',
      destination: params.connectedAccountId,
      transfer_group: transferGroup,
      metadata,
      ...(params.sourceTransaction ? { source_transaction: params.sourceTransaction } : {}),
    }, { idempotencyKey: params.idempotencyKey });
  }

  // =========================
  // EVENT HOST PAYOUTS
  // =========================

  /**
   * Create a Stripe Express account for an event host. Same shape as the staff helper
   * (card_payments + transfers, since transfers-only is rejected in live mode).
   */
  async createHostConnectAccount(email: string, userId: string, idempotencyKey?: string) {
    const stripe = await getUncachableStripeClient();

    return stripe.accounts.create({
      type: "express",
      email,
      business_type: "individual",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        mcc: "7922", // Theatrical producers (except motion pictures) and ticket agencies
        product_description: "Event hosting and ticketed events",
      },
      metadata: {
        role: "host",
        userId,
      },
    }, idempotencyKey ? { idempotencyKey } : undefined);
  }

  /** Whether a host's Connect account can take payouts: ready = charges and payouts both enabled. */
  async getPayoutReadiness(accountId: string, opts?: { timeoutMs?: number; maxNetworkRetries?: number }): Promise<{ ready: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }> {
    const stripe = await getUncachableStripeClient();
    // Optional bound per request (the payout job passes one); without it the client defaults apply as before.
    const account = opts ? await stripe.accounts.retrieve(accountId, {}, eventPayoutRequestOptions(opts)) : await stripe.accounts.retrieve(accountId);
    const chargesEnabled = !!account.charges_enabled;
    const payoutsEnabled = !!account.payouts_enabled;
    return {
      ready: chargesEnabled && payoutsEnabled,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted: !!account.details_submitted,
    };
  }

  /**
   * An event payout transfer already sent for this payout, if any. Looks in the event's
   * transfer_group for the one whose metadata.payoutId matches. A single page of 100 is enough
   * (one transfer per payout plus rare recoveries per event), so no paging is done.
   */
  async findEventPayoutTransfer(eventId: string, payoutId: string, opts?: { timeoutMs?: number; maxNetworkRetries?: number }): Promise<{ id: string; amount: number } | null> {
    const stripe = await getUncachableStripeClient();
    const params = { transfer_group: `event_${eventId}`, limit: 100 };
    const existing = opts ? await stripe.transfers.list(params, eventPayoutRequestOptions(opts)) : await stripe.transfers.list(params);
    const prior = existing.data.find(t => t.metadata?.payoutId === payoutId);
    return prior ? { id: prior.id, amount: prior.amount } : null;
  }

  /**
   * Send an event payout to the host's Connect account. Idempotent on event_payout_<payoutId> unless the caller
   * passes its own key (the payout job uses one key per try, since Stripe replays a saved error for 24 hours).
   */
  async createEventPayoutTransfer(p: {
    eventId: string; payoutId: string; destination: string; amountCents: number; idempotencyKey?: string;
    /** Bounded so the whole call ends well inside the payout job's 10 minute claim (default 30 s, 1 network retry). */
    timeoutMs?: number; maxNetworkRetries?: number;
  }): Promise<{ id: string }> {
    const stripe = await getUncachableStripeClient();
    const transfer = await stripe.transfers.create({
      amount: p.amountCents,
      currency: 'usd',
      destination: p.destination,
      transfer_group: `event_${p.eventId}`,
      metadata: { type: 'event_payout', eventId: p.eventId, payoutId: p.payoutId },
    }, {
      idempotencyKey: p.idempotencyKey ?? `event_payout_${p.payoutId}`,
      timeout: p.timeoutMs ?? 30000,
      maxNetworkRetries: p.maxNetworkRetries ?? 1,
    });
    return { id: transfer.id };
  }

  /**
   * Pull back part of an event payout after a ticket refund. Idempotent on event_recovery_<ticketId> unless the
   * caller passes its own key (the recovery job uses one key per try, since Stripe replays a saved error for 24
   * hours). timeoutMs / maxNetworkRetries bound the call when given; without them the client defaults apply.
   */
  async reverseEventPayoutTransfer(p: {
    transferId: string; ticketId: string; amountCents: number; idempotencyKey?: string;
    timeoutMs?: number; maxNetworkRetries?: number;
  }): Promise<{ id: string }> {
    const stripe = await getUncachableStripeClient();
    const reversal = await stripe.transfers.createReversal(p.transferId, {
      amount: p.amountCents,
      metadata: { type: 'event_payout_recovery', ticketId: p.ticketId },
    }, { idempotencyKey: p.idempotencyKey ?? `event_recovery_${p.ticketId}`, ...eventPayoutRequestOptions(p) });
    return { id: reversal.id };
  }

  /**
   * A reversal already made on this transfer for this ticket, if any (metadata.ticketId). One reversal per
   * refunded ticket of one event payout, so up to 10 pages of 100 are read (an event cancelled after its payout
   * can have hundreds). Each page call is bounded by opts when given.
   */
  async findEventPayoutReversal(transferId: string, ticketId: string, opts?: { timeoutMs?: number; maxNetworkRetries?: number }): Promise<{ id: string; amount: number } | null> {
    const stripe = await getUncachableStripeClient();
    let startingAfter: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params = { limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) };
      const list = opts ? await stripe.transfers.listReversals(transferId, params, eventPayoutRequestOptions(opts)) : await stripe.transfers.listReversals(transferId, params);
      const prior = list.data.find(r => r.metadata?.ticketId === ticketId);
      if (prior) return { id: prior.id, amount: prior.amount };
      if (!list.has_more || list.data.length === 0) return null;
      startingAfter = list.data[list.data.length - 1].id;
    }
    throw new Error(`more than 1000 reversals on transfer ${transferId}: can't tell if ticket ${ticketId} was reversed`);
  }

  // =========================
  // BOOKING REFUND RECOVERY. Every call is bounded by opts (defaults: 30 s, 1 network retry).

  /** Transfers made for a booking charge (by transfer_group): id, amount, amount already reversed and destination account. */
  async listBookingTransfers(transferGroup: string, opts: { timeoutMs?: number; maxNetworkRetries?: number } = {}): Promise<Array<{ id: string; amount: number; amountReversed: number; destination: string }>> {
    const stripe = await getUncachableStripeClient();
    const list = await stripe.transfers.list({ transfer_group: transferGroup, limit: 100 }, boundedPayoutOptions(opts));
    return list.data.map(t => ({
      id: t.id,
      amount: t.amount,
      amountReversed: t.amount_reversed ?? 0,
      destination: typeof t.destination === 'string' ? t.destination : (t.destination?.id ?? ''),
    }));
  }

  /** Refunds on a PaymentIntent: id, amount, created (unix seconds) and status. */
  async listPaymentIntentRefunds(paymentIntentId: string, opts: { timeoutMs?: number; maxNetworkRetries?: number } = {}): Promise<Array<{ id: string; amount: number; created: number; status: string }>> {
    const stripe = await getUncachableStripeClient();
    const list = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 }, boundedPayoutOptions(opts));
    return list.data.map(r => ({ id: r.id, amount: r.amount, created: r.created, status: r.status ?? '' }));
  }

  /**
   * Reversals already made on a transfer for one refund (metadata.refundId). Up to 10 pages of 100 are read; each
   * page call is bounded by opts.
   */
  async findRecoveryReversals(transferId: string, refundId: string, opts: { timeoutMs?: number; maxNetworkRetries?: number } = {}): Promise<Array<{ id: string; amount: number }>> {
    const stripe = await getUncachableStripeClient();
    const found: Array<{ id: string; amount: number }> = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params = { limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) };
      const list = await stripe.transfers.listReversals(transferId, params, boundedPayoutOptions(opts));
      for (const r of list.data) if (r.metadata?.refundId === refundId) found.push({ id: r.id, amount: r.amount });
      if (!list.has_more || list.data.length === 0) return found;
      startingAfter = list.data[list.data.length - 1].id;
    }
    return found;
  }

  /** Take back part of a seller's transfer after a booking refund. The caller passes its own idempotency key (one per try). */
  async reverseForRecovery(p: {
    transferId: string; amountCents: number; refundId: string; bookingType: string; bookingId: string; idempotencyKey: string;
    timeoutMs?: number; maxNetworkRetries?: number;
  }): Promise<{ id: string }> {
    const stripe = await getUncachableStripeClient();
    const reversal = await stripe.transfers.createReversal(p.transferId, {
      amount: p.amountCents,
      metadata: { type: 'booking_refund_recovery', refundId: p.refundId, bookingType: p.bookingType, bookingId: p.bookingId },
    }, { idempotencyKey: p.idempotencyKey, ...boundedPayoutOptions(p) });
    return { id: reversal.id };
  }

  /** Amount the customer was charged on a PaymentIntent, in cents. */
  async getPaymentIntentAmountReceived(paymentIntentId: string, opts: { timeoutMs?: number; maxNetworkRetries?: number } = {}): Promise<number> {
    const stripe = await getUncachableStripeClient();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {}, boundedPayoutOptions(opts));
    return pi.amount_received ?? 0;
  }

  /** True when Stripe or the platform balance says there are not enough funds (same match as payouts.ts). */
  isInsufficientFundsError(err: unknown): boolean {
    const e = err as { code?: string; raw?: { code?: string }; message?: string } | null;
    const code = e?.code ?? e?.raw?.code;
    return code === 'balance_insufficient' || /insufficient (available )?funds/i.test(e?.message ?? '');
  }

  /** The charge behind a PaymentIntent: id, amount received and amount already refunded. */
  async getPaymentIntentCharge(paymentIntentId: string): Promise<{ chargeId: string | null; amountReceived: number; amountRefunded: number }> {
    const stripe = await getUncachableStripeClient();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    return {
      chargeId: charge?.id ?? (typeof pi.latest_charge === 'string' ? pi.latest_charge : null),
      amountReceived: pi.amount_received ?? 0,
      amountRefunded: charge?.amount_refunded ?? 0,
    };
  }

  /** Outsyde's available USD balance on Stripe (what booking payouts are paid from), in cents. */
  async getAvailableBalanceCents(): Promise<number> {
    const stripe = await getUncachableStripeClient();
    const balance = await stripe.balance.retrieve();
    return (balance.available ?? []).filter(b => b.currency === 'usd').reduce((sum, b) => sum + b.amount, 0);
  }

  // =========================
  // DAILY BANK PAYOUT (platform balance -> Outsyde's bank). Every call is bounded by opts (defaults: 30 s, 1 network retry).
  // =========================

  /** The platform's own payout schedule interval ('manual', 'daily', 'weekly', 'monthly'), or null when Stripe returns none. */
  async getPlatformPayoutInterval(opts: { timeoutMs?: number; maxNetworkRetries?: number } = {}): Promise<string | null> {
    const stripe = await getUncachableStripeClient();
    // GET /v1/account (the platform itself, no account id).
    const account = await stripe.accounts.retrieveCurrent({}, boundedPayoutOptions(opts));
    return account.settings?.payouts?.schedule?.interval ?? null;
  }

  /** Available USD balance in cents, plus the other currencies that hold a non-zero available amount. */
  async getAvailableUsdBalance(opts: { timeoutMs?: number; maxNetworkRetries?: number } = {}): Promise<{ usdCents: number; otherCurrencies: string[] }> {
    const stripe = await getUncachableStripeClient();
    const balance = await stripe.balance.retrieve({}, boundedPayoutOptions(opts));
    const available = balance.available ?? [];
    const usdCents = available.filter(b => b.currency === 'usd').reduce((sum, b) => sum + b.amount, 0);
    const otherCurrencies = Array.from(new Set(available.filter(b => b.currency !== 'usd' && b.amount !== 0).map(b => b.currency)));
    return { usdCents, otherCurrencies };
  }

  /** Platform payouts created at or after sinceUnix. Follows has_more for up to 5 pages of 100. */
  async listPlatformPayoutsCreatedSince(sinceUnix: number, opts: { timeoutMs?: number; maxNetworkRetries?: number } = {}): Promise<Array<{ id: string; amount: number; status: string; created: number; metadata: Record<string, string> }>> {
    const stripe = await getUncachableStripeClient();
    const out: Array<{ id: string; amount: number; status: string; created: number; metadata: Record<string, string> }> = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 5; page++) {
      const list = await stripe.payouts.list(
        { created: { gte: sinceUnix }, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
        boundedPayoutOptions(opts),
      );
      for (const p of list.data) out.push({ id: p.id, amount: p.amount, status: p.status, created: p.created, metadata: (p.metadata ?? {}) as Record<string, string> });
      if (!list.has_more || list.data.length === 0) break;
      startingAfter = list.data[list.data.length - 1].id;
    }
    return out;
  }

  /**
   * Send one standard payout from the platform's USD balance to its bank. The caller supplies the idempotency
   * key (one per try: Stripe replays a saved response, errors included, for 24 hours).
   */
  async createPlatformPayout(p: {
    amountCents: number; payoutDate: string; rowId: string; idempotencyKey: string;
    timeoutMs?: number; maxNetworkRetries?: number;
  }): Promise<{ id: string; status: string }> {
    const stripe = await getUncachableStripeClient();
    const payout = await stripe.payouts.create({
      amount: p.amountCents,
      currency: 'usd',
      method: 'standard',
      statement_descriptor: 'OUTSYDE',
      description: `Outsyde daily payout ${p.payoutDate}`,
      metadata: { type: 'outsyde_bank_payout', payoutDate: p.payoutDate, rowId: p.rowId },
    }, { idempotencyKey: p.idempotencyKey, ...boundedPayoutOptions(p) });
    return { id: payout.id, status: payout.status };
  }

  /** Current state of a platform payout, with Stripe's failure code when it failed. */
  async retrievePlatformPayout(id: string, opts: { timeoutMs?: number; maxNetworkRetries?: number } = {}): Promise<{ id: string; status: string; failureCode: string | null }> {
    const stripe = await getUncachableStripeClient();
    const payout = await stripe.payouts.retrieve(id, {}, boundedPayoutOptions(opts));
    return { id: payout.id, status: payout.status, failureCode: payout.failure_code ?? null };
  }

  /**
   * Pull money from the platform's verified bank account into the Stripe balance (Stripe
   * top-up). Needs an approved platform profile and a verified bank; ACH funds take days.
   */
  async createBalanceTopUp(amountCents: number, description: string, idempotencyKey: string) {
    const stripe = await getUncachableStripeClient();
    return stripe.topups.create({
      amount: amountCents,
      currency: 'usd',
      description,
      statement_descriptor: 'Outsyde payouts',
    }, { idempotencyKey });
  }

  /**
   * Transfer a photographer payout from the platform balance to the photographer's
   * connected account after a platform-balance PaymentIntent has succeeded.
   * Parallel to transferBookingPayout() (business/staff path) — kept separate
   * because the metadata shape and transfer_group key differ for shoot bookings.
   */
  async transferShootBookingPayout(params: {
    amountInCents: number;
    connectedAccountId: string;
    bookingId: string;
  }) {
    const stripe = await getUncachableStripeClient();
    const transferGroup = `shoot_booking_${params.bookingId}`;

    // Stripe keeps idempotency keys for 24h only, so also look for an earlier
    // photographer transfer in the booking's transfer group.
    const existing = await stripe.transfers.list({ transfer_group: transferGroup, limit: 10 });
    const prior = existing.data.find(t => t.metadata?.recipient === 'photographer');
    if (prior) {
      return prior;
    }

    // Deterministic key: must be stable across retries, so not the
    // idempotencyKey() helper (it appends randomUUID()).
    return stripe.transfers.create({
      amount: params.amountInCents,
      currency: 'usd',
      destination: params.connectedAccountId,
      transfer_group: transferGroup,
      metadata: {
        bookingId: params.bookingId,
        recipient: 'photographer',
        type: 'shoot_booking_payout',
      },
    }, { idempotencyKey: `transfer_shoot_${params.bookingId}_photographer` });
  }

  /**
   * Capture a previously authorized PaymentIntent (for manual capture flow)
   * Called when provider accepts a booking
   */
  async capturePaymentIntent(paymentIntentId: string, amountToCaptureCents?: number) {
    const stripe = await getUncachableStripeClient();

    const captureParams: any = {};
    if (amountToCaptureCents !== undefined) {
      captureParams.amount_to_capture = amountToCaptureCents;
    }

    return stripe.paymentIntents.capture(paymentIntentId, captureParams);
  }

  /**
   * Cancel a PaymentIntent (void authorization for manual capture)
   * Called when provider declines or booking expires
   */
  async cancelPaymentIntent(paymentIntentId: string, cancellationReason?: 'duplicate' | 'fraudulent' | 'requested_by_customer' | 'abandoned') {
    const stripe = await getUncachableStripeClient();

    return stripe.paymentIntents.cancel(paymentIntentId, {
      cancellation_reason: cancellationReason || 'abandoned',
    });
  }

  /**
   * Change the amount and metadata of a PaymentIntent the customer has not paid yet
   * (requires_payment_method / requires_confirmation / requires_action). Used when the
   * customer adds, changes or removes a points code before paying.
   */
  async updateUnpaidPaymentIntent(paymentIntentId: string, params: { amountCents: number; metadata: Record<string, string> }) {
    const stripe = await getUncachableStripeClient();
    return stripe.paymentIntents.update(paymentIntentId, {
      amount: params.amountCents,
      metadata: params.metadata,
    });
  }

  /**
   * Retrieve a PaymentIntent to check its status
   */
  async getPaymentIntent(paymentIntentId: string) {
    const stripe = await getUncachableStripeClient();
    return stripe.paymentIntents.retrieve(paymentIntentId);
  }

  /**
   * What a refund against this PaymentIntent can still return: the amount
   * Stripe actually received minus anything already refunded on its charge.
   * `status` lets callers spot an uncaptured authorization (requires_capture),
   * which must be canceled rather than refunded.
   */
  async getPaymentIntentForRefund(paymentIntentId: string): Promise<{ status: string; amountReceived: number; amountRefunded: number }> {
    const stripe = await getUncachableStripeClient();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    return {
      status: pi.status,
      amountReceived: pi.amount_received ?? 0,
      amountRefunded: charge?.amount_refunded ?? 0,
    };
  }

  async getPaymentMethodIdFromIntent(paymentIntentId: string): Promise<string | null> {
    const stripe = await getUncachableStripeClient();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const pm = pi.payment_method;
    if (!pm) return null;
    return typeof pm === 'string' ? pm : pm.id;
  }

  async chargeSavedPaymentMethod(params: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    metadata: Record<string, string>;
    description?: string;
  }) {
    const stripe = await getUncachableStripeClient();
    return stripe.paymentIntents.create({
      amount: params.amountCents,
      currency: 'usd',
      customer: params.customerId,
      payment_method: params.paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: params.metadata,
      description: params.description,
    });
  }

  // =========================
  // REFUNDS (PLATFORM CONTROLLED)
  // =========================

  async refundPayment(
    paymentIntentId: string,
    amountInCents?: number
  ) {
    const stripe = await getUncachableStripeClient();

    return stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amountInCents,
    });
  }

  /**
   * Create a refund for a booking with tracking
   * Returns the refund object for storing stripeRefundId
   */
  async createBookingRefund(params: {
    paymentIntentId: string;
    amountCents?: number; // undefined = full refund
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    metadata?: Record<string, string>;
    // Deterministic key so a retried request returns the ORIGINAL refund
    // instead of creating a second one. Must be stable across retries —
    // do not build it with the idempotencyKey() helper above, which appends
    // randomUUID() and defeats deduplication.
    idempotencyKey?: string;
  }) {
    const stripe = await getUncachableStripeClient();

    // Never ask for more than the customer was charged: a points code can make the charge
    // smaller than the service price some callers default to, and Stripe rejects that refund
    // outright. Capped at the amount received (fixed for this PaymentIntent), so a retried call
    // sends the same amount and the idempotency key still returns the original refund.
    // If that read fails, the refund goes ahead exactly as asked (as before this cap).
    let amountCents = params.amountCents;
    if (amountCents !== undefined) {
      try {
        const state = await this.getPaymentIntentForRefund(params.paymentIntentId);
        if (state.amountReceived > 0 && amountCents > state.amountReceived) {
          console.warn(`[Refund] capped pi=${params.paymentIntentId}: asked ${amountCents}, charged ${state.amountReceived}`);
          amountCents = state.amountReceived;
        }
      } catch (err) {
        console.error(`[Refund] could not read pi=${params.paymentIntentId} for the cap; refunding as asked:`, err);
      }
    }

    const refund = await stripe.refunds.create(
      {
        payment_intent: params.paymentIntentId,
        amount: amountCents,
        reason: params.reason || 'requested_by_customer',
        metadata: params.metadata,
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined
    );

    // Record the refund so the seller's share is taken back later. Fire and forget: never throws, never
    // delays or changes the refund; a failure is only logged.
    void (async () => {
      try {
        const { recordBookingRefund } = await import("../bookingRecoveries");
        await recordBookingRefund({
          refundId: refund.id,
          paymentIntentId: params.paymentIntentId,
          refundCents: refund.amount,
          createdUnix: refund.created,
        });
      } catch (err) {
        console.error(`[Refund] could not record refund ${refund.id} for recovery:`, err);
      }
    })();

    return refund;
  }

  /**
   * Refund a cancelled paid product order.
   *
   * Two-call pattern required for destination charges:
   *   1. Refund the customer in full WITHOUT auto-reversing the transfer or fee.
   *   2. Separately reverse exactly `vendorReclaimCents` from the auto-created transfer
   *      so the platform recoups the vendor's net without touching its own fee.
   *
   * Using `reverse_transfer: true` on the refund alone would only reverse the transfer
   * proportionally (customer refund / gross charge), not the full vendor net.
   */
  async refundOrderCancellation(params: {
    paymentIntentId: string;
    refundAmountCents: number;  // order.totalAmount — full customer refund
    vendorReclaimCents: number; // order.vendorNet  — exact amount to pull back from vendor
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    // Never more than the customer was charged (a points code can make the charge smaller than
    // the order base, and Stripe rejects a larger refund outright).
    // If that read fails, the refund goes ahead exactly as asked (as before this cap).
    let refundAmountCents = params.refundAmountCents;
    try {
      const refundState = await this.getPaymentIntentForRefund(params.paymentIntentId);
      if (refundState.amountReceived > 0 && refundAmountCents > refundState.amountReceived) {
        console.warn(`[Refund] order refund capped pi=${params.paymentIntentId}: asked ${params.refundAmountCents}, charged ${refundState.amountReceived}`);
        refundAmountCents = refundState.amountReceived;
      }
    } catch (err) {
      console.error(`[Refund] could not read pi=${params.paymentIntentId} for the cap; refunding as asked:`, err);
    }

    // Step 1: refund the customer; do NOT touch the transfer or application fee automatically
    const refund = await stripe.refunds.create({
      payment_intent: params.paymentIntentId,
      amount: refundAmountCents,
      reverse_transfer: false,
      refund_application_fee: false,
      reason: 'requested_by_customer',
      metadata: params.metadata,
    });

    // Step 2: retrieve the auto-created transfer and reverse exactly vendorReclaimCents
    const paymentIntent = await stripe.paymentIntents.retrieve(
      params.paymentIntentId,
      { expand: ['latest_charge.transfer'] }
    );
    const charge = paymentIntent.latest_charge as any;
    const transfer = charge?.transfer;
    const transferId = typeof transfer === 'string' ? transfer : transfer?.id;

    let transferReversal = null;
    if (transferId) {
      transferReversal = await stripe.transfers.createReversal(transferId, {
        amount: params.vendorReclaimCents,
        metadata: params.metadata,
      });
    } else {
      console.error(
        `[Refund] No transfer found for PaymentIntent ${params.paymentIntentId} — ` +
        `vendor reclaim skipped, needs manual reconciliation`
      );
    }

    return { refund, transferReversal };
  }

  // =========================
  // CATALOG MANAGEMENT (Products & Prices)
  // =========================

  /**
   * Create a Stripe Product for a vendor product, service, or photographer service
   * If connectedAccountId is provided, creates on the connected account (marketplace model)
   * Otherwise creates on the platform account (legacy behavior)
   */
  async createStripeProduct(params: {
    name: string;
    description?: string;
    metadata: {
      type: 'vendor_product' | 'vendor_service' | 'photographer_service';
      itemId: string;
      businessId?: string;
      photographerId?: string;
    };
    images?: string[];
    connectedAccountId?: string;
  }) {
    const stripe = await getUncachableStripeClient();

    const productData = {
      name: params.name,
      description: params.description || undefined,
      metadata: params.metadata,
      images: params.images?.filter(Boolean) || undefined,
    };

    if (params.connectedAccountId) {
      return stripe.products.create(productData, {
        stripeAccount: params.connectedAccountId,
      });
    }

    return stripe.products.create(productData);
  }

  /**
   * Create a Stripe Price for a product
   * Prices are immutable in Stripe - to change price, create a new one
   * If connectedAccountId is provided, creates on the connected account (marketplace model)
   */
  async createStripePrice(params: {
    productId: string;
    unitAmountCents: number;
    currency?: string;
    metadata?: Record<string, string>;
    connectedAccountId?: string;
  }) {
    const stripe = await getUncachableStripeClient();

    const priceData = {
      product: params.productId,
      unit_amount: params.unitAmountCents,
      currency: params.currency || 'usd',
      metadata: params.metadata,
    };

    if (params.connectedAccountId) {
      return stripe.prices.create(priceData, {
        stripeAccount: params.connectedAccountId,
      });
    }

    return stripe.prices.create(priceData);
  }

  /**
   * Deactivate a Stripe Price (archive it).
   * Used when a vendor changes their price — old price becomes inactive.
   * Pass connectedAccountId when the price lives on a Connect account.
   */
  async deactivateStripePrice(priceId: string, connectedAccountId?: string) {
    const stripe = await getUncachableStripeClient();

    if (connectedAccountId) {
      return stripe.prices.update(
        priceId,
        { active: false },
        { stripeAccount: connectedAccountId },
      );
    }
    return stripe.prices.update(priceId, { active: false });
  }

  /**
   * Update a Stripe Product's metadata or details (not price)
   */
  async updateStripeProduct(productId: string, params: {
    name?: string;
    description?: string;
    images?: string[];
    active?: boolean;
  }, connectedAccountId?: string) {
    const stripe = await getUncachableStripeClient();

    const updateData = {
      name: params.name,
      description: params.description || undefined,
      images: params.images?.filter(Boolean) || undefined,
      active: params.active,
    };

    if (connectedAccountId) {
      return stripe.products.update(productId, updateData, {
        stripeAccount: connectedAccountId,
      });
    }

    return stripe.products.update(productId, updateData);
  }

  /**
   * Archive a Stripe Product (set active=false)
   * Used when vendor archives their product/service
   * Pass connectedAccountId when the product lives on a Connect account.
   */
  async archiveStripeProduct(productId: string, connectedAccountId?: string) {
    const stripe = await getUncachableStripeClient();

    if (connectedAccountId) {
      return stripe.products.update(
        productId,
        { active: false },
        { stripeAccount: connectedAccountId },
      );
    }

    return stripe.products.update(productId, {
      active: false,
    });
  }

  // =========================
  // SUBSCRIPTION PRODUCTS SETUP
  // =========================

  async setupSubscriptionProducts() {
    // Subscription products are managed via Stripe dashboard
    // This is a placeholder for future automated product creation
    console.log('[stripe] Subscription products setup complete (using existing products)');
  }

  async setupAlaCarteProducts() {
    // A la carte products are managed via Stripe dashboard
    // This is a placeholder for future automated product creation
    console.log('[stripe] A la carte products setup complete (using existing products)');
  }

  // =========================
  // SUBSCRIPTION TIERS
  // =========================

  async getSubscriptionTiers() {
    const tiers = await db.select()
      .from(subscriptionTiers)
      .orderBy(asc(subscriptionTiers.sortOrder));
    return tiers;
  }

  // =========================
  // SUBSCRIPTION CHECKOUT
  // =========================

  async createTierSubscriptionCheckout(
    customerId: string,
    tierId: string,
    successUrl: string,
    cancelUrl: string,
    vendorId: string,
    businessId: string
  ) {
    const stripe = await getUncachableStripeClient();

    // Get the tier to find the Stripe price ID
    const [tier] = await db.select()
      .from(subscriptionTiers)
      .where(eq(subscriptionTiers.id, tierId));

    if (!tier) {
      throw new Error(`Subscription tier not found: ${tierId}`);
    }

    if (!tier.stripePriceId) {
      throw new Error(`Subscription tier ${tierId} has no Stripe price ID configured`);
    }

    // Create a subscription checkout session (web redirect flow)
    return stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: tier.stripePriceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        type: "vendor_subscription",
        vendorId,
        businessId,
        tierId,
      },
      subscription_data: {
        metadata: {
          vendorId,
          businessId,
          tierId,
        },
      },
    });
  }

  /**
   * Create a subscription directly and return the client secret for native Payment Sheet.
   * Used by React Native with Apple Pay / Google Pay.
   */
  async createTierSubscriptionNative(
    customerId: string,
    tierId: string,
    vendorId: string,
    businessId: string
  ): Promise<{ clientSecret: string; subscriptionId: string; ephemeralKey: string }> {
    const stripe = await getUncachableStripeClient();

    const [tier] = await db.select()
      .from(subscriptionTiers)
      .where(eq(subscriptionTiers.id, tierId));

    if (!tier) throw new Error(`Subscription tier not found: ${tierId}`);
    if (!tier.stripePriceId) throw new Error(`Subscription tier ${tierId} has no Stripe price ID configured`);

    // Create an ephemeral key for the customer (required for Payment Sheet)
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2024-06-20' }
    );

    // Create subscription with payment_behavior: 'default_incomplete' so we get a PaymentIntent
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: tier.stripePriceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        type: 'vendor_subscription',
        vendorId,
        businessId,
        tierId,
      },
    });

    // Extract client secret from the expanded PaymentIntent
    const invoice = subscription.latest_invoice as any;
    const paymentIntent = invoice?.payment_intent;

    if (!paymentIntent?.client_secret) {
      throw new Error('Failed to get client secret from subscription payment intent');
    }

    return {
      clientSecret: paymentIntent.client_secret,
      subscriptionId: subscription.id,
      ephemeralKey: ephemeralKey.secret!,
    };
  }

  // =========================
  // CART CHECKOUT (Multi-item, single vendor)
  // =========================

  /**
   * Create a checkout session for cart items from a single vendor
   * Uses destination charges to route payment to vendor minus platform fee
   */
  async createCartCheckout(params: {
    customerId: string;
    lineItems: Array<{
      stripePriceId: string;
      quantity: number;
    }>;
    successUrl: string;
    cancelUrl: string;
    connectedAccountId: string;
    platformFeeInCents: number;
    consumerServiceFeeCents?: number;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    // Build line items: product prices + consumer service fee
    const checkoutLineItems: Array<Record<string, unknown>> = params.lineItems.map(item => ({
      price: item.stripePriceId,
      quantity: item.quantity,
    }));

    // Add consumer service fee as a separate visible line item
    if (params.consumerServiceFeeCents && params.consumerServiceFeeCents > 0) {
      checkoutLineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Outsyde Service Fee',
            description: 'Platform service fee',
          },
          unit_amount: params.consumerServiceFeeCents,
        },
        quantity: 1,
      });
    }

    // application_fee_amount = platformFee + consumerServiceFee (both stay with Outsyde)
    const totalApplicationFee = params.platformFeeInCents + (params.consumerServiceFeeCents || 0);

    return stripe.checkout.sessions.create({
      customer: params.customerId,
      mode: "payment",
      payment_method_types: ["card"],
      line_items: checkoutLineItems as any,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      payment_intent_data: {
        application_fee_amount: totalApplicationFee,
        transfer_data: {
          destination: params.connectedAccountId,
        },
      },
      metadata: params.metadata,
    }, { idempotencyKey: idempotencyKey('cart') });
  }

  /**
   * Create a checkout session for cart without destination charge (for platform-only purchases)
   * Used when vendor has no connected Stripe account yet
   */
  async createCartCheckoutPlatform(params: {
    customerId: string;
    lineItems: Array<{
      stripePriceId: string;
      quantity: number;
    }>;
    successUrl: string;
    cancelUrl: string;
    consumerServiceFeeCents?: number;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    const checkoutLineItems: Array<Record<string, unknown>> = params.lineItems.map(item => ({
      price: item.stripePriceId,
      quantity: item.quantity,
    }));

    if (params.consumerServiceFeeCents && params.consumerServiceFeeCents > 0) {
      checkoutLineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Outsyde Service Fee',
            description: 'Platform service fee',
          },
          unit_amount: params.consumerServiceFeeCents,
        },
        quantity: 1,
      });
    }

    return stripe.checkout.sessions.create({
      customer: params.customerId,
      mode: "payment",
      payment_method_types: ["card"],
      line_items: checkoutLineItems as any,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
    }, { idempotencyKey: idempotencyKey('cart_platform') });
  }

  // =========================
  // MULTI-VENDOR CART CHECKOUT (Single Payment, Multiple Transfers)
  // =========================

  /**
   * Create a single checkout session for all cart items from multiple vendors.
   * Payment is collected by the platform, then transfers are made to each vendor after payment succeeds.
   * This provides a single payment experience for multi-vendor carts.
   */
  async createMultiVendorCartCheckout(params: {
    customerId: string;
    lineItems: Array<{
      stripePriceId: string;
      quantity: number;
    }>;
    successUrl: string;
    cancelUrl: string;
    consumerServiceFeeCents?: number;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    const checkoutLineItems: Array<Record<string, unknown>> = params.lineItems.map(item => ({
      price: item.stripePriceId,
      quantity: item.quantity,
    }));

    if (params.consumerServiceFeeCents && params.consumerServiceFeeCents > 0) {
      checkoutLineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Outsyde Service Fee',
            description: 'Platform service fee',
          },
          unit_amount: params.consumerServiceFeeCents,
        },
        quantity: 1,
      });
    }

    return stripe.checkout.sessions.create({
      customer: params.customerId,
      mode: "payment",
      payment_method_types: ["card"],
      line_items: checkoutLineItems as any,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
    }, { idempotencyKey: idempotencyKey('multi_vendor') });
  }

  /**
   * Transfer funds to a connected account after payment is received.
   * Used for multi-vendor checkout to split payment between vendors.
   * Transfers are made from the platform's available balance (no source_transaction).
   */
  async transferToVendor(params: {
    amountInCents: number;
    connectedAccountId: string;
    orderId: string;
    orderGroupId?: string;
  }) {
    const stripe = await getUncachableStripeClient();

    // Use transfer_group to link related transfers together for reporting
    const transferGroup = params.orderGroupId ? `order_group_${params.orderGroupId}` : `order_${params.orderId}`;

    console.log(`[Stripe] Transferring ${params.amountInCents}¢ to ${params.connectedAccountId} for order ${params.orderId}`);
    const transfer = await stripe.transfers.create({
      amount: params.amountInCents,
      currency: "usd",
      destination: params.connectedAccountId,
      transfer_group: transferGroup,
      metadata: {
        orderId: params.orderId,
        orderGroupId: params.orderGroupId || '',
        type: 'multi_vendor_cart_transfer',
      },
    }, { idempotencyKey: idempotencyKey(`transfer_${params.orderId}`) });
    console.log(`[Stripe] Transfer ${transfer.id} completed: ${params.amountInCents}¢ → ${params.connectedAccountId}`);
    return transfer;
  }

  /**
   * Retrieve a checkout session to get charge details after payment
   */
  async getCheckoutSession(sessionId: string) {
    const stripe = await getUncachableStripeClient();
    return stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'payment_intent.latest_charge'],
    });
  }

  // =========================
  // PHOTOGRAPHER BOOKING CHECKOUT (Marketplace Model)
  // =========================

  /**
   * Create a checkout session for photographer booking using destination charges.
   * Uses price_data for dynamic pricing - Stripe's destination charges model
   * allows platform to create charges and transfer funds to connected account.
   * Application fee is collected by platform automatically.
   */
  async createPhotographerBookingCheckout(params: {
    customerId?: string;
    connectedAccountId: string;
    amountInCents: number;
    platformFeeInCents: number;
    consumerServiceFeeCents?: number;
    serviceName: string;
    serviceDescription?: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    const lineItems: Array<Record<string, unknown>> = [
      {
        price_data: {
          currency: "usd",
          product_data: { name: params.serviceName, description: params.serviceDescription },
          unit_amount: params.amountInCents,
        },
        quantity: 1,
      },
    ];

    if (params.consumerServiceFeeCents && params.consumerServiceFeeCents > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Outsyde Service Fee", description: "Platform service fee" },
          unit_amount: params.consumerServiceFeeCents,
        },
        quantity: 1,
      });
    }

    const totalApplicationFee = params.platformFeeInCents + (params.consumerServiceFeeCents || 0);

    const sessionConfig: Record<string, unknown> = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      payment_intent_data: {
        application_fee_amount: totalApplicationFee,
        transfer_data: { destination: params.connectedAccountId },
      },
      metadata: params.metadata,
    };

    if (params.customerId) {
      sessionConfig.customer = params.customerId;
    }

    return stripe.checkout.sessions.create(sessionConfig as any, {
      idempotencyKey: idempotencyKey('photo_booking'),
    });
  }

  /**
   * Create a checkout session for business/staff appointment using destination charges.
   * Application fee (10%) is deducted and sent to platform.
   */
  async createAppointmentCheckout(params: {
    customerId?: string;
    connectedAccountId: string;
    amountInCents: number;
    platformFeeInCents: number;
    consumerServiceFeeCents?: number;
    serviceName: string;
    serviceDescription?: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    const lineItems: Array<Record<string, unknown>> = [
      {
        price_data: {
          currency: "usd",
          product_data: { name: params.serviceName, description: params.serviceDescription },
          unit_amount: params.amountInCents,
        },
        quantity: 1,
      },
    ];

    if (params.consumerServiceFeeCents && params.consumerServiceFeeCents > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Outsyde Service Fee", description: "Platform service fee" },
          unit_amount: params.consumerServiceFeeCents,
        },
        quantity: 1,
      });
    }

    const totalApplicationFee = params.platformFeeInCents + (params.consumerServiceFeeCents || 0);

    const sessionConfig: Record<string, unknown> = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      payment_intent_data: {
        application_fee_amount: totalApplicationFee,
        transfer_data: { destination: params.connectedAccountId },
      },
      metadata: params.metadata,
    };

    if (params.customerId) {
      sessionConfig.customer = params.customerId;
    }

    return stripe.checkout.sessions.create(sessionConfig as any, {
      idempotencyKey: idempotencyKey('appt_booking'),
    });
  }
}

export const stripeService = new StripeService();

/**
 * True when Stripe says a saved Connect account id is unusable from this platform: deleted, or
 * created under another platform or mode (e.g. an old sandbox account). Seen on Render 2026-10-17
 * from accountLinks.create: "You requested an account link for an account that is not connected
 * to your platform or does not exist."
 */
export function isUnreachableConnectAccountError(err: unknown): boolean {
  const e = err as { type?: string; code?: string; message?: string } | null;
  if (!e || e.type !== "StripeInvalidRequestError") return false;
  if (e.code === "account_invalid") return true;
  return /not connected to your platform or does not exist/i.test(e.message ?? "");
}
