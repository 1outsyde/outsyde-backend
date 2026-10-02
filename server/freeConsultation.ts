/**
 * Free consultation bookings (vendor_services.is_free_consultation).
 *
 * A free consultation is an appointment with payment_method 'free',
 * total_price 0, no deposit, no capture method and no PaymentIntent. It is
 * created by POST /api/booking/:holdId/confirm-free and never touches Stripe.
 * Post-booking routes branch on appointment.paymentMethod === 'free' only.
 */
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { BOOKING_STATES, type Appointment, type BookingAnswer } from "@shared/schema";
import { sendTransactionReceipts } from "./stripe/webhookHandlers";
import { NotificationTriggers } from "./notificationService";
import { sendBookingConfirmationPush, sendExpoPush } from "./expoPushService";
import {
  sendFreeConsultationConfirmationToConsumer,
  sendFreeConsultationAcceptedToConsumer,
  sendFreeConsultationNotificationToVendor,
  sendFreeConsultationRequestReceivedToConsumer,
  sendFreeConsultationRequestToVendor,
  sendFreeConsultationAdminAlert,
} from "./emailService";

export const FREE_PAYMENT_METHOD = 'free';
export const FREE_CONSULTATION_CAPABILITY = 'free-consultation';

export function isFreeAppointment(appointment: { paymentMethod?: string | null } | null | undefined): boolean {
  return appointment?.paymentMethod === FREE_PAYMENT_METHOD;
}

/**
 * True when the client sent X-Outsyde-Capabilities including
 * "free-consultation". Public service lists hide free services from clients
 * that cannot book them (older app versions).
 */
export function clientSupportsFreeConsultation(req: Request): boolean {
  const raw = req.headers['x-outsyde-capabilities'];
  const value = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  return value.split(',').map(s => s.trim().toLowerCase()).includes(FREE_CONSULTATION_CAPABILITY);
}

export interface FreeAppointmentInsert {
  businessId: string;
  clientId: string;
  serviceId: string;
  holdId: string;
  appointmentDate: string;
  appointmentTime: string;
  appointmentEndTime: string;
  durationMinutes: number;
  status: typeof BOOKING_STATES.PENDING_PAYMENT | typeof BOOKING_STATES.PENDING_PROVIDER;
  pendingProviderExpiresAt: Date | null;
  customerServiceAddress: string | null;
  customerServiceCity: string | null;
  customerServiceState: string | null;
  customerServiceZipCode: string | null;
  serviceName: string;
  serviceDurationMinutes: number;
  serviceFullRefundWindow: string | null;
  serviceHasPartialRefund: boolean | null;
  servicePartialRefundWindow: string | null;
  servicePartialRefundPercentage: number | null;
  serviceHasCancellationFee: boolean | null;
  serviceCancellationFeeType: string | null;
  serviceCancellationFeeAmount: number | null;
  bookingAnswers: BookingAnswer[];
}

/**
 * Insert a free appointment unless the client already has an open free
 * consultation with this business: one conditional INSERT … WHERE NOT EXISTS
 * over (client_id, business_id, payment_method 'free', status pending_payment
 * / pending_provider / confirmed, appointment_date >= yesterday UTC).
 *
 * Returns the new appointment, or null when the limit blocked the insert.
 * Money columns are fixed: total_price 0, platform_fee 0, vendor_net 0,
 * deposit null, capture_method null.
 */
export async function insertFreeAppointmentIfAllowed(data: FreeAppointmentInsert): Promise<Appointment | null> {
  const id = randomUUID();
  const result = await db.execute(sql`
    INSERT INTO appointments (
      id, business_id, client_id, service_id, hold_id,
      appointment_date, appointment_time, appointment_end_time, duration_minutes,
      total_price, platform_fee, vendor_net, status, payment_method, capture_method,
      pending_provider_expires_at,
      customer_service_address, customer_service_city, customer_service_state, customer_service_zip_code,
      service_name, service_price_cents, service_duration_minutes,
      service_full_refund_window, service_has_partial_refund, service_partial_refund_window,
      service_partial_refund_percentage, service_has_cancellation_fee, service_cancellation_fee_type,
      service_cancellation_fee_amount, deposit_amount_cents, booking_answers
    )
    SELECT
      ${id}, ${data.businessId}, ${data.clientId}, ${data.serviceId}, ${data.holdId},
      ${data.appointmentDate}, ${data.appointmentTime}, ${data.appointmentEndTime}, ${data.durationMinutes}::integer,
      0, 0, 0, ${data.status}, ${FREE_PAYMENT_METHOD}, NULL,
      ${data.pendingProviderExpiresAt ? data.pendingProviderExpiresAt.toISOString() : null}::timestamp,
      ${data.customerServiceAddress}, ${data.customerServiceCity}, ${data.customerServiceState}, ${data.customerServiceZipCode},
      ${data.serviceName}, 0, ${data.serviceDurationMinutes}::integer,
      ${data.serviceFullRefundWindow}, ${data.serviceHasPartialRefund}::boolean, ${data.servicePartialRefundWindow},
      ${data.servicePartialRefundPercentage}::integer, ${data.serviceHasCancellationFee}::boolean, ${data.serviceCancellationFeeType},
      ${data.serviceCancellationFeeAmount}::integer, NULL, ${JSON.stringify(data.bookingAnswers)}::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM appointments
      WHERE client_id = ${data.clientId}
        AND business_id = ${data.businessId}
        AND payment_method = ${FREE_PAYMENT_METHOD}
        AND status IN (${BOOKING_STATES.PENDING_PAYMENT}, ${BOOKING_STATES.PENDING_PROVIDER}, ${BOOKING_STATES.CONFIRMED})
        AND appointment_date >= to_char((now() AT TIME ZONE 'UTC')::date - 1, 'YYYY-MM-DD')
    )
    RETURNING id
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? [];
  if (rows.length === 0) return null;
  return (await storage.getAppointment(id)) ?? null;
}

async function loadParties(appointment: Appointment) {
  const [business, owner, customer] = await Promise.all([
    storage.getBusiness(appointment.businessId).catch(() => undefined),
    storage.getUserByBusinessOwnerId(appointment.businessId).catch(() => undefined),
    storage.getUser(appointment.clientId).catch(() => undefined),
  ]);
  return { business, owner, customer };
}

/**
 * Receipts for a confirmed free consultation: consumer, vendor, admin. Same
 * single-sender rule as sendAppointmentReceipts: call only from the path that
 * performed the transition to confirmed. `accepted` picks the consumer's
 * "accepted" email (manual flow) instead of "confirmed".
 */
export async function sendFreeConsultationReceipts(
  appointmentId: string,
  opts: { txnType: string; accepted?: boolean },
): Promise<void> {
  const appointment = await storage.getAppointment(appointmentId).catch(() => undefined);
  if (!appointment) {
    console.error(`[Receipt] ${opts.txnType} ${appointmentId} SKIPPED: appointment not found`);
    return;
  }
  const { business, owner, customer } = await loadParties(appointment);
  const vendorName = business?.name || 'Business';
  const consumerName = customer?.name || customer?.email || 'Customer';
  const base = {
    vendorName,
    consumerName,
    serviceName: appointment.serviceName || 'Consultation',
    bookingId: appointmentId,
    bookingNumber: appointment.bookingNumber,
    date: appointment.appointmentDate,
    time: appointment.appointmentTime,
    answers: appointment.bookingAnswers,
  };

  await sendTransactionReceipts(opts.txnType, appointmentId, {
    consumer: {
      email: customer?.email,
      send: () => opts.accepted
        ? sendFreeConsultationAcceptedToConsumer({ ...base, toEmail: customer!.email! })
        : sendFreeConsultationConfirmationToConsumer({ ...base, toEmail: customer!.email!, vendorContactEmail: business?.contactEmail ?? undefined }),
    },
    vendor: {
      email: owner?.email,
      send: () => sendFreeConsultationNotificationToVendor({ ...base, toEmail: owner!.email!, consumerUsername: customer?.username ?? undefined }),
    },
    admin: () => sendFreeConsultationAdminAlert({
      type: opts.accepted ? 'accepted' : 'confirmed',
      bookingId: appointmentId,
      businessName: vendorName,
      customerName: consumerName,
      customerEmail: customer?.email || '',
      vendorEmail: owner?.email || '',
      serviceName: base.serviceName,
      date: base.date,
      time: base.time,
      answers: base.answers,
    }),
  });
}

/** In-app + push for a confirmed free consultation (best-effort). */
export async function notifyFreeConsultationConfirmed(appointmentId: string): Promise<void> {
  const appointment = await storage.getAppointment(appointmentId).catch(() => undefined);
  if (!appointment) return;
  const { business, owner, customer } = await loadParties(appointment);
  try {
    await NotificationTriggers.freeConsultationConfirmed({
      customerId: appointment.clientId,
      ownerUserId: owner?.id,
      appointmentId,
      businessName: business?.name || 'business',
      serviceName: appointment.serviceName || 'Consultation',
      date: appointment.appointmentDate,
      time: appointment.appointmentTime,
      customerName: customer?.name,
    });
  } catch (err) {
    console.error(`[Notify:free] in-app notification failed for appointment ${appointmentId}:`, err);
  }
  sendBookingConfirmationPush({
    customerId: appointment.clientId,
    providerName: business?.name || 'business',
    date: appointment.appointmentDate,
    time: appointment.appointmentTime,
    businessOwnerId: owner?.id,
    customerName: customer?.name || undefined,
  }).catch(err => console.error(`[Notify:free] push failed for appointment ${appointmentId}:`, err));
}

/**
 * Manual-accept free consultation request: vendor (push + email), consumer
 * (request received), admin. Replaces notifyPendingBookingRequest for free
 * bookings, whose copy talks about card authorizations and payouts.
 */
export async function notifyFreeConsultationRequest(appointmentId: string): Promise<void> {
  const appointment = await storage.getAppointment(appointmentId).catch(() => undefined);
  if (!appointment) return;
  const { business, owner, customer } = await loadParties(appointment);
  const vendorName = business?.name || 'Business';
  const consumerName = customer?.name || customer?.email || 'Customer';
  const expiresAt = appointment.pendingProviderExpiresAt ? new Date(appointment.pendingProviderExpiresAt) : new Date();
  const base = {
    vendorName,
    consumerName,
    serviceName: appointment.serviceName || 'Consultation',
    bookingId: appointmentId,
    bookingNumber: appointment.bookingNumber,
    date: appointment.appointmentDate,
    time: appointment.appointmentTime,
    answers: appointment.bookingAnswers,
    expiresAt,
  };

  if (owner) {
    sendExpoPush({
      userId: owner.id,
      title: 'New Consultation Request',
      body: `${consumerName} requested a free consultation (${base.serviceName}) on ${base.date} at ${base.time}`,
      data: { type: 'booking_request', screen: 'dashboard' },
    }).catch(() => {});
  }

  await sendTransactionReceipts('free_request', appointmentId, {
    consumer: {
      email: customer?.email,
      send: () => sendFreeConsultationRequestReceivedToConsumer({ ...base, toEmail: customer!.email! }),
    },
    vendor: {
      email: owner?.email,
      send: () => sendFreeConsultationRequestToVendor({ ...base, toEmail: owner!.email!, consumerUsername: customer?.username ?? undefined }),
    },
    admin: () => sendFreeConsultationAdminAlert({
      type: 'requested',
      bookingId: appointmentId,
      businessName: vendorName,
      customerName: consumerName,
      customerEmail: customer?.email || '',
      vendorEmail: owner?.email || '',
      serviceName: base.serviceName,
      date: base.date,
      time: base.time,
      answers: base.answers,
    }),
  });
}

/** True when the hold's service is a free consultation vendor service. */
export async function holdIsFreeConsultation(hold: { serviceId: string | null }): Promise<boolean> {
  if (!hold.serviceId) return false;
  const service = await storage.getVendorService(hold.serviceId);
  return service?.isFreeConsultation === true;
}

/** 400 body for the payment routes when the hold is a free consultation. */
export const FREE_CONSULTATION_PAYMENT_ERROR = {
  error: "This service is a free consultation and needs no payment.",
  message: "This service is a free consultation. Book it with POST /api/booking/:holdId/confirm-free.",
  code: "FREE_CONSULTATION",
} as const;
