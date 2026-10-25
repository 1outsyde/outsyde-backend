/**
 * Admin push announcements: who can receive one.
 *
 * Same five audiences and the same role rules as email broadcasts (IS_VENDOR, IS_PHOTOGRAPHER and
 * IS_CONSUMER are imported from broadcasts.ts, unchanged). What differs from email:
 *   needs an app push token (only people who allowed notifications on their phone have one),
 *   no email needed, and the opt out is push_news_optouts ("Outsyde news and offers"), not
 *   broadcast_optouts. Admins, demo, inactive and deleted accounts are always left out.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { IS_CONSUMER, IS_PHOTOGRAPHER, IS_VENDOR } from "../broadcasts/broadcasts";
import { pgTextArray } from "../emailHistory";

export const PUSH_AUDIENCES = ["picked", "vendors", "photographers", "consumers", "all"] as const;
export type PushAudience = (typeof PUSH_AUDIENCES)[number];
export const MAX_PICKED = 500;

/** Same checks as email ELIGIBLE (broadcasts.ts) minus email and broadcast_optouts, plus a token and the news opt out. */
export const PUSH_ELIGIBLE = sql`
  u.expo_push_token IS NOT NULL
  AND u.is_active = true
  AND u.deletion_status = 'active'
  AND u.is_admin = false
  AND u.id NOT ILIKE 'demo%'
  AND NOT EXISTS (SELECT 1 FROM businesses bd WHERE bd.owner_id = u.id AND COALESCE(bd.is_demo, false) = true)
  AND NOT EXISTS (SELECT 1 FROM photographers pd WHERE pd.user_id = u.id AND COALESCE(pd.is_demo, false) = true)
  AND NOT EXISTS (SELECT 1 FROM push_news_optouts o WHERE o.user_id = u.id)
`;

export function pushAudienceFilter(audience: PushAudience, userIds?: string[]): SQL {
  switch (audience) {
    case "picked": return sql`u.id = ANY(${pgTextArray(userIds ?? [])}::varchar[])`;
    case "vendors": return IS_VENDOR;
    case "photographers": return IS_PHOTOGRAPHER;
    case "consumers": return IS_CONSUMER;
    case "all": return sql`true`;
  }
}

export async function pushAudienceCounts(): Promise<Record<Exclude<PushAudience, "picked">, number>> {
  const r = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE ${IS_VENDOR})::int AS vendors,
      count(*) FILTER (WHERE ${IS_PHOTOGRAPHER})::int AS photographers,
      count(*) FILTER (WHERE ${IS_CONSUMER})::int AS consumers,
      count(*)::int AS "all"
    FROM users u WHERE ${PUSH_ELIGIBLE}
  `);
  const row = (r.rows[0] ?? {}) as Record<string, number>;
  return {
    vendors: Number(row.vendors ?? 0), photographers: Number(row.photographers ?? 0),
    consumers: Number(row.consumers ?? 0), all: Number(row.all ?? 0),
  };
}

export async function countPushRecipients(audience: PushAudience, userIds?: string[]): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM users u WHERE ${PUSH_ELIGIBLE} AND ${pushAudienceFilter(audience, userIds)}`);
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
}

/** Display name and role, same rules as the email page (broadcasts.ts DISPLAY_NAME and ROLE). */
export const PUSH_DISPLAY_NAME = sql`COALESCE(
  (SELECT b.name FROM businesses b WHERE b.owner_id = u.id LIMIT 1),
  (SELECT p.display_name FROM photographers p WHERE p.user_id = u.id LIMIT 1),
  u.name)`;
export const PUSH_ROLE = sql`CASE
  WHEN EXISTS (SELECT 1 FROM businesses b WHERE b.owner_id = u.id) THEN 'business'
  WHEN EXISTS (SELECT 1 FROM photographers p WHERE p.user_id = u.id) THEN 'photographer'
  WHEN EXISTS (SELECT 1 FROM staff_members s WHERE s.user_id = u.id AND s.status = 'active') THEN 'staff'
  ELSE 'consumer' END`;

export interface PushPersonRow {
  id: string; name: string | null; username: string | null; role: string;
  hasToken: boolean; newsOptOut: boolean; canPush: boolean;
}

/** Search accounts for "Picked people". Never returns an email or a push token. */
export async function searchPushPeople(q: string, limit = 20): Promise<PushPersonRow[]> {
  const term = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const r = await db.execute(sql`
    SELECT u.id, ${PUSH_DISPLAY_NAME} AS name, u.username, ${PUSH_ROLE} AS role,
           (u.expo_push_token IS NOT NULL) AS has_token,
           EXISTS (SELECT 1 FROM push_news_optouts o WHERE o.user_id = u.id) AS news_opt_out,
           (${PUSH_ELIGIBLE}) AS can_push
    FROM users u
    WHERE u.deletion_status = 'active'
      AND (u.email ILIKE ${term} OR u.name ILIKE ${term} OR u.username ILIKE ${term}
           OR EXISTS (SELECT 1 FROM businesses b WHERE b.owner_id = u.id AND b.name ILIKE ${term})
           OR EXISTS (SELECT 1 FROM photographers p WHERE p.user_id = u.id AND p.display_name ILIKE ${term}))
    ORDER BY u.created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `);
  return (r.rows as Record<string, unknown>[]).map((x) => ({
    id: String(x.id), name: (x.name as string | null) ?? null, username: (x.username as string | null) ?? null,
    role: String(x.role), hasToken: x.has_token === true, newsOptOut: x.news_opt_out === true, canPush: x.can_push === true,
  }));
}

export function checkPushAudience(body: unknown): { audience: PushAudience; userIds?: string[] } | string {
  const b = (body ?? {}) as { audience?: unknown; userIds?: unknown };
  const audience = b.audience as PushAudience;
  if (!PUSH_AUDIENCES.includes(audience)) return "Pick who to send to.";
  if (audience !== "picked") return { audience };
  const ids = b.userIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PICKED ||
      !ids.every((v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 100)) {
    return `Pick between 1 and ${MAX_PICKED} people.`;
  }
  return { audience, userIds: Array.from(new Set(ids as string[])) };
}
