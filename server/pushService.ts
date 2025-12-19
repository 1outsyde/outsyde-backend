import webPush from 'web-push';
import { storage } from './storage';
import type { PushSubscription, CartItem } from '@shared/schema';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:info@goutsyde.com';

let pushConfigured = false;

export function initializePushService() {
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushConfigured = true;
    console.log('Push notifications configured');
  } else {
    console.log('Push notifications disabled - VAPID keys not configured');
  }
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export function isPushConfigured(): boolean {
  return pushConfigured;
}

export async function sendPushNotification(
  subscription: PushSubscription,
  payload: {
    title: string;
    body: string;
    url?: string;
    tag?: string;
  }
): Promise<boolean> {
  if (!pushConfigured) {
    console.log('Push not configured, skipping notification');
    return false;
  }

  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  };

  try {
    await webPush.sendNotification(pushSubscription, JSON.stringify(payload));
    return true;
  } catch (error: any) {
    console.error('Push notification failed:', error);
    
    if (error.statusCode === 404 || error.statusCode === 410) {
      await storage.deletePushSubscription(subscription.userId, subscription.endpoint);
      console.log('Removed invalid subscription');
    }
    return false;
  }
}

export async function sendCartReminderNotifications(): Promise<number> {
  if (!pushConfigured) {
    console.log('Push not configured, skipping cart reminders');
    return 0;
  }

  const abandonedCarts = await storage.getUsersWithAbandonedCarts(24);
  let sent = 0;

  for (const { userId, items } of abandonedCarts) {
    const subscriptions = await storage.getUserPushSubscriptions(userId);
    
    if (subscriptions.length === 0) continue;

    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
    const totalCents = items.reduce((sum, item) => sum + item.priceInCents * item.quantity, 0);
    
    const payload = {
      title: "Don't forget your cart!",
      body: `You have ${itemCount} item${itemCount > 1 ? 's' : ''} worth $${(totalCents / 100).toFixed(2)} waiting for you.`,
      url: '/?openCart=true',
      tag: 'cart-reminder',
    };

    for (const subscription of subscriptions) {
      const success = await sendPushNotification(subscription, payload);
      if (success) sent++;
    }
  }

  return sent;
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const keys = webPush.generateVAPIDKeys();
  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}
