// Stripe service for Outsyde marketplace
// Handles Stripe Connect + checkout (core only)

import { getUncachableStripeClient } from "./stripeClient";
import { db } from "../db";
import { subscriptionTiers } from "@shared/schema";
import { asc, eq } from "drizzle-orm";

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
   * Deactivate a Stripe Price (archive it)
   * Used when a vendor changes their price - old price becomes inactive
   */
  async deactivateStripePrice(priceId: string) {
    const stripe = await getUncachableStripeClient();

    return stripe.prices.update(priceId, {
      active: false,
    });
  }

  /**
   * Update a Stripe Product's metadata or details (not price)
   */
  async updateStripeProduct(productId: string, params: {
    name?: string;
    description?: string;
    images?: string[];
    active?: boolean;
  }) {
    const stripe = await getUncachableStripeClient();

    return stripe.products.update(productId, {
      name: params.name,
      description: params.description || undefined,
      images: params.images?.filter(Boolean) || undefined,
      active: params.active,
    });
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

    // Create a subscription checkout session (not a one-time payment)
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
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    return stripe.checkout.sessions.create({
      customer: params.customerId,
      mode: "payment",
      payment_method_types: ["card"],
      line_items: params.lineItems.map(item => ({
        price: item.stripePriceId,
        quantity: item.quantity,
      })),
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      payment_intent_data: {
        application_fee_amount: params.platformFeeInCents,
        transfer_data: {
          destination: params.connectedAccountId,
        },
      },
      metadata: params.metadata,
    });
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
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    return stripe.checkout.sessions.create({
      customer: params.customerId,
      mode: "payment",
      payment_method_types: ["card"],
      line_items: params.lineItems.map(item => ({
        price: item.stripePriceId,
        quantity: item.quantity,
      })),
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
    });
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
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    // For multi-vendor, we collect payment on the platform and distribute via transfers later
    return stripe.checkout.sessions.create({
      customer: params.customerId,
      mode: "payment",
      payment_method_types: ["card"],
      line_items: params.lineItems.map(item => ({
        price: item.stripePriceId,
        quantity: item.quantity,
      })),
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
    });
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

    return stripe.transfers.create({
      amount: params.amountInCents,
      currency: "usd",
      destination: params.connectedAccountId,
      transfer_group: transferGroup,
      metadata: {
        orderId: params.orderId,
        orderGroupId: params.orderGroupId || '',
        type: 'multi_vendor_cart_transfer',
      },
    });
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
    serviceName: string;
    serviceDescription?: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    // Build checkout session config
    const sessionConfig: any = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: params.serviceName,
              description: params.serviceDescription,
            },
            unit_amount: params.amountInCents,
          },
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
    };

    // Associate with existing Stripe customer if available
    if (params.customerId) {
      sessionConfig.customer = params.customerId;
    }

    return stripe.checkout.sessions.create(sessionConfig);
  }

  /**
   * Create a checkout session for business/staff appointment using destination charges.
   * Application fee (4%) is deducted and sent to platform.
   */
  async createAppointmentCheckout(params: {
    customerId?: string;
    connectedAccountId: string;
    amountInCents: number;
    platformFeeInCents: number;
    serviceName: string;
    serviceDescription?: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    const sessionConfig: any = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: params.serviceName,
              description: params.serviceDescription,
            },
            unit_amount: params.amountInCents,
          },
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
    };

    // Associate with existing Stripe customer if available
    if (params.customerId) {
      sessionConfig.customer = params.customerId;
    }

    return stripe.checkout.sessions.create(sessionConfig);
  }
}

export const stripeService = new StripeService();
