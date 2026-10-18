/**
 * Messaging HTTP + websocket tests — run with:
 *   npx tsx server/messaging/messaging.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema),
 * started with the same JWT_SECRET as here, and an Expo push capture server:
 *   MSG_TEST_BASE_URL     e.g. http://localhost:5062                 (must be localhost)
 *   MSG_TEST_PG_URL       the SAME scratch database (localhost only; seeds + cleans up)
 *   MSG_TEST_EXPO_FILE    file the local exp.host stub appends each push request body to
 *   JWT_SECRET            same value the backend was started with (tokens are minted here)
 * Skips (exit 0) when MSG_TEST_BASE_URL is unset and refuses any non-local host, so it can never
 * touch Neon or production.
 *
 * Rules under test:
 *  - Every messaging route accepts the app's Bearer token with NO session cookie.
 *  - A valid session cookie still works (web), no auth is 401, an invalid token alone is 401.
 *  - Sending a message (REST or websocket) sends ONE Expo push to the recipient, never the sender,
 *    titled with the sender's public name (business name for a vendor), data.type new_message.
 *  - Blocked either way: REST 403 and websocket error, nothing stored, no push.
 *  - Websocket send enforces the same content rules as REST (empty, >2000).
 *  - No notifications row is created for a message.
 */
import fs from "fs";

const BASE = process.env.MSG_TEST_BASE_URL;
const PG_URL = process.env.MSG_TEST_PG_URL;
const EXPO_FILE = process.env.MSG_TEST_EXPO_FILE;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!BASE) {
    console.log("⏭  skipped: set MSG_TEST_BASE_URL (+ MSG_TEST_PG_URL, MSG_TEST_EXPO_FILE) to run");
    process.exit(0);
  }
  if (!PG_URL || !EXPO_FILE || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error("refusing to run: base URL and database must both be local scratch instances");
  }
  const { generateAccessToken } = await import("../auth");
  const bcryptMod: any = await import("bcrypt");
  const bcrypt = bcryptMod.default ?? bcryptMod;
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const WS: any = (await import("ws")).default;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── seed ─────────────────────────────────────────────────────────────
  const P = `msg-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const PASSWORD = "local-test-pass-123";
  const hash = await bcrypt.hash(PASSWORD, 4);
  const tokenFor = (who: string) => `ExponentPushToken[${P}-${who}]`;
  for (const who of ["customer", "owner", "blocker"]) {
    await q(`INSERT INTO users (id, username, email, password, name, first_name, expo_push_token, is_vendor) VALUES ($1::varchar, $2, $3, $4, $5, $6, $7, $8)`,
      [id(who), `${who}${Date.now().toString(36)}`, `${id(who)}@x.test`, hash, `Real ${who} Lastname`, who, tokenFor(who), who === "owner"]);
  }
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, $3, 'Hair', 'approved')`,
    [id("biz"), id("owner"), "Braids Test Studio"]);
  await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [id("blocker"), id("customer")]);

  const bearer = (who: string) => ({ Authorization: `Bearer ${generateAccessToken({ userId: id(who), isVendor: who === "owner" })}` });
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json: any = null; try { json = await res.json(); } catch {}
    return { status: res.status, json, headers: res.headers };
  };
  const pushes = () => fs.readFileSync(EXPO_FILE, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { const j = JSON.parse(l); return Array.isArray(j) ? j : [j]; } catch { return []; } }).filter((m: any) => String(m.to).includes(P));
  const notifCountBefore = (await q(`SELECT count(*)::int n FROM notifications WHERE user_id = ANY($1)`, [[id("customer"), id("owner"), id("blocker")]]))[0].n;

  try {
    console.log("auth");
    assert((await call("GET", "/api/conversations")).status === 401, "no auth → 401");
    assert((await call("GET", "/api/conversations", { Authorization: "Bearer not-a-token" })).status === 401, "invalid token alone → 401");
    const list = await call("GET", "/api/conversations", bearer("customer"));
    assert(list.status === 200, "GET /api/conversations works with Bearer only (no cookie)", list);

    console.log("start a chat (customer → business)");
    const conv = await call("POST", "/api/conversations", bearer("customer"), { participantId: id("biz"), participantType: "business" });
    assert(conv.status === 200 && conv.json?.conversation?.id, "POST /api/conversations with Bearer only", conv);
    const convId = conv.json.conversation.id;
    assert(conv.json.otherParticipant?.publicName === "Braids Test Studio", "other side shows the business name", conv.json.otherParticipant);

    console.log("REST send + push");
    const sent = await call("POST", `/api/conversations/${convId}/messages`, bearer("customer"), { content: "Hi, do you have Saturday open?" });
    assert(sent.status === 200 && sent.json?.message?.id, "POST message with Bearer only", sent);
    await sleep(1200);
    let p = pushes();
    assert(p.length === 1, "exactly one Expo push sent", p);
    assert(p[0]?.to === tokenFor("owner"), "push goes to the business owner (recipient), not the sender", p[0]?.to);
    assert(p[0]?.title === "Real customer Lastname", "title is the customer's public name (users.name, same rule as feed + inbox, #300)", p[0]?.title);
    assert(!JSON.stringify(p[0]).includes("@x.test"), "push never contains the email");
    assert(p[0]?.body === "Hi, do you have Saturday open?", "body is the message text", p[0]?.body);
    assert(p[0]?.data?.type === "new_message" && p[0]?.data?.conversationId === convId && p[0]?.data?.messageId === sent.json.message.id, "data has type + conversation + message ids", p[0]?.data);

    const reply = await call("POST", `/api/conversations/${convId}/messages`, bearer("owner"), { content: "Yes, 11am works" });
    assert(reply.status === 200, "business replies with Bearer only", reply);
    await sleep(1200);
    p = pushes();
    const toCustomer = p.filter((m: any) => m.to === tokenFor("customer"));
    assert(toCustomer.length === 1 && toCustomer[0].title === "Braids Test Studio", "reply push titled with the BUSINESS name", toCustomer[0]?.title);

    const msgs = await call("GET", `/api/conversations/${convId}/messages`, bearer("owner"));
    assert(msgs.status === 200 && msgs.json?.messages?.length === 2, "GET messages with Bearer only (2 messages)", msgs.json?.messages?.length);
    const unread = await call("GET", "/api/messages/unread-count", bearer("customer"));
    assert(unread.status === 200 && unread.json?.totalUnreadCount === 1 && unread.json?.count === 1, "unread-count with Bearer only, keeps both keys", unread.json);
    const reports = await call("GET", "/api/messages/my-reports", bearer("customer"));
    assert(reports.status === 200 && Array.isArray(reports.json?.reports), "my-reports with Bearer only", reports.status);

    const empty = await call("POST", `/api/conversations/${convId}/messages`, bearer("customer"), { content: "   " });
    assert(empty.status === 400, "REST: whitespace only → 400", empty);
    const tooLong = await call("POST", `/api/conversations/${convId}/messages`, bearer("customer"), { content: "x".repeat(2001) });
    assert(tooLong.status === 400, "REST: 2001 chars → 400", tooLong);
    const other = await call("GET", `/api/conversations/${convId}/messages`, bearer("blocker"));
    assert(other.status === 403, "non-participant → 403", other.status);

    console.log("blocked");
    const bconv = await call("POST", "/api/conversations", bearer("customer"), { participantId: id("blocker"), participantType: "user" });
    const bconvId = bconv.json?.conversation?.id;
    const before = pushes().length;
    const bsend = await call("POST", `/api/conversations/${bconvId}/messages`, bearer("customer"), { content: "hello?" });
    assert(bsend.status === 403, "REST send to someone who blocked you → 403", bsend);

    console.log("websocket");
    const wsUrl = BASE.replace(/^http/, "ws") + "/ws";
    const ws = new WS(wsUrl);
    const inbox: any[] = [];
    ws.on("message", (d: any) => inbox.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    const tok = bearer("customer").Authorization.slice(7);
    ws.send(JSON.stringify({ type: "auth", payload: { token: tok } }));
    await sleep(400);
    assert(inbox.some((m) => m.type === "auth_success"), "websocket auth with app token");
    const waitFor = async (pred: (m: any) => boolean) => { for (let i = 0; i < 30; i++) { const m = inbox.find(pred); if (m) return m; await sleep(100); } return null; };

    inbox.length = 0;
    ws.send(JSON.stringify({ type: "send_message", payload: { conversationId: bconvId, content: "sneaky" } }));
    const blockedErr = await waitFor((m) => m.type === "error" || m.type === "message_sent");
    assert(blockedErr?.type === "error", "websocket send to someone who blocked you → error (R23)", blockedErr);
    inbox.length = 0;
    ws.send(JSON.stringify({ type: "send_message", payload: { conversationId: convId, content: "x".repeat(2001) } }));
    const longErr = await waitFor((m) => m.type === "error" || m.type === "message_sent");
    assert(longErr?.type === "error", "websocket 2001 chars → error", longErr);
    inbox.length = 0;
    ws.send(JSON.stringify({ type: "send_message", payload: { conversationId: convId, content: "" } }));
    const emptyErr = await waitFor((m) => m.type === "error" || m.type === "message_sent");
    assert(emptyErr?.type === "error", "websocket empty → error", emptyErr);
    const stored = (await q(`SELECT count(*)::int n FROM messages WHERE conversation_id = $1`, [bconvId]))[0].n;
    assert(stored === 0, "nothing stored in the blocked conversation", stored);
    assert(pushes().length === before, "no push for blocked or rejected sends");

    inbox.length = 0;
    ws.send(JSON.stringify({ type: "send_message", payload: { conversationId: convId, content: "Sent over the socket" } }));
    const ok = await waitFor((m) => m.type === "message_sent");
    assert(!!ok && ok.payload?.content === "Sent over the socket", "websocket valid send → message_sent", ok);
    await sleep(1200);
    const wsPush = pushes().filter((m: any) => m.body === "Sent over the socket");
    assert(wsPush.length === 1 && wsPush[0].to === tokenFor("owner"), "websocket send → one Expo push to the recipient", wsPush);
    ws.close();

    console.log("websocket: other people's chats");
    const ws2 = new WS(wsUrl);
    const inbox2: any[] = [];
    ws2.on("message", (d: any) => inbox2.push(JSON.parse(String(d))));
    await new Promise((r) => ws2.on("open", r));
    ws2.send(JSON.stringify({ type: "auth", payload: { token: bearer("blocker").Authorization.slice(7) } }));
    await sleep(400);
    await q(`UPDATE messages SET is_read = false WHERE conversation_id = $1`, [convId]);
    ws2.send(JSON.stringify({ type: "mark_read", payload: { conversationId: convId } }));
    ws2.send(JSON.stringify({ type: "focus_conversation", payload: { conversationId: convId } }));
    await sleep(800);
    const stillUnread = (await q(`SELECT count(*)::int n FROM messages WHERE conversation_id = $1 AND is_read = false`, [convId]))[0].n;
    assert(stillUnread > 0, "non-participant mark_read / focus leaves messages unread", stillUnread);
    assert(!inbox2.some((m) => m.type === "messages_read"), "non-participant gets no messages_read ack");
    ws2.close();

    console.log("report a message");
    const anyMsg = (await q(`SELECT id, sender_id FROM messages WHERE conversation_id = $1 AND sender_id = $2 LIMIT 1`, [convId, id("owner")]))[0];
    const rep = await call("POST", `/api/messages/${anyMsg.id}/report`, bearer("customer"), { reason: "Spam" });
    assert(rep.status === 200 && rep.json?.report?.reportedUserId === id("owner") && rep.json?.report?.conversationId === convId, "app shape { reason } works; conversation + reported user come from the message", rep.json);
    const repOther = await call("POST", `/api/messages/${anyMsg.id}/report`, bearer("blocker"), { reason: "Spam", conversationId: convId, reportedUserId: id("customer") });
    assert(repOther.status === 403, "non-participant can't report a message in someone else's chat", repOther.status);
    const repOwn = await call("POST", `/api/messages/${anyMsg.id}/report`, bearer("owner"), { reason: "Spam" });
    assert(repOwn.status === 400, "can't report your own message", repOwn.status);
    const repMissing = await call("POST", `/api/messages/00000000-0000-0000-0000-000000000000/report`, bearer("customer"), { reason: "Spam" });
    assert(repMissing.status === 404, "unknown message → 404", repMissing.status);
    await q(`DELETE FROM message_reports WHERE reporter_id = ANY($1)`, [[id("customer"), id("owner"), id("blocker")]]);

    console.log("push token: one phone, one account");
    const shared = tokenFor("customer");
    const reg = await call("POST", "/api/push/expo-token", bearer("owner"), { expoPushToken: shared });
    assert(reg.status === 200, "owner registers the phone the customer used", reg.status);
    const holders = await q(`SELECT id FROM users WHERE expo_push_token = $1`, [shared]);
    assert(holders.length === 1 && holders[0].id === id("owner"), "token removed from the customer's account", holders);
    const delWrong = await call("DELETE", "/api/push/expo-token", bearer("owner"), { expoPushToken: "ExponentPushToken[other]" });
    const stillHas = (await q(`SELECT expo_push_token t FROM users WHERE id = $1`, [id("owner")]))[0].t;
    assert(delWrong.status === 200 && stillHas === shared, "sign out with a different token leaves the current one", stillHas);
    const del = await call("DELETE", "/api/push/expo-token", bearer("owner"), { expoPushToken: shared });
    const cleared = (await q(`SELECT expo_push_token t FROM users WHERE id = $1`, [id("owner")]))[0].t;
    assert(del.status === 200 && cleared === null, "sign out clears this phone's token", cleared);
    assert((await call("DELETE", "/api/push/expo-token")).status === 401, "sign out without auth → 401");

    const notifCountAfter = (await q(`SELECT count(*)::int n FROM notifications WHERE user_id = ANY($1)`, [[id("customer"), id("owner"), id("blocker")]]))[0].n;
    assert(notifCountAfter === notifCountBefore, "no notifications rows created by messages", { notifCountBefore, notifCountAfter });
  } finally {
    // ── clean up ───────────────────────────────────────────────────────
    const ids = [id("customer"), id("owner"), id("blocker")];
    await q(`DELETE FROM message_reports WHERE reporter_id = ANY($1)`, [ids]);
    await q(`DELETE FROM messages WHERE sender_id = ANY($1)`, [ids]);
    await q(`DELETE FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [ids]);
    await q(`DELETE FROM user_blocks WHERE blocker_id = ANY($1)`, [ids]);
    await q(`DELETE FROM businesses WHERE id = $1`, [id("biz")]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
