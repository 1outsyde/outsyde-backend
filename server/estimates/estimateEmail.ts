/**
 * The request email (migration 068), sent to the business owner or the photographer, and to Outsyde.
 * Request forms F2 call 12 (Legend 2026-11-09): one wording for every vendor ("New request", the service, every
 * answer, photos shown as small images). Pure: builds subject, html and text only (no database).
 */
import type { EstimateRequest, RequestAnswerShape } from "@shared/schema";
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

/** A photo answer: each photo as a small image that opens the full size one. */
function photoRow(label: string, urls: string[], odd: boolean): string {
  const bg = odd ? "#1A1A1A" : "#212121";
  const imgs = urls.map((u, i) => `<a href="${escapeHtml(u)}" style="display:inline-block;margin:0 6px 6px 0;"><img src="${escapeHtml(u)}" width="96" height="96" alt="Photo ${i + 1}" style="display:block;width:96px;height:96px;object-fit:cover;border-radius:6px;border:0;"></a>`).join("");
  return `<tr style="background:${bg};">
    <td style="padding:10px 14px;color:#E8B930;font-size:13px;font-weight:600;width:40%;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:10px 14px 4px;vertical-align:top;">${imgs}</td>
  </tr>`;
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
  request: Pick<EstimateRequest, "customerName" | "customerEmail" | "customerPhone" | "city" | "serviceName" | "preferredDate" | "details"> & {
    /** Request form answers (migration 096), shown after the fields above, in form order. */
    answers?: RequestAnswerShape[] | null;
  };
}): { subject: string; html: string; text: string } {
  const r = p.request;
  const lines: [string, string][] = [
    ["Name", r.customerName],
    ["Phone", r.customerPhone],
    ["Email", r.customerEmail],
    ["City", r.city ?? ""],
    ["Service", r.serviceName ?? "Not chosen"],
    ["Preferred date", r.preferredDate ?? ""],
  ];
  const details = r.details ?? {};
  const known = Object.keys(DETAIL_LABELS).filter((k) => details[k]);
  const extra = Object.keys(details).filter((k) => !(k in DETAIL_LABELS) && details[k]);
  for (const k of known) lines.push([DETAIL_LABELS[k], details[k]]);
  for (const k of extra) lines.push([k, details[k]]);
  // Photo answers are shown as small images in the html (row number -> urls); the text lists the links.
  const photoRows = new Map<number, string[]>();
  for (const a of r.answers ?? []) {
    if (a.type === "photos") {
      // Only Outsyde upload links get here (checkAnswers accepts nothing else); escaped where shown.
      const urls = (Array.isArray(a.value) ? a.value : []).map(String);
      if (!urls.length) continue;
      photoRows.set(lines.length, urls);
      lines.push([a.label, urls.length === 1 ? `1 photo: ${urls[0]}` : `${urls.length} photos: ${urls.join("  ")}`]);
    } else {
      lines.push([a.label, Array.isArray(a.value) ? a.value.join(", ") : a.value]);
    }
  }
  const shownIdx = lines.map((l, i) => [l, i] as const).filter(([[, v]]) => v && String(v).trim());
  const shown = shownIdx.map(([l]) => l);

  const subject = `New request from ${r.customerName}`;
  const table = `<tr><td style="background:#1A1A1A;padding:8px 32px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:6px;overflow:hidden;">
        ${shownIdx.map(([[l, v], idx], i) => (photoRows.has(idx) ? photoRow(l, photoRows.get(idx)!, i % 2 === 0) : row(l, v, i % 2 === 0))).join("")}
      </table>
    </td></tr>`;
  const html = wrapEmail(
    emailHeader("New request", `For ${escapeHtml(p.businessName.trim())}. Reply to this email to reach the customer.`) +
      table +
      emailFooter("You can also see this request in the Outsyde app under Requests, and in your chat with the customer."),
  );
  const text = [`New request for ${p.businessName.trim()}.`, "", ...shown.map(([l, v]) => `${l}: ${v}`)].join("\n");
  return { subject, html, text };
}
