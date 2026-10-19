/**
 * Real name vs display name, end to end against a LOCAL server + scratch DB (never production).
 *
 *   MSG_TEST_BASE_URL=http://127.0.0.1:5062 MSG_TEST_PG_URL=postgresql://...@127.0.0.1:5432/outsyde \
 *   JWT_SECRET=... npx tsx server/displayName.http.test.ts
 *
 * Rule (personName.ts): first_name/last_name = real name, only in transactions and for admins.
 * users.name = display name everywhere else, falling back to @username. New accounts: display = first name.
 */
const BASE = process.env.MSG_TEST_BASE_URL;
const PG_URL = process.env.MSG_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log("⏭  skipped: set MSG_TEST_BASE_URL + MSG_TEST_PG_URL to run");
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error("refusing to run: base URL and database must both be local scratch instances");
  }
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `dn${Date.now().toString(36)}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
  const userByEmail = async (email: string) => (await q(`SELECT * FROM users WHERE email = $1`, [email]))[0];
  const tokenFor = (u: any) => generateAccessToken({ userId: u.id, isVendor: !!u.is_vendor, isPhotographer: !!u.is_photographer, isAdmin: !!u.is_admin });
  const bearer = (u: any) => ({ Authorization: `Bearer ${tokenFor(u)}` });

  // ── signups ──────────────────────────────────────────────────────────
  console.log("signup: display name = first name, real name saved in first/last");
  const first = `Jas${P}`;
  const last = `Car${P}`;
  const custEmail = `${P}-cust@x.test`;
  let r = await call("POST", "/api/auth/customer/signup", { email: custEmail, password: "local-pass-123", name: `${first} ${last}`, firstName: first, lastName: last, username: `${P}_cust` });
  assert(r.status < 300, "app customer signup ok", r);
  const cust = await userByEmail(custEmail);
  assert(cust?.name === first && cust?.first_name === first && cust?.last_name === last, "app signup: name=first, first_name/last_name saved", cust && { name: cust.name, f: cust.first_name, l: cust.last_name });

  const siteEmail = `${P}-site@x.test`;
  r = await call("POST", "/api/auth/register", { email: siteEmail, password: "local-pass-123", name: `Mary${P} Ann Smith${P}`, username: `${P}_site`, source: "test-site" });
  assert(r.status < 300, "vendor site register (name only) ok", r);
  const site = await userByEmail(siteEmail);
  assert(site?.name === `Mary${P}` && site?.first_name === `Mary${P}` && site?.last_name === `Ann Smith${P}`, "name only: split, display = first word", site && { name: site.name, f: site.first_name, l: site.last_name });

  const vendEmail = `${P}-vend@x.test`;
  r = await call("POST", "/api/auth/vendor/signup", { email: vendEmail, password: "local-pass-123", name: `Danei${P} Owner${P}`, businessName: `Braids${P} Studio`, businessCategory: "Hair", offerType: "services", acceptedSubscription: true, username: `${P}_vend`, deferAdminNotification: true });
  assert(r.status < 300, "vendor signup ok", r);
  const vend = await userByEmail(vendEmail);
  assert(vend?.name === `Danei${P}` && vend?.first_name === `Danei${P}` && vend?.last_name === `Owner${P}`, "vendor signup: owner display = first name, real name saved", vend && { name: vend.name, f: vend.first_name, l: vend.last_name });

  const photoEmail = `${P}-photo@x.test`;
  r = await call("POST", "/api/auth/photographer/signup", { email: photoEmail, password: "local-pass-123", name: `Greg${P} Lens${P}`, displayName: `Gicasso${P} Films`, username: `${P}_photo` });
  assert(r.status < 300, "photographer signup ok", r);
  const photo = await userByEmail(photoEmail);
  const ph = photo ? (await q(`SELECT display_name FROM photographers WHERE user_id = $1`, [photo.id]))[0] : null;
  assert(photo?.name === `Greg${P}` && photo?.last_name === `Lens${P}` && ph?.display_name === `Gicasso${P} Films`, "photographer: brand display name untouched, users.name = first name", { name: photo?.name, l: photo?.last_name, ph });

  // ── /api/auth/me ─────────────────────────────────────────────────────
  console.log("/api/auth/me");
  r = await call("GET", "/api/auth/me", undefined, bearer(cust));
  const me = r.json?.user;
  assert(me?.displayName === first && me?.name === first && me?.username === `${P}_cust`, "auth/me now returns display name + username (additive)", me);
  assert(me?.firstName === first && me?.lastName === last, "auth/me still returns own real name", me);

  // ── public surfaces ──────────────────────────────────────────────────
  console.log("comments, followers, search: never the real name");
  // Someone with NO display name (older data): must show @username, never their first name.
  const blankId = `${P}-blank`;
  await q(`INSERT INTO users (id, username, email, password, name, first_name, last_name) VALUES ($1, $2, $3, 'x', '', $4, $5)`, [blankId, `${P}_blank`, `${P}-blank@x.test`, `Quinn${P}`, `Real${P}`]);
  const postId = `${P}-post`;
  await q(`INSERT INTO feed_posts (id, author_id, author_type, content) VALUES ($1, $2, 'customer', 'hello')`, [postId, vend.id]);
  await q(`INSERT INTO post_comments (post_id, user_id, content) VALUES ($1, $2, 'nice'), ($1, $3, 'cool')`, [postId, cust.id, blankId]);
  r = await call("GET", `/api/feed/${postId}/comments`);
  const list: any[] = r.json?.comments ?? r.json ?? [];
  const cc = list.find((c) => c.userId === cust.id)?.user;
  const bc = list.find((c) => c.userId === blankId)?.user;
  assert(cc?.name === first && cc?.firstName === null && cc?.lastName === null, "comment author: display name, no first/last sent", cc);
  assert(bc?.name === `@${P}_blank` && bc?.firstName === null, "comment author without display name: @username, never first name", bc);

  await q(`INSERT INTO follows (follower_user_id, target_user_id) VALUES ($1, $2), ($3, $2)`, [cust.id, vend.id, blankId]);
  r = await call("GET", `/api/users/${vend.id}/followers`);
  const fl: any[] = r.json?.followers ?? r.json ?? [];
  const names = fl.map((f) => f.displayName);
  assert(names.includes(first) && names.includes(`@${P}_blank`) && !names.some((n) => String(n).includes(`Quinn${P}`)), "followers: display name or @username, never first name", names);

  r = await call("GET", `/api/search?q=${encodeURIComponent(last)}&scope=consumers`);
  const byLast = JSON.stringify(r.json ?? {});
  assert(r.status === 200 && !byLast.includes(cust.id), "public search: NOT found by real last name", r.status);
  r = await call("GET", `/api/search?q=${encodeURIComponent(`Quinn${P}`)}&scope=consumers`);
  assert(r.status === 200 && !JSON.stringify(r.json ?? {}).includes(blankId), "public search: NOT found by real first name", r.status);
  r = await call("GET", `/api/search?q=${encodeURIComponent(first)}&scope=consumers`);
  const s1 = JSON.stringify(r.json ?? {});
  assert(r.status === 200 && s1.includes(cust.id) && !s1.includes(last), "public search: found by display name, real last name not in the result", r.status);

  const adminId = `${P}-admin`;
  await q(`INSERT INTO users (id, username, email, password, name, is_admin) VALUES ($1, $2, $3, 'x', 'Admin', true)`, [adminId, `${P}_admin`, `${P}-admin@x.test`]);
  const admin = { id: adminId, is_admin: true };
  r = await call("GET", `/api/search?q=${encodeURIComponent(last)}&scope=consumers&viewerUserId=${adminId}`);
  assert(r.status === 200 && !JSON.stringify(r.json ?? {}).includes(cust.id), "viewerUserId=<admin> without signing in does NOT unlock admin search", r.status);
  r = await call("GET", `/api/search?q=${encodeURIComponent(last)}&scope=consumers`, undefined, bearer(admin));
  const sa = JSON.stringify(r.json ?? {});
  assert(r.status === 200 && sa.includes(cust.id), "signed-in admin: can still find a customer by real last name", sa.slice(0, 600));

  // ── staff invite page ────────────────────────────────────────────────
  console.log("staff invite");
  const bizId = (await q(`SELECT id FROM businesses WHERE owner_id = $1`, [vend.id]))[0]?.id;
  const code = `${P}code`;
  await q(`INSERT INTO staff_invites (business_id, email, invite_code, invited_by_user_id, status, expires_at) VALUES ($1, $2, $3, $4, 'pending', now() + interval '3 days')`, [bizId, custEmail, code, vend.id]);
  r = await call("GET", `/api/staff/invites/${code}`);
  const inv = r.json?.invite ?? r.json;
  assert(r.status === 200 && inv?.invitedByName === `Danei${P}`, "public invite page: inviter's display name, not their real name", inv);
  // Accept through signup with the invite code (goutsyde.com accept-invite page does this).
  const staffEmail = `${P}-staff@x.test`;
  const code2 = `${P}code2`;
  await q(`INSERT INTO staff_invites (business_id, email, invite_code, invited_by_user_id, status, expires_at) VALUES ($1, $2, $3, $4, 'pending', now() + interval '3 days')`, [bizId, staffEmail, code2, vend.id]);
  r = await call("POST", "/api/auth/customer/signup", { email: staffEmail, password: "local-pass-123", name: `Tia${P} Stylist${P}`, username: `${P}_staff`, inviteCode: code2 });
  const staffUser = await userByEmail(staffEmail);
  const staffRow = staffUser ? (await q(`SELECT display_name FROM staff_members WHERE business_id = $1 AND user_id = $2`, [bizId, staffUser.id]))[0] : null;
  assert(staffRow?.display_name === `Tia${P}`, "accepted staff member's public name = display name (was real full name or email)", { status: r.status, staffRow });

  // ── transactions keep the real name; receipts need real access ───────
  console.log("receipts");
  const apptId = `${P}-appt`;
  await q(`INSERT INTO appointments (id, business_id, client_id, appointment_date, appointment_time, total_price, status) VALUES ($1, $2, $3, $4, '10:00', 5000, 'confirmed')`, [apptId, bizId, cust.id, `2099-${P}`]);
  const orderId = `${P}-order`;
  await q(`INSERT INTO orders (id, business_id, customer_id, items, total_amount) VALUES ($1, $2, $3, '[]'::jsonb, 5000)`, [orderId, bizId, cust.id]);
  for (const [kind, path] of [["appointment", `/api/appointments/${apptId}/receipt`], ["order", `/api/orders/${orderId}/receipt`]]) {
    r = await call("GET", path, undefined, { ...bearer(site), "x-business-id": bizId });
    assert(r.status === 403, `${kind} receipt: a stranger sending x-business-id is refused (was allowed)`, r.status);
    r = await call("GET", path, undefined, bearer(vend));
    assert(r.status === 200 && r.json?.customer?.name === `${first} ${last}`, `${kind} receipt: business owner sees the customer's real name`, r.json?.customer);
    r = await call("GET", path, undefined, bearer(cust));
    assert(r.status === 200, `${kind} receipt: the customer can still open it`, r.status);
  }

  r = await call("GET", "/api/business/bookings", undefined, bearer(vend));
  const bookings = JSON.stringify(r.json ?? {});
  assert(r.status === 200 && bookings.includes(`${first} ${last}`), "vendor bookings list shows the customer's real name", r.status);

  await db.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
