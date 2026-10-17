/**
 * Video cover helpers + Mux webhook signature — pure tests, no DB, no network. Run with:
 *   npx tsx server/coverMediaVideo.test.ts
 */
import { createHmac } from "crypto";
import {
  coverPosterUrl,
  isMuxUploadId,
  muxPlaybackIdFromUrl,
  resolveCoverVideoValue,
} from "./coverMedia";
import { verifyMuxSignature } from "./muxWebhookSignature";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const PLAYBACK = "ZNi92f02p9Nrh7Hs91YJBo5EA02p01DYmGSR013Bwt00FTP4";
const M3U8 = `https://stream.mux.com/${PLAYBACK}.m3u8`;
const UPLOAD = "OA02dANZQXQ01Xx4n8JoU1hKFU00eSaS6eBUqZkk01EjIU";
const R2 = "https://pub-3eedcbff3d38496598a620e7bc45085b.r2.dev/covers/a.jpg";

(async () => {
  console.log("isMuxUploadId");
  assert(isMuxUploadId(UPLOAD), "upload id accepted");
  assert(!isMuxUploadId(M3U8), "URL is not an upload id");
  assert(!isMuxUploadId(R2), "R2 URL is not an upload id");
  assert(!isMuxUploadId("file:///var/mobile/x.jpg"), "phone path is not an upload id");
  assert(!isMuxUploadId(""), "empty is not an upload id");
  assert(!isMuxUploadId(null), "null is not an upload id");
  assert(!isMuxUploadId("abc"), "too short is not an upload id");

  console.log("muxPlaybackIdFromUrl");
  assert(muxPlaybackIdFromUrl(M3U8) === PLAYBACK, "playback id parsed");
  assert(muxPlaybackIdFromUrl(R2) === null, "R2 → null");
  assert(muxPlaybackIdFromUrl("https://stream.mux.com.evil.com/x.m3u8") === null, "look-alike host → null");

  console.log("coverPosterUrl");
  assert(coverPosterUrl(M3U8, "video") === `https://image.mux.com/${PLAYBACK}/thumbnail.jpg`, "video → Mux thumbnail");
  assert(coverPosterUrl(UPLOAD, "video") === null, "processing video → null");
  assert(coverPosterUrl(R2, "image") === R2, "image → itself");
  assert(coverPosterUrl("https://goutsyde.com/lifestyle-tea.jpg", null) === "https://goutsyde.com/lifestyle-tea.jpg", "legacy null type image → itself (Lotus)");
  assert(coverPosterUrl(M3U8, "image") === `https://image.mux.com/${PLAYBACK}/thumbnail.jpg`, "mislabelled Mux URL still gives a picture");
  assert(coverPosterUrl("file:///var/mobile/x.jpg", null) === null, "phone path → null (Stuff Outsyde)");
  assert(coverPosterUrl(null, "image") === null, "no cover → null");

  console.log("resolveCoverVideoValue");
  const ready = async () => ({ playbackId: PLAYBACK, status: "ready" });
  const preparing = async () => ({ playbackId: "", status: "preparing" });
  const missing = async () => null;
  const throws = async () => { throw new Error("mux down"); };
  let calls = 0;
  const counting = async () => { calls++; return { playbackId: PLAYBACK, status: "ready" }; };
  assert((await resolveCoverVideoValue(UPLOAD, "video", ready)) === M3U8, "ready upload → playable URL");
  assert((await resolveCoverVideoValue(UPLOAD, "video", preparing)) === UPLOAD, "still processing → upload id kept");
  assert((await resolveCoverVideoValue(UPLOAD, "video", missing)) === UPLOAD, "no asset yet → upload id kept");
  assert((await resolveCoverVideoValue(UPLOAD, "video", throws)) === UPLOAD, "Mux error → upload id kept, no throw");
  assert((await resolveCoverVideoValue(R2, "image", counting)) === R2 && calls === 0, "image → unchanged, no lookup");
  assert((await resolveCoverVideoValue(M3U8, "video", counting)) === M3U8 && calls === 0, "already playable → unchanged, no lookup");
  assert((await resolveCoverVideoValue(null, "video", counting)) === null && calls === 0, "null → null");
  assert((await resolveCoverVideoValue(undefined, undefined, counting)) === undefined && calls === 0, "undefined → undefined");
  assert((await resolveCoverVideoValue(UPLOAD, undefined, counting)) === UPLOAD && calls === 0, "no type → unchanged");

  console.log("verifyMuxSignature");
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ type: "video.asset.ready", data: { id: "a1" } });
  const now = 1_760_000_000;
  const sign = (t: number, b = body, s = secret) => createHmac("sha256", s).update(`${t}.${b}`).digest("hex");
  const header = (t: number, sig = sign(t)) => `t=${t},v1=${sig}`;
  const r0 = verifyMuxSignature(Buffer.from(body), undefined, undefined, now);
  assert(r0.ok && !r0.enforced, "no secret → accepted, not enforced (current behaviour)");
  assert(verifyMuxSignature(Buffer.from(body), header(now), secret, now).ok, "valid signature accepted");
  assert(verifyMuxSignature(body, header(now), secret, now).ok, "string body accepted");
  assert(verifyMuxSignature(Buffer.from(body), [header(now)], secret, now).ok, "array header accepted");
  assert(verifyMuxSignature(Buffer.from(body), `t=${now},v1=deadbeef,v1=${sign(now)}`, secret, now).ok, "any matching v1 accepted");
  assert(!verifyMuxSignature(Buffer.from(body + " "), header(now), secret, now).ok, "tampered body rejected");
  assert(!verifyMuxSignature(Buffer.from(body), header(now, sign(now, body, "other")), secret, now).ok, "wrong secret rejected");
  assert(!verifyMuxSignature(Buffer.from(body), undefined, secret, now).ok, "missing header rejected");
  assert(!verifyMuxSignature(Buffer.from(body), "garbage", secret, now).ok, "malformed header rejected");
  assert(!verifyMuxSignature(Buffer.from(body), `t=${now},v1=zz`, secret, now).ok, "non-hex signature rejected");
  assert(!verifyMuxSignature(Buffer.from(body), header(now - 301), secret, now).ok, "old timestamp rejected");
  assert(!verifyMuxSignature(Buffer.from(body), header(now + 301), secret, now).ok, "future timestamp rejected");
  assert(verifyMuxSignature(Buffer.from(body), header(now - 299), secret, now).ok, "timestamp inside tolerance accepted");
  assert(!verifyMuxSignature(undefined, header(now), secret, now).ok, "no raw body rejected when enforced");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
