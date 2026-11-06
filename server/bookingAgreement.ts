// Booking redesign step 3 (Legend 2026-11-06): record that the customer agreed
// to the cancellation policy, the vendor's terms and the Outsyde Terms before
// paying. Optional: old app builds and vendor sites don't send it, and a
// payment without it works exactly as before. Saved once; a retry of the same
// hold never overwrites the first agreement.
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { appointments, shootBookings } from "@shared/schema";

/** Version of the Outsyde Terms shown in the app ("Last Updated: November 2026"). */
export const OUTSYDE_TERMS_VERSION = "2026-11";

/** Longest vendor terms copy kept (the vendor's own text, not trusted from the client). */
export const MAX_VENDOR_TERMS_COPY = 20000;

export type BookingAgreement = { termsVersion: string };

/** `{ agreement: { agreed: true, termsVersion?: "YYYY-MM" } }` → agreement, else null. */
export function parseBookingAgreement(body: unknown): BookingAgreement | null {
  const a = (body as { agreement?: unknown } | null | undefined)?.agreement as
    | { agreed?: unknown; termsVersion?: unknown }
    | null
    | undefined;
  if (!a || typeof a !== "object" || a.agreed !== true) return null;
  const v = a.termsVersion;
  return {
    termsVersion: typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? v : OUTSYDE_TERMS_VERSION,
  };
}

/** The vendor's terms as they read now, or null when there are none. */
export function vendorTermsCopy(terms: string | null | undefined): string | null {
  const t = (terms ?? "").trim();
  return t ? t.slice(0, MAX_VENDOR_TERMS_COPY) : null;
}

/**
 * Save the agreement on the booking when it has none yet. Never throws: a
 * failure is logged and the payment goes on (the agreement is a record, not a gate).
 * Returns true when a row was updated.
 */
export async function recordBookingAgreement(
  kind: "appointment" | "shoot_booking",
  bookingId: string,
  agreement: BookingAgreement | null,
  vendorTerms: string | null | undefined,
): Promise<boolean> {
  if (!agreement) return false;
  const values = {
    customerAgreedAt: new Date(),
    customerAgreedTermsVersion: agreement.termsVersion,
    customerAgreedVendorTerms: vendorTermsCopy(vendorTerms),
  };
  try {
    if (kind === "appointment") {
      const rows = await db.update(appointments).set(values)
        .where(and(eq(appointments.id, bookingId), isNull(appointments.customerAgreedAt)))
        .returning({ id: appointments.id });
      return rows.length > 0;
    }
    const rows = await db.update(shootBookings).set(values)
      .where(and(eq(shootBookings.id, bookingId), isNull(shootBookings.customerAgreedAt)))
      .returning({ id: shootBookings.id });
    return rows.length > 0;
  } catch (e) {
    console.error(`[Booking] could not save agreement on ${kind} ${bookingId}:`, e);
    return false;
  }
}
