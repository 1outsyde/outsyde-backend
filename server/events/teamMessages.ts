/**
 * p4-team step 5: host messages to the event team (Legend 2026-10-30, decision 10, calls 27 and 30 to 33).
 *
 * Personal messages only ("Make it a group chat" is a later step, built with the screens): the host or a co-host
 * sends to the whole team, all of one role, or one person. Each person gets it in their own Messages thread with
 * the sender (a normal `messages` row, so today's app shows it and they reply there), one push that opens that
 * thread, and one Activity item. The message copy is marked read, so the Activity item is the one unread count
 * (the tab badge adds Messages unread and Activity unread).
 *
 *   Whole team = accepted, not taken off, this event or the host's standing team, co-hosts too, plus the host when a
 *   co-host sends. Never pending or declined invites, never someone blocked either way, never the sender.
 *   Open from publishing until 3 days after the event (payout day). Text 1 to 1,000 characters, no photos yet. The
 *   same text to the same people twice in a row is refused.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { rows, iso, hostIdentity } from "./eventsRouter";
import { TEAM_ROLES } from "./teamRoles";

export const TEAM_MESSAGE_MAX = 1000;
/** Messages can be sent until this long after the event ends (payout day). */
export const MESSAGES_OPEN_DAYS_AFTER = 3;
const PREVIEW_MAX = 120;

const bodySchema = z.object({
  to: z.enum(["team", "role", "person"]),
  role: z.enum(TEAM_ROLES).optional(),
  userId: z.string().min(1).max(36).optional(),
  text: z.string(),
}).strict();

export type TeamMessageInput = { to: "team" | "role" | "person"; role: string | null; userId: string | null; text: string };
export type SendError = { status: number; code: string; message: string };

/** The request body, checked. */
export function parseTeamMessage(body: unknown): { ok: true; value: TeamMessageInput } | { ok: false; message: string } {
  const p = bodySchema.safeParse(body ?? {});
  if (!p.success) {
    const first = p.error.issues[0];
    return { ok: false, message: `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}` };
  }
  const text = p.data.text.trim();
  if (!text) return { ok: false, message: "text: write a message." };
  if (text.length > TEAM_MESSAGE_MAX) return { ok: false, message: `text: up to ${TEAM_MESSAGE_MAX.toLocaleString("en-US")} characters.` };
  if (p.data.to === "role" && !p.data.role) return { ok: false, message: "role: choose which role." };
  if (p.data.to !== "role" && p.data.role) return { ok: false, message: "role: only when sending to a role." };
  if (p.data.to === "person" && !p.data.userId) return { ok: false, message: "userId: choose who." };
  if (p.data.to !== "person" && p.data.userId) return { ok: false, message: "userId: only when sending to one person." };
  return { ok: true, value: { to: p.data.to, role: p.data.role ?? null, userId: p.data.userId ?? null, text } };
}

/** Open from publishing until 3 days after the end; drafts and cancelled events are closed. */
export function messagesOpen(e: { status: string; ends_at: Date | string }, now = Date.now()): boolean {
  if (e.status !== "published" && e.status !== "paused") return false;
  return now <= new Date(e.ends_at).getTime() + MESSAGES_OPEN_DAYS_AFTER * 24 * 3600_000;
}

/** Everyone on the event's team now (accepted, not taken off, active account), with their roles. */
async function teamNow(event: { id: string; host_user_id: string }, role: string | null): Promise<string[]> {
  const byRole = role ? sql`AND a.role = ${role}` : sql``;
  const list = await rows<any>(sql`
    SELECT DISTINCT a.member_user_id FROM (
      SELECT m.member_user_id, m.role FROM event_door_members m
      WHERE m.event_id = ${event.id} AND m.removed_at IS NULL AND m.accepted_at IS NOT NULL
      UNION ALL
      SELECT t.member_user_id, t.role FROM event_door_team t
      WHERE t.host_user_id = ${event.host_user_id} AND t.removed_at IS NULL AND t.accepted_at IS NOT NULL
    ) a JOIN users u ON u.id = a.member_user_id
    WHERE u.is_active = true AND COALESCE(u.deletion_status, 'active') = 'active' ${byRole}`);
  return list.map((r) => String(r.member_user_id));
}

/** Who a message goes to, before blocks: the team or role (plus the host when a co-host sends to the team), or one person. */
async function audienceFor(event: any, senderId: string, input: TeamMessageInput): Promise<string[] | SendError> {
  if (input.to === "person") {
    const onTeam = await teamNow(event, null);
    const allowed = input.userId === String(event.host_user_id) || onTeam.includes(String(input.userId));
    if (!allowed || input.userId === senderId) return { status: 404, code: "NOT_ON_TEAM", message: "That person isn't on this event's team." };
    return [String(input.userId)];
  }
  const list = await teamNow(event, input.to === "role" ? input.role : null);
  if (input.to === "team" && senderId !== String(event.host_user_id)) list.push(String(event.host_user_id));
  return Array.from(new Set(list)).filter((id) => id !== senderId);
}

/** Drops anyone blocked either way with the sender. */
async function withoutBlocked(senderId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return ids;
  const blocked = await rows<any>(sql`
    SELECT CASE WHEN blocker_id = ${senderId} THEN blocked_id ELSE blocker_id END AS other FROM user_blocks
    WHERE (blocker_id = ${senderId} AND blocked_id IN (SELECT unnest(string_to_array(${ids.join(",")}, ','))))
       OR (blocked_id = ${senderId} AND blocker_id IN (SELECT unnest(string_to_array(${ids.join(",")}, ','))))`);
  const out = new Set(blocked.map((b) => String(b.other)));
  return ids.filter((id) => !out.has(id));
}

/** The name people see: the event's public host name for the host, the person's public name for a co-host. */
export async function senderName(event: any, userId: string): Promise<string> {
  try {
    if (userId === String(event.host_user_id)) {
      const [full] = await rows<any>(sql`SELECT * FROM events WHERE id = ${event.id}`);
      return (await hostIdentity(full ?? event)).publicName;
    }
    const [u] = await rows<any>(sql`SELECT id, name, first_name, username, profile_image_url, is_vendor, is_photographer FROM users WHERE id = ${userId}`);
    if (!u) return "Your host";
    const { resolvePublicIdentity } = await import("../publicIdentity");
    const who = await resolvePublicIdentity({
      id: u.id, name: u.name, firstName: u.first_name, username: u.username, profileImageUrl: u.profile_image_url,
      isVendor: u.is_vendor === true, isPhotographer: u.is_photographer === true,
    } as any);
    return who.publicName;
  } catch {
    return "Your host";
  }
}

const preview = (t: string) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length <= PREVIEW_MAX ? one : `${one.slice(0, PREVIEW_MAX - 3).trimEnd()}...`;
};

/** Sends one team message. The event row needs id, host_user_id, status, ends_at and title. */
export async function sendTeamMessage(event: any, senderId: string, input: TeamMessageInput):
  Promise<{ message: { id: string; audience: string; role: string | null; recipientCount: number; sentAt: string | null } } | SendError> {
  if (!messagesOpen(event)) {
    return { status: 409, code: "MESSAGES_CLOSED", message: "Messages for this event are closed. They open when it's published and close 3 days after it ends." };
  }
  const audience = await audienceFor(event, senderId, input);
  if (!Array.isArray(audience)) return audience;
  const to = await withoutBlocked(senderId, audience);
  if (!to.length) return { status: 409, code: "NO_RECIPIENTS", message: "Nobody on the team can get this message right now." };

  const [last] = await rows<any>(sql`
    SELECT audience, role, recipient_user_id, content FROM event_team_messages
    WHERE event_id = ${event.id} AND sender_user_id = ${senderId} ORDER BY created_at DESC, id DESC LIMIT 1`);
  if (last && last.content === input.text && last.audience === input.to && (last.role ?? null) === input.role && (last.recipient_user_id ?? null) === input.userId) {
    return { status: 409, code: "DUPLICATE_MESSAGE", message: "You just sent this same message. Change it to send again." };
  }

  const [tm] = await rows<any>(sql`
    INSERT INTO event_team_messages (event_id, sender_user_id, audience, role, recipient_user_id, content, recipient_count)
    VALUES (${event.id}, ${senderId}, ${input.to}, ${input.role}, ${input.userId}, ${input.text}, 0)
    RETURNING id, created_at`);
  const name = await senderName(event, senderId);
  const title = `From ${name}`;
  const { storage } = await import("../storage");
  const { noticeDeps } = await import("./ticketNotices");
  const d = await noticeDeps();
  let delivered = 0;
  for (const userId of to) {
    try {
      const convo = await storage.getOrCreateConversation(senderId, userId);
      const msg = await storage.createMessage({ conversationId: convo.id, senderId, content: input.text });
      // Read already: the Activity item below is the one unread count (call 27).
      await rows(sql`UPDATE messages SET is_read = true, read_at = now() WHERE id = ${msg.id}`);
      await rows(sql`
        INSERT INTO event_team_message_recipients (team_message_id, member_user_id, conversation_id, message_id)
        VALUES (${tm.id}, ${userId}, ${convo.id}, ${msg.id}) ON CONFLICT DO NOTHING`);
      delivered++;
      // Same push type as a normal message, so today's app opens the thread where they can reply.
      await d.sendPush({
        userId, title, body: preview(input.text),
        data: { type: "new_message", conversationId: String(convo.id), messageId: String(msg.id), senderId, eventId: String(event.id) },
      }).catch((err) => console.error(`[TeamMessage] push failed for ${userId}:`, (err as Error)?.message ?? err));
      if (d.createActivity) {
        await d.createActivity({
          userId, type: "team_message", title, message: preview(input.text), referenceType: "event", referenceId: String(event.id),
          metadata: { eventId: String(event.id), conversationId: String(convo.id), teamMessageId: String(tm.id) }, triggeredByUserId: senderId,
        }).catch((err) => console.error(`[TeamMessage] activity failed for ${userId}:`, (err as Error)?.message ?? err));
      }
    } catch (err) {
      console.error(`[TeamMessage] delivery to ${userId} failed for ${tm.id}:`, (err as Error)?.message ?? err);
    }
  }
  await rows(sql`UPDATE event_team_messages SET recipient_count = ${delivered} WHERE id = ${tm.id}`);
  return { message: { id: String(tm.id), audience: input.to, role: input.role, recipientCount: delivered, sentAt: iso(tm.created_at) } };
}

/** Everything sent for an event, newest first (host and co-hosts). */
export async function sentTeamMessages(event: any) {
  const list = await rows<any>(sql`
    SELECT tm.*, ru.username AS to_username, ru.name AS to_name
    FROM event_team_messages tm LEFT JOIN users ru ON ru.id = tm.recipient_user_id
    WHERE tm.event_id = ${event.id} ORDER BY tm.created_at DESC, tm.id DESC LIMIT 200`);
  const names = new Map<string, string>();
  const out = [];
  for (const m of list) {
    const sid = String(m.sender_user_id);
    if (!names.has(sid)) names.set(sid, await senderName(event, sid));
    out.push({
      id: String(m.id), sentAt: iso(m.created_at), text: m.content, audience: m.audience, role: m.role ?? null,
      to: m.recipient_user_id ? { userId: String(m.recipient_user_id), username: m.to_username ?? null } : null,
      from: { userId: sid, name: names.get(sid) }, recipientCount: Number(m.recipient_count),
    });
  }
  return out;
}

/** What one member got for this event ("From the host" on their screen), newest first. */
export async function fromHostFor(event: any, userId: string) {
  const list = await rows<any>(sql`
    SELECT tm.id, tm.sender_user_id, tm.content, tm.created_at
    FROM event_team_message_recipients r JOIN event_team_messages tm ON tm.id = r.team_message_id
    WHERE tm.event_id = ${event.id} AND r.member_user_id = ${userId}
    ORDER BY tm.created_at DESC, tm.id DESC LIMIT 50`);
  const names = new Map<string, string>();
  const out = [];
  for (const m of list) {
    const sid = String(m.sender_user_id);
    if (!names.has(sid)) names.set(sid, await senderName(event, sid));
    out.push({ id: String(m.id), at: iso(m.created_at), text: m.content, from: { name: names.get(sid) } });
  }
  return out;
}
