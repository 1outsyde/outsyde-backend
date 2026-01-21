import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { storage } from "../storage";
import { db } from "../db";
import { fulfillmentTasks, subscriptionTiers, appointments, shootBookings, BOOKING_STATES } from "@shared/schema";
import { sql, eq } from "drizzle-orm";
import { NotificationTriggers } from "../notificationService";
import { stripeService } from "./stripeService";
import { transitionAppointmentState, transitionShootBookingState } from "../bookingStateMachine";

function isOnReplit(): boolean {
  return !!(process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL || process.env.REPL_ID);
}

export class WebhookHandlers {
  static async processWebhook(
    payload: Buffer,
    signature: string,
    uuid: string
  ): Promise<void> {
    // Always use StripeSync for data persistence (works in both environments)
    try {
      const sync = await getStripeSync();
      await sync.processWebhook(payload, signature, uuid);
    } catch (syncError) {
      console.error("StripeSync processWebhook error (continuing with event handling):", syncError);
    }

    // On Replit, managed webhooks handle verification via sync.processWebhook
    // On external hosting, we need STRIPE_WEBHOOK_SECRET for manual verification
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    // If no webhook secret, on Replit we can continue (managed webhook verified it)
    // On external hosting without secret, we must fail
    if (!webhookSecret) {
      if (isOnReplit()) {
        // On Replit, sync.processWebhook already verified - parse the event directly
        const stripe = await getUncachableStripeClient();
        const event = JSON.parse(payload.toString());
        await this.handleEvent(event);
        return;
      }
      console.error("STRIPE_WEBHOOK_SECRET not configured for external hosting");
      throw new Error("Webhook secret not configured");
    }

    const stripe = await getUncachableStripeClient();
    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret
    );
    
    await this.handleEvent(event);
  }

  static async handleEvent(event: any): Promise<void> {


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

      case "account.updated":
        await this.handleConnectAccountUpdated(event.data.object);
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

    // Handle appointment booking checkout (state machine confirmation)
    if (metadata.type === "appointment_booking") {
      await this.handleAppointmentBookingCompleted(session);
      return;
    }

    // Handle photographer shoot booking checkout (state machine confirmation)
    if (metadata.type === "shoot_booking") {
      await this.handleShootBookingCompleted(session);
      return;
    }

    // Award points ONLY here
    const user = await this.findUserByStripeCustomer(session.customer);
    if (!user) return;

    await storage.earnPoints({
      userId: user.id,
      dollarAmountCents: session.amount_total,
      transactionType: 'business_transaction',
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
      amount: purchase.priceInCents,
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
        transactionType: 'business_transaction',
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

      // Get the vendor's connected account for transfer (from business, not user)
      const business = await storage.getBusiness(businessId);
      if (business?.stripeAccountId && vendorNet > 0) {
        try {
          // Transfer the vendor's share to their connected account
          // Uses platform balance (no source_transaction needed)
          await stripeService.transferToVendor({
            amountInCents: vendorNet,
            connectedAccountId: business.stripeAccountId,
            orderId,
            orderGroupId,
          });
          console.log(`Transferred ${vendorNet} cents to business ${business.name} for order ${orderId}`);
        } catch (transferError) {
          console.error(`Failed to transfer to vendor for order ${orderId}:`, transferError);
          // Mark the order as needing manual transfer review
          await storage.updateOrder(orderId, {
            status: 'transfer_failed',
          });
        }
      }

      // Notify the business owner of the new order
      const vendorUser = await storage.getUserByBusinessOwnerId(businessId);
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
        transactionType: 'business_transaction',
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

      // Auto-pause/unpause logic respects the 3-day grace period for past_due subscriptions
      // Use the same logic as isBusinessSubscriptionActive to ensure policy consistency
      const subActiveStatus = await storage.isBusinessSubscriptionActive(vendorSub.businessId);
      
      // Determine previous subscription active status for transition detection
      // (previous status is what it was before this webhook, now check actual enforcement status)
      const wasActiveStatus = previousStatus === 'active' || previousStatus === 'trialing';
      const isNowActiveByPolicy = subActiveStatus.active;
      
      // Auto-pause: Only when subscription enforcement status goes from active to inactive
      // This respects grace periods - past_due within 3 days is still considered "active"
      if (wasActiveStatus && !isNowActiveByPolicy) {
        const pauseResult = await storage.pauseBusinessLiveItems(vendorSub.businessId);
        if (pauseResult.pausedProducts > 0 || pauseResult.pausedServices > 0) {
          console.log(`[Subscription Enforcement] Paused ${pauseResult.pausedProducts} products and ${pauseResult.pausedServices} services for business ${vendorSub.businessId} due to subscription status: ${newStatus} (${subActiveStatus.reason})`);
          
          // Audit log for auto-pause
          await storage.createAuditLog({
            actorId: 'system',
            actorType: 'system',
            action: 'items_auto_paused',
            targetType: 'business',
            targetId: vendorSub.businessId,
            beforeState: { subscriptionStatus: previousStatus },
            afterState: { 
              subscriptionStatus: newStatus,
              pausedProducts: pauseResult.pausedProducts,
              pausedServices: pauseResult.pausedServices,
              reason: subActiveStatus.reason,
            },
            metadata: {
              vendorId: vendorSub.vendorId,
              stripeSubscriptionId: vendorSub.stripeSubscriptionId,
              reason: 'subscription_inactive_after_grace_period',
            }
          });
        }
      }

      // Auto-unpause: When subscription becomes active again (from any inactive state)
      const wasInactiveStatus = previousStatus !== 'active' && previousStatus !== 'trialing';
      
      if (wasInactiveStatus && isNowActiveByPolicy) {
        const unpauseResult = await storage.unpauseBusinessPausedItems(vendorSub.businessId);
        if (unpauseResult.unpausedProducts > 0 || unpauseResult.unpausedServices > 0) {
          console.log(`[Subscription Enforcement] Unpaused ${unpauseResult.unpausedProducts} products and ${unpauseResult.unpausedServices} services for business ${vendorSub.businessId} due to subscription status: ${newStatus}`);
          
          // Audit log for auto-unpause
          await storage.createAuditLog({
            actorId: 'system',
            actorType: 'system',
            action: 'items_auto_unpaused',
            targetType: 'business',
            targetId: vendorSub.businessId,
            beforeState: { subscriptionStatus: previousStatus },
            afterState: { 
              subscriptionStatus: newStatus,
              unpausedProducts: unpauseResult.unpausedProducts,
              unpausedServices: unpauseResult.unpausedServices,
            },
            metadata: {
              vendorId: vendorSub.vendorId,
              stripeSubscriptionId: vendorSub.stripeSubscriptionId,
              reason: 'subscription_reactivated',
            }
          });
        }
      }
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
    const subResponse = await stripe.subscriptions.retrieve(invoice.subscription);
    const sub = subResponse as unknown as { current_period_start: number; current_period_end: number };

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

    const userId = result.rows?.[0]?.user_id;
    if (!userId || typeof userId !== 'string') return null;

    return storage.getUser(userId);
  }

  /* =====================================================
     CONNECT ACCOUNT UPDATED (ONBOARDING STATUS)
  ===================================================== */
  static async handleConnectAccountUpdated(account: any) {
    const metadata = account.metadata || {};
    const accountId = account.id;
    
    // Check if onboarding is complete
    const isOnboardingComplete = account.charges_enabled && account.payouts_enabled && account.details_submitted;
    
    console.log(`[Stripe] account.updated for ${accountId}: charges_enabled=${account.charges_enabled}, payouts_enabled=${account.payouts_enabled}, details_submitted=${account.details_submitted}, isComplete=${isOnboardingComplete}`);
    
    // Try to find the entity by metadata first, then fallback to account ID lookup
    let business = null;
    let photographer = null;
    
    if (metadata.role === 'business' && metadata.businessId) {
      business = await storage.getBusiness(metadata.businessId);
    } else if (metadata.role === 'photographer' && metadata.photographerId) {
      photographer = await storage.getPhotographer(metadata.photographerId);
    }
    
    // Fallback: Look up by stripeAccountId directly if metadata didn't match
    if (!business && !photographer) {
      console.log(`[Stripe] No metadata match for ${accountId}, searching by account ID...`);
      business = await storage.getBusinessByStripeAccountId(accountId);
      if (!business) {
        photographer = await storage.getPhotographerByStripeAccountId(accountId);
      }
    }
    
    // Update business onboarding status
    if (business && business.stripeAccountId === accountId) {
      await storage.updateBusiness(business.id, {
        stripeOnboardingComplete: isOnboardingComplete,
      });
      
      if (isOnboardingComplete) {
        console.log(`[Stripe] Business ${business.id} (${business.name}) completed Stripe onboarding`);
        
        // Get vendor user and send notification
        const vendorUser = await storage.getUserByBusinessOwnerId(business.id);
        if (vendorUser) {
          await NotificationTriggers.stripeOnboardingComplete({
            userId: vendorUser.id,
            accountType: 'business',
            businessName: business.name,
          });
        }
      }
    }
    
    // Update photographer onboarding status
    if (photographer && photographer.stripeAccountId === accountId) {
      await storage.updatePhotographer(photographer.id, {
        stripeOnboardingComplete: isOnboardingComplete,
      });
      
      if (isOnboardingComplete) {
        console.log(`[Stripe] Photographer ${photographer.id} (${photographer.displayName}) completed Stripe onboarding`);
        
        // Get photographer user and send notification
        const photographerUser = await storage.getUser(photographer.userId);
        if (photographerUser) {
          await NotificationTriggers.stripeOnboardingComplete({
            userId: photographerUser.id,
            accountType: 'photographer',
            businessName: photographer.displayName,
          });
        }
      }
    }
    
    if (!business && !photographer) {
      console.log(`[Stripe] No business or photographer found for account ${accountId}`);
    }
  }

  /* =====================================================
     APPOINTMENT BOOKING CONFIRMATION (STATE MACHINE)
  ===================================================== */
  static async handleAppointmentBookingCompleted(session: any) {
    const { appointmentId, clientId } = session.metadata || {};
    
    if (!appointmentId) {
      console.error("[Stripe] Appointment booking checkout missing appointmentId in metadata");
      return;
    }

    console.log(`[Stripe] Confirming appointment booking ${appointmentId}`);

    try {
      // Transition from pending_payment to confirmed
      const result = await transitionAppointmentState(
        appointmentId,
        BOOKING_STATES.CONFIRMED,
        {
          triggeredBy: 'stripe',
          triggerSource: 'webhook',
          metadata: {
            stripeCheckoutSessionId: session.id,
            stripePaymentIntentId: session.payment_intent,
          }
        }
      );

      if (!result.success) {
        console.error(`[Stripe] Failed to confirm appointment ${appointmentId}: ${result.error}`);
        return;
      }

      // Update appointment with Stripe IDs
      await db.update(appointments)
        .set({
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: session.payment_intent,
          updatedAt: new Date(),
        })
        .where(eq(appointments.id, appointmentId));

      console.log(`[Stripe] Appointment ${appointmentId} confirmed successfully`);

      // Send booking confirmation notification (async, non-blocking)
      if (clientId) {
        NotificationTriggers.bookingConfirmed({
          userId: clientId,
          bookingType: 'appointment',
          bookingId: appointmentId,
        }).catch(err => console.error("[Stripe] Failed to send booking notification:", err));
      }

      // Award points for the booking
      const [appointment] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
      if (appointment && clientId) {
        await storage.earnPoints({
          userId: clientId,
          dollarAmountCents: appointment.totalPrice,
          transactionType: 'business_transaction',
          referenceType: "appointment",
          referenceId: appointmentId,
          description: "Points earned from service booking",
          businessId: appointment.businessId,
        });

        // Complete referral bonus if applicable
        await this.tryCompleteReferral(clientId, appointmentId, 'appointment');
      }
    } catch (error) {
      console.error(`[Stripe] Error confirming appointment ${appointmentId}:`, error);
    }
  }

  /* =====================================================
     SHOOT BOOKING CONFIRMATION (STATE MACHINE)
  ===================================================== */
  static async handleShootBookingCompleted(session: any) {
    const { shootBookingId, clientId } = session.metadata || {};
    
    if (!shootBookingId) {
      console.error("[Stripe] Shoot booking checkout missing shootBookingId in metadata");
      return;
    }

    console.log(`[Stripe] Confirming shoot booking ${shootBookingId}`);

    try {
      // Transition from pending_payment to confirmed
      const result = await transitionShootBookingState(
        shootBookingId,
        BOOKING_STATES.CONFIRMED,
        {
          triggeredBy: 'stripe',
          triggerSource: 'webhook',
          metadata: {
            stripeCheckoutSessionId: session.id,
            stripePaymentIntentId: session.payment_intent,
          }
        }
      );

      if (!result.success) {
        console.error(`[Stripe] Failed to confirm shoot booking ${shootBookingId}: ${result.error}`);
        return;
      }

      // Update shoot booking with Stripe IDs
      await db.update(shootBookings)
        .set({
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: session.payment_intent,
          updatedAt: new Date(),
        })
        .where(eq(shootBookings.id, shootBookingId));

      console.log(`[Stripe] Shoot booking ${shootBookingId} confirmed successfully`);

      // Send booking confirmation notification (async, non-blocking)
      if (clientId) {
        NotificationTriggers.bookingConfirmed({
          userId: clientId,
          bookingType: 'shoot_booking',
          bookingId: shootBookingId,
        }).catch(err => console.error("[Stripe] Failed to send booking notification:", err));
      }

      // Award points for the booking
      const [booking] = await db.select().from(shootBookings).where(eq(shootBookings.id, shootBookingId));
      if (booking && clientId) {
        await storage.earnPoints({
          userId: clientId,
          dollarAmountCents: booking.totalPrice,
          transactionType: 'photographer_booking',
          referenceType: "shoot_booking",
          referenceId: shootBookingId,
          description: "Points earned from photography booking",
        });

        // Complete referral bonus if applicable
        await this.tryCompleteReferral(clientId, shootBookingId, 'shoot_booking');
      }
    } catch (error) {
      console.error(`[Stripe] Error confirming shoot booking ${shootBookingId}:`, error);
    }
  }
}
