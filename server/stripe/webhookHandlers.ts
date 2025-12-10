import { getStripeSync, getUncachableStripeClient } from './stripeClient';
import { storage } from '../storage';

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string, uuid: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
        'Received type: ' + typeof payload + '. ' +
        'This usually means express.json() parsed the body before reaching this handler. ' +
        'FIX: Ensure webhook route is registered BEFORE app.use(express.json()).'
      );
    }

    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature, uuid);

    try {
      const stripe = await getUncachableStripeClient();
      const event = JSON.parse(payload.toString());
      
      if (event.type === 'checkout.session.completed') {
        await WebhookHandlers.handleCheckoutCompleted(event.data.object);
      } else if (event.type === 'payment_intent.succeeded') {
        await WebhookHandlers.handlePaymentSucceeded(event.data.object);
      }
    } catch (error) {
      console.error('Error processing custom webhook logic:', error);
    }
  }

  static async handleCheckoutCompleted(session: any): Promise<void> {
    try {
      const customerId = session.customer;
      const amountTotal = session.amount_total || 0;
      const metadata = session.metadata || {};
      
      if (amountTotal <= 0) {
        return;
      }
      
      if (metadata.type === 'vendor_subscription') {
        console.log('Vendor subscription checkout completed, no points awarded');
        return;
      }

      const user = await WebhookHandlers.findUserByStripeCustomer(customerId);
      if (!user) {
        console.log('Could not find user for Stripe customer:', customerId);
        return;
      }

      console.log(`Awarding points to user ${user.id} for checkout of ${amountTotal} cents`);
      
      await storage.earnPoints({
        userId: user.id,
        dollarAmountCents: amountTotal,
        businessId: metadata.businessId || undefined,
        businessName: metadata.businessName || undefined,
        referenceType: 'checkout_session',
        referenceId: session.id,
        description: `Points earned from purchase`,
      });
      
      console.log(`Successfully awarded ${amountTotal} points to user ${user.id}`);
    } catch (error) {
      console.error('Error awarding points on checkout:', error);
    }
  }

  static async handlePaymentSucceeded(paymentIntent: any): Promise<void> {
    try {
      const customerId = paymentIntent.customer;
      const amount = paymentIntent.amount || 0;
      const metadata = paymentIntent.metadata || {};
      
      if (amount <= 0) {
        return;
      }

      if (metadata.pointsAwarded === 'true') {
        return;
      }

      const user = await WebhookHandlers.findUserByStripeCustomer(customerId);
      if (!user) {
        console.log('Could not find user for Stripe customer:', customerId);
        return;
      }

      console.log(`Awarding points to user ${user.id} for payment of ${amount} cents`);
      
      await storage.earnPoints({
        userId: user.id,
        dollarAmountCents: amount,
        businessId: metadata.businessId || undefined,
        businessName: metadata.businessName || undefined,
        referenceType: 'payment_intent',
        referenceId: paymentIntent.id,
        description: `Points earned from payment`,
      });
      
      console.log(`Successfully awarded ${amount} points to user ${user.id}`);
    } catch (error) {
      console.error('Error awarding points on payment:', error);
    }
  }

  static async findUserByStripeCustomer(stripeCustomerId: string): Promise<{ id: string; email: string } | null> {
    if (!stripeCustomerId) return null;
    
    try {
      const { db } = await import('../db');
      const { sql } = await import('drizzle-orm');
      
      const result = await db.execute(
        sql`SELECT metadata->>'userId' as user_id FROM stripe.customers WHERE id = ${stripeCustomerId}`
      );
      
      if (result.rows.length > 0 && result.rows[0].user_id) {
        const user = await storage.getUser(result.rows[0].user_id as string);
        if (user) {
          return { id: user.id, email: user.email };
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error finding user by Stripe customer:', error);
      return null;
    }
  }
}
