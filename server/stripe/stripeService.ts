// Stripe service for Outsyde marketplace
// Handles checkout sessions, subscriptions, and Connect for vendors

import { getUncachableStripeClient } from './stripeClient';
import { db } from '../db';
import { sql } from 'drizzle-orm';

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

  // Create checkout session for vendor subscription ($40/month)
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
}

export const stripeService = new StripeService();
