/**
 * /api/events — Events & Ticketing, Phase 1 PR 1 (host side + public event page data).
 *
 *   POST  /                  (auth)  create a draft event
 *   GET   /                  (public) listed upcoming events for Discover (eventList.ts), no private address data
 *   GET   /mine              (auth)  the events I host
 *   GET   /slug/:slug        (public; host sees own drafts) event page data, address hidden until you have a ticket
 *   GET   /:id/manage        (auth, host)  full event + ticket types
 *   PATCH /:id               (auth, host)  edit (refund policy can only become more flexible once published)
 *   POST  /:id/publish       (auth, host)  draft -> published (needs a future start, at least one visible ticket type and
 *                                          the current Event Host Agreement accepted: 409 HOST_AGREEMENT_REQUIRED, hostAgreement.ts)
 *   POST  /:id/cancel        (auth, host)  cancel; free RSVPs cancelled, paid orders refunded in full (ticketRefunds.ts)
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
  checkTimes,
  makeEventSlug,
  paidEventsEnabled,
  ticketSalesStatus,
  holderCanSeeAddress,
  addressRevealAt,
  visibleAddress,
  type RefundPolicy,
  type TicketTypeForSale,
} from "./eventRules";
import { calculateTicketFees } from "../fees";
import { geocodeEventInBackground } from "./eventGeocode";
import { listQuerySchema, listPublicEvents } from "./eventList";

const router = Router();


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
  addressVisibility: z.enum(["public", "ticket_holders", "ticket_holders_day_of"]).optional(),
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

// Keep naming rules in sync with hostIdentityFrom in eventList.ts (the public list shapes the same host names).
/** followId is what POST /api/follows takes: the business or photographer id (resolved to its owner there), else the user id. */
export async function hostIdentity(e: any): Promise<{ publicName: string; avatarUrl: string | null; followId: string }> {
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
      return { publicName: id.publicName, avatarUrl: id.avatarUrl, followId: String(b.id) };
    }
  }
  if (e.host_type === "photographer" && e.host_photographer_id) {
    const [p] = await rows<any>(sql`SELECT id, display_name, logo_image FROM photographers WHERE id = ${e.host_photographer_id}`);
    if (p) {
      const id = pickPublicIdentity({ ...user, isPhotographer: true }, null, { id: p.id, displayName: p.display_name, logoImage: p.logo_image });
      return { publicName: id.publicName, avatarUrl: id.avatarUrl, followId: String(p.id) };
    }
  }
  // A person hosting as themselves: their display name (users.name), else @username, never the real
  // first or last name (Legend 2026-10-18 and 2026-10-23, server/personName.ts). Same rule as the feed.
  const id = pickPublicIdentity(user);
  return { publicName: id.publicName, avatarUrl: id.avatarUrl, followId: String(e.host_user_id) };
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

/**
 * Host profile for hostAs = business | photographer, from the signed-in user only: business = the caller's
 * business (approved first, must be approved), photographer = the caller's profile. Shared by event create and
 * the payout routes so both always pick the same profile.
 */
export async function resolveOwnedHostProfile(userId: string, hostAs: string):
  Promise<{ ok: true; businessId: string | null; photographerId: string | null } | { ok: false; code: string; message: string }> {
  if (hostAs === "business") {
    const [biz] = await rows<any>(sql`
      SELECT id, approval_status FROM businesses WHERE owner_id = ${userId}
      ORDER BY (approval_status = 'approved') DESC, created_at ASC LIMIT 1`);
    if (!biz) return { ok: false, code: "NOT_A_BUSINESS_OWNER", message: "You don't own a business on Outsyde." };
    if (biz.approval_status !== "approved") return { ok: false, code: "BUSINESS_NOT_APPROVED", message: "Your business has to be approved before it can host events." };
    return { ok: true, businessId: biz.id, photographerId: null };
  }
  if (hostAs === "photographer") {
    const [p] = await rows<any>(sql`SELECT id FROM photographers WHERE user_id = ${userId} ORDER BY created_at ASC LIMIT 1`);
    if (!p) return { ok: false, code: "NOT_A_PHOTOGRAPHER", message: "You don't have a photographer profile." };
    return { ok: true, businessId: null, photographerId: p.id };
  }
  return { ok: true, businessId: null, photographerId: null };
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
    const owned = await resolveOwnedHostProfile(userId, hostAs);
    if (!owned.ok) return fail(res, 403, owned.code, owned.message);
    const hostBusinessId = owned.businessId;
    const hostPhotographerId = owned.photographerId;

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
        if (b.latitude == null && b.longitude == null && (b.addressLine1 || b.city || b.state || b.postalCode)) {
          geocodeEventInBackground(created.id, {
            addressLine1: created.address_line1 ?? null, city: created.city ?? null,
            state: created.state ?? null, postalCode: created.postal_code ?? null,
          });
        }
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

// Public list. Registered before every /:id route and without auth middleware on purpose: a stale or
// invalid Bearer must not turn a public read into a 401.
router.get("/", async (req: Request, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "INVALID_QUERY", "Check the filters and try again.");
  try {
    const out = await listPublicEvents(parsed.data, (q) => rows(q));
    if ("badCursor" in out) return fail(res, 400, "INVALID_QUERY", "Check the filters and try again.");
    return res.json({ success: true, events: out.events, nextCursor: out.nextCursor });
  } catch (err) {
    console.error("[Events] list failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load events.");
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
      // Same math checkout uses for one ticket. Free types have nothing to preview.
      const priceCents = Number(t.price_cents);
      const f = priceCents > 0 ? calculateTicketFees(priceCents, 1) : null;
      return {
        id: t.id, name: t.name, description: t.description ?? null, priceCents: Number(t.price_cents),
        serviceFeeCents: f ? f.unitServiceFeeCents + f.unitPerTicketFeeCents : null,
        buyerTotalCents: f ? f.unitBuyerTotalCents : null,
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
      {
        addressVisibility: e.address_visibility, viewerIsHost, viewerHasTicket,
        holderRevealed: holderCanSeeAddress(e.address_visibility, new Date(e.starts_at), e.timezone, new Date()),
      },
    );
    const host = await hostIdentity(e);

    return res.json({
      success: true,
      event: {
        id: e.id, slug: e.slug, status: e.status, title: e.title, description: e.description ?? null,
        coverImageUrl: e.cover_image_url ?? null, startsAt: iso(e.starts_at), endsAt: iso(e.ends_at), timezone: e.timezone,
        ...address,
        addressRevealAt: e.address_visibility === "ticket_holders_day_of" ? iso(addressRevealAt(new Date(e.starts_at), e.timezone)) : null,
        refundPolicy: e.refund_policy, refundCutoffHours: e.refund_cutoff_hours == null ? null : Number(e.refund_cutoff_hours),
        visibility: e.visibility,
        soldOut: remainingAtEvent === 0,
        host: { name: host.publicName, avatarUrl: host.avatarUrl, kind: e.host_type, followId: host.followId },
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
      const now = new Date();
      const started = new Date(e.starts_at) <= now;
      const timeError = checkTimes(startsAt, endsAt, now, startChanged, new Date(e.ends_at), started);
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

    // Guards for the started-event rules: an event that started after the check above can't take an earlier end,
    // and its start can't move (sent back unchanged is fine). No row -> EVENT_CHANGED.
    const newEndsAt: string | null = b.endsAt ?? null;
    const newStartsAt: string | null = b.startsAt ?? null;
    const sets: SQL[] = Object.keys(b)
      .filter((k) => COLUMNS[k])
      .map((k) => sql`${sql.raw(COLUMNS[k])} = ${b[k] ?? null}`);
    // Moving the address without sending coordinates clears the old ones in the same write; they are re-geocoded below.
    const addressChanged = ["addressLine1", "city", "state", "postalCode"].some((k) => b[k] !== undefined);
    const coordsSent = b.latitude !== undefined || b.longitude !== undefined;
    const regeocode = addressChanged && !coordsSent;
    if (regeocode) sets.push(sql`latitude = NULL`, sql`longitude = NULL`);
    // A new start time means new reminder moments: clear the host's and every guest's reminder stamps
    // (eventReminders.ts) in this same statement, so the job can't claim against the old time in between.
    const startMoved = newStartsAt !== null && new Date(newStartsAt).getTime() !== new Date(e.starts_at).getTime();
    if (startMoved) sets.push(sql`host_reminder_at = NULL`);
    sets.push(sql`updated_at = now()`);

    try {
      const [updated] = await rows(sql`
        WITH u AS (
          UPDATE events SET ${sql.join(sets, sql`, `)}
          WHERE id = ${e.id} AND host_user_id = ${userId} AND status = ${e.status}
            AND refund_policy = ${e.refund_policy}
            AND refund_cutoff_hours IS NOT DISTINCT FROM ${e.refund_cutoff_hours == null ? null : Number(e.refund_cutoff_hours)}::int
            AND (starts_at > now() OR ${b.endsAt === undefined} OR ${newEndsAt}::timestamptz >= date_trunc('milliseconds', ends_at))
            AND (starts_at > now() OR ${b.startsAt === undefined} OR ${newStartsAt}::timestamptz = date_trunc('milliseconds', starts_at))
          RETURNING *
        ),
        reminders AS (
          UPDATE tickets SET reminder_day_before_at = NULL, reminder_soon_at = NULL
          WHERE ${startMoved} AND event_id IN (SELECT id FROM u)
            AND (reminder_day_before_at IS NOT NULL OR reminder_soon_at IS NOT NULL)
          RETURNING 1
        )
        SELECT * FROM u`);
      if (!updated) return fail(res, 409, "EVENT_CHANGED", "This event just changed. Reload and try again.");
      if (regeocode) {
        geocodeEventInBackground(updated.id, {
          addressLine1: updated.address_line1 ?? null, city: updated.city ?? null,
          state: updated.state ?? null, postalCode: updated.postal_code ?? null,
        });
      }
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
    // The publishing user must have accepted the current Event Host Agreement (hostAgreement.ts). Checked inside the UPDATE.
    const { acceptedCurrentVersionSql } = await import("./hostAgreement");
    // Every host needs payouts set up to publish, free events too (Legend 2026-10-26), so adding paid tickets
    // later never stops a live event. Free: our own record of a finished setup on the account this event pays
    // (the business's or photographer's for those hosts). Paid: also the switch AND a live Stripe check.
    // Both are checked before the single UPDATE below.
    const { hostPayoutDestination, isHostReady } = await import("./hostPayouts");
    let payoutsSetUp = false;
    let paidAllowed = false;
    const ev = await loadEventForHost(req.params.id, userId);
    if (ev && ev.status === "draft") {
      const dest = await hostPayoutDestination(ev);
      payoutsSetUp = !!dest.accountId && dest.localReady;
      if (paidEventsEnabled()) {
        const paid = await rows(sql`SELECT 1 FROM ticket_types WHERE event_id = ${ev.id} AND status = 'active' AND price_cents > 0 LIMIT 1`);
        if (paid.length > 0) paidAllowed = (await isHostReady(ev)).ready;
      }
    }
    const [published] = await rows(sql`
      UPDATE events SET status = 'published', published_at = now(), updated_at = now()
      WHERE id = ${req.params.id} AND host_user_id = ${userId} AND status = 'draft' AND starts_at > now()
        AND ${acceptedCurrentVersionSql(userId)}
        AND ${payoutsSetUp}
        AND EXISTS (SELECT 1 FROM ticket_types t WHERE t.event_id = events.id AND t.status = 'active' AND t.hidden = false)
        AND (NOT EXISTS (SELECT 1 FROM ticket_types t WHERE t.event_id = events.id AND t.status = 'active' AND t.price_cents > 0)
             OR ${paidAllowed})
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
    if (types.some((t) => Number(t.price_cents) > 0) && !paidAllowed) {
      if (!paidEventsEnabled()) return fail(res, 409, "PAID_TICKETS_NOT_AVAILABLE", "Paid tickets aren't available yet. Use free tickets for now.");
      return fail(res, 409, "PAYOUTS_NOT_SET_UP", "Set up payouts before selling paid tickets.");
    }
    const { acceptanceOf } = await import("./hostAgreement");
    if (!(await acceptanceOf(userId))) {
      return fail(res, 409, "HOST_AGREEMENT_REQUIRED", "Read and accept the Event Host Agreement to publish.");
    }
    if (!payoutsSetUp) {
      return fail(res, 409, "PAYOUTS_NOT_SET_UP", "Set up payouts before you publish. Every host needs payouts set up, even for free events.");
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
    // Cancelling with guests (Phase 2 PR 4): free RSVPs are cancelled and every paid order is refunded in
    // full, fees included. Closing the event comes first, so nothing new can be claimed or bought; the
    // guests are handled right after, and the every-minute refund job repeats that step as a backstop.
    const [cancelled] = await rows(sql`
      UPDATE events SET status = 'cancelled', cancelled_at = now(), cancel_reason = ${parsed.data.reason ?? null}, updated_at = now()
      WHERE id = ${req.params.id} AND host_user_id = ${userId} AND status IN ('draft', 'published')
        -- Once it has started, an event with paid orders can't be cancelled by the host (that would refund
        -- every fee for an event that happened). Single orders can still be refunded; anything else is support.
        AND (starts_at > now() OR NOT EXISTS (
          SELECT 1 FROM ticket_orders o WHERE o.event_id = events.id AND o.total_cents > 0
            AND o.status IN ('pending', 'completed', 'refunding', 'refunded')))
      RETURNING *`);
    if (cancelled) {
      const guests = { freeCancelled: 0, refunding: 0 };
      try {
        const { queueCancelledEventOrders, processTicketRefund } = await import("./ticketRefunds");
        const { notifyFreeOrdersCancelled } = await import("./ticketNotices");
        const q = await queueCancelledEventOrders(String((cancelled as any).id));
        guests.freeCancelled = q.freeCancelled.length;
        guests.refunding = q.refunding.length;
        void notifyFreeOrdersCancelled(q.freeCancelled);
        // Refunds talk to Stripe: run after the answer; the job retries what fails.
        setImmediate(async () => {
          for (const id of q.refunding) await processTicketRefund(id, undefined, true).catch((err) => console.error(`[Events] refund ${id} failed:`, err));
        });
      } catch (err) {
        console.error("[Events] cancel guests step failed (the refund job will repeat it):", err);
      }
      // Open checkouts: stopped even when the step above failed (the job repeats this too).
      setImmediate(() => {
        import("./ticketRefunds")
          .then((m) => m.closePendingCheckouts(String((cancelled as any).id)))
          .catch((err) => console.error("[Events] closing checkouts failed:", err));
      });
      return res.json({ success: true, event: hostEventJson(cancelled), guests });
    }

    const e = await loadEventForHost(req.params.id, userId);
    if (!e) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    if (e.status === "cancelled") return fail(res, 409, "ALREADY_CANCELLED", "This event is already cancelled.");
    if (e.status === "paused") return fail(res, 409, "EVENT_PAUSED", "This event is paused by Outsyde. Contact support.");
    if (new Date(e.starts_at) <= new Date()) {
      return fail(res, 409, "EVENT_STARTED", "This event has already started, so it can't be cancelled here. You can still refund single orders, or contact Outsyde support.");
    }
    return fail(res, 409, "EVENT_NOT_CANCELLABLE", "This event can't be cancelled.");
  } catch (err) {
    console.error("[Events] cancel failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't cancel the event.");
  }
});

export default router;
