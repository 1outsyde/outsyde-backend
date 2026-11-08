/**
 * PUSH_DISABLED switch (payment methods Step 5 test backend) — tests
 *
 * Run with: npx tsx server/push/pushSwitch.test.ts
 *
 * The switch part always runs. The direct push part needs a LOCAL scratch Postgres:
 *   PS_TEST_PG_URL   the scratch database (localhost only)
 *   DATABASE_URL     the same database, with NODE_OPTIONS="--import ./.dev/neon-preload.mjs"
 * Expo is never reached: its send and receipt methods are replaced with recorders that fail the test if called.
 */
import Expo from "expo-server-sdk";

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

// Any real Expo call is recorded (and would be a failure while the switch is on).
const expoCalls: string[] = [];
(Expo.prototype as any).sendPushNotificationsAsync = async (m: unknown[]) => {
  expoCalls.push("send");
  return m.map((_, i) => ({ status: "ok", id: `real-${i}` }));
};
(Expo.prototype as any).getPushNotificationReceiptsAsync = async () => {
  expoCalls.push("receipts");
  return {};
};

(async () => {
  const { pushDisabled, offTickets, offReceipts } = await import("./pushSwitch");

  console.log("The switch");
  eq(pushDisabled({ PUSH_DISABLED: "true" }), true, "PUSH_DISABLED=true turns push off");
  eq(pushDisabled({}), false, "unset (production): push on");
  for (const v of ["false", "1", "TRUE", "yes", ""]) eq(pushDisabled({ PUSH_DISABLED: v }), false, `"${v}" leaves push on`);
  const t = offTickets(3);
  eq(t.length, 3, "one ticket per message");
  eq(t.every((x) => x.status === "ok" && typeof (x as any).id === "string" && (x as any).id.startsWith("push-off-")), true, "tickets read as sent");
  eq(new Set(t.map((x: any) => x.id)).size, 3, "ticket ids are unique");
  eq(offReceipts(["a", "b"]), { a: { status: "ok" }, b: { status: "ok" } }, "receipts read as delivered");

  console.log("\nBroadcast sender");
  process.env.PUSH_DISABLED = "true";
  const { defaultPushDeps } = await import("./pushBroadcasts");
  const sent = await defaultPushDeps.sendChunk([{ to: "ExponentPushToken[abc]", title: "Hi", body: "x" }]);
  const rec = await defaultPushDeps.getReceipts(["push-off-1"]);
  eq(expoCalls, [], "switch on: broadcasts never reach Expo");
  eq(sent[0]?.status, "ok", "switch on: the broadcast row is marked sent");
  eq(rec, { "push-off-1": { status: "ok" } }, "switch on: receipts come back ok");
  delete process.env.PUSH_DISABLED;
  await defaultPushDeps.sendChunk([{ to: "ExponentPushToken[abc]", title: "Hi", body: "x" }]);
  await defaultPushDeps.getReceipts(["real-0"]);
  eq(expoCalls, ["send", "receipts"], "switch off (production): Expo is called as before");
  expoCalls.length = 0;

  const PG_URL = process.env.PS_TEST_PG_URL;
  if (!PG_URL) {
    console.log("⏭  direct push part skipped: set PS_TEST_PG_URL (+ DATABASE_URL and the neon preload) to run");
  } else {
    if (!isLocal(PG_URL)) throw new Error("refusing to run: localhost database only");
    const pgMod: any = await import("pg");
    const pg = pgMod.default ?? pgMod;
    const db = new pg.Client({ connectionString: PG_URL });
    await db.connect();
    const uid = `pushoff_${Date.now().toString(36)}`;
    await db.query(`INSERT INTO users (id, username, email, expo_push_token) VALUES ($1::varchar, $1::text, $2, 'ExponentPushToken[pushofftest]')`, [uid, `${uid}@ps.test`]);
    try {
      const { sendExpoPush } = await import("../expoPushService");
      console.log("\nDirect push (booking, order, quote messages)");
      process.env.PUSH_DISABLED = "true";
      eq(await sendExpoPush({ userId: uid, title: "Booked", body: "x" }), true, "switch on: reports sent so callers carry on");
      eq(expoCalls, [], "switch on: never reaches Expo");
      const tok = await db.query(`SELECT expo_push_token FROM users WHERE id = $1`, [uid]);
      eq(tok.rows[0].expo_push_token, "ExponentPushToken[pushofftest]", "switch on: the token is kept");
      delete process.env.PUSH_DISABLED;
      eq(await sendExpoPush({ userId: uid, title: "Booked", body: "x" }), true, "switch off: sends as before");
      eq(expoCalls, ["send"], "switch off: Expo called once");
    } finally {
      await db.query(`DELETE FROM users WHERE id = $1`, [uid]).catch((e: Error) => console.error("cleanup", e.message));
      await db.end();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
