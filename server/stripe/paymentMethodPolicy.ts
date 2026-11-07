/**
 * Which payment methods a PaymentIntent may offer (app payment methods, Step 1).
 *
 * Redirect methods (Klarna, Afterpay, Cash App Pay, Amazon Pay) send the customer to the provider's page and
 * back, so they need a client that can handle the return. Only the new app build says it can, with
 * `redirectCapable: true` in the request body. Everyone else (app builds already in the App Store,
 * goutsyde.com, every vendor site) keeps exactly today's settings.
 *
 * Bookings and service quotes never pass the switch: they keep card, Apple Pay and Google Pay so the card
 * on file can pay a cancellation or no-show fee.
 */

export interface AutomaticPaymentMethods {
  enabled: true;
  allow_redirects?: "never";
}

/** Stripe's `automatic_payment_methods`. Off = today's `allow_redirects: 'never'`. */
export function automaticPaymentMethods(redirectMethods: boolean): AutomaticPaymentMethods {
  return redirectMethods ? { enabled: true } : { enabled: true, allow_redirects: "never" };
}

/** True only when the request body carries the boolean `redirectCapable: true`. */
export function wantsRedirects(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { redirectCapable?: unknown }).redirectCapable === true;
}
