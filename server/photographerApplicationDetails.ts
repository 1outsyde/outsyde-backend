/**
 * Every answer a photographer gave at signup, as labelled rows, for the admin email
 * (emailService.sendNewPhotographerApplicationEmail) and the admin APIs (signupDetails).
 *
 * Same rules as businesses (Legend 2026-10-17/18): show ALL answers, empty → "Not provided",
 * never show password, tokens or Stripe ids. App and website answers are both shown readable.
 */
import type { Photographer } from "@shared/schema";
import { optionLabel, photographerSpecialtyLabels } from "@shared/photographerTaxonomy";
import {
  NOT_PROVIDED, type DetailRow, type DetailSection, type OwnerLike,
  text, joinParts, formatDate, isHttpUrl,
} from "./adminApplicationDetails";

function list(values: string[] | null | undefined, field?: string): string {
  const shown = (values ?? []).map((v) => (field ? optionLabel(field, v) : v)).filter((v): v is string => !!v);
  return shown.length ? shown.join(", ") : NOT_PROVIDED;
}

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents) || cents <= 0) return NOT_PROVIDED;
  return `$${(cents / 100).toFixed(2)}`;
}

/** Specialty names: the shared list's names when codes exist, plus any typed names never mapped. */
export function photographerSpecialtyNames(p: Pick<Photographer, "specialtyCodes" | "specialties">): string[] {
  const codes = Array.isArray(p.specialtyCodes) ? p.specialtyCodes : [];
  const saved = (p.specialties ?? []).filter((n) => typeof n === "string" && n.trim());
  if (!codes.length) return saved;
  const fromCodes = photographerSpecialtyLabels(codes);
  return [...fromCodes, ...saved.filter((n) => !fromCodes.includes(n))];
}

export function photographerSpecialtyText(p: Pick<Photographer, "specialtyCodes" | "specialties">): string {
  const names = photographerSpecialtyNames(p);
  return names.length ? names.join("; ") : NOT_PROVIDED;
}

export function buildPhotographerApplicationSections(p: Photographer, owner: OwnerLike | null | undefined): DetailSection[] {
  const logoRow: DetailRow = isHttpUrl(p.logoImage)
    ? { label: "Profile photo / logo", value: p.logoImage.trim(), kind: "image" }
    : { label: "Profile photo / logo", value: NOT_PROVIDED };
  const portfolioRow: DetailRow = isHttpUrl(p.portfolioUrl) && !/^https?:\/\/(www\.)?outsyde\.app\/?$/i.test(p.portfolioUrl.trim())
    ? { label: "Portfolio", value: p.portfolioUrl.trim(), kind: "link" }
    : { label: "Portfolio", value: NOT_PROVIDED };
  const lookup = [p.displayName, "photographer", p.city, p.state].filter(Boolean).join(" ");
  const studio = (p.shootLocation ?? []).some((v) => v === "studio" || v === "both" || /studio/i.test(v));

  return [
    {
      title: "Profile",
      rows: [
        { label: "Display name", value: text(p.displayName) },
        logoRow,
        { label: "Specialties", value: photographerSpecialtyText(p) },
        { label: "Their own words (Other)", value: text(p.specialtyOther) },
        { label: "Bio", value: text(p.bio) },
        portfolioRow,
        { label: "Experience", value: text(optionLabel("experienceLevel", p.experienceLevel)) },
        { label: "Equipment", value: text(optionLabel("equipmentLevel", p.equipmentLevel)) },
        { label: "Delivery time", value: text(optionLabel("deliveryTime", p.deliveryTime)) },
        { label: "Extra services", value: list(p.additionalServices, "additionalServices") },
        { label: "Look them up", value: `https://www.google.com/search?q=${encodeURIComponent(lookup)}`, kind: "link" },
      ],
    },
    {
      title: "Pricing",
      rows: [
        { label: "Pricing type", value: text(optionLabel("pricingType", p.pricingType)) },
        { label: "Starting price", value: money(p.startingPrice) },
        // Units differ by signup (website: dollars, app: cents); shown as stored until that is unified.
        { label: "Hourly rate (as stored)", value: p.hourlyRate ? String(p.hourlyRate) : NOT_PROVIDED },
        { label: "Minimum booking", value: text(optionLabel("minimumBooking", p.minimumBooking)) },
      ],
    },
    {
      title: "Where they shoot",
      rows: [
        { label: "City / state", value: joinParts([p.city, p.state]) },
        { label: "Shoots", value: list(p.shootLocation, "shootLocation") },
        { label: "Studio name", value: text(p.studioName) },
        { label: "Studio address", value: text(p.studioAddress) },
        { label: "Shared studio", value: p.usesSharedStudio === true ? "Yes" : studio ? "No" : NOT_PROVIDED },
        { label: "Travel", value: text(optionLabel("travelRadius", p.travelRadius)) },
      ],
    },
    {
      title: "Owner",
      rows: [
        { label: "Name", value: text(owner?.name) },
        { label: "Email", value: text(owner?.email) },
        { label: "Phone", value: text(owner?.phone) },
        { label: "Username", value: owner?.username ? `@${owner.username}` : NOT_PROVIDED },
        { label: "Signed up from", value: text(owner?.source) },
        { label: "Account created", value: formatDate(owner?.createdAt) },
      ],
    },
    {
      title: "Status",
      rows: [
        { label: "Joined", value: formatDate(p.createdAt) },
        { label: "Visibility", value: text(p.visibilityStatus) },
        { label: "Payouts connected", value: p.stripeOnboardingComplete ? "Yes" : "No" },
        { label: "Admin notes", value: text(p.adminNotes) },
      ],
    },
  ];
}

/** JSON shape for the admin APIs (additive field `signupDetails`). */
export function buildPhotographerSignupDetailsPayload(p: Photographer, owner: OwnerLike | null | undefined) {
  return {
    specialties: {
      codes: Array.isArray(p.specialtyCodes) ? p.specialtyCodes : [],
      labels: photographerSpecialtyNames(p),
      other: p.specialtyOther ?? null,
    },
    sections: buildPhotographerApplicationSections(p, owner),
  };
}
