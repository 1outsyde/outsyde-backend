/**
 * Door access rules for ticket check-in. Recomputed from the database on every call (no caching), so a removed
 * member or an ended event loses access on the very next request.
 *   host     events.host_user_id = user
 *   standing active, accepted row in event_door_team for that host
 *   event    active, accepted row in event_door_members for that event, and now() < events.ends_at
 * "Active, accepted" = removed_at IS NULL AND accepted_at IS NOT NULL (migration 075: an invite that is still pending
 * or was declined gives no access).
 * Every role needs an active account (same test as loadActiveUser).
 * p4-team (2026-10-29): only team rows with role 'door' (Admissions) give scanner access. Security and host /
 * promoter rows give none here; their own access comes with their own screens.
 *   cohost   (step 2b) an accepted co-host for this event, or a standing co-host for this host: scans, undoes a
 *            check in and manages the event's team like the host (not money). Not limited to before the end.
 */
import { sql } from "drizzle-orm";
import { rows } from "./eventsRouter";

export type DoorRole = "host" | "cohost" | "standing" | "event";

const SCAN_OPENS_BEFORE_START_MS = 6 * 60 * 60 * 1000;

export async function loadEventForDoor(eventId: string, userId: string): Promise<{ event: any; role: DoorRole } | null> {
  const [r] = await rows<any>(sql`
    SELECT e.id, e.title, e.host_user_id, e.status, e.starts_at, e.ends_at, e.timezone,
      CASE
        WHEN e.host_user_id = u.id THEN 'host'
        WHEN EXISTS (SELECT 1 FROM event_door_members m
                     WHERE m.event_id = e.id AND m.member_user_id = u.id AND m.removed_at IS NULL
                       AND m.accepted_at IS NOT NULL AND m.role = 'cohost')
          OR EXISTS (SELECT 1 FROM event_door_team t
                     WHERE t.host_user_id = e.host_user_id AND t.member_user_id = u.id AND t.removed_at IS NULL
                       AND t.accepted_at IS NOT NULL AND t.role = 'cohost') THEN 'cohost'
        WHEN EXISTS (SELECT 1 FROM event_door_team t
                     WHERE t.host_user_id = e.host_user_id AND t.member_user_id = u.id AND t.removed_at IS NULL
                       AND t.accepted_at IS NOT NULL AND t.role = 'door') THEN 'standing'
        WHEN now() < e.ends_at AND EXISTS (SELECT 1 FROM event_door_members m
                     WHERE m.event_id = e.id AND m.member_user_id = u.id AND m.removed_at IS NULL
                       AND m.accepted_at IS NOT NULL AND m.role = 'door') THEN 'event'
        ELSE NULL
      END AS door_role
    FROM events e
    JOIN users u ON u.id = ${userId} AND u.is_active = true AND COALESCE(u.deletion_status, 'active') = 'active'
    WHERE e.id = ${eventId}`);
  if (!r || !r.door_role) return null;
  const { door_role, ...event } = r;
  return { event, role: door_role as DoorRole };
}

export function isWithinScanWindow(e: { status: string; starts_at: Date | string; ends_at: Date | string }, now: Date): boolean {
  if (e.status !== "published") return false;
  const start = new Date(e.starts_at).getTime();
  const end = new Date(e.ends_at).getTime();
  const t = now.getTime();
  return t >= start - SCAN_OPENS_BEFORE_START_MS && t <= end;
}
