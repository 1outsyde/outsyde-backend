/**
 * READ-ONLY report of appointments stuck in `pending_payment`.
 *
 * For each one, looks up its PaymentIntent on the Stripe account configured
 * by STRIPE_SECRET_KEY and prints what actually happened to the payment.
 * This script never writes to the database, never calls the webhook handler
 * and never sends email. There is intentionally no --apply mode: deciding
 * what to confirm, refund or delete is a separate, manual step.
 *
 *   npx tsx scripts/reportStuckAppointments.ts
 */
import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { appointments, businesses, users, BOOKING_STATES } from "@shared/schema";
import { getUncachableStripeClient } from "../server/stripe/stripeClient";

// Braids With Love — all bookings/revenue are test data pending cleanup.
const TEST_DATA_BUSINESS_IDS = new Set(["f94ae1a2-2ecd-40dc-8d81-4a8dfdfb0a8d"]);

function money(cents: number | null | undefined): string {
  return cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;
}

async function main() {
  const stripe = await getUncachableStripeClient();
  const account = await stripe.accounts.retrieve();
  const keyMode = (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live") ? "live" : "test";
  const accountLabel = `${account.id} (${keyMode} key)`;

  const rows = await db
    .select({
      id: appointments.id,
      bookingNumber: appointments.bookingNumber,
      businessId: appointments.businessId,
      businessName: businesses.name,
      customerName: users.name,
      customerEmail: users.email,
      totalPrice: appointments.totalPrice,
      depositAmountCents: appointments.depositAmountCents,
      paymentIntentId: appointments.stripePaymentIntentId,
      createdAt: appointments.createdAt,
    })
    .from(appointments)
    .leftJoin(businesses, eq(businesses.id, appointments.businessId))
    .leftJoin(users, eq(users.id, appointments.clientId))
    .where(eq(appointments.status, BOOKING_STATES.PENDING_PAYMENT));

  rows.sort((a, b) => b.bookingNumber - a.bookingNumber);

  console.log(`Stripe account queried: ${accountLabel}`);
  console.log(`Appointments in pending_payment: ${rows.length}\n`);

  const realCharges: string[] = [];

  for (const r of rows) {
    const ref = `#A${String(r.bookingNumber).padStart(4, "0")}`;
    const tag = TEST_DATA_BUSINESS_IDS.has(r.businessId) ? "  [TEST DATA — do not confirm/email]" : "";

    let piStatus = "no PaymentIntent";
    let piAmount: number | null = null;
    let livemode: boolean | null = null;

    if (r.paymentIntentId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(r.paymentIntentId);
        piStatus = pi.status;
        piAmount = pi.amount;
        livemode = pi.livemode;
      } catch (err: any) {
        piStatus = err?.code === "resource_missing"
          ? `NOT FOUND on ${account.id}`
          : `lookup error: ${err?.message ?? err}`;
      }
    }

    const line = [
      `${ref}${tag}`,
      `  business:  ${r.businessName ?? "?"} (${r.businessId})`,
      `  customer:  ${r.customerName ?? "?"} <${r.customerEmail ?? "?"}>`,
      `  amount:    service ${money(r.totalPrice)} · deposit ${money(r.depositAmountCents)} · PI ${money(piAmount)}`,
      `  PI:        ${r.paymentIntentId ?? "—"}`,
      `  stripe:    status=${piStatus} livemode=${livemode ?? "—"} account=${accountLabel}`,
      `  created:   ${r.createdAt?.toISOString?.() ?? r.createdAt}`,
    ].join("\n");
    console.log(line + "\n");

    if (piStatus === "succeeded" && livemode === true) {
      realCharges.push(`${ref}  ${r.businessName ?? "?"}  ${money(piAmount)}  ${r.paymentIntentId}${tag}`);
    }
  }

  console.log("⚠ REAL CHARGES (succeeded + livemode=true) — may need refunds:");
  if (realCharges.length === 0) {
    console.log("  none");
  } else {
    for (const c of realCharges) console.log(`  ${c}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
