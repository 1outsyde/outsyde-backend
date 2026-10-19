/**
 * Every answer a person gave at signup, as labelled rows, for the admin user screens
 * (GET /api/admin/users/:id → signupDetails). Legend 2026-10-18: show every signup answer
 * on both admin dashboards, interests in their own section, never in signup emails.
 *
 * Never shown: password, reset tokens, Stripe ids, ethnicity (Legend: left out).
 * Empty → "Not provided". Values are plain text (clients render them as text).
 */
import type { User } from "@shared/schema";
import { describeCustomerInterests } from "@shared/customerInterests";
import { NOT_PROVIDED, type DetailRow, type DetailSection, text, joinParts, formatDate } from "./adminApplicationDetails";

type CustomerLike = Pick<User,
  | "name" | "firstName" | "lastName" | "email" | "phone" | "username" | "profileImageUrl"
  | "address" | "aptUnit" | "city" | "state" | "zipCode" | "country"
  | "billingSameAsHome" | "billingStreet" | "billingAptUnit" | "billingCity" | "billingState" | "billingZip" | "billingCountry"
  | "dateOfBirth" | "gender" | "shoppingFrequency"
  | "selectedIndustries" | "industryNiches" | "industryValues"
  | "source" | "createdAt" | "isActive" | "isVendor" | "isPhotographer" | "isAdmin" | "loyaltyPoints"
> & { deletionStatus?: string | null; scheduledDeletionAt?: Date | string | null };

/** Birthday as a plain date. Stored as a timestamp at midnight UTC, so read it in UTC. */
export function birthdayText(d: Date | string | null | undefined): string {
  if (!d) return NOT_PROVIDED;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return NOT_PROVIDED;
  return date.toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" });
}

function addressText(parts: { street?: string | null; apt?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null }): string {
  const hasAny = [parts.street, parts.apt, parts.city, parts.state, parts.zip].some((p) => (p ?? "").trim());
  if (!hasAny) return NOT_PROVIDED;
  return joinParts([parts.street, parts.apt, parts.city, [parts.state, parts.zip].filter((p) => (p ?? "").trim()).join(" "), parts.country]);
}

function roleText(u: CustomerLike): string {
  const roles = [u.isAdmin && "Admin", u.isVendor && "Business", u.isPhotographer && "Photographer"].filter(Boolean) as string[];
  return roles.length ? roles.join(", ") : "Customer";
}

export function buildCustomerSignupSections(u: CustomerLike): DetailSection[] {
  const interests = describeCustomerInterests(u);
  const interestRows: DetailRow[] = [
    {
      label: "Industries",
      value: interests.industries.length ? interests.industries.map((i) => i.label).join(", ") : NOT_PROVIDED,
    },
    {
      label: "Matches business industries",
      value: (() => {
        const labels = Array.from(new Set(interests.industries.map((i) => i.categoryLabel).filter((l): l is string => !!l)));
        return labels.length ? labels.join(", ") : NOT_PROVIDED;
      })(),
    },
    ...(interests.niches.length
      ? interests.niches.map((g) => ({ label: `Into (${g.industryLabel})`, value: g.items.join(", ") }))
      : [{ label: "What they're into", value: NOT_PROVIDED }]),
    ...(interests.values.length
      ? interests.values.map((g) => ({ label: `What matters (${g.industryLabel})`, value: g.items.join(", ") }))
      : [{ label: "What matters most", value: NOT_PROVIDED }]),
  ];

  const billing = u.billingSameAsHome !== false
    ? (addressText({ street: u.address, city: u.city, state: u.state, zip: u.zipCode }) === NOT_PROVIDED ? NOT_PROVIDED : "Same as home")
    : addressText({ street: u.billingStreet, apt: u.billingAptUnit, city: u.billingCity, state: u.billingState, zip: u.billingZip, country: u.billingCountry });

  return [
    { title: "Interests", rows: interestRows },
    {
      title: "About them",
      rows: [
        { label: "Gender", value: text(u.gender) },
        { label: "Birthday", value: birthdayText(u.dateOfBirth) },
        { label: "Shopping frequency", value: text(u.shoppingFrequency) },
      ],
    },
    {
      title: "Contact",
      rows: [
        { label: "Name", value: text(u.name || [u.firstName, u.lastName].filter(Boolean).join(" ")) },
        { label: "Email", value: text(u.email) },
        { label: "Phone", value: text(u.phone) },
        { label: "Username", value: u.username ? `@${u.username}` : NOT_PROVIDED },
        { label: "Home address", value: addressText({ street: u.address, apt: u.aptUnit, city: u.city, state: u.state, zip: u.zipCode, country: u.country }) },
        { label: "Billing address", value: billing },
      ],
    },
    {
      title: "Account",
      rows: [
        { label: "Type", value: roleText(u) },
        { label: "Signed up from", value: text(u.source) },
        { label: "Account created", value: formatDate(u.createdAt) },
        { label: "Account", value: u.isActive === false ? "Disabled" : "Active" },
        ...(u.deletionStatus === "pending_deletion"
          ? [{ label: "Deletion scheduled", value: formatDate(u.scheduledDeletionAt ?? null) }]
          : []),
        { label: "Loyalty points", value: String(u.loyaltyPoints ?? 0) },
      ],
    },
  ];
}

/** JSON shape for GET /api/admin/users/:id (additive field `signupDetails`). */
export function buildCustomerSignupDetailsPayload(u: CustomerLike) {
  return {
    interests: describeCustomerInterests(u),
    sections: buildCustomerSignupSections(u),
  };
}
