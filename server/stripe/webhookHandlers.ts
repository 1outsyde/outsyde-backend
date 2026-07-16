import { getUncachableStripeClient } from "./stripeClient";
import { storage } from "../storage";
import { db } from "../db";
import { fulfillmentTasks, subscriptionTiers, appointments, shootBookings, bookingAuditLog, BOOKING_STATES } from "@shared/schema";
import { sql, eq, and, inArray } from "drizzle-orm";
import { NotificationTriggers } from "../notificationService";
import { sendStaffOnboardingCompleteOwnerEmail } from "../services/resendService";
import { stripeService } from "./stripeService";
import { transitionAppointmentState, transitionShootBookingState } from "../bookingStateMachine";
import { markHoldAsConverted } from "../availabilityService";
import { sendBookingConfirmationPush } from "../expoPushService";
import { processInfluencerCommission, reverseInfluencerCommission } from "../influencerPayoutService";
import { calculateBookingFees } from "../fees";

function isOnReplit(): boolean {
  return !!(process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL || process.env.REPL_ID);
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

    if (!type || (!bookingId && !appointmentIdFromMetadata)) {
      // Not a booking-related PaymentIntent, ignore
      return;
    }

    console.log(`[Stripe] PaymentIntent succeeded for ${type} ${bookingId || appointmentIdFromMetadata}`);

    try {
      if (type === 'appointment_booking') {
        const appointment = await storage.getAppointment(bookingId);
        if (!appointment) {
          console.error(`[Stripe] Appointment ${bookingId} not found`);
          return;
        }

        // If status is pending_payment (automatic capture) -> CONFIRMED
        // If status is pending_provider (manual capture just captured) -> CONFIRMED
        if (appointment.status === BOOKING_STATES.PENDING_PAYMENT || 
            appointment.status === BOOKING_STATES.PENDING_PROVIDER) {
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
            console.error(`[Stripe] Failed to confirm appointment ${bookingId}: ${result.error}`);
            return;
          }

          // Update appointment with payment details
          await db.update(appointments).set({
            stripePaymentIntentId: paymentIntent.id,
            updatedAt: new Date()
          }).where(eq(appointments.id, bookingId));

          // Award points
          const user = clientId ? await storage.getUser(clientId) : null;
          if (user) {
            await storage.earnPoints({
              userId: user.id,
              dollarAmountCents: paymentIntent.amount,
              transactionType: 'business_transaction',
              referenceType: 'appointment',
              referenceId: bookingId,
              description: 'Points earned from appointment booking',
            });
            await this.tryCompleteReferral(user.id, bookingId, 'appointment');
          }

          console.log(`[Stripe] Appointment ${bookingId} confirmed via PaymentIntent`);
        }
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

        // Transfer payout to photographer's connected account. vendorPayoutCents
        // was stored in PI metadata at creation time so the webhook uses the
        // exact figure computed in the create-payment-intent route — no
        // re-derivation from the booking needed.
        const vendorPayoutCents = metadata.vendorPayoutCents
          ? parseInt(metadata.vendorPayoutCents, 10)
          : 0;

        if (vendorPayoutCents > 0) {
          const booking = await storage.getShootBooking(bookingId);
          const photographer = booking ? await storage.getPhotographer(booking.photographerId) : null;

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

        // Award points
        const user = clientId ? await storage.getUser(clientId) : null;
        if (user) {
          await storage.earnPoints({
            userId: user.id,
            dollarAmountCents: paymentIntent.amount,
            transactionType: 'photographer_booking',
            referenceType: 'shoot_booking',
            referenceId: bookingId,
            description: 'Points earned from photographer booking',
          });
          await this.tryCompleteReferral(user.id, bookingId, 'shoot_booking');
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

        if (appointment.status === BOOKING_STATES.PENDING_PAYMENT ||
            appointment.status === BOOKING_STATES.PENDING_PROVIDER) {
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
            console.error(`[Stripe] Failed to confirm appointment ${appointmentId}: ${result.error}`);
            return;
          }

          await db.update(appointments).set({
            stripePaymentIntentId: paymentIntent.id,
            updatedAt: new Date()
          }).where(eq(appointments.id, appointmentId));

          console.log(`[Stripe] Appointment ${appointmentId} confirmed via platform-balance PaymentIntent`);

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

          // PLACEHOLDER SPLIT MODEL: calculateBookingFees() applies the
          // current fees.ts v2 rates (3% consumer fee / 12% booking fee),
          // NOT the real 5%/5%-with-floor booking model this flow is meant
          // to land on. Using it here only so a real transfer actually fires
          // and appointments.staffPayout gets populated with real data,
          // rather than blocking this whole payout path on the final fee
          // model being designed. Replace this call once that model exists.
          const feeBreakdown = calculateBookingFees(appointment.totalPrice);
          const vendorNetCents = feeBreakdown.vendorNetCents;

          const business = businessId ? await storage.getBusiness(businessId) : undefined;
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
        }
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
          const pendingProviderExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          
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
            
            console.log(`[Stripe] Appointment ${bookingId} awaiting provider approval (24h timeout)`);
          }
        }
      } else if (type === 'shoot_booking') {
        const booking = await storage.getShootBooking(bookingId);
        if (!booking || booking.status !== BOOKING_STATES.PENDING_PAYMENT) {
          return;
        }

        const photographer = await storage.getPhotographer(booking.photographerId);
        if (photographer && photographer.autoAcceptBookings === false) {
          const pendingProviderExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          
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
            
            console.log(`[Stripe] Shoot booking ${bookingId} awaiting provider approval (24h timeout)`);
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
        await storage.updateVendorSubscription(existing.id, {
          tierId,
          status: 'active',
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

    // Update order status to paid
    const order = await storage.getOrder(orderId);
    if (!order || order.status === 'paid') return;

    await storage.updateOrder(orderId, {
      status: 'paid',
      stripePaymentIntentId: session.payment_intent,
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
          const product = await storage.getVendorProduct(item.productId);
          if (product?.trackInventory && product.inventory !== null) {
            const newInventory = Math.max(0, (product.inventory ?? 0) - item.quantity);
            await storage.updateVendorProduct(item.productId, { inventory: newInventory });
            console.log(`[Inventory] Decremented ${item.productId}: ${product.inventory} → ${newInventory} (ordered: ${item.quantity})`);
          }
        } catch (invError) {
          console.error(`[Inventory] Failed to decrement ${item.productId}:`, invError);
        }
      }
    }

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
            const product = await storage.getVendorProduct(item.productId);
            if (product?.trackInventory && product.inventory !== null) {
              const newInventory = Math.max(0, (product.inventory ?? 0) - item.quantity);
              await storage.updateVendorProduct(item.productId, { inventory: newInventory });
              console.log(`[Inventory] Decremented ${item.productId}: ${product.inventory} → ${newInventory} (ordered: ${item.quantity})`);
            }
          } catch (invError) {
            console.error(`[Inventory] Failed to decrement ${item.productId}:`, invError);
          }
        }
      }

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
      console.log(`[Stripe] Updating photographer ${photographer.id} stripeOnboardingComplete=${isOnboardingComplete}`);
      await storage.updatePhotographer(photographer.id, {
        stripeOnboardingComplete: isOnboardingComplete,
      });
      console.log(`[Stripe] Photographer ${photographer.id} stripeOnboardingComplete updated to ${isOnboardingComplete}`);
      
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
    
    // Update staff member onboarding status (with event-ordering guard)
    if (staffMember && staffMember.stripeAccountId === accountId) {
      const incomingEventTime = new Date(eventCreatedAt * 1000);
      const lastAppliedTime = staffMember.stripeOnboardingLastEventAt;
      if (lastAppliedTime && incomingEventTime <= new Date(lastAppliedTime)) {
        console.log(`[Stripe] Ignoring stale/out-of-order account.updated for staff ${staffMember.id} — event time ${incomingEventTime.toISOString()} <= last applied ${new Date(lastAppliedTime).toISOString()}`);
      } else {
        const wasAlreadyComplete = staffMember.stripeOnboardingComplete === true;
        console.log(`[Stripe] Updating staff ${staffMember.id} (${staffMember.displayName}) stripeOnboardingComplete=${isOnboardingComplete}`);
        await storage.updateStaffMember(staffMember.id, {
          stripeOnboardingComplete: isOnboardingComplete,
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

      // Mark any associated hold as converted
      const holdId = session.metadata?.holdId;
      if (holdId) {
        try {
          await markHoldAsConverted(holdId, appointmentId, 'appointment');
        } catch (holdErr) {
          console.error(`[Stripe] Failed to convert hold ${holdId}:`, holdErr);
        }
      }

      // Award points for the booking
      const [appointment] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));

      // Send booking confirmation notification (async, non-blocking)
      if (clientId && appointment) {
        // Notify customer
        const business = await storage.getBusiness(appointment.businessId);
        NotificationTriggers.paymentSucceeded({
          userId: clientId,
          amount: appointment.totalPrice,
          referenceType: 'appointment',
          referenceId: appointmentId,
          description: `Booking confirmed at ${business?.name || 'business'}`,
        }).catch(err => console.error("[Stripe] Failed to send booking notification:", err));

        // Notify business owner
        if (business) {
          const owner = await storage.getUserByBusinessOwnerId(appointment.businessId);
          if (owner) {
            const customer = await storage.getUser(clientId);
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
              providerName: business.name,
              date: appointment.appointmentDate,
              time: appointment.appointmentTime,
              businessOwnerId: owner.id,
              customerName: customer?.name || undefined,
            }).catch(err => console.error("[ExpoPush] Appointment push error:", err));
          }
        }
      }
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

      // Mark any associated hold as converted
      const holdId = session.metadata?.holdId;
      if (holdId) {
        try {
          await markHoldAsConverted(holdId, shootBookingId, 'shoot_booking');
        } catch (holdErr) {
          console.error(`[Stripe] Failed to convert hold ${holdId}:`, holdErr);
        }
      }

      // Award points for the booking
      const [booking] = await db.select().from(shootBookings).where(eq(shootBookings.id, shootBookingId));

      // Send booking confirmation notification (async, non-blocking)
      if (clientId && booking) {
        const photographer = await storage.getPhotographer(booking.photographerId);
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
      }
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
