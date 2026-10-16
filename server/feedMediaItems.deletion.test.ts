/**
 * Account deletion purges every photo of a multi-photo post (migration 045) — run with:
 *   npx tsx server/feedMediaItems.deletion.test.ts
 *
 * SCRATCH ONLY. Calls purgePostMediaAssets directly against a local fake R2 (any S3-compatible stub that
 * logs requests), never real storage:
 *   FEEDMI_DEL_S3_LOG   path of the stub's request log (one JSON line per request: { method, host, url })
 *   R2_ENDPOINT         the stub, must be localhost (e.g. http://127.0.0.1:4600)
 *   R2_PUBLIC_URL       e.g. https://r2.test.example
 *   DATABASE_URL        must be set (server/db.ts throws on import without it); never queried here
 * Skips (exit 0) when FEEDMI_DEL_S3_LOG is unset; refuses a non-local R2_ENDPOINT.
 */
import fs from 'node:fs';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

(async () => {
  const LOG = process.env.FEEDMI_DEL_S3_LOG;
  if (!LOG) {
    console.log('⏭  skipped: set FEEDMI_DEL_S3_LOG (+ R2_ENDPOINT, R2_PUBLIC_URL) to run');
    process.exit(0);
  }
  const endpoint = process.env.R2_ENDPOINT || '';
  if (!['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname)) {
    throw new Error('refusing to run: R2_ENDPOINT must be a local stub');
  }
  const R2 = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  const { purgePostMediaAssets } = await import('./services/accountDeletionService');

  const deletedKeys = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.method === 'DELETE')
    .map((e) => decodeURIComponent(String(e.url).split('?')[0]).replace(/^\/outsyde-media\//, '').replace(/^\//, ''));

  const P = `del-${Date.now().toString(36)}`;
  const key = (n: number) => `posts/${P}-${n}.jpeg`;
  const url = (n: number) => `${R2}/${key(n)}`;

  fs.writeFileSync(LOG, '');
  console.log('\nmulti-photo post');
  await purgePostMediaAssets('user-x', [{
    id: 'post-multi', mediaUrl: url(1), imageUrl: url(1), mediaType: 'image',
    mediaItems: [{ url: url(1) }, { url: url(2) }, { url: url(3) }],
  }]);
  let keys = deletedKeys();
  assert(keys.filter((k) => k === key(2)).length === 1 && keys.filter((k) => k === key(3)).length === 1, 'photos 2 and 3 deleted once each', keys);
  assert(keys.includes(key(1)), 'photo 1 deleted (by the existing mediaUrl/imageUrl lines)', keys);
  assert(keys.filter((k) => k === key(1)).length === 2, 'photo 1 not deleted a third time by the new loop (existing code already deletes it twice: mediaUrl + imageUrl)', keys);

  fs.writeFileSync(LOG, '');
  console.log('\nsingle-photo post (today\'s behaviour)');
  await purgePostMediaAssets('user-x', [{ id: 'post-single', mediaUrl: url(10), imageUrl: url(10), mediaType: 'image', mediaItems: [] }]);
  keys = deletedKeys();
  assert(keys.length === 2 && keys.every((k) => k === key(10)), 'single post: exactly the same deletes as before (mediaUrl + imageUrl)', keys);

  fs.writeFileSync(LOG, '');
  await purgePostMediaAssets('user-x', [{ id: 'post-legacy', mediaUrl: url(11), imageUrl: null, mediaType: 'image' }]);
  keys = deletedKeys();
  assert(keys.length === 1 && keys[0] === key(11), 'row without mediaItems field (undefined) → unchanged', keys);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
