/**
 * Message push + message rules unit tests (no DB, no network) — run with:
 *   npx tsx server/messaging/messagePush.test.ts
 */
import { notifyNewMessage, buildMessagePreview, type NotifyDeps } from "./notifyNewMessage";
import { checkMessageContent, isRepeatedMessage } from "./messageRules";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

function fakeDeps(over: Partial<NotifyDeps> = {}) {
  const calls = { expo: [] as any[], web: [] as any[] };
  const deps: NotifyDeps = {
    sendExpoPush: async (p) => { calls.expo.push(p); return true; },
    isWebPushConfigured: () => true,
    getWebPushSubscriptions: async () => [],
    sendWebPush: async (sub, payload) => { calls.web.push({ sub, payload }); },
    getUnreadCount: async () => 3,
    log: () => {},
    ...over,
  };
  return { deps, calls };
}

const base = {
  conversationId: "conv-1",
  messageId: "msg-1",
  senderId: "u-sender",
  recipientId: "u-recipient",
  content: "See you at 3",
  senderPublicName: "Braids With Love",
};

(async () => {
  console.log("notifyNewMessage");
  {
    const { deps, calls } = fakeDeps();
    const r = await notifyNewMessage(base, deps);
    assert(r.expo === true && calls.expo.length === 1, "sends one Expo push to the recipient");
    const p = calls.expo[0];
    assert(p.userId === "u-recipient", "Expo push goes to the recipient, not the sender", p);
    assert(p.title === "Braids With Love", "title is the sender's public name", p.title);
    assert(p.body === "See you at 3", "body is the message preview", p.body);
    assert(p.data.type === "new_message" && p.data.conversationId === "conv-1" && p.data.messageId === "msg-1" && p.data.senderId === "u-sender", "data carries type + ids for the tap", p.data);
    assert(Object.values(p.data).every((v) => typeof v === "string"), "every data value is a string (Expo SDK type)", p.data);
    assert(p.data.badgeCount === "3", "badge count included", p.data);
  }
  {
    const { deps, calls } = fakeDeps();
    await notifyNewMessage({ ...base, recipientId: "u-sender" }, deps);
    assert(calls.expo.length === 0 && calls.web.length === 0, "never pushes to the sender themselves");
  }
  {
    const { deps, calls } = fakeDeps();
    await notifyNewMessage({ ...base, senderPublicName: null }, deps);
    assert(calls.expo[0].title === "New message", "falls back to 'New message' with no name", calls.expo[0].title);
  }
  {
    const { deps, calls } = fakeDeps({ getWebPushSubscriptions: async () => [{ id: "a" }, { id: "b" }] });
    const r = await notifyNewMessage(base, deps);
    assert(r.webDevices === 2 && calls.web.length === 2, "web push still sent to every subscription");
    const w = calls.web[0].payload;
    assert(w.url === "/messages?conversation=conv-1" && w.tag === "message-conv-1" && w.data.type === "new_message" && w.data.senderDisplayName === "Braids With Love" && w.data.badgeCount === 3, "web push payload shape unchanged", w);
  }
  {
    const { deps, calls } = fakeDeps({ isWebPushConfigured: () => false, getWebPushSubscriptions: async () => [{ id: "a" }] });
    await notifyNewMessage(base, deps);
    assert(calls.web.length === 0 && calls.expo.length === 1, "no VAPID config: skips web push, still sends Expo push");
  }
  {
    const { deps, calls } = fakeDeps({ sendExpoPush: async () => { throw new Error("expo down"); }, getWebPushSubscriptions: async () => [{ id: "a" }] });
    let threw = false;
    try { await notifyNewMessage(base, deps); } catch { threw = true; }
    assert(!threw && calls.web.length === 1, "Expo failure never throws and web push still goes out");
  }
  {
    const { deps, calls } = fakeDeps({ getUnreadCount: async () => { throw new Error("db"); } });
    let threw = false;
    try { await notifyNewMessage(base, deps); } catch { threw = true; }
    assert(!threw && calls.expo.length === 1 && calls.expo[0].data.badgeCount === undefined, "unread count failure: push still sent, no badge");
  }

  console.log("buildMessagePreview");
  assert(buildMessagePreview("  hi   there \n you ") === "hi there you", "collapses whitespace");
  const long = "a".repeat(80);
  const prev = buildMessagePreview(long);
  assert(prev.length === 50 && prev.endsWith("..."), "cuts long text to 50 chars with ...", prev.length);

  console.log("checkMessageContent");
  assert(checkMessageContent("hello").ok === true, "normal text passes");
  assert(checkMessageContent("").ok === false, "empty rejected");
  assert(checkMessageContent("   ").ok === false, "whitespace only rejected");
  assert(checkMessageContent(undefined).ok === false, "missing rejected");
  assert(checkMessageContent(42 as any).ok === false, "non-string rejected");
  assert(checkMessageContent("x".repeat(2000)).ok === true, "2000 chars passes");
  assert(checkMessageContent("x".repeat(2001)).ok === false, "2001 chars rejected");
  const six = Array.from({ length: 6 }, (_, i) => `https://a.com/${i}`).join(" ");
  const five = Array.from({ length: 5 }, (_, i) => `https://a.com/${i}`).join(" ");
  assert(checkMessageContent(five).ok === true && checkMessageContent(six).ok === false, "5 links ok, 6 rejected");

  console.log("isRepeatedMessage");
  const recent = [{ senderId: "a", content: "yo" }, { senderId: "a", content: "yo" }, { senderId: "b", content: "yo" }];
  assert(isRepeatedMessage(recent, "a", "yo") === true, "third identical message from same sender blocked");
  assert(isRepeatedMessage(recent, "b", "yo") === false, "other sender not blocked");
  assert(isRepeatedMessage(recent, "a", "different") === false, "different text not blocked");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
