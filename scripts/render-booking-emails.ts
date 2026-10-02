/**
 * Golden render of every pre-existing email in server/emailService.ts.
 *
 * Calls each email function with fixed parameters (several variants where a
 * function branches), captures what would be sent to Resend, and prints it as
 * JSON. Nothing is sent: fetch is stubbed. The clock and timezone are fixed.
 *
 * Run it on two checkouts and diff the output to prove the emails did not
 * change byte-for-byte:
 *
 *   TZ=UTC RESEND_API_KEY=re_test npx tsx scripts/render-booking-emails.ts > /tmp/branch.json
 *   (in a main checkout) same command > /tmp/main.json
 *   cmp /tmp/main.json /tmp/branch.json
 */
const FIXED_NOW = Date.UTC(2026, 9, 2, 15, 30, 0);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...(args as [any]));
  }
  static now() { return FIXED_NOW; }
}
(globalThis as any).Date = FixedDate;

process.env.RESEND_API_KEY ||= "re_test";
process.env.ADMIN_NOTIFICATION_EMAIL ||= "admin@example.com";

interface Captured { label: string; from?: string; to?: string; subject?: string; html?: string; text?: string; error?: string }
const captured: Captured[] = [];
let currentLabel = "";
globalThis.fetch = (async (input: any, init?: any) => {
  const body = JSON.parse(init?.body ?? "{}");
  captured.push({ label: currentLabel, from: body.from, to: Array.isArray(body.to) ? body.to.join(",") : body.to, subject: body.subject, html: body.html, text: body.text });
  return new Response(JSON.stringify({ id: "email_fixed" }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const quiet = () => {};
console.log = quiet;
console.error = quiet;
console.warn = quiet;

const expiresAt = new RealDate(Date.UTC(2026, 9, 4, 18, 0, 0));

// Superset of the fields the email functions read.
const base: Record<string, any> = {
  toEmail: "customer@example.com",
  to: "admin@example.com",
  subject: "Fixed subject",
  html: "<p>fixed</p>",
  text: "fixed",
  consumerName: "Ada <Lovelace> & Co",
  consumerUsername: "ada",
  consumerDisplayName: "Ada L.",
  consumerEmail: "customer@example.com",
  customerName: "Ada Lovelace",
  customerEmail: "customer@example.com",
  vendorName: "Braids & Co",
  vendorEmail: "vendor@example.com",
  vendorContactEmail: "contact@braids.example.com",
  businessName: "Braids & Co",
  photographerName: "Pat Photo",
  photographerContactEmail: "pat@example.com",
  displayName: "Pat Photo",
  name: "Pat Photo",
  email: "pat@example.com",
  userId: "user-1",
  businessId: "biz-1",
  photographerId: "ph-1",
  applicationId: "app-1",
  serviceName: "Knotless braids",
  shootType: "Portrait",
  bookingId: "booking-1",
  bookingNumber: 42,
  appointmentId: "appt-1",
  orderId: "order-1",
  orderNumber: 1001,
  bookingOrOrderId: "booking-1",
  date: "2026-10-10",
  time: "14:00",
  appointmentDate: "2026-10-10",
  appointmentTime: "14:00",
  location: "1 Main St, Albany NY",
  basePrice: 27500,
  totalPrice: 27500,
  amount: "$297.00",
  amountCents: 29700,
  refundAmountCents: 12500,
  feeAmountCents: 500,
  expiresAt,
  reason: "Schedule conflict",
  windowLabel: "24h",
  loyaltyPointsEarned: 250,
  trackingNumber: "1Z999",
  carrier: "UPS",
  trackingUrl: "https://track.example.com/1Z999",
  items: [{ productName: "Tea", name: "Tea", quantity: 2, basePrice: 1000, price: 1000 }],
  shippingAddress: { line1: "1 Main St", city: "Albany", state: "NY", zipCode: "12207", postalCode: "12207" },
  eventType: "appointment_booking",
  type: "new_pending",
  depositAmount: 3000,
  depositCents: 3000,
  balanceDue: 24500,
  reasons: ["Incomplete profile"],
  rejectionReason: "Incomplete profile",
  dashboardUrl: "https://goutsyde.com/vendor",
  cancellationType: "appointment",
  canceledBy: "consumer",
};

const variants: Record<string, Record<string, any>[]> = {
  sendAppointmentConfirmationToConsumer: [{}, { depositAmountCents: 3000, remainderDueCents: 24500 }],
  sendAppointmentNotificationToVendor: [{}, { depositAmountCents: 3000, remainderDueCents: 24500 }],
  sendShootBookingConfirmationToConsumer: [{}, { depositAmountCents: 3000, remainderDueCents: 12000 }],
  sendShootBookingNotificationToPhotographer: [{}, { depositAmountCents: 3000, remainderDueCents: 12000 }],
  sendBookingDeclinedToConsumer: [{}, { expired: true }, { reason: undefined }],
  sendAdminBookingAlert: [{ type: "new_pending" }, { type: "accepted" }, { type: "declined" }],
  sendInternalEventAlert: [
    { eventType: "appointment_booking", paymentType: "full", amountChargedCents: 27500, stripeChargeCents: 29700 },
    { eventType: "appointment_booking", paymentType: "deposit", amountChargedCents: 3000, serviceTotalCents: 27500, stripeChargeCents: 3240 },
    { eventType: "shoot_booking" },
    { eventType: "product_order", basePrice: undefined },
  ],
  sendAppointmentReminderEmail: [{ windowLabel: "24h" }, { windowLabel: "2h" }],
  sendAftercareEmail: [{}, { loyaltyPointsEarned: undefined }],
  sendCancellationAdminEmail: [
    { adminEmail: "admin@example.com", eventType: "appointment_canceled", providerName: "Braids & Co", referenceId: "appt-1", amountCents: 0 },
    { adminEmail: "admin@example.com", eventType: "appointment_refunded", providerName: "Braids & Co", referenceId: "appt-1", amountCents: 12500 },
  ],
  sendNewBookingAlertToVendor: [
    { vendorOwnerEmail: "vendor@example.com", depositAmountCents: 3000 },
    { vendorOwnerEmail: "vendor@example.com", depositAmountCents: undefined, fromAddress: "XO <bookings@xo.example.com>" },
  ],
};

// Every email function exported on main (7393def). New functions are not listed.
const FUNCTIONS = [
  "sendAdminEmail", "sendNewConsumerSignupEmail", "sendNewVendorApplicationEmail", "sendNewPhotographerApplicationEmail",
  "sendVendorApprovalEmail", "sendVendorRejectionEmail", "sendAppointmentConfirmationToConsumer", "sendAppointmentNotificationToVendor",
  "sendShootBookingConfirmationToConsumer", "sendShootBookingNotificationToPhotographer", "sendShootBookingAcceptedToPhotographer",
  "sendShootBookingDeclinedToPhotographer", "sendShootBookingCanceledToPhotographer", "sendShootBookingExpiredToPhotographer",
  "sendPhotographerWelcomeEmail", "sendOrderConfirmationToConsumer", "sendOrderNotificationToVendor", "sendInternalEventAlert",
  "sendOrderShippedEmail", "sendCancellationAdminEmail", "sendBookingRequestReceivedToConsumer", "sendBookingRequestToVendor",
  "sendBookingAcceptedToConsumer", "sendBookingDeclinedToConsumer", "sendAdminBookingAlert", "sendAppointmentReminderEmail",
  "sendAftercareEmail", "sendBookingConfirmationToCustomer", "sendNewBookingAlertToVendor", "sendOrderDeliveredEmail",
  "sendOrderDeliveredVendorEmail",
];

async function main() {
  const mod: Record<string, any> = await import("../server/emailService");
  for (const name of FUNCTIONS) {
    const fn = mod[name];
    if (typeof fn !== "function") {
      captured.push({ label: name, error: "missing export" });
      continue;
    }
    for (const [i, v] of (variants[name] ?? [{}]).entries()) {
      currentLabel = `${name}#${i}`;
      const before = captured.length;
      try {
        if (name === "sendPhotographerWelcomeEmail") await fn("pat@example.com", "Pat <Photo>");
        else await fn({ ...base, ...v });
      } catch (err: any) {
        captured.push({ label: currentLabel, error: String(err?.message ?? err) });
      }
      if (captured.length === before) captured.push({ label: currentLabel, error: "nothing sent" });
    }
  }
  process.stdout.write(JSON.stringify(captured, null, 2) + "\n");
}

main().then(() => process.exit(0));
