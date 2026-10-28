/**
 * Apple Wallet passes for tickets (p3-wallet).
 *
 * Each valid ticket can be downloaded as a signed .pkpass from a private link:
 *
 *   /api/events/wallet/<token>.pkpass
 *   token = base64url(ticketId) + "~" + first 22 chars of base64url(HMAC-SHA256(secret, "ticket-wallet:" + ticketId))
 *
 * Same shape as the QR image token (ticketQr.ts) with its own prefix, so a leaked QR image link can't open a pass and
 * the other way round. Secret is JWT_SECRET, else SESSION_SECRET.
 *
 * The pass carries the same QR content as the ticket today (the 16 character code), so the door scanners need no
 * change. Everything is off (walletUrlFor returns null, the route 404s) until every Apple value below is set and
 * parses:
 *   APPLE_PASS_TYPE_ID, APPLE_TEAM_ID, APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM, APPLE_WWDR_PEM
 *   APPLE_PASS_KEY_PASSPHRASE (only when the key is encrypted)
 * A PEM value may be pasted with real newlines, with literal "\n", or as base64 of the whole PEM.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PKPass } from "passkit-generator";
import { holderCanSeeAddress, type AddressVisibility } from "./eventRules";

const SIG_LEN = 22;
const SEP = "~";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Outsyde app on the App Store (same id as outsyde-web lib/app-stores.ts). */
const APP_STORE_ID = 6738926870;
const APP_STORE_URL = "https://apps.apple.com/app/outsyde/id6738926870";

const secret = (): string | null => process.env.JWT_SECRET || process.env.SESSION_SECRET || null;

function signature(ticketId: string, key: string): string {
  return crypto.createHmac("sha256", key).update("ticket-wallet:" + ticketId).digest("base64url").slice(0, SIG_LEN);
}

export function walletTokenFor(ticketId: string): string {
  return Buffer.from(ticketId, "utf8").toString("base64url") + SEP + signature(ticketId, secret() ?? "");
}

/** The ticket id inside a Wallet token whose signature checks out, else null. */
export function ticketIdFromWalletToken(token: string): string | null {
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

export type WalletConfig = {
  passTypeId: string;
  teamId: string;
  signerCert: string;
  signerKey: string;
  signerKeyPassphrase?: string;
  wwdr: string;
};

/** Real newlines, literal "\n" or base64 of the PEM, all to a plain PEM string. Null when it isn't a PEM. */
function normalisePem(raw: string | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  if (!v.includes("-----BEGIN")) {
    try { v = Buffer.from(v, "base64").toString("utf8").trim(); } catch { return null; }
  }
  if (!v.includes("-----BEGIN")) return null;
  return v.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n") + "\n";
}

let cache: { key: string; value: WalletConfig | null; validTo: number } | null = null;
let warned = "";

function warnOnce(why: string) {
  if (warned === why) return;
  warned = why;
  console.warn(`[wallet] Apple Wallet passes are off: ${why}`);
}

/** The Apple signing setup, or null when anything is missing or doesn't parse. Never throws. */
export function walletConfig(): WalletConfig | null {
  const env = process.env;
  const key = [env.APPLE_PASS_TYPE_ID, env.APPLE_TEAM_ID, env.APPLE_PASS_CERT_PEM, env.APPLE_PASS_KEY_PEM, env.APPLE_PASS_KEY_PASSPHRASE, env.APPLE_WWDR_PEM]
    .map((v) => v ?? "").join("\u0000");
  if (!cache || cache.key !== key) {
    const value = readConfig();
    cache = { key, value, validTo: value ? Date.parse(new crypto.X509Certificate(value.signerCert).validTo) : 0 };
  }
  if (cache.value && !(cache.validTo > Date.now())) {
    warnOnce("the pass certificate has expired (renew it in Apple Developer and update APPLE_PASS_CERT_PEM)");
    return null;
  }
  return cache.value;
}

function readConfig(): WalletConfig | null {
  const env = process.env;
  const passTypeId = env.APPLE_PASS_TYPE_ID?.trim();
  const teamId = env.APPLE_TEAM_ID?.trim();
  if (!passTypeId && !teamId && !env.APPLE_PASS_CERT_PEM && !env.APPLE_PASS_KEY_PEM && !env.APPLE_WWDR_PEM) return null; // not set up yet: quiet
  try {
    if (!passTypeId || !/^pass\.[A-Za-z0-9.-]+$/.test(passTypeId)) { warnOnce("APPLE_PASS_TYPE_ID missing or not pass.*"); return null; }
    if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) { warnOnce("APPLE_TEAM_ID missing or not 10 letters and digits"); return null; }
    const signerCert = normalisePem(env.APPLE_PASS_CERT_PEM);
    const signerKey = normalisePem(env.APPLE_PASS_KEY_PEM);
    const wwdr = normalisePem(env.APPLE_WWDR_PEM);
    if (!signerCert || !signerKey || !wwdr) { warnOnce("a certificate or key is missing or not a PEM"); return null; }
    const passphrase = env.APPLE_PASS_KEY_PASSPHRASE || undefined;
    new crypto.X509Certificate(signerCert);
    new crypto.X509Certificate(wwdr);
    const pk = crypto.createPrivateKey({ key: signerKey, format: "pem", passphrase });
    const x = new crypto.X509Certificate(signerCert);
    if (!x.checkPrivateKey(pk)) { warnOnce("the key doesn't belong to the pass certificate"); return null; }
    if (Date.parse(x.validFrom) > Date.now()) { warnOnce("the pass certificate isn't valid yet"); return null; }
    return { passTypeId, teamId, signerCert, signerKey, signerKeyPassphrase: passphrase, wwdr };
  } catch {
    warnOnce("a certificate, key or passphrase doesn't parse");
    return null;
  }
}

/** Test hook: forget the cached config (env changed inside one process). */
export function resetWalletConfigCacheForTest() { cache = null; warned = ""; }

/** The pass download link for a ticket, or null while Wallet isn't configured. Same base URL rule as qrUrlFor. */
export function walletUrlFor(ticketId: string): string | null {
  if (!secret() || !walletConfig()) return null;
  const p = `/api/events/wallet/${walletTokenFor(ticketId)}.pkpass`;
  const base = process.env.API_BASE_URL?.replace(/\/+$/, "");
  if (base) return base + p;
  if (process.env.NODE_ENV !== "production") return `http://localhost:${process.env.PORT || 5000}${p}`;
  return p;
}

export type TicketPassInput = {
  ticketId: string;
  code: string;
  ticketTypeName: string;
  holderFirstName: string | null;
  event: {
    title: string;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    addressVisibility: AddressVisibility;
    venueName: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
};

/**
 * Folder of the pass images. Worked out when first needed, never at import: a CJS bundle (script/build.ts) has no
 * import.meta.url, so it falls back to the repo path from the working directory (Render runs from the repo root).
 */
export function walletAssetsDir(moduleUrl: string | undefined = typeof import.meta !== "undefined" ? import.meta.url : undefined): string {
  if (moduleUrl) {
    try { return path.join(path.dirname(fileURLToPath(moduleUrl)), "walletAssets"); } catch { /* fall through */ }
  }
  return path.resolve(process.cwd(), "server", "events", "walletAssets");
}
const ASSET_NAMES = ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png"];
let assets: Record<string, Buffer> | null = null;
function passImages(): Record<string, Buffer> {
  if (!assets) { const dir = walletAssetsDir(); assets = Object.fromEntries(ASSET_NAMES.map((n) => [n, fs.readFileSync(path.join(dir, n))])); }
  return assets;
}

/** "Fri, Nov 6, 9:00 PM" in the event's own time zone. */
function whenText(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(d).replace(/[  ]/g, " ");
}

const join = (parts: Array<string | null | undefined>, sep: string) => parts.map((p) => (p ?? "").trim()).filter(Boolean).join(sep);

/** Builds the signed .pkpass. `now` decides the day of event address rule. No file writes. */
export async function buildTicketPass(t: TicketPassInput, cfg: WalletConfig, now: Date = new Date()): Promise<Buffer> {
  const e = t.event;
  const revealed = holderCanSeeAddress(e.addressVisibility, e.startsAt, e.timezone, now);
  const area = join([e.city, e.state], ", ");
  const street = join([e.venueName, e.addressLine1, e.addressLine2, join([join([e.city, e.state], ", "), e.postalCode], " ")], "\n");
  const where = revealed ? (join([e.venueName], "") || join([e.addressLine1], "") || area) : area;

  const pass = new PKPass(
    { ...passImages() },
    { wwdr: cfg.wwdr, signerCert: cfg.signerCert, signerKey: cfg.signerKey, signerKeyPassphrase: cfg.signerKeyPassphrase },
    {
      serialNumber: t.ticketId,
      passTypeIdentifier: cfg.passTypeId,
      teamIdentifier: cfg.teamId,
      organizationName: "Outsyde",
      description: `Ticket for ${e.title}`.slice(0, 200),
      backgroundColor: "rgb(26, 26, 26)",
      foregroundColor: "rgb(245, 240, 232)",
      labelColor: "rgb(232, 185, 48)",
      associatedStoreIdentifiers: [APP_STORE_ID],
      sharingProhibited: true,
    },
  );
  pass.type = "eventTicket";
  pass.primaryFields.push({ key: "event", label: "EVENT", value: e.title });
  pass.secondaryFields.push({ key: "when", label: "WHEN", value: whenText(e.startsAt, e.timezone) });
  if (where) pass.secondaryFields.push({ key: "where", label: "WHERE", value: where });
  pass.auxiliaryFields.push({ key: "ticket", label: "TICKET", value: t.ticketTypeName });
  const first = t.holderFirstName?.trim();
  if (first) pass.auxiliaryFields.push({ key: "name", label: "NAME", value: first });

  pass.backFields.push({ key: "door", label: "AT THE DOOR", value: "Show this QR code at the door. Each code lets one person in." });
  pass.backFields.push({
    key: "address",
    label: "ADDRESS",
    value: revealed
      ? (street || "The host hasn't added an address yet. Check My Tickets on Outsyde.")
      : `${area ? area + ". " : ""}The full address appears in My Tickets on Outsyde on the day of the event.`,
  });
  pass.backFields.push({ key: "code", label: "TICKET CODE", value: t.code });
  pass.backFields.push({ key: "app", label: "OUTSYDE", value: `Get the Outsyde app for faster checkout and all your tickets in one place. ${APP_STORE_URL}` });

  pass.setBarcodes({ format: "PKBarcodeFormatQR", message: t.code, messageEncoding: "iso-8859-1", altText: t.code });
  pass.setRelevantDate(e.startsAt);
  pass.setExpirationDate(e.endsAt);
  return pass.getAsBuffer();
}

/**
 * buildTicketPass with a small in memory cache (signing costs about 50 ms of CPU on a public route). The key covers
 * everything that goes into the pass, the address reveal state at `now` and the signing setup, so an event edit,
 * the reveal passing or a new certificate all build a fresh pass. Holds at most 300 passes.
 */
const PASS_CACHE_MAX = 300;
const passCache = new Map<string, Buffer>();
export async function cachedTicketPass(t: TicketPassInput, cfg: WalletConfig, now: Date = new Date()): Promise<Buffer> {
  const revealed = holderCanSeeAddress(t.event.addressVisibility, t.event.startsAt, t.event.timezone, now);
  const key = crypto.createHash("sha256").update(JSON.stringify([t, revealed, cfg.passTypeId, cfg.teamId, cfg.signerCert, cfg.wwdr])).digest("base64url");
  const hit = passCache.get(key);
  if (hit) { passCache.delete(key); passCache.set(key, hit); return hit; }
  const built = await buildTicketPass(t, cfg, now);
  passCache.set(key, built);
  while (passCache.size > PASS_CACHE_MAX) passCache.delete(passCache.keys().next().value as string);
  return built;
}
