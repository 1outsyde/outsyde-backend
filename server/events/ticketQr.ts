/**
 * Signed QR images for tickets.
 *
 * The QR itself encodes only the ticket's 16 character code. The image URL never contains that code: it carries a
 * signed ticket id instead, so the server looks the code up itself.
 *
 *   token = base64url(ticketId) + "~" + first 22 chars of base64url(HMAC-SHA256(secret, "ticket-qr:" + ticketId))
 *
 * "~" separates the two parts because it is not in the base64url alphabet and, unlike ".", cannot collide with the
 * ".png" suffix in the route path. Secret is JWT_SECRET, else SESSION_SECRET; with neither, nothing verifies.
 */
import crypto from "crypto";
import QRCode from "qrcode";

const SIG_LEN = 22;
const SEP = "~";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const secret = (): string | null => process.env.JWT_SECRET || process.env.SESSION_SECRET || null;

function signature(ticketId: string, key: string): string {
  return crypto.createHmac("sha256", key).update("ticket-qr:" + ticketId).digest("base64url").slice(0, SIG_LEN);
}

export function qrTokenFor(ticketId: string): string {
  const key = secret() ?? "";
  return Buffer.from(ticketId, "utf8").toString("base64url") + SEP + signature(ticketId, key);
}

/** The ticket id inside a token whose signature checks out, else null. */
export function ticketIdFromQrToken(token: string): string | null {
  const key = secret();
  if (!key || typeof token !== "string") return null;
  const parts = token.split(SEP);
  if (parts.length !== 2 || !parts[0] || parts[1].length !== SIG_LEN) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const ticketId = Buffer.from(parts[0], "base64url").toString("utf8");
  if (!UUID_RE.test(ticketId)) return null;
  const want = Buffer.from(signature(ticketId, key));
  const got = Buffer.from(parts[1]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return ticketId;
}

export function qrUrlFor(ticketId: string): string {
  const path = `/api/events/qr/${qrTokenFor(ticketId)}.png`;
  const base = process.env.API_BASE_URL?.replace(/\/+$/, "");
  if (base) return base + path;
  if (process.env.NODE_ENV !== "production") return `http://localhost:${process.env.PORT || 5000}${path}`;
  return path;
}

export async function qrPng(code: string): Promise<Buffer> {
  return QRCode.toBuffer(code, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 512 });
}
