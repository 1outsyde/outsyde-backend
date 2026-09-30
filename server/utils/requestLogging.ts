/**
 * Pure helpers for the request logger and the global error handler in server/index.ts
 * (kept here so they can be unit-tested without booting the server).
 */

/** The one route whose JSON response carries a secret: { linkExpiresAt, url: ".../subscribe/free/<token>" }. */
export const COMPLIMENTARY_LINK_CREATE_PATH = "/api/admin/subscription/complimentary-link";

/**
 * Body to log for "METHOD path status :: <JSON>". Only POST /api/admin/subscription/complimentary-link
 * is touched: a shallow copy with `url` replaced by "[redacted]". Every other request gets the
 * SAME object back, so its log line is byte-identical to before.
 */
export function loggedResponseBody<T extends Record<string, any> | undefined>(
  method: string,
  path: string,
  body: T,
): T | Record<string, any> {
  if (body && method === "POST" && path === COMPLIMENTARY_LINK_CREATE_PATH && "url" in body) {
    return { ...body, url: "[redacted]" };
  }
  return body;
}

/**
 * Arguments for the global error handler's console.error. A malformed JSON body
 * (body-parser `entity.parse.failed`) gets a fixed line: its message can quote part of the body,
 * which may hold a claim token. Everything else is logged exactly as before.
 */
export function errorLogArgs(err: any): unknown[] {
  if (err && err.type === "entity.parse.failed") {
    return ["[ERROR] Malformed JSON body"];
  }
  return [`[ERROR] ${err.message || 'Unknown error'}`, err.stack || ''];
}
