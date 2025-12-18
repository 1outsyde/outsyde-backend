import { storage } from './storage';
import { sendPushNotification, isPushConfigured } from './pushService';
import type { InsertNotification } from '@shared/schema';

export type NotificationType = 
  | 'booking_confirmed'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'subscription_activated'
  | 'subscription_canceled'
  | 'addon_charged'
  | 'refund_issued'
  | 'new_order'
  | 'photographer_assigned';

interface NotificationData {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, any>;
}

async function sendNotification(data: NotificationData): Promise<void> {
  const notificationData: InsertNotification = {
    userId: data.userId,
    type: data.type,
    title: data.title,
    message: data.message,
    referenceType: data.referenceType,
    referenceId: data.referenceId,
    metadata: data.metadata,
  };

  await storage.createNotification(notificationData);

  if (isPushConfigured()) {
    const subscriptions = await storage.getUserPushSubscriptions(data.userId);
    for (const subscription of subscriptions) {
      await sendPushNotification(subscription, {
        title: data.title,
        body: data.message,
        url: getNotificationUrl(data.type, data.referenceType, data.referenceId),
        tag: data.type,
      });
    }
  }
}

function getNotificationUrl(type: NotificationType, referenceType?: string, referenceId?: string): string {
  switch (type) {
    case 'booking_confirmed':
    case 'photographer_assigned':
      return referenceId ? `/bookings/${referenceId}` : '/bookings';
    case 'payment_succeeded':
    case 'payment_failed':
    case 'addon_charged':
      return '/vendor/dashboard';
    case 'subscription_activated':
    case 'subscription_canceled':
      return '/vendor/dashboard?tab=subscription';
    case 'refund_issued':
      return '/profile';
    case 'new_order':
      return referenceId ? `/vendor/orders/${referenceId}` : '/vendor/orders';
    default:
      return '/';
  }
}

export const NotificationTriggers = {
  async bookingConfirmed(params: {
    customerId: string;
    photographerId: string;
    bookingId: string;
    photographerName: string;
    shootType: string;
    date: string;
    time: string;
  }): Promise<void> {
    await sendNotification({
      userId: params.customerId,
      type: 'booking_confirmed',
      title: 'Booking Confirmed',
      message: `Your ${params.shootType} session with ${params.photographerName} on ${params.date} at ${params.time} has been confirmed.`,
      referenceType: 'shoot_booking',
      referenceId: params.bookingId,
      metadata: {
        photographerId: params.photographerId,
        shootType: params.shootType,
        date: params.date,
        time: params.time,
      },
    });

    const photographer = await storage.getPhotographer(params.photographerId);
    if (photographer?.userId) {
      await sendNotification({
        userId: photographer.userId,
        type: 'booking_confirmed',
        title: 'New Booking Received',
        message: `You have a new ${params.shootType} booking on ${params.date} at ${params.time}.`,
        referenceType: 'shoot_booking',
        referenceId: params.bookingId,
        metadata: {
          customerId: params.customerId,
          shootType: params.shootType,
          date: params.date,
          time: params.time,
        },
      });
    }
  },

  async paymentSucceeded(params: {
    userId: string;
    amount: number;
    referenceType: string;
    referenceId: string;
    description?: string;
  }): Promise<void> {
    const formattedAmount = (params.amount / 100).toFixed(2);
    await sendNotification({
      userId: params.userId,
      type: 'payment_succeeded',
      title: 'Payment Successful',
      message: params.description || `Your payment of $${formattedAmount} has been processed successfully.`,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      metadata: { amount: params.amount },
    });
  },

  async paymentFailed(params: {
    userId: string;
    amount: number;
    referenceType: string;
    referenceId: string;
    reason?: string;
  }): Promise<void> {
    const formattedAmount = (params.amount / 100).toFixed(2);
    await sendNotification({
      userId: params.userId,
      type: 'payment_failed',
      title: 'Payment Failed',
      message: params.reason || `Your payment of $${formattedAmount} could not be processed. Please update your payment method.`,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      metadata: { amount: params.amount, reason: params.reason },
    });
  },

  async subscriptionActivated(params: {
    userId: string;
    tierName: string;
    subscriptionId: string;
  }): Promise<void> {
    await sendNotification({
      userId: params.userId,
      type: 'subscription_activated',
      title: 'Subscription Activated',
      message: `Your ${params.tierName} subscription is now active. Enjoy your new benefits!`,
      referenceType: 'vendor_subscription',
      referenceId: params.subscriptionId,
      metadata: { tierName: params.tierName },
    });
  },

  async subscriptionCanceled(params: {
    userId: string;
    tierName: string;
    subscriptionId: string;
    effectiveDate?: string;
  }): Promise<void> {
    const dateMessage = params.effectiveDate 
      ? ` Your access will continue until ${params.effectiveDate}.`
      : '';
    await sendNotification({
      userId: params.userId,
      type: 'subscription_canceled',
      title: 'Subscription Canceled',
      message: `Your ${params.tierName} subscription has been canceled.${dateMessage}`,
      referenceType: 'vendor_subscription',
      referenceId: params.subscriptionId,
      metadata: { tierName: params.tierName, effectiveDate: params.effectiveDate },
    });
  },

  async addonCharged(params: {
    userId: string;
    serviceName: string;
    amount: number;
    purchaseId: string;
  }): Promise<void> {
    const formattedAmount = (params.amount / 100).toFixed(2);
    await sendNotification({
      userId: params.userId,
      type: 'addon_charged',
      title: 'Add-on Service Charged',
      message: `You've been charged $${formattedAmount} for ${params.serviceName}.`,
      referenceType: 'ala_carte_purchase',
      referenceId: params.purchaseId,
      metadata: { serviceName: params.serviceName, amount: params.amount },
    });
  },

  async refundIssued(params: {
    userId: string;
    amount: number;
    referenceType: string;
    referenceId: string;
    reason?: string;
  }): Promise<void> {
    const formattedAmount = (params.amount / 100).toFixed(2);
    await sendNotification({
      userId: params.userId,
      type: 'refund_issued',
      title: 'Refund Issued',
      message: `A refund of $${formattedAmount} has been issued to your account.${params.reason ? ` Reason: ${params.reason}` : ''}`,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      metadata: { amount: params.amount, reason: params.reason },
    });
  },

  async newOrderReceived(params: {
    vendorUserId: string;
    orderId: string;
    customerName: string;
    orderTotal: number;
    itemCount: number;
  }): Promise<void> {
    const formattedAmount = (params.orderTotal / 100).toFixed(2);
    await sendNotification({
      userId: params.vendorUserId,
      type: 'new_order',
      title: 'New Order Received',
      message: `${params.customerName} placed an order for ${params.itemCount} item${params.itemCount > 1 ? 's' : ''} totaling $${formattedAmount}.`,
      referenceType: 'order',
      referenceId: params.orderId,
      metadata: {
        customerName: params.customerName,
        orderTotal: params.orderTotal,
        itemCount: params.itemCount,
      },
    });
  },

  async orderShipped(params: {
    customerId: string;
    orderId: string;
    carrier: string;
    trackingNumber: string;
  }): Promise<void> {
    await sendNotification({
      userId: params.customerId,
      type: 'order_shipped',
      title: 'Your Order Has Shipped',
      message: `Your order has been shipped via ${params.carrier}. Tracking number: ${params.trackingNumber}`,
      referenceType: 'order',
      referenceId: params.orderId,
      metadata: {
        carrier: params.carrier,
        trackingNumber: params.trackingNumber,
      },
    });
  },

  async photographerAssigned(params: {
    customerId: string;
    photographerId: string;
    photographerName: string;
    bookingId: string;
    shootType: string;
  }): Promise<void> {
    await sendNotification({
      userId: params.customerId,
      type: 'photographer_assigned',
      title: 'Photographer Assigned',
      message: `${params.photographerName} has been assigned to your ${params.shootType} session.`,
      referenceType: 'shoot_booking',
      referenceId: params.bookingId,
      metadata: {
        photographerId: params.photographerId,
        photographerName: params.photographerName,
        shootType: params.shootType,
      },
    });

    const photographer = await storage.getPhotographer(params.photographerId);
    if (photographer?.userId) {
      await sendNotification({
        userId: photographer.userId,
        type: 'photographer_assigned',
        title: 'New Assignment',
        message: `You've been assigned to a ${params.shootType} session.`,
        referenceType: 'shoot_booking',
        referenceId: params.bookingId,
        metadata: {
          customerId: params.customerId,
          shootType: params.shootType,
        },
      });
    }
  },
};

export default NotificationTriggers;
