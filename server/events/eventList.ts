/**
 * Public event list for Discover and Pro feed cards: GET /api/events (see eventsRouter.ts).
 *
 * Privacy rules this file owns:
 *  - Only published, public (listed), not-yet-ended events of active hosts are returned.
 *  - A card goes through visibleAddress as a stranger (no host, no ticket): when the address is not
 *    public the venue is dropped and addressHidden is true. A card never has street, postal code,
 *    latitude/longitude or any distance number.
 *  - The near-me filter reads the stored coordinates INSIDE SQL only. Results are ordered strictly by
 *    (starts_at, id), never by distance, so repeated queries from different points cannot be used to
 *    locate a hidden address from the order. For non-public addresses the filter also uses the coordinates
 *    rounded to 0.1 degree, so tiny-radius sweeps can't pin the spot.
 *  - Hidden ticket types never contribute to price, free or any other card field.
 */
import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { pickPublicIdentity } from "../publicIdentity";
import { visibleAddress } from "./eventRules";

export const DEFAULT_RADIUS_KM = 40;
export const MAX_RADIUS_KM = 200;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

const num = (min: number, max: number) =>
  z.string().trim().min(1).max(32).transform((s) => Number(s)).refine((n) => Number.isFinite(n) && n >= min && n <= max, "out of range");

export const listQuerySchema = z
  .object({
    lat: num(-90, 90).optional(),
    lng: num(-180, 180).optional(),
    radiusKm: num(0.1, MAX_RADIUS_KM).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    free: z.enum(["true", "false"]).optional(),
    limit: z.string().regex(/^\d{1,3}$/).transform(Number).refine((n) => n >= 1 && n <= MAX_LIMIT, "1 to 50").optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict()
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), "lat and lng go together")
  .refine((q) => q.radiusKm === undefined || q.lat !== undefined, "radiusKm needs lat and lng");

export type ListQuery = z.infer<typeof listQuerySchema>;

const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[A-Za-z0-9-]{1,36}$/;

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, "utf8").toString("base64url");
}

/** null when the cursor isn't one we issued. */
export function decodeCursor(c: string): { ts: string; id: string } | null {
  try {
    const [ts, id, extra] = Buffer.from(c, "base64url").toString("utf8").split("|");
    if (extra !== undefined || !CURSOR_TS.test(ts ?? "") || !CURSOR_ID.test(id ?? "")) return null;
    // Shape alone isn't enough: Postgres would reject an impossible date with a 500. Require a real
    // calendar date (the ISO round-trip catches month 13, Feb 30, hour 99) within Postgres' year range.
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms) || ts < "1000" || new Date(ms).toISOString().slice(0, 19) !== ts.slice(0, 19)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

export interface EventCard {
  id: string; slug: string; title: string; coverImageUrl: string | null;
  startsAt: string; endsAt: string; timezone: string; city: string | null; state: string | null;
  venueName: string | null; addressHidden: boolean;
  host: { name: string; avatarUrl: string | null; kind: string };
  priceFromCents: number | null; hasFree: boolean; soldOut: boolean;
}

/** Same naming rules as the event page (hostIdentity in eventsRouter.ts), from columns already joined. Keep naming rules in sync with hostIdentity. */
export function hostIdentityFrom(r: {
  host_type: string; host_user_id: string;
  u_name?: string | null; u_first_name?: string | null; u_username?: string | null; u_image?: string | null;
  b_id?: string | null; b_name?: string | null; b_logo?: string | null;
  p_id?: string | null; p_name?: string | null; p_logo?: string | null;
}): { publicName: string; avatarUrl: string | null } {
  const user = {
    id: r.host_user_id, name: r.u_name ?? null, firstName: r.u_first_name ?? null, username: r.u_username ?? null,
    profileImageUrl: r.u_image ?? null, isVendor: false, isPhotographer: false,
  } as any; // same loose shape the event page passes (full User columns aren't loaded)
  if (r.host_type === "business" && r.b_id) {
    const id = pickPublicIdentity({ ...user, isVendor: true }, { id: r.b_id, name: r.b_name ?? "", logoImage: r.b_logo ?? null });
    return { publicName: id.publicName, avatarUrl: id.avatarUrl };
  }
  if (r.host_type === "photographer" && r.p_id) {
    const id = pickPublicIdentity({ ...user, isPhotographer: true }, null, { id: r.p_id, displayName: r.p_name ?? "", logoImage: r.p_logo ?? null });
    return { publicName: id.publicName, avatarUrl: id.avatarUrl };
  }
  const first = (r.u_first_name ?? "").trim();
  const username = (r.u_username ?? "").trim();
  return { publicName: first || (username ? `@${username}` : "Outsyde member"), avatarUrl: (r.u_image ?? "").trim() || null };
}

const isoOf = (v: unknown) => new Date(v as string).toISOString();

export function shapeCard(r: any): EventCard {
  const addr = visibleAddress(
    {
      venueName: r.venue_name ?? null, addressLine1: null, addressLine2: null,
      city: r.city ?? null, state: r.state ?? null, postalCode: null, latitude: null, longitude: null,
    },
    { addressVisibility: r.address_visibility, viewerIsHost: false, viewerHasTicket: false },
  );
  const host = hostIdentityFrom(r);
  return {
    id: r.id, slug: r.slug, title: r.title, coverImageUrl: r.cover_image_url ?? null,
    startsAt: isoOf(r.starts_at), endsAt: isoOf(r.ends_at), timezone: r.timezone,
    city: addr.city, state: addr.state, venueName: addr.venueName, addressHidden: addr.addressHidden,
    host: { name: host.publicName, avatarUrl: host.avatarUrl, kind: r.host_type },
    priceFromCents: r.price_from == null ? null : Number(r.price_from),
    hasFree: !!r.has_free,
    soldOut: r.capacity != null && Number(r.reserved_count) >= Number(r.capacity),
  };
}

/**
 * Event rows for one page (limit + 1 to detect a next page). The WHERE is the whole privacy filter;
 * the SELECT list carries the address columns only so shapeCard can run visibleAddress over them
 * (it drops everything but city/state/venue for hidden addresses and never copies coordinates).
 */
export function buildListSql(q: ListQuery, cursor: { ts: string; id: string } | null): SQL {
  const limit = q.limit ?? DEFAULT_LIMIT;
  const conds: SQL[] = [
    sql`ev.status = 'published'`,
    sql`ev.visibility = 'public'`,
    sql`ev.ends_at > now()`,
    sql`u.is_active = true`,
    sql`COALESCE(u.deletion_status, 'active') = 'active'`,
  ];
  if (q.city) conds.push(sql`lower(btrim(ev.city)) = lower(${q.city})`);
  if (q.from) conds.push(sql`ev.ends_at > ${q.from}::timestamptz`);
  if (q.to) conds.push(sql`ev.starts_at < ${q.to}::timestamptz`);
  if (q.free === "true") {
    conds.push(sql`NOT EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = ev.id AND tt.status = 'active' AND tt.hidden = false AND tt.price_cents > 0)`);
  }
  if (q.lat !== undefined && q.lng !== undefined) {
    const r = q.radiusKm ?? DEFAULT_RADIUS_KM;
    const dLat = r / 111.045;
    // Non-public addresses are compared at 0.1 degree (~11 km) resolution, so a sweep of tiny radii
    // cannot pin the real spot down; public addresses keep their exact point.
    const effLat = sql`(CASE WHEN ev.address_visibility = 'public' THEN ev.latitude ELSE ROUND(ev.latitude::numeric, 1)::float8 END)`;
    const effLng = sql`(CASE WHEN ev.address_visibility = 'public' THEN ev.longitude ELSE ROUND(ev.longitude::numeric, 1)::float8 END)`;
    conds.push(sql`ev.latitude IS NOT NULL AND ev.longitude IS NOT NULL`);
    conds.push(sql`${effLat} BETWEEN ${q.lat - dLat}::float8 AND ${q.lat + dLat}::float8`);
    const cosLat = Math.cos((q.lat * Math.PI) / 180);
    const dLng = cosLat > 0.01 ? r / (111.045 * cosLat) : 360;
    if (q.lng - dLng >= -180 && q.lng + dLng <= 180) {
      conds.push(sql`${effLng} BETWEEN ${q.lng - dLng}::float8 AND ${q.lng + dLng}::float8`);
    }
    conds.push(sql`(6371 * acos(LEAST(1.0, GREATEST(-1.0,
      cos(radians(${q.lat}::float8)) * cos(radians(${effLat})) * cos(radians(${effLng}) - radians(${q.lng}::float8)) +
      sin(radians(${q.lat}::float8)) * sin(radians(${effLat}))
    )))) <= ${r}::float8`);
  }
  if (cursor) conds.push(sql`(ev.starts_at, ev.id) > (${cursor.ts}::timestamptz, ${cursor.id}::varchar)`);

  const where = sql.join(conds, sql` AND `);
  return sql`
    SELECT ev.id, ev.slug, ev.title, ev.cover_image_url, ev.starts_at, ev.ends_at, ev.timezone,
           ev.venue_name, ev.city, ev.state, ev.address_visibility, ev.host_type, ev.host_user_id,
           ev.capacity, ev.reserved_count,
           to_char(ev.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts,
           u.name AS u_name, u.first_name AS u_first_name, u.username AS u_username, u.profile_image_url AS u_image,
           b.id AS b_id, b.name AS b_name, b.logo_image AS b_logo,
           p.id AS p_id, p.display_name AS p_name, p.logo_image AS p_logo,
           (SELECT MIN(tt.price_cents) FROM ticket_types tt
              WHERE tt.event_id = ev.id AND tt.status = 'active' AND tt.hidden = false AND tt.price_cents > 0) AS price_from,
           EXISTS (SELECT 1 FROM ticket_types tt
              WHERE tt.event_id = ev.id AND tt.status = 'active' AND tt.hidden = false AND tt.price_cents = 0) AS has_free
    FROM events ev
    JOIN users u ON u.id = ev.host_user_id
    LEFT JOIN businesses b ON b.id = ev.host_business_id
    LEFT JOIN photographers p ON p.id = ev.host_photographer_id
    WHERE ${where}
    ORDER BY ev.starts_at, ev.id
    LIMIT ${limit + 1}`;
}

export async function listPublicEvents(
  q: ListQuery,
  run: (query: SQL) => Promise<any[]>,
): Promise<{ events: EventCard[]; nextCursor: string | null } | { badCursor: true }> {
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cursor) return { badCursor: true };
  const limit = q.limit ?? DEFAULT_LIMIT;
  const found = await run(buildListSql(q, cursor));
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page.map(shapeCard),
    nextCursor: found.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
  };
}
