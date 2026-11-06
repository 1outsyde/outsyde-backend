/**
 * Quotes step 6a (no migration, notifications.type is free text). Rules and words: ./quoteNoticesRules.ts.
 *
 * Legend 2026-11-05 (step 6 calls 3, 4 and 6, all as recommended):
 *   - The customer gets an Activity row for each extra (type quote_extra, reference the extra), done once the extra
 *     is answered or closed, and an email at once when quote emails are on (QUOTE_EMAILS_ENABLED=true).
 *   - The business (the quote's sender, who gets its chat cards) gets Activity rows for a quote paid, an extra approved
 *     or declined, a problem reported and a card that couldn't be held. Only the last also pushes: the others already
 *     push through their chat card. That push is a message push (type new_message), so every app version opens the chat.
 * Every notice is best effort: it never fails the money step it follows. Blocked either way: nothing.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import type { Quote, QuoteExtra } from "@shared/schema";
import { buildExtraEmail, businessNotice, extraActivityText, type BusinessNoticeKind } from "./quoteNoticesRules";

async function rows<T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result: any = await db.execute(query);
  return (result?.rows ?? result ?? []) as T[];
}

type Push = { userId: string; title: string; body: string; data?: Record<string, string> };
type Mail = { to: string; subject: string; text: string; html: string };
export interface QuoteNoticeDeps {
  sendPush: (p: Push) => Promise<boolean>;
  sendEmail: (m: Mail) => Promise<boolean>;
}
let testDeps: QuoteNoticeDeps | null = null;
/** Tests: capture the pushes and emails sent from this process (null restores the real senders). */
export function setQuoteNoticeDepsForTest(d: QuoteNoticeDeps | null): void { testDeps = d; }
async function deps(): Promise<QuoteNoticeDeps> {
  if (testDeps) return testDeps;
  const push = await import("../expoPushService");
  const email = await import("../emailService");
  return {
    sendPush: (p) => push.sendExpoPush(p),
    sendEmail: (m) => email.sendAdminEmail({ to: m.to, subject: m.subject, html: m.html, text: m.text, log: { kind: "booking", label: "Quote extra" } }),
  };
}

/**
 * Adds an Activity row unless one is already there for this person, type and reference (unreadOnly: unless an unread
 * one is). Returns true only when this call added it, so whatever follows (email, push) happens once.
 */
async function addRow(o: { userId: string; type: string; title: string; message: string; referenceId: string; metadata: Record<string, string>; unreadOnly?: boolean }): Promise<boolean> {
  const [r] = await rows<{ id: string }>(sql`
    INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id, metadata)
    SELECT ${o.userId}, ${o.type}, ${o.title}, ${o.message}, 'quote', ${o.referenceId}, ${JSON.stringify(o.metadata)}::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = ${o.userId} AND type = ${o.type} AND reference_id = ${o.referenceId}
                         AND (${!o.unreadOnly} OR is_read = false))
    RETURNING id`);
  return !!r;
}

/** The business sent an extra: the customer's Activity row and (quote emails on) the email. Once per extra. */
export async function noticeExtraProposed(q: Quote, extra: Pick<QuoteExtra, "id" | "description" | "amountCents" | "appointmentId">): Promise<void> {
  try {
    if (await storage.isUserBlockedEitherWay(q.senderId, q.customerId)) return;
    const { quoteExtraSplit } = await import("../fees");
    const fee = quoteExtraSplit(extra.amountCents).serviceFeeCents;
    const businessName = (await storage.getBusiness(q.businessId))?.name ?? "";
    const words = extraActivityText({ businessName, title: q.title, description: extra.description, totalCents: extra.amountCents + fee });
    const added = await addRow({
      userId: q.customerId, type: "quote_extra", ...words, referenceId: extra.id,
      metadata: { quoteId: q.id, extraId: extra.id, conversationId: q.conversationId, screen: "chat" },
    });
    if (!added || process.env.QUOTE_EMAILS_ENABLED !== "true") return;
    const customer = await storage.getUser(q.customerId);
    if (!customer?.email) return;
    const [a] = await rows<{ cents: number }>(sql`
      SELECT COALESCE(SUM(amount_cents), 0)::int AS cents FROM quote_extras WHERE appointment_id = ${extra.appointmentId} AND status = 'approved' AND id <> ${extra.id}`);
    const { quoteLink } = await import("./quoteEmail");
    const mail = buildExtraEmail({
      customerFirstName: (customer as any).firstName ?? null, businessName, title: q.title, description: extra.description,
      amountCents: extra.amountCents, serviceFeeCents: fee, totalBeforeCents: q.totalCents + Number(a?.cents ?? 0), link: quoteLink(q),
    });
    const ok = await (await deps()).sendEmail({ to: customer.email, ...mail }).catch(() => false);
    if (!ok) console.error(`[quote notices] extra email for ${extra.id} was not sent`);
  } catch (err) {
    console.error(`[quote notices] extra ${extra.id} notice failed:`, err);
  }
}

/** The extra was answered or closed: its Activity row is done. */
export async function closeExtraNotice(extraId: string): Promise<void> {
  await rows(sql`UPDATE notifications SET is_read = true, read_at = now() WHERE type = 'quote_extra' AND reference_id = ${extraId} AND is_read = false`)
    .catch((err) => console.error(`[quote notices] closing ${extraId} failed:`, err));
}

/** The safety net (with the extras job): rows for extras closed some other way (lapsed, canceled). */
export async function sweepExtraNotices(): Promise<void> {
  await rows(sql`
    UPDATE notifications n SET is_read = true, read_at = now() FROM quote_extras x
     WHERE n.type = 'quote_extra' AND n.is_read = false AND n.reference_id = x.id AND x.status NOT IN ('proposed', 'approving')`)
    .catch((err) => console.error("[quote notices] sweep failed:", err));
}

/** The business's Activity row (and push, card failed only). referenceId: the quote, the extra, or the payment record. */
export async function noticeBusiness(q: Quote, kind: BusinessNoticeKind, referenceId: string, o: { description?: string; amountCents?: number } = {}): Promise<void> {
  try {
    if (await storage.isUserBlockedEitherWay(q.senderId, q.customerId)) return;
    const customer = await storage.getUser(q.customerId);
    const { resolvePublicIdentity } = await import("../publicIdentity");
    const customerName = customer ? (await resolvePublicIdentity(customer)).publicName ?? "" : "";
    const n = businessNotice(kind, { customerName, title: q.title, description: o.description, amountCents: o.amountCents ?? 0 });
    const metadata: Record<string, string> = { quoteId: q.id, conversationId: q.conversationId, screen: "chat" };
    const added = await addRow({ userId: q.senderId, type: n.type, title: n.title, message: n.message, referenceId, metadata, unreadOnly: kind === "card_failed" });
    if (added && n.push) {
      await (await deps()).sendPush({ userId: q.senderId, title: n.title, body: n.message, data: { type: "new_message", conversationId: q.conversationId, quoteId: q.id } }).catch(() => false);
    }
  } catch (err) {
    console.error(`[quote notices] ${kind} notice for ${q.id} failed:`, err);
  }
}
