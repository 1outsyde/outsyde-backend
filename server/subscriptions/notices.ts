/**
 * Subscription notices (step 1.0b): vendor emails, phone push, in-app notifications, and a copy of
 * every subscription event to Outsyde (ADMIN_NOTIFICATION_EMAIL).
 *
 * Decided by Legend 2026-10-19: vendors get only Outsyde's emails (Stripe's failed payment emails are
 * turned off), and Legend is told about every subscription event.
 *
 * Every notice is claimed in subscription_notices first (unique per subscription, kind and ref), so a
 * webhook retry, a duplicate event or the hourly job never sends the same notice twice.
 * Nothing here throws: a failed email or push never undoes a subscription change.
 *
 * Copy rules: real punctuation, no dashes, never the service fee percentage.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { escapeHtml } from "../adminApplicationDetails";
import { SUBSCRIPTION_GRACE_DAYS, graceEndsAt } from "./policy";

export type SubscriptionEvent =
  | "activated"        // new paid plan started (checkout, one tap, or an accepted plan offer)
  | "free_started"     // the Free plan started from an accepted plan offer
  | "renewed"          // renewal invoice paid
  | "plan_switched"    // vendor moved to another paid plan
  | "payment_failed"   // a payment did not go through: plan is late, grace starts
  | "action_required"  // the bank wants the vendor to confirm the payment
  | "grace_reminder"   // listings pause soon
  | "paused"           // grace ran out: listings and benefits paused
  | "restored"         // paid again after being late or paused
  | "ended";           // Stripe ended the subscription

export const MANAGE_PLAN_URL = "https://www.goutsyde.com/subscription/manage";
export const CHOOSE_PLAN_URL = "https://www.goutsyde.com/subscription";

export interface NoticeContext {
  vendorSubscriptionId: string;
  vendorId: string;
  businessId: string;
  businessName: string;
  ownerEmail: string | null;
  ownerFirstName: string | null;
  planName: string;
  stripeSubscriptionId: string | null;
}

export interface NoticeDetails {
  amountCents?: number | null;
  /** Hosted invoice page (payment confirmation) when Stripe gives one. */
  invoiceUrl?: string | null;
  invoiceId?: string | null;
  pastDueSince?: Date | null;
  periodEnd?: Date | null;
  previousPlanName?: string | null;
  pausedItems?: number;
  restoredItems?: number;
  /** Set when a paid plan starts on a free trial (Grandfathered over a dated Free plan): first charge date. */
  billingStartsAt?: Date | null;
  /** Free plan end; null with `permanent` true. */
  freeEndsAt?: Date | null;
  permanent?: boolean;
}

export interface NoticeDeps {
  sendEmail: (p: { to: string; subject: string; html: string; log?: { kind: "subscription"; label: string } }) => Promise<boolean>;
  sendPush: (p: { userId: string; title: string; body: string; data?: Record<string, string> }) => Promise<boolean>;
  createInApp: (p: { userId: string; type: string; title: string; message: string; referenceId: string; metadata?: Record<string, unknown> }) => Promise<void>;
  adminEmail: string;
}

let testDeps: NoticeDeps | null = null;
/** Tests only: route every notice to these senders (null restores the real ones). */
export function setSubscriptionNoticeDepsForTest(d: NoticeDeps | null) { testDeps = d; }

/** The senders every notice uses (the test overrides included). Plan offer notices share them. */
export async function noticeDeps(): Promise<NoticeDeps> {
  if (testDeps) return testDeps;
  const email = await import("../emailService");
  const push = await import("../expoPushService");
  return {
    sendEmail: (p) => email.sendAdminEmail(p),
    sendPush: (p) => push.sendExpoPush(p),
    createInApp: async (p) => {
      await storage.createNotification({
        userId: p.userId, type: p.type as any, title: p.title, message: p.message,
        referenceType: "vendor_subscription", referenceId: p.referenceId, metadata: p.metadata,
      } as any);
    },
    adminEmail: email.ADMIN_NOTIFICATION_EMAIL,
  };
}

/** Claims a notice. Returns true only the first time for this (subscription, kind, ref). */
export async function claimNotice(vendorSubscriptionId: string, kind: string, ref: string): Promise<boolean> {
  const r = await db.execute(sql`
    INSERT INTO subscription_notices (vendor_subscription_id, kind, ref)
    VALUES (${vendorSubscriptionId}, ${kind}, ${ref})
    ON CONFLICT (vendor_subscription_id, kind, ref) DO NOTHING
    RETURNING id`);
  return r.rows.length > 0;
}

/** Owner, business and plan names for a vendor_subscriptions row. */
export async function loadNoticeContext(vs: { id: string; vendorId: string; businessId: string; tierId: string; stripeSubscriptionId: string | null }): Promise<NoticeContext> {
  const r = await db.execute(sql`
    SELECT b.name AS business_name, u.email AS owner_email, u.first_name AS owner_first_name,
           coalesce(t.display_name, t.name) AS plan_name
    FROM businesses b
    LEFT JOIN users u ON u.id = b.owner_id
    LEFT JOIN subscription_tiers t ON t.id = ${vs.tierId}
    WHERE b.id = ${vs.businessId}`);
  const row = (r.rows[0] ?? {}) as Record<string, string | null>;
  return {
    vendorSubscriptionId: vs.id,
    vendorId: vs.vendorId,
    businessId: vs.businessId,
    businessName: (row.business_name ?? "your business").trim(),
    ownerEmail: row.owner_email ?? null,
    ownerFirstName: row.owner_first_name ?? null,
    planName: row.plan_name ?? "Outsyde",
    stripeSubscriptionId: vs.stripeSubscriptionId,
  };
}

// ─── Copy ────────────────────────────────────────────────────────────────────

const money = (c?: number | null) => (typeof c === "number" ? `$${(c / 100).toFixed(2)}` : null);
const day = (d?: Date | null) =>
  d ? d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }) : null;

interface VendorCopy {
  subject: string;
  heading: string;
  lead: string;
  body: string;
  cta: { label: string; url: string } | null;
  push: { title: string; body: string };
  /** null when the caller already writes the in-app notification (checkout activation). */
  inApp: { type: string; title: string; message: string } | null;
}

export const VENDOR_DASHBOARD_URL = "https://www.goutsyde.com/vendor-dashboard";

/** What the vendor receives, or null when the event is for Outsyde only. Pure, for tests. */
export function vendorCopy(event: SubscriptionEvent, ctx: NoticeContext, d: NoticeDetails = {}): VendorCopy | null {
  const hi = ctx.ownerFirstName ? `Hi ${ctx.ownerFirstName},` : "Hi,";
  const biz = ctx.businessName;
  const plan = ctx.planName;
  const amount = money(d.amountCents);
  const deadline = d.pastDueSince ? day(graceEndsAt(d.pastDueSince)) : null;
  switch (event) {
    case "payment_failed":
      return {
        subject: "Your Outsyde plan payment didn't go through",
        heading: "Payment not received",
        lead: `${hi} we couldn't take the payment for your ${plan} plan.`,
        body: `We tried to charge ${amount ? `${amount} ` : ""}for ${biz}'s ${plan} plan and the payment didn't go through. Your listings are still live for now. Please update your card${deadline ? ` by ${deadline}` : ` within ${SUBSCRIPTION_GRACE_DAYS} days`} so customers can keep finding and booking you.`,
        cta: { label: "Update payment", url: MANAGE_PLAN_URL },
        push: { title: "Plan payment didn't go through", body: `Update your card so ${biz} stays live.` },
        inApp: { type: "payment_failed", title: "Plan payment didn't go through", message: `We couldn't take the payment for your ${plan} plan. Update your card${deadline ? ` by ${deadline}` : ""} so your listings stay live.` },
      };
    case "action_required":
      return {
        subject: "Confirm your Outsyde plan payment",
        heading: "Your bank needs you to confirm",
        lead: `${hi} one more step for your ${plan} plan payment.`,
        body: `Your bank asked you to confirm the ${amount ? `${amount} ` : ""}payment for ${biz}'s ${plan} plan. It only takes a moment, and your plan stays active once it's confirmed.`,
        cta: { label: "Confirm payment", url: d.invoiceUrl || MANAGE_PLAN_URL },
        push: { title: "Confirm your plan payment", body: "Your bank needs you to confirm it." },
        inApp: { type: "payment_failed", title: "Confirm your plan payment", message: `Your bank needs you to confirm the payment for your ${plan} plan.` },
      };
    case "grace_reminder":
      return {
        subject: "Your Outsyde listings pause soon",
        heading: "Your listings pause soon",
        lead: `${hi} we still haven't received the payment for your ${plan} plan.`,
        body: `${deadline ? `On ${deadline}` : "Soon"}, ${biz}'s products and services will be paused and customers won't be able to find or book you until the plan is paid. Update your card now to keep everything live.`,
        cta: { label: "Update payment", url: MANAGE_PLAN_URL },
        push: { title: "Your listings pause soon", body: `Update your card so ${biz} stays live.` },
        inApp: { type: "payment_failed", title: "Your listings pause soon", message: `Update your card${deadline ? ` before ${deadline}` : ""} so your listings stay live.` },
      };
    case "paused":
      return {
        subject: "Your Outsyde listings are paused",
        heading: "Your listings are paused",
        lead: `${hi} the payment for your ${plan} plan still hasn't come through.`,
        body: `${biz}'s products and services are paused, so customers can't find or book you right now. Anything customers already paid for still goes through. As soon as your plan is paid, everything goes live again on its own.`,
        cta: { label: "Update payment", url: MANAGE_PLAN_URL },
        push: { title: "Your listings are paused", body: "Pay your plan and they go live again." },
        inApp: { type: "subscription_canceled", title: "Your listings are paused", message: `Your ${plan} plan payment hasn't come through, so your listings are paused. Pay your plan and they go live again.` },
      };
    case "ended":
      return {
        subject: "Your Outsyde plan has ended",
        heading: "Your plan has ended",
        lead: `${hi} your ${plan} plan for ${biz} has ended.`,
        body: `${biz}'s products and services are paused, so customers can't find or book you right now. Anything customers already paid for still goes through. Choose a plan any time and everything goes live again.`,
        cta: { label: "Choose a plan", url: CHOOSE_PLAN_URL },
        push: { title: "Your Outsyde plan has ended", body: "Choose a plan to go live again." },
        inApp: { type: "subscription_canceled", title: "Your plan has ended", message: `Your ${plan} plan has ended and your listings are paused. Choose a plan to go live again.` },
      };
    case "restored":
      return {
        subject: "You're back live on Outsyde",
        heading: "You're back live",
        lead: `${hi} thanks, your ${plan} plan is paid.`,
        body: `${biz} is live again${d.restoredItems ? `, and the ${d.restoredItems} ${d.restoredItems === 1 ? "listing" : "listings"} we paused are back up` : ""}. Customers can find and book you as usual.`,
        cta: { label: "Open dashboard", url: "https://www.goutsyde.com/vendor-dashboard" },
        push: { title: "You're back live", body: `Your ${plan} plan is paid.` },
        inApp: { type: "subscription_activated", title: "You're back live", message: `Your ${plan} plan is paid and your listings are live again.` },
      };
    case "activated":
      return {
        subject: "You're live on Outsyde",
        heading: `Your ${plan} plan is active`,
        lead: `${hi} thanks, your ${plan} plan for ${biz} is active.`,
        body: d.billingStartsAt
          ? `Your free plan covers you until then, and billing starts on ${day(d.billingStartsAt)}. If you haven't set up payouts yet, do it from your dashboard so customers' payments reach you.`
          : `${amount ? `We charged ${amount}. ` : ""}${d.periodEnd ? `Your plan renews on ${day(d.periodEnd)}. ` : ""}If you haven't set up payouts yet, do it from your dashboard so customers' payments reach you.`,
        cta: { label: "Open dashboard", url: VENDOR_DASHBOARD_URL },
        push: { title: "You're live on Outsyde", body: `Your ${plan} plan is active.` },
        inApp: null, // NotificationTriggers.subscriptionActivated already writes it
      };
    case "free_started": {
      const until = d.permanent || !d.freeEndsAt ? "with no end date" : `until ${day(d.freeEndsAt)}`;
      return {
        subject: "Your free Outsyde plan is active",
        heading: "Your free plan is active",
        lead: `${hi} your plan for ${biz} is on us.`,
        body: `Outsyde is covering ${biz}'s plan ${until}. There's nothing to pay for the plan. If you haven't set up payouts yet, do it from your dashboard so customers' payments reach you.`,
        cta: { label: "Open dashboard", url: VENDOR_DASHBOARD_URL },
        push: { title: "Your free plan is active", body: `Outsyde is covering ${biz}'s plan.` },
        inApp: { type: "subscription_activated", title: "Your free plan is active", message: `Outsyde is covering your plan ${until}.` },
      };
    }
    default:
      return null; // renewed, plan_switched: in-app already exists; Outsyde gets the copy
  }
}

const ADMIN_TITLE: Record<SubscriptionEvent, string> = {
  activated: "New plan started",
  free_started: "Free plan started",
  renewed: "Renewal paid",
  plan_switched: "Plan switched",
  payment_failed: "Payment failed, plan is late",
  action_required: "Payment needs the vendor to confirm",
  grace_reminder: "Reminder sent, listings pause soon",
  paused: "Listings paused",
  restored: "Back live",
  ended: "Plan ended",
};

/** The copy Outsyde receives for every event. Pure, for tests. */
export function adminCopy(event: SubscriptionEvent, ctx: NoticeContext, d: NoticeDetails = {}, vendorSubject?: string | null) {
  const rows: [string, string | null | undefined][] = [
    ["Business", ctx.businessName],
    ["Owner", ctx.ownerEmail],
    ["Plan", d.previousPlanName ? `${d.previousPlanName} to ${ctx.planName}` : ctx.planName],
    ["Amount", money(d.amountCents)],
    ["Late since", day(d.pastDueSince)],
    ["Listings pause on", event === "payment_failed" || event === "grace_reminder" ? day(d.pastDueSince ? graceEndsAt(d.pastDueSince) : null) : null],
    ["Paid until", day(d.periodEnd)],
    ["Billing starts", day(d.billingStartsAt)],
    ["Free until", event === "free_started" ? (d.permanent || !d.freeEndsAt ? "No end date" : day(d.freeEndsAt)) : null],
    ["Listings paused", d.pausedItems ? String(d.pausedItems) : null],
    ["Listings restored", d.restoredItems ? String(d.restoredItems) : null],
    ["Stripe subscription", ctx.stripeSubscriptionId],
    ["Invoice", d.invoiceId],
    ["Vendor was sent", vendorSubject ? `"${vendorSubject}"` : null],
  ];
  const subject = `[Subscription] ${ctx.businessName}: ${ADMIN_TITLE[event]}`;
  return { subject, heading: ADMIN_TITLE[event], rows: rows.filter(([, v]) => v) as [string, string][] };
}

async function renderVendorHtml(c: VendorCopy): Promise<string> {
  const e = await import("../emailService");
  return e.wrapEmail(`
    ${e.emailHeader(escapeHtml(c.heading), escapeHtml(c.lead))}
    <tr><td style="background:#1A1A1A;padding:8px 32px 4px;">
      <p style="color:#F5F0E8;font-size:14px;line-height:1.6;margin:0;">${escapeHtml(c.body)}</p>
    </td></tr>
    ${c.cta ? e.emailCta(escapeHtml(c.cta.label), escapeHtml(c.cta.url)) : ""}
    ${e.emailFooter()}
  `);
}

async function renderAdminHtml(a: ReturnType<typeof adminCopy>): Promise<string> {
  const e = await import("../emailService");
  const rows = a.rows.map(([k, v], i) => `<tr style="background:${i % 2 ? "#212121" : "#1A1A1A"};">
      <td style="padding:10px 14px;color:#E8B930;font-size:13px;font-weight:600;width:40%;">${escapeHtml(k)}</td>
      <td style="padding:10px 14px;color:#FFFFFF;font-size:14px;">${escapeHtml(v)}</td></tr>`).join("");
  return e.wrapEmail(`
    ${e.emailHeader(escapeHtml(a.heading), "Subscription update")}
    <tr><td style="background:#1A1A1A;padding:0 32px 16px;"><table width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
    ${e.emailFooter()}
  `);
}

/**
 * Sends one subscription event, at most once per (subscription, event, ref): vendor email, phone push
 * and in-app notification when the event is for the vendor, and always the copy to Outsyde.
 * Returns true when this call sent it, false when it had already been sent (or nothing could be claimed).
 */
export async function sendSubscriptionNotice(
  event: SubscriptionEvent,
  ref: string,
  ctx: NoticeContext,
  details: NoticeDetails = {},
): Promise<boolean> {
  try {
    if (!(await claimNotice(ctx.vendorSubscriptionId, event, ref))) return false;
  } catch (err) {
    console.error(`[SubscriptionNotice] could not claim ${event} for ${ctx.vendorSubscriptionId}:`, err instanceof Error ? err.message : err);
    return false;
  }
  const d = await noticeDeps();
  const copy = vendorCopy(event, ctx, details);
  if (copy) {
    if (ctx.ownerEmail) {
      try {
        await d.sendEmail({ to: ctx.ownerEmail, subject: copy.subject, html: await renderVendorHtml(copy), log: { kind: "subscription", label: `Plan ${event.replace(/_/g, " ")} (vendor)` } });
      } catch (err) { console.error(`[SubscriptionNotice] vendor email ${event} failed:`, err); }
    }
    try { await d.sendPush({ userId: ctx.vendorId, title: copy.push.title, body: copy.push.body, data: { type: `subscription_${event}`, screen: "subscription" } }); }
    catch (err) { console.error(`[SubscriptionNotice] push ${event} failed:`, err); }
    if (copy.inApp) {
      try { await d.createInApp({ userId: ctx.vendorId, type: copy.inApp.type, title: copy.inApp.title, message: copy.inApp.message, referenceId: ctx.vendorSubscriptionId, metadata: { event } }); }
      catch (err) { console.error(`[SubscriptionNotice] in-app ${event} failed:`, err); }
    }
  }
  try {
    const a = adminCopy(event, ctx, details, copy?.subject ?? null);
    await d.sendEmail({ to: d.adminEmail, subject: a.subject, html: await renderAdminHtml(a) });
  } catch (err) { console.error(`[SubscriptionNotice] admin copy ${event} failed:`, err); }
  return true;
}
