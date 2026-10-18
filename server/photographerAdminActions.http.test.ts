/**
 * Photographer admin actions + optional signup rate (2026-10-18): HTTP integration tests.
 *
 * Run with: npx tsx server/photographerAdminActions.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres.
 *   PS_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   PS_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when PS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - drop `?? 0` on hourlyRate in the signup route → "signup without a rate" fails (500, NOT NULL).
 *  - drop the refreshTokens delete in /ban → "ban removes saved sign-ins" fails.
 *  - drop the hosted-shoot block in checkActiveOrders → both "booked photographer can't be deleted" checks fail.
 */
import http from "http";

const BASE = process.env.PS_TEST_BASE_URL;
const PG_URL = process.env.PS_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

let ipCounter = 1;
async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { "X-Forwarded-For": `10.98.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
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

  const P = `pa${Date.now().toString(36)}`;
  const email = (s: string) => `${P}-${s}@test.local`;
  const uname = (s: string) => `${P}${s}`.slice(0, 20);
  const signupBody = (s: string, over: Record<string, unknown> = {}) => ({
    email: email(s), password: "secret123", name: `Owner ${s}`, username: uname(s), phone: "5165550123",
    displayName: `${P} ${s}`, skipStripe: true, ...over,
  });
  const photographerOf = async (s: string) => (await q(
    `SELECT p.*, u.id AS owner_id, u.is_active, u.deletion_status, u.scheduled_deletion_at FROM photographers p JOIN users u ON u.id = p.user_id WHERE u.email = $1`, [email(s)],
  ))[0];
  const login = (s: string) => call("POST", "/api/auth/mobile/login", { body: { email: email(s), password: "secret123" } });

  let [admin] = await q(`SELECT id FROM users WHERE email = 'info@goutsyde.com'`);
  if (!admin) {
    [admin] = await q(`INSERT INTO users (id, email, name, username, is_admin) VALUES (gen_random_uuid(), 'info@goutsyde.com', 'Admin', $1, true) RETURNING id`, [uname("adm")]);
  } else {
    await q(`UPDATE users SET is_admin = true WHERE id = $1`, [admin.id]);
  }
  const adminToken = generateAccessToken({ userId: admin.id, isVendor: false, isAdmin: true });
  const shootIds: string[] = [];

  try {
    console.log("\n=== Rate is optional at signup ===");
    let r = await call("POST", "/api/auth/photographer/signup", { body: signupBody("norate", { pricingType: "packages", specialtyCodes: ["photo.events"] }) });
    let p = await photographerOf("norate");
    assert(r.status === 200 && p?.hourly_rate === 0, "signup without a rate saves 0", { s: r.status, b: r.body, rate: p?.hourly_rate });
    assert(p?.city === null && p?.state === null && p?.portfolio_url === null, "no made up city, state or portfolio", p && { c: p.city, s: p.state, u: p.portfolio_url });
    r = await call("POST", "/api/auth/photographer/signup", { body: signupBody("rate", { hourlyRate: 15000, city: "Freeport", state: "NY" }) });
    p = await photographerOf("rate");
    assert(r.status === 200 && p?.hourly_rate === 15000, "a sent rate is saved as sent", p?.hourly_rate);
    r = await call("POST", "/api/auth/photographer/signup", { body: signupBody("zero", { hourlyRate: 0 }) });
    assert(r.status === 400 && (await q(`SELECT 1 FROM users WHERE email=$1`, [email("zero")])).length === 0, "a rate of 0 is still refused, no account made", r.status);
    const norate = await photographerOf("norate");
    r = await call("GET", `/api/admin/photographers/${norate.id}`, { token: adminToken });
    const pricing = r.body?.signupDetails?.sections?.find((s: any) => s.title === "Pricing")?.rows ?? [];
    assert(pricing.find((x: any) => x.label === "Hourly rate (as stored)")?.value === "Not provided", "admin detail shows no rate as Not provided");

    console.log("\n=== Account state on the admin list and detail ===");
    let status = r.body?.signupDetails?.sections?.find((s: any) => s.title === "Status")?.rows ?? [];
    assert(status.find((x: any) => x.label === "Account")?.value === "Active", "Status shows Account: Active");
    assert(!status.some((x: any) => x.label === "Deletion scheduled"), "no Deletion row when none is scheduled");
    assert(r.body?.photographer?.ownerIsActive === true && r.body?.photographer?.ownerDeletionStatus === "active", "detail row has ownerIsActive + ownerDeletionStatus", r.body?.photographer && { a: r.body.photographer.ownerIsActive, d: r.body.photographer.ownerDeletionStatus });
    r = await call("GET", "/api/admin/photographers", { token: adminToken });
    const listed = (r.body ?? []).find((x: any) => x.id === norate.id);
    assert(listed?.ownerIsActive === true && !("stripeAccountId" in (listed ?? {})), "list row has ownerIsActive, still no Stripe ids");

    console.log("\n=== Only admins ===");
    const ownerToken = generateAccessToken({ userId: norate.owner_id, isVendor: false, isAdmin: false });
    for (const path of ["ban", "unban", "schedule-deletion", "cancel-deletion"]) {
      const a = await call("POST", `/api/admin/photographers/${norate.id}/${path}`);
      const b = await call("POST", `/api/admin/photographers/${norate.id}/${path}`, { token: ownerToken });
      assert([401, 403].includes(a.status) && [401, 403].includes(b.status), `${path}: refused without admin`, { a: a.status, b: b.status });
    }
    r = await call("POST", `/api/admin/photographers/00000000-0000-0000-0000-000000000000/ban`, { token: adminToken });
    assert(r.status === 404, "unknown photographer is 404", r.status);

    console.log("\n=== Ban ===");
    assert((await login("norate")).status === 200, "can sign in before the ban");
    await q(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [norate.owner_id, `${P}-hash`]);
    r = await call("POST", `/api/admin/photographers/${norate.id}/ban`, { token: adminToken });
    p = await photographerOf("norate");
    assert(r.status === 200 && p.is_active === false && p.visibility_status === "hidden", "ban disables the account and hides the profile", { s: r.status, a: p.is_active, v: p.visibility_status });
    assert(Number((await q(`SELECT count(*)::int n FROM refresh_tokens WHERE user_id=$1`, [norate.owner_id]))[0].n) === 0, "ban removes saved sign-ins");
    assert(r.body?.photographer?.ownerIsActive === false && !("stripeAccountId" in (r.body?.photographer ?? {})), "ban returns the updated row (no Stripe ids)");
    const lr = await login("norate");
    assert(lr.status !== 200, "a banned photographer can't sign in", lr.status);
    assert((await q(`SELECT 1 FROM audit_logs WHERE action='ban_photographer' AND target_id=$1`, [norate.id])).length === 1, "ban is in the audit log");
    r = await call("GET", `/api/admin/photographers/${norate.id}`, { token: adminToken });
    status = r.body?.signupDetails?.sections?.find((s: any) => s.title === "Status")?.rows ?? [];
    assert(status.find((x: any) => x.label === "Account")?.value === "Banned", "Status shows Account: Banned");

    console.log("\n=== Unban ===");
    r = await call("POST", `/api/admin/photographers/${norate.id}/unban`, { token: adminToken });
    p = await photographerOf("norate");
    assert(r.status === 200 && p.is_active === true && p.visibility_status === "hidden", "unban turns the account on, profile stays hidden", { a: p.is_active, v: p.visibility_status });
    assert((await login("norate")).status === 200, "can sign in after unban");
    assert((await q(`SELECT 1 FROM audit_logs WHERE action='unban_photographer' AND target_id=$1`, [norate.id])).length === 1, "unban is in the audit log");

    console.log("\n=== Admins are never banned or deleted here ===");
    await q(`UPDATE users SET is_admin = true WHERE id = $1`, [norate.owner_id]);
    const ab = await call("POST", `/api/admin/photographers/${norate.id}/ban`, { token: adminToken });
    const ad = await call("POST", `/api/admin/photographers/${norate.id}/schedule-deletion`, { token: adminToken });
    p = await photographerOf("norate");
    assert(ab.status === 403 && ad.status === 403 && p.is_active === true && p.deletion_status === "active", "admin-owned photographer: ban + delete refused", { ab: ab.status, ad: ad.status });
    await q(`UPDATE users SET is_admin = false WHERE id = $1`, [norate.owner_id]);

    console.log("\n=== Delete is refused while a shoot is booked with them ===");
    const [client] = await q(`INSERT INTO users (id, email, name, username) VALUES (gen_random_uuid(), $1, 'Client', $2) RETURNING id`, [email("client"), uname("cli")]);
    const [shoot] = await q(
      `INSERT INTO shoot_bookings (photographer_id, client_id, shoot_type, date, start_time, end_time, duration_hours, total_price, status)
       VALUES ($1, $2, 'portrait', '2099-01-01', '10:00', '11:00', 1, 10000, 'confirmed') RETURNING id`, [norate.id, client.id]);
    shootIds.push(shoot.id);
    await q(`UPDATE photographers SET visibility_status = 'public' WHERE id = $1`, [norate.id]);
    r = await call("POST", `/api/admin/photographers/${norate.id}/schedule-deletion`, { token: adminToken });
    p = await photographerOf("norate");
    assert(r.status === 409 && r.body?.blocked === true && p.deletion_status === "active" && p.visibility_status === "public", "admin delete: booked photographer can't be deleted, nothing changed", { s: r.status, e: r.body?.error });
    const selfToken = generateAccessToken({ userId: norate.owner_id, isVendor: false, isAdmin: false });
    r = await call("POST", "/api/account/delete-request", { token: selfToken, body: {} });
    p = await photographerOf("norate");
    assert(r.status === 200 && r.body?.blocked === true && /shoots booked with this photographer/.test(r.body?.reason ?? "") && p.deletion_status === "active", "own delete request: booked photographer can't be deleted", { s: r.status, b: r.body });

    console.log("\n=== Delete (30 days) and cancel ===");
    await q(`UPDATE shoot_bookings SET status = 'canceled' WHERE id = $1`, [shoot.id]);
    await q(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [norate.owner_id, `${P}-hash2`]);
    r = await call("POST", `/api/admin/photographers/${norate.id}/schedule-deletion`, { token: adminToken });
    p = await photographerOf("norate");
    const days = p?.scheduled_deletion_at ? (new Date(p.scheduled_deletion_at.replace(" ", "T") + "Z").getTime() - Date.now()) / 86400000 : 0;
    assert(r.status === 200 && p.deletion_status === "pending_deletion" && days > 29.9 && days < 30.1, "deletion scheduled for 30 days", { s: r.status, b: r.body?.error, days });
    assert(p.visibility_status === "hidden", "profile hidden right away", p.visibility_status);
    assert(Number((await q(`SELECT count(*)::int n FROM refresh_tokens WHERE user_id=$1`, [norate.owner_id]))[0].n) === 0, "deletion removes saved sign-ins");
    assert(r.body?.photographer?.ownerDeletionStatus === "pending_deletion", "returns the updated row");
    assert((await q(`SELECT 1 FROM audit_logs WHERE action='schedule_photographer_deletion' AND target_id=$1`, [norate.id])).length === 1, "deletion is in the audit log");
    r = await call("GET", `/api/admin/photographers/${norate.id}`, { token: adminToken });
    status = r.body?.signupDetails?.sections?.find((s: any) => s.title === "Status")?.rows ?? [];
    assert(!!status.find((x: any) => x.label === "Deletion scheduled" && x.value !== "Not provided"), "Status shows Deletion scheduled with a date", status);
    r = await call("POST", `/api/admin/photographers/${norate.id}/schedule-deletion`, { token: adminToken });
    assert(r.status === 200 && r.body?.alreadyPending === true, "scheduling again says already pending");
    r = await call("POST", `/api/admin/photographers/${norate.id}/cancel-deletion`, { token: adminToken });
    p = await photographerOf("norate");
    assert(r.status === 200 && p.deletion_status === "active" && p.scheduled_deletion_at === null && p.visibility_status === "hidden", "cancel stops the deletion, profile stays hidden", { d: p.deletion_status, v: p.visibility_status });
    r = await call("POST", `/api/admin/photographers/${norate.id}/cancel-deletion`, { token: adminToken });
    assert(r.status === 400, "cancel with nothing pending is 400", r.status);

    console.log("\n=== Deleted accounts ===");
    await q(`UPDATE users SET deletion_status = 'deleted' WHERE id = $1`, [norate.owner_id]);
    const db1 = await call("POST", `/api/admin/photographers/${norate.id}/ban`, { token: adminToken });
    const db2 = await call("POST", `/api/admin/photographers/${norate.id}/unban`, { token: adminToken });
    const db3 = await call("POST", `/api/admin/photographers/${norate.id}/schedule-deletion`, { token: adminToken });
    assert(db1.status === 409 && db2.status === 409 && db3.status === 409, "deleted account: ban, unban and delete refused", [db1.status, db2.status, db3.status]);
  } finally {
    const ids = (await q(`SELECT id FROM users WHERE email LIKE $1`, [`${P}-%`])).map((x: any) => x.id);
    if (shootIds.length) await q(`DELETE FROM shoot_bookings WHERE id = ANY($1)`, [shootIds]);
    if (ids.length) {
      const pids = (await q(`SELECT id FROM photographers WHERE user_id = ANY($1)`, [ids])).map((x: any) => x.id);
      await q(`DELETE FROM audit_logs WHERE target_id = ANY($1)`, [pids]).catch(() => {});
      await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await q(`DELETE FROM refresh_tokens WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await q(`DELETE FROM photographers WHERE user_id = ANY($1)`, [ids]);
      await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
    }
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
