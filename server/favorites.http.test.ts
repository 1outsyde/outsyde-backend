/**
 * Saved businesses, photographers and products (migration 077) — HTTP checks.
 *
 * Run with: npx tsx server/favorites.http.test.ts
 * SCRATCH ONLY: FV_TEST_BASE_URL + FV_TEST_PG_URL must both be localhost; the server must run with the same
 * JWT_SECRET. Skips when FV_TEST_BASE_URL is unset.
 *
 * Proves: signed out is refused; save / list / remove for each type with Bearer; saving twice is one row;
 * hidden or missing targets cannot be saved and drop out of the list; one account never sees another's;
 * the phone import keeps real targets, skips the rest and keeps the old saved date; deletion purge clears them.
 */
import http from "http";

const BASE = process.env.FV_TEST_BASE_URL;
const PG_URL = process.env.FV_TEST_PG_URL;
let passed = 0;
let failed = 0;
const assert = (c: boolean, n: string, d?: unknown) => {
  if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.error(`  ❌ ${n}`, d === undefined ? "" : JSON.stringify(d)); }
};
const isLocal = (u: string) => ["localhost", "127.0.0.1"].includes(new URL(u).hostname);

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { "X-Forwarded-For": "10.99.7.7" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j: any = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: j }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set FV_TEST_BASE_URL + FV_TEST_PG_URL"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing: localhost only");
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const P = `fv${Date.now().toString(36)}`;
  const owner = `${P}o`, me = `${P}m`, other = `${P}x`, photogUser = `${P}pu`;
  const biz = `${P}b`, hiddenBiz = `${P}hb`, photog = `${P}p`, prod = `${P}pr`, draft = `${P}dr`;
  const users = [owner, me, other, photogUser];
  try {
    for (const u of users) {
      await q(`INSERT INTO users (id, username, email) VALUES ($1::varchar, $1::text, $2)`, [u, `${u}@fv.test`]);
    }
    await q(`INSERT INTO businesses (id, owner_id, name, category, city, state, approval_status, logo_image)
             VALUES ($1, $2, 'Saved Bakery', 'Food', 'Freeport', 'NY', 'approved', 'https://img/logo.jpg')`, [biz, owner]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'Pending Co', 'Food', 'pending')`, [hiddenBiz, owner]);
    await q(`INSERT INTO photographers (id, user_id, display_name, city, state, visibility_status, hourly_rate) VALUES ($1, $2, 'Snap Studio', 'Queens', 'NY', 'public', 10000)`, [photog, photogUser]);
    await q(`INSERT INTO vendor_products (id, business_id, name, price, images, status, is_active) VALUES ($1, $2, 'Cookies', 1200, '["https://img/c.jpg"]'::jsonb, 'live', true)`, [prod, biz]);
    await q(`INSERT INTO vendor_products (id, business_id, name, price, status, is_active) VALUES ($1, $2, 'Draft thing', 900, 'draft', true)`, [draft, biz]);
    const tMe = generateAccessToken({ userId: me, isVendor: false } as any);
    const tOther = generateAccessToken({ userId: other, isVendor: false } as any);
    const rows = async (u: string) => (await q(`SELECT target_type, target_id, created_at FROM user_favorites WHERE user_id = $1 ORDER BY target_type`, [u]));

    let r = await call("GET", "/api/users/me/favorites", null);
    assert(r.status === 401, "list signed out → 401", r.status);
    r = await call("POST", "/api/favorites", null, { type: "business", id: biz });
    assert(r.status === 401, "save signed out → 401", r.status);

    r = await call("POST", "/api/favorites", tMe, { type: "business", id: biz });
    assert(r.status === 200 && r.body?.saved === true, "save a business", r);
    r = await call("POST", "/api/favorites", tMe, { type: "business", id: biz });
    assert(r.status === 200 && (await rows(me)).length === 1, "saving twice keeps one row", r.status);
    r = await call("POST", "/api/favorites", tMe, { type: "photographer", id: photog });
    assert(r.status === 200, "save a photographer", r.status);
    await new Promise((res) => setTimeout(res, 20));
    r = await call("POST", "/api/favorites", tMe, { type: "product", id: prod });
    assert(r.status === 200, "save a product", r.status);

    r = await call("POST", "/api/favorites", tMe, { type: "business", id: hiddenBiz });
    assert(r.status === 404, "a business that is not approved cannot be saved", r.status);
    r = await call("POST", "/api/favorites", tMe, { type: "product", id: draft });
    assert(r.status === 404, "a draft product cannot be saved", r.status);
    r = await call("POST", "/api/favorites", tMe, { type: "product", id: `${P}nope` });
    assert(r.status === 404, "a missing product cannot be saved", r.status);
    r = await call("POST", "/api/favorites", tMe, { type: "post", id: biz });
    assert(r.status === 400, "unknown type → 400", r.status);

    r = await call("GET", "/api/users/me/favorites", tMe);
    const list = r.body?.favorites || [];
    assert(r.status === 200 && list.length === 3 && list[0].type === "product", "list: three items, newest first", list.map((f: any) => f.type));
    const fb = list.find((f: any) => f.type === "business");
    assert(fb?.name === "Saved Bakery" && fb?.image === "https://img/logo.jpg" && fb?.subtitle === "Food · Freeport, NY", "business filled in by the server", fb);
    const fp = list.find((f: any) => f.type === "photographer");
    assert(fp?.name === "Snap Studio" && fp?.subtitle === "Queens, NY" && fp?.image === null, "photographer filled in", fp);
    const fr = list.find((f: any) => f.type === "product");
    assert(fr?.name === "Cookies" && fr?.image === "https://img/c.jpg" && fr?.businessId === biz && fr?.priceCents === 1200 && fr?.subtitle === "Saved Bakery", "product has what ProductDetail needs", fr);

    r = await call("GET", "/api/users/me/favorites", tOther);
    assert(r.status === 200 && r.body?.favorites?.length === 0, "another account sees none of them", r.body);
    r = await call("DELETE", `/api/favorites/business/${biz}`, tOther);
    assert(r.status === 200 && (await rows(me)).length === 3, "another account cannot remove mine", r.status);

    await q(`UPDATE vendor_products SET status = 'archived' WHERE id = $1`, [prod]);
    r = await call("GET", "/api/users/me/favorites", tMe);
    assert(r.body?.favorites?.length === 2 && (await rows(me)).length === 3, "archived product drops out of the list, row kept", r.body?.favorites?.length);
    await q(`UPDATE vendor_products SET status = 'live' WHERE id = $1`, [prod]);
    r = await call("GET", "/api/users/me/favorites", tMe);
    assert(r.body?.favorites?.length === 3, "back to live → shows again", r.body?.favorites?.length);

    r = await call("DELETE", `/api/favorites/photographer/${photog}`, tMe);
    assert(r.status === 200 && r.body?.saved === false && (await rows(me)).length === 2, "remove a photographer", r);
    r = await call("DELETE", `/api/favorites/photographer/${photog}`, tMe);
    assert(r.status === 200, "removing again is fine", r.status);
    r = await call("DELETE", `/api/favorites/post/${photog}`, tMe);
    assert(r.status === 400, "remove with unknown type → 400", r.status);

    // Phone import
    r = await call("POST", "/api/users/me/favorites/import", tOther, {
      items: [
        { id: biz, type: "business", name: "Saved Bakery", image: "", savedAt: "2026-02-03T04:05:06.000Z" },
        { id: photog, type: "photographer", name: "Snap", savedAt: "2026-03-01T00:00:00.000Z" },
        { id: hiddenBiz, type: "business", name: "Pending" },
        { id: `${P}gone`, type: "product", name: "Gone" },
        { id: "x", type: "post" },
      ],
    });
    assert(r.status === 200 && r.body?.imported === 2 && r.body?.skipped === 2, "import keeps the 2 real ones, skips 2", r.body);
    const imp = await rows(other);
    const impBiz = imp.find((x) => x.target_type === "business");
    assert(imp.length === 2 && new Date(impBiz.created_at).toISOString().startsWith("2026-02-03"), "import keeps the old saved date", imp);
    r = await call("POST", "/api/users/me/favorites/import", tOther, { items: [{ id: biz, type: "business" }] });
    assert(r.status === 200 && (await rows(other)).length === 2, "importing again adds nothing", r.body);
    r = await call("POST", "/api/users/me/favorites/import", tOther, { nope: 1 });
    assert(r.status === 400, "import without a list → 400", r.status);

    // Account deletion purge (needs the test process on the same database: DATABASE_URL + the neon preload)
    await q(`UPDATE users SET deletion_status = 'pending_deletion', scheduled_deletion_at = now() - interval '1 minute' WHERE id = $1`, [other]);
    const { processScheduledDeletions } = await import("./services/accountDeletionService");
    await processScheduledDeletions();
    assert((await rows(other)).length === 0, "account deletion purge removes the saved items", await rows(other));
    assert((await rows(me)).length === 2, "and leaves other accounts alone", await rows(me));
  } finally {
    await q(`DELETE FROM user_favorites WHERE user_id = ANY($1)`, [users]);
    await q(`DELETE FROM vendor_products WHERE business_id = ANY($1)`, [[biz, hiddenBiz]]);
    await q(`DELETE FROM photographers WHERE id = $1`, [photog]);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [[biz, hiddenBiz]]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
