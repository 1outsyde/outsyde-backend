/**
 * Every answer a business gave at signup, as labelled rows, for the admin email
 * (emailService.sendNewVendorApplicationEmail) and the admin APIs (signupDetails).
 *
 * Rules (Legend 2026-10-17): show ALL answers; empty → "Not provided"; never show
 * password, tokens or Stripe ids. Values here are plain text; escape before putting in HTML.
 */
import type { Business, User } from "@shared/schema";
import { describeIndustry } from "@shared/businessTaxonomy";

export const NOT_PROVIDED = "Not provided";

export interface DetailRow {
  label: string;
  value: string;
  /** "image" rows hold a URL to render as an image; "link" rows a URL to link. */
  kind?: "text" | "image" | "link";
}

export interface DetailSection {
  title: string;
  rows: DetailRow[];
}

// Web signup stores codes, the app stores labels: map the web codes, show anything else as typed.
const YEARS_LABELS: Record<string, string> = {
  "less-than-1": "Less than 1 year",
  "1-2": "1 to 2 years",
  "3-5": "3 to 5 years",
  "5-10": "5 to 10 years",
  "10+": "10+ years",
};
const BUSINESS_TYPE_LABELS: Record<string, string> = {
  "sole-proprietor": "Sole proprietorship",
  llc: "LLC",
  corporation: "Corporation",
  partnership: "Partnership",
  nonprofit: "Nonprofit",
};

export function text(v: unknown): string {
  if (v === null || v === undefined) return NOT_PROVIDED;
  const s = String(v).trim();
  return s ? s : NOT_PROVIDED;
}

export function yesNo(v: boolean | null | undefined): string {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return NOT_PROVIDED;
}

export function joinParts(parts: Array<string | null | undefined>): string {
  const s = parts.map((p) => (p ?? "").trim()).filter(Boolean).join(", ");
  return s || NOT_PROVIDED;
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return NOT_PROVIDED;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return NOT_PROVIDED;
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }) + " ET";
}

export function offerTypeLabel(b: Pick<Business, "hasProducts" | "hasServices">): string {
  if (b.hasProducts && b.hasServices) return "Products and services";
  if (b.hasProducts) return "Products";
  if (b.hasServices) return "Services";
  return NOT_PROVIDED;
}

function billingText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return NOT_PROVIDED;
  const a = raw as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  return joinParts([str("line1"), str("line2"), str("city"), [str("state"), str("postalCode")].filter(Boolean).join(" ")]);
}

export function isHttpUrl(v: string | null | undefined): v is string {
  return !!v && /^https?:\/\//i.test(v.trim());
}

export type OwnerLike = Pick<User, "name" | "email" | "phone" | "username" | "address" | "city" | "state" | "zipCode" | "createdAt"> & {
  source?: string | null;
};

export function buildVendorApplicationSections(business: Business, owner: OwnerLike | null | undefined): DetailSection[] {
  const industry = describeIndustry(business.categoryCode, business.specialties);
  const specialtyText = industry.specialties.length
    ? industry.specialties.map((s) => (s.kind ? `${s.label} (${s.kind})` : s.label)).join(", ")
    : NOT_PROVIDED;
  const years = business.yearsInBusiness ? YEARS_LABELS[business.yearsInBusiness] ?? business.yearsInBusiness : null;
  const bizType = business.businessType ? BUSINESS_TYPE_LABELS[business.businessType] ?? business.businessType : null;

  const logoRow: DetailRow = isHttpUrl(business.logoImage)
    ? { label: "Logo", value: business.logoImage.trim(), kind: "image" }
    : { label: "Logo", value: NOT_PROVIDED };
  const websiteRow: DetailRow = isHttpUrl(business.websiteUrl)
    ? { label: "Website", value: business.websiteUrl.trim(), kind: "link" }
    : { label: "Website", value: text(business.websiteUrl) };

  const lookup = [business.name, business.city, business.state].filter(Boolean).join(" ");

  return [
    {
      title: "Business",
      rows: [
        { label: "Business name", value: text(business.name) },
        logoRow,
        { label: "Industry", value: text(business.categoryCode ? industry.categoryLabel : business.category) },
        { label: "What they do", value: specialtyText },
        { label: "Their own words (Other)", value: text(business.otherDescription) },
        { label: "Offers", value: offerTypeLabel(business) },
        { label: "Description", value: text(business.description) },
        { label: "Startup", value: yesNo(business.isStartup) },
        { label: "Multi staff", value: yesNo(business.isMultiStaff) },
        { label: "Years in business", value: text(years) },
        { label: "Employees", value: text(business.employeeCount) },
        { label: "Business type", value: text(bizType) },
        websiteRow,
        { label: "Social media", value: text(business.socialMedia) },
        { label: "Look them up", value: `https://www.google.com/search?q=${encodeURIComponent(lookup)}`, kind: "link" },
      ],
    },
    {
      title: "Location",
      rows: [
        { label: "Physical location", value: yesNo(business.hasPhysicalLocation) },
        {
          label: "Business address",
          value: joinParts([business.address, business.city, [business.state, business.zipCode].filter(Boolean).join(" ")]),
        },
        { label: "Billing address", value: billingText(business.billingAddress) },
      ],
    },
    {
      title: "Owner",
      rows: [
        { label: "Name", value: text(owner?.name) },
        { label: "Email", value: text(owner?.email) },
        { label: "Phone", value: text(owner?.phone) },
        { label: "Username", value: owner?.username ? `@${owner.username}` : NOT_PROVIDED },
        {
          label: "Home address",
          value: joinParts([owner?.address, owner?.city, [owner?.state, owner?.zipCode].filter(Boolean).join(" ")]),
        },
        { label: "Signed up from", value: text(owner?.source) },
        { label: "Account created", value: formatDate(owner?.createdAt) },
      ],
    },
    {
      title: "Status",
      rows: [
        { label: "Applied", value: formatDate(business.createdAt) },
        { label: "Approval", value: text(business.approvalStatus) },
        {
          label: "Vendor agreement",
          value: business.vendorAgreementAccepted
            ? `Accepted ${business.vendorAgreementAcceptedAt ? formatDate(business.vendorAgreementAcceptedAt) : ""}`.trim()
            : "Not accepted",
        },
      ],
    },
  ];
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) URLs are ever placed in href/src; anything else renders as text. */
export function safeUrl(s: string): string | null {
  try {
    const u = new URL(s.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function renderSectionsHtml(sections: DetailSection[]): string {
  return sections
    .map((section) => {
      const rows = section.rows
        .map((r) => {
          let cell: string;
          const url = r.kind && r.kind !== "text" ? safeUrl(r.value) : null;
          if (r.kind === "image" && url) {
            cell = `<img src="${escapeHtml(url)}" alt="Logo" width="96" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid #eee;" />`;
          } else if (r.kind === "link" && url) {
            const shown = r.label === "Look them up" ? "Search Google" : r.value;
            cell = `<a href="${escapeHtml(url)}" style="color:#b8860b;">${escapeHtml(shown)}</a>`;
          } else {
            const muted = r.value === NOT_PROVIDED ? "color:#999;" : "color:#222;";
            cell = `<span style="${muted}white-space:pre-wrap;">${escapeHtml(r.value)}</span>`;
          }
          return `<tr><td style="padding:6px 12px 6px 0;color:#666;font-size:13px;vertical-align:top;width:40%;">${escapeHtml(r.label)}</td><td style="padding:6px 0;font-size:14px;vertical-align:top;">${cell}</td></tr>`;
        })
        .join("");
      return `<h3 style="margin:24px 0 8px;font-size:15px;color:#333;border-bottom:1px solid #eee;padding-bottom:6px;">${escapeHtml(section.title)}</h3><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${rows}</table>`;
    })
    .join("");
}

export function renderSectionsText(sections: DetailSection[]): string {
  return sections
    .map((s) => `${s.title.toUpperCase()}\n${s.rows.map((r) => `${r.label}: ${r.value}`).join("\n")}`)
    .join("\n\n");
}

/** JSON shape for the admin APIs (additive field `signupDetails`). */
export function buildSignupDetailsPayload(business: Business, owner: OwnerLike | null | undefined) {
  const industry = describeIndustry(business.categoryCode, business.specialties);
  return {
    industry: {
      categoryCode: business.categoryCode ?? null,
      categoryLabel: business.categoryCode ? industry.categoryLabel : business.category ?? null,
      specialties: industry.specialties,
      otherDescription: business.otherDescription ?? null,
    },
    offers: offerTypeLabel(business),
    sections: buildVendorApplicationSections(business, owner),
  };
}
