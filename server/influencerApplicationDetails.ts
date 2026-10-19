/**
 * Every answer an influencer applicant gave, as labelled rows, for the admin email
 * (emailService.sendNewInfluencerApplicationEmail) and the admin APIs (signupDetails).
 *
 * Same rules as businesses and photographers (Legend 2026-10-17/18): show ALL answers,
 * empty → "Not provided", never show password, tokens, Stripe ids or ethnicity.
 */
import type { InfluencerApplication, User } from "@shared/schema";
import { contentCategoryLabels } from "@shared/influencerApplication";
import { NOT_PROVIDED, type DetailRow, type DetailSection, text, joinParts, formatDate } from "./adminApplicationDetails";

export type ApplicantLike = Pick<User, "name" | "email" | "phone" | "username" | "city" | "state" | "createdAt" | "isInfluencer"> & {
  source?: string | null;
  isActive?: boolean | null;
};

const PROFILE_BASES: Record<string, string> = {
  instagram: "https://www.instagram.com/",
  tiktok: "https://www.tiktok.com/@",
  youtube: "https://www.youtube.com/@",
  twitter: "https://x.com/",
};

/** A handle or link as a clickable profile link (only http(s)); anything odd is shown as typed. */
export function socialRow(label: string, platform: keyof typeof PROFILE_BASES, value: string | null | undefined): DetailRow {
  const v = (value ?? "").trim();
  if (!v) return { label, value: NOT_PROVIDED };
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (u.protocol === "http:" || u.protocol === "https:") return { label, value: u.toString(), kind: "link" };
    } catch { /* shown as typed */ }
    return { label, value: v };
  }
  const handle = v.replace(/^@+/, "");
  if (/^[A-Za-z0-9._-]{1,100}$/.test(handle)) return { label, value: `${PROFILE_BASES[platform]}${handle}`, kind: "link" };
  return { label, value: v };
}

function count(n: number | null | undefined): string {
  return n === null || n === undefined ? NOT_PROVIDED : n.toLocaleString("en-US");
}

export function buildInfluencerApplicationSections(
  a: InfluencerApplication,
  applicant: ApplicantLike | null | undefined,
  extra?: { promoCode?: string | null },
): DetailSection[] {
  const categories = contentCategoryLabels(a.contentCategories);
  return [
    {
      title: "Application",
      rows: [
        socialRow("Instagram", "instagram", a.instagramUrl),
        { label: "Instagram followers", value: count(a.instagramFollowers) },
        socialRow("TikTok", "tiktok", a.tiktokUrl),
        { label: "TikTok followers", value: count(a.tiktokFollowers) },
        socialRow("YouTube", "youtube", a.youtubeUrl),
        { label: "YouTube followers", value: count(a.youtubeFollowers) },
        socialRow("X", "twitter", a.twitterUrl),
        { label: "X followers", value: count(a.twitterFollowers) },
        { label: "Total followers", value: count(a.followerCount) },
        { label: "What they post about", value: categories.length ? categories.join(", ") : NOT_PROVIDED },
        { label: "Their own words (Other)", value: text(a.contentOther) },
        ...(a.contentNiche ? [{ label: "Content niche", value: a.contentNiche }] : []),
        { label: "Why they want to join", value: text(a.whyInfluencer) },
      ],
    },
    {
      title: "Contact",
      rows: [
        { label: "Name", value: text(applicant?.name) },
        { label: "Email", value: text(applicant?.email) },
        { label: "Phone", value: text(applicant?.phone) },
        { label: "Username", value: applicant?.username ? `@${applicant.username}` : NOT_PROVIDED },
        { label: "City / state", value: joinParts([applicant?.city, applicant?.state]) },
        { label: "Signed up from", value: text(applicant?.source) },
        { label: "Account created", value: formatDate(applicant?.createdAt) },
      ],
    },
    {
      title: "Status",
      rows: [
        { label: "Applied", value: formatDate(a.createdAt) },
        { label: "Status", value: a.status === "approved" ? "Approved" : a.status === "rejected" ? "Rejected" : a.status === "pending" ? "Pending" : text(a.status) },
        { label: "Reviewed", value: formatDate(a.reviewedAt) },
        { label: "Admin notes", value: text(a.adminNotes) },
        { label: "Influencer", value: applicant?.isInfluencer ? "Yes" : "No" },
        { label: "Promo code", value: text(extra?.promoCode) },
        ...(applicant && applicant.isActive === false ? [{ label: "Account", value: "Disabled" }] : []),
      ],
    },
  ];
}

/** JSON shape for the admin APIs (additive field `signupDetails`). */
export function buildInfluencerSignupDetailsPayload(a: InfluencerApplication, applicant: ApplicantLike | null | undefined, extra?: { promoCode?: string | null }) {
  return {
    contentCategories: { codes: Array.isArray(a.contentCategories) ? a.contentCategories : [], labels: contentCategoryLabels(a.contentCategories), other: a.contentOther ?? null },
    sections: buildInfluencerApplicationSections(a, applicant, extra),
  };
}
