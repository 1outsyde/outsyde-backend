/**
 * Admin push announcements (goutsyde.com/admin/emails?tab=push). Migration 073.
 *   Mounted at /api/admin/push, every route behind requirePlatformAdmin (router level, like emailAdmin.ts).
 * "Outsyde news and offers" switch in the app:
 *   Mounted at /api/push/preferences (GET, PUT { news }), signed in user only.
 * Logic: server/push/*. Vault: Features/Notifications & Push.
 */
import { Router, type Request, type Response } from "express";
import { requirePlatformAdmin } from "../middleware/requirePlatformAdmin";
import { getUserIdFromRequest } from "../auth";
import { checkPushAudience, pushAudienceCounts, searchPushPeople, PUSH_AUDIENCES, type PushAudience } from "../push/pushAudience";
import { PUSH_SCREENS, checkTarget, screensForAudience, DEFAULT_SCREEN } from "../push/pushScreens";
import {
  MAX_BODY, MAX_CLIENT_KEY, MAX_TITLE, PUSH_DAILY_LIMIT,
  checkPushContent, getNewsPreference, getPushLimits, getPushSend, listPushSends, sendPushTest, setNewsPreference, startPushSend,
} from "../push/pushBroadcasts";

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ success: false, error: { code, message, ...extra } });
}

type AdminUser = { id: string };
const adminOf = (req: Request): AdminUser => (req as unknown as { adminUser: AdminUser }).adminUser;

export const pushAdminRouter = Router();
pushAdminRouter.use(requirePlatformAdmin);

/** People who can get a push now, per audience (token, not opted out, not admin, active, not demo). */
pushAdminRouter.get("/audiences", async (_req, res) => {
  try {
    res.json({ success: true, counts: await pushAudienceCounts() });
  } catch (err) {
    console.error("[PushAdmin] audiences error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not count the audiences");
  }
});

/** The screens a push can open, and which ones each audience may use. */
pushAdminRouter.get("/screens", (_req, res) => {
  const byAudience = Object.fromEntries(PUSH_AUDIENCES.map((a) => [a, screensForAudience(a).map((s) => s.key)]));
  res.json({
    success: true, screens: PUSH_SCREENS, byAudience, defaultScreen: DEFAULT_SCREEN,
    maxTitle: MAX_TITLE, maxBody: MAX_BODY,
  });
});

/** Sends used today (New York day), the limit, and whether it's quiet hours in New York. */
pushAdminRouter.get("/limits", async (_req, res) => {
  try {
    res.json({ success: true, ...(await getPushLimits()) });
  } catch (err) {
    console.error("[PushAdmin] limits error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load today's sends");
  }
});

/** Search accounts for "Picked people". No email and no push token in the answer. */
pushAdminRouter.get("/people", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json({ success: true, people: [] });
    if (q.length > 100) return fail(res, 400, "INVALID_QUERY", "Search is too long");
    res.json({ success: true, people: await searchPushPeople(q) });
  } catch (err) {
    console.error("[PushAdmin] people error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not search accounts");
  }
});

/** Pushes to the signed in admin's own phone only. Not counted in the daily limit. */
pushAdminRouter.post("/test", async (req, res) => {
  const content = checkPushContent(req.body);
  if (typeof content === "string") return fail(res, 400, "INVALID_CONTENT", content);
  // A test may preview any screen, so it's checked against the widest audience.
  const target = checkTarget(req.body, "picked");
  if (typeof target === "string") return fail(res, 400, "INVALID_SCREEN", target);
  try {
    const r = await sendPushTest({ adminId: adminOf(req).id, ...content, ...target });
    if (!r.ok) return fail(res, r.status, r.code, r.message);
    res.json({ success: true, sendId: r.sendId, status: r.status, error: r.error });
  } catch (err) {
    console.error("[PushAdmin] test error:", err);
    fail(res, 502, "SEND_FAILED", "The test push could not be sent");
  }
});

/** Starts a send. 202 { sendId, recipients }; the same clientKey again returns 200 with the same send. */
pushAdminRouter.post("/sends", async (req, res) => {
  const content = checkPushContent(req.body);
  if (typeof content === "string") return fail(res, 400, "INVALID_CONTENT", content);
  const who = checkPushAudience(req.body);
  if (typeof who === "string") return fail(res, 400, "INVALID_AUDIENCE", who);
  const target = checkTarget(req.body, who.audience as PushAudience);
  if (typeof target === "string") return fail(res, 400, "INVALID_SCREEN", target);
  const clientKey = (req.body ?? {}).clientKey;
  if (typeof clientKey !== "string" || !clientKey.trim() || clientKey.length > MAX_CLIENT_KEY) {
    return fail(res, 400, "INVALID_CLIENT_KEY", "Reload the page and try again.");
  }
  try {
    const r = await startPushSend({ ...who, ...content, ...target, clientKey: clientKey.trim(), createdBy: adminOf(req).id });
    if (!r.ok) return fail(res, r.status, r.code, r.message, r.extra ?? {});
    res.status(r.existing ? 200 : 202).json({ success: true, sendId: r.sendId, recipients: r.recipients, existing: r.existing });
  } catch (err) {
    console.error("[PushAdmin] send error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not start the push");
  }
});

/** History: sends and tests, newest first. */
pushAdminRouter.get("/sends", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const beforeRaw = typeof req.query.before === "string" ? req.query.before : "";
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if (before && Number.isNaN(before.getTime())) return fail(res, 400, "INVALID_BEFORE", "Bad date");
    res.json({ success: true, sends: await listPushSends(limit, before), dailyLimit: PUSH_DAILY_LIMIT });
  } catch (err) {
    console.error("[PushAdmin] sends error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load the history");
  }
});

/** One send with its recipients (account id, name, role, status, error code). */
pushAdminRouter.get("/sends/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "");
    if (!id || id.length > 36) return fail(res, 404, "NOT_FOUND", "Push not found");
    const found = await getPushSend(id);
    if (!found) return fail(res, 404, "NOT_FOUND", "Push not found");
    res.json({ success: true, ...found });
  } catch (err) {
    console.error("[PushAdmin] send detail error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load this push");
  }
});

// ── the app's "Outsyde news and offers" switch ──────────────────────────────

export const pushPreferencesRouter = Router();

pushPreferencesRouter.get("/", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "AUTH_REQUIRED", "Sign in first");
  try {
    res.json({ success: true, news: await getNewsPreference(userId) });
  } catch (err) {
    console.error("[PushPreferences] get error:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load your notification settings");
  }
});

pushPreferencesRouter.put("/", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "AUTH_REQUIRED", "Sign in first");
  const news = (req.body ?? {}).news;
  if (typeof news !== "boolean") return fail(res, 400, "INVALID_BODY", "Send { news: true } or { news: false }");
  try {
    res.json({ success: true, news: await setNewsPreference(userId, news) });
  } catch (err) {
    console.error("[PushPreferences] save error:", err);
    fail(res, 500, "SERVER_ERROR", "Couldn't save. Try again.");
  }
});
