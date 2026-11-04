/**
 * Quotes (Quotes in Messages, step 2, migration 097). Rules: ./quoteRules.ts. No payment here (step 3).
 *
 *   POST  /api/quotes                       business owner, or an active staff member with a login, inside a chat
 *   PATCH /api/quotes/:id                   the business owner, or the staff member who sent it: edit (new version)
 *   POST  /api/quotes/:id/withdraw          same people
 *   POST  /api/quotes/:id/decline           the customer { reason? }
 *   GET   /api/quotes/:id                   the customer, the business owner, the sending staff member, or admin
 *   GET   /api/conversations/:id/quotes     the two people in the chat
 *   GET   /api/vendor/quotes                business owner (or admin with x-business-id)
 *   GET   /api/me/quotes                    the customer
 *
 * Every change is one UPDATE guarded by status, expiry and (for edits) version, so two taps can never both win.
 */
import type { Express, Request } from "express";
import { randomBytes } from "crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { getUserIdFromRequest } from "../auth";
import { businesses, estimateRequests, quotes, staffMembers, type Business, type Quote } from "@shared/schema";
import { resolveVendorBusiness } from "../estimates/estimateRequestRoutes";
import { resolveTimeZone } from "../manualRequests";
import { postCardMessage } from "../messaging/postCard";
import { checkQuoteInput, effectiveStatus, quoteAmounts, quoteMessageText, quoteTiming, type QuoteEvent } from "./quoteRules";
import { sendQuoteEmailIfEnabled } from "./quoteEmail";

const ADMIN_EMAILS = ["info@goutsyde.com", "jamesmeyers2304@gmail.com"];
const MAX_REASON = 500;

const userIdOf = (req: Request): string | null => (req.session as any)?.userId || getUserIdFromRequest(req);
const newLinkCode = () => randomBytes(12).toString("base64url");

export function toQuoteJson(q: Quote, businessName: string | null, now = new Date()) {
  return {
    id: q.id,
    status: effectiveStatus(q, now),
    version: q.version,
    businessId: q.businessId,
    businessName: businessName?.trim() ?? null,
    staffMemberId: q.staffMemberId ?? null,
    senderId: q.senderId,
    customerId: q.customerId,
    conversationId: q.conversationId,
    requestId: q.requestId ?? null,
    serviceId: q.serviceId ?? null,
    title: q.title,
    details: q.details ?? null,
    extrasNote: q.extrasNote ?? null,
    jobDate: q.jobDate,
    startTime: q.startTime,
    durationMinutes: q.durationMinutes,
    timeZone: q.timeZone,
    startsAt: q.startsAt,
    totalCents: q.totalCents,
    paymentMode: q.paymentMode,
    depositCents: q.depositCents ?? null,
    amounts: quoteAmounts(q.totalCents, q.depositCents ?? null),
    expiresAt: q.expiresAt,
    linkCode: q.linkCode,
    messageId: q.messageId ?? null,
    declineReason: q.declineReason ?? null,
    sentAt: q.sentAt,
    updatedAt: q.updatedAt,
  };
}

/** The card data saved on the message. Clients read the live quote with GET /api/quotes/:id. */
function cardFor(q: Quote, event: QuoteEvent) {
  const a = quoteAmounts(q.totalCents, q.depositCents ?? null);
  return {
    type: "quote",
    event,
    quoteId: q.id,
    version: q.version,
    businessId: q.businessId,
    title: q.title,
    totalCents: q.totalCents,
    paymentMode: q.paymentMode,
    depositOrTotalCents: a.depositOrTotalCents,
    payNowCents: a.payNowCents,
    balanceCents: a.balanceCents,
    jobDate: q.jobDate,
    startTime: q.startTime,
    durationMinutes: q.durationMinutes,
    timeZone: q.timeZone,
    expiresAt: q.expiresAt,
  };
}

async function businessName(id: string): Promise<string | null> {
  const [b] = await db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, id));
  return b?.name ?? null;
}

/** Who the user sends quotes for: the business they own, else the one business they are active staff at. */
async function senderSide(userId: string, wantedBusinessId: unknown): Promise<
  { ok: true; business: Business; staffMemberId: string | null } | { ok: false; status: number; message: string }
> {
  const owned = await storage.getBusinessByOwnerId(userId);
  if (owned && (wantedBusinessId === undefined || wantedBusinessId === null || wantedBusinessId === owned.id)) {
    return { ok: true, business: owned, staffMemberId: null };
  }
  const rows = await db.select().from(staffMembers).where(and(eq(staffMembers.userId, userId), eq(staffMembers.status, "active")));
  const pick = typeof wantedBusinessId === "string" ? rows.filter((r) => r.businessId === wantedBusinessId) : rows;
  if (pick.length === 1) {
    const business = await storage.getBusiness(pick[0].businessId);
    if (business) return { ok: true, business, staffMemberId: pick[0].id };
  }
  if (pick.length > 1) return { ok: false, status: 400, message: "Choose which business this quote is from" };
  return { ok: false, status: 403, message: "Only a business or its staff can send quotes" };
}

/** May this user change (edit, withdraw) the quote? The owner of its business, or the staff member who sent it. */
async function canManage(q: Quote, userId: string): Promise<boolean> {
  if (q.staffMemberId && q.senderId === userId) {
    // Only while they are still active staff of that business: a removed staff member loses access.
    const [s] = await db.select().from(staffMembers).where(eq(staffMembers.id, q.staffMemberId));
    if (s && s.status === "active" && s.businessId === q.businessId && s.userId === userId) return true;
  }
  const b = await storage.getBusiness(q.businessId);
  return !!b && b.ownerId === userId;
}

async function canRead(q: Quote, userId: string): Promise<boolean> {
  if (q.customerId === userId || (await canManage(q, userId))) return true;
  const u = await storage.getUser(userId);
  return ADMIN_EMAILS.includes((u?.email ?? "").toLowerCase());
}

async function loadQuote(id: string): Promise<Quote | undefined> {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, id));
  return q;
}

/** 409 body for a quote that can no longer change. */
function closedBody(q: Quote) {
  const st = effectiveStatus(q, new Date());
  const words: Record<string, string> = { withdrawn: "was withdrawn", declined: "was declined", expired: "has expired", paid: "is already paid" };
  return { code: "QUOTE_CLOSED", status: st, message: `This quote ${words[st] ?? "can't be changed"}.` };
}

/** Posts the card for an event. Nothing is posted (or pushed) when either person has blocked the other. */
export async function postEvent(q: Quote, event: QuoteEvent, fromCustomer: boolean): Promise<string | null> {
  try {
    if (await storage.isUserBlockedEitherWay(q.senderId, q.customerId)) return null;
    const msg = await postCardMessage({
      conversationId: q.conversationId,
      senderId: fromCustomer ? q.customerId : q.senderId,
      recipientId: fromCustomer ? q.senderId : q.customerId,
      kind: "quote",
      card: cardFor(q, event),
      content: quoteMessageText(event, q.title, q.totalCents),
    });
    return msg.id;
  } catch (err) {
    console.error(`[quotes] ${event} card failed for ${q.id}:`, err);
    return null;
  }
}

export function registerQuoteRoutes(app: Express): void {
  app.post("/api/quotes", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : "";
      const conv = conversationId ? await storage.getConversation(conversationId) : undefined;
      if (!conv || (conv.participant1Id !== userId && conv.participant2Id !== userId)) {
        return res.status(404).json({ error: "Chat not found" });
      }
      const customerId = conv.participant1Id === userId ? conv.participant2Id : conv.participant1Id;
      const side = await senderSide(userId, req.body?.businessId);
      if (!side.ok) return res.status(side.status).json({ error: "Not allowed", message: side.message });
      const { business, staffMemberId } = side;
      if (customerId === business.ownerId) return res.status(400).json({ error: "Invalid data", message: "Quotes go to customers, not to the business owner" });
      if (await storage.isUserBlockedEitherWay(userId, customerId)) {
        return res.status(403).json({ error: "Not allowed", message: "You can't send a quote to this person" });
      }

      const input = checkQuoteInput(req.body);
      if (!input.ok) return res.status(400).json({ error: "Invalid data", field: input.field, message: input.message });
      const timeZone = resolveTimeZone(business.timeZone);
      const timing = quoteTiming(input.value, timeZone, new Date());
      if (!timing.ok) return res.status(400).json({ error: "Invalid data", field: timing.field, message: timing.message });

      let serviceId: string | null = null;
      if (req.body?.serviceId) {
        const svc = await storage.getVendorService(String(req.body.serviceId));
        if (!svc || svc.businessId !== business.id || svc.isActive !== true) {
          return res.status(400).json({ error: "Invalid data", field: "serviceId", message: "Choose one of your services" });
        }
        serviceId = svc.id;
      }
      let requestId: string | null = null;
      if (req.body?.requestId) {
        const [r] = await db.select().from(estimateRequests).where(eq(estimateRequests.id, String(req.body.requestId)));
        if (!r || r.businessId !== business.id || r.customerId !== customerId) {
          return res.status(400).json({ error: "Invalid data", field: "requestId", message: "That request isn't from this customer" });
        }
        requestId = r.id;
      }

      const [created] = await db.insert(quotes).values({
        businessId: business.id,
        staffMemberId,
        senderId: userId,
        customerId,
        conversationId: conv.id,
        requestId,
        serviceId,
        ...input.value,
        timeZone,
        startsAt: timing.startsAt,
        expiresAt: timing.expiresAt,
        linkCode: newLinkCode(),
      }).returning();

      let q = created;
      const messageId = await postEvent(q, "sent", false);
      if (messageId) {
        [q] = await db.update(quotes).set({ messageId }).where(eq(quotes.id, q.id)).returning();
      }
      if (requestId) {
        await db.update(estimateRequests)
          .set({ status: "quoted", updatedAt: new Date() })
          .where(and(eq(estimateRequests.id, requestId), sql`${estimateRequests.status} IN ('new', 'called')`));
      }
      sendQuoteEmailIfEnabled(q, business).catch((err) => console.error(`[quotes] email failed for ${q.id}:`, err));
      return res.status(201).json({ quote: toQuoteJson(q, business.name) });
    } catch (err) {
      console.error("[quotes] send failed:", err);
      return res.status(500).json({ error: "Failed to send the quote" });
    }
  });

  // An edit replaces the whole quote: send every field, as when sending. Details or extras note left out are
  // cleared; serviceId left out keeps the current service.
  app.patch("/api/quotes/:id", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || !(await canManage(q, userId))) return res.status(404).json({ error: "Quote not found" });
      if (effectiveStatus(q, new Date()) !== "sent") return res.status(409).json(closedBody(q));
      if (await storage.isUserBlockedEitherWay(userId, q.customerId)) {
        return res.status(403).json({ error: "You can't send quotes to this person" });
      }
      if (!Number.isInteger(req.body?.version)) {
        return res.status(400).json({ error: "Invalid data", field: "version", message: "Open the quote again and make your change." });
      }
      if (req.body.version !== q.version) {
        return res.status(409).json({ code: "QUOTE_CHANGED", message: "This quote was changed in the meantime. Open it again and make your change." });
      }
      const input = checkQuoteInput(req.body);
      if (!input.ok) return res.status(400).json({ error: "Invalid data", field: input.field, message: input.message });
      const now = new Date();
      const timing = quoteTiming(input.value, q.timeZone, now);
      if (!timing.ok) return res.status(400).json({ error: "Invalid data", field: timing.field, message: timing.message });
      let serviceId = q.serviceId;
      if (req.body?.serviceId !== undefined) {
        serviceId = null;
        if (req.body.serviceId) {
          const svc = await storage.getVendorService(String(req.body.serviceId));
          if (!svc || svc.businessId !== q.businessId || svc.isActive !== true) {
            return res.status(400).json({ error: "Invalid data", field: "serviceId", message: "Choose one of your services" });
          }
          serviceId = svc.id;
        }
      }
      const [updated] = await db.update(quotes)
        .set({ ...input.value, serviceId, startsAt: timing.startsAt, expiresAt: timing.expiresAt, version: q.version + 1, updatedAt: now })
        .where(and(eq(quotes.id, q.id), eq(quotes.status, "sent"), eq(quotes.version, q.version), gt(quotes.expiresAt, now)))
        .returning();
      if (!updated) {
        const fresh = await loadQuote(q.id);
        if (fresh && effectiveStatus(fresh, new Date()) !== "sent") return res.status(409).json(closedBody(fresh));
        return res.status(409).json({ code: "QUOTE_CHANGED", message: "This quote was changed in the meantime. Open it again and make your change." });
      }
      let out = updated;
      const messageId = await postEvent(updated, "updated", false);
      if (messageId) [out] = await db.update(quotes).set({ messageId }).where(eq(quotes.id, updated.id)).returning();
      return res.json({ quote: toQuoteJson(out, await businessName(out.businessId)) });
    } catch (err) {
      console.error("[quotes] edit failed:", err);
      return res.status(500).json({ error: "Failed to save the quote" });
    }
  });

  app.post("/api/quotes/:id/withdraw", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || !(await canManage(q, userId))) return res.status(404).json({ error: "Quote not found" });
      const now = new Date();
      const [updated] = await db.update(quotes).set({ status: "withdrawn", withdrawnAt: now, updatedAt: now })
        .where(and(eq(quotes.id, q.id), eq(quotes.status, "sent"), gt(quotes.expiresAt, now))).returning();
      if (!updated) return res.status(409).json(closedBody((await loadQuote(q.id)) ?? q));
      await postEvent(updated, "withdrawn", false);
      return res.json({ quote: toQuoteJson(updated, await businessName(updated.businessId)) });
    } catch (err) {
      console.error("[quotes] withdraw failed:", err);
      return res.status(500).json({ error: "Failed to withdraw the quote" });
    }
  });

  app.post("/api/quotes/:id/decline", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || q.customerId !== userId) return res.status(404).json({ error: "Quote not found" });
      const raw = req.body?.reason;
      if (raw !== undefined && raw !== null && typeof raw !== "string") return res.status(400).json({ error: "Invalid data", field: "reason", message: "The reason must be text" });
      const reason = typeof raw === "string" ? raw.trim() : "";
      if (reason.length > MAX_REASON) return res.status(400).json({ error: "Invalid data", field: "reason", message: `The reason can be up to ${MAX_REASON} characters` });
      const now = new Date();
      const [updated] = await db.update(quotes).set({ status: "declined", declinedAt: now, declineReason: reason || null, updatedAt: now })
        .where(and(eq(quotes.id, q.id), eq(quotes.status, "sent"), gt(quotes.expiresAt, now))).returning();
      if (!updated) return res.status(409).json(closedBody((await loadQuote(q.id)) ?? q));
      await postEvent(updated, "declined", true);
      return res.json({ quote: toQuoteJson(updated, await businessName(updated.businessId)) });
    } catch (err) {
      console.error("[quotes] decline failed:", err);
      return res.status(500).json({ error: "Failed to decline the quote" });
    }
  });

  app.get("/api/quotes/:id", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || !(await canRead(q, userId))) return res.status(404).json({ error: "Quote not found" });
      return res.json({ quote: toQuoteJson(q, await businessName(q.businessId)) });
    } catch (err) {
      console.error("[quotes] read failed:", err);
      return res.status(500).json({ error: "Failed to load the quote" });
    }
  });

  app.get("/api/conversations/:id/quotes", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const conv = await storage.getConversation(req.params.id);
      if (!conv || (conv.participant1Id !== userId && conv.participant2Id !== userId)) return res.status(404).json({ error: "Chat not found" });
      const rows = await db.select().from(quotes).where(eq(quotes.conversationId, conv.id)).orderBy(desc(quotes.createdAt)).limit(100);
      const names = new Map<string, string | null>();
      for (const r of rows) if (!names.has(r.businessId)) names.set(r.businessId, await businessName(r.businessId));
      return res.json({ quotes: rows.map((r) => toQuoteJson(r, names.get(r.businessId) ?? null)) });
    } catch (err) {
      console.error("[quotes] chat list failed:", err);
      return res.status(500).json({ error: "Failed to load quotes" });
    }
  });

  app.get("/api/vendor/quotes", async (req, res) => {
    try {
      const owner = await resolveVendorBusiness(req, res);
      if (!owner) return;
      const rows = await db.select().from(quotes).where(eq(quotes.businessId, owner.business.id)).orderBy(desc(quotes.createdAt)).limit(500);
      return res.json({ quotes: rows.map((r) => toQuoteJson(r, owner.business.name)) });
    } catch (err) {
      console.error("[quotes] vendor list failed:", err);
      return res.status(500).json({ error: "Failed to load quotes" });
    }
  });

  app.get("/api/me/quotes", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const rows = await db.select().from(quotes).where(eq(quotes.customerId, userId)).orderBy(desc(quotes.createdAt)).limit(200);
      const names = new Map<string, string | null>();
      for (const r of rows) if (!names.has(r.businessId)) names.set(r.businessId, await businessName(r.businessId));
      return res.json({ quotes: rows.map((r) => toQuoteJson(r, names.get(r.businessId) ?? null)) });
    } catch (err) {
      console.error("[quotes] my list failed:", err);
      return res.status(500).json({ error: "Failed to load your quotes" });
    }
  });
}
