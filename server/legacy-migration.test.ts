/**
 * Legacy password migration integration test.
 *
 * Simulates the full login flow for a user with a legacy Base64 password:
 *   1. Verify login succeeds with the Base64 hash
 *   2. Verify migration writes a bcrypt hash to storage
 *   3. Verify bcrypt hash verifies the original plaintext (second login works)
 *
 * Run with: JWT_SECRET=test-secret npx tsx server/legacy-migration.test.ts
 */

import {
  hashPassword,
  verifyPassword,
  isLegacyPassword,
  verifyLegacyPassword,
} from "./auth";

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

// Simulates the authenticateUser logic from both login routes
async function simulateLogin(
  plaintext: string,
  storedHash: string,
  updateUser: (newHash: string) => Promise<void>
): Promise<{ success: boolean; migrated: boolean }> {
  let isValidPassword = false;
  const legacy = isLegacyPassword(storedHash);

  if (legacy) {
    isValidPassword = verifyLegacyPassword(plaintext, storedHash);
  } else {
    isValidPassword = await verifyPassword(plaintext, storedHash);
  }

  if (!isValidPassword) return { success: false, migrated: false };

  let migrated = false;
  if (legacy) {
    const bcryptHash = await hashPassword(plaintext);
    await updateUser(bcryptHash);
    migrated = true;
  }

  return { success: true, migrated };
}

async function run() {
  console.log("\n=== Legacy Password Migration Integration Tests ===\n");

  const plaintext = "SuperSecret42!";
  const legacyHash = Buffer.from(plaintext).toString("base64");

  // Seed: legacy user
  let currentStoredHash = legacyHash;

  console.log("Step 1 — First login with legacy Base64 hash:");
  assert(isLegacyPassword(currentStoredHash), 'stored hash is legacy before login');

  const capturedHashes: string[] = [];
  const result1 = await simulateLogin(plaintext, currentStoredHash, async (newHash) => {
    capturedHashes.push(newHash);
    currentStoredHash = newHash; // simulate DB write
  });

  assert(result1.success, 'login succeeds with legacy hash');
  assert(result1.migrated, 'migration triggered on first login');
  assert(capturedHashes.length === 1, 'updateUser called exactly once');
  assert(!isLegacyPassword(currentStoredHash), 'stored hash is now bcrypt after migration');
  assert(currentStoredHash.startsWith("$2b$"), 'stored hash starts with $2b$');

  console.log("\nStep 2 — Read migrated hash from DB:");
  assert(await verifyPassword(plaintext, currentStoredHash), 'migrated bcrypt hash verifies original password');
  assert(!(await verifyPassword("wrongpassword", currentStoredHash)), 'wrong password rejected by migrated hash');

  console.log("\nStep 3 — Second login using bcrypt path (no migration):");
  const capturedHashes2: string[] = [];
  const result2 = await simulateLogin(plaintext, currentStoredHash, async (newHash) => {
    capturedHashes2.push(newHash);
  });

  assert(result2.success, 'second login succeeds using bcrypt path');
  assert(!result2.migrated, 'no re-migration on second login');
  assert(capturedHashes2.length === 0, 'updateUser NOT called on second login');

  console.log("\nStep 4 — Wrong password rejected at both stages:");
  const badResult = await simulateLogin("wrongpassword", legacyHash, async () => {});
  assert(!badResult.success, 'wrong password rejected on legacy path');
  assert(!badResult.migrated, 'no migration on failed login');

  const badResult2 = await simulateLogin("wrongpassword", currentStoredHash, async () => {});
  assert(!badResult2.success, 'wrong password rejected on bcrypt path');

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
