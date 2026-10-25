/**
 * Admin push announcements: audience, send, dedupe, guards, receipts, Activity rows, preferences.
 *
 * Run with (LOCAL scratch Postgres only, with migration 073 applied, through the neon local proxy):
 *   PUSH_TEST_PG_URL=postgresql://outsyde:outsyde@127.0.0.1:5432/outsyde \
 *   DATABASE_URL=postgresql://outsyde:outsyde@127.0.0.1:5432/outsyde \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/push/pushBroadcasts.test.ts
 * Uses a fake Expo sender, so no push ever leaves the machine. Seeds accounts with ids starting
 * "pt-" and removes them, and empties the push tables, at the start and at the end.
 * Skips (exit 0) when PUSH_TEST_PG_URL is unset; refuses any non local host.
 */
import assert from "node:assert/strict";
import pg from "pg";
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from "expo-server-sdk";

const PG_URL = process.env.PUSH_TEST_PG_URL;
if (!PG_URL) { console.log("PUSH_TEST_PG_URL not set, skipping"); process.exit(0); }
const host = new URL(PG_URL).hostname;
if (!["localhost", "127.0.0.1"].includes(host) || !["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL || "x://none").hostname)) {
  console.error("Refusing: PUSH_TEST_PG_URL and DATABASE_URL must both be localhost"); process.exit(1);
}

const pool = new pg.Pool({ connectionString: PG_URL });
const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

const push = await import("./pushBroadcasts");
const aud = await import("./pushAudience");

const T = (id: string) => `ExponentPushToken[${id}]`;

async function clean() {
  await q(`DELETE FROM notifications WHERE user_id LIKE 'pt-%'`);
  await q(`DELETE FROM push_log`);
  await q(`DELETE FROM push_sends`);
  await q(`DELETE FROM push_news_optouts WHERE user_id LIKE 'pt-%'`);
  await q(`DELETE FROM staff_members WHERE user_id LIKE 'pt-%'`);
  await q(`DELETE FROM photographers WHERE user_id LIKE 'pt-%'`);
  await q(`DELETE FROM businesses WHERE owner_id LIKE 'pt-%'`);
  await q(`DELETE FROM users WHERE id LIKE 'pt-%'`);
}

async function user(id: string, o: { token?: string | null; admin?: boolean; active?: boolean; deletion?: string; created?: string } = {}) {
  await q(
    `INSERT INTO users (id, username, email, name, expo_push_token, is_admin, is_active, deletion_status, created_at)
     VALUES ($1::text, $1::text, $1::text || '@test.local', 'Name ' || $1::text, $2, $3, $4, $5, $6)`,
    [id, o.token === undefined ? T(id) : o.token, o.admin ?? false, o.active ?? true, o.deletion ?? "active", o.created ?? "2026-01-01T00:00:00Z"],
  );
}

async function seed() {
  await user("pt-vendor");
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ('pt-biz', 'pt-vendor', 'PT Shop', 'beauty', 'approved')`);
  await user("pt-photo");
  await q(`INSERT INTO photographers (user_id, display_name, hourly_rate) VALUES ('pt-photo', 'PT Photo', 100)`);
  await user("pt-cust1", { token: T("shared"), created: "2026-01-01T00:00:00Z" });
  await user("pt-cust2", { token: T("shared"), created: "2026-02-01T00:00:00Z" });
  await user("pt-cust3");
  await user("pt-staff");
  await q(`INSERT INTO staff_members (business_id, user_id, display_name, status) VALUES ('pt-biz', 'pt-staff', 'PT Staff', 'active')`);
  await user("pt-admin", { admin: true });
  await user("pt-demoowner");
  await q(`INSERT INTO businesses (id, owner_id, name, category, is_demo) VALUES ('pt-demobiz', 'pt-demoowner', 'Demo', 'beauty', true)`);
  await user("pt-inactive", { active: false });
  await user("pt-deleted", { deletion: "pending" });
  await user("pt-optout");
  await q(`INSERT INTO push_news_optouts (user_id) VALUES ('pt-optout')`);
  await user("pt-notoken", { token: null });
}

type Sent = ExpoPushMessage[];
function fakeDeps(opts: { tickets?: (m: ExpoPushMessage, i: number) => ExpoPushTicket; throws?: boolean; receipts?: Record<string, ExpoPushReceipt> } = {}) {
  const calls: Sent[] = [];
  let seq = 0;
  return {
    calls,
    deps: {
      sendChunk: async (messages: ExpoPushMessage[]) => {
        calls.push(messages);
        if (opts.throws) throw new Error("network down");
        return messages.map((m, i) => opts.tickets ? opts.tickets(m, i) : ({ status: "ok", id: `tk-${++seq}` } as ExpoPushTicket));
      },
      getReceipts: async (ids: string[]) => Object.fromEntries(ids.filter((id) => opts.receipts?.[id]).map((id) => [id, opts.receipts![id]])),
    },
  };
}

async function waitDone(sendId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await q(`SELECT status FROM push_sends WHERE id = $1`, [sendId]);
    if (r[0]?.status === "done") return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`send ${sendId} never finished`);
}

let n = 0;
async function t(name: string, fn: () => Promise<void>) {
  await q(`DELETE FROM notifications WHERE user_id LIKE 'pt-%'`);
  await q(`DELETE FROM push_log`); await q(`DELETE FROM push_sends`);
  await fn(); n++; console.log(`ok ${n} ${name}`);
}

const base = { title: "Your partner kit is ready", body: "Tap to see your new flyers.", screen: "activity", url: null as string | null, createdBy: "pt-admin" };
let key = 0;
const ck = () => `ck-${Date.now()}-${++key}`;

try {
  await clean();
  await seed();

  await t("audience counts: token, active, not admin, not demo, not opted out", async () => {
    const c = await aud.pushAudienceCounts();
    // eligible: vendor, photo, cust1, cust2, cust3, staff = 6. Staff is in all only.
    assert.deepEqual(c, { vendors: 1, photographers: 1, consumers: 3, all: 6 });
    assert.equal(await aud.countPushRecipients("picked", ["pt-cust3", "pt-optout", "pt-admin", "pt-notoken"]), 1);
  });

  await t("send to all: one push per phone, logged once per account, Activity row per account", async () => {
    const f = fakeDeps();
    const r = await push.startPushSend({ ...base, audience: "all", clientKey: ck() }, f.deps);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.recipients, 6);
    await waitDone(r.sendId);
    const msgs = f.calls.flat();
    assert.equal(msgs.length, 5, "shared phone gets one push");
    assert.equal(new Set(msgs.map((m) => m.to as string)).size, 5);
    for (const m of msgs) {
      assert.deepEqual(m.data, { type: "announcement", sendId: r.sendId, screen: "activity" });
      assert.equal(m.title, base.title); assert.equal(m.body, base.body);
      assert.equal((m as { channelId?: string }).channelId, undefined);
    }
    const log = await q(`SELECT user_id, status, error FROM push_log WHERE send_id = $1 ORDER BY user_id`, [r.sendId]);
    assert.equal(log.length, 6);
    assert.deepEqual(log.find((x) => x.user_id === "pt-cust2"), { user_id: "pt-cust2", status: "skipped", error: "duplicate_device" });
    assert.equal(log.filter((x) => x.status === "sent").length, 5);
    const notes = await q(`SELECT user_id, type, title, message, reference_type, reference_id, metadata FROM notifications WHERE reference_id = $1 ORDER BY user_id`, [r.sendId]);
    assert.equal(notes.length, 6);
    assert.deepEqual(notes[0].metadata, { screen: "activity", sendId: r.sendId });
    assert.equal(notes[0].type, "announcement");
    assert.equal(notes[0].reference_type, "push_send");
    // Activity rows are never written twice
    assert.equal(await push.writeActivityRows(r.sendId), 0);
    const s = (await q(`SELECT status, sent_count, failed_count, recipient_count FROM push_sends WHERE id = $1`, [r.sendId]))[0];
    assert.deepEqual(s, { status: "done", sent_count: 5, failed_count: 0, recipient_count: 6 });
  });

  await t("push_log and Activity metadata hold no token and no message text", async () => {
    const f = fakeDeps();
    const r = await push.startPushSend({ ...base, audience: "all", clientKey: ck() }, f.deps);
    assert.ok(r.ok); if (!r.ok) return;
    await waitDone(r.sendId);
    const rows = await q(`SELECT * FROM push_log WHERE send_id = $1`, [r.sendId]);
    const blob = JSON.stringify(rows);
    assert.ok(!blob.includes("ExponentPushToken"), "no token");
    assert.ok(!blob.includes(base.body) && !blob.includes(base.title), "no message text");
    assert.ok(rows.every((x) => typeof x.token_hash === "string" && x.token_hash.length === 64));
  });

  await t("link screen sends the url; vendor screen to vendors only", async () => {
    const f = fakeDeps();
    const r = await push.startPushSend({ ...base, audience: "vendors", screen: "link", url: "https://goutsyde.com/events", clientKey: ck() }, f.deps);
    assert.ok(r.ok); if (!r.ok) return;
    await waitDone(r.sendId);
    assert.equal(f.calls.flat().length, 1);
    assert.deepEqual(f.calls.flat()[0].data, { type: "announcement", sendId: r.sendId, screen: "link", url: "https://goutsyde.com/events" });
    const note = (await q(`SELECT metadata FROM notifications WHERE reference_id = $1`, [r.sendId]))[0];
    assert.deepEqual(note.metadata, { screen: "link", url: "https://goutsyde.com/events", sendId: r.sendId });
  });

  await t("same clientKey returns the same send and pushes nothing new", async () => {
    const f = fakeDeps();
    const k = ck();
    const a = await push.startPushSend({ ...base, audience: "picked", userIds: ["pt-cust3"], clientKey: k }, f.deps);
    assert.ok(a.ok); if (!a.ok) return;
    await waitDone(a.sendId);
    const b = await push.startPushSend({ ...base, audience: "picked", userIds: ["pt-cust3"], clientKey: k }, f.deps);
    assert.ok(b.ok && b.existing && b.sendId === a.sendId);
    assert.equal(f.calls.flat().length, 1);
    assert.equal((await q(`SELECT count(*)::int n FROM push_sends`))[0].n, 1);
  });

  await t("same title and message within 10 minutes is refused", async () => {
    const f = fakeDeps();
    const a = await push.startPushSend({ ...base, audience: "picked", userIds: ["pt-cust3"], clientKey: ck() }, f.deps);
    assert.ok(a.ok); if (a.ok) await waitDone(a.sendId);
    const b = await push.startPushSend({ ...base, audience: "picked", userIds: ["pt-cust1"], clientKey: ck() }, f.deps);
    assert.ok(!b.ok && b.status === 409 && b.code === "DUPLICATE_SEND");
    await q(`UPDATE push_sends SET created_at = now() - interval '11 minutes'`);
    const c = await push.startPushSend({ ...base, audience: "picked", userIds: ["pt-cust1"], clientKey: ck() }, f.deps);
    assert.ok(c.ok); if (c.ok) await waitDone(c.sendId);
  });

  await t("only one announcement sending at a time", async () => {
    await q(`INSERT INTO push_sends (kind, audience, title, body, status) VALUES ('announcement', 'all', 'x', 'y', 'sending')`);
    const f = fakeDeps();
    const r = await push.startPushSend({ ...base, title: "Other", audience: "all", clientKey: ck() }, f.deps);
    assert.ok(!r.ok && r.status === 409 && r.code === "SEND_IN_PROGRESS");
    assert.equal(f.calls.length, 0);
    assert.equal((await q(`SELECT count(*)::int n FROM push_log`))[0].n, 0, "nothing logged");
  });

  await t("3 sends a New York day, tests don't count", async () => {
    const f = fakeDeps();
    for (let i = 0; i < 3; i++) {
      const r = await push.startPushSend({ ...base, title: `Send ${i}`, audience: "picked", userIds: ["pt-cust3"], clientKey: ck() }, f.deps);
      assert.ok(r.ok, `send ${i}`); if (r.ok) await waitDone(r.sendId);
    }
    const tr = await push.sendPushTest({ adminId: "pt-admin", title: "Test", body: "Test body", screen: "home", url: null }, f.deps);
    assert.ok(tr.ok);
    const lim = await push.getPushLimits();
    assert.equal(lim.sentToday, 3); assert.equal(lim.remaining, 0);
    const r = await push.startPushSend({ ...base, title: "Fourth", audience: "picked", userIds: ["pt-cust3"], clientKey: ck() }, f.deps);
    assert.ok(!r.ok && r.status === 429 && r.code === "OVER_DAILY_LIMIT");
    // Yesterday (New York) doesn't count
    await q(`UPDATE push_sends SET created_at = (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York') - interval '1 minute'`);
    assert.equal((await push.getPushLimits()).remaining, 3);
  });

  await t("test push: admin's own phone only, no Activity row; NO_TOKEN without a phone", async () => {
    const f = fakeDeps();
    const r = await push.sendPushTest({ adminId: "pt-admin", title: "Test", body: "Body", screen: "edit_profile", url: null }, f.deps);
    assert.ok(r.ok && r.status === "sent");
    assert.equal(f.calls.flat().length, 1);
    assert.equal(f.calls.flat()[0].to, T("pt-admin"));
    assert.equal((f.calls.flat()[0].data as Record<string, string>).screen, "edit_profile");
    if (r.ok) assert.equal((await q(`SELECT count(*)::int n FROM notifications WHERE reference_id = $1`, [r.sendId]))[0].n, 0);
    const none = await push.sendPushTest({ adminId: "pt-notoken", title: "Test", body: "Body", screen: "home", url: null }, f.deps);
    assert.ok(!none.ok && none.code === "NO_TOKEN");
  });

  await t("no recipients is refused before anything is written", async () => {
    const r = await push.startPushSend({ ...base, audience: "picked", userIds: ["pt-optout", "pt-admin"], clientKey: ck() }, fakeDeps().deps);
    assert.ok(!r.ok && r.code === "NO_RECIPIENTS");
    assert.equal((await q(`SELECT count(*)::int n FROM push_sends`))[0].n, 0);
  });

  await t("eligibility is checked again at send time (opted out mid send: skipped, no Activity row)", async () => {
    const s = (await q(`INSERT INTO push_sends (kind, audience, title, body, screen, status) VALUES ('announcement', 'picked', 'T', 'B', 'home', 'sending') RETURNING id`))[0].id;
    await q(`INSERT INTO push_log (send_id, user_id, status) VALUES ($1, 'pt-cust3', 'pending'), ($1, 'pt-vendor', 'pending')`, [s]);
    await q(`INSERT INTO push_news_optouts (user_id) VALUES ('pt-cust3')`);
    const f = fakeDeps();
    await push.processPushSend(s, f.deps);
    await q(`DELETE FROM push_news_optouts WHERE user_id = 'pt-cust3'`);
    const log = await q(`SELECT user_id, status, error FROM push_log WHERE send_id = $1 ORDER BY user_id`, [s]);
    assert.deepEqual(log, [
      { user_id: "pt-cust3", status: "skipped", error: "no_longer_eligible" },
      { user_id: "pt-vendor", status: "sent", error: null },
    ]);
    const notes = await q(`SELECT user_id FROM notifications WHERE reference_id = $1`, [s]);
    assert.deepEqual(notes.map((x) => x.user_id), ["pt-vendor"]);
  });

  await t("Expo request fails: rows become unknown and are never retried", async () => {
    const f = fakeDeps({ throws: true });
    const r = await push.startPushSend({ ...base, title: "Down", audience: "picked", userIds: ["pt-cust3", "pt-vendor"], clientKey: ck() }, f.deps);
    assert.ok(r.ok); if (!r.ok) return;
    await waitDone(r.sendId);
    const log = await q(`SELECT status, error FROM push_log WHERE send_id = $1`, [r.sendId]);
    assert.ok(log.every((x) => x.status === "unknown" && x.error === "send_error"));
    await push.processPushSend(r.sendId, fakeDeps().deps);
    assert.equal(f.calls.length, 1);
    const s = (await q(`SELECT failed_count, sent_count FROM push_sends WHERE id = $1`, [r.sendId]))[0];
    assert.deepEqual(s, { failed_count: 2, sent_count: 0 });
  });

  await t("DeviceNotRegistered on the ticket clears that token", async () => {
    await user("pt-dead1");
    const f = fakeDeps({ tickets: () => ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } as ExpoPushTicket) });
    const r = await push.startPushSend({ ...base, title: "Dead", audience: "picked", userIds: ["pt-dead1"], clientKey: ck() }, f.deps);
    assert.ok(r.ok); if (!r.ok) return;
    await waitDone(r.sendId);
    assert.equal((await q(`SELECT expo_push_token FROM users WHERE id = 'pt-dead1'`))[0].expo_push_token, null);
    assert.deepEqual((await q(`SELECT status, error FROM push_log WHERE send_id = $1`, [r.sendId]))[0], { status: "failed", error: "DeviceNotRegistered" });
    await q(`DELETE FROM notifications WHERE user_id LIKE 'pt-%'`); await q(`DELETE FROM users WHERE id IN ('pt-dead1')`);
  });

  await t("receipts: errors marked failed; dead token cleared only when the phone hasn't re-registered", async () => {
    await user("pt-r1"); await user("pt-r2"); await user("pt-r3");
    const f = fakeDeps({ tickets: (m) => ({ status: "ok", id: `rc-${String(m.to).slice(18, -1)}` } as ExpoPushTicket) });
    const r = await push.startPushSend({ ...base, title: "Receipts", audience: "picked", userIds: ["pt-r1", "pt-r2", "pt-r3"], clientKey: ck() }, f.deps);
    assert.ok(r.ok); if (!r.ok) return;
    await waitDone(r.sendId);
    await q(`UPDATE users SET expo_push_token = $1 WHERE id = 'pt-r2'`, [T("pt-r2-new")]); // re-registered
    const receipts = {
      "rc-pt-r1": { status: "error", message: "x", details: { error: "DeviceNotRegistered" } },
      "rc-pt-r2": { status: "error", message: "x", details: { error: "DeviceNotRegistered" } },
      "rc-pt-r3": { status: "ok" },
    } as unknown as Record<string, ExpoPushReceipt>;
    assert.equal(await push.checkDueReceipts(fakeDeps({ receipts }).deps, 15), 0, "not due yet");
    const done = await push.checkDueReceipts(fakeDeps({ receipts }).deps, 0);
    assert.equal(done, 1);
    const toks = await q(`SELECT id, expo_push_token FROM users WHERE id IN ('pt-r1','pt-r2','pt-r3') ORDER BY id`);
    assert.deepEqual(toks, [
      { id: "pt-r1", expo_push_token: null },
      { id: "pt-r2", expo_push_token: T("pt-r2-new") },
      { id: "pt-r3", expo_push_token: T("pt-r3") },
    ]);
    const s = (await q(`SELECT sent_count, failed_count, receipts_checked_at IS NOT NULL AS checked FROM push_sends WHERE id = $1`, [r.sendId]))[0];
    assert.deepEqual(s, { sent_count: 1, failed_count: 2, checked: true });
    assert.equal(await push.checkDueReceipts(fakeDeps({ receipts }).deps, 0), 0, "checked once only");
    await q(`DELETE FROM notifications WHERE user_id LIKE 'pt-%'`); await q(`DELETE FROM users WHERE id IN ('pt-r1','pt-r2','pt-r3')`);
  });

  await t("restart: rows caught sending become unknown, pending rows still go out", async () => {
    const s = (await q(`INSERT INTO push_sends (kind, audience, title, body, status) VALUES ('announcement', 'picked', 'R', 'B', 'sending') RETURNING id`))[0].id;
    await q(`INSERT INTO push_log (send_id, user_id, status) VALUES ($1, 'pt-cust3', 'sending'), ($1, 'pt-vendor', 'pending')`, [s]);
    const f = fakeDeps();
    await push.resumePushSends(f.deps);
    await waitDone(s);
    const log = await q(`SELECT user_id, status FROM push_log WHERE send_id = $1 ORDER BY user_id`, [s]);
    assert.deepEqual(log, [{ user_id: "pt-cust3", status: "unknown" }, { user_id: "pt-vendor", status: "sent" }]);
    assert.equal(f.calls.flat().length, 1);
  });

  await t("news preference: off, then back on", async () => {
    assert.equal(await push.getNewsPreference("pt-cust3"), true);
    assert.equal(await push.setNewsPreference("pt-cust3", false), false);
    assert.equal(await push.setNewsPreference("pt-cust3", false), false);
    assert.equal(await aud.countPushRecipients("picked", ["pt-cust3"]), 0);
    assert.equal(await push.setNewsPreference("pt-cust3", true), true);
    assert.equal(await aud.countPushRecipients("picked", ["pt-cust3"]), 1);
  });

  await t("content and quiet hours", async () => {
    assert.equal(typeof push.checkPushContent({ title: "", body: "x" }), "string");
    assert.equal(typeof push.checkPushContent({ title: "a".repeat(66), body: "x" }), "string");
    assert.equal(typeof push.checkPushContent({ title: "a\nb", body: "x" }), "string");
    assert.equal(typeof push.checkPushContent({ title: "a", body: "b".repeat(179) }), "string");
    assert.deepEqual(push.checkPushContent({ title: " Hi ", body: " There " }), { title: "Hi", body: "There" });
    // 2026-10-24 is EDT (UTC-4)
    assert.equal(push.isQuietHours(new Date("2026-10-24T12:59:00Z")), true);  // 8:59 AM
    assert.equal(push.isQuietHours(new Date("2026-10-24T13:00:00Z")), false); // 9:00 AM
    assert.equal(push.isQuietHours(new Date("2026-10-25T00:59:00Z")), false); // 8:59 PM
    assert.equal(push.isQuietHours(new Date("2026-10-25T01:00:00Z")), true);  // 9:00 PM
  });

  console.log(`\n${n} passed`);
} finally {
  await clean();
  await pool.end();
}
process.exit(0);
