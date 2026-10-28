/**
 * Video Fill / Fit (migration 078) + Mux video size HTTP tests — run with:
 *   npx tsx server/videoFit.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema +
 * migration 078), with R2_PUBLIC_URL and MUX_WEBHOOK_SECRET set on the server, and the same values here:
 *   VIDEOFIT_TEST_BASE_URL   e.g. http://localhost:5091   (must be localhost)
 *   VIDEOFIT_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   MUX_WEBHOOK_SECRET       identical to the server's
 * Skips (exit 0) when VIDEOFIT_TEST_BASE_URL is unset; refuses any non-local host, so it can never
 * touch Neon or production.
 *
 * Rules under test:
 *  - POST /api/feed: videoFit 'fill' | 'fit' saved for videos, NULL for photos, NULL when not sent
 *    (older apps), 400 for any other value. A photo sent with media {width,height,aspectRatio} keeps
 *    its size (the new app's one-photo path).
 *  - Every post reader returns videoFit: /api/feed/:id, /api/profiles/:id/posts (also mediaWidth /
 *    mediaHeight), /api/users/:id/posts, /api/users/me/saved-posts, /api/pulse/feed.
 *  - POST /api/stories: videoFit saved for video stories, NULL for photos and when not sent, 400 otherwise.
 *    POST /api/stories/highlights copies video_fit from the story.
 *  - Mux webhook video.asset.ready fills media_width / media_height / aspect_ratio from the video track,
 *    only where they are empty (a second webhook never overwrites).
 */
import { createHmac } from "crypto";

const BASE = process.env.VIDEOFIT_TEST_BASE_URL;
const PG_URL = process.env.VIDEOFIT_TEST_PG_URL;
const SECRET = process.env.MUX_WEBHOOK_SECRET;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log("⏭  skipped: set VIDEOFIT_TEST_BASE_URL (+ VIDEOFIT_TEST_PG_URL, MUX_WEBHOOK_SECRET) to run the HTTP tests");
    process.exit(0);
  }
  if (!PG_URL || !SECRET || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error("refusing to run: base URL and database must both be local scratch instances, and MUX_WEBHOOK_SECRET must be set");
  }

  const bcryptMod: any = await import("bcrypt");
  const bcrypt = bcryptMod.default ?? bcryptMod;
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `vfit-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const PASSWORD = "local-test-pass-123";
  const hash = await bcrypt.hash(PASSWORD, 4);
  await q(`INSERT INTO users (id, username, email, password, name) VALUES ($1::varchar, $2, $3, $4, 'Video Poster')`,
    [id("author"), `vf${Date.now().toString(36)}`, `${id("author")}@x.test`, hash]);

  let ipSeq = 0;
  let cookie = "";
  let token = "";
  async function call(method: string, path: string, o: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "X-Forwarded-For": `10.97.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`, ...(o.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined = o.raw;
    if (o.body !== undefined) body = JSON.stringify(o.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(BASE + path, { method, headers, body });
    const sid = (r.headers as any).getSetCookie?.().find((c: string) => c.startsWith("connect.sid="));
    if (sid) cookie = sid.split(";")[0];
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text };
  }

  const login = await call("POST", "/api/auth/mobile/login", { body: { email: `${id("author")}@x.test`, password: PASSWORD } });
  if (login.status !== 200 || !cookie || !login.body?.accessToken) throw new Error(`login failed: ${login.status} ${login.text.slice(0, 200)}`);
  token = login.body.accessToken;
  const postRow = async (pid: string) => (await q(`SELECT media_width, media_height, aspect_ratio, video_fit, media_url FROM feed_posts WHERE id = $1`, [pid]))[0];
  const created: string[] = [];
  const newPost = async (body: Record<string, unknown>) => {
    const r = await call("POST", "/api/feed", { body: { content: "vf", ...body } });
    const pid = r.body?.post?.id ?? r.body?.id;
    if (pid) created.push(pid);
    return { r, pid };
  };

  try {
    console.log("\nPOST /api/feed");
    const upFit = `upl${P}fit`;
    const fitVideo = await newPost({ videoUrl: upFit, mediaType: "video", feedSurface: "pulse", displayLayout: "pulse", videoFit: "fit" });
    assert(fitVideo.r.status === 200 && !!fitVideo.pid, "video with videoFit 'fit' → created", { status: fitVideo.r.status, body: fitVideo.r.text.slice(0, 200) });
    assert((await postRow(fitVideo.pid))?.video_fit === "fit", "video_fit saved as 'fit'");

    const upNone = `upl${P}none`;
    const noFit = await newPost({ videoUrl: upNone, mediaType: "video", feedSurface: "pulse", displayLayout: "pulse" });
    assert(noFit.r.status === 200 && (await postRow(noFit.pid))?.video_fit === null, "video without videoFit (older apps) → NULL");

    const photoFit = await newPost({ imageUrl: "https://r2.test.example/a.jpg", videoFit: "fill" });
    assert(photoFit.r.status === 200 && (await postRow(photoFit.pid))?.video_fit === null, "photo sent with videoFit → stored NULL");

    const bad = await call("POST", "/api/feed", { body: { content: "vf", videoUrl: `upl${P}bad`, mediaType: "video", feedSurface: "pulse", videoFit: "zoom" } });
    assert(bad.status === 400, "videoFit 'zoom' → 400", { status: bad.status });

    const sized = await newPost({ media: { url: "https://r2.test.example/s.jpg", type: "image", width: 1080, height: 1350, aspectRatio: 0.8 } });
    const sizedRow = await postRow(sized.pid);
    assert(sized.r.status === 200 && sizedRow?.media_width === 1080 && sizedRow?.media_height === 1350 && sizedRow?.aspect_ratio === 0.8,
      "one photo with media {width, height, aspectRatio} → size saved", sizedRow);

    console.log("\nreaders");
    let r = await call("GET", `/api/feed/${fitVideo.pid}`);
    assert(r.status === 200 && r.body?.post?.videoFit === "fit", "GET /api/feed/:id → videoFit", { status: r.status, v: r.body?.post?.videoFit });

    r = await call("GET", `/api/profiles/${id("author")}/posts`);
    const profilePosts: any[] = r.body?.posts ?? r.body ?? [];
    const pFit = profilePosts.find((p: any) => p.id === fitVideo.pid);
    const pSized = profilePosts.find((p: any) => p.id === sized.pid);
    assert(r.status === 200 && pFit?.videoFit === "fit" && pSized?.mediaWidth === 1080 && pSized?.mediaHeight === 1350,
      "GET /api/profiles/:id/posts → videoFit, mediaWidth, mediaHeight", { status: r.status, pFit, pSized });

    r = await call("GET", `/api/users/${id("author")}/posts`);
    const userPosts: any[] = r.body?.posts ?? r.body?.data ?? [];
    const uFit = userPosts.find((p: any) => p.id === fitVideo.pid);
    assert(r.status === 200 && uFit?.videoFit === "fit", "GET /api/users/:id/posts → videoFit", { status: r.status, keys: Object.keys(r.body || {}), uFit });

    r = await call("POST", `/api/feed/${fitVideo.pid}/save`);
    assert(r.status === 200 || r.status === 201, "save the video post", { status: r.status });
    r = await call("GET", "/api/users/me/saved-posts");
    const sp = (r.body?.posts || []).find((p: any) => p.id === fitVideo.pid);
    assert(r.status === 200 && sp?.videoFit === "fit", "GET /api/users/me/saved-posts → videoFit", { status: r.status, sp });

    console.log("\nMux webhook");
    function signed(body: unknown) {
      const raw = JSON.stringify(body);
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", SECRET!).update(`${t}.${raw}`).digest("hex");
      return { raw, headers: { "Mux-Signature": `t=${t},v1=${sig}` } };
    }
    const ready = (uploadId: string, playbackId: string, w: number, h: number, aspect: string) => ({
      type: "video.asset.ready",
      data: {
        id: `asset${playbackId}`, upload_id: uploadId, aspect_ratio: aspect,
        playback_ids: [{ id: playbackId, policy: "public" }],
        tracks: [{ type: "video", max_width: w, max_height: h }, { type: "audio" }],
      },
    });
    let s = signed(ready(upFit, `pb${P}fit`, 1080, 1920, "9:16"));
    r = await call("POST", "/api/webhooks/mux", { raw: s.raw, headers: s.headers });
    let row = await postRow(fitVideo.pid);
    assert(r.status === 200 && row?.media_width === 1080 && row?.media_height === 1920 && Math.abs(row?.aspect_ratio - 0.5625) < 1e-9
      && row?.media_url === `https://stream.mux.com/pb${P}fit.m3u8`, "ready webhook → playback URL + video size saved", row);

    s = signed(ready(upNone, `pb${P}none`, 1920, 1080, "9:16"));
    r = await call("POST", "/api/webhooks/mux", { raw: s.raw, headers: s.headers });
    row = await postRow(noFit.pid);
    assert(row?.media_width === 1080 && row?.media_height === 1920, "rotated track (1920x1080, asset 9:16) → saved as 1080x1920", row);

    await q(`UPDATE feed_posts SET media_url = $2 WHERE id = $1`, [fitVideo.pid, `upl${P}again`]);
    s = signed(ready(`upl${P}again`, `pb${P}again`, 640, 360, "16:9"));
    r = await call("POST", "/api/webhooks/mux", { raw: s.raw, headers: s.headers });
    row = await postRow(fitVideo.pid);
    assert(row?.media_width === 1080 && row?.media_height === 1920, "second webhook never overwrites an existing size", row);

    const upNoTrack = `upl${P}notrack`;
    const noTrack = await newPost({ videoUrl: upNoTrack, mediaType: "video", feedSurface: "pulse", displayLayout: "pulse" });
    s = signed({ type: "video.asset.ready", data: { id: "assetX", upload_id: upNoTrack, playback_ids: [{ id: `pb${P}nt`, policy: "public" }] } });
    r = await call("POST", "/api/webhooks/mux", { raw: s.raw, headers: s.headers });
    row = await postRow(noTrack.pid);
    assert(r.status === 200 && row?.media_url === `https://stream.mux.com/pb${P}nt.m3u8` && row?.media_width === null,
      "webhook without tracks (as before) → URL set, size left empty", row);

    r = await call("GET", "/api/pulse/feed?limit=50");
    const cards: any[] = r.body?.data?.videos ?? [];
    // Match by video URL: the local Neon proxy builds rows by column name, so the joined
    // post_distribution.id (NULL) overwrites feed_posts.id on this route locally. Real Neon is positional.
    const fitCard = cards.find((c: any) => c.videoUrl === `https://stream.mux.com/pb${P}none.m3u8`);
    const autoCard = cards.find((c: any) => c.videoUrl === `https://stream.mux.com/pb${P}nt.m3u8`);
    assert(r.status === 200 && !!fitCard && fitCard.videoFit === null && !!autoCard && autoCard.videoFit === null,
      "GET /api/pulse/feed → cards carry videoFit (null = automatic)", { status: r.status, fitCard, autoCard });
    await q(`UPDATE feed_posts SET video_fit = 'fill' WHERE id = $1`, [noTrack.pid]);
    r = await call("GET", "/api/pulse/feed?limit=50");
    const filled = (r.body?.data?.videos ?? []).find((c: any) => c.videoUrl === `https://stream.mux.com/pb${P}nt.m3u8`);
    assert(filled?.videoFit === "fill", "GET /api/pulse/feed → saved 'fill' comes through", filled);

    console.log("\nstories");
    r = await call("POST", "/api/stories", { body: { mediaUrl: `upl${P}st`, mediaType: "video", muxAssetId: `upl${P}st`, videoFit: "fill" } });
    const storyId = r.body?.id;
    assert(r.status === 201 && r.body?.videoFit === "fill", "video story with videoFit 'fill' → saved", { status: r.status, body: r.body });
    r = await call("POST", "/api/stories", { body: { mediaUrl: "https://r2.test.example/st.jpg", mediaType: "image", videoFit: "fit" } });
    assert(r.status === 201 && r.body?.videoFit === null, "photo story with videoFit → NULL", { status: r.status, v: r.body?.videoFit });
    r = await call("POST", "/api/stories", { body: { mediaUrl: `upl${P}st2`, mediaType: "video", muxAssetId: `upl${P}st2` } });
    assert(r.status === 201 && r.body?.videoFit === null, "video story without videoFit (older apps) → NULL", { status: r.status });
    r = await call("POST", "/api/stories", { body: { mediaUrl: `upl${P}st3`, mediaType: "video", videoFit: "zoom" } });
    assert(r.status === 400, "story videoFit 'zoom' → 400", { status: r.status });

    r = await call("POST", "/api/stories/highlights", { body: { storyId, mediaUrl: `upl${P}st`, mediaType: "video" } });
    assert(r.status === 201 && r.body?.video_fit === "fill", "highlight copies video_fit from the story", { status: r.status, body: r.body });
    r = await call("GET", "/api/stories/highlights");
    const hl = (Array.isArray(r.body) ? r.body : r.body?.highlights ?? []).find((h: any) => h.story_id === storyId);
    assert(r.status === 200 && hl?.video_fit === "fill", "GET /api/stories/highlights → video_fit", { status: r.status, hl });
  } finally {
    await q(`DELETE FROM story_highlights WHERE user_id = $1`, [id("author")]);
    await q(`DELETE FROM story_views WHERE story_id IN (SELECT id FROM stories WHERE author_id = $1)`, [id("author")]);
    await q(`DELETE FROM stories WHERE author_id = $1`, [id("author")]);
    await q(`DELETE FROM user_saved_posts WHERE user_id = $1`, [id("author")]);
    await q(`DELETE FROM feed_posts WHERE author_id = $1`, [id("author")]);
    await q(`DELETE FROM users WHERE id = $1`, [id("author")]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
