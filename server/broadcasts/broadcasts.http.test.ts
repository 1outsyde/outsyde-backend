/**
 * Broadcasts + email history HTTP tests. Run with: npx tsx server/broadcasts/broadcasts.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend on localhost against a LOCAL scratch Postgres with migrations 042
 * and 043 applied, started with the same JWT_SECRET and these extra env vars:
 *   RESEND_API_KEY=re_test  RESEND_BASE_URL=http://127.0.0.1:<BCAST_TEST_RESEND_PORT>
 *   BROADCAST_DAILY_LIMIT=12
 * This test runs the Resend stub itself on BCAST_TEST_RESEND_PORT, so no email ever leaves the machine.
 *   BCAST_TEST_BASE_URL   e.g. http://localhost:5077 (must be localhost)
 *   BCAST_TEST_PG_URL     the SAME scratch database (must be localhost; seeds + cleans up)
 *   BCAST_TEST_RESEND_PORT e.g. 5098
 * Skips (exit 0) when BCAST_TEST_BASE_URL is unset; refuses any non local host.
 */
import http from "http";

const BASE = process.env.BCAST_TEST_BASE_URL;
const PG_URL = process.env.BCAST_TEST_PG_URL;
const STUB_PORT = Number(process.env.BCAST_TEST_RESEND_PORT || 0);

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!BASE) { console.log("⏭  skipped: set BCAST_TEST_BASE_URL + BCAST_TEST_PG_URL + BCAST_TEST_RESEND_PORT"); process.exit(0); }
  if (!PG_URL || !STUB_PORT || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: base URL and database must both be local, and a stub port is required");

  // Local Resend stub: records every email; addresses containing "+fail" get a Resend error.
  const sent: any[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = body ? JSON.parse(body) : {};
      res.setHeader("Content-Type", "application/json");
      if (String(j.to).includes("+fail")) { res.statusCode = 422; return res.end(JSON.stringify({ name: "validation_error", message: "stub rejected this address" })); }
      sent.push({ path: req.url, ...j });
      res.end(JSON.stringify({ id: `stub_${sent.length}` }));
    });
  });
  await new Promise<void>((ok) => stub.listen(STUB_PORT, "127.0.0.1", () => ok()));

  const { generateAccessToken } = await import("../auth");
  const { broadcastUnsubSig } = await import("./broadcasts");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text };
  };
  const waitDone = async (sendId: string, token: string) => {
    for (let i = 0; i < 60; i++) {
      const r = await call("GET", `/api/admin/emails/sends/${sendId}`, undefined, token);
      if (r.json?.send?.status && r.json.send.status !== "sending") return r;
      await sleep(250);
    }
    return call("GET", `/api/admin/emails/sends/${sendId}`, undefined, token);
  };

  const P = `bct-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const email = (s: string) => `${id(s)}@x.test`;
  let createdAdmin = false;

  try {
    // ── seed ────────────────────────────────────────────────────────────────
    await q(`DELETE FROM email_log WHERE created_at >= now() - interval '1 day'`); // scratch db: start the day's budget clean
    const adminRow = await q(`SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com'`);
    let adminId = adminRow[0]?.id as string | undefined;
    if (!adminId) {
      adminId = id("admin"); createdAdmin = true;
      await q(`INSERT INTO users (id, email, password, is_admin, username, first_name) VALUES ($1, 'info@goutsyde.com', 'x', true, $2, 'Legend')`, [adminId, `adm${Date.now().toString(36)}`]);
    }
    const adminJwt = generateAccessToken({ userId: adminId, isVendor: false, isAdmin: true } as any);
    const add = (k: string, extra = "", vals: unknown[] = []) =>
      q(`INSERT INTO users (id, email, password, username, first_name${extra ? ", " + extra.split("=")[0] : ""}) VALUES ($1, $2, 'x', $3, $4${extra ? ", $5" : ""})`,
        [id(k), email(k), `${k}${Date.now().toString(36)}`.slice(0, 30), k.charAt(0).toUpperCase() + k.slice(1), ...vals]);
    await add("cons");
    await add("cons2");
    await q(`UPDATE users SET email = $2 WHERE id = $1`, [id("cons2"), `${id("cons2")}+fail@x.test`]);
    await add("vend", "is_vendor=", [true]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'Glow Studio', 'beauty', 'approved')`, [id("biz"), id("vend")]);
    await add("rej", "is_vendor=", [true]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'Nope Co', 'beauty', 'rejected')`, [id("bizr"), id("rej")]);
    await add("photo", "is_photographer=", [true]);
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate) VALUES ($1, $2, 'Lens Co', 100)`, [id("ph"), id("photo")]);
    await add("inact", "is_active=", [false]);
    await add("unsub");
    await q(`INSERT INTO broadcast_optouts (user_id) VALUES ($1)`, [id("unsub")]);

    // ── 1. admin only ───────────────────────────────────────────────────────
    const userJwt = generateAccessToken({ userId: id("cons"), isVendor: false } as any);
    for (const [m, p] of [["GET", "/api/admin/emails/budget"], ["GET", "/api/admin/emails/audiences"], ["GET", "/api/admin/emails/people?q=glow"], ["GET", "/api/admin/emails/sends"], ["POST", "/api/admin/emails/broadcasts"], ["POST", "/api/admin/emails/broadcasts/test"]] as const) {
      const r1 = await call(m, p, m === "POST" ? {} : undefined);
      const r2 = await call(m, p, m === "POST" ? {} : undefined, userJwt);
      assert(r1.status === 401 && r2.status === 403, `${m} ${p}: 401 signed out, 403 non admin`, [r1.status, r2.status]);
    }

    // ── 2. budget, audiences, search ────────────────────────────────────────
    let r = await call("GET", "/api/admin/emails/budget", undefined, adminJwt);
    assert(r.status === 200 && r.json.limit === 12 && r.json.sentToday === 0 && r.json.remaining === 12, "budget starts at 0 of 12", r.json);
    r = await call("GET", "/api/admin/emails/audiences", undefined, adminJwt);
    const counts = r.json?.counts;
    assert(r.status === 200 && counts && counts.all >= 5, "audience counts returned", counts);
    r = await call("GET", `/api/admin/emails/people?q=${encodeURIComponent(P)}`, undefined, adminJwt);
    const people = r.json?.people ?? [];
    const byId = new Map(people.map((x: any) => [x.id, x]));
    assert(people.length === 7, "search finds the 7 seeded accounts", people.map((x: any) => x.id));
    assert((byId.get(id("vend")) as any)?.role === "business" && (byId.get(id("photo")) as any)?.role === "photographer" && (byId.get(id("cons")) as any)?.role === "consumer", "roles labelled");
    assert((byId.get(id("unsub")) as any)?.unsubscribed === true && (byId.get(id("unsub")) as any)?.canBroadcast === false, "unsubscribed shown and not sendable");
    assert((byId.get(id("inact")) as any)?.canBroadcast === false, "inactive not sendable");
    r = await call("GET", `/api/admin/emails/people?q=Glow%20Studio`, undefined, adminJwt);
    assert((r.json?.people ?? []).some((x: any) => x.id === id("vend")), "search by business name");
    r = await call("GET", `/api/admin/emails/people?q=a`, undefined, adminJwt);
    assert(r.status === 200 && r.json.people.length === 0, "one letter search returns nothing");

    // ── 3. validation ───────────────────────────────────────────────────────
    r = await call("POST", "/api/admin/emails/broadcasts", { audience: "all", subject: "", html: "<p>x</p>" }, adminJwt);
    assert(r.status === 400 && r.json.error.code === "INVALID_CONTENT", "subject required", r.json);
    r = await call("POST", "/api/admin/emails/broadcasts", { audience: "nobody", subject: "Hi", html: "<p>x</p>" }, adminJwt);
    assert(r.status === 400 && r.json.error.code === "INVALID_AUDIENCE", "audience validated", r.json);
    r = await call("POST", "/api/admin/emails/broadcasts", { audience: "picked", userIds: [id("unsub"), id("inact")], subject: "Hi", html: "<p>x</p>" }, adminJwt);
    assert(r.status === 400 && r.json.error.code === "NO_RECIPIENTS", "only ineligible picks → NO_RECIPIENTS", r.json);
    assert(sent.length === 0, "nothing sent yet");

    // ── 4. test send to the admin ───────────────────────────────────────────
    r = await call("POST", "/api/admin/emails/broadcasts/test", { subject: "Fall drop", html: "<html><body><p>Hi {{first_name}}</p></body></html>" }, adminJwt);
    assert(r.status === 200 && r.json.to === "info@goutsyde.com", "test send ok", r.json);
    const t = sent.at(-1);
    assert(t && t.to === "info@goutsyde.com" && t.subject === "[Test] Fall drop" && t.reply_to === "info@goutsyde.com", "test went to the admin only with [Test] and reply to", t && { to: t.to, subject: t.subject, reply_to: t.reply_to });
    assert(t && typeof t.headers?.["List-Unsubscribe"] === "string" && t.html.includes("Unsubscribe from announcements"), "test has unsubscribe header and footer");

    // ── 5. broadcast to picked people ───────────────────────────────────────
    const before = sent.length;
    r = await call("POST", "/api/admin/emails/broadcasts", { audience: "picked", userIds: [id("cons"), id("photo"), id("unsub"), id("cons2"), "nobody"], subject: "Hey {{first_name}}", html: "<p>Hello {{first_name}}, <a href=\"https://goutsyde.com\">see what's new</a></p>" }, adminJwt);
    assert(r.status === 202 && r.json.recipients === 3, "202 with 3 recipients (unsubscribed and unknown skipped)", r.json);
    const sendId = r.json?.sendId;
    r = await waitDone(sendId, adminJwt);
    const recips = r.json?.recipients ?? [];
    assert(r.json?.send?.status === "done" && r.json.send.sent_count === 2 && r.json.send.failed_count === 1 && r.json.send.recipient_count === 3, "send finished: 2 sent, 1 failed", r.json?.send);
    const out = sent.slice(before);
    assert(out.length === 2 && out.every((e) => e.reply_to === "info@goutsyde.com"), "exactly 2 emails left through Resend", out.map((e) => e.to));
    const consMail = out.find((e) => e.to === email("cons"));
    assert(consMail?.subject === "Hey Cons" && consMail.html.includes("Hello Cons") && consMail.text.includes("see what's new (https://goutsyde.com)"), "personalized subject, html and text", consMail && { subject: consMail.subject });
    const sig = broadcastUnsubSig(id("cons"));
    const lu = String(consMail?.headers?.["List-Unsubscribe"] ?? "");
    assert(lu.startsWith("<") && lu.endsWith(">") && lu.includes(`/api/broadcasts/unsubscribe?u=${encodeURIComponent(id("cons"))}&s=${sig}`) && consMail?.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", "per person one click unsubscribe header", lu);
    const failedRow = recips.find((x: any) => x.user_id === id("cons2"));
    assert(failedRow?.status === "failed" && /stub rejected/.test(failedRow.error || ""), "Resend error recorded on the failed row", failedRow);
    const logRows = await q(`SELECT user_id, status, resend_id, kind FROM email_log WHERE send_id = $1 ORDER BY user_id`, [sendId]);
    assert(logRows.length === 3 && logRows.filter((x) => x.status === "sent").every((x) => /^stub_/.test(x.resend_id)), "log rows keep Resend ids", logRows);
    const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'email_log'`);
    assert(!cols.some((c) => /email|name|subject/.test(c.column_name)), "email_log stores no email, name or subject column", cols.map((c) => c.column_name));

    // ── 6. history ──────────────────────────────────────────────────────────
    r = await call("GET", "/api/admin/emails/sends", undefined, adminJwt);
    const sends = r.json?.sends ?? [];
    assert(sends[0]?.id === sendId && sends[0].kind === "broadcast" && sends[0].subject === "Hey {{first_name}}" && sends[0].created_by_name, "by send: newest first, with sender", sends[0]);
    assert(sends.some((s: any) => s.kind === "broadcast_test"), "test send is in the history");
    r = await call("GET", `/api/admin/emails/people/${encodeURIComponent(id("cons"))}/emails`, undefined, adminJwt);
    assert(r.status === 200 && r.json.emails.length === 1 && r.json.emails[0].subject === "Hey {{first_name}}" && r.json.emails[0].status === "sent", "by person: the broadcast shows on Cons's history", r.json);
    r = await call("GET", `/api/admin/emails/people/nobody/emails`, undefined, adminJwt);
    assert(r.status === 404, "unknown person → 404");

    // ── 7. daily limit ──────────────────────────────────────────────────────
    r = await call("GET", "/api/admin/emails/budget", undefined, adminJwt);
    assert(r.json.sentToday === 3 && r.json.remaining === 9, "budget counts the test and the 2 sent (failed rows don't count)", r.json);
    // Use up most of the day (filler rows) so an "All users" broadcast no longer fits.
    await q(`INSERT INTO email_log (user_id, kind, status) SELECT $1, 'broadcast', 'sent' FROM generate_series(1, 6)`, [id("rej")]);
    r = await call("GET", "/api/admin/emails/budget", undefined, adminJwt);
    assert(r.json.remaining === 3 && counts.all > 3, "3 left today, fewer than the audience", { budget: r.json, all: counts.all });
    r = await call("POST", "/api/admin/emails/broadcasts", { audience: "all", subject: "Too many", html: "<p>x</p>" }, adminJwt);
    assert(r.status === 429 && r.json.error.code === "OVER_DAILY_LIMIT" && r.json.error.recipients === counts.all, "over the daily limit → 429", r.json);
    assert((await q(`SELECT count(*)::int n FROM email_sends WHERE subject = 'Too many'`))[0].n === 0, "no send row for a refused broadcast");
    assert(sent.every((e) => e.subject !== "Too many"), "nothing went to Resend for it");

    // ── 8. unsubscribe ──────────────────────────────────────────────────────
    r = await call("GET", `/api/broadcasts/unsubscribe?u=${encodeURIComponent(id("cons"))}&s=${"0".repeat(32)}`);
    assert(r.status === 400 && /isn't valid/.test(r.text), "bad signature → 400 page");
    r = await call("POST", `/api/broadcasts/unsubscribe?u=${encodeURIComponent(id("cons"))}&s=${sig}`);
    assert(r.status === 200 && /unsubscribed/i.test(r.text), "one click POST unsubscribes");
    assert((await q(`SELECT count(*)::int n FROM broadcast_optouts WHERE user_id = $1`, [id("cons")]))[0].n === 1, "opt out row written");
    assert((await q(`SELECT count(*)::int n FROM account_setup_optouts WHERE user_id = $1`, [id("cons")]))[0].n === 0, "setup reminders opt out untouched");
    r = await call("GET", `/api/broadcasts/unsubscribe?u=${encodeURIComponent(id("cons"))}&s=${sig}`);
    assert(r.status === 200, "unsubscribing twice is fine");
    r = await call("POST", "/api/admin/emails/broadcasts", { audience: "picked", userIds: [id("cons")], subject: "Again", html: "<p>x</p>" }, adminJwt);
    assert(r.status === 400 && r.json.error.code === "NO_RECIPIENTS", "unsubscribed person can't be broadcast to", r.json);

    // ── 9. setup emails now show up in history ──────────────────────────────
    await q(`UPDATE users SET created_at = now() - interval '3 days', username = NULL WHERE id = $1`, [id("photo")]);
    r = await call("POST", "/api/admin/account-setup/send", { dryRun: false, userIds: [id("photo")] }, adminJwt);
    assert(r.status === 200 && r.json.sent === 1, "setup send to the photographer went out (stub)", r.json);
    const setupRow = (await q(`SELECT l.kind, l.label, l.status, l.resend_id, s.kind AS send_kind, s.created_by, s.status AS send_status
                               FROM email_log l JOIN email_sends s ON s.id = l.send_id WHERE l.user_id = $1 AND l.kind LIKE 'setup_%'`, [id("photo")]))[0];
    assert(setupRow?.kind === "setup_steps_left" && setupRow.label === "Steps left email #1" && setupRow.status === "sent" && /^stub_/.test(setupRow.resend_id || "")
      && setupRow.send_kind === "setup" && setupRow.created_by === adminId && setupRow.send_status === "done", "setup email logged with sender and Resend id", setupRow);
    r = await call("GET", `/api/admin/emails/people/${encodeURIComponent(id("photo"))}/emails`, undefined, adminJwt);
    assert(r.json?.emails?.length === 2 && r.json.emails[0].subject === "Steps left email #1", "by person: setup email and broadcast together, newest first", r.json?.emails);

    // ── 10. setup sends respect the daily limit too ─────────────────────────
    await q(`INSERT INTO email_log (user_id, kind, status) SELECT $1, 'broadcast', 'sent' FROM generate_series(1, 20)`, [id("vend")]);
    await q(`UPDATE users SET created_at = now() - interval '3 days', username = NULL WHERE id = $1`, [id("vend")]);
    r = await call("POST", "/api/admin/account-setup/send", { dryRun: false, userIds: [id("vend")] }, adminJwt);
    assert(r.status === 429 && r.json.error.code === "OVER_DAILY_LIMIT", "setup send over the limit → 429", r.json);
    r = await call("POST", "/api/admin/account-setup/send", { dryRun: true, userIds: [id("vend")] }, adminJwt);
    assert(r.status === 200 && r.json.dryRun === true, "dry runs are never blocked", r.json);
    r = await call("POST", "/api/admin/emails/broadcasts/test", { subject: "x", html: "<p>x</p>" }, adminJwt);
    assert(r.status === 429, "test send blocked once the limit is used", r.status);

  } finally {
    await q(`DELETE FROM email_log WHERE user_id LIKE $1 OR user_id = (SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com')`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM email_sends WHERE created_by = (SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com') AND created_at >= now() - interval '1 hour'`).catch(() => {});
    await q(`DELETE FROM account_setup_reminders WHERE user_id LIKE $1`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM broadcast_optouts WHERE user_id LIKE $1`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM photographers WHERE id LIKE $1`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id LIKE $1`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}%`]).catch(() => {});
    if (createdAdmin) await q(`DELETE FROM users WHERE id = $1`, [id("admin")]).catch(() => {});
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
