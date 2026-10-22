/**
 * Events & Ticketing: one-time "your address is ready" notice for day-of events (runAddressRevealJob).
 *
 * Run with: npx tsx server/events/addressReveal.http.test.ts
 * Local env: .superpowers/sdd/2026-10-22-events-list-day-of-address/env/run-suite.sh server/events/addressReveal.http.test.ts
 *
 * SCRATCH ONLY. Needs local Postgres with migrations 056 and 066, plus DATABASE_URL + the neon preload (the job runs in
 * this process): EV_TEST_BASE_URL (only used as the "is this the local env" switch), EV_TEST_PG_URL.
 * Every event here starts 30 days out and the job gets an explicit `now` just after that event's reveal time, so the
 * running server's own every-minute job (real clock) never sees these events as revealed and can't race the tests.
 * Mutation notes:
 *   drop `address_reveal_notified_at IS NULL` from the claim            -> "two runs at once notify each holder once" fails
 *   drop `created_at < revealAt` from the claim                         -> "ticket bought after reveal gets no notice" fails
 *   drop `status = 'valid'` from the claim                              -> "refunded and cancelled tickets get no notice" fails
 *   drop the DISTINCT holder handling                                   -> "two tickets, one holder = one notice" fails
 * Nothing reaches Resend or Expo: notices go to recording fakes.
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

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must be localhost");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const emails: any[] = [];
  const pushes: any[] = [];
  let emailThrowsFor: string | null = null;
  const { setNoticeDepsForTest } = await import("./ticketNotices");
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {},
    sendAddressReveal: async (p) => { if (emailThrowsFor && p.toEmail === emailThrowsFor) throw new Error("resend down"); emails.push(p); },
    sendPush: async (p) => { pushes.push(p); return true; },
  });
  const { runAddressRevealJob } = await import("./addressReveal");
  const { addressRevealAt } = await import("./eventRules");

  const P = `ar${Date.now().toString(36)}`;
  let seq = 0;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO users (id, email, name, first_name, username) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [`${P}-${s}@test.local`, `Guest ${s}`, `Guest${s}`, `${P}${s}`.slice(0, 20)],
  ))[0].id as string;
  const host = await mkUser("host");
  const users: string[] = [];
  for (let i = 0; i < 8; i++) users.push(await mkUser(`u${i}`));
  const emailOf = (i: number) => `${P}-u${i}@test.local`;

  /** A published event 30 days out (+ offset hours). Returns the event, its reveal time and a way to add tickets. */
  const mkEvent = async (over: { visibility?: string; status?: string; title?: string } = {}) => {
    const startsAt = new Date(Date.now() + 30 * 86400000 + (++seq) * 3600000);
    const title = over.title ?? `Reveal Night ${P} ${seq}`;
    const ev = (await q(
      `INSERT INTO events (host_user_id, slug, title, starts_at, ends_at, timezone, venue_name, address_line1, city, state, postal_code, address_visibility, status, published_at)
       VALUES ($1, $2, $3, $4, $5, 'America/New_York', 'The Loft', '12 Main St', 'Freeport', 'NY', '11520', $6, $7, now()) RETURNING *`,
      [host, `${P}-${seq}`, title, startsAt.toISOString(), new Date(startsAt.getTime() + 5 * 3600000).toISOString(),
       over.visibility ?? "ticket_holders_day_of", over.status ?? "published"],
    ))[0];
    const type = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, 'General', 0, 100) RETURNING id`, [ev.id]))[0].id as string;
    const revealAt = addressRevealAt(startsAt, "America/New_York");
    const mine = seq;
    let n = 0;
    /** One free order with `count` tickets for `user`. */
    const addTickets = async (user: string, count = 1, o: { status?: string; createdAt?: Date } = {}) => {
      const order = (await q(
        `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, completed_at) VALUES ($1, $2, 'completed', $3, now()) RETURNING id`,
        [ev.id, user, count],
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
          [order, item, ev.id, type, user, i, `${P}${mine}x${++n}`.toUpperCase(), o.status ?? "valid", (o.createdAt ?? new Date()).toISOString()],
        ))[0].id as string);
      }
      return ids;
    };
    const after = new Date(revealAt.getTime() + 60000);
    const before = new Date(revealAt.getTime() - 60000);
    return { ev, revealAt, after, before, addTickets };
  };
  const reset = () => { emails.length = 0; pushes.length = 0; emailThrowsFor = null; };
  const notifiedAt = async (ids: string[]) => (await q(`SELECT address_reveal_notified_at AS t FROM tickets WHERE id = ANY($1)`, [ids])).map((r) => r.t);
  const forEvent = (arr: any[], title: string, pick: (x: any) => string) => arr.filter((x) => pick(x).includes(title));

  const cleanup = async () => {
    const evs = (await q(`SELECT id FROM events WHERE slug LIKE $1`, [`${P}-%`])).map((r) => r.id);
    if (!evs.length) return;
    await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [evs]);
    await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [evs]);
    await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [evs]);
    await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [evs]);
    await q(`DELETE FROM events WHERE id = ANY($1)`, [evs]);
  };

  try {
    console.log("Reveal passed: each holder is told once");
    {
      const e = await mkEvent();
      const a = await e.addTickets(users[0], 2); // two tickets, one holder
      const b = await e.addTickets(users[1], 1);
      reset();
      const r = await runAddressRevealJob(e.after);
      assert(r.notified === 2, "job reports 2 holders notified", r);
      const myPush = pushes.filter((p) => p.body.includes(e.ev.title));
      const myMail = emails.filter((m) => m.event.title === e.ev.title);
      assert(myPush.length === 2 && myMail.length === 2, "two tickets, one holder = one push and one email each", { pushes: myPush.length, emails: myMail.length });
      const p0 = myPush.find((p) => p.userId === users[0]);
      assert(p0?.title === "Your event address is ready" && p0?.body === `The address for ${e.ev.title} is now in your tickets.`, "push copy is exact", p0);
      assert(p0?.data?.type === "address_reveal" && p0?.data?.eventId === e.ev.id, "push carries type and event id", p0?.data);
      const m0 = myMail.find((m) => m.toEmail === emailOf(0));
      assert(m0?.event.whereText === "The Loft, 12 Main St, Freeport, NY 11520" && /E[DS]T/.test(m0?.event.whenText ?? ""), "email carries the full address and the local time", m0?.event);
      assert(typeof m0?.ticketsUrl === "string" && m0.ticketsUrl.endsWith("/tickets"), "email links to My Tickets", m0?.ticketsUrl);
      assert((await notifiedAt([...a, ...b])).every((t) => t), "every claimed ticket is stamped");
      reset();
      const again = await runAddressRevealJob(e.after);
      assert(again.notified === 0 && forEvent(pushes, e.ev.title, (x) => x.body).length === 0 && emails.length === 0, "a second run sends nothing", { again, pushes: pushes.length, emails: emails.length });
    }

    console.log("Two runs at once");
    {
      const e = await mkEvent();
      await e.addTickets(users[2], 1);
      await e.addTickets(users[3], 3);
      await e.addTickets(users[4], 1);
      reset();
      const [r1, r2] = await Promise.all([runAddressRevealJob(e.after), runAddressRevealJob(e.after)]);
      const mine = forEvent(pushes, e.ev.title, (x) => x.body);
      assert(r1.notified + r2.notified === 3 && mine.length === 3 && new Set(mine.map((p) => p.userId)).size === 3, "two runs at once notify each holder once", { r1, r2, n: mine.length });
      assert(emails.filter((m) => m.event.title === e.ev.title).length === 3, "and each gets one email");
    }

    console.log("Who is skipped");
    {
      const e = await mkEvent();
      const refunded = await e.addTickets(users[0], 1, { status: "refunded" });
      const cancelled = await e.addTickets(users[1], 1, { status: "cancelled" });
      const late = await e.addTickets(users[2], 1, { createdAt: new Date(e.revealAt.getTime() + 30000) });
      const ok = await e.addTickets(users[3], 1);
      reset();
      const r = await runAddressRevealJob(e.after);
      const mine = forEvent(pushes, e.ev.title, (x) => x.body);
      assert(r.notified === 1 && mine.length === 1 && mine[0].userId === users[3], "only the valid ticket from before the reveal is notified", { r, mine });
      assert((await notifiedAt([...refunded, ...cancelled])).every((t) => t === null), "refunded and cancelled tickets get no notice (and stay unstamped)");
      assert((await notifiedAt(late))[0] === null, "ticket bought after reveal gets no notice (it already sees the address)");
      assert((await notifiedAt(ok))[0] !== null, "the valid one is stamped");
    }
    {
      const e = await mkEvent();
      const ids = await e.addTickets(users[0], 1);
      reset();
      const r = await runAddressRevealJob(e.before);
      assert(r.notified === 0 && forEvent(pushes, e.ev.title, (x) => x.body).length === 0 && (await notifiedAt(ids))[0] === null, "reveal not yet passed: nothing sent, nothing stamped", r);
    }
    {
      const other = await mkEvent({ visibility: "ticket_holders" });
      const pub = await mkEvent({ visibility: "public" });
      const a = await other.addTickets(users[0], 1);
      const b = await pub.addTickets(users[1], 1);
      reset();
      await runAddressRevealJob(new Date(Math.max(other.after.getTime(), pub.after.getTime())));
      assert(forEvent(pushes, other.ev.title, (x) => x.body).length === 0 && forEvent(pushes, pub.ev.title, (x) => x.body).length === 0
        && (await notifiedAt([...a, ...b])).every((t) => t === null), "ticket_holders and public events get no notice");
    }
    {
      const draft = await mkEvent({ status: "cancelled" });
      const ids = await draft.addTickets(users[0], 1);
      reset();
      await runAddressRevealJob(draft.after);
      assert(forEvent(pushes, draft.ev.title, (x) => x.body).length === 0 && (await notifiedAt(ids))[0] === null, "a cancelled event gets no notice");
    }
    {
      const e = await mkEvent();
      const ids = await e.addTickets(users[0], 1);
      reset();
      const past = new Date(e.ev.ends_at.getTime ? e.ev.ends_at.getTime() + 60000 : new Date(e.ev.ends_at).getTime() + 60000);
      await runAddressRevealJob(past);
      assert(forEvent(pushes, e.ev.title, (x) => x.body).length === 0 && (await notifiedAt(ids))[0] === null, "an event that already ended gets no notice");
    }

    console.log("A failing email does not stop the rest");
    {
      const e = await mkEvent();
      await e.addTickets(users[5], 1);
      await e.addTickets(users[6], 1);
      await e.addTickets(users[7], 1);
      reset();
      emailThrowsFor = emailOf(5);
      let threw = false;
      let r: any = null;
      try { r = await runAddressRevealJob(e.after); } catch { threw = true; }
      const mine = forEvent(pushes, e.ev.title, (x) => x.body);
      assert(!threw && r?.notified >= 3, "the job does not throw (earlier test events with a later-passed reveal may add holders)", { threw, r });
      assert(mine.length === 3, "all three holders still get the push", mine.length);
      assert(emails.filter((m) => m.event.title === e.ev.title).map((m) => m.toEmail).sort().join() === [emailOf(6), emailOf(7)].sort().join(), "the other two still get their email");
    }

    console.log("Email copy");
    {
      const em = await import("../emailService");
      const visible = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
      const out = em.renderAddressReveal({ toEmail: "a@b.c", firstName: "Ana", event: { title: "Night <b>Out</b>", whenText: "Saturday, October 24 at 8:00 PM EDT", whereText: "The Loft, 12 Main St, Freeport, NY 11520" }, ticketsUrl: "https://www.goutsyde.com/tickets" });
      const text = `${out.subject} ${visible(out.html)}`;
      assert(text.includes("The Loft, 12 Main St, Freeport, NY 11520") && text.includes("Saturday, October 24") && text.includes("Night"), "email shows event, when and full address", text);
      assert(out.html.includes('href="https://www.goutsyde.com/tickets"'), "email links to My Tickets");
      assert(!text.includes("%") && noDash(text), "no percentages and no dashes", text);
      assert(!out.html.includes("<b>Out</b>") && out.html.includes("Night &lt;b&gt;Out&lt;/b&gt;"), "title is escaped");
    }
  } finally {
    setNoticeDepsForTest(null);
    await cleanup();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
