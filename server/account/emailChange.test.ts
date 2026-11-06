/**
 * Change email (migration 107), in process. Run with:
 *   EMAIL_CHANGE_TEST_PG_URL=postgresql://…@localhost/… DATABASE_URL=<same> NODE_OPTIONS="--import ./.dev/neon-preload.mjs" \
 *   npx tsx server/account/emailChange.test.ts
 *
 * SCRATCH ONLY: needs a LOCAL Postgres with the full schema + 107 and the Neon local proxy running
 * (.dev/neon-local-proxy.mjs). Skips (exit 0) without EMAIL_CHANGE_TEST_PG_URL and refuses any non-local host.
 * Emails, Stripe and the clock are swapped through emailChangeDeps; nothing leaves the machine.
 */
const PG_URL = process.env.EMAIL_CHANGE_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'email-change-test-secret';
  const m = await import('./emailChange');

  console.log('\n── pure ──');
  const codes = Array.from({ length: 200 }, () => m.generateCode());
  assert(codes.every((c) => /^\d{6}$/.test(c)), 'codes are always 6 digits (leading zeros kept)');
  const h = m.hashCode('req-a', '123456');
  assert(h !== '123456' && /^[0-9a-f]{64}$/.test(h), 'only an HMAC is stored');
  assert(m.codeMatches('req-a', '123456', h) && !m.codeMatches('req-a', '123457', h), 'right code matches, wrong code does not');
  assert(!m.codeMatches('req-b', '123456', h), 'a code is bound to its request');
  assert(m.isAdminAddress(' INFO@goutsyde.com ') && m.isAdminAddress('JamesMeyers2304@gmail.com') && !m.isAdminAddress('a@b.co'), 'admin addresses, any case');
  assert(!m.requestBodySchema.safeParse({ newEmail: 'nope' }).success, 'invalid email refused');
  assert(!m.requestBodySchema.safeParse({ newEmail: 'a@b.co', extra: 1 }).success, 'unknown fields refused');
  assert(!m.confirmBodySchema.safeParse({ code: '12345' }).success && !m.confirmBodySchema.safeParse({ code: 'abcdef' }).success, 'code must be 6 digits');
  const notice = m.buildChangedNotice('<b>x@y.co</b>');
  assert(notice.html.includes('&lt;b&gt;') && !/[–—]| - /.test(notice.html + m.buildCodeEmail('000000').html), 'notice escapes the address; no dashes in copy');

  if (!PG_URL) { console.log(`\n⏭  DB tests skipped: set EMAIL_CHANGE_TEST_PG_URL\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }
  if (!isLocal(PG_URL) || !process.env.DATABASE_URL || !isLocal(process.env.DATABASE_URL)) throw new Error('refusing to run: databases must be local scratch instances');

  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  const q = async (t: string, p: unknown[] = []) => (await client.query(t, p)).rows as any[];

  // Swapped dependencies.
  const sent: { to: string; code: string }[] = [];
  const notices: { to: string; newEmail: string }[] = [];
  const stripeCalls: { id: string; email: string }[] = [];
  const alerts: string[] = [];
  let sendOk = true, stripeOk = true;
  let clock: Date | null = null;
  m.emailChangeDeps.sendCode = async (to, code) => { if (!sendOk) return false; sent.push({ to, code }); return true; };
  m.emailChangeDeps.sendChangedNotice = async (to, newEmail) => { notices.push({ to, newEmail }); return true; };
  m.emailChangeDeps.updateStripeCustomerEmail = async (id, email) => { if (!stripeOk) throw new Error('stripe down'); stripeCalls.push({ id, email }); };
  m.emailChangeDeps.alertOutsyde = async (subject) => { alerts.push(subject); };
  m.emailChangeDeps.now = () => clock ?? new Date();
  const lastCode = () => sent[sent.length - 1].code;
  const verifyPassword = async (pw: string, hash: string) => hash === `pw:${pw}`;

  const P = `ec${Date.now().toString(36)}`;
  const users: string[] = [], bizs: string[] = [];
  const mkUser = async (key: string, o: { email?: string | null; password?: string | null; admin?: boolean; active?: boolean; stripe?: string | null } = {}) => {
    const id = `${P}-${key}`.slice(0, 36);
    await q(`INSERT INTO users (id, username, email, password, is_admin, is_active, stripe_customer_id) VALUES ($1::varchar, $1::text, $2, $3, $4, $5, $6)`,
      [id, o.email === undefined ? `${id}@old.test` : o.email, o.password === undefined ? 'pw:secret' : o.password, !!o.admin, o.active ?? true, o.stripe ?? null]);
    users.push(id);
    return id;
  };
  const email = async (id: string) => (await q(`SELECT email FROM users WHERE id = $1`, [id]))[0]?.email;
  const pendingCount = async (id: string) => Number((await q(`SELECT count(*)::int n FROM email_change_requests WHERE user_id = $1 AND status = 'pending'`, [id]))[0].n);
  const req = (userId: string, body: unknown) => m.requestEmailChange({ userId, body, verifyPassword });
  const conf = (userId: string, code: string) => m.confirmEmailChange({ userId, body: { code } });
  const errCode = (r: any) => r.body?.error?.code;

  try {
    console.log('\n── request: refusals ──');
    const a = await mkUser('a', { stripe: 'cus_test_a' });
    assert(errCode(await req(a, { newEmail: 'bad', password: 'secret' })) === 'INVALID_EMAIL', 'invalid email');
    assert(errCode(await req(a, { newEmail: `${a.toUpperCase()}@OLD.TEST`, password: 'secret' })) === 'SAME_EMAIL', 'same email in another case');
    assert(errCode(await req(a, { newEmail: 'Info@GoOutsyde.com'.replace('GoOutsyde', 'goutsyde'), password: 'secret' })) === 'EMAIL_NOT_ALLOWED', 'admin address as target');
    assert(errCode(await req(a, { newEmail: 'new-a@new.test' })) === 'PASSWORD_REQUIRED', 'password required when the account has one');
    const wrong = await req(a, { newEmail: 'new-a@new.test', password: 'nope' });
    assert(wrong.status === 401 && errCode(wrong) === 'WRONG_PASSWORD', 'wrong password');
    const taker = await mkUser('taker', { email: 'Taken@New.Test' });
    const taken = await req(a, { newEmail: 'taken@new.test', password: 'secret' });
    assert(taken.status === 409 && errCode(taken) === 'EMAIL_TAKEN', 'address used by another account (other case)');
    const adm = await mkUser('adm', { admin: true });
    assert(errCode(await req(adm, { newEmail: 'x@new.test', password: 'secret' })) === 'ADMIN_ACCOUNT', 'admin flag account refused');
    const admMail = await mkUser('admmail', { email: 'JamesMeyers2304@gmail.com' }).catch(() => null);
    if (admMail) assert(errCode(await req(admMail, { newEmail: 'x2@new.test', password: 'secret' })) === 'ADMIN_ACCOUNT', 'admin email account refused');
    const off = await mkUser('off', { active: false });
    assert(errCode(await req(off, { newEmail: 'off@new.test', password: 'secret' })) === 'ACCOUNT_UNAVAILABLE', 'disabled account refused');
    assert(sent.length === 0 && (await pendingCount(a)) === 0, 'no code sent and nothing saved for any refusal');

    console.log('\n── request: send failure ──');
    sendOk = false;
    const sf = await req(a, { newEmail: 'new-a@new.test', password: 'secret' });
    sendOk = true;
    assert(sf.status === 502 && errCode(sf) === 'EMAIL_FAILED' && (await pendingCount(a)) === 0, 'code email failed: 502, request closed');

    console.log('\n── request + confirm: happy path ──');
    const biz = `${P}-biz`.slice(0, 36);
    await q(`INSERT INTO businesses (id, owner_id, name, category) VALUES ($1, $2, 'Test Biz', 'beauty')`, [biz, taker]);
    bizs.push(biz);
    await q(`INSERT INTO staff_members (business_id, user_id, display_name, email) VALUES ($1, $2, 'Linked', $3)`, [biz, a, `${a.toUpperCase()}@old.test`]);
    await q(`INSERT INTO staff_members (business_id, user_id, display_name, email) VALUES ($1, NULL, 'Not linked', $2)`, [biz, `${a}@old.test`]);
    await q(`INSERT INTO staff_invites (business_id, email, invite_code, status) VALUES ($1, $2, $3, 'pending'), ($1, $2, $4, 'accepted')`, [biz, `${a}@old.test`, `${P}-i1`, `${P}-i2`]);

    const ok = await req(a, { newEmail: '  New-A@New.Test ', password: 'secret' });
    assert(ok.status === 200 && (ok.body as any).pending?.newEmail === 'new-a@new.test', 'request accepted, address lowercased');
    assert(sent.length === 1 && sent[0].to === 'new-a@new.test', 'code sent to the NEW address');
    const row = (await q(`SELECT * FROM email_change_requests WHERE user_id = $1 AND status = 'pending'`, [a]))[0];
    assert(row && row.code_hash !== sent[0].code && row.old_email === `${a}@old.test`, 'saved with a hash, never the code');
    const g = await m.getPendingEmailChange(a);
    assert((g.body as any).pending?.newEmail === 'new-a@new.test' && (g.body as any).pending?.triesLeft === 5, 'GET shows the open request');
    assert((g.body as any).passwordRequired === true, 'GET: passwordRequired true for an account with a password');
    assert((await email(a)) === `${a}@old.test`, 'email unchanged until confirmed');

    const w = await conf(a, lastCode() === '000000' ? '000001' : '000000');
    assert(w.status === 400 && errCode(w) === 'WRONG_CODE' && (w.body as any).triesLeft === 4, 'wrong code: 4 tries left');
    const c = await conf(a, lastCode());
    assert(c.status === 200 && (c.body as any).email === 'new-a@new.test', 'right code: confirmed');
    assert((await email(a)) === 'new-a@new.test', 'users.email moved');
    assert((await q(`SELECT status FROM email_change_requests WHERE id = $1`, [row.id]))[0].status === 'confirmed', 'request closed as confirmed');
    assert(stripeCalls.length === 1 && stripeCalls[0].id === 'cus_test_a' && stripeCalls[0].email === 'new-a@new.test', 'Stripe customer email updated');
    assert(notices.length === 1 && notices[0].to === `${a}@old.test` && notices[0].newEmail === 'new-a@new.test', 'notice to the OLD address');
    const staff = await q(`SELECT display_name, email FROM staff_members WHERE business_id = $1 ORDER BY display_name`, [biz]);
    assert(staff.find((s) => s.display_name === 'Linked')?.email === 'new-a@new.test', 'own linked staff profile follows');
    assert(staff.find((s) => s.display_name === 'Not linked')?.email === `${a}@old.test`, 'staff profile not linked to the user untouched');
    const inv = await q(`SELECT status, email FROM staff_invites WHERE business_id = $1 ORDER BY status`, [biz]);
    assert(inv.find((i) => i.status === 'pending')?.email === 'new-a@new.test' && inv.find((i) => i.status === 'accepted')?.email === `${a}@old.test`, 'pending invite follows, accepted invite untouched');
    const audit = await q(`SELECT before_state, after_state FROM audit_logs WHERE action = 'user.email_change' AND target_id = $1`, [a]);
    assert(audit.length === 1 && audit[0].before_state.email === `${a}@old.test` && audit[0].after_state.email === 'new-a@new.test', 'audit log written');
    assert(errCode(await conf(a, lastCode())) === 'NO_PENDING', 'a used code can not be used again');

    console.log('\n── replace, tries, expiry, cancel ──');
    const b = await mkUser('b', { password: null }); // Google or Apple only
    const gb = await m.getPendingEmailChange(b);
    assert((gb.body as any).passwordRequired === false && (gb.body as any).pending === null, 'GET: passwordRequired false and no request for a Google or Apple only account');
    const r1 = await req(b, { newEmail: 'b1@new.test' });
    assert(r1.status === 200, 'no password account: code alone is enough');
    const code1 = lastCode();
    await req(b, { newEmail: 'b2@new.test' });
    assert((await pendingCount(b)) === 1, 'a new request replaces the open one');
    const stale = await conf(b, code1);
    assert(code1 === lastCode() || errCode(stale) === 'WRONG_CODE', 'the replaced code no longer works');
    for (let i = 0; i < 3; i++) await conf(b, '999999' === lastCode() ? '999998' : '999999');
    const fifth = await conf(b, '999999' === lastCode() ? '999998' : '999999');
    assert(fifth.status === 429 && errCode(fifth) === 'TOO_MANY_TRIES', '5 wrong codes: locked');
    assert(errCode(await conf(b, lastCode())) === 'NO_PENDING', 'even the right code fails after the lock');
    assert((await email(b)) === `${b}@old.test`, 'email unchanged after the lock');

    await req(b, { newEmail: 'b3@new.test' });
    clock = new Date(Date.now() + 16 * 60 * 1000);
    const exp = await conf(b, lastCode());
    clock = null;
    assert(exp.status === 410 && errCode(exp) === 'CODE_EXPIRED', 'expired after 15 minutes');

    await req(b, { newEmail: 'b4@new.test' });
    const cancel = await m.cancelEmailChange(b);
    assert((cancel.body as any).cancelled === true && (await pendingCount(b)) === 0, 'cancel closes the request');
    assert(errCode(await conf(b, lastCode())) === 'NO_PENDING', 'nothing to confirm after cancel');

    console.log('\n── rate limit ──');
    // b made 4 requests within this hour (b1 to b4): the 5th is allowed, the 6th refused.
    assert((await req(b, { newEmail: 'b5@new.test' })).status === 200, '5th request in an hour allowed');
    const six = await req(b, { newEmail: 'b6@new.test' });
    assert(six.status === 429 && errCode(six) === 'TOO_MANY_REQUESTS', '6th request in an hour refused');

    console.log('\n── races ──');
    const r = await mkUser('r');
    await req(r, { newEmail: 'race@new.test', password: 'secret' });
    const raceCode = lastCode();
    const other = await mkUser('other', { email: 'RACE@new.test' }); // takes it after the request
    const lost = await conf(r, raceCode);
    assert(lost.status === 409 && errCode(lost) === 'EMAIL_TAKEN', 'address taken between request and confirm: refused');
    assert((await email(r)) === `${r}@old.test` && (await pendingCount(r)) === 0, 'email unchanged, request closed');
    await q(`DELETE FROM users WHERE id = $1`, [other]);

    const d = await mkUser('d');
    await req(d, { newEmail: 'double@new.test', password: 'secret' });
    const dc = lastCode();
    const both = await Promise.all([conf(d, dc), conf(d, dc)]);
    assert(both.filter((x) => x.status === 200).length === 1, 'two confirms at once: exactly one wins', both.map((x) => x.status));
    assert(notices.filter((n) => n.newEmail === 'double@new.test').length === 1, 'one notice only');

    const e1 = await mkUser('e1'), e2 = await mkUser('e2');
    await req(e1, { newEmail: 'same@new.test', password: 'secret' }); const ce1 = lastCode();
    await req(e2, { newEmail: 'same@new.test', password: 'secret' }); const ce2 = lastCode();
    const pair = await Promise.all([conf(e1, ce1), conf(e2, ce2)]);
    const owners = await q(`SELECT id FROM users WHERE lower(email) = 'same@new.test'`);
    assert(pair.filter((x) => x.status === 200).length === 1 && owners.length === 1, 'two users racing for one address: one gets it', pair.map((x) => x.status));

    const f = await mkUser('f');
    const pr = await Promise.all([req(f, { newEmail: 'f1@new.test', password: 'secret' }), req(f, { newEmail: 'f2@new.test', password: 'secret' })]);
    assert((await pendingCount(f)) === 1 && pr.every((x) => x.status === 200 || errCode(x) === 'REQUEST_BUSY'), 'two requests at once: one open request', pr.map((x) => x.status));

    console.log('\n── Stripe failure ──');
    const s = await mkUser('s', { stripe: 'cus_test_s' });
    await req(s, { newEmail: 's@new.test', password: 'secret' });
    stripeOk = false;
    const sc = await conf(s, lastCode());
    stripeOk = true;
    assert(sc.status === 200 && (await email(s)) === 's@new.test', 'Stripe down: email still changes');
    assert(alerts.length === 1, 'Outsyde alerted to fix Stripe by hand');
  } finally {
    await q(`DELETE FROM staff_invites WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM staff_members WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    await q(`DELETE FROM audit_logs WHERE target_id = ANY($1)`, [users]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]); // email_change_requests cascade
    await client.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
