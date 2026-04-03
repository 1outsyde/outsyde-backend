/**
 * Apple Sign-In server-side verification.
 * Validates Apple identity tokens using Apple's public JWKS endpoint.
 */

import * as jose from 'jose';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

let cachedJWKS: jose.JSONWebKeySet | null = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getAppleJWKS(): Promise<jose.JSONWebKeySet> {
  if (cachedJWKS && Date.now() - jwksCachedAt < JWKS_CACHE_TTL) {
    return cachedJWKS;
  }

  const response = await fetch(APPLE_JWKS_URL);
  if (!response.ok) throw new Error('Failed to fetch Apple JWKS');
  
  cachedJWKS = await response.json() as jose.JSONWebKeySet;
  jwksCachedAt = Date.now();
  return cachedJWKS;
}

export interface AppleTokenPayload {
  sub: string;       // Apple user ID (stable across sessions)
  email?: string;
  email_verified?: string;
  is_private_email?: string;
}

/**
 * Verify an Apple identity token.
 * Returns the decoded payload if valid, throws on failure.
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  expectedAudience?: string
): Promise<AppleTokenPayload> {
  const jwks = await getAppleJWKS();
  const JWKS = jose.createLocalJWKSet(jwks);

  const audience = expectedAudience || process.env.APPLE_SERVICES_ID;
  if (!audience) {
    throw new Error('APPLE_SERVICES_ID environment variable is required for Apple Sign-In');
  }

  const { payload } = await jose.jwtVerify(identityToken, JWKS, {
    issuer: APPLE_ISSUER,
    audience,
  });

  if (!payload.sub) {
    throw new Error('Apple token missing sub claim');
  }

  return {
    sub: payload.sub as string,
    email: payload.email as string | undefined,
    email_verified: payload.email_verified as string | undefined,
    is_private_email: payload.is_private_email as string | undefined,
  };
}
