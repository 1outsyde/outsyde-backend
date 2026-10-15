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

async function send(params: { to: string; subject: string; html: string; text: string; unsubscribe?: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("[accountSetup] RESEND_API_KEY not set");
  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from: FROM,
    to: params.to,
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

/** Reminder for accounts with no password: "your account is saved, claim it". */
export async function sendClaimReminderEmail(params: {
  to: string; userId: string; firstName: string | null; claimUrl: string; hasUsername: boolean;
}): Promise<void> {
  const unsub = unsubscribeUrl(params.userId);
  const name = params.firstName ? `${escapeHtml(params.firstName)}, your` : "Your";
  const items = [
    { label: "Name, email & phone — saved", done: true },
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
  await send({ to: params.to, subject: `${params.firstName ? params.firstName + ", your" : "Your"} Outsyde account is ready to claim`, html, text, unsubscribe: unsub });
}

const ROLE_GOAL: Record<SetupRole, string> = {
  business: "customers can book or buy from you",
  photographer: "clients can book your shoots",
  staff: "you can take bookings and get paid",
  consumer: "your account is complete",
};

/** Reminder for signed-up accounts with steps left (plan, payouts, username). */
export async function sendStepsLeftEmail(params: {
  to: string; userId: string; displayName: string | null; role: SetupRole;
  steps: { key: StepKey; label: string; done: boolean }[];
}): Promise<void> {
  const unsub = unsubscribeUrl(params.userId);
  const left = params.steps.filter((s) => !s.done).length;
  const who = params.displayName ? escapeHtml(params.displayName) : "Your account";
  const subject = `${params.displayName ?? "Your account"}: ${left} step${left === 1 ? "" : "s"} left${params.role === "consumer" ? "" : ` before ${ROLE_GOAL[params.role]}`}`;
  const finishUrl = `${frontendUrl()}/finish`;
  const html = wrapEmail(
    emailHeader(`${who}: ${left} step${left === 1 ? "" : "s"} left`, params.role === "consumer" ? "Finish your Outsyde account" : `So ${ROLE_GOAL[params.role]}`) +
    paragraph("Each step takes a few minutes, and the checklist walks you through them in order.") +
    checklist(params.steps.map((s) => ({ label: s.label, done: s.done }))) +
    emailCta("Finish my setup", finishUrl) +
    paragraph("Sign in with your email or username if asked. Forgot your password? Reset it from the sign-in page. Stuck? Reply to info@goutsyde.com and a real person answers.") +
    emailFooter(unsubFooterLine(unsub)),
  );
  const text = `${subject}\n\nFinish your setup: ${finishUrl}\n\nStop these reminders: ${unsub}`;
  await send({ to: params.to, subject, html, text, unsubscribe: unsub });
}
