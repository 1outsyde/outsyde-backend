/**
 * Message photos + messaging search HTTP tests — run with:
 *   npx tsx server/messaging/messagingPhotosSearch.http.test.ts
 *
 * SCRATCH ONLY. Same setup as messaging.http.test.ts, plus the backend must run with a fake R2:
 *   R2_ENDPOINT=http://127.0.0.1:<port> R2_PUBLIC_URL=http://127.0.0.1:<port>/<bucket> (any server
 *   that answers PUT 200), and migration 055 applied to the scratch DB.
 *   MSG_TEST_BASE_URL, MSG_TEST_PG_URL, MSG_TEST_EXPO_FILE, JWT_SECRET as in messaging.http.test.ts.
 *
 * Rules under test:
 *  - Upload folder "messages" takes photos only; returns a URL under R2_PUBLIC_URL/messages/.
 *  - A message can be photos only, text + photos, or text only (old app shape).
 *  - Photo only: stored content '', API content "Sent a photo" (old apps), text '' + mediaItems (new app),
 *    inbox preview and push body "Sent a photo" / "Sent N photos".
 *  - Max 10 photos; URLs must be Outsyde uploads in the messages folder.
 *  - Recipients: matches the public name (business name, photographer name, users.name) or @username;
 *    never a business owner's personal name; excludes self, blocked either way, banned, deleted;
 *    returns the existing conversation id; never returns email.
 *  - Message search: only the caller's own conversations.
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
// 1x1 JPEG
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

(async () => {
  if (!BASE) { console.log("⏭  skipped: set MSG_TEST_BASE_URL (+ MSG_TEST_PG_URL, MSG_TEST_EXPO_FILE)"); process.exit(0); }
  if (!PG_URL || !EXPO_FILE || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: local scratch only");

  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `mps${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const people: Record<string, { name: string; vendor?: boolean; photographer?: boolean; active?: boolean; deleted?: boolean }> = {
    tia: { name: `Tia ${P} Customer` },
    owner: { name: `Danei${P} Realname`, vendor: true },
    lens: { name: `Lenny ${P} Person`, photographer: true },
    blocker: { name: `Braids${P} Blocker` },
    banned: { name: `Braids${P} Banned`, active: false },
    gone: { name: `Braids${P} Gone`, deleted: true },
  };
  for (const [who, v] of Object.entries(people)) {
    await q(`INSERT INTO users (id, username, email, password, name, expo_push_token, is_vendor, is_photographer, is_active, deletion_status)
             VALUES ($1::varchar, $2, $3, 'x', $4, $5, $6, $7, $8, $9)`,
      [id(who), `${who}_${P}`, `${id(who)}@x.test`, v.name, `ExponentPushToken[${id(who)}]`, !!v.vendor, !!v.photographer, v.active !== false, v.deleted ? "deleted" : "active"]);
  }
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, $3, 'Hair', 'approved')`, [id("biz"), id("owner"), `Braids${P} Studio`]);
  await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate) VALUES ($1, $2, $3, 100)`, [id("ph"), id("lens"), `Lens${P} Pro`]);
  await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [id("blocker"), id("tia")]);

  const auth = (who: string) => ({ Authorization: `Bearer ${generateAccessToken({ userId: id(who), isVendor: !!people[who].vendor })}` });
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json: any = null; try { json = await res.json(); } catch {}
    return { status: res.status, json, raw: JSON.stringify(json) };
  };
  const upload = async (who: string, buf: Buffer, type: string, name: string) => {
    const fd = new FormData();
    fd.append("folder", "messages");
    fd.append("file", new Blob([buf], { type }), name);
    const res = await fetch(`${BASE}/api/media/upload-image`, { method: "POST", headers: auth(who), body: fd });
    let json: any = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const pushes = () => fs.readFileSync(EXPO_FILE, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { const j = JSON.parse(l); return Array.isArray(j) ? j : [j]; } catch { return []; } }).filter((m: any) => String(m.to).includes(P));

  try {
    console.log("upload");
    const up = await upload("tia", JPEG, "image/jpeg", "a.jpg");
    assert(up.status === 200 && /\/messages\/[0-9a-f-]+\.jpeg$/.test(up.json?.url || ""), "photo uploads to the messages folder", up);
    const bad = await upload("tia", Buffer.from("hello"), "text/plain", "a.txt");
    assert(bad.status === 400 && bad.json?.code === "INVALID_FILE_TYPE", "non-image refused in messages folder", bad);
    const urls = [up.json.url];
    for (let i = 0; i < 2; i++) urls.push((await upload("tia", JPEG, "image/png", "b.png")).json.url);

    const conv = (await call("POST", "/api/conversations", auth("tia"), { participantId: id("owner"), participantType: "user" })).json.conversation.id;

    console.log("send photos");
    const photoOnly = await call("POST", `/api/conversations/${conv}/messages`, auth("tia"), { mediaItems: [urls[0]] });
    const m1 = photoOnly.json?.message;
    assert(photoOnly.status === 200 && m1?.text === "" && m1?.content === "Sent a photo" && m1?.mediaItems?.[0] === urls[0], "photo only: text '', content 'Sent a photo', mediaItems", m1);
    const stored = (await q(`SELECT content, media_items FROM messages WHERE id = $1`, [m1.id]))[0];
    assert(stored.content === "" && stored.media_items.length === 1, "DB stores empty text + the photo", stored);
    const prev = (await q(`SELECT last_message_preview FROM conversations WHERE id = $1`, [conv]))[0].last_message_preview;
    assert(prev === "Sent a photo", "inbox preview 'Sent a photo'", prev);
    await sleep(1200);
    let p = pushes().filter((x: any) => x.to.includes("owner"));
    assert(p.length === 1 && p[0].body === "Sent a photo" && p[0].title === people.tia.name, "push: sender name + 'Sent a photo'", p);

    const multi = await call("POST", `/api/conversations/${conv}/messages`, auth("tia"), { content: "Is this style possible?", mediaItems: urls });
    assert(multi.status === 200 && multi.json?.message?.text === "Is this style possible?" && multi.json?.message?.mediaItems?.length === 3, "text + 3 photos", multi.json?.message);
    const three = await call("POST", `/api/conversations/${conv}/messages`, auth("tia"), { mediaItems: urls });
    assert(three.json?.message?.content === "Sent 3 photos", "3 photos only → 'Sent 3 photos'", three.json?.message?.content);
    await sleep(1200);
    p = pushes().filter((x: any) => x.to.includes("owner"));
    assert(p.some((x: any) => x.body === "Is this style possible?") && p.some((x: any) => x.body === "Sent 3 photos"), "push bodies use text, else photo count", p.map((x: any) => x.body));

    const eleven = await call("POST", `/api/conversations/${conv}/messages`, auth("tia"), { mediaItems: Array(11).fill(urls[0]) });
    assert(eleven.status === 400 && eleven.json?.code === "TOO_MANY_PHOTOS", "11 photos → 400", eleven.json);
    const foreign = await call("POST", `/api/conversations/${conv}/messages`, auth("tia"), { mediaItems: ["https://evil.example/messages/x.jpg"] });
    assert(foreign.status === 400 && foreign.json?.code === "INVALID_MEDIA_URL", "foreign photo URL → 400", foreign.json);
    const textOnly = await call("POST", `/api/conversations/${conv}/messages`, auth("owner"), { content: "Yes Saturday works for that" });
    assert(textOnly.status === 200 && textOnly.json?.message?.mediaItems?.length === 0 && textOnly.json?.message?.content === "Yes Saturday works for that", "text only (old app shape) unchanged + mediaItems []", textOnly.json?.message);

    const list = await call("GET", `/api/conversations/${conv}/messages`, auth("owner"));
    const withPhotos = (list.json?.messages || []).filter((m: any) => m.mediaItems.length > 0);
    assert(list.status === 200 && withPhotos.length === 3 && list.json.messages.every((m: any) => typeof m.text === "string"), "GET messages returns mediaItems + text on every message", list.json?.messages?.length);

    console.log("recipients");
    const r1 = await call("GET", `/api/messages/recipients?q=${encodeURIComponent("braids" + P)}`, auth("tia"));
    const names1 = (r1.json?.results || []).map((x: any) => x.publicName);
    assert(r1.status === 200 && names1.includes(`Braids${P} Studio`), "finds the business by its business name", names1);
    const biz = r1.json.results.find((x: any) => x.publicName === `Braids${P} Studio`);
    assert(biz?.type === "business" && biz?.participantId === id("owner") && biz?.participantType === "user" && biz?.conversationId === conv && biz?.businessId === id("biz"), "business row: type, owner user id, existing conversation", biz);
    assert(!names1.includes(people.banned.name) && !names1.includes(people.gone.name), "banned and deleted accounts excluded", names1);
    assert(!names1.includes(people.blocker.name), "someone who blocked you is excluded", names1);
    assert(!r1.raw.includes("@x.test"), "no emails in results");
    const r2 = await call("GET", `/api/messages/recipients?q=${encodeURIComponent("danei" + P)}`, auth("tia"));
    assert(r2.status === 200 && r2.json.results.length === 0, "business owner's personal name never matches", r2.json?.results);
    const r3 = await call("GET", `/api/messages/recipients?q=${encodeURIComponent("@lens_" + P)}`, auth("tia"));
    assert(r3.json?.results?.[0]?.publicName === `Lens${P} Pro` && r3.json.results[0].type === "photographer", "finds a photographer by @username, shows display name", r3.json?.results);
    const r4 = await call("GET", `/api/messages/recipients?q=${encodeURIComponent("tia " + P)}`, auth("owner"));
    assert(r4.json?.results?.[0]?.publicName === people.tia.name && r4.json.results[0].type === "consumer" && r4.json.results[0].conversationId === conv, "business finds the customer + existing chat", r4.json?.results);
    const r5 = await call("GET", `/api/messages/recipients?q=${encodeURIComponent("tia " + P)}`, auth("tia"));
    assert(r5.json?.results?.length === 0, "never returns yourself", r5.json?.results);
    const r6 = await call("GET", `/api/messages/recipients?q=${encodeURIComponent("braids" + P)}`, auth("blocker"));
    assert(!(r6.json?.results || []).some((x: any) => x.userId === id("tia")), "blocker doesn't see the person they blocked either");
    assert((await call("GET", `/api/messages/recipients?q=a`, auth("tia"))).status === 400, "1 char → 400");
    assert((await call("GET", `/api/messages/recipients?q=braids`)).status === 401, "no auth → 401");
    const wild = await call("GET", `/api/messages/recipients?q=${encodeURIComponent("%%")}`, auth("tia"));
    assert(wild.status === 200 && wild.json.results.length === 0, "% is matched literally, not as a wildcard", wild.json?.results?.length);

    console.log("message search");
    const lensConv = (await call("POST", "/api/conversations", auth("lens"), { participantId: id("owner"), participantType: "user" })).json.conversation.id;
    await call("POST", `/api/conversations/${lensConv}/messages`, auth("lens"), { content: "Private saturday shoot plan" });
    const s1 = await call("GET", `/api/messages/search?q=saturday`, auth("tia"));
    const convs = (s1.json?.results || []).map((x: any) => x.conversationId);
    assert(s1.status === 200 && convs.includes(conv), "finds text in your own chat", s1.json);
    assert(!convs.includes(lensConv), "never returns other people's chats");
    const hit = s1.json.results.find((x: any) => x.conversationId === conv);
    assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(hit?.createdAt || "") && Math.abs(Date.parse(hit.createdAt) - Date.now()) < 5 * 60 * 1000, "createdAt is ISO UTC with Z and matches now", hit?.createdAt);
    assert(hit?.otherParticipant?.publicName === `Braids${P} Studio` && hit?.fromMe === false && /saturday/i.test(hit?.snippet || ""), "result shows the other side's public name + snippet", hit);
    const s2 = await call("GET", `/api/messages/search?q=saturday`, auth("owner"));
    assert((s2.json?.results || []).length === 2, "owner sees matches from both of their chats", s2.json?.results?.length);
    assert((await call("GET", `/api/messages/search?q=s`, auth("tia"))).status === 400, "1 char → 400");
    assert((await call("GET", `/api/messages/search?q=saturday`)).status === 401, "no auth → 401");
  } finally {
    const ids = Object.keys(people).map(id);
    await q(`DELETE FROM messages WHERE sender_id = ANY($1)`, [ids]);
    await q(`DELETE FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [ids]);
    await q(`DELETE FROM user_blocks WHERE blocker_id = ANY($1)`, [ids]);
    await q(`DELETE FROM photographers WHERE id = $1`, [id("ph")]);
    await q(`DELETE FROM businesses WHERE id = $1`, [id("biz")]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
