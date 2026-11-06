/**
 * Quotes (Quotes in Messages, step 2, migration 097). Rules: ./quoteRules.ts. Paying a quote (step 3) is
 * POST /api/quotes/:id/pay in routes.ts (./quotePaid.ts); while a payment runs, edit, withdraw, decline and
 * expiry wait (paying_until, up to 15 minutes).
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
import type { SQL } from "drizzle-orm";
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

/**
 * The paid quote's booking as `viewerId` sees it: the balance (step 4a), the Confirm or Report window, the report and
 * (business side) the payout (4b-1), the extras and the extras payment (4b-2b). Empty for a quote not paid yet.
 * Used by GET /api/quotes/:id and (step 6a, customer view) GET /api/me/quotes and /api/me/quote-actions.
 */
export async function quoteDetailJson(q: Quote, viewerId: string, canManageIt: boolean) {
  let balance = null;
  let win: { window: unknown; report: unknown; payout: unknown } = { window: null, report: null, payout: null };
  let extras: { extras: unknown[]; extrasPayment: unknown } = { extras: [], extrasPayment: null };
  if (q.appointmentId) {
    const { quoteJobFor, balanceJson } = await import("./quoteBalance");
    const job = await quoteJobFor(q.appointmentId);
    // Step 4b-2a: no balance block when the rest is paid to the business directly (amounts.paidDirectlyCents).
    balance = q.restPaid === "outside" ? null : balanceJson(job);
    const { windowJson } = await import("./quoteWindow");
    win = await windowJson(q, job, viewerId, canManageIt);
    const { extrasJson } = await import("./quoteExtras");
    extras = await extrasJson(q, viewerId, canManageIt);
  }
  return { balance, ...win, ...extras };
}
/**
 * The customer's quotes, newest first (200 at most), each with its booking detail (step 6a, additive).
 * openOnly (the pop-up list): only paid quotes whose booking can still need the customer (not complete, the window
 * still running, or extras unpaid or needing a card), so a long history costs nothing. Review I1 and I2: the detail
 * is read 8 at a time, and a detail that fails falls back to the bare quote (the list never fails for one row).
 */
async function myQuotesWithDetail(userId: string, o: { openOnly?: boolean } = {}) {
  const where = o.openOnly
    ? and(eq(quotes.customerId, userId), eq(quotes.status, "paid"), sql`EXISTS (
        SELECT 1 FROM quote_jobs j WHERE j.appointment_id = ${quotes.appointmentId}
           AND (j.completed_at IS NULL OR j.window_ends_at > now()
                OR EXISTS (SELECT 1 FROM quote_extras_payments x WHERE x.appointment_id = j.appointment_id AND x.status IN ('unpaid', 'hold_failed'))))`)
    : eq(quotes.customerId, userId);
  const list = await db.select().from(quotes).where(where).orderBy(desc(quotes.createdAt)).limit(200);
  const names = new Map<string, string | null>();
  for (const r of list) if (!names.has(r.businessId)) names.set(r.businessId, await businessName(r.businessId));
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < list.length; i += 8) {
    out.push(...(await Promise.all(list.slice(i, i + 8).map(async (r) => {
      const base = toQuoteJson(r, names.get(r.businessId) ?? null);
      try {
        return { ...base, ...(await quoteDetailJson(r, userId, false)) };
      } catch (err) {
        console.error(`[quotes] detail for ${r.id} failed:`, err);
        return base;
      }
    }))));
  }
  return out;
}

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
    kind: q.kind,
    dueDate: q.dueDate ?? null,
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
    // Step 4b-2a (additive): how the rest is paid; amounts.paidDirectlyCents is what the business collects itself.
    restPaid: q.restPaid ?? "outsyde",
    amounts: quoteAmounts(q.totalCents, q.depositCents ?? null, q.restPaid ?? "outsyde"),
    expiresAt: q.expiresAt,
    linkCode: q.linkCode,
    messageId: q.messageId ?? null,
    declineReason: q.declineReason ?? null,
    // Step 3 (additive): the booking a paid quote became, and whether a payment is running right now.
    appointmentId: q.appointmentId ?? null,
    paidAt: q.paidAt ?? null,
    paying: !!q.payingUntil && new Date(q.payingUntil).getTime() > now.getTime() && q.status === "sent",
    sentAt: q.sentAt,
    updatedAt: q.updatedAt,
  };
}

/** The card data saved on the message. Clients read the live quote with GET /api/quotes/:id. */
function cardFor(q: Quote, event: QuoteEvent) {
  const a = quoteAmounts(q.totalCents, q.depositCents ?? null, q.restPaid ?? "outsyde");
  return {
    type: "quote",
    event,
    quoteId: q.id,
    version: q.version,
    businessId: q.businessId,
    kind: q.kind,
    dueDate: q.dueDate ?? null,
    title: q.title,
    totalCents: q.totalCents,
    paymentMode: q.paymentMode,
    depositOrTotalCents: a.depositOrTotalCents,
    payNowCents: a.payNowCents,
    balanceCents: a.balanceCents,
    restPaid: a.restPaid,
    paidDirectlyCents: a.paidDirectlyCents,
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

/** Step 3: no payment is running (the pay route sets paying_until for up to 15 minutes). */
export const notPaying = (now: Date): SQL => sql`(${quotes.payingUntil} IS NULL OR ${quotes.payingUntil} <= ${now})`;
const PAYING_BODY = { code: "QUOTE_PAYING", message: "The customer is paying this quote right now. Try again in a few minutes." };
const isPaying = (q: Quote, now: Date) => q.status === "sent" && !!q.payingUntil && new Date(q.payingUntil).getTime() > now.getTime();

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
      if (isPaying(q, new Date())) return res.status(409).json(PAYING_BODY);
      if (await storage.isUserBlockedEitherWay(userId, q.customerId)) {
        return res.status(403).json({ error: "You can't send quotes to this person" });
      }
      if (!Number.isInteger(req.body?.version)) {
        return res.status(400).json({ error: "Invalid data", field: "version", message: "Open the quote again and make your change." });
      }
      if (req.body.version !== q.version) {
        return res.status(409).json({ code: "QUOTE_CHANGED", message: "This quote was changed in the meantime. Open it again and make your change." });
      }
      // Step 4b-2a: an edit that leaves out how the rest is paid keeps it (a full payment quote has none).
      const restLeftOut = req.body?.restPaid === undefined || req.body?.restPaid === null || req.body?.restPaid === "";
      const body = restLeftOut && req.body?.paymentMode === "deposit" ? { ...req.body, restPaid: q.restPaid } : req.body;
      const input = checkQuoteInput(body);
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
        .where(and(eq(quotes.id, q.id), eq(quotes.status, "sent"), eq(quotes.version, q.version), gt(quotes.expiresAt, now), notPaying(now)))
        .returning();
      if (!updated) {
        const fresh = await loadQuote(q.id);
        if (fresh && isPaying(fresh, new Date())) return res.status(409).json(PAYING_BODY);
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
        .where(and(eq(quotes.id, q.id), eq(quotes.status, "sent"), gt(quotes.expiresAt, now), notPaying(now))).returning();
      if (!updated) {
        const fresh = (await loadQuote(q.id)) ?? q;
        return res.status(409).json(isPaying(fresh, new Date()) ? PAYING_BODY : closedBody(fresh));
      }
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
        .where(and(eq(quotes.id, q.id), eq(quotes.status, "sent"), gt(quotes.expiresAt, now), notPaying(now))).returning();
      if (!updated) {
        const fresh = (await loadQuote(q.id)) ?? q;
        return res.status(409).json(isPaying(fresh, new Date()) ? PAYING_BODY : closedBody(fresh));
      }
      await postEvent(updated, "declined", true);
      return res.json({ quote: toQuoteJson(updated, await businessName(updated.businessId)) });
    } catch (err) {
      console.error("[quotes] decline failed:", err);
      return res.status(500).json({ error: "Failed to decline the quote" });
    }
  });

  // GET /api/quotes/link/:code (step 5a): opens a quote from its link (goutsyde.com/q/<code>). Signed out: a preview
  // (business look, title, date, price), nothing about the customer. The customer, the business (owner or the
  // sending staff member) or Outsyde admin: the quote id to load. Anyone else: OTHER_ACCOUNT with no details.
  app.get("/api/quotes/link/:code", async (req, res) => {
    try {
      const { quoteByLinkCode } = await import("./quoteNotes");
      const { quotePreviewJson } = await import("./quoteNotesRules");
      const q = await quoteByLinkCode(req.params.code);
      if (!q) return res.status(404).json({ code: "NOT_FOUND", message: "This quote link isn't valid." });
      const userId = userIdOf(req);
      const biz = await storage.getBusiness(q.businessId);
      if (!biz) return res.status(404).json({ code: "NOT_FOUND", message: "This quote link isn't valid." });
      const preview = quotePreviewJson(q, biz);
      if (!userId) return res.json({ access: "preview", preview });
      if (q.customerId === userId) return res.json({ access: "customer", quoteId: q.id, preview });
      if (await canManage(q, userId)) return res.json({ access: "vendor", quoteId: q.id, preview });
      if (await canRead(q, userId)) return res.json({ access: "admin", quoteId: q.id, preview });
      return res.status(403).json({ code: "OTHER_ACCOUNT", message: "This quote was sent to another Outsyde account. Sign in with the email it was sent to." });
    } catch (err) {
      console.error("[quotes] link failed:", err);
      return res.status(500).json({ error: "Failed to open the quote" });
    }
  });

  app.get("/api/quotes/:id", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || !(await canRead(q, userId))) return res.status(404).json({ error: "Quote not found" });
      // Step 4a (additive): the balance of a paid quote (held, charged, needs a new card) and its Job complete.
      const detail = await quoteDetailJson(q, userId, q.customerId !== userId && (await canManage(q, userId)));
      // Step 5a (additive): the business's look for the goutsyde.com quote page.
      const { businessLookJson } = await import("./quoteNotesRules");
      const biz = await storage.getBusiness(q.businessId);
      return res.json({ quote: { ...toQuoteJson(q, await businessName(q.businessId)), ...detail, business: biz ? businessLookJson(biz) : null } });
    } catch (err) {
      console.error("[quotes] read failed:", err);
      return res.status(500).json({ error: "Failed to load the quote" });
    }
  });

  // POST /api/quotes/:id/job-complete (step 4a): the owner, or the staff member who sent the quote, marks the job
  // complete. The held balance (and its service fee) is charged, the booking moves to completed. It also runs on its
  // own 2 h after the scheduled end (quoteBalance.runQuoteBalanceJob).
  app.post("/api/quotes/:id/job-complete", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || !(await canManage(q, userId))) return res.status(404).json({ error: "Quote not found" });
      if (q.status !== "paid" || !q.appointmentId) return res.status(409).json({ code: "NOT_CONFIRMED", message: "Only a paid quote's booking can be marked complete." });
      const b = await storage.getBusiness(q.businessId);
      const via = b?.ownerId === userId ? "owner" : "staff";
      const { completeQuoteJob } = await import("./quoteBalance");
      const r = await completeQuoteJob(q.appointmentId, { userId, via });
      if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message, error: r.message });
      return res.json({ success: true, appointmentId: q.appointmentId, status: "completed", pointsAwarded: r.pointsReleased, balanceChargedCents: r.capturedCents, extrasChargedCents: r.extrasCapturedCents });
    } catch (err) {
      console.error("[quotes] job complete failed:", err);
      return res.status(500).json({ error: "Failed to complete the job" });
    }
  });

  // POST /api/quotes/:id/confirm (step 4b-1): the customer confirms the job inside the 6 hour window. The vendor's
  // balance share is paid at once and the points land.
  app.post("/api/quotes/:id/confirm", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || q.customerId !== userId) return res.status(404).json({ error: "Quote not found" });
      const { confirmQuoteJob, windowJson } = await import("./quoteWindow");
      const r = await confirmQuoteJob(q);
      if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message, error: r.message });
      return res.json({ success: true, ...(await windowJson(q, r.job, userId, false)) });
    } catch (err) {
      console.error("[quotes] confirm failed:", err);
      return res.status(500).json({ error: "Failed to confirm the job" });
    }
  });

  // POST /api/quotes/:id/report (step 4b-1): the customer reports a problem inside the 6 hour window. Body
  // { reason, photos? } (photos uploaded first, like request photos). The vendor's payout is paused for Outsyde's review.
  app.post("/api/quotes/:id/report", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || q.customerId !== userId) return res.status(404).json({ error: "Quote not found" });
      const { reportQuoteJob, windowJson } = await import("./quoteWindow");
      const r = await reportQuoteJob(q, req.body ?? {});
      if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message, error: r.message });
      return res.json({ success: true, reportId: r.reportId, ...(await windowJson(q, r.job, userId, false)) });
    } catch (err) {
      console.error("[quotes] report failed:", err);
      return res.status(500).json({ error: "Failed to send the report" });
    }
  });

  // POST /api/quotes/:id/balance/card (step 4a): the customer, after the balance hold failed ("Update your card"),
  // pays the hold with a new card. Body { paymentSheet? }. Returns the PaymentIntent to confirm on session.
  app.post("/api/quotes/:id/balance/card", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || q.customerId !== userId || !q.appointmentId) return res.status(404).json({ error: "Quote not found" });
      const user = await storage.getUser(userId);
      if (!user?.stripeCustomerId) return res.status(409).json({ code: "NO_CUSTOMER", message: "Open the quote again to pay." });
      const { startNewCardPayment } = await import("./quoteBalance");
      const r = await startNewCardPayment(q.appointmentId, user.stripeCustomerId);
      if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message, error: r.message });
      const { paymentSheetFields } = await import("../payments/savedCards");
      return res.json({
        ...(await paymentSheetFields(r.pi.customer, req.body?.paymentSheet === true)),
        quoteId: q.id,
        appointmentId: q.appointmentId,
        clientSecret: r.pi.client_secret,
        paymentIntentId: r.pi.id,
        captureMethod: "manual",
        amountCents: r.pi.amount,
      });
    } catch (err) {
      console.error("[quotes] new card payment failed:", err);
      return res.status(500).json({ error: "Failed to start the payment" });
    }
  });

  // ─── Step 4b-2b: extras ───────────────────────────────────────────────────
  const extrasError = (res: any, r: { status: number; code: string; message: string; field?: string }) =>
    res.status(r.status).json({ code: r.code, message: r.message, error: r.message, ...(r.field ? { field: r.field } : {}) });

  // POST /api/quotes/:id/extras: the owner, or the staff member who sent the quote, sends an extra. Body
  // { description, amountCents }. From payment until Job complete; only the customer's Approve adds it.
  app.post("/api/quotes/:id/extras", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || !(await canManage(q, userId))) return res.status(404).json({ error: "Quote not found" });
      const { proposeExtra, extraJson } = await import("./quoteExtras");
      const r = await proposeExtra(q, userId, req.body);
      if (!r.ok) return extrasError(res, r);
      return res.status(201).json({ extra: extraJson(r.extra, { isCustomer: false, canManage: true }, true) });
    } catch (err) {
      console.error("[quotes] extra failed:", err);
      return res.status(500).json({ error: "Failed to send the extra" });
    }
  });

  // POST /api/quotes/:id/extras/:extraId/withdraw: the vendor takes back an extra the customer hasn't answered.
  app.post("/api/quotes/:id/extras/:extraId/withdraw", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || !(await canManage(q, userId))) return res.status(404).json({ error: "Quote not found" });
      const { withdrawExtra, extraJson } = await import("./quoteExtras");
      const r = await withdrawExtra(q, req.params.extraId);
      if (!r.ok) return extrasError(res, r);
      return res.json({ extra: extraJson(r.extra, { isCustomer: false, canManage: true }, true) });
    } catch (err) {
      console.error("[quotes] withdraw extra failed:", err);
      return res.status(500).json({ error: "Failed to withdraw the extra" });
    }
  });

  // POST /api/quotes/:id/extras/:extraId/decline: the customer declines. Nothing is added.
  app.post("/api/quotes/:id/extras/:extraId/decline", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || q.customerId !== userId) return res.status(404).json({ error: "Quote not found" });
      const { declineExtra, extraJson } = await import("./quoteExtras");
      const r = await declineExtra(q, req.params.extraId);
      if (!r.ok) return extrasError(res, r);
      return res.json({ extra: extraJson(r.extra, { isCustomer: true, canManage: false }, true) });
    } catch (err) {
      console.error("[quotes] decline extra failed:", err);
      return res.status(500).json({ error: "Failed to decline the extra" });
    }
  });

  // POST /api/quotes/:id/extras/:extraId/approve: the customer approves. Body { newCard?, paymentSheet? }. Held on
  // the card at once (far out: the card is checked). status needs_action: finish clientSecret in the app (a
  // PaymentIntent or a SetupIntent, intentType), then call this again.
  app.post("/api/quotes/:id/extras/:extraId/approve", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || q.customerId !== userId) return res.status(404).json({ error: "Quote not found" });
      const { approveExtra, extraJson } = await import("./quoteExtras");
      const r = await approveExtra(q, req.params.extraId, { newCard: req.body?.newCard === true });
      if (!r.ok) return extrasError(res, r);
      const extra = extraJson(r.extra, { isCustomer: true, canManage: false }, true);
      if (r.status === "approved") return res.json({ status: "approved", extra });
      // The payment sheet keys are for the intent's own customer (the deposit's), never a different one.
      const { paymentSheetFields } = await import("../payments/savedCards");
      return res.json({
        status: "needs_action", extra, intentType: r.intentType, clientSecret: r.clientSecret, intentId: r.intentId,
        ...(r.customerId ? await paymentSheetFields(r.customerId, req.body?.paymentSheet === true) : {}),
      });
    } catch (err) {
      console.error("[quotes] approve extra failed:", err);
      return res.status(500).json({ error: "Failed to approve the extra" });
    }
  });

  // POST /api/quotes/:id/extras/card: the customer pays the extras with a new card: Update your card (a far out
  // hold that failed, held now) or Pay for extras (couldn't be charged at Job complete, charged now).
  app.post("/api/quotes/:id/extras/card", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const q = await loadQuote(req.params.id);
      if (!q || q.customerId !== userId || !q.appointmentId) return res.status(404).json({ error: "Quote not found" });
      const user = await storage.getUser(userId);
      if (!user?.stripeCustomerId) return res.status(409).json({ code: "NO_CUSTOMER", message: "Open the quote again to pay." });
      const { startExtrasCardPayment } = await import("./quoteExtras");
      const r = await startExtrasCardPayment(q.appointmentId, user.stripeCustomerId);
      if (!r.ok) return extrasError(res, r);
      const { paymentSheetFields } = await import("../payments/savedCards");
      return res.json({
        ...(await paymentSheetFields(r.pi.customer, req.body?.paymentSheet === true)),
        quoteId: q.id, appointmentId: q.appointmentId, clientSecret: r.pi.client_secret, paymentIntentId: r.pi.id,
        captureMethod: r.captureMethod, amountCents: r.pi.amount,
      });
    } catch (err) {
      console.error("[quotes] extras card payment failed:", err);
      return res.status(500).json({ error: "Failed to start the payment" });
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
      return res.json({ quotes: await myQuotesWithDetail(userId) });
    } catch (err) {
      console.error("[quotes] my list failed:", err);
      return res.status(500).json({ error: "Failed to load your quotes" });
    }
  });

  // GET /api/me/quote-actions (step 6a call 5): everything waiting on the signed in customer (an extra to approve,
  // Update your card, Pay for extras, Confirm or Report), for the app's pop-up. Money first.
  app.get("/api/me/quote-actions", async (req, res) => {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { quoteActionsFor } = await import("./quoteNoticesRules");
      const list = (await myQuotesWithDetail(userId, { openOnly: true })) as any[];
      return res.json({ actions: quoteActionsFor(list.map((d) => ({ quote: d, balance: d.balance, window: d.window, extras: d.extras, extrasPayment: d.extrasPayment }))) });
    } catch (err) {
      console.error("[quotes] my actions failed:", err);
      return res.status(500).json({ error: "Failed to load what needs you" });
    }
  });
}
