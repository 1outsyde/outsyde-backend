import { createHmac, timingSafeEqual } from "crypto";

// Mux webhook signature check (R10).
// Header format: "Mux-Signature: t=<unix seconds>,v1=<hex hmac-sha256>"
// Signed payload: `${t}.${rawBody}` with the webhook signing secret.
// https://docs.mux.com/core/verify-webhook-signatures

export const MUX_SIGNATURE_TOLERANCE_SECONDS = 300;

export type MuxSignatureResult =
  | { ok: true; enforced: boolean }
  | { ok: false; reason: string };

/**
 * Only enforced when a secret is configured (MUX_WEBHOOK_SECRET). With no
 * secret the webhook keeps working exactly as before, so deploying this code
 * before the env var is set changes nothing.
 */
export function verifyMuxSignature(
  rawBody: Buffer | string | undefined,
  header: string | string[] | undefined,
  secret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): MuxSignatureResult {
  if (!secret) return { ok: true, enforced: false };
  if (rawBody === undefined) return { ok: false, reason: "raw body unavailable" };
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return { ok: false, reason: "missing Mux-Signature header" };

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of value.split(",")) {
    const [k, v] = part.split("=", 2).map((x) => x?.trim());
    if (k === "t") timestamp = v;
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    return { ok: false, reason: "malformed Mux-Signature header" };
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > MUX_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const matched = signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matched ? { ok: true, enforced: true } : { ok: false, reason: "signature mismatch" };
}
