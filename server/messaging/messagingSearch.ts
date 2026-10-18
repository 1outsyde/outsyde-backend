/**
 * Messaging search (2026-10-18, Legend's decisions):
 *  - People to message: everyone (customers, businesses, photographers), matched on the name other
 *    people SEE (business name for a business owner, display name for a photographer, users.name /
 *    first name for everyone else) or @username. Never matched or returned by email, phone, last
 *    name, or a business owner's personal name. Excludes the caller, anyone blocked either way,
 *    banned (is_active = false) and deleted accounts.
 *  - Message text: only messages in conversations the caller is part of.
 *
 * Both return `participantId` = the other person's user id with `participantType: "user"`, which
 * POST /api/conversations already resolves for every kind of account.
 */
import { sql } from "drizzle-orm";

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 60;

/** Trim, drop a leading @, cap length. Returns null when too short to search. */
export function normalizeQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim().replace(/^@+/, "").slice(0, SEARCH_MAX_CHARS).trim();
  return q.length >= SEARCH_MIN_CHARS ? q : null;
}

/** ILIKE pattern with %, _ and \ escaped so they match literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** ~90 characters around the first match, with … where text was cut. */
export function snippetAround(text: string, q: string, width = 90): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= width) return clean;
  const i = clean.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return clean.slice(0, width - 1).trimEnd() + "…";
  const start = Math.max(0, Math.min(i - Math.floor((width - q.length) / 2), clean.length - width));
  const end = Math.min(clean.length, start + width);
  return (start > 0 ? "…" : "") + clean.slice(start, end).trim() + (end < clean.length ? "…" : "");
}

export interface RecipientResult {
  userId: string;
  participantId: string;
  participantType: "user";
  type: "business" | "photographer" | "consumer";
  publicName: string;
  username: string | null;
  avatarUrl: string | null;
  businessId: string | null;
  photographerId: string | null;
  /** Existing conversation with this person, if any (open it instead of starting a new one). */
  conversationId: string | null;
}

export async function searchRecipients(me: string, rawQuery: unknown, limit = 25): Promise<RecipientResult[] | null> {
  const q = normalizeQuery(rawQuery);
  if (!q) return null;
  const pattern = likePattern(q);
  const prefix = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { db } = await import("../db");

  const r = await db.execute(sql`
    WITH blocked AS (
      SELECT blocked_id AS uid FROM user_blocks WHERE blocker_id = ${me}
      UNION SELECT blocker_id FROM user_blocks WHERE blocked_id = ${me}
    ),
    candidates AS (
      SELECT u.id, u.name, u.first_name, u.username, u.profile_image_url, u.is_vendor, u.is_photographer,
             b.id AS biz_id, b.name AS biz_name, b.logo_image AS biz_logo,
             p.id AS ph_id, p.display_name AS ph_name, p.logo_image AS ph_logo
      FROM users u
      LEFT JOIN LATERAL (
        SELECT id, name, logo_image FROM businesses WHERE owner_id = u.id ORDER BY created_at ASC LIMIT 1
      ) b ON true
      LEFT JOIN LATERAL (
        SELECT id, display_name, logo_image FROM photographers WHERE user_id = u.id AND u.is_photographer LIMIT 1
      ) p ON true
      WHERE u.id <> ${me}
        AND u.is_active = true
        AND coalesce(u.deletion_status, 'active') <> 'deleted'
        AND u.id NOT IN (SELECT uid FROM blocked)
    ),
    named AS (
      SELECT *,
        CASE
          WHEN ph_id IS NOT NULL AND nullif(trim(ph_name), '') IS NOT NULL THEN trim(ph_name)
          WHEN biz_id IS NOT NULL AND nullif(trim(biz_name), '') IS NOT NULL THEN trim(biz_name)
          ELSE coalesce(nullif(trim(name), ''), nullif(trim(first_name), ''))
        END AS public_name
      FROM candidates
    )
    SELECT n.*,
      (SELECT c.id FROM conversations c
        WHERE (c.participant1_id = ${me} AND c.participant2_id = n.id)
           OR (c.participant2_id = ${me} AND c.participant1_id = n.id)
        ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1) AS conversation_id
    FROM named n
    WHERE n.public_name ILIKE ${pattern} OR n.username ILIKE ${pattern}
    ORDER BY
      (lower(n.public_name) = lower(${q}) OR lower(n.username) = lower(${q})) DESC,
      (n.public_name ILIKE ${prefix} OR n.username ILIKE ${prefix}) DESC,
      (n.biz_id IS NOT NULL OR n.ph_id IS NOT NULL) DESC,
      n.public_name ASC
    LIMIT ${Math.max(1, Math.min(limit, 50))}
  `);

  const { pickPublicIdentity } = await import("../publicIdentity");
  return (r.rows as any[]).map((row) => {
    const who = pickPublicIdentity(
      { id: row.id, name: row.name, firstName: row.first_name, username: row.username, profileImageUrl: row.profile_image_url, isVendor: row.is_vendor, isPhotographer: row.is_photographer } as any,
      row.biz_id ? { id: row.biz_id, name: row.biz_name, logoImage: row.biz_logo } : null,
      row.ph_id ? { id: row.ph_id, displayName: row.ph_name, logoImage: row.ph_logo } : null,
    );
    return {
      userId: row.id,
      participantId: row.id,
      participantType: "user" as const,
      type: who.kind,
      publicName: who.publicName,
      username: row.username || null,
      avatarUrl: who.avatarUrl,
      businessId: who.businessId,
      photographerId: who.photographerId,
      conversationId: row.conversation_id || null,
    };
  });
}

export interface MessageSearchResult {
  messageId: string;
  conversationId: string;
  snippet: string;
  fromMe: boolean;
  createdAt: string;
  otherParticipant: {
    id: string;
    publicName: string;
    avatarUrl: string | null;
    type: "business" | "photographer" | "consumer";
    username: string | null;
  };
}

export async function searchMyMessages(me: string, rawQuery: unknown, limit = 50): Promise<MessageSearchResult[] | null> {
  const q = normalizeQuery(rawQuery);
  if (!q) return null;
  const pattern = likePattern(q);
  const { db } = await import("../db");

  const r = await db.execute(sql`
    SELECT m.id, m.conversation_id, m.content, m.sender_id, m.created_at,
           CASE WHEN c.participant1_id = ${me} THEN c.participant2_id ELSE c.participant1_id END AS other_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE (c.participant1_id = ${me} OR c.participant2_id = ${me})
      AND m.content ILIKE ${pattern}
    ORDER BY m.created_at DESC
    LIMIT ${Math.max(1, Math.min(limit, 50))}
  `);
  const rows = r.rows as any[];
  if (rows.length === 0) return [];

  const { users } = await import("@shared/schema");
  const { inArray } = await import("drizzle-orm");
  const otherIds = Array.from(new Set(rows.map((x) => String(x.other_id))));
  const others = await db
    .select({ id: users.id, name: users.name, firstName: users.firstName, username: users.username, profileImageUrl: users.profileImageUrl, isVendor: users.isVendor, isPhotographer: users.isPhotographer })
    .from(users)
    .where(inArray(users.id, otherIds));
  const { resolvePublicIdentities, pickPublicIdentity } = await import("../publicIdentity");
  const ids = await resolvePublicIdentities(others as any);
  const byId = new Map(others.map((o) => [o.id, o]));

  return rows.map((row) => {
    const other = byId.get(String(row.other_id));
    const who = (other && ids.get(other.id)) || (other ? pickPublicIdentity(other as any) : null);
    return {
      messageId: row.id,
      conversationId: row.conversation_id,
      snippet: snippetAround(row.content, q),
      fromMe: row.sender_id === me,
      createdAt: row.created_at,
      otherParticipant: {
        id: String(row.other_id),
        publicName: who?.publicName || "Outsyde member",
        avatarUrl: who?.avatarUrl ?? null,
        type: who?.kind || "consumer",
        username: other?.username || null,
      },
    };
  });
}
