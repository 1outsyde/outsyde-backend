/**
 * The estimate request email (migration 067), sent to the business owner and to Outsyde.
 * Pure: builds subject, html and text only (no database), so it can be tested on its own.
 */
import type { EstimateRequest } from "@shared/schema";
import { emailHeader, emailFooter, wrapEmail } from "../emailService";

/** Labels for the known form fields, in the order the email shows them. Unknown keys follow, as sent. */
const DETAIL_LABELS: Record<string, string> = {
  moveType: "Move type",
  homeSize: "Home size",
  fromAddress: "Pickup address",
  toAddress: "Drop off address",
  floor: "Floor",
  stops: "Additional stops",
  notes: "Notes and special items",
};

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function row(label: string, value: string, odd: boolean): string {
  const bg = odd ? "#1A1A1A" : "#212121";
  return `<tr style="background:${bg};">
    <td style="padding:10px 14px;color:#E8B930;font-size:13px;font-weight:600;width:40%;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:10px 14px;color:#FFFFFF;font-size:14px;vertical-align:top;white-space:pre-wrap;">${escapeHtml(value)}</td>
  </tr>`;
}

/** The email both the business and Outsyde receive. Plain words, no dashes (Legend's copy rule). */
export function buildEstimateRequestEmail(p: {
  businessName: string;
  request: Pick<EstimateRequest, "customerName" | "customerEmail" | "customerPhone" | "city" | "serviceName" | "preferredDate" | "details">;
}): { subject: string; html: string; text: string } {
  const r = p.request;
  const lines: [string, string][] = [
    ["Name", r.customerName],
    ["Phone", r.customerPhone],
    ["Email", r.customerEmail],
    ["City", r.city ?? ""],
    ["Plan", r.serviceName ?? "Not chosen"],
    ["Preferred date", r.preferredDate ?? ""],
  ];
  const details = r.details ?? {};
  const known = Object.keys(DETAIL_LABELS).filter((k) => details[k]);
  const extra = Object.keys(details).filter((k) => !(k in DETAIL_LABELS) && details[k]);
  for (const k of known) lines.push([DETAIL_LABELS[k], details[k]]);
  for (const k of extra) lines.push([k, details[k]]);
  const shown = lines.filter(([, v]) => v && String(v).trim());

  const subject = `New estimate request from ${r.customerName}`;
  const table = `<tr><td style="background:#1A1A1A;padding:8px 32px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:6px;overflow:hidden;">
        ${shown.map(([l, v], i) => row(l, v, i % 2 === 0)).join("")}
      </table>
    </td></tr>`;
  const html = wrapEmail(
    emailHeader("New estimate request", `For ${escapeHtml(p.businessName.trim())}. Reply to this email to reach the customer.`) +
      table +
      emailFooter("You can also see this request in your dashboard under Estimate Requests."),
  );
  const text = [`New estimate request for ${p.businessName.trim()}.`, "", ...shown.map(([l, v]) => `${l}: ${v}`)].join("\n");
  return { subject, html, text };
}
