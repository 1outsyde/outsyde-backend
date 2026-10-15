/**
 * Pure tests for the reminder schedule and the claim helpers —
 * run with: npx tsx server/accountSetup/reminders.test.ts   (no database, no network)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

(async () => {
  const { planReminder, inSendWindow } = await import("./reminders");
  const { computeSetupSteps } = await import("./status");
  const { isClaimable, codeIssuedRecently, CODE_TTL_MS, resetTokenMatches } = await import("./claim");
  const { unsubscribeSig, verifyUnsubscribeSig } = await import("./emails");
  const { createHash } = await import("crypto");

  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date("2026-10-15T15:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const todo = computeSetupSteps({ hasLoginMethod: true, hasUsername: true, photographer: { payoutsComplete: false } });
  const done = computeSetupSteps({ hasLoginMethod: true, hasUsername: true });
  const noPw = computeSetupSteps({ hasLoginMethod: false, hasUsername: false });
  const empty = { count: 0, firstSentAt: null, lastSentAt: null };

  // schedule
  assert(planReminder({ createdAt: ago(2 * 60 * 60 * 1000), status: todo, log: empty, optedOut: false, now }) === null, "account 2 h old → no reminder yet");
  const r1 = planReminder({ createdAt: ago(2 * DAY), status: todo, log: empty, optedOut: false, now });
  assert(r1?.reminderNumber === 1 && r1.template === "steps_left" && r1.actionable.includes("payouts"), "2-day-old incomplete → reminder 1, steps_left", r1);
  assert(planReminder({ createdAt: ago(9 * DAY), status: todo, log: { count: 1, firstSentAt: ago(2 * DAY), lastSentAt: ago(2 * DAY) }, optedOut: false, now }) === null, "reminder 1 sent 2 days ago → nothing");
  assert(planReminder({ createdAt: ago(9 * DAY), status: todo, log: { count: 1, firstSentAt: ago(3 * DAY), lastSentAt: ago(3 * DAY) }, optedOut: false, now })?.reminderNumber === 2, "reminder 1 sent 3 days ago → reminder 2");
  assert(planReminder({ createdAt: ago(30 * DAY), status: todo, log: { count: 2, firstSentAt: ago(7 * DAY), lastSentAt: ago(4 * DAY) }, optedOut: false, now })?.reminderNumber === 3, "7 days after first → reminder 3");
  assert(planReminder({ createdAt: ago(30 * DAY), status: todo, log: { count: 3, firstSentAt: ago(13 * DAY), lastSentAt: ago(6 * DAY) }, optedOut: false, now }) === null, "13 days after first → reminder 4 not yet");
  assert(planReminder({ createdAt: ago(30 * DAY), status: todo, log: { count: 3, firstSentAt: ago(14 * DAY), lastSentAt: ago(7 * DAY) }, optedOut: false, now })?.reminderNumber === 4, "14 days after first → reminder 4");
  assert(planReminder({ createdAt: ago(60 * DAY), status: todo, log: { count: 4, firstSentAt: ago(30 * DAY), lastSentAt: ago(16 * DAY) }, optedOut: false, now }) === null, "4 sent → stop");
  assert(planReminder({ createdAt: ago(2 * DAY), status: todo, log: empty, optedOut: true, now }) === null, "opted out → never");
  assert(planReminder({ createdAt: ago(2 * DAY), status: done, log: empty, optedOut: false, now }) === null, "complete → never");
  assert(planReminder({ createdAt: ago(2 * DAY), status: noPw, log: empty, optedOut: false, now })?.template === "claim", "no password → claim template");
  const pending = computeSetupSteps({ hasLoginMethod: true, hasUsername: true, business: { approvalStatus: "pending", subscription: null, tier: null, payoutsComplete: false } });
  assert(planReminder({ createdAt: ago(5 * DAY), status: pending, log: empty, optedOut: false, now }) === null, "business waiting on approval → no reminder");

  // send window (America/New_York, EDT = UTC-4 in October)
  assert(inSendWindow(new Date("2026-10-15T15:00:00Z")) === true, "11:00 New York → inside window");
  assert(inSendWindow(new Date("2026-10-15T02:00:00Z")) === false, "22:00 New York → outside window");
  assert(inSendWindow(new Date("2026-10-15T23:30:00Z")) === false, "19:30 New York → outside window");

  // claim helpers
  assert(isClaimable({ password: null, appleId: null, googleSub: null, email: "a@b.co", isActive: true } as any) === true, "passwordless active account with email → claimable");
  assert(isClaimable({ password: "x", appleId: null, googleSub: null, email: "a@b.co", isActive: true } as any) === false, "has password → not claimable");
  assert(isClaimable({ password: null, appleId: "a", googleSub: null, email: "a@b.co", isActive: true } as any) === false, "Apple login → not claimable");
  assert(isClaimable({ password: null, appleId: null, googleSub: null, email: null, isActive: true } as any) === false, "no email → not claimable");
  assert(isClaimable({ password: null, appleId: null, googleSub: null, email: "a@b.co", isActive: false } as any) === false, "disabled → not claimable");

  const t = new Date("2026-10-15T15:00:00Z");
  assert(codeIssuedRecently(new Date(t.getTime() + CODE_TTL_MS - 30_000), t) === true, "code issued 30 s ago → recent (no resend)");
  assert(codeIssuedRecently(new Date(t.getTime() + CODE_TTL_MS - 90_000), t) === false, "code issued 90 s ago → resend allowed");
  assert(codeIssuedRecently(null, t) === false, "no code → resend allowed");

  const raw = "abc123token";
  const h = createHash("sha256").update(raw).digest("hex");
  assert(resetTokenMatches({ resetTokenHash: h, resetTokenExpiresAt: new Date(t.getTime() + 1000) } as any, raw, t), "matching unexpired token accepted");
  assert(!resetTokenMatches({ resetTokenHash: h, resetTokenExpiresAt: new Date(t.getTime() - 1000) } as any, raw, t), "expired token rejected");
  assert(!resetTokenMatches({ resetTokenHash: h, resetTokenExpiresAt: new Date(t.getTime() + 1000) } as any, "other", t), "wrong token rejected");

  // unsubscribe signature
  const sig = unsubscribeSig("user-1");
  assert(verifyUnsubscribeSig("user-1", sig), "unsubscribe signature round-trips");
  assert(!verifyUnsubscribeSig("user-2", sig), "signature for another user rejected");
  assert(!verifyUnsubscribeSig("user-1", "short"), "malformed signature rejected");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
