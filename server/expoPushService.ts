/**
 * Expo Push Notification Service for mobile clients.
 * Wraps expo-server-sdk to send push notifications to Expo/React Native apps.
 * Failures are logged but never crash — callers should always try/catch.
 */

import Expo, { type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { storage } from './storage';

const expo = new Expo();

export interface ExpoPushParams {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Send an Expo push notification to a user by userId.
 * Looks up the user's expoPushToken. If not found or invalid, logs and returns false.
 */
export async function sendExpoPush(params: ExpoPushParams): Promise<boolean> {
  try {
    const user = await storage.getUser(params.userId);
    const token = user?.expoPushToken;

    if (!token) {
      return false; // No token registered — silent skip
    }

    if (!Expo.isExpoPushToken(token)) {
      console.warn(`[ExpoPush] Invalid token for user ${params.userId}: ${token}`);
      return false;
    }

    const messages: ExpoPushMessage[] = [{
      to: token,
      sound: 'default',
      title: params.title,
      body: params.body,
      data: params.data,
    }];

    const tickets = await expo.sendPushNotificationsAsync(messages);
    const ticket = tickets[0] as ExpoPushTicket;

    if (ticket.status === 'ok') {
      console.log(`[ExpoPush] Sent to user ${params.userId}: "${params.title}"`);
      return true;
    } else {
      console.warn(`[ExpoPush] Failed for user ${params.userId}:`, (ticket as any).message);
      // If token is invalid, clear it from user record
      if ((ticket as any).details?.error === 'DeviceNotRegistered') {
        await storage.updateUser(params.userId, { expoPushToken: null });
        console.log(`[ExpoPush] Cleared invalid token for user ${params.userId}`);
      }
      return false;
    }
  } catch (error) {
    console.error(`[ExpoPush] Error sending to user ${params.userId}:`, error);
    return false;
  }
}

/**
 * Send booking confirmation push to both customer and business/photographer owner.
 * Failures are logged but never thrown — this must not crash the booking flow.
 */
export async function sendBookingConfirmationPush(params: {
  customerId: string;
  providerName: string;
  date: string;
  time: string;
  businessOwnerId?: string;
  customerName?: string;
}): Promise<void> {
  // Notify customer
  await sendExpoPush({
    userId: params.customerId,
    title: 'Booking Confirmed!',
    body: `Your booking at ${params.providerName} is confirmed for ${params.date} at ${params.time}`,
    data: { type: 'booking_confirmed', screen: 'bookings' },
  });

  // Notify business/photographer owner
  if (params.businessOwnerId) {
    await sendExpoPush({
      userId: params.businessOwnerId,
      title: 'New Booking',
      body: `New booking from ${params.customerName || 'a customer'} for ${params.date} at ${params.time}`,
      data: { type: 'new_booking', screen: 'dashboard' },
    });
  }
}
