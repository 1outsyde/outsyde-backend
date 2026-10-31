/**
 * Events & Ticketing: event reminder pushes (runEventReminderJob, Events canvas screen 36).
 *
 * Run with: npx tsx server/events/eventReminders.http.test.ts
 * SCRATCH ONLY. Needs local Postgres with migrations 056 and 074, plus DATABASE_URL + the neon preload (the job runs in
 * this process): EV_TEST_BASE_URL (only used as the "is this the local env" switch), EV_TEST_PG_URL.
 * Every event here starts 30 days out and the job gets an explicit `now`, so a running server's own every-minute job
 * (real clock) never sees these events as due and can't race the tests.
 * Mutation notes (checked 2026-10-26). The guest guards sit in both the claim and its holder subquery; the subquery
 * decides who gets a push, so each must be dropped from BOTH places to change behavior (one place alone: still green):
 *   drop `<column> IS NULL` (both places)                       -> "second run sends nothing", "two runs at once" and 4 more fail
 *   drop `created_at < moment` (both places)                    -> "ticket after the moment gets no day before push" and 2 more fail
 *   drop `status = 'valid'` (both places)                       -> "refunded and cancelled tickets: no push" fails
 *   drop `published_at < moment` from the host claim            -> "published inside the window: no host push" fails
 *   drop `o.status = 'completed'` from the going count          -> "host push counts only paid or RSVP'd valid tickets" fails
 *   drop the host-active filter                                 -> "inactive host: nothing" fails
 * Nothing reaches Expo: pushes go to a recording fake.
 */
const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);
const noDash = (s: string) => !/[‒–—―]| - /.test(s);
const H = 3600e3;

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must be localhost");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const pushes: any[] = [];
  const { setNoticeDepsForTest } = await import("./ticketNotices");
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p) => { pushes.push(p); return true; },
  });
  const { runEventReminderJob } = await import("./eventReminders");

  const P = `er${Date.now().toString(36)}`;
  let seq = 0;
  const mkUser = async (s: string, active = true) => (await q(
    `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
    [`${P}-${s}@test.local`, `Guest ${s}`, `Guest${s}`, `${P}${s}`.slice(0, 20), active],
  ))[0].id as string;
  const host = await mkUser("host");
  const users: string[] = [];
  for (let i = 0; i < 6; i++) users.push(await mkUser(`u${i}`));

  /** A published event 30 days out. `publishedHoursBefore` = hours before the start it was published. */
  const mkEvent = async (over: { status?: string; hostId?: string; publishedHoursBefore?: number } = {}) => {
    const startsAt = new Date(Date.now() + 30 * 86400000 + (++seq) * H);
    const title = `Rooftop ${P} ${seq}`;
    const publishedAt = new Date(startsAt.getTime() - (over.publishedHoursBefore ?? 72) * H);
    const ev = (await q(
      `INSERT INTO events (host_user_id, slug, title, starts_at, ends_at, timezone, venue_name, address_line1, city, state, postal_code, address_visibility, status, published_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'America/New_York', 'The Loft', '12 Main St', 'Freeport', 'NY', '11520', 'ticket_holders_day_of', $6, $7, $7) RETURNING *`,
      [over.hostId ?? host, `${P}-${seq}`, title, startsAt.toISOString(), new Date(startsAt.getTime() + 5 * H).toISOString(),
       over.status ?? "published", publishedAt.toISOString()],
    ))[0];
    const type = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, 'General', 0, 100) RETURNING id`, [ev.id]))[0].id as string;
    const mine = seq;
    let n = 0;
    /** One order with `count` tickets for `user`, all created `hoursBefore` hours before the start. */
    const addTickets = async (user: string, count = 1, o: { status?: string; orderStatus?: string; hoursBefore?: number } = {}) => {
      const created = new Date(startsAt.getTime() - (o.hoursBefore ?? 48) * H).toISOString();
      // A refunding order has a paid total and a refund in flight (ticket_orders_refunding_has_amount).
      const refunding = o.orderStatus === "refunding";
      const order = (await q(
        `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, completed_at, created_at,
                                    subtotal_cents, total_cents, host_net_cents, refund_reason, refund_amount_cents)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $6, $6, $7, $8) RETURNING id`,
        [ev.id, user, o.orderStatus ?? "completed", count, created,
         refunding ? 1000 : 0, refunding ? "buyer" : null, refunding ? 1000 : 0],
      ))[0].id as string;
      const item = (await q(
        `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 0, 'issued', now()) RETURNING id`, [order, ev.id, type, user, count],
      ))[0].id as string;
      const ids: string[] = [];
      for (let i = 1; i <= count; i++) {
        ids.push((await q(
          `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9) RETURNING id`,
          [order, item, ev.id, type, user, i, `${P}${mine}x${++n}`.toUpperCase(), o.status ?? "valid", created],
        ))[0].id as string);
      }
      return ids;
    };
    const at = (hoursBefore: number) => new Date(startsAt.getTime() - hoursBefore * H);
    return { ev, startsAt, title, at, addTickets };
  };
  const reset = () => { pushes.length = 0; };
  const mine = (title: string) => pushes.filter((p) => p.title.includes(title));
  const stamps = async (ids: string[], col: string) => (await q(`SELECT ${col} AS t FROM tickets WHERE id = ANY($1)`, [ids])).map((r) => r.t);

  const cleanup = async () => {
    const evs = (await q(`SELECT id FROM events WHERE slug LIKE $1`, [`${P}-%`])).map((r) => r.id);
    if (evs.length) {
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [evs]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [evs]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [evs]);
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [evs]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [evs]);
    }
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
  };

  try {
    console.log("Day before: one push per holder, exact copy");
    {
      const e = await mkEvent();
      const a = await e.addTickets(users[0], 3);
      reset();
      const r = await runEventReminderJob(e.at(24));
      const g = mine(e.title).filter((p) => p.userId === users[0]);
      assert(g.length === 1, "three tickets, one holder: one push", g.length);
      assert(g[0]?.title === `Tomorrow: ${e.title}`, "day before title", g[0]?.title);
      assert(/^\w+day at \d{1,2}:\d{2} [AP]M in Freeport, NY\. Your ticket is in the app\.$/.test(g[0]?.body ?? ""), "day before body: day, time, city and state", g[0]?.body);
      assert(!(g[0]?.body ?? "").includes("Main St") && !(g[0]?.body ?? "").includes("Loft"), "day before body never shows the venue or street");
      assert(g[0]?.data?.type === "event_reminder" && g[0]?.data?.kind === "day_before" && g[0]?.data?.eventId === e.ev.id, "push data", g[0]?.data);
      assert(noDash(g[0]?.title + g[0]?.body), "no dashes in the copy");
      assert(r.guestPushes >= 1, "job counts guest pushes", r);
      assert((await stamps(a, "reminder_day_before_at")).every(Boolean), "all three tickets stamped");
      assert((await stamps(a, "reminder_soon_at")).every((t) => !t), "2 hour stamp untouched");
      reset();
      await runEventReminderJob(e.at(23));
      assert(mine(e.title).filter((p) => p.userId === users[0]).length === 0, "second run sends nothing");

      console.log("2 hours before: the second push");
      reset();
      await runEventReminderJob(e.at(2));
      const s = mine(e.title).filter((p) => p.userId === users[0]);
      assert(s.length === 1 && s[0].title === `${e.title} starts in 2 hours`, "2 hour push title", s.map((x) => x.title));
      assert(/^Starts at \d{1,2}:\d{2} [AP]M\. Tap for your ticket and directions\.$/.test(s[0]?.body ?? ""), "2 hour push body", s[0]?.body);
      assert(s[0]?.data?.kind === "soon", "2 hour push kind", s[0]?.data);
      reset();
      await runEventReminderJob(e.at(1));
      assert(mine(e.title).filter((p) => p.userId === users[0]).length === 0, "2 hour push sent once");
      reset();
      await runEventReminderJob(e.at(0));
      // p4-team step 6 (decision 11): "Doors just opened" at the start, nothing else.
      assert(mine(e.title).length > 0 && mine(e.title).every((p) => p.data?.kind === "start" || p.data?.kind === "host_start"), "at the start: only doors open", mine(e.title).map((p) => p.data?.kind));
    }

    console.log("Two runs at once");
    {
      const e = await mkEvent();
      await e.addTickets(users[0], 2);
      await e.addTickets(users[1], 1);
      reset();
      await Promise.all([runEventReminderJob(e.at(24)), runEventReminderJob(e.at(24))]);
      const g = mine(e.title).filter((p) => p.data?.kind === "day_before");
      assert(g.length === 2 && new Set(g.map((p) => p.userId)).size === 2, "each holder told once", g.map((p) => p.userId));
    }

    console.log("Ticket created after the moment");
    {
      const e = await mkEvent();
      await e.addTickets(users[0], 1, { hoursBefore: 10 }); // after the day before moment, before the 2 hour one
      await e.addTickets(users[1], 1, { hoursBefore: 48 });
      await e.addTickets(users[1], 1, { hoursBefore: 10 }); // same holder, one before and one after
      reset();
      await runEventReminderJob(e.at(9));
      const d = mine(e.title).filter((p) => p.data?.kind === "day_before");
      assert(!d.some((p) => p.userId === users[0]), "ticket after the moment gets no day before push", d.map((p) => p.userId));
      assert(d.filter((p) => p.userId === users[1]).length === 1, "holder with one before and one after: one push");
      reset();
      await runEventReminderJob(e.at(2));
      const s = mine(e.title).filter((p) => p.data?.kind === "soon");
      assert(s.some((p) => p.userId === users[0]) && s.some((p) => p.userId === users[1]), "both get the 2 hour push", s.map((p) => p.userId));
      const late = await e.addTickets(users[2], 1, { hoursBefore: 1 });
      reset();
      await runEventReminderJob(e.at(0.5));
      assert(!mine(e.title).some((p) => p.userId === users[2]), "ticket after the 2 hour moment: no push");
      assert((await stamps(late, "reminder_soon_at")).every((t) => !t), "late ticket not stamped");
    }

    console.log("No push for refunded or cancelled tickets, or for events that aren't live");
    {
      const e = await mkEvent();
      await e.addTickets(users[0], 1, { status: "refunded", orderStatus: "refunded" });
      await e.addTickets(users[1], 1, { status: "cancelled", orderStatus: "cancelled" });
      reset();
      await runEventReminderJob(e.at(24));
      assert(!mine(e.title).some((p) => p.data?.kind === "day_before"), "refunded and cancelled tickets: no push");
      for (const status of ["paused", "cancelled", "draft"]) {
        const x = await mkEvent({ status });
        await x.addTickets(users[0], 1);
        reset();
        await runEventReminderJob(x.at(24));
        assert(mine(x.title).length === 0, `${status} event: nothing`);
      }
      const offHost = await mkUser("offhost", false);
      const x = await mkEvent({ hostId: offHost });
      await x.addTickets(users[0], 1);
      reset();
      await runEventReminderJob(x.at(24));
      assert(mine(x.title).length === 0, "inactive host: nothing");
    }

    console.log("Batches are by holder");
    {
      const e = await mkEvent();
      for (let i = 0; i < 5; i++) await e.addTickets(users[i], 2);
      reset();
      await runEventReminderJob(e.at(24), { batchSize: 2 });
      const g = mine(e.title).filter((p) => p.data?.kind === "day_before");
      assert(g.length === 5 && new Set(g.map((p) => p.userId)).size === 5, "batch of 2, five holders: five pushes", g.length);
    }

    console.log("Host push the day before");
    {
      const e = await mkEvent();
      await e.addTickets(users[0], 2);
      await e.addTickets(users[1], 1, { status: "refunded", orderStatus: "refunded" });
      await e.addTickets(users[2], 1, { orderStatus: "refunding" });
      reset();
      const r = await runEventReminderJob(e.at(24));
      const h = mine(e.title).filter((p) => p.userId === host);
      assert(h.length === 1, "host gets one push", h.length);
      assert(h[0]?.title === `Your event is tomorrow: ${e.title}`, "host title", h[0]?.title);
      assert(h[0]?.body === "2 going. Tap to see your guests and manage the event.", "host push counts only paid or RSVP'd valid tickets", h[0]?.body);
      assert(h[0]?.data?.type === "event_reminder" && h[0]?.data?.kind === "host_day_before" && h[0]?.data?.eventId === e.ev.id, "host push data", h[0]?.data);
      assert(r.hostPushes >= 1, "job counts host pushes", r);
      reset();
      await runEventReminderJob(e.at(20));
      assert(!mine(e.title).some((p) => p.userId === host), "host's day before told once");
      // p4-team step 6 (decision 11): the host now also gets a 2 hour push, with its own kind.
      await runEventReminderJob(e.at(2));
      const h2 = mine(e.title).filter((p) => p.userId === host);
      assert(h2.length === 1 && h2[0].data?.kind === "host_soon", "host gets the 2 hour push once", h2.map((p) => p.data?.kind));
      const stamped = (await q(`SELECT host_reminder_at FROM events WHERE id = $1`, [e.ev.id]))[0].host_reminder_at;
      assert(!!stamped, "event stamped");

      const late = await mkEvent({ publishedHoursBefore: 10 });
      await late.addTickets(users[0], 1, { hoursBefore: 9 });
      reset();
      await runEventReminderJob(late.at(5));
      assert(!mine(late.title).some((p) => p.userId === host), "published inside the window: no host push");

      const empty = await mkEvent();
      reset();
      await runEventReminderJob(empty.at(24));
      const he = mine(empty.title).filter((p) => p.userId === host);
      assert(he.length === 1 && he[0].body.startsWith("0 going."), "host push with nobody yet", he.map((p) => p.body));

      const both = await mkEvent();
      await both.addTickets(host, 1);
      reset();
      await Promise.all([runEventReminderJob(both.at(24)), runEventReminderJob(both.at(24))]);
      const kinds = mine(both.title).filter((p) => p.userId === host).map((p) => p.data?.kind).sort();
      assert(JSON.stringify(kinds) === JSON.stringify(["day_before", "host_day_before"]), "host holding a ticket: one of each kind", kinds);
    }

    console.log("A push that fails is not retried and never throws");
    {
      const e = await mkEvent();
      await e.addTickets(users[3], 1);
      setNoticeDepsForTest({
        sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
        sendPush: async () => { throw new Error("expo down"); },
      });
      let threw = false;
      try { await runEventReminderJob(e.at(24)); } catch { threw = true; }
      assert(!threw, "job never throws");
      setNoticeDepsForTest({
        sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
        sendPush: async (p) => { pushes.push(p); return true; },
      });
      reset();
      await runEventReminderJob(e.at(23));
      assert(!mine(e.title).some((p) => p.userId === users[3]), "claimed reminder is not sent again");
    }
  } finally {
    await cleanup();
    await db.end();
    setNoticeDepsForTest(null);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
