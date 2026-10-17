/**
 * Search card cover helper — pure tests. Run: npx tsx server/coverMedia.test.ts
 * Mutation check: return `u` for Mux URLs instead of the thumbnail → the Mux assertions fail.
 */
import { coverStillImage, nonEmpty } from "./coverMedia";

let passed = 0, failed = 0;
const eq = (a: unknown, b: unknown, name: string) => {
  if (a === b) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}\n     expected ${JSON.stringify(b)}\n     got      ${JSON.stringify(a)}`); }
};

eq(coverStillImage("https://cdn.x/cover.jpeg", "image"), "https://cdn.x/cover.jpeg", "image cover passes through");
eq(coverStillImage("https://www.goutsyde.com/lifestyle-tea.jpg", null), "https://www.goutsyde.com/lifestyle-tea.jpg", "null media type + image URL (Lotus) passes through");
eq(coverStillImage("https://stream.mux.com/AbC123xyz.m3u8", "video"), "https://image.mux.com/AbC123xyz/thumbnail.jpg", "Mux video cover → Mux thumbnail");
eq(coverStillImage("https://stream.mux.com/AbC123xyz.m3u8?token=t", "video"), "https://image.mux.com/AbC123xyz/thumbnail.jpg", "Mux URL with query → thumbnail");
eq(coverStillImage("https://stream.mux.com/AbC123xyz", null), "https://image.mux.com/AbC123xyz/thumbnail.jpg", "Mux URL without extension → thumbnail");
eq(coverStillImage("https://cdn.x/clip.mp4", "video"), null, "non-Mux video → null (no still available)");
eq(coverStillImage("https://cdn.x/clip.mp4", null), null, "video file with missing media type → null");
eq(coverStillImage("https://cdn.x/file", "video"), null, "unknown URL marked video → null");
eq(coverStillImage("", "image"), null, "empty → null");
eq(coverStillImage("   ", null), null, "blank → null");
eq(coverStillImage(null, null), null, "null → null");
eq(nonEmpty("  "), null, "nonEmpty blank → null");
eq(nonEmpty(" https://l.png "), "https://l.png", "nonEmpty trims");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
