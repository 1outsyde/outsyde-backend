/**
 * p4-team step 3: personal promoter links + sales tracking (migration 085).
 *
 * One link per promoter (Event team role 'host', shown as Promoter) per event. Since step 4a, Entertainment gets one too. Standing promoters get one for each
 * event of their host. A sale counts for the link the buyer checked out through. Decided by Legend 2026-10-30:
 *   - a promoter buying through their own link doesn't count
 *   - a removed promoter's link stops counting new sales; past sales stay theirs
 *   - free RSVPs are counted apart from paid tickets
 *   - host and co-hosts see a per promoter breakdown
 *   - links for promoters only, for now
 * A link that doesn't count never blocks the sale: the order is saved with no link.
 * Counts use the host summary's rule: tickets 'valid' on 'completed' orders, so pending checkouts, refunds and
 * cancelled RSVPs never count.
 */
import { randomInt } from "crypto";
import { sql, type SQL } from "drizzle-orm";
import { rows } from "./eventsRouter";

/** Event team role stored for promoters. */
export const PROMOTER_ROLE = "host";
/**
 * Roles that get a link (step 4a, Legend 2026-10-30): Promoters and Entertainment (DJs, performers, MCs), so both can
 * earn commission on sales through it. Same list as teamPay.LINK_ROLES (checked in teamPay.http.test.ts).
 */
const LINK_ROLES_SQL = sql.raw(`('host', 'entertainment')`);

/** 32 letters and digits with no I, O, 0 or 1 (easy to read aloud); matches the CHECK in migration 085. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LINK_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

export function makeLinkCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** The code as stored, or null for anything that can't be one (missing, wrong type, wrong shape). */
export function normalizeLinkCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return LINK_CODE_RE.test(code) ? code : null;
}

/** SQL true when `userId` is an accepted, not removed promoter at the event (this event or standing for its host). */
function isActivePromoter(eventId: SQL, hostUserId: SQL, userId: SQL): SQL {
  return sql`(EXISTS (SELECT 1 FROM event_door_members pm
                 WHERE pm.event_id = ${eventId} AND pm.member_user_id = ${userId} AND pm.role IN ${LINK_ROLES_SQL}
                   AND pm.removed_at IS NULL AND pm.accepted_at IS NOT NULL)
            OR EXISTS (SELECT 1 FROM event_door_team pt
                 WHERE pt.host_user_id = ${hostUserId} AND pt.member_user_id = ${userId} AND pt.role IN ${LINK_ROLES_SQL}
                   AND pt.removed_at IS NULL AND pt.accepted_at IS NOT NULL))`;
}

/**
 * The link id an order should record, as a SQL expression for the order's own INSERT (so it is decided in the
 * same statement as the sale). NULL when the code is missing, unknown, for another event, the buyer's own, or
 * belongs to someone who is no longer an active promoter on an active account.
 * Paid checkout decides this when the seats are held, so a promoter removed during the 10 minute hold still gets
 * that sale once it is paid (the buyer started through their link while it counted).
 */
export function promoterLinkIdSql(code: string | null, eventId: string, buyerUserId: string): SQL {
  if (!code) return sql`NULL::varchar`;
  return sql`(SELECT l.id FROM event_promoter_links l
              JOIN events le ON le.id = l.event_id
              JOIN users lu ON lu.id = l.promoter_user_id AND lu.is_active = true AND COALESCE(lu.deletion_status, 'active') = 'active'
              WHERE l.code = ${code} AND l.event_id = ${eventId} AND l.promoter_user_id <> ${buyerUserId}
                AND ${isActivePromoter(sql`l.event_id`, sql`le.host_user_id`, sql`l.promoter_user_id`)})`;
}

/**
 * Makes sure every active promoter at the event has a link (one per promoter per event). Safe to call any number
 * of times and from several requests at once: the unique indexes keep one link per promoter and one per code.
 * `onlyUserId` limits it to one promoter.
 */
export async function ensurePromoterLinks(eventId: string, onlyUserId?: string): Promise<void> {
  const missing = await rows<any>(sql`
    SELECT p.user_id FROM (
      SELECT m.member_user_id AS user_id FROM event_door_members m
      WHERE m.event_id = ${eventId} AND m.role IN ${LINK_ROLES_SQL} AND m.removed_at IS NULL AND m.accepted_at IS NOT NULL
      UNION
      SELECT t.member_user_id FROM event_door_team t JOIN events e ON e.id = ${eventId}
      WHERE t.host_user_id = e.host_user_id AND t.role IN ${LINK_ROLES_SQL} AND t.removed_at IS NULL AND t.accepted_at IS NOT NULL
    ) p
    WHERE (${onlyUserId ?? null}::text IS NULL OR p.user_id = ${onlyUserId ?? null}::text)
      AND NOT EXISTS (SELECT 1 FROM event_promoter_links l WHERE l.event_id = ${eventId} AND l.promoter_user_id = p.user_id)`);
  for (const { user_id: userId } of missing) {
    // A clash on the code (about 1 in a trillion) just tries a new one; a clash on (event, promoter) means
    // another request made the link first, which is fine.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [made] = await rows<any>(sql`
        INSERT INTO event_promoter_links (event_id, promoter_user_id, code)
        VALUES (${eventId}, ${userId}, ${makeLinkCode()})
        ON CONFLICT DO NOTHING
        RETURNING id`);
      if (made) break;
      const [exists] = await rows<any>(sql`SELECT 1 AS found FROM event_promoter_links WHERE event_id = ${eventId} AND promoter_user_id = ${userId}`);
      if (exists) break;
    }
  }
}

/** The event page with the promoter's code. */
export function promoterLinkUrl(slug: string, code: string): string {
  const base = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || "https://www.goutsyde.com").replace(/\/+$/, "");
  return `${base}/e/${encodeURIComponent(slug)}?ref=${code}`;
}

type LinkStats = { linkId: string; code: string; userId: string; username: string | null; firstName: string | null;
  rsvps: number; ticketsSold: number; salesCents: number; active: boolean };

/** Every link of the event with its counts (or one promoter's), most sales first. Columns aliased: no two share a name. */
export async function promoterLinkStats(eventId: string, onlyUserId?: string): Promise<LinkStats[]> {
  const list = await rows<any>(sql`
    SELECT l.id AS link_id, l.code AS link_code, l.promoter_user_id AS promoter_id, pu.username AS promoter_username,
           pu.first_name AS promoter_first_name, l.created_at AS link_created_at,
           count(t.id) FILTER (WHERE t.price_cents = 0)::int AS rsvp_count,
           count(t.id) FILTER (WHERE t.price_cents > 0)::int AS sold_count,
           COALESCE(sum(t.price_cents) FILTER (WHERE t.price_cents > 0), 0)::int AS sales_total,
           (${isActivePromoter(sql`l.event_id`, sql`le.host_user_id`, sql`l.promoter_user_id`)}
             AND pu.is_active = true AND COALESCE(pu.deletion_status, 'active') = 'active') AS is_active_promoter
    FROM event_promoter_links l
    JOIN events le ON le.id = l.event_id
    JOIN users pu ON pu.id = l.promoter_user_id
    LEFT JOIN ticket_orders o ON o.promoter_link_id = l.id AND o.status = 'completed'
    LEFT JOIN tickets t ON t.order_id = o.id AND t.status = 'valid'
    WHERE l.event_id = ${eventId} AND (${onlyUserId ?? null}::text IS NULL OR l.promoter_user_id = ${onlyUserId ?? null}::text)
    GROUP BY l.id, le.host_user_id, pu.username, pu.first_name, pu.is_active, pu.deletion_status
    ORDER BY sales_total DESC, sold_count DESC, rsvp_count DESC, l.created_at`);
  return list.map((r) => ({
    linkId: String(r.link_id), code: String(r.link_code), userId: String(r.promoter_id),
    username: r.promoter_username ?? null, firstName: r.promoter_first_name ?? null,
    rsvps: Number(r.rsvp_count), ticketsSold: Number(r.sold_count), salesCents: Number(r.sales_total),
    active: r.is_active_promoter === true,
  }));
}
