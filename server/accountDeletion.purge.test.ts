/**
 * Scheduled account deletion actually completes (no db.transaction, no NOT NULL violations,
 * no foreign key blocks from other users' rows) — run with:
 *   npx tsx server/accountDeletion.purge.test.ts
 *
 * SCRATCH ONLY. Needs a LOCAL Postgres built from shared/schema.ts (drizzle-kit push to 127.0.0.1)
 * reached through .dev/neon-local-proxy.mjs, plus a local fake R2 that logs requests:
 *   ACCTDEL_LOCAL_PG     postgres URL of the local database (must be localhost); used for setup + asserts
 *   ACCTDEL_S3_LOG       path of the fake R2 request log (one JSON line per request: { method, url })
 *   DATABASE_URL         any value (db.ts needs it); NODE_OPTIONS must load .dev/neon-preload.mjs
 *   R2_ENDPOINT          the fake R2, must be localhost;  R2_PUBLIC_URL e.g. https://r2.test.example
 * Skips (exit 0) when ACCTDEL_LOCAL_PG is unset; refuses any non-local database or R2 endpoint.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

(async () => {
  const PG = process.env.ACCTDEL_LOCAL_PG;
  if (!PG) { console.log('⏭  skipped: set ACCTDEL_LOCAL_PG (+ ACCTDEL_S3_LOG, R2_ENDPOINT, R2_PUBLIC_URL) to run'); process.exit(0); }
  if (!['localhost', '127.0.0.1'].includes(new URL(PG).hostname)) throw new Error('refusing to run: ACCTDEL_LOCAL_PG must be local');
  if (!['localhost', '127.0.0.1'].includes(new URL(process.env.R2_ENDPOINT || 'http://x.invalid').hostname)) throw new Error('refusing to run: R2_ENDPOINT must be a local stub');
  const LOG = process.env.ACCTDEL_S3_LOG || '';
  const R2 = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

  const pool = new pg.Pool({ connectionString: PG });
  const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;

  // Insert a row, filling any other NOT NULL column without a default with a harmless value.
  async function ins(table: string, values: Record<string, unknown>): Promise<string> {
    const cols = await q(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO' AND column_default IS NULL`, [table]);
    const row: Record<string, unknown> = { ...values };
    for (const c of cols) {
      if (c.column_name in row) continue;
      const t = String(c.data_type);
      row[c.column_name] =
        t.includes('int') || t === 'numeric' || t.includes('double') || t === 'real' ? 0 :
        t === 'boolean' ? false :
        t.includes('timestamp') || t === 'date' ? new Date() :
        t === 'jsonb' || t === 'json' ? '{}' :
        t === 'ARRAY' ? '{}' :
        c.column_name === 'id' ? crypto.randomUUID() : `t-${c.column_name}`;
    }
    const keys = Object.keys(row);
    const res = await q(
      `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      keys.map((k) => row[k]));
    return String(res[0].id);
  }
  const count = async (sql: string, v: unknown[]) => Number((await q(sql, v))[0].n);

  const S = Date.now().toString(36);
  const past = new Date(Date.now() - 86400000);
  const U = await ins('users', {
    id: crypto.randomUUID(), email: `del-${S}@test.local`, username: `deluser${S}`, password: 'hash', name: 'Del User',
    first_name: 'Del', phone: '5551234', profile_image_url: `${R2}/avatars/${S}.jpg`, cover_media_url: `${R2}/covers/${S}.jpg`,
    is_active: true, deletion_status: 'pending_deletion', deletion_requested_at: past, scheduled_deletion_at: past,
  });
  const O = await ins('users', { id: crypto.randomUUID(), email: `other-${S}@test.local`, username: `other${S}`, is_active: true, deletion_status: 'active' });
  const A = await ins('users', { id: crypto.randomUUID(), email: `active-${S}@test.local`, username: `active${S}`, is_active: true, deletion_status: 'active' });

  // U's post that OTHER people interacted with (the foreign key case that used to block the delete)
  const P = await ins('feed_posts', { author_id: U, media_url: `${R2}/posts/${S}.jpg`, media_type: 'image' });
  await ins('post_likes', { post_id: P, user_id: O });
  await ins('post_comments', { post_id: P, user_id: O, content: 'nice' });
  await ins('user_saved_posts', { post_id: P, user_id: O });
  await ins('pulse_engagements', { post_id: P, user_id: O });
  await ins('feed_engagement_events', { post_id: P, user_id: O });
  await ins('post_distribution', { post_id: P });
  // O's post that U interacted with
  const PO = await ins('feed_posts', { author_id: O, media_type: 'image' });
  await ins('post_comments', { post_id: PO, user_id: U, content: 'by U' });
  await ins('post_likes', { post_id: PO, user_id: U });
  // social + financial records that stay attached to the scrubbed account (NOT NULL columns)
  await ins('follows', { follower_user_id: U, target_user_id: O });
  const BIZO = await ins('businesses', { owner_id: O, name: `Other biz ${S}`, approval_status: 'approved' });
  const BIZ = await ins('businesses', { owner_id: U, name: `Biz ${S}`, contact_email: 'biz@test.local', approval_status: 'approved' });
  const ORD = await ins('orders', { customer_id: U, business_id: BIZO, status: 'delivered' });
  const APPT = await ins('appointments', { client_id: U, business_id: BIZ, status: 'completed' });
  await ins('refresh_tokens', { user_id: U });
  await ins('notifications', { user_id: U });
  // stories: U's live story viewed by O, and U viewing O's story
  const ST = await ins('stories', { author_id: U, media_type: 'image', media_url: `${R2}/stories/${S}.jpg`, is_active: true, expires_at: new Date(Date.now() + 3600000) });
  await ins('story_views', { story_id: ST, viewer_id: O });
  const STO = await ins('stories', { author_id: O, media_type: 'image', is_active: true, expires_at: new Date(Date.now() + 3600000) });
  await ins('story_views', { story_id: STO, viewer_id: U });

  const { processScheduledDeletions } = await import('./services/accountDeletionService');
  console.log('\nRun 1');
  await processScheduledDeletions();

  const [u] = await q('SELECT * FROM users WHERE id=$1', [U]);
  assert(u.deletion_status === 'deleted', 'account marked deleted', u.deletion_status);
  assert(u.is_active === false && u.password === null, 'login blocked (inactive, no password)');
  assert(u.email === null && u.name === null && u.first_name === null && u.phone === null, 'personal data scrubbed');
  assert(u.profile_image_url === null && u.cover_media_url === null, 'profile photo and cover cleared');
  assert(String(u.username).startsWith('deleted_'), 'username anonymized', u.username);
  assert(await count('SELECT count(*) n FROM feed_posts WHERE author_id=$1', [U]) === 0, 'own posts deleted');
  assert(await count('SELECT count(*) n FROM user_saved_posts WHERE post_id=$1', [P]) === 0, "other users' saves of the post removed");
  assert(await count('SELECT count(*) n FROM post_distribution WHERE post_id=$1', [P]) === 0, 'post distribution rows removed');
  assert(await count('SELECT count(*) n FROM stories WHERE author_id=$1', [U]) === 0, 'own stories deleted');
  assert(await count('SELECT count(*) n FROM story_views WHERE viewer_id=$1', [U]) === 0, 'own story views deleted');
  assert(await count('SELECT count(*) n FROM refresh_tokens WHERE user_id=$1', [U]) === 0, 'sessions revoked');
  assert(await count('SELECT count(*) n FROM follows WHERE follower_user_id=$1', [U]) === 0, 'follows removed');
  assert(await count('SELECT count(*) n FROM orders WHERE id=$1 AND customer_id=$2', [ORD, U]) === 1, 'order kept, linked to anonymous account');
  assert(await count('SELECT count(*) n FROM appointments WHERE id=$1', [APPT]) === 1, 'appointment kept');
  assert(await count('SELECT count(*) n FROM post_comments WHERE post_id=$1 AND user_id=$2', [PO, U]) === 1, "comment on someone else's post kept (anonymous)");
  const [b] = await q('SELECT approval_status, contact_email FROM businesses WHERE id=$1', [BIZ]);
  assert(b.approval_status === 'rejected' && b.contact_email === null, 'business hidden and scrubbed', b);
  const [o] = await q('SELECT deletion_status, email FROM users WHERE id=$1', [O]);
  assert(o.deletion_status === 'active' && o.email !== null, 'other user untouched');
  assert(await count('SELECT count(*) n FROM feed_posts WHERE id=$1', [PO]) === 1, "other user's post untouched");
  assert(await count('SELECT count(*) n FROM stories WHERE id=$1', [STO]) === 1, "other user's story untouched");
  const [a] = await q('SELECT deletion_status FROM users WHERE id=$1', [A]);
  assert(a.deletion_status === 'active', 'active account never processed');

  if (LOG && fs.existsSync(LOG)) {
    const deletes = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.method === 'DELETE').map((e) => decodeURIComponent(String(e.url)));
    for (const k of [`avatars/${S}.jpg`, `covers/${S}.jpg`, `posts/${S}.jpg`, `stories/${S}.jpg`]) {
      assert(deletes.some((d) => d.includes(k)), `storage file deleted: ${k}`);
    }
  }

  console.log('\nRun 2 (nothing pending, must be a no-op)');
  await processScheduledDeletions();
  const [u2] = await q('SELECT deletion_status, username FROM users WHERE id=$1', [U]);
  assert(u2.deletion_status === 'deleted' && u2.username === u.username, 'second run changes nothing');

  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
