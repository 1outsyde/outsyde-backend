/**
 * Admin referrals HTTP (referral Step 5b): access, list shape, action status codes.
 *
 * Run with: npx tsx server/adminReferrals.http.test.ts
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (migration 072 applied).
 *   AREF_TEST_BASE_URL   e.g. http://localhost:5062 (must be localhost)
 *   AREF_TEST_PG_URL     the SAME scratch database (localhost only)
 *   JWT_SECRET           identical to the server's
 * Skips (exit 0) when AREF_TEST_BASE_URL is unset. The admin user info@goutsyde.com is created if missing.
 */
import crypto from "crypto";

const BASE = process.env.AREF_TEST_BASE_URL;
const PG_URL = process.env.AREF_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u?: string) => !!u && ["localhost", "127.0.0.1"].includes(new URL(u).hostname);

(async () => {
  if (!BASE) { console.log("⏭  skipped: set AREF_TEST_BASE_URL"); process.exit(0); }
  if (!isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: base URL and database must both be local");
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const P = `ar${Date.now().toString(36)}`;
  const call = async (method: string, path: string, token?: string) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    let json: any = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  };

  let adminId = (await q(`SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com' LIMIT 1`))[0]?.id;
  if (!adminId) {
    adminId = crypto.randomUUID();
    await q(`INSERT INTO users (id, email, username, is_active, is_admin) VALUES ($1, 'info@goutsyde.com', $2, true, true)`, [adminId, `${P}adm`]);
  } else await q(`UPDATE users SET is_admin = true WHERE id = $1`, [adminId]);
  const adminTok = generateAccessToken({ userId: adminId, isAdmin: true } as any);
  const userId = crypto.randomUUID();
  await q(`INSERT INTO users (id, email, username, is_active) VALUES ($1, $2, $3, true)`, [userId, `${P}-u@x.test`, `${P}u`]);
  const userTok = generateAccessToken({ userId, isAdmin: false } as any);
  // A non-admin who claims isAdmin in the token is still refused by the DB check.
  const fakeAdminTok = generateAccessToken({ userId, isAdmin: true } as any);

  // One referral with a payout in review, one pending.
  const owner = crypto.randomUUID();
  await q(`INSERT INTO users (id, email, username, is_active, is_vendor) VALUES ($1, $2, $3, true, true)`, [owner, `${P}-o@x.test`, `${P}o`]);
  const mk = async (status: string) => {
    const biz = crypto.randomUUID();
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, $3, 'beauty', 'approved')`, [biz, owner, `${P} ${status}`]);
    const ref = crypto.randomUUID();
    await q(`INSERT INTO business_referrals (id, referrer_user_id, business_id, referred_owner_user_id, code, status, qualified_at, expires_at)
             VALUES ($1, $2, $3, $4, 'CODE1', 'qualified', now() - interval '8 days', now() + interval '80 days')`, [ref, userId, biz, owner]);
    const pid = crypto.randomUUID();
    await q(`INSERT INTO referral_payouts (id, business_referral_id, recipient_user_id, amount_cents, status, payable_after, updated_at)
             VALUES ($1, $2, $3, 2500, $4, now() - interval '1 day', now() - interval '1 hour')`, [pid, ref, userId, status]);
    return pid;
  };
  const review = await mk("review");
  const pending = await mk("pending");

  console.log("\nAccess");
  const paths: Array<[string, string]> = [["GET", "/api/admin/referrals"], ...["pause", "release", "cancel", "retry"].map((a) => ["POST", `/api/admin/referrals/payouts/${pending}/${a}`] as [string, string])];
  for (const [m, path] of paths) {
    const none = await call(m, path);
    const user = await call(m, path, userTok);
    const fake = await call(m, path, fakeAdminTok);
    assert(none.status === 401 && user.status === 403 && fake.status === 403, `${m} ${path.replace(pending, ":id")}: 401 signed out, 403 for a non-admin (even with an isAdmin token)`, [none.status, user.status, fake.status]);
  }
  assert((await q(`SELECT status FROM referral_payouts WHERE id=$1`, [pending]))[0].status === "pending", "refused calls changed nothing");

  console.log("\nList");
  const list = await call("GET", "/api/admin/referrals", adminTok);
  const row = list.json?.business?.find((b: any) => b.payout?.id === review);
  assert(list.status === 200 && list.json.success === true && !!row && row.payout.status === "review" && Array.isArray(list.json.friends) && !!list.json.totals?.payouts, "admin: 200 with business, friends and totals", list.status);
  assert(list.json.attention?.some((a: any) => a.payoutId === review && a.kind === "review"), "review payout in Needs attention");
  assert(!/@x\.test|info@goutsyde/.test(JSON.stringify(list.json)), "no email address in the response");

  console.log("\nActions");
  let r = await call("POST", `/api/admin/referrals/payouts/${pending}/pause`, adminTok);
  assert(r.status === 200 && r.json.payout?.status === "held" && r.json.payout.holdReason === "admin_paused", "pause: 200, held admin_paused", r.json);
  r = await call("POST", `/api/admin/referrals/payouts/${pending}/pause`, adminTok);
  assert(r.status === 409 && r.json.error?.code === "NOT_PAUSABLE", "pause again: 409 NOT_PAUSABLE", r.json);
  r = await call("POST", `/api/admin/referrals/payouts/${pending}/release`, adminTok);
  assert(r.status === 200 && r.json.payout?.status === "pending", "release: 200, pending", r.json);
  r = await call("POST", `/api/admin/referrals/payouts/${pending}/release`, adminTok);
  assert(r.status === 409 && r.json.error?.code === "NOT_PAUSED", "release again: 409 NOT_PAUSED");
  r = await call("POST", `/api/admin/referrals/payouts/${pending}/retry`, adminTok);
  assert(r.status === 409 && r.json.error?.code === "NOT_IN_REVIEW", "retry a pending payout: 409 NOT_IN_REVIEW");
  r = await call("POST", `/api/admin/referrals/payouts/${review}/retry`, adminTok);
  assert(r.status === 200 && r.json.payout?.status === "pending" && r.json.payout.attempts === 0, "retry review: 200, pending, attempts 0", r.json);
  // Released and retried rows are due now; claim-like timestamps make them look mid send.
  await q(`UPDATE referral_payouts SET updated_at = now(), next_attempt_at = now() + interval '10 minutes' WHERE id=$1`, [review]);
  r = await call("POST", `/api/admin/referrals/payouts/${review}/cancel`, adminTok);
  assert(r.status === 409 && r.json.error?.code === "PAYOUT_SENDING" && /few minutes/.test(r.json.error.message), "cancel while it may be sending: 409 PAYOUT_SENDING", r.json);
  r = await call("POST", `/api/admin/referrals/payouts/${pending}/cancel`, adminTok);
  assert(r.status === 200 && r.json.payout?.status === "cancelled", "cancel: 200, cancelled", r.json);
  r = await call("POST", `/api/admin/referrals/payouts/${pending}/cancel`, adminTok);
  assert(r.status === 409 && r.json.error?.code === "NOT_CANCELLABLE", "cancel again: 409 NOT_CANCELLABLE");
  r = await call("POST", `/api/admin/referrals/payouts/${crypto.randomUUID()}/pause`, adminTok);
  assert(r.status === 404 && r.json.error?.code === "PAYOUT_NOT_FOUND", "unknown id: 404");
  r = await call("POST", `/api/admin/referrals/payouts/bad%20id!/pause`, adminTok);
  assert(r.status === 404, "malformed id: 404", r.status);
  const logs = await q(`SELECT action FROM audit_logs WHERE target_id = ANY($1) AND actor_id = $2 ORDER BY created_at`, [[pending, review], adminId]);
  assert(logs.map((l) => l.action).join(",") === "referral_payout.pause,referral_payout.release,referral_payout.retry,referral_payout.cancel", "audit log: exactly the four successful actions, in order", logs);

  await db.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
