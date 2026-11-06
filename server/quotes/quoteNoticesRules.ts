/**
 * Quotes step 6a (no migration): the words for the extra's push, Activity row and email, the business's Activity
 * rows, and the list of what is waiting on the customer (the app's pop-up). Pure, no database.
 *
 * Legend 2026-11-05 (step 6 calls 2 to 6, all as recommended):
 *   - 2: the extra's push stays a message push (every app version opens the chat) with its own words.
 *   - 3: the extra is emailed at once (the job is happening now), off until QUOTE_EMAILS_ENABLED=true.
 *   - 4: a real Activity row (type quote_extra), done once the customer answers.
 *   - 5: the pop-up covers every thing waiting on the customer.
 *   - 6: the business gets Activity rows for paid, extra approved or declined, report and card failed; a push only
 *        where no chat card already pushed them (card failed).
 * Copy rules: commas and periods, no dashes, never the fee rate.
 */
import { formatCents } from "./quoteRules";

/** Longer than a normal message preview (50): the push has to say what and how much. */
export const PUSH_BODY_MAX = 178;

/** A push body: spaces tidied, cut at PUSH_BODY_MAX with an ellipsis. */
export function pushPreview(text: string): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length <= PUSH_BODY_MAX ? t : t.substring(0, PUSH_BODY_MAX - 3).trimEnd() + "...";
}

export function extraPushText(o: { description: string; totalCents: number }): string {
  return `Needs your OK: ${o.description.trim()}, ${formatCents(o.totalCents)} with the service fee. Nothing is charged unless you approve.`;
}

export function extraActivityText(o: { businessName: string; title: string; description: string; totalCents: number }): { title: string; message: string } {
  return {
    title: o.businessName.trim() || "The business",
    message: `Added ${o.description.trim()} to ${o.title.trim()}. ${formatCents(o.totalCents)} with the service fee, only if you approve.`,
  };
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** totalBeforeCents: the quote total plus extras already approved (what it stays if they decline). */
export function buildExtraEmail(p: {
  customerFirstName: string | null; businessName: string; title: string; description: string;
  amountCents: number; serviceFeeCents: number; totalBeforeCents: number; link: string;
}): { subject: string; html: string; text: string } {
  const name = p.businessName.trim() || "The business";
  const title = p.title.trim();
  const d = p.description.trim();
  const hi = p.customerFirstName?.trim() ? `Hi ${p.customerFirstName.trim()},` : "Hi,";
  const intro = `${name} asked to add something to ${title}. Nothing is charged unless you approve it.`;
  const rows: [string, string][] = [
    [d, formatCents(p.amountCents)],
    ["Service fee", formatCents(p.serviceFeeCents)],
    ["You approve", formatCents(p.amountCents + p.serviceFeeCents)],
    ["New total", formatCents(p.totalBeforeCents + p.amountCents)],
  ];
  const decline = `If you decline, your total stays ${formatCents(p.totalBeforeCents)}. You can also ask ${name} a question in your chat.`;
  const when = "Approved extras are charged when the job is complete.";
  const cta = "Review and approve";
  const subject = `${name} needs your OK for ${d}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#141413;">
  <div style="background:#3D1A5B;padding:22px 28px;color:#fff;"><div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#E2BE4B;font-weight:800;">Needs your OK</div><div style="font-size:22px;font-weight:800;">${escapeHtml(`${name} added to ${title}`)}</div></div>
  <div style="padding:22px 28px;background:#fff;">
    <p>${escapeHtml(hi)}<br>${escapeHtml(intro)}</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #ECEAE4;border-radius:10px;">
      ${rows.map(([k, v], i) => `<tr><td style="padding:9px 14px;${i === 2 ? "font-weight:800;" : ""}">${escapeHtml(k)}</td><td style="padding:9px 14px;text-align:right;${i === 2 ? "font-weight:800;" : ""}">${escapeHtml(v)}</td></tr>`).join("")}
    </table>
    <p style="text-align:center;margin:22px 0;"><a href="${escapeHtml(p.link)}" style="background:#E2BE4B;color:#141413;padding:12px 20px;border-radius:10px;font-weight:800;text-decoration:none;display:inline-block;">${escapeHtml(cta)}</a></p>
    <p style="font-size:13px;color:#5E5B55;">${escapeHtml(decline)}</p>
    <p style="font-size:13px;color:#5E5B55;">${escapeHtml(when)}</p>
  </div></div>`;
  const text = [hi, intro, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `${cta}: ${p.link}`, "", decline, when].join("\n");
  return { subject, html, text };
}

export type BusinessNoticeKind = "paid" | "extra_approved" | "extra_declined" | "problem_reported" | "card_failed";

/** The business's Activity row. push: only where no chat card already pushed them. */
export function businessNotice(kind: BusinessNoticeKind, o: { customerName: string; title: string; description?: string; amountCents: number }): { type: string; title: string; message: string; push: boolean } {
  const who = o.customerName.trim() || "The customer";
  const t = o.title.trim();
  const d = (o.description ?? "").trim();
  switch (kind) {
    case "paid": return { type: "quote_paid", title: "Quote paid", message: `${who} paid for ${t}. It's booked.`, push: false };
    case "extra_approved": return { type: "quote_extra_approved", title: "Extra approved", message: `${who} approved ${d}, ${formatCents(o.amountCents)}.`, push: false };
    case "extra_declined": return { type: "quote_extra_declined", title: "Extra declined", message: `${who} declined ${d}. Nothing was added.`, push: false };
    case "problem_reported": return { type: "quote_problem_reported", title: "Problem reported", message: `${who} reported a problem with ${t}. Your payout for this job is paused while Outsyde reviews it.`, push: false };
    case "card_failed": return { type: "quote_card_failed", title: "Card couldn't be held", message: `We couldn't hold ${who}'s card for ${t}, ${formatCents(o.amountCents)}. We asked them to update it.`, push: true };
  }
}

/** One quote as GET /api/quotes/:id gives it to the customer (only the fields read here). */
export interface QuoteDetail {
  quote: { id: string; status: string; conversationId: string; businessName: string | null; title: string };
  balance: { needsNewCard: boolean; holdCents: number } | null;
  window: { canConfirm: boolean; canReport: boolean; endsAt: unknown } | null;
  extras: { id: string; description: string; amountCents: number; serviceFeeCents: number; totalCents: number; status: string; canApprove: boolean; createdAt?: unknown }[];
  extrasPayment: { needsNewCard: boolean; unpaid: boolean; holdCents: number } | null;
}

export type QuoteActionKind = "update_card" | "update_extras_card" | "pay_extras" | "approve_extra" | "confirm_or_report";
export interface QuoteAction {
  kind: QuoteActionKind; quoteId: string; conversationId: string; businessName: string | null; title: string;
  amountCents?: number; extraId?: string; description?: string; serviceFeeCents?: number; totalCents?: number; endsAt?: unknown;
}

const ORDER: QuoteActionKind[] = ["update_card", "update_extras_card", "pay_extras", "approve_extra", "confirm_or_report"];

/** Everything waiting on the customer across their paid quotes. Money first, then extras, then Confirm or Report. */
export function quoteActionsFor(list: QuoteDetail[]): QuoteAction[] {
  const out: QuoteAction[] = [];
  for (const d of list) {
    if (d.quote.status !== "paid") continue;
    const base = { quoteId: d.quote.id, conversationId: d.quote.conversationId, businessName: d.quote.businessName, title: d.quote.title };
    if (d.balance?.needsNewCard) out.push({ kind: "update_card", ...base, amountCents: d.balance.holdCents });
    if (d.extrasPayment?.needsNewCard) out.push({ kind: "update_extras_card", ...base, amountCents: d.extrasPayment.holdCents });
    if (d.extrasPayment?.unpaid) out.push({ kind: "pay_extras", ...base, amountCents: d.extrasPayment.holdCents });
    for (const x of d.extras) {
      if (x.canApprove) out.push({ kind: "approve_extra", ...base, extraId: x.id, description: x.description, amountCents: x.amountCents, serviceFeeCents: x.serviceFeeCents, totalCents: x.totalCents });
    }
    if (d.window?.canConfirm || d.window?.canReport) out.push({ kind: "confirm_or_report", ...base, endsAt: d.window.endsAt });
  }
  return out.map((a, i) => ({ a, i })).sort((x, y) => ORDER.indexOf(x.a.kind) - ORDER.indexOf(y.a.kind) || x.i - y.i).map((x) => x.a);
}
