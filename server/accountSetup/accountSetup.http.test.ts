/**
 * Account setup HTTP tests — run with: npx tsx server/accountSetup/accountSetup.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (schema pushed
 * from shared/schema.ts, see AGENTS.md "Local Database Setup") and the same JWT_SECRET here:
 *   SETUP_TEST_BASE_URL  e.g. http://localhost:5077   (must be localhost)
 *   SETUP_TEST_PG_URL    the SAME scratch database     (must be localhost; seeds + cleans up)
 *   JWT_SECRET           identical to the server's
 * Skips (exit 0) when SETUP_TEST_BASE_URL is unset; refuses any non-local host.
 * No RESEND_API_KEY on the server: emails fail and are logged, which these tests tolerate.
 */
import { createHash } from "crypto";

const BASE = process.env.SETUP_TEST_BASE_URL;
const PG_URL = process.env.SETUP_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

(async () => {
  if (!BASE) { console.log("⏭  skipped: set SETUP_TEST_BASE_URL + SETUP_TEST_PG_URL"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: base URL and database must both be local scratch instances");

  const { generateAccessToken } = await import("../auth");
  const { unsubscribeSig } = await import("./emails");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  let ip = 0;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `10.9.${Math.floor(++ip / 250)}.${ip % 250}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { /* html / redirect */ }
    return { status: res.status, json, text, location: res.headers.get("location") };
  };

  // Optional local Stripe stub: counts every Stripe API call and answers "onboarding complete".
  const stubPort = process.env.SETUP_TEST_STRIPE_STUB_PORT;
  let stripeHits: { count: number } | null = null;
  let stubServer: any = null;
  if (stubPort) {
    const http = await import("http");
    stripeHits = { count: 0 };
    const hits = stripeHits;
    stubServer = http.createServer((req, res) => {
      hits.count++;
      const m = (req.url || "").match(/\/v1\/accounts\/([^/?]+)/);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: m?.[1] ?? "acct_stub", object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null } }));
    });
    await new Promise<void>((ok) => stubServer.listen(Number(stubPort), "127.0.0.1", () => ok()));
  }

  const P = `ast-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const email = (s: string) => `${id(s)}@x.test`;

  try {
    // ── seed ────────────────────────────────────────────────────────────────
    await q(`INSERT INTO users (id, email, name, first_name, phone) VALUES ($1, $2, 'Jordan Reyes', 'Jordan', '5165550100')`, [id("wix"), email("wix")]);
    await q(`INSERT INTO users (id, email, username, password, name) VALUES ($1, $2, $3, 'x', 'Taken')`, [id("taken"), email("taken"), `t${Date.now().toString(36)}`]);
    const takenName = (await q(`SELECT username FROM users WHERE id = $1`, [id("taken")]))[0].username;
    await q(`INSERT INTO users (id, email, username, password, is_vendor) VALUES ($1, $2, $3, 'x', true)`, [id("vendor"), email("vendor"), `v${Date.now().toString(36)}`]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'Glow Studio', 'beauty', 'approved')`, [id("biz"), id("vendor")]);
    await q(`INSERT INTO users (id, email, password) VALUES ($1, $2, 'x')`, [id("nouser"), email("nouser")]);
    await q(`INSERT INTO users (id, email, password, is_photographer, username) VALUES ($1, $2, 'x', true, $3)`, [id("photo"), email("photo"), `p${Date.now().toString(36)}`]);
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate) VALUES ($1, $2, 'Lens Co', 100)`, [id("ph"), id("photo")]);
    const wixUsername = `wu${Date.now().toString(36)}`;
    await q(`INSERT INTO users (id, email, name, first_name, username) VALUES ($1, $2, 'Una Wix', 'Una', $3)`, [id("wixun"), email("wixun"), wixUsername]);
    await q(`INSERT INTO users (id, email, password, is_photographer, username, created_at) VALUES ($1, $2, 'x', true, $3, now() - interval '3 days')`, [id("photo2"), email("photo2"), `p2${Date.now().toString(36)}`]);
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 'Stub Lens', 100, 'acct_stub_ph2', false)`, [id("ph2"), id("photo2")]);
    await q(`INSERT INTO users (id, email, password, is_vendor, username) VALUES ($1, $2, 'x', true, $3)`, [id("lana"), email("lana"), `ln${Date.now().toString(36)}`]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_onboarding_complete, stripe_account_id) VALUES ($1, $2, 'Flag Only Braids', 'beauty', 'approved', true, NULL)`, [id("lanabiz"), id("lana")]);

    // ── 1. passwordless login → needs setup ─────────────────────────────────
    let r = await call("POST", "/api/auth/mobile/login", { email: email("wix"), password: "anything" });
    assert(r.status === 401 && r.json?.error?.code === "ACCOUNT_NEEDS_SETUP", "passwordless login → 401 ACCOUNT_NEEDS_SETUP", r.json);
    assert(typeof r.json?.error?.message === "string" && r.json.error.message.length > 10, "keeps a readable error.message for old clients");
    assert(r.json?.error?.firstName === "Jordan" && r.json?.error?.hasUsername === false, "returns firstName + hasUsername=false", r.json?.error);
    const firstHash = (await q(`SELECT reset_code_hash FROM users WHERE id = $1`, [id("wix")]))[0].reset_code_hash;
    assert(!!firstHash, "a reset code was stored");

    r = await call("POST", "/api/auth/mobile/login", { email: email("wix"), password: "again" });
    const secondHash = (await q(`SELECT reset_code_hash FROM users WHERE id = $1`, [id("wix")]))[0].reset_code_hash;
    assert(r.json?.error?.code === "ACCOUNT_NEEDS_SETUP" && secondHash === firstHash, "second attempt within 60 s → same code, no resend");

    // ── 1b. username login never reveals the account's email or name ────────
    r = await call("POST", "/api/auth/mobile/login", { username: wixUsername, password: "anything" });
    assert(r.status === 401 && r.json?.error?.code === "ACCOUNT_NEEDS_SETUP", "username login on passwordless account → ACCOUNT_NEEDS_SETUP", r.json);
    assert(r.json?.error?.email === undefined && r.json?.error?.firstName === undefined, "username login: no email or first name in the response", r.json?.error);
    assert(r.json?.error?.hasUsername === true, "username login: hasUsername still returned", r.json?.error);
    r = await call("POST", "/api/auth/mobile/login", { identifier: wixUsername, password: "anything" });
    assert(r.json?.error?.code === "ACCOUNT_NEEDS_SETUP" && r.json?.error?.email === undefined && r.json?.error?.firstName === undefined, "identifier=username: no email or first name", r.json?.error);
    r = await call("POST", "/api/auth/mobile/login", { identifier: email("wixun"), password: "anything" });
    assert(r.json?.error?.email === email("wixun") && r.json?.error?.firstName === "Una", "identifier=email: email + first name still returned", r.json?.error);

    r = await call("POST", "/api/auth/mobile/login", { email: email("vendor"), password: "wrong" });
    assert(r.status === 401 && r.json?.error?.code === "INVALID_CREDENTIALS", "wrong password on a normal account → unchanged INVALID_CREDENTIALS", r.json);

    // ── 2. code → token via the existing verify-code route ──────────────────
    await q(`UPDATE users SET reset_code_hash = $2, reset_code_expires_at = now() + interval '10 minutes', reset_code_attempts = 0 WHERE id = $1`, [id("wix"), sha("123456")]);
    r = await call("POST", "/api/auth/forgot-password/verify-code", { email: email("wix"), code: "123456" });
    assert(r.status === 200 && typeof r.json?.resetToken === "string", "existing verify-code returns a resetToken", r.json);
    const token = r.json?.resetToken as string;

    // ── 3. claim validation ─────────────────────────────────────────────────
    r = await call("POST", "/api/account-setup/claim", { email: email("wix"), resetToken: token, newPassword: "sunnydays24" });
    assert(r.status === 400 && r.json?.error?.code === "USERNAME_REQUIRED", "no username for an account without one → USERNAME_REQUIRED", r.json);
    r = await call("POST", "/api/account-setup/claim", { email: email("wix"), resetToken: token, newPassword: "sunnydays24", username: "Bad Name!" });
    assert(r.status === 400 && r.json?.error?.code === "INVALID_USERNAME", "invalid username → INVALID_USERNAME", r.json);
    r = await call("POST", "/api/account-setup/claim", { email: email("wix"), resetToken: token, newPassword: "sunnydays24", username: takenName.toUpperCase() });
    assert(r.status === 409 && r.json?.error?.code === "USERNAME_TAKEN", "taken username (any case) → USERNAME_TAKEN", r.json);
    r = await call("POST", "/api/account-setup/claim", { email: email("wix"), resetToken: token, newPassword: "123", username: "jordanr_x" });
    assert(r.status === 400 && r.json?.error?.code === "INVALID_PASSWORD", "short password → INVALID_PASSWORD", r.json);
    r = await call("POST", "/api/account-setup/claim", { email: email("wix"), resetToken: "f".repeat(64), newPassword: "sunnydays24", username: "jordanr_x" });
    assert(r.status === 400 && r.json?.error?.code === "INVALID_TOKEN", "wrong token → INVALID_TOKEN", r.json);
    let row = (await q(`SELECT password, username FROM users WHERE id = $1`, [id("wix")]))[0];
    assert(!row.password && !row.username, "failed attempts changed nothing");

    // ── 4. claim success ────────────────────────────────────────────────────
    const uname = `jr_${Date.now().toString(36)}`.slice(0, 20);
    r = await call("POST", "/api/account-setup/claim", { email: email("wix"), resetToken: token, newPassword: "sunnydays24", username: uname.toUpperCase() });
    assert(r.status === 200 && typeof r.json?.accessToken === "string" && typeof r.json?.refreshToken === "string", "claim → 200 with tokens (login shape)", r.json);
    assert(r.json?.user?.username === uname && r.json?.user?.password === undefined, "username saved lowercase; password never returned", r.json?.user);
    row = (await q(`SELECT password, username, reset_token_hash, reset_code_hash FROM users WHERE id = $1`, [id("wix")]))[0];
    assert(!!row.password && row.username === uname && !row.reset_token_hash && !row.reset_code_hash, "password set, reset fields cleared");
    const claimedAccess = r.json?.accessToken as string;

    r = await call("POST", "/api/account-setup/claim", { email: email("wix"), resetToken: token, newPassword: "other123", username: "x_other" });
    assert(r.status === 400 && r.json?.error?.code === "INVALID_TOKEN", "token can't be reused", r.json);

    r = await call("POST", "/api/auth/mobile/login", { email: email("wix"), password: "sunnydays24" });
    assert(r.status === 200 && !!r.json?.accessToken, "normal login works with the new password", r.json);
    r = await call("POST", "/api/auth/mobile/login", { username: uname, password: "sunnydays24" });
    assert(r.status === 200, "login by the new username works");

    // ── 5. status ───────────────────────────────────────────────────────────
    r = await call("GET", "/api/account-setup/status", undefined, claimedAccess);
    assert(r.status === 200 && r.json?.role === "consumer" && r.json?.complete === true, "claimed consumer → complete", r.json);
    r = await call("GET", "/api/account-setup/status", undefined, generateAccessToken({ userId: id("vendor"), isVendor: true, isAdmin: false } as any));
    assert(r.json?.role === "business" && r.json?.next === "plan", "approved business without plan → next plan", r.json);
    r = await call("GET", "/api/account-setup/status", undefined, generateAccessToken({ userId: id("photo"), isVendor: false, isAdmin: false, isPhotographer: true } as any));
    assert(r.json?.role === "photographer" && r.json?.next === "payouts", "photographer without Stripe → next payouts", r.json);
    r = await call("GET", "/api/account-setup/status");
    assert(r.status === 401, "status requires sign-in");

    // ── 6. username endpoint ────────────────────────────────────────────────
    const nouserJwt = generateAccessToken({ userId: id("nouser"), isVendor: false, isAdmin: false } as any);
    r = await call("POST", "/api/account-setup/username", { username: takenName }, nouserJwt);
    assert(r.status === 409 && r.json?.error?.code === "USERNAME_TAKEN", "username endpoint refuses taken name", r.json);
    const un2 = `nu_${Date.now().toString(36)}`.slice(0, 20);
    r = await call("POST", "/api/account-setup/username", { username: un2 }, nouserJwt);
    assert(r.status === 200 && r.json?.username === un2, "username endpoint sets first username", r.json);
    r = await call("POST", "/api/account-setup/username", { username: un2 + "z" }, nouserJwt);
    assert(r.status === 409 && r.json?.error?.code === "ALREADY_SET", "second call → ALREADY_SET (rename lives in Settings)", r.json);

    // ── 7. send-code is enumeration-safe ────────────────────────────────────
    const a = await call("POST", "/api/account-setup/send-code", { email: `nobody-${P}@x.test` });
    const b = await call("POST", "/api/account-setup/send-code", { email: email("vendor") });
    assert(a.status === 200 && b.status === 200 && a.json?.message === b.json?.message, "send-code answers the same for unknown and non-claimable emails");

    // ── 8. unsubscribe ──────────────────────────────────────────────────────
    r = await call("GET", `/api/account-setup/unsubscribe?u=${encodeURIComponent(id("vendor"))}&s=${"0".repeat(32)}`);
    assert(r.status === 400, "bad signature → 400 page");
    r = await call("GET", `/api/account-setup/unsubscribe?u=${encodeURIComponent(id("vendor"))}&s=${unsubscribeSig(id("vendor"))}`);
    const opt = await q(`SELECT 1 FROM account_setup_optouts WHERE user_id = $1`, [id("vendor")]);
    assert(r.status === 200 && opt.length === 1 && /unsubscribed/i.test(r.text), "valid link → opted out + confirmation page");

    // ── 9. Stripe return redirects ──────────────────────────────────────────
    r = await call("GET", "/api/stripe/connect-return?account=acct_test&type=photographer-web");
    assert(r.status === 302 && r.location === "https://www.goutsyde.com/photographer-dashboard?stripe=success", "photographer-web return → goutsyde.com dashboard", r.location);
    r = await call("GET", "/api/stripe/connect-return?account=acct_test&type=photographer");
    assert(r.status === 302 && r.location === "outsyde://stripe-return?status=complete&type=photographer", "photographer (app) return → deep link", r.location);
    r = await call("GET", "/api/stripe/connect-return?account=acct_test&type=vendor-web&return=finish");
    assert(r.status === 302 && r.location === "https://www.goutsyde.com/finish?stripe=done", "return=finish → /finish?stripe=done", r.location);
    r = await call("GET", "/api/stripe/connect-return?account=acct_test&type=staff&staffId=s1&return=finish");
    assert(r.location === "https://www.goutsyde.com/finish?stripe=done", "staff + return=finish → /finish", r.location);
    r = await call("GET", "/api/stripe/connect-return?account=acct_test&type=vendor");
    assert(r.location === "outsyde://stripe-return?status=complete&type=vendor", "vendor (app) return unchanged", r.location);
    r = await call("GET", "/api/stripe/connect-return?account=acct_test&type=vendor-web");
    assert(r.location === "https://www.goutsyde.com/vendor-dashboard/stripe/return?status=complete", "vendor-web return unchanged", r.location);
    r = await call("GET", "/api/stripe/connect-refresh?account=acct_test&type=vendor-web&return=finish");
    assert(r.location === "https://www.goutsyde.com/finish?stripe=refresh", "refresh + return=finish → /finish?stripe=refresh", r.location);
    r = await call("GET", "/api/stripe/connect-refresh?account=acct_test&type=staff&staffId=s1");
    assert(r.location === "outsyde://stripe-return?status=refresh&type=staff&staffId=s1", "staff refresh unchanged", r.location);

    // ── 10. admin preview is read-only and admin-only ───────────────────────
    r = await call("GET", "/api/admin/account-setup/preview", undefined, nouserJwt);
    assert(r.status === 403, "non-admin → 403 on preview", r.status);
    const adminRow = await q(`SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com'`);
    let adminId = adminRow[0]?.id as string | undefined;
    if (!adminId) {
      adminId = id("admin");
      await q(`INSERT INTO users (id, email, password, is_admin, username) VALUES ($1, 'info@goutsyde.com', 'x', true, $2)`, [adminId, `adm${Date.now().toString(36)}`]);
    }
    await q(`UPDATE users SET created_at = now() - interval '3 days' WHERE id = $1`, [id("photo")]);
    if (stripeHits) stripeHits.count = 0; // count every Stripe call the previews make
    const before = (await q(`SELECT count(*)::int n FROM account_setup_reminders`))[0].n;
    r = await call("GET", "/api/admin/account-setup/preview", undefined, generateAccessToken({ userId: adminId, isVendor: false, isAdmin: true } as any));
    const after = (await q(`SELECT count(*)::int n FROM account_setup_reminders`))[0].n;
    const mine = (r.json?.reminders ?? []).find((x: any) => x.userId === id("photo"));
    assert(r.status === 200 && mine?.reminderNumber === 1 && mine?.template === "steps_left" && mine.steps.includes("payouts"), "preview lists the 3-day-old photographer for reminder 1", mine ?? r.json);
    assert(!(r.json?.reminders ?? []).some((x: any) => x.userId === id("vendor")), "opted-out vendor is not in the preview");
    assert(before === after, "preview wrote nothing");

    // ── 10b. manual send to picked people only ──────────────────────────────
    const adminJwt = generateAccessToken({ userId: adminId, isVendor: false, isAdmin: true } as any);
    r = await call("POST", "/api/admin/account-setup/send", { dryRun: false, userIds: [id("photo")] }, nouserJwt);
    assert(r.status === 403, "non-admin → 403 on send", r.status);
    for (const bad of [[], "x", [""], [1], Array.from({ length: 201 }, (_, i) => `u${i}`)]) {
      r = await call("POST", "/api/admin/account-setup/send", { dryRun: false, userIds: bad }, adminJwt);
      assert(r.status === 400 && r.json?.error?.code === "INVALID_USER_IDS", `bad userIds ${JSON.stringify(bad).slice(0, 20)} → 400`, r.json);
    }
    r = await call("POST", "/api/admin/account-setup/send", { dryRun: true, userIds: [id("photo"), id("vendor"), "nobody"] }, adminJwt);
    const dryIds = (r.json?.reminders ?? []).map((x: any) => x.userId);
    assert(r.status === 200 && r.json?.dryRun === true && dryIds.length === 1 && dryIds[0] === id("photo"), "dry run with picks → only the picked, due account", r.json);
    assert(JSON.stringify([...(r.json?.notDue ?? [])].sort()) === JSON.stringify([id("vendor"), "nobody"].sort()), "opted-out and unknown picks come back as notDue", r.json?.notDue);
    assert((await q(`SELECT count(*)::int n FROM account_setup_reminders`))[0].n === before, "dry run with picks wrote nothing");
    r = await call("POST", "/api/admin/account-setup/send", { dryRun: false, userIds: [id("photo")] }, adminJwt);
    const realIds = (r.json?.reminders ?? []).map((x: any) => x.userId);
    assert(r.status === 200 && r.json?.dryRun === false && realIds.length === 1 && realIds[0] === id("photo"), "real send with picks → attempted only the picked account", r.json);
    // No RESEND_API_KEY locally, so the email fails and its log row is removed for a retry.
    assert(r.json?.reminders?.[0]?.outcome === "failed" && (await q(`SELECT count(*)::int n FROM account_setup_reminders`))[0].n === before, "failed email leaves no log row (retryable)", r.json?.reminders);

    // ── 11. preview never calls Stripe or writes onboarding flags; live /status still self-heals ──
    if (stripeHits) {
      r = await call("GET", "/api/admin/account-setup/preview", undefined, generateAccessToken({ userId: adminId, isVendor: false, isAdmin: true } as any));
      const ph2 = (await q(`SELECT stripe_onboarding_complete FROM photographers WHERE id = $1`, [id("ph2")]))[0];
      assert(r.status === 200 && stripeHits.count === 0, "previews made no Stripe calls", stripeHits.count);
      assert(ph2.stripe_onboarding_complete === false, "preview left the photographer's onboarding flag untouched", ph2);
      r = await call("GET", "/api/account-setup/status", undefined, generateAccessToken({ userId: id("photo2"), isVendor: false, isPhotographer: true, photographerId: id("ph2") } as any));
      const healed = (await q(`SELECT stripe_onboarding_complete FROM photographers WHERE id = $1`, [id("ph2")]))[0];
      assert(stripeHits.count > 0 && healed.stripe_onboarding_complete === true, "live /status still self-heals from Stripe", { hits: stripeHits.count, healed });
      assert(r.json?.steps?.find((x: any) => x.key === "payouts")?.state === "done", "…and reports payouts done", r.json);
    } else {
      console.log("  ⏭  Stripe stub checks skipped: set SETUP_TEST_STRIPE_STUB_PORT (server needs the same STRIPE_STUB_PORT)");
    }

    // ── 12. onboarding flag without a Stripe account is NOT done (Lana case) ──
    r = await call("GET", "/api/account-setup/status", undefined, generateAccessToken({ userId: id("lana"), isVendor: true, businessId: id("lanabiz") } as any));
    const lanaPayouts = r.json?.steps?.find((x: any) => x.key === "payouts");
    assert(r.status === 200 && lanaPayouts?.state === "todo", "flag true + no Stripe account → payouts todo", r.json);
    if (adminId === id("admin")) await q(`DELETE FROM users WHERE id = $1`, [adminId]);
  } finally {
    await q(`DELETE FROM refresh_tokens WHERE user_id LIKE $1`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM photographers WHERE id LIKE $1`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id LIKE $1`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}%`]).catch(() => {});
    await db.end();
    if (stubServer) stubServer.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
