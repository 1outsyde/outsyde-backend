// Run: npx tsx server/adminBusinessOverride.test.ts
import { adminOverrideBusinessId } from './adminBusinessOverride';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  if (actual === expected) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const BIZ = '9733f28e-a809-4e99-b2b4-32e6203f15de';
const OTHER = '8523e3c5-fc07-461b-9452-087d2b4aada6';

console.log('\n— adminOverrideBusinessId');
// Non-admins never get an override, whatever they send.
eq(adminOverrideBusinessId(false, BIZ, OTHER), null, 'non-admin with header + query → null');
eq(adminOverrideBusinessId(false, undefined, BIZ), null, 'non-admin with query → null');
eq(adminOverrideBusinessId(undefined as unknown as boolean, BIZ, undefined), null, 'isAdmin undefined → null');
eq(adminOverrideBusinessId('true' as unknown as boolean, BIZ, undefined), null, 'isAdmin "true" string → null');
// Admins get what they name, header first.
eq(adminOverrideBusinessId(true, BIZ, undefined), BIZ, 'admin + header → header');
eq(adminOverrideBusinessId(true, undefined, BIZ), BIZ, 'admin + query → query');
eq(adminOverrideBusinessId(true, BIZ, OTHER), BIZ, 'admin + both → header wins');
eq(adminOverrideBusinessId(true, `  ${BIZ}  `, undefined), BIZ, 'whitespace trimmed');
eq(adminOverrideBusinessId(true, [BIZ, OTHER], undefined), BIZ, 'repeated value → first');
// Admin naming nothing falls back to their own business (null).
eq(adminOverrideBusinessId(true, undefined, undefined), null, 'admin, nothing named → null');
eq(adminOverrideBusinessId(true, '', '   '), null, 'admin, empty values → null');
eq(adminOverrideBusinessId(true, 42, { id: BIZ }), null, 'admin, non-string values → null');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
