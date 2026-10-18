/**
 * Influencer applications (2026-10-18): HTTP integration tests.
 *
 * Run with: npx tsx server/influencerApplications.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres that has
 * migration 057 applied. The server must NOT have INFLUENCER_ATTRIBUTION_ENABLED=true.
 *   PS_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   PS_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when PS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - remove the INFLUENCER_ATTRIBUTION_ENABLED check → "attribution stays off" fails.
 *  - remove ensureInfluencerPromoCode from the PATCH approve → "approve gives a promo code" fails.
 *  - remove the NotificationTriggers.newInfluencerApplication call → "admins get an in-app alert" fails.
 */
import http from "http";

const BASE = process.env.PS_TEST_BASE_URL;
const PG_URL = process.env.PS_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ipCounter = 1;
async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { "X-Forwarded-For": `10.95.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json, raw: b }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set PS_TEST_BASE_URL + PS_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ps-test-jwt";
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `if${Date.now().toString(36)}`;
  const mk = async (s: string, extra = "") => {
    const [u] = await q(`INSERT INTO users (id, email, name, username, phone, city, state ${extra ? ", " + extra.split("=")[0] : ""}) VALUES (gen_random_uuid(), $1, $2, $3, '5165550100', 'Freeport', 'NY' ${extra ? ", " + extra.split("=")[1] : ""}) RETURNING id`, [`${P}-${s}@test.local`, `Person ${s}`, `${P}${s}`.slice(0, 20)]);
    return { id: u.id as string, token: generateAccessToken({ userId: u.id, isVendor: false, isAdmin: false }) };
  };

  let [admin] = await q(`SELECT id FROM users WHERE email = 'info@goutsyde.com'`);
  if (!admin) [admin] = await q(`INSERT INTO users (id, email, name, username, is_admin) VALUES (gen_random_uuid(), 'info@goutsyde.com', 'Admin', $1, true) RETURNING id`, [`${P}adm`.slice(0, 20)]);
  else await q(`UPDATE users SET is_admin = true WHERE id = $1`, [admin.id]);
  const adminToken = generateAccessToken({ userId: admin.id, isVendor: false, isAdmin: true });

  try {
    console.log("\n=== Apply: every answer saved ===");
    const full = await mk("full");
    let r = await call("POST", "/api/influencer/apply", { token: full.token, body: {
      instagramUrl: "@kat.style", tiktokUrl: "@katt", youtubeUrl: "https://youtube.com/@kat", twitterUrl: "katx",
      instagramFollowers: "12,000", tiktokFollowers: "3.5k", youtubeFollowers: 500, twitterFollowers: 0,
      contentCategories: ["beauty", "other"], contentOther: "Braid tutorials", whyInfluencer: "I love local businesses",
    } });
    const [row] = await q(`SELECT * FROM influencer_applications WHERE user_id = $1`, [full.id]);
    assert(r.status === 201 && r.body?.application?.id === row?.id, "201 with the application", r.status);
    assert(row?.instagram_followers === 12000 && row?.tiktok_followers === 3500 && row?.youtube_followers === 500 && row?.twitter_followers === 0 && row?.follower_count === 16000, "followers per platform + total", row);
    assert(JSON.stringify(row?.content_categories) === '["beauty","other"]' && row?.content_other === "Braid tutorials" && row?.why_influencer === "I love local businesses", "categories, Other words, why saved");
    assert(row?.youtube_url === "https://youtube.com/@kat" && row?.twitter_url === "katx" && row?.status === "pending", "all 4 socials saved, pending");

    console.log("\n=== Older app payload (bio) ===");
    const old = await mk("old");
    r = await call("POST", "/api/influencer/apply", { token: old.token, body: { instagramUrl: "@old", tiktokUrl: null, followerCount: "2,500", bio: "Why text from the old app" } });
    const [oldRow] = await q(`SELECT * FROM influencer_applications WHERE user_id = $1`, [old.id]);
    assert(r.status === 201 && oldRow?.why_influencer === "Why text from the old app" && oldRow?.follower_count === 2500, "old app's bio now saved as why", oldRow);

    console.log("\n=== Bad input: 400 with field, nothing saved ===");
    const badU = await mk("bad");
    for (const [body, field] of [
      [{}, "socials"], [{ instagramUrl: "@b", followerCount: "lots" }, "followerCount"],
      [{ instagramUrl: "@b", contentCategories: ["nope"] }, "contentCategories"], [{ instagramUrl: "@b", contentCategories: ["other"] }, "contentOther"],
    ] as const) {
      r = await call("POST", "/api/influencer/apply", { token: badU.token, body });
      assert(r.status === 400 && r.body?.field === field, `400 field ${field}`, r.body);
    }
    assert((await q(`SELECT 1 FROM influencer_applications WHERE user_id = $1`, [badU.id])).length === 0, "nothing saved for bad input");
    r = await call("POST", "/api/influencer/apply", { body: { instagramUrl: "@x" } });
    assert(r.status === 401, "signed out → 401", r.status);
    r = await call("POST", "/api/influencer/apply", { token: full.token, body: { instagramUrl: "@again" } });
    assert(r.status === 400 && /already/i.test(r.body?.error ?? ""), "second application while pending → 400 Application already exists", r.body);

    console.log("\n=== Own status with the app token ===");
    r = await call("GET", "/api/influencer/application", { token: full.token });
    assert(r.status === 200 && r.body?.application?.status === "pending", "Bearer works (was session only)", r.status);

    console.log("\n=== Admin alert ===");
    await sleep(800);
    const notes = await q(`SELECT * FROM notifications WHERE user_id = $1 AND type = 'new_influencer_application' AND reference_id = $2`, [admin.id, row.id]);
    assert(notes.length === 1 && /applied to the Outsyde influencer program/.test(notes[0].message), "admins get an in-app alert", notes);
    assert(!/[–—]/.test(notes[0]?.message ?? ""), "no dashes in the alert");

    console.log("\n=== Admin list + detail ===");
    const userTok = full.token;
    for (const path of ["/api/admin/influencers", `/api/admin/influencers/${row.id}`]) {
      const a = await call("GET", path), b = await call("GET", path, { token: userTok });
      assert([401, 403].includes(a.status) && [401, 403].includes(b.status), `${path}: admins only`, { a: a.status, b: b.status });
    }
    r = await call("GET", "/api/admin/influencers?status=pending", { token: adminToken });
    const listed = (r.body?.applications ?? []).find((x: any) => x.id === row.id);
    assert(listed?.instagramFollowers === 12000 && JSON.stringify(listed?.contentCategoryLabels) === '["Beauty & Personal Care","Other"]' && listed?.user?.phone === "5165550100", "list: new fields added", listed);
    for (const k of ["id", "userId", "instagramUrl", "tiktokUrl", "youtubeUrl", "twitterUrl", "followerCount", "contentNiche", "whyInfluencer", "status", "adminNotes", "reviewedBy", "reviewedAt", "createdAt"]) {
      assert(k in (listed ?? {}), `list: ${k} still sent`);
    }
    r = await call("GET", `/api/admin/influencers/${row.id}`, { token: adminToken });
    const v = (t: string, l: string) => r.body?.signupDetails?.sections?.find((s: any) => s.title === t)?.rows?.find((x: any) => x.label === l)?.value;
    assert(r.status === 200 && v("Application", "Instagram") === "https://www.instagram.com/kat.style" && v("Application", "Total followers") === "16,000", "detail: application rows", r.body?.signupDetails);
    assert(v("Application", "What they post about") === "Beauty & Personal Care, Other" && v("Application", "Why they want to join") === "I love local businesses", "detail: categories + why");
    assert(v("Contact", "Phone") === "5165550100" && v("Contact", "City / state") === "Freeport, NY" && v("Status", "Status") === "Pending", "detail: contact + status");
    assert(!/"password"|resetTokenHash|stripeAccountId|ethnicity/.test(r.raw), "detail: no secrets");
    r = await call("GET", `/api/admin/influencers/00000000-0000-0000-0000-000000000000`, { token: adminToken });
    assert(r.status === 404, "unknown application → 404", r.status);

    console.log("\n=== Approve gives a promo code (both routes) ===");
    r = await call("PATCH", `/api/admin/influencers/${row.id}`, { token: adminToken, body: { status: "approved" } });
    let [prof] = await q(`SELECT * FROM influencer_profiles WHERE user_id = $1`, [full.id]);
    assert(r.status === 200 && !!prof?.promo_code && r.body?.promoCode === prof.promo_code && /^[A-Z0-9]{4,14}$/.test(prof.promo_code), "approve gives a promo code", { b: r.body, p: prof?.promo_code });
    const [fu] = await q(`SELECT is_influencer FROM users WHERE id = $1`, [full.id]);
    assert(fu?.is_influencer === true, "user flagged as influencer");
    r = await call("GET", `/api/admin/influencers/${row.id}`, { token: adminToken });
    assert(r.body?.application?.promoCode === prof.promo_code && v("Status", "Promo code") === prof.promo_code && v("Status", "Influencer") === "Yes", "detail shows the code");
    r = await call("POST", `/api/admin/influencer-applications/${oldRow.id}/approve`, { token: adminToken });
    [prof] = await q(`SELECT * FROM influencer_profiles WHERE user_id = $1`, [old.id]);
    assert(r.status === 200 && !!prof?.promo_code && prof.promo_code !== (await q(`SELECT promo_code FROM influencer_profiles WHERE user_id=$1`, [full.id]))[0].promo_code, "legacy approve route gives a different code", { b: r.body, p: prof?.promo_code });

    console.log("\n=== Money guard: attribution stays off ===");
    const buyer = await mk("buyer");
    r = await call("POST", "/api/influencer-tracking/attribute", { token: buyer.token, body: { refCode: prof.promo_code } });
    assert(r.status === 503 && (await q(`SELECT 1 FROM influencer_attributions WHERE user_id = $1`, [buyer.id])).length === 0, "attribution stays off, nothing saved", r);
  } finally {
    const ids = (await q(`SELECT id FROM users WHERE email LIKE $1`, [`${P}-%`])).map((x) => x.id);
    if (ids.length) {
      await q(`DELETE FROM influencer_attributions WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await q(`DELETE FROM influencer_profiles WHERE user_id = ANY($1)`, [ids]).catch((e) => console.error("cleanup profiles", e.message));
      await q(`DELETE FROM notifications WHERE reference_id IN (SELECT id FROM influencer_applications WHERE user_id = ANY($1))`, [ids]).catch(() => {});
      await q(`DELETE FROM influencer_applications WHERE user_id = ANY($1)`, [ids]).catch((e) => console.error("cleanup apps", e.message));
      await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]).catch((e) => console.error("cleanup users", e.message));
    }
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
