// Stripe service for Outsyde marketplace
// Handles checkout sessions, subscriptions, refunds,
// and Stripe Connect for businesses and photographers

import { getUncachableStripeClient } from "./stripeClient";
import { db } from "../db";
import { sql, eq } from "drizzle-orm";

// ✅ IMPORT FROM BARREL (NOT schema.ts DIRECTLY)
import {
  subscriptionTiers,
  alaCarteServices,
  businesses,
  photographers,
} from "../../shared";

/**
 * OUTSYDE PAYMENT MODEL
 * --------------------------------------------------
 * - Businesses & photographers use Stripe Connect Express
 * - Customers pay OUTSYDE
 * - Funds are transferred via destination charges
 * - Platform fee collected via application_fee_amount
 * - Refunds executed ONLY by backend
 * - Platform fees are NOT refunded by default
 */

export class StripeService {
  // =================================================
  // CUSTOMERS
  // =================================================

  async createCustomer(email: string, userId: string, name?: string) {
    const stripe = await getUncachableStripeClient();
    return stripe.customers.create({
      email,
      name,
      metadata: { userId },
    });
  }

  async getCustomer(customerId: string) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.customers WHERE id = ${customerId}`
    );
    return result.rows?.[0] ?? null;
  }

  async createCustomerPortalSession(customerId: string, returnUrl: string) {
    const stripe = await getUncachableStripeClient();
    return stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  }

  // =================================================
  // STRIPE CONNECT — BUSINESSES
  // =================================================

  async createBusinessConnectAccount(params: {
    businessId: string;
    ownerEmail: string;
    businessName: string;
    businessType: "product" | "service" | "hybrid";
    businessCategory?: string;
  }) {
    const stripe = await getUncachableStripeClient();

    const account = await stripe.accounts.create({
      type: "express",
      email: params.ownerEmail,
      business_type: "company",
      business_profile: {
        name: params.businessName,
      },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        role: "business",
        businessId: params.businessId,
        businessType: params.businessType,
        businessCategory: params.businessCategory || "",
      },
    });

    await db
      .update(businesses)
      .set({
        stripeAccountId: account.id,
        stripeOnboardingComplete: false,
      })
      .where(eq(businesses.id, params.businessId));

    return account;
  }

  async createBusinessOnboardingLink(params: {
    stripeAccountId: string;
    refreshUrl: string;
    returnUrl: string;
  }) {
    const stripe = await getUncachableStripeClient();
    return stripe.accountLinks.create({
      account: params.stripeAccountId,
      refresh_url: params.refreshUrl,
      return_url: params.returnUrl,
      type: "account_onboarding",
    });
  }

  async getBusinessConnectAccountStatus(stripeAccountId: string) {
    const stripe = await getUncachableStripeClient();
    const account = await stripe.accounts.retrieve(stripeAccountId);

    return {
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements,
    };
  }

  // =================================================
  // STRIPE CONNECT — PHOTOGRAPHERS
  // =================================================

  async createPhotographerConnectAccount(params: {
    photographerId: string;
    email: string;
    displayName: string;
  }) {
    const stripe = await getUncachableStripeClient();

    const account = await stripe.accounts.create({
      type: "express",
      email: params.email,
      business_type: "individual",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        name: params.displayName,
        mcc: "7221", // Photography
      },
      metadata: {
        role: "photographer",
        photographerId: params.photographerId,
      },
    });

    await db
      .update(photographers)
      .set({
        stripeAccountId: account.id,
        stripeOnboardingComplete: false,
      })
      .where(eq(photographers.id, params.photographerId));

    return account;
  }

  async createPhotographerOnboardingLink(params: {
    stripeAccountId: string;
    refreshUrl: string;
    returnUrl: string;
  }) {
    const stripe = await getUncachableStripeClient();
    return stripe.accountLinks.create({
      account: params.stripeAccountId,
      refresh_url: params.refreshUrl,
      return_url: params.returnUrl,
      type: "account_onboarding",
    });
  }

  async getPhotographerConnectAccountStatus(stripeAccountId: string) {
    const stripe = await getUncachableStripeClient();
    const account = await stripe.accounts.retrieve(stripeAccountId);

    return {
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements,
    };
  }

  // =================================================
  // MARKETPLACE CHECKOUTS (DESTINATION CHARGES)
  // =================================================

  async createPurchaseCheckout(params: {
    customerId: string;
    items: { priceId: string; quantity: number }[];
    successUrl: string;
    cancelUrl: string;
    connectedAccountId: string;
    platformFeeInCents: number;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    return stripe.checkout.sessions.create({
      customer: params.customerId,
      payment_method_types: ["card"],
      line_items: params.items,
      mode: "payment",
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

  async createBookingAddOnCheckout(params: {
    customerId: string;
    connectedAccountId: string;
    addOnDescription: string;
    addOnAmountInCents: number;
    platformFeeInCents: number;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();

    return stripe.checkout.sessions.create({
      customer: params.customerId,
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: params.addOnAmountInCents,
            product_data: {
              name: "Outsyde Add-On",
              description: params.addOnDescription,
            },
          },
          quantity: 1,
        },
      ],
      mode: "payment",
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

  // =================================================
  // REFUNDS (BACKEND ONLY)
  // =================================================

  async executeRefund(params: {
    paymentIntentId: string;
    amountInCents?: number;
    reason?: "duplicate" | "fraudulent" | "requested_by_customer";
    metadata?: Record<string, string>;
  }) {
    const stripe = await getUncachableStripeClient();
    return stripe.refunds.create({
      payment_intent: params.paymentIntentId,
      amount: params.amountInCents,
      reason: params.reason,
      metadata: params.metadata,
    });
  }

  // =================================================
  // STRIPE PRODUCT SETUP (SUBSCRIPTIONS & ALA CARTE)
  // =================================================

  async setupSubscriptionProducts() {
    const stripe = await getUncachableStripeClient();
    const tiers = await db.select().from(subscriptionTiers);

    for (const tier of tiers) {
      if (tier.stripePriceId) continue;

      const product = await stripe.products.create({
        name: `Outsyde ${tier.displayName} Subscription`,
        description: tier.description || "",
        metadata: { tierId: tier.id },
      });

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: tier.priceInCents,
        currency: "usd",
        recurring: { interval: "month" },
      });

      await db
        .update(subscriptionTiers)
        .set({
          stripeProductId: product.id,
          stripePriceId: price.id,
        })
        .where(eq(subscriptionTiers.id, tier.id));
    }
  }

  async setupAlaCarteProducts() {
    const stripe = await getUncachableStripeClient();
    const services = await db.select().from(alaCarteServices);

    for (const service of services) {
      if (service.stripePriceId) continue;

      const product = await stripe.products.create({
        name: service.displayName,
        description: service.description || "",
        metadata: { serviceId: service.id },
      });

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: service.basePriceInCents,
        currency: "usd",
      });

      await db
        .update(alaCarteServices)
        .set({
          stripeProductId: product.id,
          stripePriceId: price.id,
        })
        .where(eq(alaCarteServices.id, service.id));
    }
  }
}

export const stripeService = new StripeService();
