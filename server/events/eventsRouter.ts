/**
 * /api/events — Events & Ticketing, Phase 1 PR 1 (host side + public event page data).
 *
 *   POST  /                  (auth)  create a draft event
 *   GET   /mine              (auth)  the events I host
 *   GET   /slug/:slug        (public; host sees own drafts) event page data, address hidden until you have a ticket
 *   GET   /:id/manage        (auth, host)  full event + ticket types
 *   PATCH /:id               (auth, host)  edit (refund policy can only become more flexible once published)
 *   POST  /:id/publish       (auth, host)  draft -> published (needs a future start + at least one visible free ticket type)
 *   POST  /:id/cancel        (auth, host)  only while nobody holds a spot (cancelling with guests = refunds, Phase 2)
 *
 * Tables: migrations/056_events_tickets.sql (raw SQL, not in shared/schema.ts, like booking_payout_issues).
 * The database enforces capacity, quantities and money lines; neon-http has no transactions, so every
 * change here is one SQL statement. Host identity is always taken from the signed-in user, never the body.
 * Paid tickets are refused at publish until Phase 2 (checkout, fees, payouts) ships.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import { pickPublicIdentity } from "../publicIdentity";
import {
  isRefundPolicyChangeAllowed,
  isValidTimeZone,
  makeEventSlug,
  ticketSalesStatus,
  visibleAddress,
  type RefundPolicy,
  type TicketTypeForSale,
} from "./eventRules";

const router = Router();

const MAX_EVENT_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_START_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export async function rows<T = Record<string, any>>(query: SQL): Promise<T[]> {
  const result: any = await db.execute(query);
  return (result?.rows ?? result ?? []) as T[];
}

export function pgError(err: unknown): { code?: string; constraint?: string; message?: string } {
  const e = err as { code?: string; constraint?: string; message?: string; cause?: { code?: string; constraint?: string; message?: string } } | null;
  return {
    code: e?.code ?? e?.cause?.code,
    constraint: e?.constraint ?? e?.cause?.constraint,
    message: e?.message ?? e?.cause?.message,
  };
}

export const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const dateOrNull = (v: unknown): Date | null => (v == null ? null : new Date(v as string));

export function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}

// ─── Validation ─────────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
export const optionalText = (max: number) => text(max).nullable().optional().transform((v) => (v === "" ? null : v));
export const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) link");

const eventFields = {
  title: text(120).min(1),
  description: optionalText(5000),
  coverImageUrl: httpsUrl.nullable().optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  timezone: z.string().refine(isValidTimeZone, "unknown time zone"),
  venueName: optionalText(200),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postalCode: optionalText(20),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  addressVisibility: z.enum(["public", "ticket_holders"]).optional(),
  visibility: z.enum(["public", "unlisted"]).optional(),
  capacity: z.number().int().min(1).max(100000).nullable().optional(),
  refundPolicy: z.enum(["no_refunds", "until_cutoff"]).optional(),
  refundCutoffHours: z.number().int().min(0).max(8760).nullable().optional(),
};

const createSchema = z
  .object({ ...eventFields, hostAs: z.enum(["user", "business", "photographer"]).optional() })
  .strict();

const updateSchema = z
  .object({
    ...eventFields,
    title: eventFields.title.optional(),
    startsAt: eventFields.startsAt.optional(),
    endsAt: eventFields.endsAt.optional(),
    timezone: eventFields.timezone.optional(),
  })
  .strict();

/** Column for each editable field (camelCase body -> snake_case column). */
const COLUMNS: Record<string, string> = {
  title: "title", description: "description", coverImageUrl: "cover_image_url",
  startsAt: "starts_at", endsAt: "ends_at", timezone: "timezone",
  venueName: "venue_name", addressLine1: "address_line1", addressLine2: "address_line2",
  city: "city", state: "state", postalCode: "postal_code", latitude: "latitude", longitude: "longitude",
  addressVisibility: "address_visibility", visibility: "visibility", capacity: "capacity",
  refundPolicy: "refund_policy", refundCutoffHours: "refund_cutoff_hours",
};

export function zodError(res: Response, error: z.ZodError) {
  const first = error.issues[0];
  return fail(res, 400, "INVALID_EVENT", `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}`);
}

function checkTimes(startsAt: Date, endsAt: Date, now: Date, startChanged: boolean): string | null {
  if (startChanged && startsAt <= now) return "The event can't start in the past.";
  if (endsAt <= startsAt) return "The event has to end after it starts.";
  if (endsAt.getTime() - startsAt.getTime() > MAX_EVENT_LENGTH_MS) return "An event can last 30 days at most.";
  if (startsAt.getTime() - now.getTime() > MAX_START_AHEAD_MS) return "An event can start at most 2 years from now.";
  return null;
}

function checkRefund(policy: RefundPolicy, cutoffHours: number | null | undefined): string | null {
  if (policy === "until_cutoff" && (cutoffHours == null)) return "Choose how many hours before the event refunds stop.";
  return null;
}

// ─── Loading ────────────────────────────────────────────────────────────────

interface ActiveUser {
  id: string; name: string | null; first_name: string | null; username: string | null;
  profile_image_url: string | null; is_vendor: boolean; is_photographer: boolean;
}

export async function loadActiveUser(userId: string): Promise<ActiveUser | null> {
  const [u] = await rows<ActiveUser & { is_active: boolean; deletion_status: string }>(sql`
    SELECT id, name, first_name, username, profile_image_url, is_vendor, is_photographer, is_active, deletion_status
    FROM users WHERE id = ${userId}`);
  if (!u || u.is_active === false || (u.deletion_status && u.deletion_status !== "active")) return null;
  return u;
}

export async function loadEventForHost(eventId: string, userId: string): Promise<any | null> {
  const [e] = await rows(sql`SELECT * FROM events WHERE id = ${eventId} AND host_user_id = ${userId}`);
  return e ?? null;
}

export async function loadTicketTypes(eventId: string): Promise<any[]> {
  return rows(sql`SELECT * FROM ticket_types WHERE event_id = ${eventId} ORDER BY sort_order, created_at`);
}

async function hostIdentity(e: any): Promise<{ publicName: string; avatarUrl: string | null }> {
  const [u] = await rows<any>(sql`
    SELECT id, name, first_name, username, profile_image_url FROM users WHERE id = ${e.host_user_id}`);
  const user = {
    id: e.host_user_id, name: u?.name ?? null, firstName: u?.first_name ?? null, username: u?.username ?? null,
    profileImageUrl: u?.profile_image_url ?? null, isVendor: false, isPhotographer: false,
  };
  if (e.host_type === "business" && e.host_business_id) {
    const [b] = await rows<any>(sql`SELECT id, name, logo_image FROM businesses WHERE id = ${e.host_business_id}`);
    if (b) {
      const id = pickPublicIdentity({ ...user, isVendor: true }, { id: b.id, name: b.name, logoImage: b.logo_image });
      return { publicName: id.publicName, avatarUrl: id.avatarUrl };
    }
  }
  if (e.host_type === "photographer" && e.host_photographer_id) {
    const [p] = await rows<any>(sql`SELECT id, display_name, logo_image FROM photographers WHERE id = ${e.host_photographer_id}`);
    if (p) {
      const id = pickPublicIdentity({ ...user, isPhotographer: true }, null, { id: p.id, displayName: p.display_name, logoImage: p.logo_image });
      return { publicName: id.publicName, avatarUrl: id.avatarUrl };
    }
  }
  // A person hosting as themselves: first name or @username only (users.name often holds "First Last").
  const first = (u?.first_name ?? "").trim();
  const username = (u?.username ?? "").trim();
  return { publicName: first || (username ? `@${username}` : "Outsyde member"), avatarUrl: (u?.profile_image_url ?? "").trim() || null };
}

// ─── Serializers (additive only once clients ship) ──────────────────────────

function ticketTypeForSale(t: any): TicketTypeForSale {
  return {
    id: t.id, quantity: Number(t.quantity), reservedCount: Number(t.reserved_count),
    salesStartAt: dateOrNull(t.sales_start_at), salesEndAt: dateOrNull(t.sales_end_at),
    unlockAfterTicketTypeId: t.unlock_after_ticket_type_id ?? null,
  };
}

function eventRemaining(e: any): number | null {
  return e.capacity == null ? null : Math.max(0, Number(e.capacity) - Number(e.reserved_count));
}

export function hostTicketTypeJson(t: any) {
  return {
    id: t.id, name: t.name, description: t.description ?? null, priceCents: Number(t.price_cents),
    quantity: Number(t.quantity), takenCount: Number(t.reserved_count),
    salesStartAt: iso(t.sales_start_at), salesEndAt: iso(t.sales_end_at),
    unlockAfterTicketTypeId: t.unlock_after_ticket_type_id ?? null,
    minPerOrder: Number(t.min_per_order), maxPerOrder: Number(t.max_per_order),
    perAccountLimit: t.per_account_limit == null ? null : Number(t.per_account_limit),
    hidden: !!t.hidden, sortOrder: Number(t.sort_order), status: t.status,
  };
}

function hostEventJson(e: any) {
  return {
    id: e.id, slug: e.slug, status: e.status, hostType: e.host_type,
    hostBusinessId: e.host_business_id ?? null, hostPhotographerId: e.host_photographer_id ?? null,
    title: e.title, description: e.description ?? null, coverImageUrl: e.cover_image_url ?? null,
    startsAt: iso(e.starts_at), endsAt: iso(e.ends_at), timezone: e.timezone,
    venueName: e.venue_name ?? null, addressLine1: e.address_line1 ?? null, addressLine2: e.address_line2 ?? null,
    city: e.city ?? null, state: e.state ?? null, postalCode: e.postal_code ?? null,
    latitude: e.latitude == null ? null : Number(e.latitude), longitude: e.longitude == null ? null : Number(e.longitude),
    addressVisibility: e.address_visibility, visibility: e.visibility,
    capacity: e.capacity == null ? null : Number(e.capacity), takenCount: Number(e.reserved_count),
    refundPolicy: e.refund_policy, refundCutoffHours: e.refund_cutoff_hours == null ? null : Number(e.refund_cutoff_hours),
    publishedAt: iso(e.published_at), cancelledAt: iso(e.cancelled_at),
    createdAt: iso(e.created_at), updatedAt: iso(e.updated_at),
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

router.post("/", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to create an event.");
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return zodError(res, parsed.error);
  const b = parsed.data;

  try {
    const user = await loadActiveUser(userId);
    if (!user) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't host events.");

    const now = new Date();
    const startsAt = new Date(b.startsAt);
    const endsAt = new Date(b.endsAt);
    const timeError = checkTimes(startsAt, endsAt, now, true);
    if (timeError) return fail(res, 400, "INVALID_EVENT_TIMES", timeError);
    const refundPolicy = (b.refundPolicy ?? "no_refunds") as RefundPolicy;
    const refundError = checkRefund(refundPolicy, b.refundCutoffHours);
    if (refundError) return fail(res, 400, "INVALID_REFUND_POLICY", refundError);

    // Host profile comes from the signed-in user only.
    const hostAs = b.hostAs ?? "user";
    let hostBusinessId: string | null = null;
    let hostPhotographerId: string | null = null;
    if (hostAs === "business") {
      const [biz] = await rows<any>(sql`
        SELECT id, approval_status FROM businesses WHERE owner_id = ${userId}
        ORDER BY (approval_status = 'approved') DESC, created_at ASC LIMIT 1`);
      if (!biz) return fail(res, 403, "NOT_A_BUSINESS_OWNER", "You don't own a business on Outsyde.");
      if (biz.approval_status !== "approved") return fail(res, 403, "BUSINESS_NOT_APPROVED", "Your business has to be approved before it can host events.");
      hostBusinessId = biz.id;
    } else if (hostAs === "photographer") {
      const [p] = await rows<any>(sql`SELECT id FROM photographers WHERE user_id = ${userId} ORDER BY created_at ASC LIMIT 1`);
      if (!p) return fail(res, 403, "NOT_A_PHOTOGRAPHER", "You don't have a photographer profile.");
      hostPhotographerId = p.id;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = makeEventSlug(b.title);
      try {
        const [created] = await rows(sql`
          INSERT INTO events (
            host_user_id, host_type, host_business_id, host_photographer_id, slug, title, description, cover_image_url,
            starts_at, ends_at, timezone, venue_name, address_line1, address_line2, city, state, postal_code,
            latitude, longitude, address_visibility, visibility, capacity, refund_policy, refund_cutoff_hours
          ) VALUES (
            ${userId}, ${hostAs}, ${hostBusinessId}, ${hostPhotographerId}, ${slug}, ${b.title}, ${b.description ?? null},
            ${b.coverImageUrl ?? null}, ${startsAt.toISOString()}, ${endsAt.toISOString()}, ${b.timezone},
            ${b.venueName ?? null}, ${b.addressLine1 ?? null}, ${b.addressLine2 ?? null}, ${b.city ?? null},
            ${b.state ?? null}, ${b.postalCode ?? null}, ${b.latitude ?? null}, ${b.longitude ?? null},
            ${b.addressVisibility ?? "ticket_holders"}, ${b.visibility ?? "public"}, ${b.capacity ?? null},
            ${refundPolicy}, ${refundPolicy === "until_cutoff" ? b.refundCutoffHours ?? null : null}
          ) RETURNING *`);
        return res.status(201).json({ success: true, event: hostEventJson(created), ticketTypes: [] });
      } catch (err) {
        const pe = pgError(err);
        if (pe.code === "23505" && pe.constraint === "uq_events_slug") continue;
        throw err;
      }
    }
    return fail(res, 500, "SLUG_FAILED", "Couldn't create a link for this event. Try again.");
  } catch (err) {
    console.error("[Events] create failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't create the event.");
  }
});

router.get("/mine", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to see your events.");
  try {
    const list = await rows(sql`SELECT * FROM events WHERE host_user_id = ${userId} ORDER BY starts_at DESC LIMIT 200`);
    return res.json({ success: true, events: list.map(hostEventJson) });
  } catch (err) {
    console.error("[Events] mine failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load your events.");
  }
});

router.get("/slug/:slug", async (req: Request, res: Response) => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
  try {
    const [e] = await rows<any>(sql`
      SELECT ev.* FROM events ev JOIN users u ON u.id = ev.host_user_id
      WHERE ev.slug = ${slug} AND u.is_active = true AND COALESCE(u.deletion_status, 'active') = 'active'`);
    const viewerId = getUserIdFromRequest(req);
    const viewerIsHost = !!e && !!viewerId && viewerId === e.host_user_id;
    // Drafts are visible to their host only (preview); admin-paused events to nobody.
    if (!e || e.status === "paused" || (e.status === "draft" && !viewerIsHost)) {
      return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    }

    let viewerHasTicket = false;
    if (viewerId && !viewerIsHost) {
      const [t] = await rows(sql`
        SELECT 1 FROM tickets WHERE event_id = ${e.id} AND holder_user_id = ${viewerId} AND status = 'valid' LIMIT 1`);
      viewerHasTicket = !!t;
    }

    // Sales status is worked out over every active type (a hidden type can still be what unlocks
    // the next tier); only visible ones are returned.
    const activeTypes = (await loadTicketTypes(e.id)).filter((t) => t.status === "active");
    const allForSale = activeTypes.map(ticketTypeForSale);
    const types = activeTypes.filter((t) => !t.hidden);
    const forSale = types.map(ticketTypeForSale);
    const now = new Date();
    const remainingAtEvent = eventRemaining(e);
    const ticketTypes = types.map((t, i) => {
      const s = e.status === "cancelled"
        ? { status: "ended" as const, remaining: 0 }
        : ticketSalesStatus(forSale[i], allForSale, remainingAtEvent, now);
      return {
        id: t.id, name: t.name, description: t.description ?? null, priceCents: Number(t.price_cents),
        salesStatus: s.status, remaining: s.remaining,
        salesStartAt: iso(t.sales_start_at), salesEndAt: iso(t.sales_end_at),
        minPerOrder: Number(t.min_per_order), maxPerOrder: Number(t.max_per_order),
        perAccountLimit: t.per_account_limit == null ? null : Number(t.per_account_limit),
      };
    });

    const address = visibleAddress(
      {
        venueName: e.venue_name ?? null, addressLine1: e.address_line1 ?? null, addressLine2: e.address_line2 ?? null,
        city: e.city ?? null, state: e.state ?? null, postalCode: e.postal_code ?? null,
        latitude: e.latitude == null ? null : Number(e.latitude), longitude: e.longitude == null ? null : Number(e.longitude),
      },
      { addressVisibility: e.address_visibility, viewerIsHost, viewerHasTicket },
    );
    const host = await hostIdentity(e);

    return res.json({
      success: true,
      event: {
        id: e.id, slug: e.slug, status: e.status, title: e.title, description: e.description ?? null,
        coverImageUrl: e.cover_image_url ?? null, startsAt: iso(e.starts_at), endsAt: iso(e.ends_at), timezone: e.timezone,
        ...address,
        refundPolicy: e.refund_policy, refundCutoffHours: e.refund_cutoff_hours == null ? null : Number(e.refund_cutoff_hours),
        soldOut: remainingAtEvent === 0,
        host: { name: host.publicName, avatarUrl: host.avatarUrl, kind: e.host_type },
        viewerIsHost, viewerHasTicket,
      },
      ticketTypes,
    });
  } catch (err) {
    console.error("[Events] public read failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load the event.");
  }
});

router.get("/:id/manage", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to manage this event.");
  try {
    const e = await loadEventForHost(req.params.id, userId);
    if (!e) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    const types = await loadTicketTypes(e.id);
    return res.json({ success: true, event: hostEventJson(e), ticketTypes: types.map(hostTicketTypeJson) });
  } catch (err) {
    console.error("[Events] manage read failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load the event.");
  }
});

router.patch("/:id", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to edit this event.");
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return zodError(res, parsed.error);
  const b = parsed.data as Record<string, any>;
  if (Object.keys(b).length === 0) return fail(res, 400, "NOTHING_TO_UPDATE", "Nothing to update.");

  try {
    if (!(await loadActiveUser(userId))) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't host events.");
    const e = await loadEventForHost(req.params.id, userId);
    if (!e) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    if (e.status === "cancelled") return fail(res, 409, "EVENT_CANCELLED", "A cancelled event can't be edited.");
    if (e.status === "paused") return fail(res, 409, "EVENT_PAUSED", "This event is paused by Outsyde. Contact support.");

    const startsAt = b.startsAt ? new Date(b.startsAt) : new Date(e.starts_at);
    const endsAt = b.endsAt ? new Date(b.endsAt) : new Date(e.ends_at);
    if (b.startsAt || b.endsAt) {
      const startChanged = !!b.startsAt && startsAt.getTime() !== new Date(e.starts_at).getTime();
      const timeError = checkTimes(startsAt, endsAt, new Date(), startChanged);
      if (timeError) return fail(res, 400, "INVALID_EVENT_TIMES", timeError);
    }

    const nextPolicy = (b.refundPolicy ?? e.refund_policy) as RefundPolicy;
    let nextCutoff: number | null =
      b.refundCutoffHours !== undefined ? b.refundCutoffHours : e.refund_cutoff_hours == null ? null : Number(e.refund_cutoff_hours);
    if (nextPolicy === "no_refunds") nextCutoff = null;
    if (b.refundPolicy !== undefined || b.refundCutoffHours !== undefined) {
      const refundError = checkRefund(nextPolicy, nextCutoff);
      if (refundError) return fail(res, 400, "INVALID_REFUND_POLICY", refundError);
      if (e.status !== "draft" && !isRefundPolicyChangeAllowed(
        { policy: e.refund_policy, cutoffHours: e.refund_cutoff_hours == null ? null : Number(e.refund_cutoff_hours) },
        { policy: nextPolicy, cutoffHours: nextCutoff },
      )) {
        return fail(res, 409, "REFUND_POLICY_LOCKED", "Once an event is published its refund policy can only become more flexible.");
      }
      b.refundPolicy = nextPolicy;
      b.refundCutoffHours = nextCutoff;
    }
    if (b.startsAt) b.startsAt = startsAt.toISOString();
    if (b.endsAt) b.endsAt = endsAt.toISOString();

    const sets: SQL[] = Object.keys(b)
      .filter((k) => COLUMNS[k])
      .map((k) => sql`${sql.raw(COLUMNS[k])} = ${b[k] ?? null}`);
    sets.push(sql`updated_at = now()`);

    try {
      const [updated] = await rows(sql`
        UPDATE events SET ${sql.join(sets, sql`, `)}
        WHERE id = ${e.id} AND host_user_id = ${userId} AND status = ${e.status}
          AND refund_policy = ${e.refund_policy}
          AND refund_cutoff_hours IS NOT DISTINCT FROM ${e.refund_cutoff_hours == null ? null : Number(e.refund_cutoff_hours)}::int
        RETURNING *`);
      if (!updated) return fail(res, 409, "EVENT_CHANGED", "This event just changed. Reload and try again.");
      const types = await loadTicketTypes(e.id);
      return res.json({ success: true, event: hostEventJson(updated), ticketTypes: types.map(hostTicketTypeJson) });
    } catch (err) {
      const pe = pgError(err);
      if (pe.code === "23514" && pe.constraint === "events_capacity_not_exceeded") {
        return fail(res, 409, "CAPACITY_BELOW_TAKEN", "Capacity can't be lower than the spots already taken.");
      }
      throw err;
    }
  } catch (err) {
    console.error("[Events] update failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't update the event.");
  }
});

router.post("/:id/publish", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to publish this event.");
  try {
    if (!(await loadActiveUser(userId))) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't host events.");
    const [published] = await rows(sql`
      UPDATE events SET status = 'published', published_at = now(), updated_at = now()
      WHERE id = ${req.params.id} AND host_user_id = ${userId} AND status = 'draft' AND starts_at > now()
        AND EXISTS (SELECT 1 FROM ticket_types t WHERE t.event_id = events.id AND t.status = 'active' AND t.hidden = false)
        AND NOT EXISTS (SELECT 1 FROM ticket_types t WHERE t.event_id = events.id AND t.status = 'active' AND t.price_cents > 0)
      RETURNING *`);
    if (published) {
      const types = await loadTicketTypes(published.id);
      return res.json({ success: true, event: hostEventJson(published), ticketTypes: types.map(hostTicketTypeJson) });
    }

    // Nothing changed: say why.
    const e = await loadEventForHost(req.params.id, userId);
    if (!e) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    if (e.status !== "draft") return fail(res, 409, "NOT_A_DRAFT", "Only a draft can be published.");
    if (new Date(e.starts_at) <= new Date()) return fail(res, 409, "EVENT_IN_PAST", "The event has already started.");
    const types = (await loadTicketTypes(e.id)).filter((t) => t.status === "active");
    if (types.length === 0) return fail(res, 409, "NO_TICKET_TYPES", "Add at least one ticket type first.");
    if (!types.some((t) => !t.hidden)) return fail(res, 409, "NO_VISIBLE_TICKET_TYPES", "At least one ticket type has to be visible to guests.");
    if (types.some((t) => Number(t.price_cents) > 0)) {
      return fail(res, 409, "PAID_TICKETS_NOT_AVAILABLE", "Paid tickets aren't available yet. Use free tickets for now.");
    }
    return fail(res, 409, "EVENT_CHANGED", "This event just changed. Reload and try again.");
  } catch (err) {
    console.error("[Events] publish failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't publish the event.");
  }
});

const cancelSchema = z.object({ reason: optionalText(500) }).strict();

router.post("/:id/cancel", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to cancel this event.");
  const parsed = cancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) return zodError(res, parsed.error);
  try {
    const [cancelled] = await rows(sql`
      UPDATE events SET status = 'cancelled', cancelled_at = now(), cancel_reason = ${parsed.data.reason ?? null}, updated_at = now()
      WHERE id = ${req.params.id} AND host_user_id = ${userId} AND status IN ('draft', 'published')
        AND reserved_count = 0
        AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = events.id AND t.status = 'valid')
        AND NOT EXISTS (SELECT 1 FROM ticket_order_items i WHERE i.event_id = events.id AND i.status = 'held')
      RETURNING *`);
    if (cancelled) return res.json({ success: true, event: hostEventJson(cancelled) });

    const e = await loadEventForHost(req.params.id, userId);
    if (!e) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    if (e.status === "cancelled") return fail(res, 409, "ALREADY_CANCELLED", "This event is already cancelled.");
    if (e.status === "paused") return fail(res, 409, "EVENT_PAUSED", "This event is paused by Outsyde. Contact support.");
    return fail(res, 409, "EVENT_HAS_GUESTS", "People already have spots. Cancelling with guests isn't available yet.");
  } catch (err) {
    console.error("[Events] cancel failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't cancel the event.");
  }
});

export default router;
