/**
 * "Your quote is ready" email (Quotes step 2). Legend 2026-11-04: built now, OFF until the goutsyde.com quote
 * page exists (step 5), so no email ever links to a page that isn't there. Switch on with QUOTE_EMAILS_ENABLED=true.
 * Copy: plain words, no dashes, never the fee rate; points are the Outsyde loyalty rewards program.
 */
import type { Business, Quote } from "@shared/schema";
import { formatCents, quoteAmounts } from "./quoteRules";
import { formatDateLabel, formatTimeLabel } from "../manualRequests";

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

export function quoteLink(q: Pick<Quote, "linkCode">, frontendUrl = process.env.FRONTEND_URL || "https://goutsyde.com"): string {
  return `${frontendUrl.replace(/\/+$/, "")}/q/${q.linkCode}`;
}

export function buildQuoteEmail(p: { quote: Quote; businessName: string; businessPhone: string | null; customerFirstName: string | null; link: string }): { subject: string; html: string; text: string } {
  const q = p.quote;
  const a = quoteAmounts(q.totalCents, q.depositCents ?? null);
  const biz = p.businessName.trim();
  // Step 3: date and time are optional; with none, the line is left out.
  const when = q.jobDate && q.startTime ? `${formatDateLabel(q.jobDate)} at ${formatTimeLabel(q.startTime)}` : "";
  const lines: [string, string][] = [["Total", formatCents(a.totalCents)]];
  if (q.paymentMode === "deposit") {
    lines.push(["Deposit due now", formatCents(a.depositOrTotalCents)], ["Service fee", formatCents(a.serviceFeeCents)], ["Balance, held on your card the day before", formatCents(a.balanceCents)]);
  } else {
    lines.push(["Service fee", formatCents(a.serviceFeeCents)]);
  }
  const pay = `Review and pay ${formatCents(a.payNowCents)}`;
  const hi = p.customerFirstName ? `Hi ${p.customerFirstName.trim()},` : "Hi,";
  const intro = `${biz} sent you a quote. Pay ${q.paymentMode === "deposit" ? "the deposit" : "now"} to lock in your date.`;
  const footer = `This quote is valid until it expires. You earn Outsyde loyalty rewards points on this payment.${p.businessPhone ? ` Questions? Reply in the Outsyde app or call ${biz} at ${p.businessPhone}.` : " Questions? Reply in the Outsyde app."}`;
  const subject = `Your quote from ${biz}`;
  const rows = lines.map(([l, v]) => `<tr><td style="padding:6px 0;color:#4A4843;">${escapeHtml(l)}</td><td style="padding:6px 0;text-align:right;font-weight:700;">${escapeHtml(v)}</td></tr>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#141413;">
  <div style="background:#3D1A5B;padding:24px 28px;color:#fff;"><div style="color:#E2BE4B;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">${escapeHtml(biz)}</div><div style="font-size:24px;font-weight:800;">Your quote is ready</div></div>
  <div style="padding:24px 28px;background:#fff;">
    <p>${escapeHtml(hi)}<br>${escapeHtml(intro)}</p>
    <div style="border:1px solid #E4E1D9;border-radius:10px;padding:16px 18px;">
      <div style="font-weight:800;font-size:16px;">${escapeHtml(q.title)}</div>
      <div style="color:#4A4843;font-size:14px;line-height:1.5;">${escapeHtml(when)}${q.details ? `${when ? "<br>" : ""}${escapeHtml(q.details)}` : ""}${q.extrasNote ? `<br>${escapeHtml(q.extrasNote)}` : ""}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:14px;">${rows}</table>
    </div>
    <p style="text-align:center;margin:22px 0;"><a href="${escapeHtml(p.link)}" style="background:#E2BE4B;color:#141413;padding:14px 22px;border-radius:10px;font-weight:800;text-decoration:none;display:inline-block;">${escapeHtml(pay)}</a></p>
    <p style="font-size:13px;color:#5E5B55;line-height:1.6;">${escapeHtml(footer)}</p>
  </div></div>`;
  const text = [`${hi}`, intro, "", q.title, ...(when ? [when] : []), ...(q.details ? [q.details] : []), ...(q.extrasNote ? [q.extrasNote] : []), "", ...lines.map(([l, v]) => `${l}: ${v}`), "", `${pay}: ${p.link}`, "", footer].join("\n");
  return { subject, html, text };
}

/** Sends the email only when QUOTE_EMAILS_ENABLED=true (off until step 5). Never throws into the caller. */
export async function sendQuoteEmailIfEnabled(q: Quote, business: Business): Promise<boolean> {
  if (process.env.QUOTE_EMAILS_ENABLED !== "true") return false;
  const { storage } = await import("../storage");
  const { sendAdminEmail } = await import("../emailService");
  const customer = await storage.getUser(q.customerId);
  if (!customer?.email) return false;
  const email = buildQuoteEmail({
    quote: q,
    businessName: business.name,
    businessPhone: (business as any).contactPhone ?? null,
    customerFirstName: (customer as any).firstName ?? null,
    link: quoteLink(q),
  });
  const replyTo = business.ownerId ? (await storage.getUser(business.ownerId))?.email ?? undefined : undefined;
  return sendAdminEmail({ to: customer.email, subject: email.subject, html: email.html, text: email.text, replyTo, log: { kind: "booking", label: "Quote" } });
}
