/**
 * Mux direct upload link lifetime — run with: npx tsx server/muxUploadTimeout.test.ts
 * No network: the Mux SDK call is replaced, so this only checks what createMuxUploadUrl asks for.
 */
process.env.MUX_TOKEN_ID ??= "test";
process.env.MUX_TOKEN_SECRET ??= "test";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

(async () => {
  const { mux, createMuxUploadUrl, MUX_UPLOAD_TIMEOUT_SECONDS } = await import("./services/mux");
  let sent: any = null;
  (mux.video.uploads as any).create = async (body: any) => {
    sent = body;
    return { id: "up_123", url: "https://storage.example/upload" };
  };

  const result = await createMuxUploadUrl();
  assert(result.uploadId === "up_123" && result.uploadUrl === "https://storage.example/upload", "returns the upload id and url", result);
  assert(sent?.timeout === 21600, "upload link lasts 6 hours (21600 s)", sent);
  assert(MUX_UPLOAD_TIMEOUT_SECONDS >= 60 && MUX_UPLOAD_TIMEOUT_SECONDS <= 604800, "inside Mux's allowed range");
  assert(sent?.cors_origin === "*", "cors_origin unchanged", sent);
  assert(
    sent?.new_asset_settings?.playback_policies?.[0] === "public" && sent?.new_asset_settings?.video_quality === "basic",
    "asset settings unchanged (public, basic)",
    sent,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
