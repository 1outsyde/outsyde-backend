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
  // STRIPE CONNECT (PHOTOGRAPHERS)
  // =========================

  async createConnectAccount(
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
   * Products are owned by the platform, not connected accounts
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
  }) {
    const stripe = await getUncachableStripeClient();

    return stripe.products.create({
      name: params.name,
      description: params.description || undefined,
      metadata: params.metadata,
      images: params.images?.filter(Boolean) || undefined,
    });
  }

  /**
   * Create a Stripe Price for a product
   * Prices are immutable in Stripe - to change price, create a new one
   */
  async createStripePrice(params: {
    productId: string;
    unitAmountCents: number;
    currency?: string;
    metadata?: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    return stripe.prices.create({
      product: params.productId,
      unit_amount: params.unitAmountCents,
      currency: params.currency || 'usd',
      metadata: params.metadata,
    });
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
}

export const stripeService = new StripeService();
