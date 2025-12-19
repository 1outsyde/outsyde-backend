import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { storage } from "../storage";
import { db } from "../db";
import { fulfillmentTasks, subscriptionTiers } from "@shared/schema";
import { sql, eq } from "drizzle-orm";
import { NotificationTriggers } from "../notificationService";
import { stripeService } from "./stripeService";

export class WebhookHandlers {
  static async processWebhook(
    payload: Buffer,
    signature: string,
    uuid: string
  ): Promise<void> {
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature, uuid);

    const event = JSON.parse(payload.toString());

    switch (event.type) {
      case "checkout.session.completed":
        await this.handleCheckoutCompleted(event.data.object);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
        await this.handleSubscriptionChange(event.data.object);
        break;

      case "invoice.paid":
        await this.handleInvoicePaid(event.data.object);
        break;
    }
  }

  /* =====================================================
     CHECKOUT COMPLETED (SINGLE SOURCE OF TRUTH)
  ===================================================== */
  static async handleCheckoutCompleted(session: any) {
    const metadata = session.metadata || {};

    if (metadata.type === "vendor_subscription") {
      await this.handleVendorSubscriptionCheckoutCompleted(session);
      return;
    }

    if (metadata.type === "ala_carte_purchase") {
      await this.handleAlaCartePurchaseCompleted(session);
      return;
    }

    if (metadata.type === "cart_checkout") {
      await this.handleCartCheckoutCompleted(session);
      return;
    }

    if (metadata.type === "multi_vendor_cart_checkout") {
      await this.handleMultiVendorCartCheckoutCompleted(session);
      return;
    }

    // Award points ONLY here
    const user = await this.findUserByStripeCustomer(session.customer);
    if (!user) return;

    await storage.earnPoints({
      userId: user.id,
      dollarAmountCents: session.amount_total,
      referenceType: "checkout_session",
      referenceId: session.id,
      description: "Points earned from purchase",
    });

    // Complete referral bonus if this is the referred user's first transaction
    await this.tryCompleteReferral(user.id, session.id, 'checkout_session');
  }

  /* =====================================================
     REFERRAL COMPLETION (Triggered on first transaction)
  ===================================================== */
  static async tryCompleteReferral(userId: string, transactionId: string, transactionType: string) {
    try {
      // Check if user was referred and has a pending referral
      const pendingReferral = await storage.getPendingReferral(userId);
      if (!pendingReferral || pendingReferral.status === 'completed') {
        return; // No pending referral or already completed
      }

      // Complete the referral - awards bonus to referrer
      const result = await storage.completeReferral(userId, transactionId, transactionType);
      if (result.success) {
        console.log(`Referral bonus awarded for user ${userId}'s first transaction`);
      }
    } catch (error) {
      console.error('Error completing referral:', error);
      // Don't throw - referral completion shouldn't block the main flow
    }
  }

  /* =====================================================
     VENDOR SUBSCRIPTION
  ===================================================== */
  static async handleVendorSubscriptionCheckoutCompleted(session: any) {
    const { vendorId, businessId, tierId } = session.metadata || {};
    if (!vendorId || !businessId || !tierId) return;

    const existing = await storage.getVendorSubscription(vendorId);

    let subscriptionId: string;
    if (existing) {
      await storage.updateVendorSubscription(existing.id, {
        tierId,
        stripeSubscriptionId: session.subscription,
        stripeCustomerId: session.customer,
      });
      subscriptionId = existing.id;
    } else {
      const newSub = await storage.createVendorSubscription({
        vendorId,
        businessId,
        tierId,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
      });
      subscriptionId = newSub.id;
    }

    const [tier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, tierId));
    const tierName = tier?.displayName || tier?.name || 'subscription';

    await NotificationTriggers.subscriptionActivated({
      userId: vendorId,
      tierName,
      subscriptionId,
    });

    await NotificationTriggers.paymentSucceeded({
      userId: vendorId,
      amount: session.amount_total || 0,
      referenceType: 'vendor_subscription',
      referenceId: subscriptionId,
      description: `Your ${tierName} subscription payment was successful.`,
    });

    // Complete referral bonus if this is the vendor's first paid transaction
    await this.tryCompleteReferral(vendorId, subscriptionId, 'vendor_subscription');
  }

  /* =====================================================
     À LA CARTE PURCHASE
  ===================================================== */
  static async handleAlaCartePurchaseCompleted(session: any) {
    const { purchaseId } = session.metadata || {};
    if (!purchaseId) return;

    const purchase = await storage.getAlaCartePurchase(purchaseId);
    if (!purchase || purchase.status === "paid") return;

    await storage.updateAlaCartePurchase(purchaseId, {
      status: "paid",
      stripePaymentIntentId: session.payment_intent,
    });

    await db.insert(fulfillmentTasks).values({
      vendorId: purchase.vendorId,
      businessId: purchase.businessId,
      taskType: "ala_carte",
      taskName: "À la carte fulfillment",
      description: `Fulfill à la carte service`,
      metadata: { purchaseId },
    });

    const service = await storage.getAlaCarteService(purchase.serviceId);
    const serviceName = service?.name || 'Add-on service';

    await NotificationTriggers.addonCharged({
      userId: purchase.vendorId,
      serviceName,
      amount: purchase.finalPriceInCents,
      purchaseId,
    });

    // Complete referral bonus if this is the vendor's first paid transaction
    await this.tryCompleteReferral(purchase.vendorId, purchaseId, 'ala_carte_purchase');
  }

  /* =====================================================
     CART CHECKOUT (Single vendor)
  ===================================================== */
  static async handleCartCheckoutCompleted(session: any) {
    const { orderId, userId, businessId } = session.metadata || {};
    if (!orderId) return;

    // Update order status to paid
    const order = await storage.getOrder(orderId);
    if (!order || order.status === 'paid') return;

    await storage.updateOrder(orderId, {
      status: 'paid',
      stripePaymentIntentId: session.payment_intent,
    });

    // Clear the user's cart
    if (userId) {
      await storage.clearCart(userId);
    }

    // Award points to the customer
    const user = await this.findUserByStripeCustomer(session.customer);
    if (user) {
      await storage.earnPoints({
        userId: user.id,
        dollarAmountCents: session.amount_total,
        referenceType: "cart_order",
        referenceId: orderId,
        description: "Points earned from purchase",
      });

      // Complete referral bonus if this is the user's first transaction
      await this.tryCompleteReferral(user.id, orderId, 'cart_order');
    }

    // Notify the business of the new order
    const business = await storage.getBusiness(businessId);
    const vendor = await storage.getUserByBusinessOwnerId(businessId);
    if (vendor && order) {
      const customer = await storage.getUser(order.customerId);
      const itemCount = order.items?.length || 1;
      await NotificationTriggers.newOrderReceived({
        vendorUserId: vendor.id,
        orderId,
        customerName: customer?.name || customer?.email || 'Customer',
        orderTotal: order.totalAmount,
        itemCount,
      });
    }

    console.log(`Cart checkout completed: Order ${orderId} marked as paid`);
  }

  /* =====================================================
     MULTI-VENDOR CART CHECKOUT (Single payment, multiple transfers)
  ===================================================== */
  static async handleMultiVendorCartCheckoutCompleted(session: any) {
    const { orderGroupId, userId, vendorData } = session.metadata || {};
    if (!orderGroupId) return;

    // Parse the vendor data to get order details
    let vendorOrders: Array<{ orderId: string; businessId: string; vendorNet: number }> = [];
    try {
      vendorOrders = JSON.parse(vendorData || '[]');
    } catch (e) {
      console.error('Failed to parse vendor data:', e);
      return;
    }

    // Process each order and initiate transfers
    for (const vendorOrder of vendorOrders) {
      const { orderId, businessId, vendorNet } = vendorOrder;
      
      // Update order status to paid
      const order = await storage.getOrder(orderId);
      if (!order || order.status === 'paid') continue;

      await storage.updateOrder(orderId, {
        status: 'paid',
        stripePaymentIntentId: session.payment_intent,
      });

      // Get the vendor's connected account for transfer
      const vendorUser = await storage.getUserByBusinessOwnerId(businessId);
      if (vendorUser?.stripeConnectedAccountId && vendorNet > 0) {
        try {
          // Transfer the vendor's share to their connected account
          // Uses platform balance (no source_transaction needed)
          await stripeService.transferToVendor({
            amountInCents: vendorNet,
            connectedAccountId: vendorUser.stripeConnectedAccountId,
            orderId,
            orderGroupId,
          });
          console.log(`Transferred ${vendorNet} cents to vendor ${vendorUser.id} for order ${orderId}`);
        } catch (transferError) {
          console.error(`Failed to transfer to vendor for order ${orderId}:`, transferError);
          // Mark the order as needing manual transfer review
          await storage.updateOrder(orderId, {
            status: 'transfer_failed',
          });
        }
      }

      // Notify the business of the new order
      if (vendorUser && order) {
        const customer = await storage.getUser(order.customerId);
        const itemCount = order.items?.length || 1;
        await NotificationTriggers.newOrderReceived({
          vendorUserId: vendorUser.id,
          orderId,
          customerName: customer?.name || customer?.email || 'Customer',
          orderTotal: order.totalAmount,
          itemCount,
        });
      }
    }

    // Update order group status to completed
    await storage.updateOrderGroup(orderGroupId, {
      status: 'completed',
      completedVendors: vendorOrders.length,
    });

    // Clear the user's cart
    if (userId) {
      await storage.clearCart(userId);
    }

    // Award points to the customer
    const user = await this.findUserByStripeCustomer(session.customer);
    if (user) {
      await storage.earnPoints({
        userId: user.id,
        dollarAmountCents: session.amount_total,
        referenceType: "multi_vendor_order",
        referenceId: orderGroupId,
        description: "Points earned from multi-vendor purchase",
      });

      // Complete referral bonus if this is the user's first transaction
      await this.tryCompleteReferral(user.id, orderGroupId, 'multi_vendor_order');
    }

    console.log(`Multi-vendor checkout completed: Order group ${orderGroupId} with ${vendorOrders.length} orders`);
  }

  /* =====================================================
     SUBSCRIPTION STATUS CHANGES
  ===================================================== */
  static async handleSubscriptionChange(subscription: any) {
    const vendorSub = await storage.getVendorSubscriptionByStripeId(subscription.id);
    if (!vendorSub) return;

    const previousStatus = vendorSub.status;
    const newStatus = subscription.status;
    const previousTierId = vendorSub.tierId;

    // Detect tier change by checking the Stripe subscription's price
    const stripePriceId = subscription.items?.data?.[0]?.price?.id;
    let newTierId = previousTierId;
    let tierChanged = false;

    if (stripePriceId) {
      // Find the tier that matches this Stripe price
      const [matchingTier] = await db.select()
        .from(subscriptionTiers)
        .where(eq(subscriptionTiers.stripePriceId, stripePriceId));

      if (matchingTier && matchingTier.id !== previousTierId) {
        newTierId = matchingTier.id;
        tierChanged = true;
      }
    }

    // Update subscription with new status and potentially new tier
    const updateData: any = {
      status: newStatus,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    };

    if (tierChanged) {
      updateData.tierId = newTierId;
    }

    await storage.updateVendorSubscription(vendorSub.id, updateData);

    if (vendorSub.businessId) {
      await storage.updateBusiness(vendorSub.businessId, {
        subscriptionActive: newStatus === "active",
      });
    }

    // Handle tier change notifications and benefit migration
    if (tierChanged && newStatus === 'active') {
      const [previousTier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, previousTierId));
      const [newTier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, newTierId));
      
      const previousTierName = previousTier?.displayName || previousTier?.name || 'previous plan';
      const newTierName = newTier?.displayName || newTier?.name || 'new plan';
      
      // Determine if this is an upgrade or downgrade
      const previousPrice = previousTier?.priceInCents || 0;
      const newPrice = newTier?.priceInCents || 0;
      const isUpgrade = newPrice > previousPrice;

      // Audit log for subscription tier change
      await storage.createAuditLog({
        actorId: vendorSub.vendorId,
        actorType: 'vendor',
        action: isUpgrade ? 'subscription_upgraded' : 'subscription_downgraded',
        targetType: 'vendor_subscription',
        targetId: vendorSub.id,
        beforeState: { tierId: previousTierId, tierName: previousTierName, priceInCents: previousPrice },
        afterState: { tierId: newTierId, tierName: newTierName, priceInCents: newPrice },
        metadata: {
          businessId: vendorSub.businessId,
          stripeSubscriptionId: vendorSub.stripeSubscriptionId,
          changeType: isUpgrade ? 'upgrade' : 'downgrade',
        }
      });

      // Migrate benefits to the new tier
      await storage.migrateBenefitsForTierChange(vendorSub.id, previousTierId, newTierId);

      // Send notification about the plan change
      await NotificationTriggers.subscriptionTierChanged({
        userId: vendorSub.vendorId,
        previousTierName,
        newTierName,
        isUpgrade,
        subscriptionId: vendorSub.id,
        effectiveDate: new Date().toLocaleDateString(),
      });
    }

    // Handle cancellation notifications and audit logging
    if (previousStatus === 'active' && (newStatus === 'canceled' || newStatus === 'past_due')) {
      const [tier] = await db.select().from(subscriptionTiers).where(eq(subscriptionTiers.id, vendorSub.tierId));
      const tierName = tier?.displayName || tier?.name || 'subscription';
      const effectiveDate = new Date(subscription.current_period_end * 1000).toLocaleDateString();

      // Audit log for subscription status change
      await storage.createAuditLog({
        actorId: vendorSub.vendorId,
        actorType: newStatus === 'canceled' ? 'vendor' : 'system',
        action: newStatus === 'canceled' ? 'subscription_canceled' : 'subscription_payment_failed',
        targetType: 'vendor_subscription',
        targetId: vendorSub.id,
        beforeState: { status: previousStatus, tierId: vendorSub.tierId },
        afterState: { status: newStatus, tierId: vendorSub.tierId },
        metadata: {
          businessId: vendorSub.businessId,
          stripeSubscriptionId: vendorSub.stripeSubscriptionId,
          effectiveDate,
          tierName,
        }
      });

      await NotificationTriggers.subscriptionCanceled({
        userId: vendorSub.vendorId,
        tierName,
        subscriptionId: vendorSub.id,
        effectiveDate,
      });
    }
  }

  /* =====================================================
     INVOICE PAID (RENEW BENEFITS)
  ===================================================== */
  static async handleInvoicePaid(invoice: any) {
    if (!invoice.subscription) return;

    const vendorSub = await storage.getVendorSubscriptionByStripeId(invoice.subscription);
    if (!vendorSub || vendorSub.status !== "active") return;

    const stripe = await getUncachableStripeClient();
    const sub = await stripe.subscriptions.retrieve(invoice.subscription);

    await storage.updateVendorSubscription(vendorSub.id, {
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
    });

    await storage.createBenefitAllowances(vendorSub.id);
  }

  /* =====================================================
     STRIPE CUSTOMER → USER
  ===================================================== */
  static async findUserByStripeCustomer(customerId: string) {
    if (!customerId) return null;

    const result = await db.execute(
      sql`SELECT metadata->>'userId' AS user_id FROM stripe.customers WHERE id = ${customerId}`
    );

    if (!result.rows?.[0]?.user_id) return null;

    return storage.getUser(result.rows[0].user_id);
  }
}
