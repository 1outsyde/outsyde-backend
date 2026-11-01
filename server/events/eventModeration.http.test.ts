/**
 * Events Phase 5, p5-safety (Legend's calls T1 to T11, 2026-11-01; audit https://claude.ai/artifact/VPB4BzbgFY7FPcFL22KweU).
 *
 *   T1 to T4  POST /api/events/:id/report: signed in only, six reasons (something else needs a note, notes up to 500),
 *             once per person per event, never the host, co-hosts or the event's team; saved in moderation_queue
 *             (target_type 'event', one row per reporter). Admin email on the first report and at 3 reporters.
 *             Nothing pauses on its own.
 *   T5 to T7  First event limits: personal (user) hosts until their first paid event's payout was paid with no lost
 *             dispute; approved business and photographer hosts exempt; a trusted host switch lifts them. At most
 *             100 paid tickets per event and $100 per ticket; free RSVPs never limited. Checked when a ticket type
 *             is added or changed and on publish (409 NEW_HOST_LIMIT).
 *   T8        Admin (goutsyde.com/admin/events): GET /reports (events and posts), POST /:id/pause, /:id/release,
 *             /:id/cancel (refund everyone, also after the start), /:id/reports/dismiss, /hosts/:userId/trust.
 *             Reason required; every action writes audit_logs; pause, cancel and dismiss close the pending reports.
 *   T9        Host email and push on pause, release and cancel, in Legend's approved wording, with the reason.
 *   T10       A paused event's page: ticket holders and the host see it with onHold true; everyone else gets 404.
 *   T11       POST /api/feed/:postId/report (the app's Report post) works and lands in the same queue.
 *
 * Run in process (local Postgres with every migration incl. 095, neon local proxy on 4444):
 *   EV_TEST_PG_URL=<local> DATABASE_URL=<local> STRIPE_STUB_PORT=<free port> STRIPE_SECRET_KEY=sk_test_stub_only JWT_SECRET=local_test_only
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" npx tsx server/events/eventModeration.http.test.ts
 * SCRATCH ONLY: refuses any non-local database or non sk_test_ key. Nothing reaches real Stripe, Resend or Expo.
 */
import http from "http";

const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.STRIPE_STUB_PORT || "0");
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

function callAt(base: string, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set EV_TEST_PG_URL (+ DATABASE_URL via the shim) to run"); process.exit(0); }
  if (!isLocal(PG_URL)) throw new Error("refusing to run: PG_URL must be localhost");
  if (!process.env.DATABASE_URL || !isLocal(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, "http:"))) throw new Error("refusing to run: DATABASE_URL must be local");
  if (!STUB_PORT) throw new Error("refusing to run: set STRIPE_STUB_PORT and preload ./.dev/stripe-stub-preload.mjs");
  if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) throw new Error("refusing to run: STRIPE_SECRET_KEY must be a sk_test_ stub key");
  process.env.STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_stub_only";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  process.env.PAID_EVENTS_ENABLED = "true";
  process.env.FRONTEND_URL = "https://goutsyde.test";

  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // Stripe stub: connected accounts are ready (publish's live check); anything else fails (refunds retry later).
  const stripeCalls: string[] = [];
  const stub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      stripeCalls.push(`${req.method} ${req.url}`);
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const pi = u.pathname.match(/^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/);
      res.writeHead(u.pathname.startsWith("/v1/accounts/") || pi ? 200 : 500, { "content-type": "application/json" });
      if (u.pathname.startsWith("/v1/accounts/")) res.end(JSON.stringify({ id: u.pathname.split("/").pop(), object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true }));
      else if (pi) res.end(JSON.stringify({ id: pi[1], object: "payment_intent", status: pi[2] ? "canceled" : "requires_payment_method", client_secret: `${pi[1]}_secret`, amount: 2000, amount_received: 0, customer: null }));
      else res.end(JSON.stringify({ error: { type: "api_error", message: "stub: not used here" } }));
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const { generateAccessToken } = await import("../auth");
  const notices = await import("./ticketNotices");
  const pushes: any[] = [];
  const moderationEmails: any[] = [];
  notices.setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; }, createActivity: async () => {}, sendDoorInvite: async () => {},
    sendOwedReminder: async () => {}, sendTeamSetupReminder: async () => {},
    sendModeration: async (p: any) => { moderationEmails.push(p); },
  } as any);
  const mod: any = await import("./eventModeration"); // fails on main: the module is part of the build
  const alerts: { subject: string; detail: string }[] = [];
  mod.setModerationAlertForTest(async (subject: string, detail: string) => { alerts.push({ subject, detail }); });
  (await import("./ticketCheckout")).setAdminAlertForTest(async () => {});
  const { HOST_AGREEMENT_VERSION } = await import("./hostAgreement");

  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/admin/events", (await import("./adminEventsRouter")).adminEventsRouter);
  app.use("/api/events", (await import("./eventsRouter")).default);
  app.use("/api/events", (await import("./ticketsRouter")).default);
  app.use("/api/events", (await import("./ticketCheckout")).default);
  app.use("/api/events", mod.eventReportsRouter);
  app.use("/api/feed", mod.postReportsRouter);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `md${Date.now().toString(36)}`;
  let seq = 0;
  const allEvents: string[] = [];
  const allUsers: string[] = [];
  const mkUser = async (s: string) => {
    const n = ++seq;
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}-${n}@test.local`, `Person ${s}`, `First${s}`, `${P}${s}${n}`.slice(0, 24)],
    ))[0].id as string;
    allUsers.push(id);
    return { id, token: generateAccessToken({ userId: id, isVendor: false }) };
  };
  // Admin: platform admin rule = is_admin AND an allowed email. Reuse the local one if a suite made it, else make it (removed after).
  let adminCreated = false;
  let [adminRow] = await q(`SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com'`);
  if (!adminRow) {
    adminRow = (await q(`INSERT INTO users (id, email, name, first_name, username, is_active, is_admin) VALUES (gen_random_uuid(), 'info@goutsyde.com', 'Admin', 'Admin', $1, true, true) RETURNING id`, [`${P}admin`]))[0];
    adminCreated = true;
  } else await q(`UPDATE users SET is_admin = true WHERE id = $1`, [adminRow.id]);
  const admin = { id: adminRow.id as string, token: generateAccessToken({ userId: adminRow.id, isVendor: false, isAdmin: true } as any) };

  /** Event straight in the DB. Defaults: personal host, published, starts in 10 days. */
  const mkEvent = async (host: { id: string }, slug: string, o: { status?: string; startsIn?: string; hostType?: string; businessId?: string | null } = {}) => {
    const e = (await q(
      `INSERT INTO events (host_user_id, host_type, host_business_id, slug, title, status, starts_at, ends_at, timezone, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + $7::interval, now() + $7::interval + interval '4 hours', 'America/New_York',
               CASE WHEN $6 = 'draft' THEN NULL ELSE now() - interval '1 day' END)
       RETURNING id, slug`,
      [host.id, o.hostType ?? "user", o.businessId ?? null, `${P}-${slug}`, `${P} ${slug}`, o.status ?? "published", o.startsIn ?? "10 days"],
    ))[0] as { id: string; slug: string };
    allEvents.push(e.id);
    return e;
  };
  const mkType = async (eventId: string, priceCents: number, quantity: number) => (await q(
    `INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'GA', $2, $3, 1, 10) RETURNING id`, [eventId, priceCents, quantity],
  ))[0].id as string;
  /** Completed order with valid tickets (paid when priceCents > 0). */
  const mkOrder = async (eventId: string, typeId: string, buyer: string, priceCents: number, count = 1) => {
    const sub = priceCents * count, plat = Math.round(priceCents * 0.02) * count;
    const oid = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, platform_fee_cents, host_net_cents, total_cents, completed_at, paid_at, stripe_payment_intent_id)
       VALUES ($1, $2, 'completed', $3, $4, $5, $6, $4, now() - interval '2 days', now() - interval '2 days', $7) RETURNING id`,
      [eventId, buyer, count, sub, plat, sub - plat, priceCents > 0 ? `pi_${P}_${++seq}` : null],
    ))[0].id as string;
    const iid = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'issued', now() + interval '1 day') RETURNING id`, [oid, eventId, typeId, buyer, count, priceCents],
    ))[0].id as string;
    for (let i = 1; i <= count; i++) {
      await q(
        `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid', $8, 0, 0, $9, $10)`,
        [oid, iid, eventId, typeId, buyer, i, `${P}${Math.random().toString(36).slice(2, 12)}`, priceCents, Math.round(priceCents * 0.02), priceCents - Math.round(priceCents * 0.02)],
      );
    }
    return oid;
  };
  /** An open checkout: pending order with a held item and the type's hold counted. */
  const mkPending = async (eventId: string, typeId: string, buyer: string, key: string, pi: string) => {
    const oid = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, platform_fee_cents, host_net_cents, total_cents, expires_at, stripe_payment_intent_id, idempotency_key)
       VALUES ($1, $2, 'pending', 1, 2000, 40, 1960, 2000, now() + interval '10 minutes', $3, $4) RETURNING id`, [eventId, buyer, pi, key],
    ))[0].id as string;
    await q(`INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
             VALUES ($1, $2, $3, $4, 1, 2000, 'held', now() + interval '10 minutes')`, [oid, eventId, typeId, buyer]);
    await q(`UPDATE ticket_types SET reserved_count = reserved_count + 1 WHERE id = $1`, [typeId]);
    await q(`UPDATE events SET reserved_count = reserved_count + 1 WHERE id = $1`, [eventId]);
    await q(`INSERT INTO ticket_account_counts (ticket_type_id, user_id, count) VALUES ($1, $2, 1)
             ON CONFLICT (ticket_type_id, user_id) DO UPDATE SET count = ticket_account_counts.count + 1`, [typeId, buyer]);
    return oid;
  };
  const reportRows = (eventId: string) => q(`SELECT reporter_id, reason, details, status, admin_action FROM moderation_queue WHERE target_type = 'event' AND target_id = $1 ORDER BY created_at`, [eventId]);
  const auditFor = (targetId: string) => q(`SELECT action, target_type, metadata FROM audit_logs WHERE target_id = $1 ORDER BY created_at`, [targetId]);
  const eventStatus = async (id: string) => (await q(`SELECT status FROM events WHERE id = $1`, [id]))[0]?.status;
  const alertsAbout = (needle: string) => alerts.filter((a) => `${a.subject} ${a.detail}`.includes(needle));

  try {
    // ════ T1 to T4: report an event ════
    console.log("\nT1 to T4: report an event");
    const host = await mkUser("host");
    const ev = await mkEvent(host, "reported");
    const r1 = await mkUser("r1"); const r2 = await mkUser("r2"); const r3 = await mkUser("r3");
    {
      let r = await call("POST", `/api/events/${ev.id}/report`, { token: r1.token, body: { reason: "scam" } });
      assert(r.status === 200 && r.body?.success === true && r.body?.alreadyReported === false, "signed in person can report a live event", r);
      let rows = await reportRows(ev.id);
      assert(rows.length === 1 && rows[0].reporter_id === r1.id && rows[0].reason === "scam" && rows[0].status === "pending", "saved in the report queue as an event report, one row per reporter", rows);
      assert(alertsAbout(ev.id).length === 1, "admin emailed on the event's first report", alertsAbout(ev.id));
      r = await call("POST", `/api/events/${ev.id}/report`, { token: r1.token, body: { reason: "illegal" } });
      assert(r.status === 200 && r.body?.alreadyReported === true && (await reportRows(ev.id)).length === 1 && alertsAbout(ev.id).length === 1,
        "same person again: accepted, not counted twice, no email", { r, n: (await reportRows(ev.id)).length });
      r = await call("POST", `/api/events/${ev.id}/report`, { token: r2.token, body: { reason: "other", note: "  Venue says this party is not happening.  " } });
      rows = await reportRows(ev.id);
      assert(r.status === 200 && rows.length === 2 && rows[1].details === "Venue says this party is not happening." && alertsAbout(ev.id).length === 1,
        "second reporter: saved with the note (trimmed), no email", { r, rows });
      r = await call("POST", `/api/events/${ev.id}/report`, { token: r3.token, body: { reason: "hate" } });
      assert(r.status === 200 && alertsAbout(ev.id).length === 2, "third reporter: admin emailed again", alertsAbout(ev.id).map((a) => a.subject));
      assert((await eventStatus(ev.id)) === "published", "reports never pause the event on their own", await eventStatus(ev.id));
    }
    {
      const r = await call("POST", `/api/events/${ev.id}/report`, { body: { reason: "scam" } });
      assert(r.status === 401, "signed out: 401", r.status);
      const bad = await mkUser("bad");
      const a = await call("POST", `/api/events/${ev.id}/report`, { token: bad.token, body: { reason: "boring" } });
      const b = await call("POST", `/api/events/${ev.id}/report`, { token: bad.token, body: { reason: "other" } });
      const c = await call("POST", `/api/events/${ev.id}/report`, { token: bad.token, body: { reason: "other", note: "x".repeat(501) } });
      assert(a.status === 400 && b.status === 400 && c.status === 400, "unknown reason, something else without a note, note over 500: 400", [a.status, b.status, c.status]);
      const own = await call("POST", `/api/events/${ev.id}/report`, { token: host.token, body: { reason: "scam" } });
      assert(own.status === 403, "the host can't report their own event", own);
      const co = await mkUser("cohost");
      await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, invited_at, accepted_at) VALUES ($1, $2, $3, 'cohost', now(), now())`, [ev.id, co.id, host.id]);
      const team = await mkUser("door");
      await q(`INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id, role, invited_at, accepted_at) VALUES ($1, $2, $1, 'door', now(), now())`, [host.id, team.id]);
      const x = await call("POST", `/api/events/${ev.id}/report`, { token: co.token, body: { reason: "scam" } });
      const y = await call("POST", `/api/events/${ev.id}/report`, { token: team.token, body: { reason: "scam" } });
      assert(x.status === 403 && y.status === 403, "co-hosts and the host's team can't report it", [x.status, y.status]);
      const draft = await mkEvent(host, "draft", { status: "draft" });
      const d = await call("POST", `/api/events/${draft.id}/report`, { token: bad.token, body: { reason: "scam" } });
      const nf = await call("POST", `/api/events/nope-${P}/report`, { token: bad.token, body: { reason: "scam" } });
      assert(d.status === 404 && nf.status === 404, "drafts and unknown events: 404", [d.status, nf.status]);
      const gone = await mkUser("gone");
      await q(`UPDATE users SET is_active = false WHERE id = $1`, [gone.id]);
      const g = await call("POST", `/api/events/${ev.id}/report`, { token: gone.token, body: { reason: "scam" } });
      const gp = await call("POST", `/api/feed/nope-${P}/report`, { token: gone.token, body: { reason: "x" } });
      assert(g.status === 403 && gp.status === 403 && (await reportRows(ev.id)).length === 3, "deactivated account: can't report an event or a post", [g.status, gp.status]);
    }

    // ════ T11: report a post ════
    console.log("\nT11: report a post (the app's Report post button)");
    {
      const author = await mkUser("author");
      const [post] = await q(`INSERT INTO feed_posts (author_id, author_type, post_type, post_intent, content, is_active) VALUES ($1, 'user', 'photo', 'share', 'hello', true) RETURNING id`, [author.id]);
      const rep = await mkUser("postrep");
      let r = await call("POST", `/api/feed/${post.id}/report`, { token: rep.token, body: { reason: "Spam" } });
      const rows = await q(`SELECT reporter_id, reason, status FROM moderation_queue WHERE target_type = 'post' AND target_id = $1`, [post.id]);
      assert(r.status === 200 && r.body?.success === true && rows.length === 1 && rows[0].reporter_id === rep.id && rows[0].reason === "Spam", "report post works and is saved in the queue", { r, rows });
      r = await call("POST", `/api/feed/${post.id}/report`, { token: rep.token, body: { reason: "Spam again" } });
      assert(r.status === 200 && (await q(`SELECT 1 FROM moderation_queue WHERE target_type = 'post' AND target_id = $1`, [post.id])).length === 1, "same person twice: one row", r);
      const own = await call("POST", `/api/feed/${post.id}/report`, { token: author.token, body: { reason: "x" } });
      const nf = await call("POST", `/api/feed/nope-${P}/report`, { token: rep.token, body: { reason: "x" } });
      const out = await call("POST", `/api/feed/${post.id}/report`, { body: { reason: "x" } });
      const empty = await call("POST", `/api/feed/${post.id}/report`, { token: (await mkUser("p2")).token, body: { reason: "  " } });
      assert(own.status === 400 && nf.status === 404 && out.status === 401 && empty.status === 400, "own post 400, unknown post 404, signed out 401, empty reason 400", [own.status, nf.status, out.status, empty.status]);
      const list = await call("GET", "/api/admin/events/reports?type=post", { token: admin.token });
      const item = list.body?.items?.find((i: any) => i.postId === post.id);
      assert(list.status === 200 && item && item.reportCount === 1 && item.reasons?.[0]?.reason === "Spam", "post reports listed for the admin", { status: list.status, item });
    }

    // ════ T5 to T7: first event limits ════
    console.log("\nT5 to T7: first event limits");
    const newHost = await mkUser("newhost");
    const lim = await mkEvent(newHost, "limits", { status: "draft" });
    {
      const over = await call("POST", `/api/events/${lim.id}/ticket-types`, { token: newHost.token, body: { name: "GA", priceCents: 2000, quantity: 101 } });
      assert(over.status === 409 && over.body?.error?.code === "NEW_HOST_LIMIT" && /100 paid tickets/.test(over.body?.error?.message ?? "") && !/[–—]/.test(over.body?.error?.message ?? ""),
        "new host: 101 paid tickets refused with a plain message", over.body);
      const ok = await call("POST", `/api/events/${lim.id}/ticket-types`, { token: newHost.token, body: { name: "GA", priceCents: 10000, quantity: 100 } });
      assert(ok.status === 201, "100 paid tickets at $100: allowed", ok.status);
      const more = await call("POST", `/api/events/${lim.id}/ticket-types`, { token: newHost.token, body: { name: "VIP", priceCents: 500, quantity: 1 } });
      assert(more.status === 409 && more.body?.error?.code === "NEW_HOST_LIMIT", "a second paid type over 100 in total: refused", more.status);
      const pricey = await call("POST", `/api/events/${lim.id}/ticket-types`, { token: newHost.token, body: { name: "VIP", priceCents: 10100, quantity: 1 } });
      assert(pricey.status === 409 && pricey.body?.error?.code === "NEW_HOST_LIMIT", "a ticket over $100: refused", pricey.status);
      const free = await call("POST", `/api/events/${lim.id}/ticket-types`, { token: newHost.token, body: { name: "RSVP", priceCents: 0, quantity: 500 } });
      assert(free.status === 201, "free RSVPs: no limit", free.status);
      const up = await call("PATCH", `/api/events/${lim.id}/ticket-types/${ok.body.ticketType.id}`, { token: newHost.token, body: { quantity: 150 } });
      assert(up.status === 409 && up.body?.error?.code === "NEW_HOST_LIMIT", "raising a paid type past 100: refused", up.status);
      const down = await call("PATCH", `/api/events/${lim.id}/ticket-types/${ok.body.ticketType.id}`, { token: newHost.token, body: { quantity: 80 } });
      assert(down.status === 200, "lowering it: allowed", down.status);
      const freeUp = await call("PATCH", `/api/events/${lim.id}/ticket-types/${free.body.ticketType.id}`, { token: newHost.token, body: { quantity: 2000 } });
      assert(freeUp.status === 200, "raising the free type: allowed", freeUp.status);
      // Removing a sold type keeps its sold tickets in the count (it is archived, its tickets stay valid).
      await q(`UPDATE ticket_types SET reserved_count = 80 WHERE id = $1`, [ok.body.ticketType.id]);
      const del = await call("DELETE", `/api/events/${lim.id}/ticket-types/${ok.body.ticketType.id}`, { token: newHost.token });
      assert(del.status === 200 && del.body?.removed === "archived", "removing the sold type archives it", del.body);
      const again = await call("POST", `/api/events/${lim.id}/ticket-types`, { token: newHost.token, body: { name: "GA 2", priceCents: 2000, quantity: 30 } });
      assert(again.status === 409 && again.body?.error?.code === "NEW_HOST_LIMIT", "80 sold on a removed type + 30 new: refused (no way past the limit by removing types)", again.status);
      const fits = await call("POST", `/api/events/${lim.id}/ticket-types`, { token: newHost.token, body: { name: "GA 2", priceCents: 2000, quantity: 20 } });
      assert(fits.status === 201, "80 sold + 20 new: allowed", fits.status);
      const grow = await call("PATCH", `/api/events/${lim.id}/ticket-types/${fits.body.ticketType.id}`, { token: newHost.token, body: { quantity: 21 } });
      assert(grow.status === 409 && grow.body?.error?.code === "NEW_HOST_LIMIT", "then raising the new type to 21: refused", grow.status);
      const rename = await call("PATCH", `/api/events/${lim.id}/ticket-types/${fits.body.ticketType.id}`, { token: newHost.token, body: { name: "General" } });
      assert(rename.status === 200, "renaming a paid type at the limit: allowed", rename.status);
    }
    {
      // Publish: everything else in place (agreement, payout setup, paid tickets on), limits decide.
      await q(`INSERT INTO host_agreement_acceptances (user_id, version) VALUES ($1, $2)`, [newHost.id, HOST_AGREEMENT_VERSION]);
      await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [newHost.id, `acct_${P}_new`]);
      const pub = await mkEvent(newHost, "pub-over", { status: "draft" });
      await mkType(pub.id, 2000, 150); // over the limit (written straight to the DB, as an older draft could be)
      let r = await call("POST", `/api/events/${pub.id}/publish`, { token: newHost.token });
      assert(r.status === 409 && r.body?.error?.code === "NEW_HOST_LIMIT" && (await eventStatus(pub.id)) === "draft", "publish over the limit: refused, still a draft", r.body);
      r = await call("POST", `/api/events/${lim.id}/publish`, { token: newHost.token });
      assert(r.status === 200 && (await eventStatus(lim.id)) === "published", "publish within the limit: live", r.body);
    }
    {
      // Exempt: approved business hosts.
      const owner = await mkUser("owner");
      const [biz] = await q(`INSERT INTO businesses (owner_id, name, category, approval_status) VALUES ($1, $2, 'Beauty', 'approved') RETURNING id`, [owner.id, `${P} Biz`]);
      const be = await mkEvent(owner, "biz", { status: "draft", hostType: "business", businessId: biz.id });
      const r = await call("POST", `/api/events/${be.id}/ticket-types`, { token: owner.token, body: { name: "GA", priceCents: 25000, quantity: 500 } });
      assert(r.status === 201, "approved business host: no limit", r.body);
    }
    {
      // Lifted after the first paid payout with no lost dispute; not when a dispute on it was lost.
      const seasoned = await mkUser("seasoned");
      const past = await mkEvent(seasoned, "past", { startsIn: "-10 days" });
      await q(`INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, team_cents, amount_cents, status, transfer_id, paid_at)
               VALUES ($1, 'user', $2, 1960, 0, 0, 1960, 'paid', $3, now() - interval '3 days')`, [past.id, `acct_${P}_s`, `tr_${P}_s`]);
      const next = await mkEvent(seasoned, "next", { status: "draft" });
      let r = await call("POST", `/api/events/${next.id}/ticket-types`, { token: seasoned.token, body: { name: "GA", priceCents: 30000, quantity: 400 } });
      assert(r.status === 201, "host whose first paid payout went out: no limit", r.body);

      const burned = await mkUser("burned");
      const past2 = await mkEvent(burned, "past2", { startsIn: "-10 days" });
      const t2 = await mkType(past2.id, 2000, 10);
      const o2 = await mkOrder(past2.id, t2, (await mkUser("buyer2")).id, 2000);
      await q(`INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, team_cents, amount_cents, status, transfer_id, paid_at)
               VALUES ($1, 'user', $2, 1960, 0, 0, 1960, 'paid', $3, now() - interval '3 days')`, [past2.id, `acct_${P}_b`, `tr_${P}_b`]);
      await q(`INSERT INTO stripe_disputes (dispute_id, kind, reference_id, amount_cents, status, outcome, closed_at) VALUES ($1, 'ticket_order', $2, 2000, 'lost', 'lost', now())`, [`dp_${P}_b`, o2]);
      const next2 = await mkEvent(burned, "next2", { status: "draft" });
      r = await call("POST", `/api/events/${next2.id}/ticket-types`, { token: burned.token, body: { name: "GA", priceCents: 2000, quantity: 101 } });
      assert(r.status === 409 && r.body?.error?.code === "NEW_HOST_LIMIT", "payout went out but a dispute on it was lost: still limited", r.status);

      // T7 trusted host switch
      let t = await call("POST", `/api/admin/events/hosts/${burned.id}/trust`, { token: admin.token, body: { trusted: true, note: "Known promoter" } });
      assert(t.status === 200 && t.body?.trusted === true, "admin marks the host trusted", t.body);
      r = await call("POST", `/api/events/${next2.id}/ticket-types`, { token: burned.token, body: { name: "GA", priceCents: 2000, quantity: 101 } });
      assert(r.status === 201, "trusted host: no limit", r.status);
      const aud = await auditFor(burned.id);
      assert(aud.some((a: any) => a.action === "event_host.trust" && a.target_type === "user"), "trust saved in the audit log", aud);
      const det = await call("GET", `/api/admin/events/${next2.id}`, { token: admin.token });
      assert(det.status === 200 && det.body?.moderation?.hostTrusted === true && det.body?.moderation?.hostLimited === false, "event detail shows the host trusted and not limited", det.body?.moderation);
      t = await call("POST", `/api/admin/events/hosts/${burned.id}/trust`, { token: admin.token, body: { trusted: false } });
      const det2 = await call("GET", `/api/admin/events/${next2.id}`, { token: admin.token });
      assert(t.status === 200 && det2.body?.moderation?.hostTrusted === false && det2.body?.moderation?.hostLimited === true, "switch off: limited again", det2.body?.moderation);
      const bad = await call("POST", `/api/admin/events/hosts/nope-${P}/trust`, { token: admin.token, body: { trusted: true } });
      assert(bad.status === 404, "unknown host: 404", bad.status);
    }

    // ════ T8 to T10: admin actions ════
    console.log("\nT8 to T10: admin actions, host notices, paused page");
    {
      const list = await call("GET", "/api/admin/events/reports?type=event", { token: admin.token });
      const item = list.body?.items?.find((i: any) => i.eventId === ev.id);
      assert(list.status === 200 && item && item.reportCount === 3 && item.reasons.length === 3 && item.status === "published" && item.reasons.some((x: any) => x.note === "Venue says this party is not happening."),
        "reported event listed with count, reasons and notes", item);
      const notAdmin = await call("GET", "/api/admin/events/reports?type=event", { token: r1.token });
      assert(notAdmin.status === 403 || notAdmin.status === 401, "not an admin: refused", notAdmin.status);

      const holder = await mkUser("holder");
      const tt = await mkType(ev.id, 0, 50);
      await mkOrder(ev.id, tt, holder.id, 0);
      const stranger = await mkUser("stranger");

      const noReason = await call("POST", `/api/admin/events/${ev.id}/pause`, { token: admin.token, body: {} });
      assert(noReason.status === 400, "pause needs a reason", noReason.status);
      const paidT = await mkType(ev.id, 2000, 10);
      const buyerA = await mkUser("buyA");
      const pendA = await mkPending(ev.id, paidT, buyerA.id, `key_${P}_a`, `pi_${P}_a`);
      moderationEmails.length = 0; pushes.length = 0;
      let r = await call("POST", `/api/admin/events/${ev.id}/pause`, { token: admin.token, body: { reason: "Several reports of a fake venue" } });
      assert(r.status === 200 && (await eventStatus(ev.id)) === "paused", "pause: event paused", r.body);
      const rows = await reportRows(ev.id);
      assert(rows.every((x: any) => x.status === "reviewed" && x.admin_action === "pause"), "pause closes its pending reports", rows);
      const aud = await auditFor(ev.id);
      assert(aud.some((a: any) => a.action === "event.pause" && a.metadata?.reason === "Several reports of a fake venue"), "pause saved in the audit log with the reason", aud);
      const em = moderationEmails.find((m) => m.kind === "pause");
      assert(!!em && em.eventTitle === `${P} reported` && em.reason === "Several reports of a fake venue" && em.toEmail?.includes(`${P}-host`), "host emailed with the reason", moderationEmails);
      const pu = pushes.find((p) => p.userId === host.id && p.title === "Your event is on hold");
      assert(!!pu && /Check your email for details\.$/.test(pu.body) && pu.data?.type === "event_moderation", "host pushed: Your event is on hold", pushes);
      const again = await call("POST", `/api/admin/events/${ev.id}/pause`, { token: admin.token, body: { reason: "again" } });
      assert(again.status === 409, "pausing a paused event: 409", again.status);
      await new Promise((res) => setTimeout(res, 400));
      const oa = (await q(`SELECT status FROM ticket_orders WHERE id = $1`, [pendA]))[0];
      const ta = (await q(`SELECT reserved_count FROM ticket_types WHERE id = $1`, [paidT]))[0];
      assert(oa.status === "cancelled" && Number(ta.reserved_count) === 0 && stripeCalls.some((c) => c.startsWith(`POST /v1/payment_intents/pi_${P}_a/cancel`)),
        "pause closes open checkouts: payment cancelled, hold released", { oa, ta, calls: stripeCalls.filter((c) => c.includes("payment_intents")) });
      // A checkout that opened as the pause landed: asking for it again doesn't hand back the payment.
      const buyerB = await mkUser("buyB");
      await mkPending(ev.id, paidT, buyerB.id, `key_${P}_b`, `pi_${P}_b`);
      const rb = await call("POST", `/api/events/${ev.id}/checkout`, { token: buyerB.token, body: { ticketTypeId: paidT, quantity: 1, idempotencyKey: `key_${P}_b` } });
      assert(rb.status === 409 && rb.body?.error?.code === "CHECKOUT_CLOSED" && !rb.body?.clientSecret, "paused: a repeated checkout request is refused", rb.body);

      // T10
      const s = await call("GET", `/api/events/slug/${ev.slug}`, { token: stranger.token });
      const h = await call("GET", `/api/events/slug/${ev.slug}`, { token: holder.token });
      const o = await call("GET", `/api/events/slug/${ev.slug}`, { token: host.token });
      const anon = await call("GET", `/api/events/slug/${ev.slug}`);
      assert(s.status === 404 && anon.status === 404, "paused: strangers and signed out visitors get not found", [s.status, anon.status]);
      assert(h.status === 200 && h.body?.event?.onHold === true && o.status === 200 && o.body?.event?.onHold === true, "paused: ticket holder and host see it on hold", [h.status, h.body?.event?.onHold, o.status, o.body?.event?.onHold]);

      moderationEmails.length = 0; pushes.length = 0;
      r = await call("POST", `/api/admin/events/${ev.id}/release`, { token: admin.token, body: { reason: "Venue confirmed the booking" } });
      assert(r.status === 200 && (await eventStatus(ev.id)) === "published", "release: live again", r.body);
      assert(moderationEmails.some((m) => m.kind === "release" && m.reason === "Venue confirmed the booking") && pushes.some((p) => p.userId === host.id && p.title === "Your event is live again"),
        "host told it is live again", { moderationEmails, pushes });
      const s2 = await call("GET", `/api/events/slug/${ev.slug}`, { token: stranger.token });
      assert(s2.status === 200 && s2.body?.event?.onHold === false, "released: visible again, not on hold", [s2.status, s2.body?.event?.onHold]);
      assert((await auditFor(ev.id)).some((a: any) => a.action === "event.release"), "release in the audit log", null);

      // dismiss
      const r4 = await mkUser("r4");
      await call("POST", `/api/events/${ev.id}/report`, { token: r4.token, body: { reason: "wrong_details" } });
      r = await call("POST", `/api/admin/events/${ev.id}/reports/dismiss`, { token: admin.token, body: { reason: "Details are right" } });
      const after = await call("GET", "/api/admin/events/reports?type=event", { token: admin.token });
      assert(r.status === 200 && r.body?.dismissed === 1 && !after.body?.items?.some((i: any) => i.eventId === ev.id) && (await eventStatus(ev.id)) === "published",
        "dismiss: report closed, event untouched, gone from the list", { r: r.body, still: after.body?.items?.some((i: any) => i.eventId === ev.id) });
      assert((await auditFor(ev.id)).some((a: any) => a.action === "event.reports_dismissed"), "dismiss in the audit log", null);
    }
    {
      // Cancel and refund everyone, also after the event started (hosts can't do that themselves)
      const h2 = await mkUser("h2");
      const live = await mkEvent(h2, "started", { startsIn: "-1 hour" });
      const paidType = await mkType(live.id, 2000, 50);
      const freeType = await mkType(live.id, 0, 50);
      const paidOrder = await mkOrder(live.id, paidType, (await mkUser("pb")).id, 2000, 2);
      const freeOrder = await mkOrder(live.id, freeType, (await mkUser("fb")).id, 0);
      moderationEmails.length = 0; pushes.length = 0;
      const r = await call("POST", `/api/admin/events/${live.id}/cancel`, { token: admin.token, body: { reason: "Event was a scam" } });
      assert(r.status === 200 && (await eventStatus(live.id)) === "cancelled", "admin cancel after the start: cancelled", r.body);
      const po = (await q(`SELECT status, refund_reason, refund_amount_cents FROM ticket_orders WHERE id = $1`, [paidOrder]))[0];
      const fo = (await q(`SELECT status FROM ticket_orders WHERE id = $1`, [freeOrder]))[0];
      assert(["refunding", "refunded"].includes(po.status) && po.refund_reason === "event_cancelled" && fo.status === "cancelled", "paid order refunded in full, free RSVP cancelled", { po, fo });
      assert(moderationEmails.some((m) => m.kind === "cancel" && m.reason === "Event was a scam") && pushes.some((p) => p.userId === h2.id && p.title === "Your event was cancelled"),
        "host told it was cancelled", { moderationEmails, pushes });
      assert((await auditFor(live.id)).some((a: any) => a.action === "event.cancel" && a.metadata?.reason === "Event was a scam"), "cancel in the audit log with the reason", null);
      const cr = (await q(`SELECT cancel_reason FROM events WHERE id = $1`, [live.id]))[0];
      assert(cr.cancel_reason === null, "guests never see the admin's reason (their emails show cancel_reason as a message from the host)", cr);
      const again = await call("POST", `/api/admin/events/${live.id}/cancel`, { token: admin.token, body: { reason: "x" } });
      const rel = await call("POST", `/api/admin/events/${live.id}/release`, { token: admin.token, body: { reason: "x" } });
      assert(again.status === 409 && rel.status === 409, "cancelled: can't cancel again or release", [again.status, rel.status]);
      const nf = await call("POST", `/api/admin/events/nope-${P}/pause`, { token: admin.token, body: { reason: "x" } });
      assert(nf.status === 404, "unknown event: 404", nf.status);
    }
    {
      // The approved copy, rendered (no dashes, no fee percentages)
      const { renderEventModerationEmail } = await import("../emailService") as any;
      const kinds = ["pause", "release", "cancel"] as const;
      const out = kinds.map((k) => renderEventModerationEmail({ userId: "u", toEmail: "a@b.test", firstName: "Dana", kind: k, eventTitle: "Rooftop <Party>", reason: "Because & so" }));
      assert(out[0].subject === "Your event is on hold" && out[1].subject === "Your event is live again" && out[2].subject === "Outsyde cancelled your event", "subjects as approved", out.map((o: any) => o.subject));
      assert(out[0].html.includes("we've put Rooftop &lt;Party&gt; on hold while we review it") && out[0].html.includes("Reason: Because &amp; so") && out[0].html.includes("Guests keep their tickets."),
        "pause email: approved sentences, escaped", out[0].html.slice(0, 400));
      assert(out[2].html.includes("Every guest is refunded in full and gets an email about it.") && out[2].html.includes("Host Agreement"), "cancel email: approved sentences", null);
      // What the host reads (tags and styling removed): no dashes, no percentages.
      const visible = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
      assert(out.every((o: any) => !/[–—]/.test(visible(o.html) + o.subject) && !/%/.test(visible(o.html) + o.subject)), "no dashes, no percentages in what the host reads", out.map((o: any) => visible(o.html).replace(/\s+/g, " ").slice(0, 300)));
    }
  } finally {
    await q(`UPDATE events SET status = 'draft' WHERE id = ANY($1::varchar[])`, [allEvents]).catch(() => {});
    await q(`DELETE FROM moderation_queue WHERE target_id = ANY($1::varchar[]) OR reporter_id = ANY($2::varchar[])`, [allEvents, allUsers]).catch(() => {});
    await q(`DELETE FROM event_host_trust WHERE user_id = ANY($1::varchar[])`, [allUsers]).catch(() => {});
    if (adminCreated) {
      await q(`DELETE FROM audit_logs WHERE actor_id = $1`, [admin.id]).catch(() => {});
      await q(`DELETE FROM users WHERE id = $1`, [admin.id]).catch(() => {});
    }
    mod.setModerationAlertForTest?.(null);
    notices.setNoticeDepsForTest(null);
    await db.end().catch(() => {});
    srv.close(); stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
