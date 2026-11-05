/**
 * Quotes step 5a (goutsyde.com support, migration 103). Rules: ./quoteNotesRules.ts.
 *
 * Legend 2026-11-05 (step 5 calls 1 to 3, 6):
 *   - A quote link (goutsyde.com/q/<code>) opens the quote: signed out, a preview; the customer, the business or
 *     Outsyde admin, the quote; anyone else, no details.
 *   - Notes are the quote's chat (the same conversation as app Messages, sent with the normal Messages route). Every
 *     note left unread for 2 minutes is emailed to the other side, at most one email per chat and person every 10
 *     minutes, with all the new notes in it. Only chats with a live quote (sent and not expired, or paid). Off until
 *     QUOTE_EMAILS_ENABLED=true, so no email links to a page that isn't live.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { quotes, type Quote } from "@shared/schema";
import { buildNoteEmail, noteEmailDue, NOTE_EMAIL_DELAY_MINUTES, NOTE_EMAIL_EVERY_MINUTES } from "./quoteNotesRules";

async function rows<T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result: any = await db.execute(query);
  return (result?.rows ?? result ?? []) as T[];
}

const CODE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** The quote behind a link code, or undefined for anything that isn't one. */
export async function quoteByLinkCode(code: unknown): Promise<Quote | undefined> {
  if (typeof code !== "string" || !CODE_RE.test(code)) return undefined;
  const [q] = await db.select().from(quotes).where(eq(quotes.linkCode, code));
  return q;
}

// ─── Note emails ────────────────────────────────────────────────────────────

type Mail = { to: string; subject: string; text: string; html: string };
let mailerForTest: ((m: Mail) => Promise<boolean>) | null = null;
/** Tests: capture the note emails instead of sending them. */
export function setQuoteNoteMailerForTest(fn: ((m: Mail) => Promise<boolean>) | null): void {
  mailerForTest = fn;
}
async function sendMail(m: Mail): Promise<boolean> {
  if (mailerForTest) return mailerForTest(m);
  const { sendAdminEmail } = await import("../emailService");
  return sendAdminEmail({ to: m.to, subject: m.subject, html: m.html, text: m.text, log: { kind: "booking", label: "Quote note" } });
}

/**
 * Every 5 minutes (with the quote expiry job). One email per chat and person at most every 10 minutes, covering the
 * text notes they haven't read that are at least 2 minutes old and newer than the last email. The row is claimed
 * (last_sent_at) before sending; a failed send puts it back, so the notes go in the next email.
 */
export async function runQuoteNoteEmails(now = new Date()): Promise<{ sent: number }> {
  if (process.env.QUOTE_EMAILS_ENABLED !== "true") return { sent: 0 };
  let sent = 0;
  const due = await rows<{ conversation_id: string; recipient_id: string; sender_id: string; quote_id: string; newest: string; prev_sent: string | null; prev_newest: string | null }>(sql`
    WITH live AS (
      SELECT DISTINCT ON (q.conversation_id) q.conversation_id, q.id, q.customer_id, q.sender_id, q.sent_at
        FROM quotes q
       WHERE (q.status = 'paid' OR (q.status = 'sent' AND q.expires_at > ${now}::timestamptz))
         AND q.sent_at > ${now}::timestamptz - interval '90 days'
       ORDER BY q.conversation_id, q.sent_at DESC
    ), unread AS (
      SELECT l.conversation_id, l.id AS quote_id, m.sender_id,
             CASE WHEN m.sender_id = l.customer_id THEN l.sender_id ELSE l.customer_id END AS recipient_id, m.created_at
        FROM live l JOIN messages m ON m.conversation_id = l.conversation_id
       WHERE m.kind = 'text' AND m.is_read = false AND m.sender_id IN (l.customer_id, l.sender_id)
         AND m.created_at >= l.sent_at - interval '1 minute'
         AND m.created_at <= ${now}::timestamptz - make_interval(mins => ${NOTE_EMAIL_DELAY_MINUTES})
    )
    SELECT u.conversation_id, u.recipient_id, min(u.sender_id) AS sender_id, min(u.quote_id) AS quote_id, max(u.created_at)::text AS newest,
           e.last_sent_at::text AS prev_sent, e.last_message_at::text AS prev_newest
      FROM unread u LEFT JOIN quote_chat_emails e ON e.conversation_id = u.conversation_id AND e.recipient_id = u.recipient_id
     WHERE (e.last_message_at IS NULL OR u.created_at > e.last_message_at)
       AND (e.last_sent_at IS NULL OR e.last_sent_at <= ${now}::timestamptz - make_interval(mins => ${NOTE_EMAIL_EVERY_MINUTES}))
     GROUP BY u.conversation_id, u.recipient_id, e.last_sent_at, e.last_message_at
     LIMIT 50`);
  for (const d of due) {
    try {
      if (!noteEmailDue(d.prev_sent ? new Date(d.prev_sent) : null, now)) continue;
      // Claim: only one run sends for this chat and person in the window.
      const [claimed] = await rows(sql`
        INSERT INTO quote_chat_emails (conversation_id, recipient_id, last_sent_at, last_message_at)
        VALUES (${d.conversation_id}, ${d.recipient_id}, now(), ${d.newest}::timestamptz)
        ON CONFLICT (conversation_id, recipient_id) DO UPDATE SET last_sent_at = now(), last_message_at = ${d.newest}::timestamptz, updated_at = now()
         WHERE quote_chat_emails.last_sent_at IS NULL OR quote_chat_emails.last_sent_at <= now() - make_interval(mins => ${NOTE_EMAIL_EVERY_MINUTES})
        RETURNING conversation_id`);
      if (!claimed) continue;
      const putBack = async () => {
        await rows(sql`UPDATE quote_chat_emails SET last_sent_at = ${d.prev_sent}::timestamptz, last_message_at = ${d.prev_newest}::timestamptz, updated_at = now()
                        WHERE conversation_id = ${d.conversation_id} AND recipient_id = ${d.recipient_id}`);
      };
      const notes = await rows<{ content: string; media: number }>(sql`
        SELECT m.content, jsonb_array_length(m.media_items) AS media FROM messages m
         WHERE m.conversation_id = ${d.conversation_id} AND m.kind = 'text' AND m.is_read = false AND m.sender_id <> ${d.recipient_id}
           AND (${d.prev_newest}::timestamptz IS NULL OR m.created_at > ${d.prev_newest}::timestamptz) AND m.created_at <= ${d.newest}::timestamptz
         ORDER BY m.created_at`);
      const [q] = await db.select().from(quotes).where(eq(quotes.id, d.quote_id));
      const recipient = await storage.getUser(d.recipient_id);
      if (!q || !recipient?.email || !notes.length || (await storage.isUserBlockedEitherWay(d.sender_id, d.recipient_id))) continue;
      // The business side writes as the business; the customer as their public name.
      let senderName = "";
      if (d.sender_id === q.customerId) {
        const u = await storage.getUser(d.sender_id);
        const { resolvePublicIdentity } = await import("../publicIdentity");
        senderName = u ? (await resolvePublicIdentity(u)).publicName ?? "" : "";
      } else {
        senderName = (await storage.getBusiness(q.businessId))?.name ?? "";
      }
      const { quoteLink } = await import("./quoteEmail");
      const email = buildNoteEmail({
        recipientFirstName: (recipient as any).firstName ?? null, senderName: senderName || "Someone", title: q.title,
        notes: notes.map((n) => (n.content?.trim() ? n.content : Number(n.media) > 0 ? "Sent a photo." : "")).filter(Boolean),
        link: quoteLink(q),
      });
      const ok = await sendMail({ to: recipient.email, ...email }).catch(() => false);
      if (ok) sent++; else await putBack();
    } catch (err) {
      console.error(`[quote notes] email for chat ${d.conversation_id} failed:`, err);
    }
  }
  return { sent };
}
