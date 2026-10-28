/**
 * Apple Wallet passes: token, config and pass builder. Pure, no database. Run: npx tsx server/events/walletPass.test.ts
 * Needs openssl and unzip on the machine (both used only by the test helpers).
 *
 * Mutation checks:
 *  - skip the timingSafeEqual compare in ticketIdFromWalletToken → "tampered signature" fails.
 *  - sign with the "ticket-qr:" prefix → "a QR token is not a Wallet token" fails.
 *  - drop one env var from the required list in walletConfig → "missing <var>" fails.
 *  - always pass holderRevealed true → "day of event before the reveal shows city and state only" fails.
 *  - format When in UTC → "When is in the event's own time zone" fails.
 *  - put a different string in the barcode → "barcode message is the ticket code" fails.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { makeTestCerts, setWalletEnv, unzipPass, signatureVerifies } from "./walletTestCerts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 800)); }
}

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test";
  const { walletTokenFor, ticketIdFromWalletToken, walletConfig, walletUrlFor, buildTicketPass, resetWalletConfigCacheForTest } = await import("./walletPass");
  const { qrTokenFor } = await import("./ticketQr");
  const certs = makeTestCerts();
  const id1 = "11111111-2222-4333-8444-555555555555";
  const id2 = "99999999-2222-4333-8444-555555555555";

  console.log("\ntoken");
  const t1 = walletTokenFor(id1);
  assert(ticketIdFromWalletToken(t1) === id1, "round trip", t1);
  assert(walletTokenFor(id1) === t1, "deterministic");
  assert(walletTokenFor(id2) !== t1, "different tickets, different tokens");
  const [idPart, sig] = t1.split("~");
  assert(!!idPart && sig?.length === 22 && !t1.includes("."), "shape base64url(id) ~ 22 chars, no dot", t1);
  const flip = (s: string) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
  assert(ticketIdFromWalletToken(`${idPart}~${flip(sig)}`) === null, "tampered signature → null");
  assert(ticketIdFromWalletToken(`${Buffer.from(id2).toString("base64url")}~${sig}`) === null, "edited id with old signature → null");
  assert(ticketIdFromWalletToken(qrTokenFor(id1)) === null, "a QR token is not a Wallet token");
  assert(walletTokenFor(id1) !== qrTokenFor(id1), "Wallet token differs from the QR token");
  for (const bad of ["", "x", "~", `${idPart}~`, `${idPart}~${sig}~`, `${Buffer.from("not-a-uuid").toString("base64url")}~${sig}`]) {
    assert(ticketIdFromWalletToken(bad) === null, `malformed rejected: ${JSON.stringify(bad)}`);
  }
  {
    const keep = { j: process.env.JWT_SECRET, s: process.env.SESSION_SECRET };
    delete process.env.JWT_SECRET; delete process.env.SESSION_SECRET;
    assert(ticketIdFromWalletToken(t1) === null, "no secret: nothing verifies");
    process.env.JWT_SECRET = keep.j!; if (keep.s !== undefined) process.env.SESSION_SECRET = keep.s;
  }

  console.log("\nconfig");
  let restore = setWalletEnv(certs);
  resetWalletConfigCacheForTest();
  const cfg = walletConfig();
  assert(!!cfg && cfg.passTypeId === "pass.com.goutsyde.tickets" && cfg.teamId === "ABCDE12345", "all vars set → config", cfg && { p: cfg.passTypeId, t: cfg.teamId });
  restore();
  for (const k of ["APPLE_PASS_TYPE_ID", "APPLE_TEAM_ID", "APPLE_PASS_CERT_PEM", "APPLE_PASS_KEY_PEM", "APPLE_WWDR_PEM"]) {
    restore = setWalletEnv(certs, { [k]: undefined });
    resetWalletConfigCacheForTest();
    assert(walletConfig() === null, `missing ${k} → null`);
    assert(walletUrlFor(id1) === null, `missing ${k} → walletUrlFor null`);
    restore();
  }
  const badCases: Array<[string, Record<string, string>]> = [
    ["malformed cert", { APPLE_PASS_CERT_PEM: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----" }],
    ["malformed key", { APPLE_PASS_KEY_PEM: "garbage" }],
    ["malformed WWDR", { APPLE_WWDR_PEM: "not a pem" }],
    ["pass type id without pass. prefix", { APPLE_PASS_TYPE_ID: "com.goutsyde.tickets" }],
    ["team id wrong shape", { APPLE_TEAM_ID: "abc" }],
    ["key from another certificate", { APPLE_PASS_KEY_PEM: fs.readFileSync(path.join(certs.dir, "wwdr.key"), "utf8") }],
    ["encrypted key, no passphrase", { APPLE_PASS_KEY_PEM: certs.signerKeyEncrypted }],
    ["encrypted key, wrong passphrase", { APPLE_PASS_KEY_PEM: certs.signerKeyEncrypted, APPLE_PASS_KEY_PASSPHRASE: "wrong" }],
  ];
  for (const [name, o] of badCases) {
    restore = setWalletEnv(certs, o);
    resetWalletConfigCacheForTest();
    let threw = false; let got: unknown = "unset";
    try { got = walletConfig(); } catch { threw = true; }
    assert(!threw && got === null, `${name} → null, never throws`, { threw, got: !!got });
    restore();
  }
  restore = setWalletEnv(certs, { APPLE_PASS_KEY_PEM: certs.signerKeyEncrypted, APPLE_PASS_KEY_PASSPHRASE: certs.passphrase });
  resetWalletConfigCacheForTest();
  assert(walletConfig() !== null, "encrypted key + right passphrase → config");
  restore();
  const escaped = certs.signerCert.replace(/\n/g, "\\n");
  const b64 = Buffer.from(certs.signerCert).toString("base64");
  restore = setWalletEnv(certs, { APPLE_PASS_CERT_PEM: escaped });
  resetWalletConfigCacheForTest();
  const cEsc = walletConfig();
  restore();
  restore = setWalletEnv(certs, { APPLE_PASS_CERT_PEM: b64 });
  resetWalletConfigCacheForTest();
  const cB64 = walletConfig();
  restore();
  assert(!!cEsc && !!cB64 && cEsc.signerCert.trim() === certs.signerCert.trim() && cB64.signerCert.trim() === certs.signerCert.trim(),
    "literal \\n and base64 PEMs normalise to the real PEM");

  console.log("\nwalletUrlFor");
  restore = setWalletEnv(certs);
  resetWalletConfigCacheForTest();
  const prevBase = process.env.API_BASE_URL;
  process.env.API_BASE_URL = "https://api.example.test/";
  assert(walletUrlFor(id1) === `https://api.example.test/api/events/wallet/${t1}.pkpass`, "url with API_BASE_URL, trailing slash trimmed", walletUrlFor(id1));
  if (prevBase === undefined) delete process.env.API_BASE_URL; else process.env.API_BASE_URL = prevBase;

  console.log("\nimages");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const size = (f: string) => { const b = fs.readFileSync(path.join(here, "walletAssets", f)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  for (const [f, s] of [["icon.png", 29], ["icon@2x.png", 58], ["icon@3x.png", 87], ["logo.png", 50], ["logo@2x.png", 100], ["logo@3x.png", 150]] as const) {
    const got = size(f);
    assert(got[0] === s && got[1] === s, `${f} is ${s}x${s}`, got);
  }

  console.log("\nbuild");
  const conf = walletConfig()!;
  const baseEvent = {
    title: "Rooftop Night 🎉 Café Música", startsAt: new Date("2026-11-07T02:00:00Z"), endsAt: new Date("2026-11-07T07:00:00Z"),
    timezone: "America/Los_Angeles", addressVisibility: "ticket_holders" as const,
    venueName: "The Loft", addressLine1: "12 Main St", addressLine2: "Floor 3", city: "Los Angeles", state: "CA", postalCode: "90012",
  };
  const input = { ticketId: id1, code: "ABCD2345EFGH6789", ticketTypeName: "General Admission", holderFirstName: "José", event: baseEvent };
  const buf = await buildTicketPass(input, conf, new Date("2026-11-01T12:00:00Z"));
  assert(buf.subarray(0, 2).toString() === "PK", "result is a zip");
  const files = unzipPass(buf);
  for (const f of ["pass.json", "manifest.json", "signature", "icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png"]) {
    assert(!!files[f], `zip has ${f}`);
  }
  const pj = JSON.parse(files["pass.json"].toString("utf8"));
  assert(pj.formatVersion === 1 && pj.passTypeIdentifier === "pass.com.goutsyde.tickets" && pj.teamIdentifier === "ABCDE12345", "ids", pj);
  assert(pj.serialNumber === id1 && pj.organizationName === "Outsyde", "serial = ticket id, org Outsyde");
  assert(pj.backgroundColor === "rgb(26, 26, 26)" && pj.foregroundColor === "rgb(245, 240, 232)" && pj.labelColor === "rgb(232, 185, 48)", "colors", [pj.backgroundColor, pj.foregroundColor, pj.labelColor]);
  const bc = pj.barcodes?.[0];
  assert(bc?.format === "PKBarcodeFormatQR" && bc.message === "ABCD2345EFGH6789" && bc.messageEncoding === "iso-8859-1" && bc.altText === "ABCD2345EFGH6789", "barcode message is the ticket code", bc);
  assert(pj.relevantDate === "2026-11-07T02:00:00.000Z" || new Date(pj.relevantDate).getTime() === baseEvent.startsAt.getTime(), "relevantDate = start", pj.relevantDate);
  assert(new Date(pj.expirationDate).getTime() === baseEvent.endsAt.getTime(), "expirationDate = end", pj.expirationDate);
  assert(Array.isArray(pj.associatedStoreIdentifiers) && pj.associatedStoreIdentifiers[0] === 6738926870, "links the Outsyde app", pj.associatedStoreIdentifiers);
  const all = [...(pj.eventTicket.primaryFields || []), ...(pj.eventTicket.secondaryFields || []), ...(pj.eventTicket.auxiliaryFields || []), ...(pj.eventTicket.backFields || []), ...(pj.eventTicket.headerFields || [])];
  const field = (k: string) => all.find((f: any) => f.key === k);
  assert(field("event")?.value === "Rooftop Night 🎉 Café Música", "title with emoji and accents survives", field("event"));
  assert(field("when")?.value === "Fri, Nov 6, 6:00 PM", "When is in the event's own time zone", field("when"));
  assert(field("ticket")?.value === "General Admission", "ticket type");
  assert(field("name")?.value === "José", "holder first name");
  assert(String(field("where")?.value).includes("The Loft") && String(field("address")?.value).includes("12 Main St") && String(field("address")?.value).includes("90012"), "ticket holders: full address shown", [field("where"), field("address")]);
  assert(String(field("door")?.value) === "Show this QR code at the door. Each code lets one person in.", "door line", field("door"));
  assert(String(field("app")?.value).includes("Get the Outsyde app") && String(field("app")?.value).includes("apps.apple.com"), "app line", field("app"));
  const text = JSON.stringify(pj);
  assert(!/ - |—|–/.test(text.replace(/"key":"[^"]*"/g, "")), "no dashes in pass copy");
  const manifest = JSON.parse(files["manifest.json"].toString("utf8"));
  const sha1 = (b: Buffer) => crypto.createHash("sha1").update(b).digest("hex");
  assert(Object.keys(files).filter((f) => f !== "manifest.json" && f !== "signature").every((f) => manifest[f] === sha1(files[f])), "manifest SHA1 matches every file");
  assert(signatureVerifies(files["signature"], files["manifest.json"], certs.signerCert), "signature is a valid PKCS#7 over the manifest by the signer");

  console.log("\nday of event address");
  const dayOf = { ...input, event: { ...baseEvent, addressVisibility: "ticket_holders_day_of" as const } };
  const before = JSON.parse(unzipPass(await buildTicketPass(dayOf, conf, new Date("2026-11-06T12:00:00Z")))["pass.json"].toString("utf8"));
  const bAll = [...before.eventTicket.secondaryFields, ...before.eventTicket.backFields];
  const bWhere = bAll.find((f: any) => f.key === "where")?.value;
  const bAddr = bAll.find((f: any) => f.key === "address")?.value;
  assert(bWhere === "Los Angeles, CA" && !JSON.stringify(before).includes("12 Main St") && !JSON.stringify(before).includes("The Loft"), "day of event before the reveal shows city and state only", { bWhere, bAddr });
  assert(String(bAddr).includes("appears in My Tickets on Outsyde on the day of the event"), "reveal note on the back", bAddr);
  const after = JSON.parse(unzipPass(await buildTicketPass(dayOf, conf, new Date("2026-11-06T18:00:00Z")))["pass.json"].toString("utf8"));
  assert(JSON.stringify(after).includes("12 Main St"), "day of event after the reveal shows the full address");
  const pub = JSON.parse(unzipPass(await buildTicketPass({ ...input, event: { ...baseEvent, addressVisibility: "public" as const } }, conf))["pass.json"].toString("utf8"));
  assert(JSON.stringify(pub).includes("12 Main St"), "public address shown");

  console.log("\nedge cases");
  const noName = JSON.parse(unzipPass(await buildTicketPass({ ...input, holderFirstName: null }, conf))["pass.json"].toString("utf8"));
  assert(![...noName.eventTicket.auxiliaryFields].some((f: any) => f.key === "name"), "no first name → no Name field");
  const blankName = JSON.parse(unzipPass(await buildTicketPass({ ...input, holderFirstName: "   " }, conf))["pass.json"].toString("utf8"));
  assert(![...blankName.eventTicket.auxiliaryFields].some((f: any) => f.key === "name"), "blank first name → no Name field");
  const noAddr = { ...input, event: { ...baseEvent, venueName: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null } };
  const na = JSON.parse(unzipPass(await buildTicketPass(noAddr, conf))["pass.json"].toString("utf8"));
  assert(typeof na.serialNumber === "string", "no address at all still builds");
  const long = { ...input, event: { ...baseEvent, title: "A".repeat(300) } };
  assert((await buildTicketPass(long, conf)).subarray(0, 2).toString() === "PK", "300 character title still builds");
  const ny = JSON.parse(unzipPass(await buildTicketPass({ ...input, event: { ...baseEvent, timezone: "America/New_York" } }, conf))["pass.json"].toString("utf8"));
  assert([...ny.eventTicket.secondaryFields].find((f: any) => f.key === "when")?.value === "Fri, Nov 6, 9:00 PM", "New York event shows New York time");

  restore();
  fs.rmSync(certs.dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
