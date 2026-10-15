/**
 * Account setup reminders — email (and push when the person has the app) for accounts that still
 * have steps left. Schedule: reminder 1 once the account is a day old, then 3, 7 and 14 days after
 * reminder 1, then stop. Each run re-checks the account, so anyone who finishes stops immediately.
 *
 * The hourly job does nothing unless ACCOUNT_SETUP_REMINDERS_ENABLED === "true".
 * Admins can preview (dry run) and send manually through /api/admin/account-setup.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { sendExpoPush } from "../expoPushService";
import { getAccountSetupStatus, type SetupStatus, type StepKey } from "./status";
import { issueClaimLinkToken, firstNameOf } from "./claim";
import { sendClaimReminderEmail, sendStepsLeftEmail, frontendUrl } from "./emails";

export const MAX_REMINDERS = 4;
/** Days after reminder 1 at which reminders 2, 3 and 4 are due. */
export const FOLLOW_UP_DAYS = [3, 7, 14] as const;
export const FIRST_REMINDER_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const SEND_WINDOW = { startHour: 10, endHour: 19, timeZone: "America/New_York" } as const;

export type Template = "claim" | "steps_left";

export interface ReminderLog {
  count: number;
  firstSentAt: Date | null;
  lastSentAt: Date | null;
}

export interface PlanInput {
  createdAt: Date;
  status: SetupStatus;
  log: ReminderLog;
  optedOut: boolean;
  now: Date;
}

export interface PlannedReminder {
  reminderNumber: number;
  template: Template;
  actionable: StepKey[];
}

/** Pure: is a reminder due for this account right now, and which one? */
export function planReminder(input: PlanInput): PlannedReminder | null {
  if (input.optedOut) return null;
  const actionable = input.status.steps.filter((s) => s.state === "todo").map((s) => s.key);
  if (actionable.length === 0) return null;
  const { count, firstSentAt, lastSentAt } = input.log;
  if (count >= MAX_REMINDERS) return null;
  const now = input.now.getTime();

  if (count === 0) {
    if (now - input.createdAt.getTime() < FIRST_REMINDER_MIN_AGE_MS) return null;
  } else {
    if (!firstSentAt) return null;
    const dueAt = firstSentAt.getTime() + FOLLOW_UP_DAYS[count - 1] * DAY_MS;
    if (now < dueAt) return null;
    if (lastSentAt && now - lastSentAt.getTime() < DAY_MS) return null; // never two in one day
  }

  return {
    reminderNumber: count + 1,
    template: actionable.includes("password") ? "claim" : "steps_left",
    actionable,
  };
}

/** Pure: is `now` inside the 10:00–19:00 New York sending window? */
export function inSendWindow(now: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: SEND_WINDOW.timeZone }).format(now),
  ) % 24;
  return hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour;
}

const PUSH_COPY: Partial<Record<StepKey, (name: string) => { title: string; body: string }>> = {
  payouts: (name) => ({ title: "You're 1 step from getting paid", body: `Connect payouts so customers can book ${name}. Tap to finish — about 3 minutes.` }),
  plan: (name) => ({ title: "Choose your plan to go live", body: `${name} is approved. Pick a plan so customers can book and buy. Tap to finish.` }),
  username: () => ({ title: "Pick your username", body: "Finish your Outsyde profile so people can find you. Tap to finish." }),
};

interface CandidateRow {
  id: string;
  email: string;
  name: string | null;
  first_name: string | null;
  username: string | null;
  created_at: string | Date;
  expo_push_token: string | null;
  display_name: string | null;
  opted_out: boolean;
  sent_count: number;
  first_sent_at: string | Date | null;
  last_sent_at: string | Date | null;
}

async function loadCandidates(): Promise<CandidateRow[]> {
  const result = await db.execute<CandidateRow & Record<string, unknown>>(sql`
    SELECT u.id, u.email, u.name, u.first_name, u.username, u.created_at, u.expo_push_token,
           COALESCE(b.name, p.display_name, u.name) AS display_name,
           (o.user_id IS NOT NULL) AS opted_out,
           COALESCE(r.sent_count, 0)::int AS sent_count, r.first_sent_at, r.last_sent_at
    FROM users u
    LEFT JOIN businesses b ON b.owner_id = u.id
    LEFT JOIN photographers p ON p.user_id = u.id
    LEFT JOIN account_setup_optouts o ON o.user_id = u.id
    LEFT JOIN (
      SELECT user_id, count(*) AS sent_count, min(sent_at) AS first_sent_at, max(sent_at) AS last_sent_at
      FROM account_setup_reminders GROUP BY user_id
    ) r ON r.user_id = u.id
    WHERE u.email IS NOT NULL
      AND u.is_admin = false
      AND u.is_active = true
      AND u.deletion_status = 'active'
      AND u.id NOT ILIKE 'demo%'
      AND COALESCE(b.is_demo, false) = false
      AND COALESCE(p.is_demo, false) = false
      AND COALESCE(b.approval_status, 'approved') <> 'rejected'
  `);
  return result.rows as CandidateRow[];
}

export interface ReminderResult {
  userId: string;
  email: string;
  displayName: string | null;
  role: SetupStatus["role"];
  reminderNumber: number;
  template: Template;
  steps: StepKey[];
  channels: ("email" | "push")[];
  outcome: "planned" | "sent" | "failed" | "skipped_recently_claimed";
  error?: string;
}

/**
 * Finds every account with a reminder due and (unless dryRun) sends it.
 * The log row is written first (unique per user + reminder number) so two runs can't double-send;
 * if the email fails the row is removed so the next run retries.
 */
export async function sendDueReminders(opts: { dryRun: boolean; now?: Date }): Promise<ReminderResult[]> {
  const now = opts.now ?? new Date();
  const results: ReminderResult[] = [];
  const candidates = await loadCandidates();

  for (const c of candidates) {
    // A dry run (admin preview) must write nothing, so it skips the Stripe self-heal, which updates
    // onboarding flags. A real run self-heals first so nobody is reminded about a step they finished.
    const status = await getAccountSetupStatus(c.id, { syncStripe: !opts.dryRun }).catch((err) => {
      console.error(`[SetupReminders] status failed for ${c.id}:`, err);
      return null;
    });
    if (!status) continue;

    const planned = planReminder({
      createdAt: new Date(c.created_at),
      status,
      optedOut: c.opted_out,
      now,
      log: {
        count: Number(c.sent_count) || 0,
        firstSentAt: c.first_sent_at ? new Date(c.first_sent_at) : null,
        lastSentAt: c.last_sent_at ? new Date(c.last_sent_at) : null,
      },
    });
    if (!planned) continue;

    const pushStep = planned.actionable.find((k) => PUSH_COPY[k]);
    const canPush = planned.template === "steps_left" && !!c.expo_push_token && !!pushStep;
    const result: ReminderResult = {
      userId: c.id,
      email: c.email,
      displayName: c.display_name,
      role: status.role,
      reminderNumber: planned.reminderNumber,
      template: planned.template,
      steps: planned.actionable,
      channels: canPush ? ["email", "push"] : ["email"],
      outcome: "planned",
    };

    if (opts.dryRun) {
      results.push(result);
      continue;
    }

    const claimed = await db.execute(sql`
      INSERT INTO account_setup_reminders (user_id, template, reminder_number, channels, steps)
      VALUES (${c.id}, ${planned.template}, ${planned.reminderNumber},
              ${`{${result.channels.join(",")}}`}::text[], ${`{${planned.actionable.join(",")}}`}::text[])
      ON CONFLICT (user_id, reminder_number) DO NOTHING
      RETURNING id
    `);
    if (claimed.rows.length === 0) {
      result.outcome = "skipped_recently_claimed";
      results.push(result);
      continue;
    }
    const logId = (claimed.rows[0] as { id: string }).id;

    try {
      if (planned.template === "claim") {
        const user = await storage.getUser(c.id);
        if (!user) throw new Error("user disappeared");
        const token = await issueClaimLinkToken(user);
        const claimUrl = `${frontendUrl()}/claim?token=${encodeURIComponent(token)}&email=${encodeURIComponent(c.email)}`;
        await sendClaimReminderEmail({
          to: c.email,
          userId: c.id,
          firstName: c.first_name ?? firstNameOf(c.name),
          claimUrl,
          hasUsername: !!c.username,
        });
      } else {
        await sendStepsLeftEmail({
          to: c.email,
          userId: c.id,
          displayName: c.display_name,
          role: status.role,
          steps: status.steps
            .filter((s) => s.state !== "waiting" && s.key !== "password")
            .map((s) => ({ key: s.key, label: s.label, done: s.state === "done" })),
        });
      }
      result.outcome = "sent";
    } catch (err) {
      result.outcome = "failed";
      result.error = err instanceof Error ? err.message : String(err);
      await db.execute(sql`DELETE FROM account_setup_reminders WHERE id = ${logId}`).catch(() => {});
      console.error(`[SetupReminders] email failed for ${c.id}:`, err);
    }

    if (result.outcome === "sent" && canPush && pushStep) {
      const copy = PUSH_COPY[pushStep]!(c.display_name || "your business");
      await sendExpoPush({
        userId: c.id,
        title: copy.title,
        body: copy.body,
        data: { type: "account_setup", screen: "FinishSetup", step: pushStep },
      }).catch(() => false);
    }

    results.push(result);
  }

  return results;
}

let started = false;

/** Hourly; a no-op unless ACCOUNT_SETUP_REMINDERS_ENABLED === "true". Sends only 10:00–19:00 New York time. */
export function startAccountSetupReminderJob(intervalMs = 60 * 60 * 1000): void {
  if (started) return;
  started = true;
  const run = async () => {
    if (process.env.ACCOUNT_SETUP_REMINDERS_ENABLED !== "true") return;
    if (!inSendWindow(new Date())) return;
    try {
      const results = await sendDueReminders({ dryRun: false });
      const sent = results.filter((r) => r.outcome === "sent").length;
      const failed = results.filter((r) => r.outcome === "failed").length;
      if (sent || failed) console.log(`[SetupReminders] run: ${sent} sent, ${failed} failed`);
    } catch (err) {
      console.error("[SetupReminders] run failed:", err);
    }
  };
  setInterval(run, intervalMs);
}
