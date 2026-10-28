/**
 * TEST ONLY: makes a throwaway self-signed signer certificate, key and a fake "WWDR" certificate with openssl in a
 * temp folder, so Wallet pass tests can sign passes on localhost. Never used by the server.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

export type TestCerts = { signerCert: string; signerKey: string; wwdr: string; passphrase: string; signerKeyEncrypted: string; dir: string };

export function makeTestCerts(): TestCerts {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-certs-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "wwdr.key", "-out", "wwdr.pem", "-days", "2", "-subj", "/CN=Test WWDR"]);
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "signer.key", "-out", "signer.pem", "-days", "2",
    "-subj", "/UID=pass.com.goutsyde.tickets/CN=Pass Type ID: pass.com.goutsyde.tickets/OU=ABCDE12345/O=Outsyde Test"]);
  const passphrase = "test-pass-phrase";
  run(["pkcs8", "-topk8", "-in", "signer.key", "-out", "signer.enc.key", "-passout", `pass:${passphrase}`]);
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  return { signerCert: read("signer.pem"), signerKey: read("signer.key"), wwdr: read("wwdr.pem"), passphrase, signerKeyEncrypted: read("signer.enc.key"), dir };
}

/** Sets the Wallet env vars for a test run and returns a function that puts the old values back. */
export function setWalletEnv(c: TestCerts, overrides: Record<string, string | undefined> = {}): () => void {
  const keys = ["APPLE_PASS_TYPE_ID", "APPLE_TEAM_ID", "APPLE_PASS_CERT_PEM", "APPLE_PASS_KEY_PEM", "APPLE_PASS_KEY_PASSPHRASE", "APPLE_WWDR_PEM"];
  const old: Record<string, string | undefined> = {};
  for (const k of keys) old[k] = process.env[k];
  const next: Record<string, string | undefined> = {
    APPLE_PASS_TYPE_ID: "pass.com.goutsyde.tickets", APPLE_TEAM_ID: "ABCDE12345",
    APPLE_PASS_CERT_PEM: c.signerCert, APPLE_PASS_KEY_PEM: c.signerKey, APPLE_PASS_KEY_PASSPHRASE: undefined, APPLE_WWDR_PEM: c.wwdr,
    ...overrides,
  };
  for (const k of keys) { if (next[k] === undefined) delete process.env[k]; else process.env[k] = next[k]; }
  return () => { for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
}

/** Unzips a .pkpass buffer into { name: Buffer }. */
export function unzipPass(buf: Buffer): Record<string, Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-pass-"));
  const f = path.join(dir, "p.pkpass");
  fs.writeFileSync(f, buf);
  execFileSync("unzip", ["-q", "-o", f, "-d", path.join(dir, "x")], { stdio: "pipe" });
  const out: Record<string, Buffer> = {};
  for (const name of fs.readdirSync(path.join(dir, "x"))) out[name] = fs.readFileSync(path.join(dir, "x", name));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

/** True when `signature` is a valid detached PKCS#7 signature over `manifest` made by `signerCertPem`. */
export function signatureVerifies(signature: Buffer, manifest: Buffer, signerCertPem: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-sig-"));
  try {
    fs.writeFileSync(path.join(dir, "sig.der"), signature);
    fs.writeFileSync(path.join(dir, "manifest.json"), manifest);
    fs.writeFileSync(path.join(dir, "signer.pem"), signerCertPem);
    execFileSync("openssl", ["smime", "-verify", "-inform", "DER", "-in", "sig.der", "-content", "manifest.json", "-noverify",
      "-certfile", "signer.pem", "-out", "/dev/null"], { cwd: dir, stdio: "pipe" });
    const signers = execFileSync("openssl", ["pkcs7", "-inform", "DER", "-in", "sig.der", "-print_certs", "-noout"], { cwd: dir, encoding: "utf8" });
    return signers.includes("Pass Type ID: pass.com.goutsyde.tickets");
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
