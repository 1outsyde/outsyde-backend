// Client-site origins: the vendor sites that are always allowed by CORS (dev and prod), and the
// only origins a Stripe Connect `vendor-site` return/refresh may redirect back to.
export const clientSiteOrigins = [
  'http://localhost:3001',           // xo-lashes-web local dev
  'https://xobeautyandlashes.com',   // xo-lashes-web production
  'https://lotushouseblends.com',    // LHB custom domain
  'https://www.lotushouseblends.com',
  'https://braids-with-love-site.vercel.app',
  'https://www.braids-with-love-site.vercel.app',
  'https://braidsbylana.com',
  'https://www.braidsbylana.com',
  'https://braids-with-lana-site.vercel.app',
  'https://nail-sniper-web.vercel.app', // The Nail Sniper (custom domain to be added later)
];

/** Drops one trailing slash, so "https://site.com/" and "https://site.com" compare equal. */
export function normalizeClientOrigin(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin;
}

/** Exact string match against clientSiteOrigins (after normalizeClientOrigin). No prefix or regex matching. */
export function isAllowedClientOrigin(origin: unknown): origin is string {
  return typeof origin === 'string' && clientSiteOrigins.includes(normalizeClientOrigin(origin));
}
