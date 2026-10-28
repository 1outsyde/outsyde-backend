/**
 * videoSizeFromMuxAsset unit tests — run with: npx tsx server/muxVideoSize.test.ts
 * Pure function, no database or network.
 */
import { videoSizeFromMuxAsset } from "./muxVideoSize";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const vertical = videoSizeFromMuxAsset({ aspect_ratio: "9:16", tracks: [{ type: "audio" }, { type: "video", max_width: 1080, max_height: 1920 }] });
assert(vertical?.width === 1080 && vertical?.height === 1920 && Math.abs(vertical.aspectRatio - 0.5625) < 1e-9, "vertical 1080x1920 → 0.5625", vertical);

const wide = videoSizeFromMuxAsset({ aspect_ratio: "16:9", tracks: [{ type: "video", max_width: 1280, max_height: 720 }] });
assert(wide?.width === 1280 && wide?.height === 720, "wide 1280x720 kept as is", wide);

const rotated = videoSizeFromMuxAsset({ aspect_ratio: "9:16", tracks: [{ type: "video", max_width: 1920, max_height: 1080 }] });
assert(rotated?.width === 1080 && rotated?.height === 1920, "track wide but asset says 9:16 → swapped to tall", rotated);

const noAspect = videoSizeFromMuxAsset({ tracks: [{ type: "video", max_width: 720, max_height: 1280 }] });
assert(noAspect?.width === 720 && noAspect?.height === 1280, "no aspect_ratio string → track size used", noAspect);

const square = videoSizeFromMuxAsset({ aspect_ratio: "1:1", tracks: [{ type: "video", max_width: 1080, max_height: 1080 }] });
assert(square?.width === 1080 && square?.aspectRatio === 1, "square stays square", square);

assert(videoSizeFromMuxAsset({ tracks: [{ type: "audio" }] }) === null, "no video track → null");
assert(videoSizeFromMuxAsset({}) === null, "no tracks → null");
assert(videoSizeFromMuxAsset(undefined) === null, "no data → null");
assert(videoSizeFromMuxAsset({ tracks: [{ type: "video", max_width: 0, max_height: 1080 }] }) === null, "zero width → null");
assert(videoSizeFromMuxAsset({ tracks: [{ type: "video", max_width: "1080", max_height: 1920 }] })?.width === 1080, "numeric strings accepted");
assert(videoSizeFromMuxAsset({ tracks: [{ type: "video", max_width: 10.5, max_height: 1920 }] }) === null, "non-integer size → null");
assert(videoSizeFromMuxAsset({ aspect_ratio: "junk", tracks: [{ type: "video", max_width: 1920, max_height: 1080 }] })?.width === 1920, "bad aspect string ignored");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
