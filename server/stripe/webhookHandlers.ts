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
      } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
        await WebhookHandlers.handleSubscriptionChange(event.data.object);
      } else if (event.type === 'invoice.paid') {
        await WebhookHandlers.handleInvoicePaid(event.data.object);
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
        await WebhookHandlers.handleVendorSubscriptionCheckoutCompleted(session);
        return;
      }

      // Handle à la carte purchase completion
      if (metadata.type === 'ala_carte_purchase') {
        await WebhookHandlers.handleAlaCartePurchaseCompleted(session);
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

  static async handleVendorSubscriptionCheckoutCompleted(session: any): Promise<void> {
    try {
      const metadata = session.metadata || {};
      const vendorId = metadata.vendorId;
      const businessId = metadata.businessId;
      const tierId = metadata.tierId;
      const stripeSubscriptionId = session.subscription;
      const customerId = session.customer;

      if (!vendorId || !businessId || !tierId) {
        console.error('Vendor subscription checkout missing required metadata:', { vendorId, businessId, tierId });
        return;
      }

      console.log(`Creating vendor subscription for vendor ${vendorId}, tier ${tierId}`);

      const existingSub = await storage.getVendorSubscription(vendorId);
      if (existingSub) {
        console.log(`Vendor ${vendorId} already has subscription ${existingSub.id}, updating...`);
        await storage.updateVendorSubscription(existingSub.id, {
          tierId,
          stripeCustomerId: customerId,
          stripeSubscriptionId,
        });
        return;
      }

      await storage.createVendorSubscription({
        vendorId,
        businessId,
        tierId,
        stripeCustomerId: customerId,
        stripeSubscriptionId,
      });

      console.log(`Created vendor subscription for vendor ${vendorId}`);
    } catch (error) {
      console.error('Error handling vendor subscription checkout:', error);
    }
  }

  static async handleAlaCartePurchaseCompleted(session: any): Promise<void> {
    try {
      const metadata = session.metadata || {};
      const purchaseId = metadata.purchaseId;
      
      if (!purchaseId) {
        console.error('À la carte checkout completed but no purchaseId in metadata');
        return;
      }

      console.log(`Processing à la carte purchase completion: ${purchaseId}`);

      const purchase = await storage.getAlaCartePurchase(purchaseId);
      if (!purchase) {
        console.error('À la carte purchase not found:', purchaseId);
        return;
      }

      if (purchase.paymentStatus === 'paid') {
        console.log(`À la carte purchase ${purchaseId} already processed, skipping`);
        return;
      }

      await storage.updateAlaCartePurchase(purchaseId, {
        paymentStatus: 'paid',
        stripePaymentIntentId: session.payment_intent,
      });

      // Get the service to determine task type
      const service = await storage.getAlaCarteService(purchase.serviceId);
      if (!service) {
        console.error('À la carte service not found:', purchase.serviceId);
        return;
      }

      // Import fulfillmentTasks for creating task
      const { db } = await import('../db');
      const { fulfillmentTasks } = await import('@shared/schema');

      // Create fulfillment task
      const [task] = await db.insert(fulfillmentTasks).values({
        vendorId: purchase.vendorId,
        businessId: purchase.businessId,
        taskType: service.name,
        sourceType: 'ala_carte',
        sourceId: purchaseId,
        status: 'pending',
        vendorNotes: metadata.notes || null,
      }).returning();

      console.log(`Created fulfillment task ${task.id} for à la carte purchase ${purchaseId}`);
    } catch (error) {
      console.error('Error processing à la carte purchase completion:', error);
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

  static async handleSubscriptionChange(subscription: any): Promise<void> {
    try {
      const stripeSubscriptionId = subscription.id;
      const status = subscription.status;
      
      console.log(`Subscription ${stripeSubscriptionId} status changed to: ${status}`);
      
      const vendorSub = await storage.getVendorSubscriptionByStripeId(stripeSubscriptionId);
      if (!vendorSub) {
        console.log('No vendor subscription found for Stripe subscription:', stripeSubscriptionId);
        return;
      }

      // Extract Stripe billing cycle dates
      const currentPeriodStart = subscription.current_period_start 
        ? new Date(subscription.current_period_start * 1000) 
        : null;
      const currentPeriodEnd = subscription.current_period_end 
        ? new Date(subscription.current_period_end * 1000) 
        : null;

      // Calculate quarterly dates based on Stripe period start
      let currentQuarterStart: Date | null = null;
      let currentQuarterEnd: Date | null = null;
      if (currentPeriodStart) {
        const quarter = Math.floor(currentPeriodStart.getMonth() / 3);
        currentQuarterStart = new Date(currentPeriodStart.getFullYear(), quarter * 3, 1);
        currentQuarterEnd = new Date(currentPeriodStart.getFullYear(), (quarter + 1) * 3, 0, 23, 59, 59);
      }

      if (status === 'active' && vendorSub.status !== 'active') {
        console.log(`Activating vendor subscription ${vendorSub.id} and creating benefit allowances`);
        
        // Update with Stripe billing cycle dates
        await storage.updateVendorSubscription(vendorSub.id, { 
          status: 'active',
          currentPeriodStart,
          currentPeriodEnd,
          currentQuarterStart,
          currentQuarterEnd,
        });
        
        // Pass cycle dates directly to avoid stale data issues
        const cycleDates = currentPeriodStart && currentPeriodEnd && currentQuarterStart && currentQuarterEnd
          ? { periodStart: currentPeriodStart, periodEnd: currentPeriodEnd, quarterStart: currentQuarterStart, quarterEnd: currentQuarterEnd }
          : undefined;
        const allowances = await storage.createBenefitAllowances(vendorSub.id, cycleDates);
        console.log(`Created ${allowances.length} benefit allowances for vendor subscription ${vendorSub.id}`);
        
        if (vendorSub.businessId) {
          const business = await storage.getBusiness(vendorSub.businessId);
          if (business) {
            await storage.updateBusiness(vendorSub.businessId, { subscriptionActive: true });
          }
        }
      } else if (status === 'active') {
        // Already active - just update the billing cycle dates
        await storage.updateVendorSubscription(vendorSub.id, {
          currentPeriodStart,
          currentPeriodEnd,
          currentQuarterStart,
          currentQuarterEnd,
        });
      } else if (status === 'canceled' || status === 'unpaid' || status === 'past_due') {
        console.log(`Deactivating vendor subscription ${vendorSub.id} due to status: ${status}`);
        
        await storage.updateVendorSubscription(vendorSub.id, { status: status });
        
        if (vendorSub.businessId) {
          const business = await storage.getBusiness(vendorSub.businessId);
          if (business) {
            await storage.updateBusiness(vendorSub.businessId, { subscriptionActive: false });
          }
        }
      }
    } catch (error) {
      console.error('Error processing subscription change:', error);
    }
  }

  static async handleInvoicePaid(invoice: any): Promise<void> {
    try {
      // Only process subscription invoices
      if (!invoice.subscription) {
        return;
      }

      const stripeSubscriptionId = invoice.subscription;
      console.log(`Invoice paid for subscription ${stripeSubscriptionId}`);

      const vendorSub = await storage.getVendorSubscriptionByStripeId(stripeSubscriptionId);
      if (!vendorSub) {
        console.log('No vendor subscription found for Stripe subscription:', stripeSubscriptionId);
        return;
      }

      // Only process if subscription is active
      if (vendorSub.status !== 'active') {
        console.log('Vendor subscription is not active, skipping renewal');
        return;
      }

      // Get the subscription from Stripe to get accurate billing cycle dates
      const stripe = await getUncachableStripeClient();
      const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId) as any;

      const currentPeriodStart = new Date(subscription.current_period_start * 1000);
      const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

      // Check if this is a new billing cycle (period start is after stored period start)
      const storedPeriodStart = vendorSub.currentPeriodStart;
      if (storedPeriodStart && currentPeriodStart <= storedPeriodStart) {
        console.log('Invoice is for current or past cycle, skipping renewal');
        return;
      }

      console.log(`Renewing benefit allowances for new billing cycle starting ${currentPeriodStart.toISOString()}`);

      // Calculate quarterly dates
      const quarter = Math.floor(currentPeriodStart.getMonth() / 3);
      const currentQuarterStart = new Date(currentPeriodStart.getFullYear(), quarter * 3, 1);
      const currentQuarterEnd = new Date(currentPeriodStart.getFullYear(), (quarter + 1) * 3, 0, 23, 59, 59);

      // Update subscription with new billing cycle dates
      await storage.updateVendorSubscription(vendorSub.id, {
        currentPeriodStart,
        currentPeriodEnd,
        currentQuarterStart,
        currentQuarterEnd,
      });

      // Create new benefit allowances for the new cycle - pass dates directly to avoid stale data
      const cycleDates = {
        periodStart: currentPeriodStart,
        periodEnd: currentPeriodEnd,
        quarterStart: currentQuarterStart,
        quarterEnd: currentQuarterEnd,
      };
      const allowances = await storage.createBenefitAllowances(vendorSub.id, cycleDates);
      console.log(`Created ${allowances.length} benefit allowances for new billing cycle`);
    } catch (error) {
      console.error('Error processing invoice paid:', error);
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
