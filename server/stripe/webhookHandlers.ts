import { getUncachableStripeClient } from "./stripeClient";
import { storage } from "../storage";
import { db } from "../db";
import { fulfillmentTasks, subscriptionTiers, appointments, shootBookings, bookingAuditLog, BOOKING_STATES, productVariants, vendorProducts, orders } from "@shared/schema";
import { sql, eq, and, inArray } from "drizzle-orm";
import { NotificationTriggers } from "../notificationService";
import { sendStaffOnboardingCompleteOwnerEmail } from "../services/resendService";
import { stripeService } from "./stripeService";
import { transitionAppointmentState, transitionShootBookingState, getPendingProviderExpiryTime } from "../bookingStateMachine";
import { markHoldAsConverted } from "../availabilityService";
import { sendBookingConfirmationPush, sendExpoPush } from "../expoPushService";
import {
  sendAppointmentConfirmationToConsumer,
  sendAppointmentNotificationToVendor,
  sendShootBookingConfirmationToConsumer,
  sendShootBookingNotificationToPhotographer,
  sendOrderConfirmationToConsumer,
  sendOrderNotificationToVendor,
  sendInternalEventAlert,
  sendBookingRequestReceivedToConsumer,
  sendBookingRequestToVendor,
  sendBookingConfirmationToCustomer,
  sendNewBookingAlertToVendor,
} from "../emailService";
import { processInfluencerCommission, reverseInfluencerCommission } from "../influencerPayoutService";
import { calculateBookingFees } from "../fees";

function isOnReplit(): boolean {
  return !!(process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL || process.env.REPL_ID);
}

async function decrementInventory(
  item: { productId?: string | null; variantId?: string | null; quantity: number },
): Promise<void> {
  if (!item.productId) return;

  if (item.variantId) {
    const [variant] = await db
      .select({ inventory: productVariants.inventory, trackInventory: productVariants.trackInventory })
      .from(productVariants)
      .where(eq(productVariants.id, item.variantId))
      .limit(1);

    if (variant?.trackInventory && variant.inventory !== null) {
      await db
        .update(productVariants)
        .set({ inventory: sql`GREATEST(0, ${productVariants.inventory} - ${item.quantity})` })
        .where(eq(productVariants.id, item.variantId));
      console.log(`[Inventory] Decremented variant ${item.variantId} by ${item.quantity}`);
      return;
    }
  }

  // No variant, or variant.inventory IS NULL → decrement product level
  const [product] = await db
    .select({ trackInventory: vendorProducts.trackInventory, inventory: vendorProducts.inventory })
    .from(vendorProducts)
    .where(eq(vendorProducts.id, item.productId))
    .limit(1);

  if (product?.trackInventory && product.inventory !== null) {
    await db
      .update(vendorProducts)
      .set({ inventory: sql`GREATEST(0, ${vendorProducts.inventory} - ${item.quantity})` })
      .where(eq(vendorProducts.id, item.productId));
    console.log(`[Inventory] Decremented product ${item.productId} by ${item.quantity}`);
  }
}

/* =====================================================
   TRANSACTION RECEIPTS
   Every paid transaction emails the consumer, the vendor and the platform
   admin. Each send is isolated: one failure is logged with the transaction
   id and recipient role and never blocks the others.
===================================================== */

type ReceiptRole = 'consumer' | 'vendor' | 'admin';

interface ReceiptTarget {
  email: string | null | undefined;
  send: () => Promise<unknown>;
}

async function sendReceipt(
  role: ReceiptRole,
  txnType: string,
  txnId: string,
  target: ReceiptTarget,
): Promise<void> {
  if (!target.email) {
    console.error(`[Receipt] ${txnType} ${txnId} → ${role} SKIPPED: no recipient email`);
    return;
  }
  try {
    await target.send();
    console.log(`[Receipt] ${txnType} ${txnId} → ${role} sent`);
  } catch (err) {
    console.error(`[Receipt] ${txnType} ${txnId} → ${role} FAILED:`, err);
  }
}

export async function sendTransactionReceipts(
  txnType: string,
  txnId: string,
  receipts: { consumer?: ReceiptTarget; vendor?: ReceiptTarget; admin?: () => Promise<unknown> },
): Promise<void> {
  const sends: Promise<void>[] = [];
  if (receipts.consumer) sends.push(sendReceipt('consumer', txnType, txnId, receipts.consumer));
  if (receipts.vendor) sends.push(sendReceipt('vendor', txnType, txnId, receipts.vendor));
  if (receipts.admin) sends.push(sendReceipt('admin', txnType, txnId, { email: 'admin', send: receipts.admin }));
  await Promise.allSettled(sends);
}

function logReceiptsSkipped(txnType: string, txnId: string): void {
  console.log(`[Receipt] ${txnType} ${txnId} SKIPPED: already processed`);
}

/** Run a post-payment side effect without letting its failure abort the rest. */
async function bestEffort(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[Stripe] ${label} failed:`, err);
  }
}

/**
 * Atomically mark an order paid. Returns true only for the delivery that
 * actually flipped it, so duplicate webhook deliveries do not re-run
 * post-payment work or re-send receipts.
 */
async function claimOrderPaid(orderId: string, paymentIntentId: string): Promise<boolean> {
  const rows = await db.update(orders)
    .set({ status: 'paid', stripePaymentIntentId: paymentIntentId })
    .where(and(eq(orders.id, orderId), sql`${orders.status} IS DISTINCT FROM 'paid'`))
    .returning({ id: orders.id });
  return rows.length > 0;
}

export class WebhookHandlers {
  static async processWebhook(
    payload: Buffer,
    signature: string,
    _uuid: string
  ): Promise<void> {
    const primarySecret = process.env.STRIPE_WEBHOOK_SECRET;
    const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

    if (!primarySecret && !connectSecret) {
      console.error("[Stripe] No webhook secret configured (STRIPE_WEBHOOK_SECRET or STRIPE_CONNECT_WEBHOOK_SECRET)");
      throw new Error("Webhook secret not configured");
    }

    const stripe = await getUncachableStripeClient();

    // Try each configured secret in order. constructEvent() throws a
    // SignatureVerificationError when the secret is wrong — that is the
    // expected signal to try the next one. Any other error is re-thrown
    // immediately since it indicates a genuine processing problem.
    const secrets = [primarySecret, connectSecret].filter(Boolean) as string[];
    let event: any;
    let lastErr: unknown;

    for (const secret of secrets) {
      try {
        event = stripe.webhooks.constructEvent(payload, signature, secret);
        break; // signature matched — stop trying
      } catch (err: any) {
        if (err?.type === "StripeSignatureVerificationError") {
          lastErr = err;
          continue; // wrong secret — try the next one
        }
        throw err; // unexpected error — propagate immediately
      }
    }

    if (!event) {
      // All secrets tried and none matched
      console.error("[Stripe] Signature verification failed against all configured secrets");
      throw lastErr;
    }

    await this.handleEvent(event);
  }

  static async verifyAndParseEvent(
    payload: Buffer,
    signature: string,
    _uuid: string
  ): Promise<any> {
    const primarySecret = process.env.STRIPE_WEBHOOK_SECRET;
    const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

    if (!primarySecret && !connectSecret) {
      console.error("[Stripe] No webhook secret configured (STRIPE_WEBHOOK_SECRET or STRIPE_CONNECT_WEBHOOK_SECRET)");
      throw new Error("Webhook secret not configured");
    }

    const stripe = await getUncachableStripeClient();
    const secrets = [primarySecret, connectSecret].filter(Boolean) as string[];
    let event: any;
    let lastErr: unknown;

    for (const secret of secrets) {
      try {
        event = stripe.webhooks.constructEvent(payload, signature, secret);
        break;
      } catch (err: any) {
        if (err?.type === "StripeSignatureVerificationError") {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }

    if (!event) {
      console.error("[Stripe] Signature verification failed against all configured secrets");
      throw lastErr;
    }

    return event;
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

      case "customer.subscription.deleted":
        await this.handleSubscriptionDeleted(event.data.object);
        break;

      case "invoice.paid":
        await this.handleInvoicePaid(event.data.object);
        break;

      case "account.updated":
        await this.handleConnectAccountUpdated(event.data.object, event.created);
        break;
      
      // PaymentIntent events for booking payments
      case "payment_intent.succeeded":
        await this.handlePaymentIntentSucceeded(event.data.object);
        break;
      
      case "payment_intent.canceled":
        await this.handlePaymentIntentCanceled(event.data.object);
        break;
      
      case "payment_intent.payment_failed":
        await this.handlePaymentIntentFailed(event.data.object);
        break;
      
      case "payment_intent.amount_capturable_updated":
        await this.handlePaymentIntentCapturableUpdated(event.data.object);
        break;
    }
  }

  /* =====================================================
     PAYMENT INTENT HANDLERS (BOOKING PAYMENTS)
  ===================================================== */

  /**
   * Handle payment_intent.succeeded - called when:
   * 1. PaymentIntent with capture_method=automatic completes payment
   * 2. PaymentIntent with capture_method=manual is captured
   */
  static async handlePaymentIntentSucceeded(paymentIntent: any) {
    const metadata = paymentIntent.metadata || {};
    const { type, bookingId, clientId } = metadata;
    // The hold-based 'appointment' type (see routes.ts POST
    // /api/booking/:holdId/create-payment-intent) uses appointmentId, not
    // bookingId, since it's the first metadata shape without a legacy
    // bookingId key.
    const appointmentIdFromMetadata = metadata.appointmentId;
    // product_purchase PaymentIntents (POST /api/cart/payment-intent) carry
    // orderId instead of bookingId — include it in the guard so they are not
    // silently dropped.
    const orderIdFromMetadata = metadata.orderId;
    const orderGroupIdFromMetadata = metadata.orderGroupId;

    if (!type || (!bookingId && !appointmentIdFromMetadata && !orderIdFromMetadata && !orderGroupIdFromMetadata)) {
      // Not a booking-related PaymentIntent, ignore
      return;
    }

    console.log(`[Stripe] PaymentIntent succeeded for ${type} ${bookingId || appointmentIdFromMetadata || orderIdFromMetadata || orderGroupIdFromMetadata}`);

    try {
      if (type === 'appointment_booking') {
        const appointment = await storage.getAppointment(bookingId);
        if (!appointment) {
          console.error(`[Stripe] Appointment ${bookingId} not found`);
          return;
        }

        // If status is pending_payment (automatic capture) -> CONFIRMED
        // If status is pending_provider (manual capture just captured) -> CONFIRMED
        if (appointment.status !== BOOKING_STATES.PENDING_PAYMENT &&
            appointment.status !== BOOKING_STATES.PENDING_PROVIDER) {
          logReceiptsSkipped('appointment_booking', bookingId);
          return;
        }

        const result = await transitionAppointmentState(
          bookingId,
          BOOKING_STATES.CONFIRMED,
          {
            triggeredBy: 'stripe',
            triggerSource: 'webhook',
            metadata: {
              stripePaymentIntentId: paymentIntent.id,
              event: 'payment_intent.succeeded'
            }
          }
        );

        if (!result.success) {
          if (result.code === 'ALREADY_CONFIRMED' || result.code === 'CONCURRENT_TRANSITION') {
            logReceiptsSkipped('appointment_booking', bookingId);
          } else {
            console.error(`[Stripe] Failed to confirm appointment ${bookingId}: ${result.error}`);
          }
          return;
        }

        // Update appointment with payment details
        await db.update(appointments).set({
          stripePaymentIntentId: paymentIntent.id,
          updatedAt: new Date()
        }).where(eq(appointments.id, bookingId));

        const user = clientId ? await storage.getUser(clientId).catch(() => undefined) : undefined;
        const ab_business = await storage.getBusiness(appointment.businessId).catch(() => undefined);
        const ab_owner = await storage.getUserByBusinessOwnerId(appointment.businessId).catch(() => undefined);

        // Receipts first, so later side effects can never skip them.
        // This legacy route always charges the full service price.
        await sendTransactionReceipts('appointment_booking', bookingId, {
          consumer: {
            email: user?.email,
            send: () => sendAppointmentConfirmationToConsumer({
              toEmail: user!.email!,
              consumerName: user!.name || user!.email!,
              vendorName: ab_business?.name || 'Business',
              vendorContactEmail: ab_business?.contactEmail ?? undefined,
              serviceName: appointment.serviceName || 'Appointment',
              bookingId,
              bookingNumber: appointment.bookingNumber,
              date: appointment.appointmentDate,
              time: appointment.appointmentTime,
              basePrice: appointment.totalPrice,
            }),
          },
          vendor: {
            email: ab_owner?.email,
            send: () => sendAppointmentNotificationToVendor({
              toEmail: ab_owner!.email!,
              vendorName: ab_business?.name || 'Business',
              consumerName: user?.name || 'Customer',
              consumerUsername: user?.username ?? undefined,
              serviceName: appointment.serviceName || 'Appointment',
              bookingId,
              bookingNumber: appointment.bookingNumber,
              date: appointment.appointmentDate,
              time: appointment.appointmentTime,
              basePrice: appointment.totalPrice,
            }),
          },
          admin: () => sendInternalEventAlert({
            eventType: 'appointment_booking',
            bookingOrOrderId: bookingId,
            consumerName: user?.name || 'Customer',
            consumerEmail: user?.email || '',
            vendorName: ab_business?.name || 'Business',
            vendorEmail: ab_owner?.email || '',
            basePrice: appointment.totalPrice,
            paymentType: 'full',
            amountChargedCents: appointment.totalPrice,
            serviceTotalCents: appointment.totalPrice,
            stripeChargeCents: paymentIntent.amount,
            date: appointment.appointmentDate,
            time: appointment.appointmentTime,
          }),
        });

        // Mark promo code used and award points on original pre-discount total
        const { promoCodeId: abPromoCodeId, originalConsumerTotalCents: abOriginalTotal } = metadata;
        if (abPromoCodeId) {
          await storage.applyPromoCode(abPromoCodeId, 'appointment', bookingId).catch(err =>
            console.error(`[Stripe] Failed to apply promo code ${abPromoCodeId} for appointment ${bookingId}:`, err)
          );
        }
        const abPointsBase = abOriginalTotal ? Number(abOriginalTotal) : paymentIntent.amount;
        if (user) {
          await bestEffort(`earnPoints for appointment ${bookingId}`, () => storage.earnPoints({
            userId: user.id,
            dollarAmountCents: abPointsBase,
            transactionType: 'business_transaction',
            referenceType: 'appointment',
            referenceId: bookingId,
            description: 'Points earned from appointment booking',
          }));
          await bestEffort(`tryCompleteReferral for appointment ${bookingId}`, () => this.tryCompleteReferral(user.id, bookingId, 'appointment'));
        }

        // In-app notifications (best-effort: each recipient is independently try/catch'd)
        try {
          console.log(`[Notify:appointment_booking] Sending customer notification to ${clientId} (appointment ${bookingId})`);
          await NotificationTriggers.paymentSucceeded({
            userId: clientId,
            amount: appointment.totalPrice,
            referenceType: 'appointment',
            referenceId: bookingId,
            description: `Booking confirmed at ${ab_business?.name || 'business'}`,
          });
          console.log(`[Notify:appointment_booking] Customer ${clientId} notified`);
        } catch (err) {
          console.error(`[Notify:appointment_booking] Customer notification failed for appointment ${bookingId}:`, err);
        }

        try {
          if (ab_owner) {
            console.log(`[Notify:appointment_booking] Sending business owner notification to ${ab_owner.id} (appointment ${bookingId})`);
            await NotificationTriggers.paymentSucceeded({
              userId: ab_owner.id,
              amount: appointment.totalPrice,
              referenceType: 'appointment',
              referenceId: bookingId,
              description: `New booking from ${user?.name || 'customer'}`,
            });
            console.log(`[Notify:appointment_booking] Business owner ${ab_owner.id} notified`);

            sendBookingConfirmationPush({
              customerId: clientId,
              providerName: ab_business?.name || 'business',
              date: appointment.appointmentDate,
              time: appointment.appointmentTime,
              businessOwnerId: ab_owner.id,
              customerName: user?.name || undefined,
            }).catch(err => console.error(`[Notify:appointment_booking] Push failed for appointment ${bookingId}:`, err));
          }
        } catch (err) {
          console.error(`[Notify:appointment_booking] Business owner notification failed for appointment ${bookingId}:`, err);
        }

        console.log(`[Stripe] Appointment ${bookingId} confirmed via PaymentIntent`);
      } else if (type === 'shoot_booking') {
        // Capture current status before the atomic claim for the audit log
        // fromState. Safe: if the UPDATE succeeds, this value is the correct
        // pre-update state because the claim guard prevents re-entry.
        const [priorRow] = await db.select({ status: shootBookings.status })
          .from(shootBookings)
          .where(eq(shootBookings.id, bookingId));
        const priorStatus = priorRow?.status;

        // DB-level idempotency guard: atomically claim the PENDING→CONFIRMED
        // transition with a conditional UPDATE. If 0 rows are affected, a
        // concurrent or duplicate webhook delivery already processed this
        // event — exit without doing any work (no SELECT-then-UPDATE race).
        const claimed = await db.update(shootBookings)
          .set({
            status: BOOKING_STATES.CONFIRMED,
            stripePaymentIntentId: paymentIntent.id,
            stateChangedAt: new Date(),
            stateChangedBy: 'stripe',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(shootBookings.id, bookingId),
              inArray(shootBookings.status, [BOOKING_STATES.PENDING_PAYMENT, BOOKING_STATES.PENDING_PROVIDER])
            )
          )
          .returning({ id: shootBookings.id });

        if (claimed.length === 0) {
          console.log(`[Stripe] Shoot booking ${bookingId} already confirmed or not in expected state — skipping duplicate webhook`);
          logReceiptsSkipped('shoot_booking', bookingId);
          return;
        }

        console.log(`[Stripe] Shoot booking ${bookingId} confirmed via PaymentIntent ${paymentIntent.id}`);

        // Write the bookingAuditLog entry that transitionShootBookingState would
        // normally write via logAuditEntry(). Closes the gap from bypassing the
        // state machine on the direct-UPDATE webhook path.
        try {
          await db.insert(bookingAuditLog).values({
            bookingType: 'shoot_booking',
            bookingId,
            fromState: priorStatus ?? BOOKING_STATES.PENDING_PAYMENT,
            toState: BOOKING_STATES.CONFIRMED,
            triggeredBy: 'stripe',
            triggerSource: 'webhook',
            metadata: {
              stripePaymentIntentId: paymentIntent.id,
            },
          });
        } catch (auditErr) {
          console.error(`[Stripe] Failed to write audit log for shoot booking ${bookingId}:`, auditErr);
        }

        const sb_booking = await storage.getShootBooking(bookingId).catch(() => undefined);
        const sb_photographer = sb_booking ? await storage.getPhotographer(sb_booking.photographerId).catch(() => undefined) : undefined;
        const sb_photographerUser = sb_photographer ? await storage.getUser(sb_photographer.userId).catch(() => undefined) : undefined;
        const user = clientId ? await storage.getUser(clientId).catch(() => undefined) : undefined;

        // Receipts first, so later side effects can never skip them.
        await sendTransactionReceipts('shoot_booking', bookingId, {
          consumer: {
            email: user?.email,
            send: () => sendShootBookingConfirmationToConsumer({
              toEmail: user!.email!,
              consumerName: user!.name || user!.email!,
              photographerName: sb_photographer?.displayName || 'Photographer',
              photographerContactEmail: sb_photographerUser?.email ?? undefined,
              shootType: sb_booking?.shootType || 'session',
              bookingId,
              bookingNumber: sb_booking?.bookingNumber || 0,
              date: sb_booking?.date || '',
              time: sb_booking?.startTime || '',
              basePrice: sb_booking?.totalPrice || 0,
            }),
          },
          vendor: {
            email: sb_photographerUser?.email,
            send: () => sendShootBookingNotificationToPhotographer({
              toEmail: sb_photographerUser!.email!,
              photographerName: sb_photographer?.displayName || 'Photographer',
              consumerName: user?.name || 'Customer',
              consumerUsername: user?.username ?? undefined,
              shootType: sb_booking?.shootType || 'session',
              bookingId,
              bookingNumber: sb_booking?.bookingNumber || 0,
              date: sb_booking?.date || '',
              time: sb_booking?.startTime || '',
              basePrice: sb_booking?.totalPrice || 0,
            }),
          },
          admin: () => sendInternalEventAlert({
            eventType: 'shoot_booking',
            bookingOrOrderId: bookingId,
            consumerName: user?.name || 'Customer',
            consumerEmail: user?.email || '',
            vendorName: sb_photographer?.displayName || 'Photographer',
            vendorEmail: sb_photographerUser?.email || '',
            basePrice: sb_booking?.totalPrice || 0,
            paymentType: 'full',
            amountChargedCents: sb_booking?.totalPrice || 0,
            stripeChargeCents: paymentIntent.amount,
            date: sb_booking?.date || '',
            time: sb_booking?.startTime || '',
          }),
        });

        // Transfer payout to photographer's connected account. vendorPayoutCents
        // was stored in PI metadata at creation time so the webhook uses the
        // exact figure computed in the create-payment-intent route — no
        // re-derivation from the booking needed.
        const vendorPayoutCents = metadata.vendorPayoutCents
          ? parseInt(metadata.vendorPayoutCents, 10)
          : 0;

        if (vendorPayoutCents > 0) {
          const photographer = sb_photographer;

          if (!photographer?.stripeAccountId) {
            console.error(`[Stripe] Cannot transfer payout for shoot booking ${bookingId}: photographer has no stripeAccountId. Funds remain on platform balance — manual reconciliation required.`);
          } else {
            try {
              const transfer = await stripeService.transferShootBookingPayout({
                amountInCents: vendorPayoutCents,
                connectedAccountId: photographer.stripeAccountId,
                bookingId,
              });
              console.log(`[Stripe] Transferred ${vendorPayoutCents}¢ to photographer ${photographer.id} (transfer ${transfer.id}) for shoot booking ${bookingId}`);
            } catch (transferErr) {
              // The charge already succeeded and the booking is confirmed above.
              // A failed transfer does NOT roll back the booking or payment.
              // Log loudly for manual reconciliation.
              console.error(`[Stripe] FAILED to transfer ${vendorPayoutCents}¢ to photographer ${photographer?.id} for shoot booking ${bookingId}. Funds remain on platform balance — manual reconciliation required.`, transferErr);
            }
          }
        } else {
          console.error(`[Stripe] Shoot booking ${bookingId} has no vendorPayoutCents in metadata — payout transfer skipped. Manual reconciliation required.`);
        }

        // If this PaymentIntent was created via the hold-based unified booking
        // flow (POST /api/booking/:holdId/create-payment-intent with
        // providerType='photographer'), convert the hold now that payment has
        // succeeded. holdId is absent from PaymentIntents created by the legacy
        // POST /api/bookings/photographer/:bookingId/create-payment-intent
        // route, so the presence check is the safe guard for backwards compat.
        const holdIdFromMeta = metadata.holdId;
        if (holdIdFromMeta) {
          try {
            await markHoldAsConverted(holdIdFromMeta, bookingId, 'shoot_booking');
          } catch (holdErr) {
            console.error(`[Stripe] Failed to convert hold ${holdIdFromMeta} for shoot booking ${bookingId}:`, holdErr);
          }
        }

        // Mark promo code used and award points on original pre-discount total
        const { promoCodeId: sbPromoCodeId, originalConsumerTotalCents: sbOriginalTotal } = metadata;
        if (sbPromoCodeId) {
          await storage.applyPromoCode(sbPromoCodeId, 'shoot_booking', bookingId).catch(err =>
            console.error(`[Stripe] Failed to apply promo code ${sbPromoCodeId} for shoot booking ${bookingId}:`, err)
          );
        }
        const sbPointsBase = sbOriginalTotal ? Number(sbOriginalTotal) : paymentIntent.amount;
        if (user) {
          await bestEffort(`earnPoints for shoot booking ${bookingId}`, () => storage.earnPoints({
            userId: user.id,
            dollarAmountCents: sbPointsBase,
            transactionType: 'photographer_booking',
            referenceType: 'shoot_booking',
            referenceId: bookingId,
            description: 'Points earned from photographer booking',
          }));
          await bestEffort(`tryCompleteReferral for shoot booking ${bookingId}`, () => this.tryCompleteReferral(user.id, bookingId, 'shoot_booking'));
        }

        // In-app + push notifications (best-effort)
        try {
          console.log(`[Notify:shoot_booking] Sending notifications for shoot booking ${bookingId}`);
          await NotificationTriggers.bookingConfirmed({
            customerId: clientId,
            photographerId: sb_booking?.photographerId || '',
            bookingId,
            photographerName: sb_photographer?.displayName || 'Photographer',
            shootType: sb_booking?.shootType || 'session',
            date: sb_booking?.date || '',
            time: sb_booking?.startTime || '',
          });
          console.log(`[Notify:shoot_booking] Customer ${clientId} and photographer notified`);

          sendBookingConfirmationPush({
            customerId: clientId,
            providerName: sb_photographer?.displayName || 'Photographer',
            date: sb_booking?.date || '',
            time: sb_booking?.startTime || '',
            businessOwnerId: sb_photographer?.userId,
            customerName: user?.name || undefined,
          }).catch(err => console.error(`[Notify:shoot_booking] Push failed for shoot booking ${bookingId}:`, err));
        } catch (err) {
          console.error(`[Notify:shoot_booking] Notifications failed for shoot booking ${bookingId}:`, err);
        }

      } else if (type === 'appointment') {
        // Hold-based business/staff booking flow (POST
        // /api/booking/:holdId/create-payment-intent). This PaymentIntent was
        // created with NO transfer_data -- the full charge landed on the
        // platform balance. Confirm the booking, convert the hold, then pay
        // out the vendor(s) via separate stripe.transfers.create() calls.
        const appointmentId = appointmentIdFromMetadata;
        const { holdId, businessId, staffMemberId } = metadata;

        if (!appointmentId) {
          console.error("[Stripe] Appointment PaymentIntent succeeded but missing appointmentId in metadata");
          return;
        }

        const appointment = await storage.getAppointment(appointmentId);
        if (!appointment) {
          console.error(`[Stripe] Appointment ${appointmentId} not found`);
          return;
        }

        if (appointment.status !== BOOKING_STATES.PENDING_PAYMENT &&
            appointment.status !== BOOKING_STATES.PENDING_PROVIDER) {
          logReceiptsSkipped('appointment', appointmentId);
          return;
        }

        {
          const result = await transitionAppointmentState(
            appointmentId,
            BOOKING_STATES.CONFIRMED,
            {
              triggeredBy: 'stripe',
              triggerSource: 'webhook',
              metadata: {
                stripePaymentIntentId: paymentIntent.id,
                event: 'payment_intent.succeeded'
              }
            }
          );

          if (!result.success) {
            if (result.code === 'ALREADY_CONFIRMED' || result.code === 'CONCURRENT_TRANSITION') {
              logReceiptsSkipped('appointment', appointmentId);
            } else {
              console.error(`[Stripe] Failed to confirm appointment ${appointmentId}: ${result.error}`);
            }
            return;
          }

          await db.update(appointments).set({
            stripePaymentIntentId: paymentIntent.id,
            updatedAt: new Date()
          }).where(eq(appointments.id, appointmentId));

          console.log(`[Stripe] Appointment ${appointmentId} confirmed via platform-balance PaymentIntent`);

          const business = businessId ? await storage.getBusiness(businessId).catch(() => undefined) : undefined;
          const apptCustomer = await storage.getUser(appointment.clientId).catch(() => undefined);
          const apptOwner = businessId ? await storage.getUserByBusinessOwnerId(businessId).catch(() => undefined) : undefined;

          // Deposit bookings charge D (+8%) now; the remainder is paid in
          // person and is display only.
          const depositCents = appointment.depositAmountCents ?? undefined;
          const remainderCents = depositCents != null ? Math.max(0, appointment.totalPrice - depositCents) : undefined;

          // Receipts first, so later side effects can never skip them.
          await sendTransactionReceipts('appointment', appointmentId, {
            consumer: {
              email: apptCustomer?.email,
              send: () => sendAppointmentConfirmationToConsumer({
                toEmail: apptCustomer!.email!,
                consumerName: apptCustomer!.name || apptCustomer!.email!,
                vendorName: business?.name || 'Business',
                vendorContactEmail: business?.contactEmail ?? undefined,
                serviceName: appointment.serviceName || 'Appointment',
                bookingId: appointmentId,
                bookingNumber: appointment.bookingNumber,
                date: appointment.appointmentDate,
                time: appointment.appointmentTime,
                basePrice: appointment.totalPrice,
                depositAmountCents: depositCents,
                remainderDueCents: remainderCents,
              }),
            },
            vendor: {
              email: apptOwner?.email,
              send: () => sendAppointmentNotificationToVendor({
                toEmail: apptOwner!.email!,
                vendorName: business?.name || 'Business',
                consumerName: apptCustomer?.name || 'Customer',
                consumerUsername: apptCustomer?.username ?? undefined,
                serviceName: appointment.serviceName || 'Appointment',
                bookingId: appointmentId,
                bookingNumber: appointment.bookingNumber,
                date: appointment.appointmentDate,
                time: appointment.appointmentTime,
                basePrice: appointment.totalPrice,
                depositAmountCents: depositCents,
                remainderDueCents: remainderCents,
              }),
            },
            admin: () => sendInternalEventAlert({
              eventType: 'appointment_booking',
              bookingOrOrderId: appointmentId,
              consumerName: apptCustomer?.name || 'Customer',
              consumerEmail: apptCustomer?.email || '',
              vendorName: business?.name || 'Business',
              vendorEmail: apptOwner?.email || '',
              basePrice: appointment.totalPrice,
              paymentType: depositCents != null ? 'deposit' : 'full',
              amountChargedCents: depositCents ?? appointment.totalPrice,
              serviceTotalCents: appointment.totalPrice,
              stripeChargeCents: paymentIntent.amount,
              date: appointment.appointmentDate,
              time: appointment.appointmentTime,
            }),
          });

          // Convert the hold now that the appointment is confirmed. This is
          // the first place holdId is ever set in Stripe metadata, so this
          // is also the first time markHoldAsConverted is actually reachable.
          if (holdId) {
            try {
              await markHoldAsConverted(holdId, appointmentId, 'appointment');
            } catch (holdErr) {
              console.error(`[Stripe] Failed to convert hold ${holdId}:`, holdErr);
            }
          }

          // Uses calculateBookingFees() from fees.ts (8% consumer fee / 2% booking fee —
          // universal rate as of the fee-model migration). vendorNetCents from this
          // breakdown is transferred to the business/staff connected account below.
          // Use the amount actually charged: depositAmountCents when a deposit was
          // configured, otherwise the full service price (no deposit = full charge).
          const chargedAmountCents = appointment.depositAmountCents ?? appointment.totalPrice;
          const feeBreakdown = calculateBookingFees(chargedAmountCents);
          const vendorNetCents = feeBreakdown.vendorNetCents;

          if (!business?.stripeAccountId) {
            console.error(`[Stripe] Cannot pay out appointment ${appointmentId}: business ${businessId} has no stripeAccountId. Funds remain on platform balance -- manual reconciliation required.`);
          } else if (staffMemberId) {
            // Staff-scoped booking. Model A (booth-split percentage) has no
            // schema-backed column anywhere on `businesses` as of this build
            // (confirmed absent from shared/schema.ts) -- until that exists,
            // the staff member receives the full vendorNetCents, same as a
            // solo-provider business would. The business-side booth-cut
            // transfer is intentionally NOT fired here; wire it in once
            // Model A's split percentage is schema-backed.
            const staffMember = await storage.getStaffMember(staffMemberId);
            if (!staffMember?.stripeAccountId) {
              console.error(`[Stripe] Cannot pay out appointment ${appointmentId}: staff member ${staffMemberId} has no stripeAccountId. Funds remain on platform balance -- manual reconciliation required.`);
            } else {
              try {
                const transfer = await stripeService.transferBookingPayout({
                  amountInCents: vendorNetCents,
                  connectedAccountId: staffMember.stripeAccountId,
                  appointmentId,
                  recipient: 'staff',
                });
                await db.update(appointments).set({
                  staffPayout: vendorNetCents,
                  updatedAt: new Date(),
                }).where(eq(appointments.id, appointmentId));
                console.log(`[Stripe] Transferred ${vendorNetCents}c to staff ${staffMemberId} (transfer ${transfer.id}) for appointment ${appointmentId}`);
              } catch (transferErr) {
                // The charge already succeeded and the booking is confirmed
                // above -- a failed transfer here does NOT roll back the
                // booking or touch payment status. This is a genuine edge
                // case: the customer's money is real and sitting on the
                // platform balance instead of reaching the staff member.
                // No automatic retry is attempted; log loudly for manual
                // reconciliation.
                console.error(`[Stripe] FAILED to transfer ${vendorNetCents}c to staff ${staffMemberId} for appointment ${appointmentId}. Funds remain on platform balance -- manual reconciliation required.`, transferErr);
              }
            }
          } else {
            // Solo-provider business: single transfer for the full vendor net.
            try {
              const transfer = await stripeService.transferBookingPayout({
                amountInCents: vendorNetCents,
                connectedAccountId: business.stripeAccountId,
                appointmentId,
                recipient: 'business',
              });
              console.log(`[Stripe] Transferred ${vendorNetCents}c to business ${businessId} (transfer ${transfer.id}) for appointment ${appointmentId}`);
            } catch (transferErr) {
              console.error(`[Stripe] FAILED to transfer ${vendorNetCents}c to business ${businessId} for appointment ${appointmentId}. Funds remain on platform balance -- manual reconciliation required.`, transferErr);
            }
          }

          // Points: create a pending transaction on totalPrice (full service value).
          // Points are held until the appointment is marked completed — they are
          // approved in PATCH /api/bookings/appointments/:id/complete.
          await bestEffort(`createPendingPointTransaction for appointment ${appointmentId}`, () => storage.createPendingPointTransaction({
            userId: appointment.clientId,
            dollarAmountCents: appointment.totalPrice,
            transactionType: 'business_transaction',
            referenceType: 'appointment',
            referenceId: appointmentId,
            description: 'Points earned from service booking',
            businessId,
          }));
          await bestEffort(`tryCompleteReferral for appointment ${appointmentId}`, () => this.tryCompleteReferral(appointment.clientId, appointmentId, 'appointment'));

          // Notifications (best-effort: each recipient is independently try/catch'd so
          // one failure does not prevent the others from firing or block the booking)

          // Customer in-app
          try {
            console.log(`[Notify:appointment] Sending customer notification to ${appointment.clientId} (appointment ${appointmentId})`);
            await NotificationTriggers.paymentSucceeded({
              userId: appointment.clientId,
              amount: appointment.totalPrice,
              referenceType: 'appointment',
              referenceId: appointmentId,
              description: `Booking confirmed at ${business?.name || 'business'}`,
            });
            console.log(`[Notify:appointment] Customer ${appointment.clientId} notified`);
          } catch (err) {
            console.error(`[Notify:appointment] Customer notification failed for appointment ${appointmentId}:`, err);
          }

          // Business owner in-app
          const apptOwnerId: string | undefined = apptOwner?.id;
          try {
            if (apptOwner) {
              console.log(`[Notify:appointment] Sending business owner notification to ${apptOwner.id} (appointment ${appointmentId})`);
              await NotificationTriggers.paymentSucceeded({
                userId: apptOwner.id,
                amount: appointment.totalPrice,
                referenceType: 'appointment',
                referenceId: appointmentId,
                description: `New booking from ${apptCustomer?.name || 'customer'}`,
              });
              console.log(`[Notify:appointment] Business owner ${apptOwner.id} notified`);
            }
          } catch (err) {
            console.error(`[Notify:appointment] Business owner notification failed for appointment ${appointmentId}:`, err);
          }

          // Staff member in-app — capture userId for the push call below
          let apptStaffMemberUserId: string | undefined;
          if (staffMemberId) {
            try {
              const apptStaffMember = await storage.getStaffMember(staffMemberId);
              if (apptStaffMember?.userId) {
                apptStaffMemberUserId = apptStaffMember.userId;
                console.log(`[Notify:appointment] Sending staff notification to ${apptStaffMember.userId} (appointment ${appointmentId})`);
                await NotificationTriggers.paymentSucceeded({
                  userId: apptStaffMember.userId,
                  amount: appointment.totalPrice,
                  referenceType: 'appointment',
                  referenceId: appointmentId,
                  description: `New booking on ${appointment.appointmentDate} at ${appointment.appointmentTime}`,
                });
                console.log(`[Notify:appointment] Staff member ${apptStaffMember.userId} notified`);
              } else {
                console.log(`[Notify:appointment] Staff member ${staffMemberId} has no linked userId — skipping in-app notification`);
              }
            } catch (err) {
              console.error(`[Notify:appointment] Staff notification failed for appointment ${appointmentId}:`, err);
            }
          }

          // Push (Expo) — customer + business owner + optional staff member on same call
          sendBookingConfirmationPush({
            customerId: appointment.clientId,
            providerName: business?.name || 'business',
            date: appointment.appointmentDate,
            time: appointment.appointmentTime,
            businessOwnerId: apptOwnerId,
            staffMemberUserId: apptStaffMemberUserId,
            customerName: apptCustomer?.name || undefined,
          }).catch(err => console.error(`[Notify:appointment] Push failed for appointment ${appointmentId}:`, err));

        }
      } else if (type === 'deposit') {
        // Legacy XO Beauty & Lashes deposit flow (POST /api/booking/:holdId/create-deposit-intent).
        // Appointment and hold were already created in that route; here we confirm the
        // appointment and send the receipts.
        const appointmentId = appointmentIdFromMetadata;
        const { holdId, businessId } = metadata;

        if (!appointmentId) {
          console.error('[Stripe] deposit PaymentIntent succeeded but missing appointmentId in metadata');
          return;
        }

        const appt = await storage.getAppointment(appointmentId);
        if (!appt) {
          console.error(`[Stripe] deposit: Appointment ${appointmentId} not found`);
          return;
        }

        if (appt.status !== BOOKING_STATES.PENDING_PAYMENT && appt.status !== BOOKING_STATES.PENDING_PROVIDER) {
          console.log(`[Stripe] deposit: Appointment ${appointmentId} already in status ${appt.status} — skipping`);
          logReceiptsSkipped('deposit', appointmentId);
          return;
        }

        const result = await transitionAppointmentState(
          appointmentId,
          BOOKING_STATES.CONFIRMED,
          {
            triggeredBy: 'stripe',
            triggerSource: 'webhook',
            metadata: { stripePaymentIntentId: paymentIntent.id, event: 'payment_intent.succeeded' }
          }
        );

        if (!result.success) {
          if (result.code === 'ALREADY_CONFIRMED' || result.code === 'CONCURRENT_TRANSITION') {
            logReceiptsSkipped('deposit', appointmentId);
          } else {
            console.error(`[Stripe] deposit: Failed to confirm appointment ${appointmentId}: ${result.error}`);
          }
          return;
        }

        await db.update(appointments).set({
          stripePaymentIntentId: paymentIntent.id,
          updatedAt: new Date(),
        }).where(eq(appointments.id, appointmentId));

        const depositCustomer = await storage.getUser(appt.clientId).catch(() => undefined);
        const depositBusiness = businessId ? await storage.getBusiness(businessId).catch(() => undefined) : undefined;
        const depositVendorOwner = businessId ? await storage.getUserByBusinessOwnerId(businessId).catch(() => undefined) : undefined;
        const depositAmountCents = paymentIntent.amount ?? undefined;

        await sendTransactionReceipts('deposit', appointmentId, {
          consumer: {
            email: depositCustomer?.email,
            send: () => sendBookingConfirmationToCustomer({
              toEmail: depositCustomer!.email!,
              customerName: depositCustomer!.name || depositCustomer!.firstName || 'there',
              serviceName: appt.serviceName || 'Appointment',
              date: appt.appointmentDate,
              time: appt.appointmentTime,
              appointmentId,
              businessName: depositBusiness?.name,
              vendorContactEmail: depositBusiness?.contactEmail ?? undefined,
            }),
          },
          vendor: {
            email: depositVendorOwner?.email,
            send: () => sendNewBookingAlertToVendor({
              customerName: depositCustomer?.name || depositCustomer?.firstName || 'Customer',
              customerEmail: depositCustomer?.email || '',
              serviceName: appt.serviceName || 'Appointment',
              date: appt.appointmentDate,
              time: appt.appointmentTime,
              appointmentId,
              vendorOwnerEmail: depositVendorOwner?.email ?? undefined,
              businessName: depositBusiness?.name,
              depositAmountCents,
            }),
          },
          admin: () => sendInternalEventAlert({
            eventType: 'appointment_booking',
            bookingOrOrderId: appointmentId,
            consumerName: depositCustomer?.name || depositCustomer?.firstName || 'Customer',
            consumerEmail: depositCustomer?.email || '',
            vendorName: depositBusiness?.name || 'Business',
            vendorEmail: depositVendorOwner?.email || '',
            paymentType: 'deposit',
            amountChargedCents: paymentIntent.amount,
            serviceTotalCents: appt.totalPrice,
            stripeChargeCents: paymentIntent.amount,
            date: appt.appointmentDate,
            time: appt.appointmentTime,
          }),
        });

        if (holdId) {
          markHoldAsConverted(holdId, appointmentId, 'appointment').catch(err =>
            console.error(`[Stripe] deposit: Failed to convert hold ${holdId}:`, err)
          );
        }

        console.log(`[Stripe] deposit: Appointment ${appointmentId} confirmed`);
      } else if (type === 'product_purchase') {
        // Mobile PaymentSheet product cart flow (POST /api/cart/payment-intent).
        // The order row was created before the PaymentIntent, so all we do here
        // is set it paid and run the same post-purchase steps as
        // handleCartCheckoutCompleted does for the web checkout session path.
        const orderId = orderIdFromMetadata;
        if (!orderId) {
          // Old PaymentIntents created before this fix had no orderId — nothing
          // to update, log and exit cleanly.
          console.warn(`[Stripe] product_purchase PaymentIntent ${paymentIntent.id} has no orderId in metadata — skipping (pre-fix payment)`);
          return;
        }

        const order = await storage.getOrder(orderId);
        if (!order) {
          console.error(`[Stripe] product_purchase: Order ${orderId} not found`);
          return;
        }

        if (!(await claimOrderPaid(orderId, paymentIntent.id))) {
          logReceiptsSkipped('product_purchase', orderId);
          return;
        }

        // Resolve business, vendor, and customer once for receipts and notifications
        const userIdFromMeta = metadata.userId;
        const orderBusinessId = metadata.businessId;
        const orderBusiness = orderBusinessId ? await storage.getBusiness(orderBusinessId).catch(() => undefined) : undefined;
        const vendor = orderBusinessId ? await storage.getUserByBusinessOwnerId(orderBusinessId).catch(() => undefined) : undefined;
        const purchaser = userIdFromMeta ? await storage.getUser(userIdFromMeta).catch(() => undefined) : undefined;
        const customer = purchaser ?? await storage.getUser(order.customerId).catch(() => undefined);

        // Build order item list shared by consumer and vendor emails
        const piOrderItems = ((order.items as any[]) || []).map((i: any) => ({
          productName: i.name || i.title || i.productId || 'Item',
          variantLabel: i.variantLabel ?? undefined,
          vendorName: orderBusiness?.name || vendor?.name || 'Business',
          vendorContactEmail: orderBusiness?.contactEmail ?? undefined,
          quantity: i.quantity || 1,
          basePrice: i.price || i.unitPrice || 0,
        }));
        const piVendorItems = piOrderItems.map(({ vendorName: _vn, vendorContactEmail: _vce, ...rest }) => rest);

        // Receipts first, so later side effects can never skip them.
        await sendTransactionReceipts('product_purchase', orderId, {
          consumer: {
            email: customer?.email,
            send: () => sendOrderConfirmationToConsumer({
              toEmail: customer!.email!,
              consumerName: customer!.firstName
                ? `${customer!.firstName} ${customer!.lastName ?? ''}`.trim()
                : customer!.name || customer!.email!.split('@')[0],
              orderId,
              orderNumber: order.orderNumber,
              items: piOrderItems,
              totalAmountCents: order.grossChargeAmount ?? undefined,
              platformFeeCents: order.consumerServiceFee ?? undefined,
            }),
          },
          vendor: {
            email: vendor?.email,
            send: () => sendOrderNotificationToVendor({
              toEmail: vendor!.email!,
              vendorName: orderBusiness?.name || vendor!.name || 'Business',
              consumerName: customer?.name || 'Customer',
              consumerUsername: customer?.username ?? undefined,
              orderId,
              orderNumber: order.orderNumber,
              items: piVendorItems,
              vendorNetCents: order.vendorNet ?? undefined,
            }),
          },
          admin: () => sendInternalEventAlert({
            eventType: 'product_order',
            bookingOrOrderId: orderId,
            consumerName: customer?.name || 'Customer',
            consumerEmail: customer?.email || '',
            vendorName: orderBusiness?.name || vendor?.name || 'Business',
            vendorEmail: vendor?.email || '',
            items: piVendorItems,
            stripeChargeCents: paymentIntent.amount,
          }),
        });

        // Process influencer commission if attributed
        if (order.influencerCodeUsed || order.attributedInfluencerId) {
          try {
            await processInfluencerCommission(orderId, paymentIntent.id);
          } catch (commErr) {
            console.error(`[InfluencerPayout] Error processing commission for order ${orderId}:`, commErr);
          }
        }

        // Decrement inventory for each purchased item
        if (order.items && Array.isArray(order.items)) {
          for (const item of order.items) {
            try {
              await decrementInventory(item);
            } catch (invError) {
              console.error(`[Inventory] Failed to decrement ${item.productId}:`, invError);
            }
          }
        }

        // Clear the user's cart
        if (userIdFromMeta) {
          await bestEffort(`clearCart for order ${orderId}`, () => storage.clearCart(userIdFromMeta));
        }

        // Mark promo code used and award points on original pre-discount total
        const { promoCodeId: ppPromoCodeId, originalConsumerTotalCents: ppOriginalTotal } = metadata;
        if (ppPromoCodeId) {
          await storage.applyPromoCode(ppPromoCodeId, 'order', orderId).catch(err =>
            console.error(`[Stripe] Failed to apply promo code ${ppPromoCodeId} for order ${orderId}:`, err)
          );
        }
        // Use stored gross_charge_amount for the earn formula; fall back to total_amount then PI amount
        const grossForPoints = order.grossChargeAmount ?? order.totalAmount;
        const ppPointsBase = ppOriginalTotal ? Number(ppOriginalTotal) : grossForPoints;
        if (purchaser) {
          await bestEffort(`earnPoints for order ${orderId}`, () => storage.earnPoints({
            userId: purchaser.id,
            dollarAmountCents: ppPointsBase,
            transactionType: 'business_transaction',
            referenceType: 'cart_order',
            referenceId: orderId,
            description: 'Points earned from purchase',
          }));
          await bestEffort(`tryCompleteReferral for order ${orderId}`, () => this.tryCompleteReferral(purchaser.id, orderId, 'cart_order'));
        }

        // Notify the business of the new order
        if (vendor) {
          const itemCount = order.items?.length || 1;
          await bestEffort(`newOrderReceived for order ${orderId}`, () => NotificationTriggers.newOrderReceived({
            vendorUserId: vendor.id,
            orderId,
            customerName: customer?.name || customer?.email || 'Customer',
            orderTotal: order.totalAmount,
            itemCount,
          }));

          // Notify the customer that their order is confirmed (app push)
          NotificationTriggers.orderConfirmed({
            customerId: order.customerId,
            orderId,
            businessName: orderBusiness?.name || vendor.name || 'the business',
            itemCount: order.items?.length || 1,
          }).catch(err => console.error('Notification error:', err));
        }

        console.log(`[Stripe] Product purchase completed: Order ${orderId} marked as paid`);

      } else if (type === 'multi_vendor_product_purchase') {
        // POST /api/cart/payment-intent multi-vendor path.
        // One platform charge covers all vendors; we transfer each vendor's
        // net payout here and mark every per-vendor order as paid.

        let vendorOrders: Array<{ orderId: string; businessId: string; vendorNetCents: number }> = [];
        try {
          vendorOrders = JSON.parse(metadata.vendorOrders || '[]');
        } catch (parseErr) {
          console.error(`[Stripe] multi_vendor_product_purchase ${paymentIntent.id}: failed to parse vendorOrders metadata — manual reconciliation required`, parseErr);
          return;
        }

        const orderGroupTxnId = metadata.orderGroupId || vendorOrders[0]?.orderId || paymentIntent.id;
        const purchaser = metadata.userId ? await storage.getUser(metadata.userId).catch(() => undefined) : undefined;
        let claimedOrders = 0;

        for (const vendorOrder of vendorOrders) {
          const order = await storage.getOrder(vendorOrder.orderId);
          if (!order) continue;

          if (!(await claimOrderPaid(vendorOrder.orderId, paymentIntent.id))) {
            logReceiptsSkipped('multi_vendor_product_purchase', vendorOrder.orderId);
            continue;
          }
          claimedOrders++;

          const piVendorBusiness = await storage.getBusiness(vendorOrder.businessId).catch(() => undefined);
          const vendorUser = await storage.getUserByBusinessOwnerId(vendorOrder.businessId).catch(() => undefined);
          const customer = purchaser ?? await storage.getUser(order.customerId).catch(() => undefined);

          // Vendor receipt for this vendor's portion — first, before side effects.
          await sendTransactionReceipts('multi_vendor_product_purchase', vendorOrder.orderId, {
            vendor: {
              email: vendorUser?.email,
              send: () => sendOrderNotificationToVendor({
                toEmail: vendorUser!.email!,
                vendorName: piVendorBusiness?.name || vendorUser!.name || 'Business',
                consumerName: customer?.name || 'Customer',
                consumerUsername: customer?.username ?? undefined,
                orderId: vendorOrder.orderId,
                orderNumber: order.orderNumber,
                items: ((order.items as any[]) || []).map((i: any) => ({
                  productName: i.name || i.title || i.productId || 'Item',
                  quantity: i.quantity || 1,
                  basePrice: i.price || i.unitPrice || 0,
                })),
                vendorNetCents: order.vendorNet ?? undefined,
              }),
            },
          });

          // Decrement inventory for this vendor's items
          if (order.items && Array.isArray(order.items)) {
            for (const item of order.items) {
              try {
                await decrementInventory(item);
              } catch (invError) {
                console.error(`[Inventory] Failed to decrement ${item.productId}:`, invError);
              }
            }
          }

          // Process influencer commission if attributed
          if (order.influencerCodeUsed || order.attributedInfluencerId) {
            try {
              await processInfluencerCommission(vendorOrder.orderId, paymentIntent.id);
            } catch (commErr) {
              console.error(`[InfluencerPayout] Error processing commission for order ${vendorOrder.orderId}:`, commErr);
            }
          }

          // Transfer vendor's net payout to their connected account
          if (piVendorBusiness?.stripeAccountId && vendorOrder.vendorNetCents > 0) {
            try {
              await stripeService.transferToVendor({
                amountInCents: vendorOrder.vendorNetCents,
                connectedAccountId: piVendorBusiness.stripeAccountId,
                orderId: vendorOrder.orderId,
                orderGroupId: metadata.orderGroupId,
              });
              console.log(`[Stripe] Transfer completed for order ${vendorOrder.orderId}: ${vendorOrder.vendorNetCents}¢ → ${piVendorBusiness.stripeAccountId}`);
            } catch (transferErr) {
              console.error(`[Stripe] TRANSFER FAILED for order ${vendorOrder.orderId} (${vendorOrder.vendorNetCents}¢ → ${piVendorBusiness.stripeAccountId}) — manual reconciliation required:`, transferErr);
              // Do not throw: the consumer payment succeeded, payout failure must be reconciled separately
            }
          }

          // Notify this vendor of their new order (in-app)
          if (vendorUser) {
            await bestEffort(`newOrderReceived for order ${vendorOrder.orderId}`, () => NotificationTriggers.newOrderReceived({
              vendorUserId: vendorUser.id,
              orderId: vendorOrder.orderId,
              customerName: customer?.name || customer?.email || 'Customer',
              orderTotal: order.totalAmount,
              itemCount: order.items?.length || 1,
            }));
          }
        }

        if (claimedOrders === 0) {
          logReceiptsSkipped('multi_vendor_product_purchase', orderGroupTxnId);
          return;
        }

        // Consolidated consumer receipt + admin copy — not gated on any other lookup.
        const allMvPiItems: Array<{ productName: string; vendorName: string; vendorContactEmail?: string; quantity: number; basePrice: number }> = [];
        let firstMvPiOrderNumber = 0;
        let mvTotalAmountCents = 0;
        let mvServiceFeeCents = 0;
        let hasMvStoredTotals = true;
        for (const vo of vendorOrders) {
          const voOrder = await storage.getOrder(vo.orderId).catch(() => undefined);
          const voBusiness = await storage.getBusiness(vo.businessId).catch(() => undefined);
          if (!firstMvPiOrderNumber && voOrder?.orderNumber) firstMvPiOrderNumber = voOrder.orderNumber;
          if (voOrder?.grossChargeAmount != null && voOrder?.consumerServiceFee != null) {
            mvTotalAmountCents += voOrder.grossChargeAmount;
            mvServiceFeeCents += voOrder.consumerServiceFee;
          } else {
            hasMvStoredTotals = false;
          }
          for (const i of ((voOrder?.items as any[]) || [])) {
            allMvPiItems.push({
              productName: i.name || i.title || i.productId || 'Item',
              vendorName: voBusiness?.name || 'Business',
              vendorContactEmail: voBusiness?.contactEmail ?? undefined,
              quantity: i.quantity || 1,
              basePrice: i.price || i.unitPrice || 0,
            });
          }
        }

        await sendTransactionReceipts('multi_vendor_product_purchase', orderGroupTxnId, {
          consumer: {
            email: purchaser?.email,
            send: () => sendOrderConfirmationToConsumer({
              toEmail: purchaser!.email!,
              consumerName: purchaser!.name || purchaser!.email!,
              orderId: vendorOrders[0]?.orderId || metadata.orderGroupId || '',
              orderNumber: firstMvPiOrderNumber,
              items: allMvPiItems,
              ...(hasMvStoredTotals ? { totalAmountCents: mvTotalAmountCents, platformFeeCents: mvServiceFeeCents } : {}),
            }),
          },
          admin: () => sendInternalEventAlert({
            eventType: 'product_order',
            bookingOrOrderId: orderGroupTxnId,
            consumerName: purchaser?.name || 'Customer',
            consumerEmail: purchaser?.email || '',
            vendorName: `${vendorOrders.length} vendors`,
            vendorEmail: '',
            items: allMvPiItems.map(({ vendorName: _vn, vendorContactEmail: _vce, ...rest }) => rest),
            stripeChargeCents: paymentIntent.amount,
          }),
        });

        // Post-loop: clear cart, award points, notify customer
        if (metadata.userId) {
          await bestEffort(`clearCart for order group ${orderGroupTxnId}`, () => storage.clearCart(metadata.userId));
        }

        if (purchaser) {
          await bestEffort(`earnPoints for order group ${orderGroupTxnId}`, () => storage.earnPoints({
            userId: purchaser.id,
            dollarAmountCents: paymentIntent.amount,
            transactionType: 'business_transaction',
            referenceType: 'multi_vendor_order',
            referenceId: metadata.orderGroupId,
            description: 'Points earned from purchase',
          }));
          await bestEffort(`tryCompleteReferral for order group ${orderGroupTxnId}`, () => this.tryCompleteReferral(purchaser.id, metadata.orderGroupId, 'multi_vendor_order'));
        }

        NotificationTriggers.orderConfirmed({
          customerId: metadata.userId,
          orderId: vendorOrders[0]?.orderId || '',
          businessName: 'Outsyde',
          itemCount: allMvPiItems.length,
        }).catch(err => console.error('Notification error:', err));

        if (metadata.orderGroupId) {
          await storage.updateOrderGroup(metadata.orderGroupId, {
            status: 'completed',
            completedVendors: vendorOrders.length,
          });
        }

        console.log(`[Stripe] Multi-vendor purchase completed: orderGroup ${metadata.orderGroupId} with ${vendorOrders.length} orders`);
      }
    } catch (error) {
      console.error(`[Stripe] Error handling payment_intent.succeeded:`, error);
    }
  }

  /**
   * Handle payment_intent.amount_capturable_updated - called when manual capture PaymentIntent is authorized
   * This transitions to PENDING_PROVIDER state for manual approval flow
   */
  static async handlePaymentIntentCapturableUpdated(paymentIntent: any) {
    const metadata = paymentIntent.metadata || {};
    const { type, bookingId } = metadata;

    if (!type || !bookingId) {
      return;
    }

    // Only handle if there's an amount to capture (authorization successful)
    if (!paymentIntent.amount_capturable || paymentIntent.amount_capturable === 0) {
      return;
    }

    console.log(`[Stripe] PaymentIntent ${paymentIntent.id} authorized for ${type} ${bookingId}`);

    try {
      if (type === 'appointment_booking') {
        const appointment = await storage.getAppointment(bookingId);
        if (!appointment || appointment.status !== BOOKING_STATES.PENDING_PAYMENT) {
          return;
        }

        // Check if provider requires manual approval
        const business = await storage.getBusiness(appointment.businessId);
        if (business && business.autoAcceptBookings === false) {
          // Transition to PENDING_PROVIDER
          const pendingProviderExpiresAt = getPendingProviderExpiryTime();
          
          const result = await transitionAppointmentState(
            bookingId,
            BOOKING_STATES.PENDING_PROVIDER,
            {
              triggeredBy: 'stripe',
              triggerSource: 'webhook',
              metadata: { event: 'payment_intent.amount_capturable_updated' }
            }
          );

          if (result.success) {
            await db.update(appointments).set({
              stripePaymentIntentId: paymentIntent.id,
              pendingProviderExpiresAt,
              updatedAt: new Date()
            }).where(eq(appointments.id, bookingId));

            console.log(`[Stripe] Appointment ${bookingId} awaiting provider approval (48h timeout)`);

            // Notify business owner — new booking request requires action
            const aptOwner = await storage.getUserByBusinessOwnerId(appointment.businessId).catch(() => undefined);
            const aptClient = await storage.getUser(appointment.clientId).catch(() => undefined);
            const aptService = appointment.serviceName || 'Appointment';

            if (aptOwner) {
              sendExpoPush({
                userId: aptOwner.id,
                title: 'New Booking Request',
                body: `${aptClient?.name || 'A customer'} requested ${aptService} on ${appointment.appointmentDate} at ${appointment.appointmentTime}`,
                data: { type: 'booking_request', screen: 'dashboard' },
              }).catch(() => {});

              if (aptOwner.email) {
                sendBookingRequestToVendor({
                  toEmail: aptOwner.email,
                  vendorName: business.name,
                  consumerName: aptClient?.name || 'Customer',
                  consumerUsername: aptClient?.username ?? undefined,
                  serviceName: aptService,
                  bookingId,
                  date: appointment.appointmentDate,
                  time: appointment.appointmentTime,
                  basePrice: appointment.totalPrice,
                  expiresAt: pendingProviderExpiresAt,
                }).catch(() => {});
              }
            }

            // Notify customer — request received, card authorized but not charged
            if (aptClient) {
              sendExpoPush({
                userId: aptClient.id,
                title: 'Booking Request Sent',
                body: `Your request for ${aptService} at ${business.name} is awaiting approval`,
                data: { type: 'booking_request_sent', screen: 'bookings' },
              }).catch(() => {});

              if (aptClient.email) {
                sendBookingRequestReceivedToConsumer({
                  toEmail: aptClient.email,
                  consumerName: aptClient.name || aptClient.email,
                  vendorName: business.name,
                  serviceName: aptService,
                  bookingId,
                  date: appointment.appointmentDate,
                  time: appointment.appointmentTime,
                  expiresAt: pendingProviderExpiresAt,
                }).catch(() => {});
              }
            }
          }
        }
      } else if (type === 'shoot_booking') {
        const booking = await storage.getShootBooking(bookingId);
        if (!booking || booking.status !== BOOKING_STATES.PENDING_PAYMENT) {
          return;
        }

        const photographer = await storage.getPhotographer(booking.photographerId);
        if (photographer && photographer.autoAcceptBookings === false) {
          const pendingProviderExpiresAt = getPendingProviderExpiryTime();

          const result = await transitionShootBookingState(
            bookingId,
            BOOKING_STATES.PENDING_PROVIDER,
            {
              triggeredBy: 'stripe',
              triggerSource: 'webhook',
              metadata: { event: 'payment_intent.amount_capturable_updated' }
            }
          );

          if (result.success) {
            await db.update(shootBookings).set({
              stripePaymentIntentId: paymentIntent.id,
              pendingProviderExpiresAt,
              updatedAt: new Date()
            }).where(eq(shootBookings.id, bookingId));

            console.log(`[Stripe] Shoot booking ${bookingId} awaiting provider approval (48h timeout)`);

            // Notify photographer — new booking request requires action
            const shootClient = await storage.getUser(booking.clientId).catch(() => undefined);
            const photographerUser = await storage.getUser(photographer.userId).catch(() => undefined);
            const shootService = booking.shootType || 'Shoot';

            if (photographerUser) {
              sendExpoPush({
                userId: photographerUser.id,
                title: 'New Shoot Request',
                body: `${shootClient?.name || 'A client'} requested ${shootService} on ${booking.date} at ${booking.startTime}`,
                data: { type: 'booking_request', screen: 'dashboard' },
              }).catch(() => {});

              if (photographerUser.email) {
                sendBookingRequestToVendor({
                  toEmail: photographerUser.email,
                  vendorName: photographer.displayName || 'Photographer',
                  consumerName: shootClient?.name || 'Client',
                  consumerUsername: shootClient?.username ?? undefined,
                  serviceName: shootService,
                  bookingId,
                  date: booking.date,
                  time: booking.startTime,
                  basePrice: booking.totalPrice,
                  expiresAt: pendingProviderExpiresAt,
                }).catch(() => {});
              }
            }

            // Notify customer
            if (shootClient) {
              sendExpoPush({
                userId: shootClient.id,
                title: 'Shoot Request Sent',
                body: `Your ${shootService} request with ${photographer.displayName || 'photographer'} is awaiting approval`,
                data: { type: 'booking_request_sent', screen: 'bookings' },
              }).catch(() => {});

              if (shootClient.email) {
                sendBookingRequestReceivedToConsumer({
                  toEmail: shootClient.email,
                  consumerName: shootClient.name || shootClient.email,
                  vendorName: photographer.displayName || 'Photographer',
                  serviceName: shootService,
                  bookingId,
                  date: booking.date,
                  time: booking.startTime,
                  expiresAt: pendingProviderExpiresAt,
                }).catch(() => {});
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`[Stripe] Error handling payment_intent.amount_capturable_updated:`, error);
    }
  }

  /**
   * Handle payment_intent.canceled - authorization was voided
   */
  static async handlePaymentIntentCanceled(paymentIntent: any) {
    const metadata = paymentIntent.metadata || {};
    const { type, bookingId } = metadata;

    // Handle product order cancellation
    if (metadata.orderId && !metadata.bookingId) {
      try {
        await storage.updateOrder(metadata.orderId, { status: 'cancelled' });
        console.log(`[Stripe] Order ${metadata.orderId} marked cancelled`);
      } catch (err) {
        console.error('[Stripe] Failed to cancel order:', metadata.orderId, err);
      }
      return;
    }

    if (!type || !bookingId) {
      return;
    }

    console.log(`[Stripe] PaymentIntent canceled for ${type} ${bookingId}`);

    try {
      if (type === 'appointment_booking') {
        const appointment = await storage.getAppointment(bookingId);
        if (!appointment) return;

        // Only handle if still in a cancellable state
        if ([BOOKING_STATES.PENDING_PAYMENT, BOOKING_STATES.PENDING_PROVIDER, BOOKING_STATES.DRAFT].includes(appointment.status as any)) {
          await transitionAppointmentState(
            bookingId,
            BOOKING_STATES.CANCELED,
            {
              triggeredBy: 'stripe',
              triggerSource: 'webhook',
              metadata: { 
                event: 'payment_intent.canceled',
                cancellationReason: paymentIntent.cancellation_reason 
              }
            }
          );
          console.log(`[Stripe] Appointment ${bookingId} canceled (payment voided)`);
        }
      } else if (type === 'shoot_booking') {
        const booking = await storage.getShootBooking(bookingId);
        if (!booking) return;

        if ([BOOKING_STATES.PENDING_PAYMENT, BOOKING_STATES.PENDING_PROVIDER, BOOKING_STATES.DRAFT].includes(booking.status as any)) {
          await transitionShootBookingState(
            bookingId,
            BOOKING_STATES.CANCELED,
            {
              triggeredBy: 'stripe',
              triggerSource: 'webhook',
              metadata: { 
                event: 'payment_intent.canceled',
                cancellationReason: paymentIntent.cancellation_reason 
              }
            }
          );
          console.log(`[Stripe] Shoot booking ${bookingId} canceled (payment voided)`);
        }
      }
    } catch (error) {
      console.error(`[Stripe] Error handling payment_intent.canceled:`, error);
    }
  }

  /**
   * Handle payment_intent.payment_failed - payment attempt failed
   */
  static async handlePaymentIntentFailed(paymentIntent: any) {
    const metadata = paymentIntent.metadata || {};
    const { type, bookingId } = metadata;

    // Handle product order payment failure
    if (metadata.orderId && !metadata.bookingId) {
      try {
        await storage.updateOrder(metadata.orderId, { status: 'cancelled' });
        console.log(`[Stripe] Order ${metadata.orderId} marked cancelled (payment failed)`);
      } catch (err) {
        console.error('[Stripe] Failed to cancel order:', metadata.orderId, err);
      }
      return;
    }

    if (!type || !bookingId) {
      return;
    }

    console.log(`[Stripe] PaymentIntent failed for ${type} ${bookingId}`);

    try {
      // Log the failure but don't immediately cancel - let the user retry
      // The draft/pending_payment cleanup job will expire it if they don't complete payment
      console.log(`[Stripe] Payment failed for ${type} ${bookingId}: ${paymentIntent.last_payment_error?.message || 'Unknown error'}`);
    } catch (error) {
      console.error(`[Stripe] Error handling payment_intent.payment_failed:`, error);
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
    if (!vendorId || !businessId || !tierId) {
      console.error('[Webhook] checkout.session.completed missing metadata:', { vendorId, businessId, tierId });
      return;
    }

    try {
      const existing = await storage.getVendorSubscription(vendorId);

      let subscriptionId: string;
      if (existing) {
        const oldStripeSubId = existing.stripeSubscriptionId;
        const newStripeSubId: string = session.subscription;

        await storage.updateVendorSubscription(existing.id, {
          tierId,
          status: 'active',
          stripeSubscriptionId: newStripeSubId,
          stripeCustomerId: session.customer,
        });
        subscriptionId = existing.id;

        // If a different Stripe subscription existed, cancel it to prevent duplicate billing.
        if (oldStripeSubId && oldStripeSubId !== newStripeSubId) {
          try {
            const stripe = await getUncachableStripeClient();
            await stripe.subscriptions.cancel(oldStripeSubId);
            console.log(`[Webhook] Cancelled old Stripe subscription ${oldStripeSubId} — replaced by ${newStripeSubId} for vendor ${vendorId}`);
          } catch (cancelErr) {
            console.error(`[Webhook] Failed to cancel old Stripe subscription ${oldStripeSubId}:`, cancelErr);
          }
        }
      } else {
        const newSub = await storage.createVendorSubscription({
          vendorId,
          businessId,
          tierId,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
        });
        subscriptionId = newSub.id;
        await storage.updateVendorSubscription(newSub.id, { status: 'active' });
      }

      // Activate the business subscription flag
      await storage.updateBusiness(businessId, {
        subscriptionActive: true,
      });

      console.log(`[Webhook] Subscription activated: vendor=${vendorId} business=${businessId} tier=${tierId} stripeSubId=${session.subscription}`);

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

      await this.tryCompleteReferral(vendorId, subscriptionId, 'vendor_subscription');
    } catch (error) {
      console.error('[Webhook] checkout.session.completed subscription activation failed:', error);
      console.error('[Webhook] Event data:', JSON.stringify(session));
    }
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

    const order = await storage.getOrder(orderId);
    if (!order) return;

    // Atomically mark paid; only the delivery that flips it continues.
    if (!(await claimOrderPaid(orderId, session.payment_intent))) {
      logReceiptsSkipped('cart_checkout', orderId);
      return;
    }

    const business = businessId ? await storage.getBusiness(businessId).catch(() => undefined) : undefined;
    const vendor = businessId ? await storage.getUserByBusinessOwnerId(businessId).catch(() => undefined) : undefined;
    const customer = await storage.getUser(order.customerId).catch(() => undefined);

    const cartItems = ((order.items as any[]) || []).map((i: any) => ({
      productName: i.name || i.title || i.productId || 'Item',
      vendorName: business?.name || vendor?.name || 'Business',
      vendorContactEmail: business?.contactEmail ?? undefined,
      quantity: i.quantity || 1,
      basePrice: i.price || i.unitPrice || 0,
    }));
    const cartVendorItems = cartItems.map(({ vendorName: _vn, vendorContactEmail: _vce, ...rest }) => rest);

    // Receipts first, so later side effects can never skip them.
    await sendTransactionReceipts('cart_checkout', orderId, {
      consumer: {
        email: customer?.email,
        send: () => sendOrderConfirmationToConsumer({
          toEmail: customer!.email!,
          consumerName: customer!.name || customer!.email!,
          orderId,
          orderNumber: order.orderNumber,
          items: cartItems,
          totalAmountCents: order.grossChargeAmount ?? undefined,
          platformFeeCents: order.consumerServiceFee ?? undefined,
        }),
      },
      vendor: {
        email: vendor?.email,
        send: () => sendOrderNotificationToVendor({
          toEmail: vendor!.email!,
          vendorName: business?.name || vendor!.name || 'Business',
          consumerName: customer?.name || 'Customer',
          consumerUsername: customer?.username ?? undefined,
          orderId,
          orderNumber: order.orderNumber,
          items: cartVendorItems,
          vendorNetCents: order.vendorNet ?? undefined,
        }),
      },
      admin: () => sendInternalEventAlert({
        eventType: 'product_order',
        bookingOrOrderId: orderId,
        consumerName: customer?.name || 'Customer',
        consumerEmail: customer?.email || '',
        vendorName: business?.name || vendor?.name || 'Business',
        vendorEmail: vendor?.email || '',
        items: cartVendorItems,
        stripeChargeCents: session.amount_total ?? undefined,
      }),
    });

    // Process influencer commission if attributed (idempotent, handles transfer + logging)
    if (order.influencerCodeUsed || order.attributedInfluencerId) {
      try {
        await processInfluencerCommission(orderId, session.payment_intent);
      } catch (commErr) {
        console.error(`[InfluencerPayout] Error processing commission for order ${orderId}:`, commErr);
      }
    }

    // Decrement inventory for purchased items
    if (order.items && Array.isArray(order.items)) {
      for (const item of order.items) {
        try {
          await decrementInventory(item);
        } catch (invError) {
          console.error(`[Inventory] Failed to decrement ${item.productId}:`, invError);
        }
      }
    }

    // Clear the user's cart
    if (userId) {
      await bestEffort(`clearCart for order ${orderId}`, () => storage.clearCart(userId));
    }

    // Award points to the customer
    const user = await this.findUserByStripeCustomer(session.customer).catch(() => undefined);
    if (user) {
      await bestEffort(`earnPoints for order ${orderId}`, () => storage.earnPoints({
        userId: user.id,
        dollarAmountCents: session.amount_total,
        transactionType: 'business_transaction',
        referenceType: "cart_order",
        referenceId: orderId,
        description: "Points earned from purchase",
      }));

      await bestEffort(`tryCompleteReferral for order ${orderId}`, () => this.tryCompleteReferral(user.id, orderId, 'cart_order'));
    }

    // Notify the business of the new order
    if (vendor) {
      const itemCount = order.items?.length || 1;
      await bestEffort(`newOrderReceived for order ${orderId}`, () => NotificationTriggers.newOrderReceived({
        vendorUserId: vendor.id,
        orderId,
        customerName: customer?.name || customer?.email || 'Customer',
        orderTotal: order.totalAmount,
        itemCount,
      }));

      // Notify the customer that their order is confirmed
      NotificationTriggers.orderConfirmed({
        customerId: order.customerId,
        orderId,
        businessName: business?.name || vendor.name || 'the business',
        itemCount,
      }).catch(err => console.error('Notification error:', err));
    }

    console.log(`[Stripe] Cart checkout completed: Order ${orderId} marked as paid`);
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

    const user = (await this.findUserByStripeCustomer(session.customer).catch(() => undefined))
      ?? (userId ? await storage.getUser(userId).catch(() => undefined) : undefined);
    let claimedOrders = 0;

    // Process each order and initiate transfers
    for (const vendorOrder of vendorOrders) {
      const { orderId, businessId, vendorNet } = vendorOrder;

      const order = await storage.getOrder(orderId);
      if (!order) continue;

      // Atomically mark paid; only the delivery that flips it continues.
      if (!(await claimOrderPaid(orderId, session.payment_intent))) {
        logReceiptsSkipped('multi_vendor_cart_checkout', orderId);
        continue;
      }
      claimedOrders++;

      const business = await storage.getBusiness(businessId).catch(() => undefined);
      const vendorUser = await storage.getUserByBusinessOwnerId(businessId).catch(() => undefined);
      const customer = await storage.getUser(order.customerId).catch(() => undefined);

      // Vendor receipt for this vendor's portion — first, before side effects.
      await sendTransactionReceipts('multi_vendor_cart_checkout', orderId, {
        vendor: {
          email: vendorUser?.email,
          send: () => sendOrderNotificationToVendor({
            toEmail: vendorUser!.email!,
            vendorName: business?.name || vendorUser!.name || 'Business',
            consumerName: customer?.name || 'Customer',
            consumerUsername: customer?.username ?? undefined,
            orderId,
            orderNumber: order.orderNumber,
            items: ((order.items as any[]) || []).map((i: any) => ({
              productName: i.name || i.title || i.productId || 'Item',
              quantity: i.quantity || 1,
              basePrice: i.price || i.unitPrice || 0,
            })),
          }),
        },
      });

      // Process influencer commission if attributed
      if (order.influencerCodeUsed || order.attributedInfluencerId) {
        try {
          await processInfluencerCommission(orderId, session.payment_intent);
        } catch (commErr) {
          console.error(`[InfluencerPayout] Error processing commission for order ${orderId}:`, commErr);
        }
      }

      // Decrement inventory for purchased items
      if (order.items && Array.isArray(order.items)) {
        for (const item of order.items) {
          try {
            await decrementInventory(item);
          } catch (invError) {
            console.error(`[Inventory] Failed to decrement ${item.productId}:`, invError);
          }
        }
      }

      // Transfer the vendor's share to their connected account (from business, not user)
      if (business?.stripeAccountId && vendorNet > 0) {
        try {
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
          await bestEffort(`mark transfer_failed for order ${orderId}`, () => storage.updateOrder(orderId, {
            status: 'transfer_failed',
          }));
        }
      }

      // Notify the business owner of the new order (in-app)
      if (vendorUser) {
        await bestEffort(`newOrderReceived for order ${orderId}`, () => NotificationTriggers.newOrderReceived({
          vendorUserId: vendorUser.id,
          orderId,
          customerName: customer?.name || customer?.email || 'Customer',
          orderTotal: order.totalAmount,
          itemCount: order.items?.length || 1,
        }));
      }
    }

    if (claimedOrders === 0) {
      logReceiptsSkipped('multi_vendor_cart_checkout', orderGroupId);
      return;
    }

    // Consolidated consumer receipt + admin copy — not gated on any other lookup.
    const wcAllItems: Array<{ productName: string; vendorName: string; vendorContactEmail?: string; quantity: number; basePrice: number }> = [];
    let firstWcMvOrderNumber = 0;
    for (const vo of vendorOrders) {
      const voOrder = await storage.getOrder(vo.orderId).catch(() => undefined);
      const voBusiness = await storage.getBusiness(vo.businessId).catch(() => undefined);
      if (!firstWcMvOrderNumber && voOrder?.orderNumber) firstWcMvOrderNumber = voOrder.orderNumber;
      for (const i of ((voOrder?.items as any[]) || [])) {
        wcAllItems.push({
          productName: i.name || i.title || i.productId || 'Item',
          vendorName: voBusiness?.name || 'Business',
          vendorContactEmail: voBusiness?.contactEmail ?? undefined,
          quantity: i.quantity || 1,
          basePrice: i.price || i.unitPrice || 0,
        });
      }
    }

    await sendTransactionReceipts('multi_vendor_cart_checkout', orderGroupId, {
      consumer: {
        email: user?.email,
        send: () => sendOrderConfirmationToConsumer({
          toEmail: user!.email!,
          consumerName: user!.name || user!.email!,
          orderId: vendorOrders[0]?.orderId || orderGroupId,
          orderNumber: firstWcMvOrderNumber,
          items: wcAllItems,
        }),
      },
      admin: () => sendInternalEventAlert({
        eventType: 'product_order',
        bookingOrOrderId: orderGroupId,
        consumerName: user?.name || 'Customer',
        consumerEmail: user?.email || '',
        vendorName: `${vendorOrders.length} vendors`,
        vendorEmail: '',
        items: wcAllItems.map(({ vendorName: _vn, vendorContactEmail: _vce, ...rest }) => rest),
        stripeChargeCents: session.amount_total ?? undefined,
      }),
    });

    // Update order group status to completed
    await bestEffort(`updateOrderGroup ${orderGroupId}`, () => storage.updateOrderGroup(orderGroupId, {
      status: 'completed',
      completedVendors: vendorOrders.length,
    }));

    // Clear the user's cart
    if (userId) {
      await bestEffort(`clearCart for order group ${orderGroupId}`, () => storage.clearCart(userId));
    }

    // Award points to the customer
    if (user) {
      await bestEffort(`earnPoints for order group ${orderGroupId}`, () => storage.earnPoints({
        userId: user.id,
        dollarAmountCents: session.amount_total,
        transactionType: 'business_transaction',
        referenceType: "multi_vendor_order",
        referenceId: orderGroupId,
        description: "Points earned from multi-vendor purchase",
      }));

      // Complete referral bonus if this is the user's first transaction
      await bestEffort(`tryCompleteReferral for order group ${orderGroupId}`, () => this.tryCompleteReferral(user.id, orderGroupId, 'multi_vendor_order'));

      // In-app notification for consumer
      NotificationTriggers.orderConfirmed({
        customerId: user.id,
        orderId: vendorOrders[0]?.orderId || orderGroupId,
        businessName: 'Outsyde',
        itemCount: vendorOrders.length,
      }).catch(err => console.error('Notification error:', err));
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
     SUBSCRIPTION DELETED (HARD CANCEL)
  ===================================================== */
  static async handleSubscriptionDeleted(subscription: any) {
    const vendorSub = await storage.getVendorSubscriptionByStripeId(subscription.id);
    if (!vendorSub) return;

    await storage.updateVendorSubscription(vendorSub.id, { status: 'canceled' });

    if (vendorSub.businessId) {
      await storage.updateBusiness(vendorSub.businessId, { subscriptionActive: false });
    }

    console.log(`[Webhook] customer.subscription.deleted: stripeId=${subscription.id} vendor=${vendorSub.vendorId} marked canceled`);
  }

  /* =====================================================
     INVOICE PAID (RENEW BENEFITS)
  ===================================================== */
  static async handleInvoicePaid(invoice: any) {
    if (!invoice.subscription) return;

    try {
      const vendorSub = await storage.getVendorSubscriptionByStripeId(invoice.subscription);
      if (!vendorSub) return;

      const stripe = await getUncachableStripeClient();
      const subResponse = await stripe.subscriptions.retrieve(invoice.subscription);
      const sub = subResponse as unknown as { current_period_start: number; current_period_end: number; status: string };

      await storage.updateVendorSubscription(vendorSub.id, {
        status: sub.status || 'active',
        currentPeriodStart: new Date(sub.current_period_start * 1000),
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
      });

      if (vendorSub.businessId) {
        await storage.updateBusiness(vendorSub.businessId, {
          subscriptionActive: sub.status === 'active' || sub.status === 'trialing',
        });
      }

      await storage.createBenefitAllowances(vendorSub.id);

      console.log(`[Webhook] invoice.paid: subscription ${invoice.subscription} status=${sub.status}`);
    } catch (error) {
      console.error('[Webhook] invoice.paid handler failed:', error);
    }
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
  static async handleConnectAccountUpdated(account: any, eventCreatedAt: number) {
    const metadata = account.metadata || {};
    const accountId = account.id;
    
    // Onboarding is complete when charges are enabled and details are submitted.
    // payouts_enabled may lag behind in sandbox — don't gate on it.
    const isOnboardingComplete = account.charges_enabled === true && account.details_submitted === true;
    
    console.log(`[Stripe] account.updated for ${accountId}: charges_enabled=${account.charges_enabled}, payouts_enabled=${account.payouts_enabled}, details_submitted=${account.details_submitted}, isComplete=${isOnboardingComplete}`);
    
    // Try to find the entity by metadata first, then fallback to account ID lookup
    let business = null;
    let photographer = null;
    let staffMember = null;
    
    if (metadata.role === 'business' && metadata.businessId) {
      business = await storage.getBusiness(metadata.businessId);
    } else if (metadata.role === 'photographer' && metadata.photographerId) {
      photographer = await storage.getPhotographer(metadata.photographerId);
    } else if (metadata.role === 'staff' && metadata.staffId) {
      staffMember = await storage.getStaffMember(metadata.staffId);
    }
    
    // Fallback: Look up by stripeAccountId directly if metadata didn't match
    if (!business && !photographer && !staffMember) {
      console.log(`[Stripe] No metadata match for ${accountId}, searching by account ID...`);
      business = await storage.getBusinessByStripeAccountId(accountId);
      if (!business) {
        photographer = await storage.getPhotographerByStripeAccountId(accountId);
      }
      if (!business && !photographer) {
        staffMember = await storage.getStaffMemberByStripeAccountId(accountId);
      }
    }
    
    // Update business onboarding status (with event-ordering guard)
    if (business && business.stripeAccountId === accountId) {
      const incomingEventTime = new Date(eventCreatedAt * 1000);
      const lastAppliedTime = business.stripeOnboardingLastEventAt;
      if (lastAppliedTime && incomingEventTime <= new Date(lastAppliedTime)) {
        console.log(`[Stripe] Ignoring stale/out-of-order account.updated for business ${business.id} — event time ${incomingEventTime.toISOString()} <= last applied ${new Date(lastAppliedTime).toISOString()}`);
      } else {
        const wasAlreadyComplete = business.stripeOnboardingComplete === true;
        // Never downgrade stripe_onboarding_complete true → false. That flag
        // controls public visibility via isBusinessVisibleToPublic, so an
        // incomplete account.updated (e.g. Express account just created,
        // charges_enabled/details_submitted still false) would take a live
        // vendor storefront offline mid-onboarding. Still write
        // stripeOnboardingLastEventAt so the stale-event guard stays accurate.
        const skipCompleteDowngrade = wasAlreadyComplete && !isOnboardingComplete;
        if (skipCompleteDowngrade) {
          console.log(`[Stripe] Skipping stripeOnboardingComplete downgrade for business ${business.id} — keeping true; writing lastEventAt only`);
        }
        await storage.updateBusiness(business.id, {
          ...(skipCompleteDowngrade ? {} : { stripeOnboardingComplete: isOnboardingComplete }),
          stripeOnboardingLastEventAt: incomingEventTime,
        });

        if (isOnboardingComplete && !wasAlreadyComplete) {
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
    }
    
    // Update photographer onboarding status (with event-ordering guard)
    if (photographer && photographer.stripeAccountId === accountId) {
      const incomingEventTime = new Date(eventCreatedAt * 1000);
      const lastAppliedTime = photographer.stripeOnboardingLastEventAt;
      if (lastAppliedTime && incomingEventTime <= new Date(lastAppliedTime)) {
        console.log(`[Stripe] Ignoring stale/out-of-order account.updated for photographer ${photographer.id} — event time ${incomingEventTime.toISOString()} <= last applied ${new Date(lastAppliedTime).toISOString()}`);
      } else {
        const wasAlreadyComplete = photographer.stripeOnboardingComplete === true;
        console.log(`[Stripe] Updating photographer ${photographer.id} (${photographer.displayName}) stripeOnboardingComplete=${isOnboardingComplete}`);
        await storage.updatePhotographer(photographer.id, {
          stripeOnboardingComplete: isOnboardingComplete,
          stripeOnboardingLastEventAt: incomingEventTime,
        });
        console.log(`[Stripe] Photographer ${photographer.id} stripeOnboardingComplete updated to ${isOnboardingComplete}`);

        if (isOnboardingComplete && !wasAlreadyComplete) {
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
    }
    
    // Update staff member onboarding status (with event-ordering guard)
    if (staffMember && staffMember.stripeAccountId === accountId) {
      const incomingEventTime = new Date(eventCreatedAt * 1000);
      const lastAppliedTime = staffMember.stripeOnboardingLastEventAt;
      if (lastAppliedTime && incomingEventTime <= new Date(lastAppliedTime)) {
        console.log(`[Stripe] Ignoring stale/out-of-order account.updated for staff ${staffMember.id} — event time ${incomingEventTime.toISOString()} <= last applied ${new Date(lastAppliedTime).toISOString()}`);
      } else {
        const wasAlreadyComplete = staffMember.stripeOnboardingComplete === true;
        // Never downgrade stripe_onboarding_complete true → false. Public
        // staff listing/availability gates on staff.stripeOnboardingComplete,
        // so an incomplete account.updated would hide a bookable staff
        // member mid-onboarding. Still write stripeOnboardingLastEventAt
        // so the stale-event guard stays accurate.
        const skipCompleteDowngrade = wasAlreadyComplete && !isOnboardingComplete;
        if (skipCompleteDowngrade) {
          console.log(`[Stripe] Skipping stripeOnboardingComplete downgrade for staff ${staffMember.id} — keeping true; writing lastEventAt only`);
        } else {
          console.log(`[Stripe] Updating staff ${staffMember.id} (${staffMember.displayName}) stripeOnboardingComplete=${isOnboardingComplete}`);
        }
        await storage.updateStaffMember(staffMember.id, {
          ...(skipCompleteDowngrade ? {} : { stripeOnboardingComplete: isOnboardingComplete }),
          stripeOnboardingLastEventAt: incomingEventTime,
        });
        if (isOnboardingComplete) {
          console.log(`[Stripe] Staff member ${staffMember.id} (${staffMember.displayName}) completed Stripe onboarding`);

          // Notify only on the true pending->complete transition — never on
          // re-delivery of an already-complete state (e.g. a later account.updated
          // where charges_enabled/details_submitted are unchanged).
          if (!wasAlreadyComplete) {
            try {
              const business = await storage.getBusiness(staffMember.businessId);
              const businessName = business?.name || "Your Business";

              const owner = await storage.getUserByBusinessOwnerId(staffMember.businessId);
              if (owner) {
                await NotificationTriggers.staffOnboardingCompleteOwner({
                  ownerId: owner.id,
                  staffId: staffMember.id,
                  staffName: staffMember.displayName,
                  businessName,
                });
                if (owner.email) {
                  const { sent, error: ownerEmailError } = await sendStaffOnboardingCompleteOwnerEmail({
                    toEmail: owner.email,
                    staffName: staffMember.displayName,
                    businessName,
                  });
                  if (!sent) {
                    console.warn(`[Stripe] Owner onboarding-complete email not sent for staff ${staffMember.id}: ${ownerEmailError}`);
                  }
                }
              } else {
                console.warn(`[Stripe] No owner found for business ${staffMember.businessId} — skipping owner notification`);
              }

              if (staffMember.userId) {
                await NotificationTriggers.staffBookable({
                  userId: staffMember.userId,
                  staffId: staffMember.id,
                  businessName,
                });
              }
            } catch (notifyErr) {
              console.error(
                `[Stripe] Non-critical: staff onboarding-complete notifications failed for staff ${staffMember.id}:`,
                notifyErr,
              );
            }
          }
        }
      }
    }

    if (!business && !photographer && !staffMember) {
      console.log(`[Stripe] No business, photographer, or staff member found for account ${accountId}`);
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
        if (result.code === 'ALREADY_CONFIRMED' || result.code === 'CONCURRENT_TRANSITION') {
          logReceiptsSkipped('appointment_checkout', appointmentId);
        } else {
          console.error(`[Stripe] Failed to confirm appointment ${appointmentId}: ${result.error}`);
        }
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

      const [appointment] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
      if (!appointment) return;

      const business = await storage.getBusiness(appointment.businessId).catch(() => undefined);
      const owner = await storage.getUserByBusinessOwnerId(appointment.businessId).catch(() => undefined);
      const customer = clientId ? await storage.getUser(clientId).catch(() => undefined) : undefined;

      // Receipts first, so later side effects can never skip them.
      await sendTransactionReceipts('appointment_checkout', appointmentId, {
        consumer: {
          email: customer?.email,
          send: () => sendAppointmentConfirmationToConsumer({
            toEmail: customer!.email!,
            consumerName: customer!.name || customer!.email!,
            vendorName: business?.name || 'Business',
            vendorContactEmail: business?.contactEmail ?? undefined,
            serviceName: appointment.serviceName || 'Appointment',
            bookingId: appointmentId,
            bookingNumber: appointment.bookingNumber,
            date: appointment.appointmentDate,
            time: appointment.appointmentTime,
            basePrice: appointment.totalPrice,
          }),
        },
        vendor: {
          email: owner?.email,
          send: () => sendAppointmentNotificationToVendor({
            toEmail: owner!.email!,
            vendorName: business?.name || 'Business',
            consumerName: customer?.name || 'Customer',
            consumerUsername: customer?.username ?? undefined,
            serviceName: appointment.serviceName || 'Appointment',
            bookingId: appointmentId,
            bookingNumber: appointment.bookingNumber,
            date: appointment.appointmentDate,
            time: appointment.appointmentTime,
            basePrice: appointment.totalPrice,
          }),
        },
        admin: () => sendInternalEventAlert({
          eventType: 'appointment_booking',
          bookingOrOrderId: appointmentId,
          consumerName: customer?.name || 'Customer',
          consumerEmail: customer?.email || '',
          vendorName: business?.name || 'Business',
          vendorEmail: owner?.email || '',
          basePrice: appointment.totalPrice,
          paymentType: 'full',
          amountChargedCents: appointment.totalPrice,
          serviceTotalCents: appointment.totalPrice,
          stripeChargeCents: session.amount_total ?? undefined,
          date: appointment.appointmentDate,
          time: appointment.appointmentTime,
        }),
      });

      // Mark any associated hold as converted
      const holdId = session.metadata?.holdId;
      if (holdId) {
        try {
          await markHoldAsConverted(holdId, appointmentId, 'appointment');
        } catch (holdErr) {
          console.error(`[Stripe] Failed to convert hold ${holdId}:`, holdErr);
        }
      }

      // Send booking confirmation notifications (async, non-blocking)
      if (clientId) {
        NotificationTriggers.paymentSucceeded({
          userId: clientId,
          amount: appointment.totalPrice,
          referenceType: 'appointment',
          referenceId: appointmentId,
          description: `Booking confirmed at ${business?.name || 'business'}`,
        }).catch(err => console.error("[Stripe] Failed to send booking notification:", err));

        if (owner) {
          NotificationTriggers.paymentSucceeded({
            userId: owner.id,
            amount: appointment.totalPrice,
            referenceType: 'appointment',
            referenceId: appointmentId,
            description: `New booking from ${customer?.name || 'customer'}`,
          }).catch(err => console.error("[Stripe] Failed to send business notification:", err));

          // Mobile push notification (Expo) — failures never crash the booking flow
          sendBookingConfirmationPush({
            customerId: clientId,
            providerName: business?.name || 'business',
            date: appointment.appointmentDate,
            time: appointment.appointmentTime,
            businessOwnerId: owner.id,
            customerName: customer?.name || undefined,
          }).catch(err => console.error("[ExpoPush] Appointment push error:", err));
        }

        // Award points for the booking
        await bestEffort(`earnPoints for appointment ${appointmentId}`, () => storage.earnPoints({
          userId: clientId,
          dollarAmountCents: appointment.totalPrice,
          transactionType: 'business_transaction',
          referenceType: "appointment",
          referenceId: appointmentId,
          description: "Points earned from service booking",
          businessId: appointment.businessId,
        }));

        // Complete referral bonus if applicable
        await bestEffort(`tryCompleteReferral for appointment ${appointmentId}`, () => this.tryCompleteReferral(clientId, appointmentId, 'appointment'));
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
        if (result.code === 'ALREADY_CONFIRMED' || result.code === 'CONCURRENT_TRANSITION') {
          logReceiptsSkipped('shoot_checkout', shootBookingId);
        } else {
          console.error(`[Stripe] Failed to confirm shoot booking ${shootBookingId}: ${result.error}`);
        }
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

      const [booking] = await db.select().from(shootBookings).where(eq(shootBookings.id, shootBookingId));
      if (!booking) return;

      const photographer = await storage.getPhotographer(booking.photographerId).catch(() => undefined);
      const photographerUser = photographer ? await storage.getUser(photographer.userId).catch(() => undefined) : undefined;
      const sbCustomer = clientId ? await storage.getUser(clientId).catch(() => undefined) : undefined;

      // Receipts first, so later side effects can never skip them.
      await sendTransactionReceipts('shoot_checkout', shootBookingId, {
        consumer: {
          email: sbCustomer?.email,
          send: () => sendShootBookingConfirmationToConsumer({
            toEmail: sbCustomer!.email!,
            consumerName: sbCustomer!.name || sbCustomer!.email!,
            photographerName: photographer?.displayName || 'Photographer',
            photographerContactEmail: photographerUser?.email ?? undefined,
            shootType: booking.shootType,
            bookingId: shootBookingId,
            bookingNumber: booking.bookingNumber,
            date: booking.date,
            time: booking.startTime,
            basePrice: booking.totalPrice,
          }),
        },
        vendor: {
          email: photographerUser?.email,
          send: () => sendShootBookingNotificationToPhotographer({
            toEmail: photographerUser!.email!,
            photographerName: photographer?.displayName || 'Photographer',
            consumerName: sbCustomer?.name || 'Customer',
            consumerUsername: sbCustomer?.username ?? undefined,
            shootType: booking.shootType,
            bookingId: shootBookingId,
            bookingNumber: booking.bookingNumber,
            date: booking.date,
            time: booking.startTime,
            basePrice: booking.totalPrice,
          }),
        },
        admin: () => sendInternalEventAlert({
          eventType: 'shoot_booking',
          bookingOrOrderId: shootBookingId,
          consumerName: sbCustomer?.name || 'Customer',
          consumerEmail: sbCustomer?.email || '',
          vendorName: photographer?.displayName || 'Photographer',
          vendorEmail: photographerUser?.email || '',
          basePrice: booking.totalPrice,
          paymentType: 'full',
          amountChargedCents: booking.totalPrice,
          stripeChargeCents: session.amount_total ?? undefined,
          date: booking.date,
          time: booking.startTime,
        }),
      });

      // Mark any associated hold as converted
      const holdId = session.metadata?.holdId;
      if (holdId) {
        try {
          await markHoldAsConverted(holdId, shootBookingId, 'shoot_booking');
        } catch (holdErr) {
          console.error(`[Stripe] Failed to convert hold ${holdId}:`, holdErr);
        }
      }

      // Send booking confirmation notifications (async, non-blocking)
      if (clientId) {
        NotificationTriggers.bookingConfirmed({
          customerId: clientId,
          photographerId: booking.photographerId,
          bookingId: shootBookingId,
          photographerName: photographer?.displayName || 'Photographer',
          shootType: booking.shootType,
          date: booking.date,
          time: booking.startTime,
        }).catch(err => console.error("[Stripe] Failed to send booking notification:", err));

        // Mobile push notification (Expo) — failures never crash the booking flow
        sendBookingConfirmationPush({
          customerId: clientId,
          providerName: photographer?.displayName || 'Photographer',
          date: booking.date,
          time: booking.startTime,
          businessOwnerId: photographer?.userId,
          customerName: undefined,
        }).catch(err => console.error("[ExpoPush] Shoot booking push error:", err));

        // Award points for the booking
        await bestEffort(`earnPoints for shoot booking ${shootBookingId}`, () => storage.earnPoints({
          userId: clientId,
          dollarAmountCents: booking.totalPrice,
          transactionType: 'photographer_booking',
          referenceType: "shoot_booking",
          referenceId: shootBookingId,
          description: "Points earned from photography booking",
        }));

        // Complete referral bonus if applicable
        await bestEffort(`tryCompleteReferral for shoot booking ${shootBookingId}`, () => this.tryCompleteReferral(clientId, shootBookingId, 'shoot_booking'));
      }
    } catch (error) {
      console.error(`[Stripe] Error confirming shoot booking ${shootBookingId}:`, error);
    }
  }
}
