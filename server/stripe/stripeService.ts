// Stripe service for Outsyde marketplace
// Handles Stripe Connect + checkout (core only)

import { getUncachableStripeClient } from "./stripeClient";

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
}

export const stripeService = new StripeService();
