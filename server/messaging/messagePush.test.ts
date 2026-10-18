/**
 * Message push + message rules unit tests (no DB, no network) — run with:
 *   npx tsx server/messaging/messagePush.test.ts
 */
import { notifyNewMessage, buildMessagePreview, type NotifyDeps } from "./notifyNewMessage";
import { checkMessageContent, isRepeatedMessage, checkOutgoingMessage, messageSummary, toClientMessage } from "./messageRules";
import { normalizeQuery, likePattern, snippetAround } from "./messagingSearch";

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

  console.log("photos: checkOutgoingMessage");
  const R2 = "https://pub-x.r2.dev";
  const uuid = (i: number) => `0000000${i}-1111-4222-8333-44444444444${i % 10}`.slice(-36);
  const ph = (n: number) => Array.from({ length: n }, (_, i) => `${R2}/messages/${uuid(i)}.jpeg`);
  let c = checkOutgoingMessage({ content: "hi" }, R2);
  assert(c.ok && c.content === "hi" && c.mediaItems.length === 0, "text only still works (old app shape)", c);
  c = checkOutgoingMessage({ mediaItems: ph(1) }, R2);
  assert(c.ok && c.content === "" && c.mediaItems.length === 1, "photo only, no text: ok", c);
  c = checkOutgoingMessage({ content: "  ", mediaItems: ph(2) }, R2);
  assert(c.ok && c.content === "", "photos + blank text: ok, text stored empty", c);
  c = checkOutgoingMessage({ content: "look", mediaItems: ph(10) }, R2);
  assert(c.ok && c.mediaItems.length === 10, "10 photos ok");
  c = checkOutgoingMessage({ content: "look", mediaItems: ph(11) }, R2);
  assert(!c.ok && (c as any).code === "TOO_MANY_PHOTOS", "11 photos rejected", c);
  c = checkOutgoingMessage({ mediaItems: ["https://evil.com/messages/a.jpg"] }, R2);
  assert(!c.ok && (c as any).code === "INVALID_MEDIA_URL", "foreign photo URL rejected", c);
  c = checkOutgoingMessage({ mediaItems: [`${R2}/posts/a.jpg`] }, R2);
  assert(!c.ok && (c as any).code === "INVALID_MEDIA_URL", "R2 URL outside the messages folder rejected", c);
  c = checkOutgoingMessage({ mediaItems: ph(1) }, undefined);
  assert(!c.ok, "photos refused when R2_PUBLIC_URL is not set");
  c = checkOutgoingMessage({ mediaItems: "nope" }, R2);
  assert(!c.ok && (c as any).code === "INVALID_MEDIA", "non-array photos rejected");
  c = checkOutgoingMessage({ content: "", mediaItems: [] }, R2);
  assert(!c.ok, "no text and no photos rejected");
  c = checkOutgoingMessage({ content: "x".repeat(2001), mediaItems: ph(1) }, R2);
  assert(!c.ok, "photos don't bypass the 2000 char limit");
  c = checkOutgoingMessage({ mediaItems: ph(1) }, R2 + "/");
  assert(c.ok, "trailing slash on R2_PUBLIC_URL handled (trimmed form)");
  c = checkOutgoingMessage({ mediaItems: [`${R2}//messages/${uuid(1)}.jpeg`] }, R2 + "/");
  assert(c.ok, "trailing slash on R2_PUBLIC_URL handled (form r2.ts actually builds)");
  c = checkOutgoingMessage({ mediaItems: [`${R2}/messages/../profiles/${uuid(1)}.jpeg`] }, R2);
  assert(!c.ok, "path traversal refused");
  c = checkOutgoingMessage({ mediaItems: [`${R2}/messages/${uuid(1)}.jpeg?x=1`] }, R2);
  assert(!c.ok, "query string refused");
  c = checkOutgoingMessage({ mediaItems: [`${R2}/messages/${uuid(1)}.svg`] }, R2);
  assert(!c.ok, "non-image extension refused");
  c = checkOutgoingMessage({ mediaItems: [`${R2}/messages/notauuid.jpeg`] }, R2);
  assert(!c.ok, "file name that the upload route never makes refused");

  console.log("messageSummary + toClientMessage");
  assert(messageSummary("hey", ph(2)) === "hey", "text wins over photos");
  assert(messageSummary("", ph(1)) === "Sent a photo", "1 photo → Sent a photo");
  assert(messageSummary("", ph(3)) === "Sent 3 photos", "3 photos → Sent 3 photos");
  assert(messageSummary("", []) === "", "nothing → empty");
  const cm = toClientMessage({ id: "1", content: "", mediaItems: ph(1) });
  assert(cm.content === "Sent a photo" && cm.text === "" && cm.mediaItems.length === 1, "photo only: content readable for old apps, text empty for new app", cm);
  const cm2 = toClientMessage({ id: "2", content: "yo", mediaItems: undefined as any });
  assert(cm2.content === "yo" && cm2.text === "yo" && Array.isArray(cm2.mediaItems) && cm2.mediaItems.length === 0, "old row without media: mediaItems = []", cm2);

  console.log("repeat check with photos");
  const rp = [{ senderId: "a", content: "", mediaItems: ph(1) }, { senderId: "a", content: "", mediaItems: ph(1) }];
  assert(isRepeatedMessage(rp, "a", "", ph(1)) === true, "same photo sent a third time blocked");
  assert(isRepeatedMessage(rp, "a", "", ph(2)) === false, "different photos not blocked");

  console.log("search helpers");
  assert(normalizeQuery("@braids") === "braids", "leading @ dropped");
  assert(normalizeQuery(" a ") === null && normalizeQuery("") === null && normalizeQuery(5) === null, "under 2 chars / non-string → null");
  assert((normalizeQuery("x".repeat(100)) || "").length === 60, "capped at 60 chars");
  assert(likePattern("50%_off\\") === "%50\\%\\_off\\\\%", "ILIKE wildcards escaped", likePattern("50%_off\\"));
  const longText = "word ".repeat(40) + "Saturday at noon works " + "more ".repeat(40);
  const sn = snippetAround(longText, "saturday");
  assert(sn.toLowerCase().includes("saturday") && sn.length <= 92 && sn.startsWith("…") && sn.endsWith("…"), "snippet centers on the match", sn);
  assert(snippetAround("short one", "one") === "short one", "short text unchanged");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
