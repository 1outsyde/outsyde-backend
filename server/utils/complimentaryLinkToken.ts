import { createHash, randomBytes } from "crypto";

/**
 * Free-plan claim-link tokens.
 *
 * The raw token is 32 random bytes (256 bits), base64url-encoded (43 chars, no "."), shown to
 * the admin once and never stored. Only its sha256 hex goes into
 * complimentary_grant_links.token_hash. Grandfathered grant tokens (utils/grantToken.ts) contain
 * a "." and are signed, so the two formats can never be confused.
 */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function generate(): string {
  return randomBytes(32).toString("base64url");
}

export function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const complimentaryLinkToken = { generate, hash, TOKEN_RE };
