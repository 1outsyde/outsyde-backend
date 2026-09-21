/**
 * Auth helper tests — run with: npx tsx server/auth.test.ts
 */

import { hashPassword, verifyPassword, isLegacyPassword, verifyLegacyPassword } from "./auth";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

async function run() {
  console.log("\n=== Auth Helper Tests ===\n");

  // --- isLegacyPassword ---
  console.log("isLegacyPassword:");
  assert(isLegacyPassword("c2VjcmV0"), 'base64 string → legacy');
  assert(isLegacyPassword("aGVsbG8="), 'base64 with padding → legacy');
  assert(!isLegacyPassword("$2b$10$abcdefghijklmnopqrstuvuABCDEFGHIJKLMNOPQRSTUVWXYZ01234"), '$2b$ prefix → not legacy');
  assert(!isLegacyPassword("$2a$10$abcdefghijklmnopqrstuvuABCDEFGHIJKLMNOPQRSTUVWXYZ01234"), '$2a$ prefix → not legacy');

  // --- verifyLegacyPassword ---
  console.log("\nverifyLegacyPassword:");
  const plain = "hunter2";
  const b64 = Buffer.from(plain).toString("base64");
  assert(verifyLegacyPassword(plain, b64), 'correct plaintext matches stored base64');
  assert(!verifyLegacyPassword("wrong", b64), 'wrong plaintext rejected');
  assert(!verifyLegacyPassword("", b64), 'empty string rejected');

  // --- hashPassword / verifyPassword roundtrip ---
  console.log("\nbcrypt roundtrip:");
  const hash = await hashPassword("mypassword");
  assert(hash.startsWith("$2b$"), 'hash starts with $2b$');
  assert(!isLegacyPassword(hash), 'bcrypt hash not flagged as legacy');
  assert(await verifyPassword("mypassword", hash), 'correct password verifies');
  assert(!(await verifyPassword("wrong", hash)), 'wrong password rejected');

  // --- migration scenario ---
  console.log("\nMigration scenario (legacy → bcrypt):");
  const password = "secretpass";
  const legacyHash = Buffer.from(password).toString("base64");
  assert(isLegacyPassword(legacyHash), 'legacy hash detected');
  assert(verifyLegacyPassword(password, legacyHash), 'legacy verify succeeds');
  // Simulate migration: hash with bcrypt
  const newHash = await hashPassword(password);
  assert(!isLegacyPassword(newHash), 'migrated hash no longer legacy');
  assert(await verifyPassword(password, newHash), 'migrated hash verifies with bcrypt');

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
