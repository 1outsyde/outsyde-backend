/**
 * R35 (2026-10-28): where the password reset email may send people.
 *
 * POST /api/auth/forgot-password lets a vendor site pass `redirect_uri` so the emailed link opens
 * that site's own /reset-password page. It used to be taken as is, so anyone could make Outsyde
 * email a customer a real reset token on a link to their own site. Now only Outsyde's own sites
 * are kept; anything else becomes FRONTEND_URL (goutsyde.com).
 *
 * The list: every https entry of clientSiteOrigins, plus braidswithlove.com (what braids-with-love-site
 * sends; not in clientSiteOrigins, which also drives CORS and is left unchanged), plus goutsyde.com.
 */
import { clientSiteOrigins } from "./clientOrigins";

const DEFAULT_FRONTEND = "https://www.goutsyde.com";

export const RESET_LINK_SITES: readonly string[] = Array.from(new Set([
  ...clientSiteOrigins.filter((o) => o.startsWith("https://")),
  "https://braidswithlove.com",
  "https://www.braidswithlove.com",
  "https://goutsyde.com",
  "https://www.goutsyde.com",
]));

/** "scheme://host[:port]" in lower case, or null when the value isn't a plain http(s) origin. */
function originOf(value: string): string | null {
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.username || u.password) return null;
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return null;
  return `${u.protocol}//${u.host}`.toLowerCase();
}

function frontendBase(env: NodeJS.ProcessEnv): string {
  const f = typeof env.FRONTEND_URL === "string" ? originOf(env.FRONTEND_URL) : null;
  return f ?? DEFAULT_FRONTEND;
}

/** The base of the emailed reset link: the requested site when it is one of ours, else FRONTEND_URL. */
export function resetLinkBase(redirectUri: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const fallback = frontendBase(env);
  if (typeof redirectUri !== "string" || !redirectUri) return fallback;
  const origin = originOf(redirectUri);
  if (origin && (origin === fallback || RESET_LINK_SITES.includes(origin))) return origin;
  console.warn(`[forgot-password] redirect_uri not allowed, using ${fallback}: ${JSON.stringify(redirectUri.slice(0, 200))}`);
  return fallback;
}
