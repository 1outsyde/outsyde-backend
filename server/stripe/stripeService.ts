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
      },
    };

    if (params.customerId) {
      paymentIntentData.customer = params.customerId;
    }

    return stripe.paymentIntents.create(paymentIntentData as any, {
      idempotencyKey: idempotencyKey('pi'),
    });
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
   * Retrieve a PaymentIntent to check its status
   */
  async getPaymentIntent(paymentIntentId: string) {
    const stripe = await getUncachableStripeClient();
    return stripe.paymentIntents.retrieve(paymentIntentId);
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
  }) {
    const stripe = await getUncachableStripeClient();

    return stripe.refunds.create({
      payment_intent: params.paymentIntentId,
      amount: params.amountCents,
      reason: params.reason || 'requested_by_customer',
      metadata: params.metadata,
    });
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
   */
  async archiveStripeProduct(productId: string) {
    const stripe = await getUncachableStripeClient();

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
