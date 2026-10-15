/**
 * Account setup emails: the 6-digit claim code, the "claim your account" reminder and the
 * "steps left" reminder. Built on the shared branded shell in emailService.ts.
 * Reminders carry a signed one-click unsubscribe link and a List-Unsubscribe header.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { Resend } from "resend";
import { wrapEmail, emailHeader, emailCta, emailFooter } from "../emailService";
import type { StepKey, SetupRole } from "./status";

const FROM = `Outsyde <${process.env.RESEND_FROM_EMAIL || "noreply@info.goutsyde.com"}>`;
export const APP_STORE_URL = "https://apps.apple.com/app/outsyde/id6738926870";

export function frontendUrl(): string {
  return (process.env.FRONTEND_URL || "https://www.goutsyde.com").replace(/\/+$/, "");
}

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL || "https://outsyde-backend.onrender.com").replace(/\/+$/, "");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ── unsubscribe signature ───────────────────────────────────────────────────

function unsubscribeSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("[accountSetup] JWT_SECRET not set");
  return s;
}

export function unsubscribeSig(userId: string): string {
  return createHmac("sha256", unsubscribeSecret()).update(`setup-unsub:${userId}`).digest("hex").slice(0, 32);
}

export function verifyUnsubscribeSig(userId: string, sig: string): boolean {
  if (typeof userId !== "string" || typeof sig !== "string" || sig.length !== 32) return false;
  const expected = Buffer.from(unsubscribeSig(userId));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function unsubscribeUrl(userId: string): string {
  return `${apiBaseUrl()}/api/account-setup/unsubscribe?u=${encodeURIComponent(userId)}&s=${unsubscribeSig(userId)}`;
}

// ── sending ─────────────────────────────────────────────────────────────────

/** Replies go to a real inbox (the From address is noreply and its domain doesn't receive mail). */
export const REPLY_TO = "info@goutsyde.com";

/** A built email, ready to send or to show in the admin preview. */
export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

async function send(params: { to: string; subject: string; html: string; text: string; unsubscribe?: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("[accountSetup] RESEND_API_KEY not set");
  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from: FROM,
    to: params.to,
    replyTo: REPLY_TO,
    subject: params.subject,
    html: params.html,
    text: params.text,
    ...(params.unsubscribe
      ? { headers: { "List-Unsubscribe": `<${params.unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }
      : {}),
  });
  if (result.error) {
    const msg = typeof result.error === "object" && result.error !== null
      ? (result.error as { message?: string }).message ?? JSON.stringify(result.error)
      : String(result.error);
    throw new Error(`Resend error: ${msg}`);
  }
}

function paragraph(html: string): string {
  return `<tr><td style="background:#1A1A1A;padding:8px 32px;"><p style="color:#DDDDDD;font-size:15px;line-height:1.6;margin:0;">${html}</p></td></tr>`;
}

function checklist(items: { label: string; done: boolean }[]): string {
  const rows = items.map((i, n) => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #2A2A2A;color:${i.done ? "#888888" : "#F5F0E8"};font-size:14px;">
      <span style="display:inline-block;width:22px;height:22px;line-height:22px;border-radius:11px;text-align:center;margin-right:10px;font-size:12px;font-weight:700;${i.done ? "background:#1A3C34;color:#E8B930;" : "border:1px solid #E8B930;color:#E8B930;"}">${i.done ? "&#10003;" : n + 1}</span>${escapeHtml(i.label)}
    </td></tr>`).join("");
  return `<tr><td style="background:#1A1A1A;padding:8px 32px;"><table width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>`;
}

function unsubFooterLine(url: string): string {
  return `<a href="${url}" style="color:#888888;">Stop these reminders</a>`;
}

/** 6-digit code sent when a passwordless account tries to sign in or asks for a code. */
export async function sendClaimCodeEmail(params: { to: string; firstName: string | null; code: string }): Promise<void> {
  const hi = params.firstName ? `Hi ${escapeHtml(params.firstName)}, your` : "Your";
  const html = wrapEmail(
    emailHeader("Your Outsyde code", "Use it to finish setting up your account") +
    paragraph(`${hi} code is:`) +
    `<tr><td style="background:#1A1A1A;padding:8px 32px 16px;"><div style="font-size:34px;font-weight:800;letter-spacing:10px;text-align:center;color:#E8B930;background:#111111;border-radius:8px;padding:18px 0;">${params.code}</div></td></tr>` +
    paragraph("It expires in 10 minutes. If you didn&#39;t try to sign in, you can ignore this email.") +
    emailFooter(),
  );
  const text = `Your Outsyde code is ${params.code}. It expires in 10 minutes. If you didn't try to sign in, ignore this email.`;
  await send({ to: params.to, subject: `${params.code} is your Outsyde code`, html, text });
}

export interface ClaimReminderParams {
  to: string; userId: string; firstName: string | null; claimUrl: string; hasUsername: boolean;
}

/** Builds the "your account is saved, claim it" reminder without sending it. */
export function renderClaimReminderEmail(params: ClaimReminderParams): BuiltEmail {
  const unsub = unsubscribeUrl(params.userId);
  const items = [
    { label: "Name, email and phone saved", done: true },
    { label: "Create your password", done: false },
    ...(params.hasUsername ? [] : [{ label: "Pick your username", done: false }]),
  ];
  const html = wrapEmail(
    emailHeader("Your account is saved", "Two minutes to finish it") +
    paragraph("We kept your details from when you joined Outsyde. To start booking, shopping and earning points, you just need a password" + (params.hasUsername ? "." : " and a username.")) +
    checklist(items) +
    emailCta("Claim my account", params.claimUrl) +
    paragraph(`This button only works for you and expires in 7 days. If it expires, sign in at ${escapeHtml(frontendUrl().replace(/^https?:\/\//, ""))} with this email and we&#39;ll send you a code. Prefer the app? <a href="${APP_STORE_URL}" style="color:#E8B930;">Get Outsyde on the App Store</a>.`) +
    emailFooter(unsubFooterLine(unsub)),
  );
  const text = `${params.firstName ? params.firstName + ", your" : "Your"} Outsyde account is saved. Finish it here: ${params.claimUrl}\n\nStop these reminders: ${unsub}`;
  const subject = `${params.firstName ? params.firstName + ", your" : "Your"} Outsyde account is ready to claim`;
  return { subject, html, text };
}

/** Reminder for accounts with no password: "your account is saved, claim it". */
export async function sendClaimReminderEmail(params: ClaimReminderParams): Promise<void> {
  const built = renderClaimReminderEmail(params);
  await send({ to: params.to, ...built, unsubscribe: unsubscribeUrl(params.userId) });
}

// ── steps left email ────────────────────────────────────────────────────────
// Copy approved by Legend 2026-10-15. House style: plain punctuation, no dashes.

/** One block per open step: a gold hook, one line, and a button to /finish. */
interface StepCopy { hook: string; line: string; button: string }

const PAYOUTS_COPY: Record<SetupRole, StepCopy> = {
  photographer: {
    hook: "Get paid for every shoot",
    line: "Clients pay you through Stripe on Outsyde. Connect it once, in about 3 minutes, and your next booking pays you directly.",
    button: "Start getting paid",
  },
  business: {
    hook: "Your customers are ready to pay",
    line: "Stripe is how bookings and orders become money in your account. Connect it and every sale on your page pays you directly.",
    button: "Turn on payments",
  },
  staff: {
    hook: "Get paid for your appointments",
    line: "Connect Stripe so what you earn on Outsyde lands in your account.",
    button: "Connect payouts",
  },
  // Consumers never get a payouts step (status.ts); kept so the map is complete.
  consumer: {
    hook: "Connect payouts",
    line: "Connect Stripe so payments on Outsyde reach your account.",
    button: "Connect payouts",
  },
};

const PLAN_COPY: StepCopy = {
  hook: "You're approved. Time to go live.",
  line: "Pick your plan and your page opens to customers on Outsyde.",
  button: "Go live",
};

const USERNAME_COPY: StepCopy = {
  hook: "Claim your name",
  line: "Your username is your address on Outsyde. It's how people find you. Grab it before someone else does.",
  button: "Claim my username",
};

export function stepCopy(key: StepKey, role: SetupRole): StepCopy | null {
  if (key === "payouts") return PAYOUTS_COPY[role];
  if (key === "plan") return PLAN_COPY;
  if (key === "username") return USERNAME_COPY;
  return null; // password and approval never appear as a block in this email
}

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five"];
function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

export interface StepsLeftParams {
  to: string; userId: string; displayName: string | null; role: SetupRole;
  steps: { key: StepKey; label: string; done: boolean }[];
  /** Business still waiting for approval (its plan and payouts steps aren't shown yet). */
  awaitingApproval?: boolean;
}

interface Framing { subject: string; heading: string; subheading: string; finishButton: string }

/** Subject, headline and main button for the email, by who it's for and what's left. */
export function stepsLeftFraming(role: SetupRole, openKeys: StepKey[], awaitingApproval: boolean): Framing {
  const left = openKeys.length;
  const steps = `${countWord(left)} step${left === 1 ? "" : "s"}`;
  const onlyUsername = left === 1 && openKeys[0] === "username";

  if (role === "business" && awaitingApproval) {
    return {
      subject: "Grab your Outsyde username while you're in review",
      heading: "You're in review.",
      subheading: "Grab your username while you wait.",
      finishButton: "Finish setup",
    };
  }
  if (onlyUsername) {
    return {
      subject: "Claim your name on Outsyde",
      heading: "One step left.",
      subheading: "It takes less than a minute.",
      finishButton: "Claim my username",
    };
  }
  if (role === "business") {
    return {
      subject: "Your Outsyde page is almost live",
      heading: "You're almost open for business.",
      subheading: `${steps} left before customers can book or buy from you.`,
      finishButton: "Finish and go live",
    };
  }
  if (role === "photographer") {
    return {
      subject: `${steps} from your first Outsyde booking`,
      heading: "You're almost bookable.",
      subheading: `${steps} left before clients can book your shoots.`,
      finishButton: "Get bookable",
    };
  }
  if (role === "staff") {
    return {
      subject: "Get paid for your appointments",
      heading: "Let's get your payouts set.",
      subheading: `${steps} left before you can take bookings and get paid.`,
      finishButton: "Finish setup",
    };
  }
  return {
    subject: "Finish your Outsyde account",
    heading: `${steps} left.`,
    subheading: "Finish your Outsyde account.",
    finishButton: "Finish setup",
  };
}

function stepBlock(copy: StepCopy, url: string): string {
  return `<tr><td style="background:#1A1A1A;padding:12px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#111111;border:1px solid #2A2A2A;border-left:3px solid #E8B930;border-radius:8px;">
      <tr><td style="padding:20px 22px;">
        <p style="color:#E8B930;font-size:17px;font-weight:800;line-height:1.3;margin:0 0 8px 0;">${escapeHtml(copy.hook)}</p>
        <p style="color:#DDDDDD;font-size:15px;line-height:1.6;margin:0 0 16px 0;">${escapeHtml(copy.line)}</p>
        <a href="${url}" style="display:inline-block;background:#1A3C34;color:#E8B930;padding:11px 24px;text-decoration:none;border-radius:6px;font-weight:700;font-size:14px;letter-spacing:0.5px;">${escapeHtml(copy.button)}</a>
      </td></tr>
    </table>
  </td></tr>`;
}

function doneRow(labels: string[]): string {
  if (labels.length === 0) return "";
  const items = labels
    .map((l) => `<span style="display:inline-block;margin:0 14px 6px 0;color:#888888;font-size:13px;"><span style="color:#E8B930;font-weight:700;">&#10003;</span>&nbsp;${escapeHtml(l)}</span>`)
    .join("");
  return `<tr><td style="background:#1A1A1A;padding:4px 32px 8px;"><p style="color:#666666;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 8px 0;">Already done</p>${items}</td></tr>`;
}

/** Builds the steps left reminder without sending it. */
export function renderStepsLeftEmail(params: StepsLeftParams): BuiltEmail {
  const unsub = unsubscribeUrl(params.userId);
  const finishUrl = `${frontendUrl()}/finish`;
  const open = params.steps.filter((s) => !s.done);
  const blocks = open
    .map((s) => ({ s, copy: stepCopy(s.key, params.role) }))
    .filter((b): b is { s: typeof open[number]; copy: StepCopy } => b.copy !== null);
  const framing = stepsLeftFraming(params.role, blocks.map((b) => b.s.key), !!params.awaitingApproval);
  const doneLabels = params.steps.filter((s) => s.done).map((s) => s.label);

  const html = wrapEmail(
    emailHeader(escapeHtml(framing.heading), escapeHtml(framing.subheading)) +
    blocks.map((b) => stepBlock(b.copy, finishUrl)).join("") +
    doneRow(doneLabels) +
    (blocks.length > 1 ? emailCta(escapeHtml(framing.finishButton), finishUrl) : "") +
    paragraph("Sign in with your email or username if asked. Forgot your password? Reset it from the sign in page. Stuck? Reply to this email and a real person answers.") +
    emailFooter(unsubFooterLine(unsub)),
  );

  const text = [
    framing.heading,
    framing.subheading,
    "",
    ...blocks.flatMap((b) => [b.copy.hook, b.copy.line, `${b.copy.button}: ${finishUrl}`, ""]),
    ...(doneLabels.length ? [`Already done: ${doneLabels.join(", ")}`, ""] : []),
    "Stuck? Reply to this email and a real person answers.",
    "",
    `Stop these reminders: ${unsub}`,
  ].join("\n");

  return { subject: framing.subject, html, text };
}

/** Reminder for signed-up accounts with steps left (plan, payouts, username). */
export async function sendStepsLeftEmail(params: StepsLeftParams): Promise<void> {
  const built = renderStepsLeftEmail(params);
  await send({ to: params.to, ...built, unsubscribe: unsubscribeUrl(params.userId) });
}
