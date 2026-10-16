/**
 * Admin Emails (goutsyde.com/admin/emails): broadcasts, email history and the daily budget.
 *   Mounted at /api/admin/emails, every route behind requirePlatformAdmin.
 * Public announcements unsubscribe:
 *   Mounted at /api/broadcasts (GET|POST /unsubscribe, signed link, one click).
 * Design: vault "Admin Email Pages, Design". Account setup sends stay on /api/admin/account-setup.
 */
import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { requirePlatformAdmin } from "../middleware/requirePlatformAdmin";
import { getBudget, getResendUsage } from "../emailHistory";
import {
  AUDIENCES, MAX_HTML, MAX_PICKED, MAX_SUBJECT, type Audience,
  audienceCounts, countRecipients, searchPeople, sendBroadcastTest, startBroadcast, verifyBroadcastUnsubSig,
} from "../broadcasts/broadcasts";

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ success: false, error: { code, message, ...extra } });
}

type AdminUser = { id: string; email: string | null; firstName?: string | null; name?: string | null };
const adminOf = (req: Request): AdminUser => (req as unknown as { adminUser: AdminUser }).adminUser;

/** Validates { subject, html } from a request body. Returns an error message or null. */
export function checkContent(body: unknown): { subject: string; html: string } | string {
  const b = (body ?? {}) as { subject?: unknown; html?: unknown };
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  const html = typeof b.html === "string" ? b.html : "";
  if (!subject) return "Add a subject.";
  if (subject.length > MAX_SUBJECT) return `Keep the subject under ${MAX_SUBJECT} characters.`;
  if (/[\r\n]/.test(subject)) return "The subject must be one line.";
  if (!html.trim()) return "Add the email HTML.";
  if (html.length > MAX_HTML) return "The HTML is too large (200 KB max).";
  return { subject, html };
}

export function checkAudience(body: unknown): { audience: Audience; userIds?: string[] } | string {
  const b = (body ?? {}) as { audience?: unknown; userIds?: unknown };
  const audience = b.audience as Audience;
  if (!AUDIENCES.includes(audience)) return "Pick who to send to.";
  if (audience !== "picked") return { audience };
  const ids = b.userIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PICKED ||
      !ids.every((v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 100)) {
    return `Pick between 1 and ${MAX_PICKED} people.`;
  }
  return { audience, userIds: Array.from(new Set(ids as string[])) };
}

export const emailAdminRouter = Router();
emailAdminRouter.use(requirePlatformAdmin);

/**
 * How many emails the admin page sent today and how many are left before the daily limit, plus
 * `resend`: every email on the Resend account today per Resend itself ({ used, limit, resetsAt }, or
 * null when Resend can't be asked). Additive field (PR C2); `resend` never blocks a send.
 */
emailAdminRouter.get("/budget", async (_req, res) => {
  try {
    const [budget, resend] = await Promise.all([getBudget(), getResendUsage()]);
    res.json({ success: true, ...budget, resend });
  } catch (err) {
    console.error("[EmailAdmin] budget error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load today's email count");
  }
});

/** Live recipient counts for each audience (unsubscribed and ineligible people excluded). */
emailAdminRouter.get("/audiences", async (_req, res) => {
  try {
    res.json({ success: true, counts: await audienceCounts() });
  } catch (err) {
    console.error("[EmailAdmin] audiences error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not count the audiences");
  }
});

/** Search accounts for "Picked people" and History by person. */
emailAdminRouter.get("/people", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json({ success: true, people: [] });
    if (q.length > 100) return fail(res, 400, "INVALID_QUERY", "Search is too long");
    res.json({ success: true, people: await searchPeople(q) });
  } catch (err) {
    console.error("[EmailAdmin] people error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not search accounts");
  }
});

/** Sends the broadcast to the signed in admin only. Counts toward the daily limit. */
emailAdminRouter.post("/broadcasts/test", async (req, res) => {
  const content = checkContent(req.body);
  if (typeof content === "string") return fail(res, 400, "INVALID_CONTENT", content);
  const admin = adminOf(req);
  if (!admin?.email) return fail(res, 400, "NO_ADMIN_EMAIL", "Your admin account has no email");
  try {
    const budget = await getBudget();
    if (budget.remaining !== null && budget.remaining < 1) {
      return fail(res, 429, "OVER_DAILY_LIMIT", "Today's email limit is used up. Try again tomorrow.", { budget });
    }
    const { sendId } = await sendBroadcastTest({
      subject: content.subject, html: content.html,
      admin: { id: admin.id, email: admin.email, firstName: admin.firstName ?? (admin.name || "").split(" ")[0] ?? null },
    });
    res.json({ success: true, sendId, to: admin.email });
  } catch (err) {
    console.error("[EmailAdmin] test send error:", err);
    fail(res, 502, "SEND_FAILED", err instanceof Error ? err.message : "The test email could not be sent");
  }
});

/** Starts a broadcast. Returns 202 with the send id; the emails go out in the background. */
emailAdminRouter.post("/broadcasts", async (req, res) => {
  const content = checkContent(req.body);
  if (typeof content === "string") return fail(res, 400, "INVALID_CONTENT", content);
  const target = checkAudience(req.body);
  if (typeof target === "string") return fail(res, 400, "INVALID_AUDIENCE", target);
  try {
    const recipients = await countRecipients(target.audience, target.userIds);
    if (recipients === 0) return fail(res, 400, "NO_RECIPIENTS", "Nobody in this audience can receive announcements.");
    const budget = await getBudget();
    if (budget.remaining !== null && recipients > budget.remaining) {
      return fail(res, 429, "OVER_DAILY_LIMIT",
        `This would send ${recipients} emails, but only ${budget.remaining} ${budget.remaining === 1 ? "is" : "are"} left today. Send it tomorrow or pick fewer people.`,
        { budget, recipients });
    }
    const started = await startBroadcast({ ...target, ...content, createdBy: adminOf(req).id });
    res.status(202).json({ success: true, sendId: started.sendId, recipients: started.recipients });
  } catch (err) {
    console.error("[EmailAdmin] broadcast error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not start the broadcast");
  }
});

/** History by send: broadcasts, tests and setup batches, newest first. */
emailAdminRouter.get("/sends", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
    const r = await db.execute(sql`
      SELECT s.id, s.kind, s.audience, s.subject, s.status, s.recipient_count, s.sent_count, s.failed_count,
             s.created_at, s.finished_at, COALESCE(a.name, a.email) AS created_by_name
      FROM email_sends s LEFT JOIN users a ON a.id = s.created_by
      WHERE ${before ? sql`s.created_at < ${before}::timestamptz` : sql`true`}
      ORDER BY s.created_at DESC
      LIMIT ${limit}
    `);
    res.json({ success: true, sends: r.rows });
  } catch (err) {
    console.error("[EmailAdmin] sends error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load the history");
  }
});

/** One send and everyone it went to. */
emailAdminRouter.get("/sends/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const s = await db.execute(sql`
      SELECT s.id, s.kind, s.audience, s.subject, s.html, s.status, s.recipient_count, s.sent_count, s.failed_count,
             s.created_at, s.finished_at, COALESCE(a.name, a.email) AS created_by_name
      FROM email_sends s LEFT JOIN users a ON a.id = s.created_by WHERE s.id = ${id}
    `);
    if (!s.rows[0]) return fail(res, 404, "NOT_FOUND", "No send with that id");
    const r = await db.execute(sql`
      SELECT l.id, l.user_id, l.kind, l.label, l.status, l.error, l.created_at, l.sent_at,
             u.email, COALESCE((SELECT b.name FROM businesses b WHERE b.owner_id = u.id LIMIT 1),
                               (SELECT p.display_name FROM photographers p WHERE p.user_id = u.id LIMIT 1), u.name) AS name
      FROM email_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.send_id = ${id}
      ORDER BY l.created_at, l.id
    `);
    res.json({ success: true, send: s.rows[0], recipients: r.rows });
  } catch (err) {
    console.error("[EmailAdmin] send detail error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load this send");
  }
});

/** History by person: every logged email one account got, newest first. */
emailAdminRouter.get("/people/:userId/emails", async (req, res) => {
  try {
    const userId = String(req.params.userId || "");
    const u = await db.execute(sql`
      SELECT u.id, u.email, COALESCE((SELECT b.name FROM businesses b WHERE b.owner_id = u.id LIMIT 1),
                                     (SELECT p.display_name FROM photographers p WHERE p.user_id = u.id LIMIT 1), u.name) AS name,
             EXISTS (SELECT 1 FROM broadcast_optouts o WHERE o.user_id = u.id) AS unsubscribed
      FROM users u WHERE u.id = ${userId}
    `);
    if (!u.rows[0]) return fail(res, 404, "NOT_FOUND", "No account with that id");
    const r = await db.execute(sql`
      SELECT l.id, l.send_id, l.kind, l.status, l.error, l.created_at, l.sent_at,
             COALESCE(s.subject, l.label) AS subject
      FROM email_log l LEFT JOIN email_sends s ON s.id = l.send_id
      WHERE l.user_id = ${userId}
      ORDER BY l.created_at DESC
      LIMIT 200
    `);
    res.json({ success: true, person: u.rows[0], emails: r.rows });
  } catch (err) {
    console.error("[EmailAdmin] person history error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load this person's emails");
  }
});

// ── public: announcements unsubscribe ───────────────────────────────────────

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#04100d;color:#F5F0E6;font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box">
<main style="max-width:420px;text-align:center"><div style="color:#E8B930;letter-spacing:.2em;font-weight:700;margin-bottom:16px">OUTSYDE</div><h1 style="font-size:24px;margin:0 0 12px">${title}</h1><p style="color:rgba(245,240,230,.75);line-height:1.6;margin:0">${body}</p></main></body></html>`;
}

async function handleUnsubscribe(req: Request, res: Response) {
  const userId = String((req.query.u ?? req.body?.u) || "");
  const sig = String((req.query.s ?? req.body?.s) || "");
  if (!verifyBroadcastUnsubSig(userId, sig)) {
    return res.status(400).type("html").send(page("This link isn't valid", "Reply to any Outsyde email or write info@goutsyde.com and we'll take you off announcements."));
  }
  try {
    await db.execute(sql`INSERT INTO broadcast_optouts (user_id) SELECT id FROM users WHERE id = ${userId} ON CONFLICT (user_id) DO NOTHING`);
    res.type("html").send(page("You're unsubscribed", "You won't get Outsyde announcements anymore. Booking, order and account emails still arrive as usual."));
  } catch (err) {
    console.error("[Broadcasts] unsubscribe error:", err);
    res.status(500).type("html").send(page("Something went wrong", "Please try the link again, or write info@goutsyde.com."));
  }
}

export const broadcastPublicRouter = Router();
broadcastPublicRouter.get("/unsubscribe", handleUnsubscribe);
broadcastPublicRouter.post("/unsubscribe", handleUnsubscribe); // RFC 8058 one click (List-Unsubscribe-Post)
