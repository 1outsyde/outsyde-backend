/** Pure tests for team access rules. Run with: npx tsx server/team/team.test.ts */
import { roleAllows, ROLES_THAT_MANAGE_TEAM } from './teamRules';

let passed = 0, failed = 0;
const assert = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.error(`  ❌ ${n}`); } };

assert(roleAllows('requests', 'read'), 'requests role can read');
assert(roleAllows('requests', 'requests'), 'requests role can work estimate requests');
assert(roleAllows('manager', 'requests'), 'manager role can work estimate requests');
assert(!roleAllows(null, 'read'), 'no role cannot read');
assert(!roleAllows(undefined, 'requests'), 'undefined role cannot work requests');
assert(!roleAllows('owner' as any, 'read'), 'an unknown role is refused');
assert(ROLES_THAT_MANAGE_TEAM.length === 0, 'no team role can manage the team yet (owner and admin only)');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
