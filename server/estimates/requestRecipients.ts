/**
 * Extra people who get every estimate request email for a business (migration 111, Royal Elite step 4, 2026-11-10).
 * The owner's login email and ADMIN_NOTIFICATION_EMAIL always get a copy, so they are never stored here.
 * Stored in businesses.request_notify_emails, private (never in toPublicBusinessDTO).
 */

export const MAX_REQUEST_RECIPIENTS = 5;
const MAX_EMAIL_LENGTH = 254;
// Something@something.tld with no spaces: enough to catch typos; Resend rejects anything it can't deliver.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const key = (email: string) => email.trim().toLowerCase();

/** Owner input to the list we store, or a message saying what to fix. */
export function cleanRecipients(
  input: unknown,
  ownerEmail: string | null | undefined,
  adminEmail: string,
): { emails: string[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'Send a list of emails.' };
  const skip = new Set([ownerEmail ? key(ownerEmail) : '', key(adminEmail)]);
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') return { error: 'Send a list of emails.' };
    const email = key(item);
    if (!email) continue;
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) return { error: `"${item.trim()}" is not an email address.` };
    if (skip.has(email) || out.includes(email)) continue;
    out.push(email);
  }
  if (out.length > MAX_REQUEST_RECIPIENTS) return { error: `You can add up to ${MAX_REQUEST_RECIPIENTS} emails.` };
  return { emails: out };
}

/** Who else to email for one request: the saved list minus the owner and Outsyde (they already get a copy). */
export function extraRecipientsFor(
  saved: string[] | null | undefined,
  ownerEmail: string | null | undefined,
  adminEmail: string,
): string[] {
  const skip = new Set([ownerEmail ? key(ownerEmail) : '', key(adminEmail)]);
  const out: string[] = [];
  for (const e of saved ?? []) {
    const k = key(e);
    if (k && !skip.has(k) && !out.includes(k)) out.push(k);
  }
  return out.slice(0, MAX_REQUEST_RECIPIENTS);
}
