/**
 * Pure tests for broadcasts and the email history helpers (no database, no network).
 * Run with: npx tsx server/broadcasts/broadcasts.test.ts   (DATABASE_URL must be set, db.ts throws on import)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.API_BASE_URL = "https://api.example.test";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

(async () => {
  const B = await import("./broadcasts");
  const H = await import("../emailHistory");
  const R = await import("../routes/emailAdmin");

  // ── personalize ──
  assert(B.personalize("Hi {{first_name}}!", "Adia", true) === "Hi Adia!", "fills {{first_name}}");
  assert(B.personalize("Hi {{ FIRST_NAME }}", "Adia", true) === "Hi Adia", "any spacing and case");
  assert(B.personalize("Hi {{first_name}}", null, true) === "Hi there", "no name → 'there'");
  assert(B.personalize("Hi {{first_name}}", "  ", true) === "Hi there", "blank name → 'there'");
  assert(B.personalize("Hi {{first_name}}", "<b>x</b>", true) === "Hi &lt;b&gt;x&lt;/b&gt;", "name is escaped in HTML");
  assert(B.personalize("Hi {{first_name}}", "Jo & Co", false) === "Hi Jo & Co", "subject keeps the raw name");

  // ── render ──
  {
    const m = B.renderBroadcast({ subject: "News for {{first_name}}", html: "<html><body><h1>Hello {{first_name}}</h1><p>New <a href=\"https://goutsyde.com\">drop</a></p></body></html>", firstName: "Sam", unsubUrl: "https://api.example.test/u" });
    assert(m.subject === "News for Sam", "subject personalized", m.subject);
    assert(m.html.includes("<h1>Hello Sam</h1>"), "body personalized");
    assert(m.html.indexOf("Unsubscribe from announcements") < m.html.indexOf("</body>") && m.html.includes('href="https://api.example.test/u"'), "unsubscribe footer goes inside </body>");
    assert((m.html.match(/<\/body>/g) || []).length === 1, "still one </body>");
    assert(m.text.includes("Hello Sam") && m.text.includes("drop (https://goutsyde.com)") && m.text.endsWith("Unsubscribe from announcements: https://api.example.test/u"), "plain text version with links and unsubscribe", m.text);
    const frag = B.renderBroadcast({ subject: "S", html: "<p>Short</p>", firstName: null, unsubUrl: "https://u" });
    assert(frag.html.startsWith("<p>Short</p>") && frag.html.includes("Unsubscribe from announcements"), "fragment HTML gets the footer appended");
    assert(!/[‒-―]/.test(B.unsubscribeFooter("https://u")), "footer copy has no dashes");
  }

  // ── htmlToText ──
  assert(B.htmlToText("<style>p{}</style><p>One</p><p>Two&nbsp;&amp; three</p>") === "One\nTwo & three", "text strips styles and tags", B.htmlToText("<style>p{}</style><p>One</p><p>Two&nbsp;&amp; three</p>"));

  // ── unsubscribe signature ──
  {
    const sig = B.broadcastUnsubSig("user-1");
    assert(sig.length === 32 && B.verifyBroadcastUnsubSig("user-1", sig), "signature verifies");
    assert(!B.verifyBroadcastUnsubSig("user-2", sig), "signature is per user");
    assert(!B.verifyBroadcastUnsubSig("user-1", "x".repeat(32)) && !B.verifyBroadcastUnsubSig("", sig), "bad or empty rejected");
    const setup = await import("../accountSetup/emails");
    assert(setup.unsubscribeSig("user-1") !== sig, "different key from setup reminders unsubscribe");
    assert(B.broadcastUnsubUrl("a b").startsWith("https://api.example.test/api/broadcasts/unsubscribe?u=a%20b&s="), "unsubscribe url");
    process.env.EMAIL_LINK_BASE_URL = "https://www.goutsyde.com/";
    assert(B.broadcastUnsubUrl("a b").startsWith("https://www.goutsyde.com/api/broadcasts/unsubscribe?u=a%20b&s="), "EMAIL_LINK_BASE_URL wins, trailing slash trimmed", B.broadcastUnsubUrl("a b"));
    assert(B.broadcastUnsubUrl("a b").endsWith(`&s=${B.broadcastUnsubSig("a b")}`), "same signature on the new host");
    delete process.env.EMAIL_LINK_BASE_URL;
  }

  // ── request validation ──
  {
    assert(R.checkContent({ subject: "", html: "<p>x</p>" }) === "Add a subject.", "subject required");
    assert(R.checkContent({ subject: "a\nb", html: "<p>x</p>" }) === "The subject must be one line.", "one line subject");
    assert(R.checkContent({ subject: "x".repeat(201), html: "<p>x</p>" }).toString().startsWith("Keep the subject"), "subject max");
    assert(R.checkContent({ subject: "Hi", html: "  " }) === "Add the email HTML.", "html required");
    assert(R.checkContent({ subject: "Hi", html: "x".repeat(200_001) }) === "The HTML is too large (200 KB max).", "html max");
    const ok = R.checkContent({ subject: "  Hi  ", html: "<p>x</p>" });
    assert(typeof ok === "object" && ok.subject === "Hi", "subject trimmed");
    assert(R.checkAudience({ audience: "everyone" }) === "Pick who to send to.", "unknown audience rejected");
    assert(JSON.stringify(R.checkAudience({ audience: "vendors", userIds: ["x"] })) === JSON.stringify({ audience: "vendors" }), "userIds ignored unless picked");
    assert(typeof R.checkAudience({ audience: "picked", userIds: [] }) === "string", "picked needs ids");
    assert(typeof R.checkAudience({ audience: "picked", userIds: [1] }) === "string", "ids must be strings");
    assert(typeof R.checkAudience({ audience: "picked", userIds: Array.from({ length: 501 }, (_, i) => `u${i}`) }) === "string", "max 500 picked");
    const p = R.checkAudience({ audience: "picked", userIds: ["a", "a", "b"] });
    assert(typeof p === "object" && p.userIds?.length === 2, "duplicate ids removed");
    for (const a of B.AUDIENCES) assert(typeof B.audienceFilter(a, ["x"]) === "object", `audience filter exists: ${a}`);
  }

  // ── history helpers ──
  {
    assert(H.pgTextArray(["a", 'b"c', "d\\e"]) === '{"a","b\\"c","d\\\\e"}', "text[] literal escapes", H.pgTextArray(["a", 'b"c', "d\\e"]));
    const prev = process.env.BROADCAST_DAILY_LIMIT;
    delete process.env.BROADCAST_DAILY_LIMIT; assert(H.dailyLimit() === 80, "default daily limit 80");
    process.env.BROADCAST_DAILY_LIMIT = "25"; assert(H.dailyLimit() === 25, "limit from env");
    process.env.BROADCAST_DAILY_LIMIT = "off"; assert(H.dailyLimit() === null, "'off' disables");
    process.env.BROADCAST_DAILY_LIMIT = "0"; assert(H.dailyLimit() === null, "'0' disables");
    process.env.BROADCAST_DAILY_LIMIT = "abc"; assert(H.dailyLimit() === 80, "junk → default");
    if (prev === undefined) delete process.env.BROADCAST_DAILY_LIMIT; else process.env.BROADCAST_DAILY_LIMIT = prev;
    // 2026-10-16 13:30 UTC = 09:30 New York (EDT) → day starts 04:00 UTC
    assert(H.startOfNewYorkDay(new Date("2026-10-16T13:30:00Z")).toISOString() === "2026-10-16T04:00:00.000Z", "New York day start (EDT)");
    // 2026-12-01 03:00 UTC = Nov 30 22:00 New York (EST) → day starts Nov 30 05:00 UTC
    assert(H.startOfNewYorkDay(new Date("2026-12-01T03:00:00Z")).toISOString() === "2026-11-30T05:00:00.000Z", "New York day start (EST, previous UTC day)");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
