/**
 * Quotes step 5a (goutsyde.com support). Pure rules: no database, no network.
 * Legend 2026-11-05 (step 5 calls 1 to 3):
 *   - A quote link opened signed out shows a preview (business look, title, date, price) and Sign in to pay. Nothing
 *     about the customer, the chat or the link. Only the customer it was sent to can act; another account sees no
 *     details.
 *   - Every unread note in a quote chat is also emailed to the other side (the vendor may have push off, a web
 *     customer has no push), at most one email per chat and person every 10 minutes, with all the new notes in it.
 */
import type { Business, Quote } from "@shared/schema";
import { effectiveStatus, quoteAmounts } from "./quoteRules";

export const NOTE_EMAIL_EVERY_MINUTES = 10;
/** A note is emailed once it has sat unread this long (the app or the page may show it first). */
export const NOTE_EMAIL_DELAY_MINUTES = 2;
const MAX_NOTES_IN_EMAIL = 5;
const MAX_NOTE_CHARS = 500;

/** The business's look, as the quote page shows it (step 5 call 4). */
export function businessLookJson(b: Pick<Business, "id" | "name" | "logoImage" | "coverImage" | "brandColors">) {
  return { id: b.id, name: b.name?.trim() ?? null, logoImage: b.logoImage ?? null, coverImage: b.coverImage ?? null, brandColors: b.brandColors ?? null };
}

/** What a signed out visitor sees (call 1). */
export function quotePreviewJson(q: Quote, b: Pick<Business, "id" | "name" | "logoImage" | "coverImage" | "brandColors">, now = new Date()) {
  return {
    status: effectiveStatus(q, now),
    kind: q.kind,
    title: q.title,
    jobDate: q.jobDate,
    startTime: q.startTime,
    durationMinutes: q.durationMinutes,
    timeZone: q.timeZone,
    dueDate: q.dueDate ?? null,
    totalCents: q.totalCents,
    paymentMode: q.paymentMode,
    depositCents: q.depositCents ?? null,
    restPaid: q.restPaid ?? "outsyde",
    amounts: quoteAmounts(q.totalCents, q.depositCents ?? null, q.restPaid ?? "outsyde"),
    expiresAt: q.expiresAt,
    business: businessLookJson(b),
  };
}

export function noteEmailDue(lastSentAt: Date | null, now: Date): boolean {
  return !lastSentAt || now.getTime() - lastSentAt.getTime() >= NOTE_EMAIL_EVERY_MINUTES * 60_000;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
const shorten = (t: string) => (t.length > MAX_NOTE_CHARS ? `${t.slice(0, MAX_NOTE_CHARS).trimEnd()}...` : t);

/** The note email. Copy: commas and periods, never the fee rate. */
export function buildNoteEmail(p: { recipientFirstName: string | null; senderName: string; title: string; notes: string[]; link: string }): { subject: string; html: string; text: string } {
  const sender = p.senderName.trim() || "Someone";
  const title = p.title.trim();
  const shown = p.notes.slice(0, MAX_NOTES_IN_EMAIL).map((n) => shorten(n.trim()));
  const more = p.notes.length - shown.length;
  const hi = p.recipientFirstName ? `Hi ${p.recipientFirstName.trim()},` : "Hi,";
  const intro = `${sender} sent you ${p.notes.length === 1 ? "a note" : "notes"} about ${title}.`;
  const moreLine = more > 0 ? `And ${more} more in the chat.` : "";
  const cta = "Open the quote";
  const footer = "Reply on the quote page or in the Outsyde app.";
  const subject = `New note from ${sender} about ${title}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#141413;">
  <div style="background:#3D1A5B;padding:22px 28px;color:#fff;"><div style="font-size:22px;font-weight:800;">New note</div></div>
  <div style="padding:22px 28px;background:#fff;">
    <p>${escapeHtml(hi)}<br>${escapeHtml(intro)}</p>
    ${shown.map((n) => `<div style="border-left:3px solid #E2BE4B;background:#F7F5F0;padding:10px 14px;margin:8px 0;white-space:pre-wrap;">${escapeHtml(n)}</div>`).join("")}
    ${moreLine ? `<p style="color:#5E5B55;">${escapeHtml(moreLine)}</p>` : ""}
    <p style="text-align:center;margin:22px 0;"><a href="${escapeHtml(p.link)}" style="background:#E2BE4B;color:#141413;padding:12px 20px;border-radius:10px;font-weight:800;text-decoration:none;display:inline-block;">${escapeHtml(cta)}</a></p>
    <p style="font-size:13px;color:#5E5B55;">${escapeHtml(footer)}</p>
  </div></div>`;
  const text = [hi, intro, "", ...shown.flatMap((n) => [n, ""]), ...(moreLine ? [moreLine, ""] : []), `${cta}: ${p.link}`, "", footer].join("\n");
  return { subject, html, text };
}
