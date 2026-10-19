/**
 * Pure tests for influencer applications (2026-10-18): parsing every answer, admin rows,
 * promo codes. Run: DATABASE_URL=<any local url> npx tsx server/influencerApplicationDetails.test.ts
 */
import { parseInfluencerApplication, parseFollowers, makeInfluencerPromoCode, contentCategoryLabels } from "@shared/influencerApplication";
import { buildInfluencerApplicationSections, socialRow } from "./influencerApplicationDetails";
import { renderSectionsHtml, renderSectionsText, NOT_PROVIDED } from "./adminApplicationDetails";

let passed = 0, failed = 0;
const ok = (c: boolean, n: string, d?: unknown) => { if (c) { passed++; console.log("  ✅ " + n); } else { failed++; console.error("  ❌ " + n, d === undefined ? "" : JSON.stringify(d)); } };

(async () => {
  console.log("\n=== Parsing ===");
  let r = parseInfluencerApplication({ instagramUrl: "@kat", tiktokUrl: null, followerCount: "12,500", bio: "I post braids" });
  ok(r.ok && r.value.followerCount === 12500 && r.value.whyInfluencer === "I post braids" && r.value.instagramUrl === "@kat", "older app payload: bio saved as why, commas ok", r);
  r = parseInfluencerApplication({
    instagram_url: "https://instagram.com/kat", youtubeUrl: "@katvids", twitterUrl: "kat_x",
    instagramFollowers: "1.2k", youtubeFollowers: 300, twitterFollowers: "0",
    contentCategories: ["beauty", "fashion", "beauty"], whyInfluencer: "  Love it  ",
  });
  ok(r.ok && r.value.instagramFollowers === 1200 && r.value.youtubeFollowers === 300 && r.value.twitterFollowers === 0, "per platform followers, k suffix", r);
  ok(r.ok && r.value.followerCount === 1500, "total = sum when no total given", r.ok && r.value.followerCount);
  ok(r.ok && JSON.stringify(r.value.contentCategories) === '["beauty","fashion"]' && r.value.whyInfluencer === "Love it", "categories de duplicated, text trimmed");
  r = parseInfluencerApplication({ tiktokUrl: "@t", followerCount: 900, instagramFollowers: 100 });
  ok(r.ok && r.value.followerCount === 900, "a sent total wins over the sum");
  const bad = (body: Record<string, unknown>, field: string, name: string) => {
    const x = parseInfluencerApplication(body);
    ok(!x.ok && x.field === field, name, x);
  };
  bad({}, "socials", "no socials → field socials");
  bad({ instagramUrl: "   " }, "socials", "blank socials → field socials");
  bad({ instagramUrl: "@k", followerCount: "lots" }, "followerCount", "words as followers → 400");
  bad({ instagramUrl: "@k", tiktokFollowers: -5 }, "tiktokFollowers", "negative followers → 400");
  bad({ instagramUrl: "@k", contentCategories: ["beauty", "nope"] }, "contentCategories", "unknown category → 400");
  bad({ instagramUrl: "@k", contentCategories: "beauty" }, "contentCategories", "categories must be a list");
  bad({ instagramUrl: "@k", contentCategories: ["beauty", "fashion", "food", "home", "pets", "auto"] }, "contentCategories", "more than 5 → 400");
  bad({ instagramUrl: "@k", contentCategories: ["other"] }, "contentOther", "Other without words → 400");
  bad({ instagramUrl: "@k", whyInfluencer: "x".repeat(2001) }, "whyInfluencer", "why over 2000 → 400");
  bad({ instagramUrl: "x".repeat(201) }, "instagramUrl", "handle over 200 → 400");
  r = parseInfluencerApplication({ instagramUrl: "@k", contentCategories: ["beauty"], contentOther: "ignored" });
  ok(r.ok && r.value.contentOther === null, "Other words dropped when Other not picked");
  ok(Number.isNaN(parseFollowers("1.5b")) && parseFollowers("2m") === 2_000_000 && parseFollowers("") === null, "follower parsing edges");

  console.log("\n=== Admin rows ===");
  const app: any = {
    id: "a1", userId: "u1", instagramUrl: "@kat.style", tiktokUrl: "https://www.tiktok.com/@kat", youtubeUrl: null, twitterUrl: "javascript:alert(1)",
    instagramFollowers: 1200, tiktokFollowers: null, youtubeFollowers: null, twitterFollowers: null, followerCount: 1200,
    contentCategories: ["beauty", "other", "zzz"], contentOther: "Braids <script>alert(1)</script>", contentNiche: null,
    whyInfluencer: `I "love" Outsyde`, status: "pending", adminNotes: null, reviewedAt: null, createdAt: new Date("2026-10-18T12:00:00Z"),
  };
  const applicant: any = { name: "Kat <b>X</b>", email: "kat@test.local", phone: null, username: "katx", city: "Freeport", state: "NY", createdAt: new Date("2026-10-01T12:00:00Z"), isInfluencer: false, source: null };
  const sections = buildInfluencerApplicationSections(app, applicant, { promoCode: null });
  const v = (t: string, l: string) => sections.find((s) => s.title === t)?.rows.find((x) => x.label === l);
  ok(sections.map((s) => s.title).join("|") === "Application|Contact|Status", "sections");
  ok(v("Application", "Instagram")?.value === "https://www.instagram.com/kat.style" && v("Application", "Instagram")?.kind === "link", "handle becomes a profile link");
  ok(v("Application", "TikTok")?.value === "https://www.tiktok.com/@kat" && v("Application", "X")?.kind === undefined, "links kept; javascript: never linked");
  ok(v("Application", "Instagram followers")?.value === "1,200" && v("Application", "YouTube")?.value === NOT_PROVIDED, "counts formatted; blanks Not provided");
  ok(v("Application", "What they post about")?.value === "Beauty & Personal Care, Other, zzz", "category names, unknown shown as saved");
  ok(v("Status", "Status")?.value === "Pending" && v("Status", "Promo code")?.value === NOT_PROVIDED && v("Status", "Influencer")?.value === "No", "status rows");
  ok(!sections[0].rows.some((x) => x.label === "Content niche"), "no Content niche row when empty");
  const html = renderSectionsHtml(sections), text = renderSectionsText(sections);
  ok(!html.includes("<script>") && !html.includes("<b>X</b>") && html.includes("&lt;script&gt;") && !/href="javascript/i.test(html), "email html escaped, javascript never linked");
  ok(!/[–—]/.test(html + text), "no dashes in the email copy");
  ok(socialRow("YouTube", "youtube", "@my channel!").value === "@my channel!", "odd handles shown as typed");
  ok(JSON.stringify(contentCategoryLabels(["food", 5, "x"])) === '["Food & Drink","x"]', "labels skip non text");

  console.log("\n=== Promo codes ===");
  const takenSet = new Set(["KATX", "OUTS"]);
  const taken = async (c: string) => takenSet.has(c);
  ok(await makeInfluencerPromoCode("kat_style.99", taken) === "KATSTYLE99", "from username, letters and digits only");
  const c2 = await makeInfluencerPromoCode("katx", taken);
  ok(/^KATX\d{2}$/.test(c2), "taken → number added", c2);
  ok(await makeInfluencerPromoCode("ab", taken) === "ABOUTSYD", "short names padded");
  ok((await makeInfluencerPromoCode(null, async () => false)).length >= 4, "no name still makes a code");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
