// Stripe service for Outsyde marketplace
// Handles checkout sessions, subscriptions, and Connect for vendors

import { getUncachableStripeClient } from './stripeClient';
import { db } from '../db';
import { sql, eq } from 'drizzle-orm';
import { subscriptionTiers, alaCarteServices } from '@shared/schema';

export class StripeService {
  // Create Stripe customer for a user
  async createCustomer(email: string, userId: string, name?: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.customers.create({
      email,
      name,
      metadata: { userId },
    });
  }

  // Create checkout session for vendor subscription
  async createVendorSubscriptionCheckout(
    customerId: string, 
    priceId: string, 
    successUrl: string, 
    cancelUrl: string,
    vendorId: string
  ) {
    const stripe = await getUncachableStripeClient();
    return await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { vendorId, type: 'vendor_subscription' },
    });
  }

  // Create checkout session for a product/service purchase
  async createPurchaseCheckout(
    customerId: string,
    items: { priceId: string; quantity: number }[],
    successUrl: string,
    cancelUrl: string,
    metadata: Record<string, string>
  ) {
    const stripe = await getUncachableStripeClient();
    return await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: items.map(item => ({ price: item.priceId, quantity: item.quantity })),
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
    });
  }

  // Create customer portal session for managing subscription
  async createCustomerPortalSession(customerId: string, returnUrl: string) {
    const stripe = await getUncachableStripeClient();
    return await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  }

  // Query products from synced Stripe data
  async getProducts(active = true, limit = 20, offset = 0) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.products WHERE active = ${active} LIMIT ${limit} OFFSET ${offset}`
    );
    return result.rows;
  }

  // Get products with prices
  async getProductsWithPrices(active = true, limit = 20, offset = 0) {
    const result = await db.execute(
      sql`
        WITH paginated_products AS (
          SELECT id, name, description, metadata, active
          FROM stripe.products
          WHERE active = ${active}
          ORDER BY id
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT 
          p.id as product_id,
          p.name as product_name,
          p.description as product_description,
          p.active as product_active,
          p.metadata as product_metadata,
          pr.id as price_id,
          pr.unit_amount,
          pr.currency,
          pr.recurring,
          pr.active as price_active,
          pr.metadata as price_metadata
        FROM paginated_products p
        LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
        ORDER BY p.id, pr.unit_amount
      `
    );
    return result.rows;
  }

  // Get subscription details
  async getSubscription(subscriptionId: string) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.subscriptions WHERE id = ${subscriptionId}`
    );
    return result.rows[0] || null;
  }

  // Get customer
  async getCustomer(customerId: string) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.customers WHERE id = ${customerId}`
    );
    return result.rows[0] || null;
  }

  // ==================== SUBSCRIPTION TIER PRODUCTS ====================

  // Setup all subscription tier products in Stripe (run once on startup)
  async setupSubscriptionProducts() {
    const stripe = await getUncachableStripeClient();
    
    const tiers = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.isActive, true));
    
    for (const tier of tiers) {
      if (tier.stripeProductId && tier.stripePriceId) {
        console.log(`Tier ${tier.name} already has Stripe IDs, skipping...`);
        continue;
      }

      try {
        const product = await stripe.products.create({
          name: `Outsyde ${tier.displayName} Subscription`,
          description: tier.description || `${tier.displayName} tier subscription`,
          metadata: {
            tierId: tier.id,
            tierName: tier.name,
            type: 'vendor_subscription',
          },
        });

        const price = await stripe.prices.create({
          product: product.id,
          unit_amount: tier.priceInCents,
          currency: 'usd',
          recurring: { interval: 'month' },
          metadata: {
            tierId: tier.id,
            tierName: tier.name,
            platformFeeBps: tier.platformFeeBps.toString(),
          },
        });

        await db.update(subscriptionTiers)
          .set({ stripeProductId: product.id, stripePriceId: price.id })
          .where(eq(subscriptionTiers.id, tier.id));

        console.log(`Created Stripe product for tier ${tier.name}: ${product.id}, price: ${price.id}`);
      } catch (error) {
        console.error(`Failed to create Stripe product for tier ${tier.name}:`, error);
      }
    }
  }

  // Setup à la carte service products in Stripe
  async setupAlaCarteProducts() {
    const stripe = await getUncachableStripeClient();
    
    const services = await db.select().from(alaCarteServices).where(eq(alaCarteServices.isActive, true));
    
    for (const service of services) {
      if (service.stripeProductId && service.stripePriceId) {
        console.log(`À la carte service ${service.name} already has Stripe IDs, skipping...`);
        continue;
      }

      try {
        const product = await stripe.products.create({
          name: `Outsyde ${service.displayName}`,
          description: service.description || service.displayName,
          metadata: {
            serviceId: service.id,
            serviceName: service.name,
            type: 'ala_carte',
          },
        });

        const price = await stripe.prices.create({
          product: product.id,
          unit_amount: service.basePriceInCents,
          currency: 'usd',
          metadata: { serviceId: service.id, serviceName: service.name },
        });

        await db.update(alaCarteServices)
          .set({ stripeProductId: product.id, stripePriceId: price.id })
          .where(eq(alaCarteServices.id, service.id));

        console.log(`Created Stripe product for à la carte ${service.name}: ${product.id}`);
      } catch (error) {
        console.error(`Failed to create Stripe product for service ${service.name}:`, error);
      }
    }
  }

  // Get subscription tiers from database
  async getSubscriptionTiers() {
    return await db.select().from(subscriptionTiers)
      .where(eq(subscriptionTiers.isActive, true))
      .orderBy(subscriptionTiers.sortOrder);
  }

  // Get tier by ID
  async getTier(tierId: string) {
    const result = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, tierId));
    return result[0] || null;
  }

  // Create subscription checkout with tier-specific pricing
  async createTierSubscriptionCheckout(
    customerId: string,
    tierId: string,
    successUrl: string,
    cancelUrl: string,
    vendorId: string,
    businessId: string
  ) {
    const tier = await this.getTier(tierId);
    if (!tier || !tier.stripePriceId) {
      throw new Error('Invalid tier or Stripe not configured for this tier');
    }

    const stripe = await getUncachableStripeClient();
    
    return await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: tier.stripePriceId, quantity: 1 }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { 
        vendorId, 
        businessId,
        tierId,
        tierName: tier.name,
        type: 'vendor_subscription' 
      },
      subscription_data: {
        metadata: {
          vendorId,
          businessId,
          tierId,
          tierName: tier.name,
          platformFeeBps: tier.platformFeeBps.toString(),
        },
      },
    });
  }
}

export const stripeService = new StripeService();
