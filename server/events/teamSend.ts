/**
 * p4-team step 4b-2: sending team pay and everything around it (Legend 2026-10-30, calls 20 to 23).
 *
 *   20 Sending is behind TEAM_PAYOUTS_ENABLED on Render, pause only. Off: rows stay 'pending', the money stays held on
 *      Stripe (bankPayout counts open team pay), nothing goes to the host. On: everything waiting goes out.
 *   21 (doorRouter) a reason to take someone off, the team locked once the event is over, each person keeps their view.
 *   22 Payout setup is not needed to accept a spot. Paid members without it get a push on accept and once a day, plus
 *      emails the day of the event and the day after, until setup or the deadline: when the payout is worked out
 *      (createDuePayouts, 3 days after the end). Not set up by then: 'no_setup', the host pays them, one last message.
 *   23 I paid them / Got it / Not yet, the host can undo until Got it; a Not yet open 3 days goes to the admin.
 *
 * Sending is the referral sender's pattern (businessReferrals.ts sendReferralPayout): claim (attempts + 1, lock 10
 * minutes), ownership tag on every write, lock re-taken right before the bounded lookup + create, lookup in the row's
 * own transfer group (event_team_<id>) before every create, one idempotency key per claim. Event paused or the
 * member's account not ready -> 'held', rechecked hourly, admin emailed once per reason. Not enough platform balance
 * -> stays 'pending', not a try, hourly, admin email at most once a day (the bank payout waits too). Other errors ->
 * backoff 10, 20, 40, 60 minutes, 'review' after 5 tries. Leaving 'review' is manual, like event payouts.
 */
import { sql } from "drizzle-orm";
import { rows, iso, hostIdentity } from "./eventsRouter";
import { alertAdmin } from "./ticketCheckout";

type StripeServiceT = typeof import("../stripe/stripeService").stripeService;
export type TeamStripe = Pick<StripeServiceT, "getPayoutReadiness" | "findEventTeamPayoutTransfer" | "createEventTeamPayoutTransfer" | "isInsufficientFundsError">;
export type TeamSendResult = "paid" | "held" | "retry" | "insufficient" | "review" | "not_due";

export const TEAM_PAYOUT_MAX_ATTEMPTS = 5;
export const TEAM_PAYOUT_JOB_LIMIT = 50;
export const TEAM_PAYOUT_LOCK_MINUTES = 10;
/** A Not yet still open this long goes to the admin (call 23: "not sorted in a few days"). */
export const NOT_RECEIVED_FLAG_DAYS = 3;
/** Shared New York day budget of email_log rows (same ceiling as the owed reminder and door invites). */
export const SETUP_EMAIL_CEILING = 70;
const STRIPE_CALL_BOUND = { timeoutMs: 30000, maxNetworkRetries: 1 };
const OWNER_TAG = sql`(extract(epoch from updated_at) * 1000000)::bigint::text`;

/** Call 20: the Render switch. Only the exact text "true" turns sending on. */
export function teamPayoutsEnabled(): boolean {
  return String(process.env.TEAM_PAYOUTS_ENABLED ?? "").trim().toLowerCase() === "true";
}

export const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Test seam only: lets a test act right after a claim (a slow read in real life). Never set in production. */
let afterClaimHook: ((teamPayoutId: string) => Promise<void>) | null = null;
export function setTeamSendHooksForTest(h: { afterClaim?: (teamPayoutId: string) => Promise<void> } | null): void {
  afterClaimHook = h?.afterClaim ?? null;
}

async function realStripe(): Promise<TeamStripe> {
  const { stripeService } = await import("../stripe/stripeService");
  return stripeService;
}

// ─── Who is set up ──────────────────────────────────────────────────────────

/**
 * SQL: does this user have a payout destination that finished setup? Same places, same order as referral payouts:
 * their own approved business, their photographer profile, their personal payout account. Stripe itself is asked at
 * send time (an account can still be held there).
 */
export const memberReadySql = (userId: ReturnType<typeof sql> | string) => sql`(
  EXISTS (SELECT 1 FROM businesses b WHERE b.owner_id = ${userId} AND b.stripe_account_id IS NOT NULL AND b.stripe_account_id <> ''
          AND b.approval_status = 'approved' AND COALESCE(b.stripe_onboarding_complete, false))
  OR EXISTS (SELECT 1 FROM photographers ph WHERE ph.user_id = ${userId} AND ph.stripe_account_id IS NOT NULL AND ph.stripe_account_id <> ''
          AND COALESCE(ph.stripe_onboarding_complete, false))
  OR EXISTS (SELECT 1 FROM user_payout_accounts upa WHERE upa.user_id = ${userId} AND upa.onboarding_complete))`;

/** Which of these users are set up (one statement). */
export async function readyMembers(userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const list = await rows<any>(sql`
    SELECT x.id FROM unnest(string_to_array(${userIds.join(",")}, ',')) AS x(id)
    WHERE ${memberReadySql(sql`x.id`)}`);
  return new Set(list.map((r) => String(r.id)));
}

// ─── Copy (no dashes) ───────────────────────────────────────────────────────

export function deadlineText(endsAt: Date | string, timeZone: string): string {
  const d = new Date(new Date(endsAt).getTime() + 3 * 24 * 3600_000);
  try {
    return `${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })}`;
  } catch {
    const tz = "America/New_York";
    return `${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}`;
  }
}

export const teamCopy = {
  setup: (title: string) => ({ title: "Set up payouts", body: `Set up payouts to be paid for ${title}.` }),
  setupFirm: (title: string, cents: number, day: string) => ({
    title: "Set up payouts",
    body: cents > 0
      ? `Your ${usd(cents)} for ${title} goes to the host if payouts aren't set up by ${day}.`
      : `Your pay for ${title} goes to the host if payouts aren't set up by ${day}.`,
  }),
  toHost: (title: string, cents: number) => ({
    title: "Your pay goes through the host",
    body: `Payouts weren't set up in time, so your ${usd(cents)} for ${title} went to the host. The host will pay you directly.`,
  }),
  heldSetup: (title: string, cents: number) => ({
    title: "Finish payout setup",
    body: `Your ${usd(cents)} for ${title} is waiting. Stripe needs a little more from you before it can be sent. Open payout setup to finish.`,
  }),
  sent: (title: string, cents: number) => ({
    title: "You got paid",
    body: `Outsyde sent you ${usd(cents)} for ${title}. It reaches your bank on your Stripe payout schedule.`,
  }),
  markedPaid: (host: string, title: string, cents: number) => ({
    title: "Did you get paid?",
    body: `${host} says they paid you ${usd(cents)} for ${title}. Did you get it?`,
  }),
  confirmed: (member: string, title: string, cents: number) => ({
    title: "Payment confirmed",
    body: `${member} confirmed they got the ${usd(cents)} for ${title}.`,
  }),
  notYet: (member: string, title: string, cents: number) => ({
    title: "Payment not received yet",
    body: `${member} says they haven't got the ${usd(cents)} for ${title} yet.`,
  }),
};

async function deps() {
  const { noticeDeps } = await import("./ticketNotices");
  return noticeDeps();
}

/** Push + Activity to one person. Never throws. */
async function tell(userId: string, copy: { title: string; body: string }, type: string, refId: string, metadata: Record<string, unknown>, by: string | null = null,
  refType = "event_team_payout"): Promise<void> {
  try {
    const d = await deps();
    await d.sendPush({ userId, title: copy.title, body: copy.body, data: { type, ...metadata } }).catch((err) =>
      console.error(`[TeamPay] ${type} push failed for ${userId}:`, (err as Error)?.message ?? err));
    if (d.createActivity) {
      await d.createActivity({
        userId, type, title: copy.title, message: copy.body, referenceType: refType, referenceId: refId, metadata, triggeredByUserId: by,
      }).catch((err) => console.error(`[TeamPay] ${type} activity failed for ${userId}:`, (err as Error)?.message ?? err));
    }
  } catch (err) {
    console.error(`[TeamPay] ${type} notice failed for ${userId}:`, (err as Error)?.message ?? err);
  }
}

const personName = (u: { first_name?: string | null; username?: string | null } | undefined) =>
  (u?.first_name && String(u.first_name).trim()) || (u?.username ? `@${u.username}` : "Someone");

// ─── Sending (call 20) ──────────────────────────────────────────────────────

const HOLD_TEXT: Record<string, string> = {
  event_paused: "the event is paused",
  no_account: "the member has no payout account",
  not_complete: "the member hasn't finished payout setup",
  stripe_not_ready: "Stripe says the member's account can't take payouts yet",
};

async function hold(p: any, reason: string, tag: string): Promise<TeamSendResult> {
  const [h] = await rows<any>(sql`
    UPDATE event_team_payouts SET status = 'held', hold_reason = ${reason}, attempts = GREATEST(0, attempts - 1),
           next_attempt_at = now() + interval '1 hour', alerted_at = now(), updated_at = now()
    WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
      AND (status <> 'held' OR alerted_at IS NULL OR hold_reason IS DISTINCT FROM ${reason})
    RETURNING id`);
  if (!h) {
    const [same] = await rows<any>(sql`
      UPDATE event_team_payouts SET attempts = GREATEST(0, attempts - 1), next_attempt_at = now() + interval '1 hour', updated_at = now()
      WHERE id = ${p.id} AND status = 'held' AND ${OWNER_TAG} = ${tag}
      RETURNING id`);
    return same ? "held" : "not_due";
  }
  await alertAdmin("Team pay on hold",
    `Team pay ${p.id} of ${p.amount_cents} cents to user ${p.member_user_id} for event ${p.event_id} is on hold: ${HOLD_TEXT[reason] ?? reason}. It is checked again every hour and sent once this is fixed.`);
  // The member can fix their own payout setup: tell them once per reason (same rule as the admin email).
  if (reason !== "event_paused") {
    const [e] = await rows<any>(sql`SELECT title FROM events WHERE id = ${p.event_id}`);
    void tell(String(p.member_user_id), teamCopy.heldSetup(String(e?.title ?? "your event"), Number(p.amount_cents)), "team_pay_held", String(p.id),
      { eventId: String(p.event_id), amountCents: Number(p.amount_cents) });
  }
  return "held";
}

async function toReview(p: any, why: string, tag: string): Promise<TeamSendResult> {
  const [r] = await rows<any>(sql`
    UPDATE event_team_payouts SET status = 'review', last_error = ${why.slice(0, 300)}, next_attempt_at = NULL, updated_at = now()
    WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
    RETURNING id`);
  if (!r) return "not_due";
  await alertAdmin("Team pay needs a look",
    `Team pay ${p.id} of ${p.amount_cents} cents to user ${p.member_user_id} for event ${p.event_id}: ${why}. Check Stripe, then set it back to pending with attempts 0 to retry.`);
  return "review";
}

/** Sends one team member's pay. Safe to run any number of times, at the same time too. Ignores the switch (the job checks it). */
export async function sendTeamPayout(teamPayoutId: string, s?: TeamStripe): Promise<TeamSendResult> {
  const [p] = await rows<any>(sql`
    UPDATE event_team_payouts SET attempts = attempts + 1,
           next_attempt_at = now() + make_interval(mins => ${TEAM_PAYOUT_LOCK_MINUTES}::int), updated_at = now()
    WHERE id = ${teamPayoutId} AND outcome = 'covered' AND status IN ('pending', 'held')
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    RETURNING id, event_id, member_user_id, amount_cents, attempts, ${OWNER_TAG} AS claim_tag`);
  if (!p) return "not_due";
  let tag = String(p.claim_tag);
  if (afterClaimHook) await afterClaimHook(String(p.id));
  const amount = Number(p.amount_cents);
  const [e] = await rows<any>(sql`SELECT id, title, status FROM events WHERE id = ${p.event_id}`);
  if (!e || e.status === "cancelled") return toReview(p, "the event was cancelled after its team pay was worked out, so it was not sent", tag);
  if (e.status !== "published") return hold(p, "event_paused", tag);

  const st = s ?? (await realStripe());
  try {
    const { referralPayoutDestinations } = await import("../referrals/businessReferrals");
    const dests = await referralPayoutDestinations(String(p.member_user_id));
    let dest: { destinationType: string; accountId: string } | null = null;
    let reason = "no_account";
    for (const d of dests) {
      if (!d.localReady) { if (reason === "no_account") reason = "not_complete"; continue; }
      try {
        if ((await st.getPayoutReadiness(d.accountId, STRIPE_CALL_BOUND)).ready) { dest = d; break; }
        reason = "stripe_not_ready";
      } catch {
        reason = "stripe_not_ready";
      }
    }
    if (!dest) return await hold(p, reason, tag);

    const [mine] = await rows<any>(sql`
      UPDATE event_team_payouts SET next_attempt_at = now() + make_interval(mins => ${TEAM_PAYOUT_LOCK_MINUTES}::int),
             status = 'pending', hold_reason = NULL,
             alerted_at = CASE WHEN status = 'held' THEN NULL ELSE alerted_at END, updated_at = now()
      WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`);
    if (!mine) return "not_due";
    tag = String(mine.tag);

    const existing = await st.findEventTeamPayoutTransfer(p.id, STRIPE_CALL_BOUND);
    let transferId: string;
    if (existing) {
      if (existing.amount !== amount) return await toReview(p, `Stripe already has transfer ${existing.id} of ${existing.amount} cents for this team pay, but it is ${amount} cents`, tag);
      transferId = existing.id;
    } else {
      transferId = (await st.createEventTeamPayoutTransfer({
        eventId: String(e.id), teamPayoutId: String(p.id), destination: dest.accountId, amountCents: amount,
        idempotencyKey: `event_team_payout_${p.id}_${p.claim_tag}`, ...STRIPE_CALL_BOUND,
      })).id;
    }
    const [done] = await rows<any>(sql`
      UPDATE event_team_payouts SET status = 'paid', transfer_id = ${transferId}, paid_at = now(),
             destination_type = ${dest.destinationType}, connected_account_id = ${dest.accountId},
             hold_reason = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = ${p.id} AND status IN ('pending', 'held')
        AND (${OWNER_TAG} = ${tag} OR next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING id`);
    if (!done) return "not_due";
    void tell(String(p.member_user_id), teamCopy.sent(String(e.title), amount), "team_pay_sent", String(p.id), { eventId: String(e.id), amountCents: amount });
    return "paid";
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 300);
    let insufficient = false;
    try { insufficient = st.isInsufficientFundsError(err); } catch { /* treat as other */ }
    if (insufficient) {
      const [w] = await rows<any>(sql`
        UPDATE event_team_payouts SET status = 'pending', attempts = GREATEST(0, attempts - 1),
               next_attempt_at = now() + interval '1 hour', last_error = ${msg},
               alerted_at = CASE WHEN alerted_at IS NULL OR alerted_at < now() - interval '24 hours' THEN now() ELSE alerted_at END,
               updated_at = now()
        WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
        RETURNING (alerted_at = now()) AS emailed`);
      if (!w) return "not_due";
      if (w.emailed === true || w.emailed === "t") {
        await alertAdmin("Team pay waiting for balance",
          `Team pay ${p.id} of ${amount} cents for "${e.title}" (event ${e.id}) can't be sent: not enough available balance on Stripe. It is tried again every hour, and the daily bank payout waits until it is sent.`);
      }
      return "insufficient";
    }
    console.error(`[TeamPay] try ${p.attempts} failed for ${p.id}: ${msg}`);
    const [still] = await rows<any>(sql`
      UPDATE event_team_payouts SET last_error = ${msg},
             next_attempt_at = now() + make_interval(mins => LEAST(60, ${TEAM_PAYOUT_LOCK_MINUTES}::int * power(2, LEAST(attempts - 1, 6)))::int),
             updated_at = now()
      WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`).catch(() => [] as any[]);
    if (!still) return "not_due";
    tag = String(still.tag);
    if (Number(p.attempts) >= TEAM_PAYOUT_MAX_ATTEMPTS) return toReview(p, `the transfer failed ${p.attempts} times, last error: ${msg}`, tag);
    return "retry";
  }
}

/** Every minute (when the switch is on): send up to 50 due team payouts, least recently tried first. */
export async function runTeamPayoutSends(s?: TeamStripe): Promise<{ sent: number; held: number; review: number }> {
  const out = { sent: 0, held: 0, review: 0 };
  if (!teamPayoutsEnabled()) return out;
  const due = await rows<any>(sql`
    SELECT id FROM event_team_payouts
    WHERE outcome = 'covered' AND status IN ('pending', 'held') AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY updated_at LIMIT ${TEAM_PAYOUT_JOB_LIMIT}`);
  for (const d of due) {
    try {
      const r = await sendTeamPayout(String(d.id), s);
      if (r === "paid") out.sent++;
      else if (r === "held") out.held++;
      else if (r === "review") out.review++;
    } catch (err) {
      console.error(`[TeamPay] ${d.id} failed:`, (err as Error)?.message ?? err);
    }
  }
  return out;
}

// ─── Call 22: setup reminders and the one last message ──────────────────────

/** The one last message to members whose share went to the host (no_setup). Each once (member_notified_at). */
export async function notifyNoSetupMembers(limit = 100): Promise<number> {
  const told = await rows<any>(sql`
    UPDATE event_team_payouts r SET member_notified_at = now()
    FROM events e
    WHERE r.id IN (SELECT id FROM event_team_payouts WHERE outcome = 'no_setup' AND member_notified_at IS NULL ORDER BY created_at LIMIT ${limit})
      AND r.member_notified_at IS NULL AND e.id = r.event_id
    RETURNING r.id, r.member_user_id, r.amount_cents, r.event_id, e.title`);
  for (const t of told) {
    await tell(String(t.member_user_id), teamCopy.toHost(String(t.title), Number(t.amount_cents)), "team_pay_to_host", String(t.id),
      { eventId: String(t.event_id), amountCents: Number(t.amount_cents) });
  }
  return told.length;
}

/** Pay set for this person at this event (any role), as the setup reminders read it. */
const PAID_SPOT = sql`(p.pay_type <> 'none' OR p.commission_bps IS NOT NULL)`;
/**
 * Paid spots: a role with pay set, or (step 7) an accepted request to stay longer that pays (Fixed, hourly, or a To be
 * discussed amount above $0), so someone whose only pay is an extra is reminded to set up payouts too.
 */
const PAID_SPOTS = sql`(
  SELECT p.event_id, p.member_user_id, p.role FROM event_team_pay p WHERE ${PAID_SPOT}
  UNION
  SELECT x.event_id, x.member_user_id, x.role FROM event_team_extensions x
  WHERE x.status = 'accepted' AND (x.pay_kind IN ('fixed', 'hourly') OR (x.pay_kind = 'tbd' AND COALESCE(x.final_cents, 0) > 0)))`;

/**
 * On the team, in a role with pay, this event or the host's standing team. Before the end: accepted and not removed.
 * After the end: the team as it stood when the event ended (same rule as eventPay asOf), so someone who left the
 * standing team afterwards is still owed this event's pay and still reminded.
 */
const onTeamAt = (a: string) => sql`${sql.raw(a)}.accepted_at IS NOT NULL AND (
  (e.ends_at > now() AND ${sql.raw(a)}.removed_at IS NULL)
  OR (e.ends_at <= now() AND ${sql.raw(a)}.accepted_at <= e.ends_at AND (${sql.raw(a)}.removed_at IS NULL OR ${sql.raw(a)}.removed_at > e.ends_at)))`;
const ON_TEAM_IN_ROLE = sql`(
  EXISTS (SELECT 1 FROM event_door_members m WHERE m.event_id = e.id AND m.member_user_id = p.member_user_id AND m.role = p.role AND ${onTeamAt("m")})
  OR EXISTS (SELECT 1 FROM event_door_team t WHERE t.host_user_id = e.host_user_id AND t.member_user_id = p.member_user_id AND t.role = p.role AND ${onTeamAt("t")}))`;

/** Events still before their deadline: published, pay not worked out yet. */
const BEFORE_DEADLINE = sql`e.status = 'published' AND e.team_pay_fixed_at IS NULL AND e.ends_at + interval '3 days' > now()`;

async function memberPayCents(event: any, userId: string, cache: Map<string, any>): Promise<number> {
  try {
    let pay = cache.get(String(event.id));
    if (!pay) {
      const { eventPay } = await import("./teamPay");
      pay = await eventPay({ id: String(event.id), host_user_id: String(event.host_user_id) });
      cache.set(String(event.id), pay);
    }
    return Number(pay.members.find((m: any) => m.userId === userId)?.totalCents ?? 0);
  } catch {
    return 0;
  }
}

/** Is today (or yesterday) the event's start day in its own time zone? */
const LOCAL_DAY = (offsetDays: number) => sql`
  ((e.starts_at AT TIME ZONE COALESCE(e.timezone, 'America/New_York'))::date + ${offsetDays}::int)
    = (now() AT TIME ZONE COALESCE(e.timezone, 'America/New_York'))::date`;

/**
 * Call 22: every paid member without payout setup, at every event before its deadline: a push once a day (the push on
 * accept counts as that day's), and an email the day of the event and the day after, with firmer words. Setup
 * stops it at once (they are no longer picked). Each send is claimed first (event_team_setup_notices), so two runs
 * never both send. Returns how many people were reminded.
 */
export async function remindTeamSetup(limit = 200): Promise<number> {
  const cand = await rows<any>(sql`
    SELECT DISTINCT e.id, e.title, e.host_user_id, e.timezone, e.starts_at, e.ends_at, p.member_user_id,
           ${LOCAL_DAY(0)} AS is_day_of, ${LOCAL_DAY(1)} AS is_day_after
    FROM ${PAID_SPOTS} p JOIN events e ON e.id = p.event_id
    LEFT JOIN event_team_setup_notices n ON n.event_id = e.id AND n.member_user_id = p.member_user_id
    WHERE ${BEFORE_DEADLINE} AND ${ON_TEAM_IN_ROLE} AND NOT ${memberReadySql(sql`p.member_user_id`)}
      -- Only people with something due, so nobody is starved behind ones already told today.
      AND (n.last_push_at IS NULL OR n.last_push_at <= now() - interval '1 day'
           OR (${LOCAL_DAY(0)} AND n.day_of_email_at IS NULL) OR (${LOCAL_DAY(1)} AND n.day_after_email_at IS NULL))
    ORDER BY e.starts_at, e.id, p.member_user_id
    LIMIT ${limit}`);
  if (!cand.length) return 0;
  const d = await deps();
  const { startOfNewYorkDay } = await import("../emailHistory");
  const cache = new Map<string, any>();
  const yes = (v: unknown) => v === true || v === "t" || v === "true";
  let reminded = 0;
  for (const c of cand) {
    const eventId = String(c.id), userId = String(c.member_user_id);
    try {
      await rows(sql`INSERT INTO event_team_setup_notices (event_id, member_user_id) VALUES (${eventId}, ${userId}) ON CONFLICT DO NOTHING`);
      const firm = yes(c.is_day_of) || yes(c.is_day_after);
      const [pushed] = await rows<any>(sql`
        UPDATE event_team_setup_notices SET last_push_at = now()
        WHERE event_id = ${eventId} AND member_user_id = ${userId} AND (last_push_at IS NULL OR last_push_at <= now() - interval '1 day')
        RETURNING 1 AS x`);
      let emailCol = yes(c.is_day_of) ? sql`day_of_email_at` : yes(c.is_day_after) ? sql`day_after_email_at` : null;
      if (emailCol) {
        // Over the shared daily email budget: leave the email unclaimed, so a later run (tomorrow at the latest) sends it.
        const nyDayStart = startOfNewYorkDay(new Date()).toISOString();
        const [n] = await rows<any>(sql`SELECT count(*)::int AS n FROM email_log WHERE created_at >= ${nyDayStart}::timestamptz AND created_at < ${nyDayStart}::timestamptz + interval '1 day'`);
        if (Number(n?.n ?? 0) >= SETUP_EMAIL_CEILING) emailCol = null;
      }
      const [mailed] = emailCol ? await rows<any>(sql`
        UPDATE event_team_setup_notices SET ${emailCol} = now()
        WHERE event_id = ${eventId} AND member_user_id = ${userId} AND ${emailCol} IS NULL
        RETURNING 1 AS x`) : [];
      if (!pushed && !mailed) continue;
      const cents = firm ? await memberPayCents(c, userId, cache) : 0;
      const day = deadlineText(c.ends_at, c.timezone ?? "America/New_York");
      if (pushed) {
        const copy = firm ? teamCopy.setupFirm(String(c.title), cents, day) : teamCopy.setup(String(c.title));
        await tell(userId, copy, "team_payout_setup", eventId, { eventId }, null, "event");
      }
      if (mailed && d.sendTeamSetupReminder) {
        const [u] = await rows<any>(sql`SELECT email, first_name FROM users WHERE id = ${userId}`);
        if (u?.email) {
          await d.sendTeamSetupReminder({
            userId, toEmail: u.email, firstName: u.first_name ?? null, amountCents: cents, eventTitle: String(c.title), deadlineText: day,
            final: yes(c.is_day_after),
          }).catch((err: unknown) => console.error(`[TeamPay] setup email failed for ${userId}:`, (err as Error)?.message ?? err));
        }
      }
      reminded++;
    } catch (err) {
      console.error(`[TeamPay] setup reminder failed for ${userId} at ${eventId}:`, (err as Error)?.message ?? err);
    }
  }
  return reminded;
}

/**
 * Call 22: the push on accept. A paid spot (this event, or the host's upcoming events for a standing spot) and no
 * payout setup: one push per event, recorded as that day's reminder. Never throws.
 */
export async function notifySetupOnAccept(p: { scope: "standing" | "event"; eventId: string | null; hostUserId: string; memberUserId: string; role: string }): Promise<void> {
  try {
    const where = p.scope === "event"
      ? sql`e.id = ${p.eventId}`
      : sql`e.host_user_id = ${p.hostUserId}`;
    const list = await rows<any>(sql`
      SELECT DISTINCT e.id, e.title, e.starts_at FROM event_team_pay p JOIN events e ON e.id = p.event_id
      WHERE ${where} AND p.member_user_id = ${p.memberUserId} AND p.role = ${p.role} AND ${PAID_SPOT} AND ${BEFORE_DEADLINE}
        AND NOT ${memberReadySql(p.memberUserId)}
      ORDER BY e.starts_at, e.id LIMIT 5`);
    for (const e of list) {
      const [claimed] = await rows<any>(sql`
        INSERT INTO event_team_setup_notices (event_id, member_user_id, last_push_at) VALUES (${e.id}, ${p.memberUserId}, now())
        ON CONFLICT (event_id, member_user_id) DO UPDATE SET last_push_at = now()
          WHERE event_team_setup_notices.last_push_at IS NULL OR event_team_setup_notices.last_push_at <= now() - interval '1 day'
        RETURNING 1 AS x`);
      if (claimed) await tell(p.memberUserId, teamCopy.setup(String(e.title)), "team_payout_setup", String(e.id), { eventId: String(e.id) }, p.hostUserId, "event");
    }
  } catch (err) {
    console.error(`[TeamPay] setup push on accept failed for ${p.memberUserId}:`, (err as Error)?.message ?? err);
  }
}

/** Step 7: they accepted a paying extra at this event and have no payout setup: the same one push a day. Never throws. */
export async function notifySetupForExtra(p: { eventId: string; memberUserId: string; hostUserId: string }): Promise<void> {
  try {
    const [e] = await rows<any>(sql`
      SELECT e.id, e.title FROM events e WHERE e.id = ${p.eventId} AND ${BEFORE_DEADLINE} AND NOT ${memberReadySql(p.memberUserId)}`);
    if (!e) return;
    const [claimed] = await rows<any>(sql`
      INSERT INTO event_team_setup_notices (event_id, member_user_id, last_push_at) VALUES (${e.id}, ${p.memberUserId}, now())
      ON CONFLICT (event_id, member_user_id) DO UPDATE SET last_push_at = now()
        WHERE event_team_setup_notices.last_push_at IS NULL OR event_team_setup_notices.last_push_at <= now() - interval '1 day'
      RETURNING 1 AS x`);
    if (claimed) await tell(p.memberUserId, teamCopy.setup(String(e.title)), "team_payout_setup", String(e.id), { eventId: String(e.id) }, p.hostUserId, "event");
  } catch (err) {
    console.error(`[TeamPay] setup push for an extra failed for ${p.memberUserId}:`, (err as Error)?.message ?? err);
  }
}

// ─── Call 23: I paid them / Got it / Not yet ────────────────────────────────

export function teamPayoutJson(r: any) {
  return {
    id: String(r.id),
    amountCents: Number(r.amount_cents),
    outcome: r.outcome as "covered" | "not_covered" | "no_setup",
    status: r.status as "pending" | "paid" | "held" | "review" | "host_to_pay",
    breakdown: r.breakdown ?? null,
    sentAt: r.status === "paid" ? iso(r.paid_at) : null,
    hostPaidAt: iso(r.host_settled_at),
    confirmedAt: iso(r.member_confirmed_at),
    notYetAt: iso(r.member_not_yet_at),
  };
}

export async function teamPayoutsForHost(eventId: string) {
  const list = await rows<any>(sql`
    SELECT r.*, u.first_name, u.username FROM event_team_payouts r JOIN users u ON u.id = r.member_user_id
    WHERE r.event_id = ${eventId} ORDER BY r.amount_cents DESC, u.username, r.id`);
  return list.map((r) => ({ ...teamPayoutJson(r), member: { userId: String(r.member_user_id), firstName: r.first_name ?? null, username: r.username ?? null } }));
}

export async function myTeamPayout(eventId: string, userId: string) {
  const [r] = await rows<any>(sql`SELECT * FROM event_team_payouts WHERE event_id = ${eventId} AND member_user_id = ${userId}`);
  return r ? teamPayoutJson(r) : null;
}

export type SettleError = { status: number; code: string; message: string };

const MESSAGES = {
  notFound: { status: 404, code: "NOT_FOUND", message: "No pay for that person at this event." },
  notHostToPay: { status: 409, code: "NOT_HOST_TO_PAY", message: "Outsyde sends this pay, so there is nothing for you to mark." },
  confirmed: { status: 409, code: "CONFIRMED", message: "They already confirmed they got it." },
  notMarked: { status: 409, code: "NOT_MARKED_PAID", message: "The host hasn't marked this as paid yet." },
} satisfies Record<string, SettleError>;

async function rowFor(eventId: string, userId: string) {
  const [r] = await rows<any>(sql`SELECT * FROM event_team_payouts WHERE event_id = ${eventId} AND member_user_id = ${userId}`);
  return r ?? null;
}

async function namesFor(event: any, memberUserId: string) {
  const [m] = await rows<any>(sql`SELECT first_name, username FROM users WHERE id = ${memberUserId}`);
  let host = "The host";
  try {
    // The full row: hostIdentity reads host_type and the profile ids (door access loads only a few columns).
    const [full] = await rows<any>(sql`SELECT * FROM events WHERE id = ${event.id}`);
    host = (await hostIdentity(full ?? event)).publicName;
  } catch { /* keep */ }
  return { member: personName(m), host };
}

/** Host taps I paid them (pay the host owes directly). A repeat changes nothing and sends nothing. */
export async function markPaid(event: any, memberUserId: string, hostUserId: string): Promise<{ payout: any } | SettleError> {
  const [r] = await rows<any>(sql`
    UPDATE event_team_payouts SET host_settled_at = now(), updated_at = now()
    WHERE event_id = ${event.id} AND member_user_id = ${memberUserId} AND status = 'host_to_pay'
      AND host_settled_at IS NULL AND member_confirmed_at IS NULL
    RETURNING *`);
  if (!r) {
    const cur = await rowFor(event.id, memberUserId);
    if (!cur) return MESSAGES.notFound;
    if (cur.status !== "host_to_pay") return MESSAGES.notHostToPay;
    return { payout: teamPayoutJson(cur) };
  }
  const n = await namesFor(event, memberUserId);
  void tell(memberUserId, teamCopy.markedPaid(n.host, String(event.title), Number(r.amount_cents)), "team_pay_marked_paid", String(r.id),
    { eventId: String(event.id), amountCents: Number(r.amount_cents) }, hostUserId);
  return { payout: teamPayoutJson(r) };
}

/** Host undoes I paid them, until the member taps Got it. */
export async function undoPaid(event: any, memberUserId: string): Promise<{ payout: any } | SettleError> {
  const [r] = await rows<any>(sql`
    UPDATE event_team_payouts SET host_settled_at = NULL, member_not_yet_at = NULL, flagged_at = NULL, updated_at = now()
    WHERE event_id = ${event.id} AND member_user_id = ${memberUserId} AND status = 'host_to_pay' AND member_confirmed_at IS NULL
    RETURNING *`);
  if (r) return { payout: teamPayoutJson(r) };
  const cur = await rowFor(event.id, memberUserId);
  if (!cur) return MESSAGES.notFound;
  if (cur.status !== "host_to_pay") return MESSAGES.notHostToPay;
  return MESSAGES.confirmed;
}

/** The member answers: Got it (final) or Not yet (the host is alerted; open 3 days -> admin). */
export async function memberAnswer(event: any, userId: string, answer: "got_it" | "not_yet"): Promise<{ payout: any } | SettleError> {
  const set = answer === "got_it"
    ? sql`member_confirmed_at = now()`
    : sql`member_not_yet_at = COALESCE(member_not_yet_at, now())`;
  const [before] = await rows<any>(sql`SELECT member_not_yet_at FROM event_team_payouts WHERE event_id = ${event.id} AND member_user_id = ${userId}`);
  const [r] = await rows<any>(sql`
    UPDATE event_team_payouts SET ${set}, updated_at = now()
    WHERE event_id = ${event.id} AND member_user_id = ${userId} AND status = 'host_to_pay'
      AND host_settled_at IS NOT NULL AND member_confirmed_at IS NULL
    RETURNING *`);
  if (!r) {
    const cur = await rowFor(event.id, userId);
    if (!cur) return MESSAGES.notFound;
    if (cur.member_confirmed_at) return MESSAGES.confirmed;
    return MESSAGES.notMarked;
  }
  const n = await namesFor(event, userId);
  const cents = Number(r.amount_cents);
  if (answer === "got_it") {
    void tell(String(event.host_user_id), teamCopy.confirmed(n.member, String(event.title), cents), "team_pay_confirmed", String(r.id), { eventId: String(event.id), amountCents: cents }, userId);
  } else if (!before?.member_not_yet_at) {
    void tell(String(event.host_user_id), teamCopy.notYet(n.member, String(event.title), cents), "team_pay_not_received", String(r.id), { eventId: String(event.id), amountCents: cents }, userId);
  }
  return { payout: teamPayoutJson(r) };
}

/** A Not yet open for 3 days and not Got it: one admin email, each once (flagged_at). Returns how many. */
export async function flagNotReceived(): Promise<number> {
  const list = await rows<any>(sql`
    UPDATE event_team_payouts r SET flagged_at = now()
    FROM events e, users u
    WHERE r.member_not_yet_at IS NOT NULL AND r.member_confirmed_at IS NULL AND r.flagged_at IS NULL
      AND r.member_not_yet_at <= now() - make_interval(days => ${NOT_RECEIVED_FLAG_DAYS}::int)
      AND e.id = r.event_id AND u.id = r.member_user_id
    RETURNING r.id, r.amount_cents, r.event_id, e.title, e.host_user_id, u.username`);
  if (!list.length) return 0;
  const lines = list.map((t) => `Team pay ${t.id}: ${t.amount_cents} cents for "${t.title}" (event ${t.event_id}), member @${t.username ?? "?"}, host user ${t.host_user_id}.`);
  await alertAdmin("Team pay not received",
    `${list.length} team members say they still haven't been paid by the host ${NOT_RECEIVED_FLAG_DAYS} days after the host marked them paid. ${lines.join(" ")}`);
  return list.length;
}

// ─── Call 21: taking someone off ────────────────────────────────────────────

export const REMOVAL_REASONS = ["late", "no_show", "unprofessional", "other"] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];
const REMOVAL_LABELS: Record<Exclude<RemovalReason, "other">, string> = { late: "Late", no_show: "No show", unprofessional: "Unprofessional conduct" };
export const REMOVAL_NOTE_MAX = 200;

/** What the person is shown: "Late", "No show", "Unprofessional conduct", or the host's note for "other". */
export function removalLabel(reason: string, note: string | null): string {
  if (reason === "other") return (note ?? "").trim() || "Other";
  return REMOVAL_LABELS[reason as Exclude<RemovalReason, "other">] ?? "Other";
}

/** ?reason= and ?note= on DELETE /door/team. Missing reason = none given (allowed unless the spot is paid). */
export function parseRemoval(reason: unknown, note: unknown):
  { ok: true; value: { reason: RemovalReason; note: string | null } | null } | { ok: false; message: string } {
  if (reason === undefined || reason === "") {
    if (note !== undefined && note !== "") return { ok: false, message: "note: only with a reason." };
    return { ok: true, value: null };
  }
  if (typeof reason !== "string" || !(REMOVAL_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, message: "reason: choose late, no_show, unprofessional or other." };
  }
  const n = typeof note === "string" ? note.trim() : note === undefined ? "" : null;
  if (n === null) return { ok: false, message: "note: text up to 200 characters." };
  if (n.length > REMOVAL_NOTE_MAX) return { ok: false, message: `note: up to ${REMOVAL_NOTE_MAX} characters.` };
  if (reason === "other" && !n) return { ok: false, message: "note: say why in a few words." };
  return { ok: true, value: { reason: reason as RemovalReason, note: n || null } };
}

/** Push + Activity: "Removed: Late". Never throws. */
export async function notifyTeamRemoved(p: { memberUserId: string; hostUserId: string; inviteId: string; scope: "standing" | "event"; eventId: string | null; label: string; what: string }): Promise<void> {
  await tell(p.memberUserId, { title: `Removed: ${p.label}`, body: `You're no longer on the Event team for ${p.what}.` }, "team_removed", p.inviteId,
    { inviteId: p.inviteId, scope: p.scope, eventId: p.eventId }, p.hostUserId, "event_door_invite");
}
