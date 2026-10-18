/**
 * Rules every outgoing direct message must pass, shared by the REST send and the websocket send
 * so a sender can't skip a check by switching paths (R23).
 *
 * Same limits REST had before this file existed:
 *  - text 1..2000 characters
 *  - at most 5 links
 *  - the same text may not be sent a third time within the last 5 messages
 * Photos (migration 055):
 *  - up to 10 photo URLs, each uploaded through Outsyde (R2_PUBLIC_URL + "/messages/")
 *  - text is optional when there is at least one photo
 */

export const MESSAGE_MAX_CHARS = 2000;
export const MESSAGE_MAX_LINKS = 5;
export const MESSAGE_MAX_PHOTOS = 10;

export type MessageCheck =
  | { ok: true; content: string }
  | { ok: false; status: number; error: string; message: string };

export function checkMessageContent(raw: unknown): MessageCheck {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, status: 400, error: "Invalid data", message: "Message content is required" };
  }
  if (raw.length > MESSAGE_MAX_CHARS) {
    return { ok: false, status: 400, error: "Invalid data", message: `Message cannot exceed ${MESSAGE_MAX_CHARS} characters` };
  }
  const urlCount = (raw.match(/(https?:\/\/[^\s]+)/gi) || []).length;
  if (urlCount > MESSAGE_MAX_LINKS) {
    return { ok: false, status: 400, error: "Message contains too many links", message: "Messages cannot contain more than 5 links." };
  }
  return { ok: true, content: raw };
}

export type OutgoingCheck =
  | { ok: true; content: string; mediaItems: string[] }
  | { ok: false; status: number; error: string; message: string; code?: string };

/**
 * Full check for a send: text and/or photos.
 * `r2PublicUrl` = process.env.R2_PUBLIC_URL (photos are refused when it isn't set).
 */
export function checkOutgoingMessage(body: { content?: unknown; mediaItems?: unknown } | null | undefined, r2PublicUrl: string | undefined): OutgoingCheck {
  const rawMedia = body?.mediaItems;
  let mediaItems: string[] = [];
  if (rawMedia !== undefined && rawMedia !== null) {
    if (!Array.isArray(rawMedia) || !rawMedia.every((u) => typeof u === "string" && u.length > 0 && u.length <= 2048)) {
      return { ok: false, status: 400, error: "Invalid data", message: "Photos must be a list of links", code: "INVALID_MEDIA" };
    }
    if (rawMedia.length > MESSAGE_MAX_PHOTOS) {
      return { ok: false, status: 400, error: "Invalid data", message: `You can send up to ${MESSAGE_MAX_PHOTOS} photos at a time`, code: "TOO_MANY_PHOTOS" };
    }
    mediaItems = rawMedia as string[];
    if (mediaItems.length > 0) {
      const prefix = r2PublicUrl ? `${r2PublicUrl.replace(/\/+$/, "")}/messages/` : null;
      if (!prefix || !mediaItems.every((u) => u.startsWith(prefix))) {
        return { ok: false, status: 400, error: "Invalid data", message: "Photos must be uploaded through Outsyde", code: "INVALID_MEDIA_URL" };
      }
    }
  }

  const rawContent = body?.content;
  const hasText = typeof rawContent === "string" && rawContent.trim().length > 0;
  if (!hasText) {
    if (mediaItems.length === 0) {
      return { ok: false, status: 400, error: "Invalid data", message: "Message content is required" };
    }
    if (rawContent !== undefined && rawContent !== null && typeof rawContent !== "string") {
      return { ok: false, status: 400, error: "Invalid data", message: "Message content must be text" };
    }
    return { ok: true, content: "", mediaItems };
  }
  const text = checkMessageContent(rawContent);
  if (!text.ok) return text;
  return { ok: true, content: text.content, mediaItems };
}

/** What the inbox and push show for a message: its text, else "Sent a photo" / "Sent N photos". */
export function messageSummary(content: string, mediaItems: string[] | null | undefined): string {
  const text = (content || "").trim();
  if (text) return text;
  const n = Array.isArray(mediaItems) ? mediaItems.length : 0;
  if (n === 1) return "Sent a photo";
  if (n > 1) return `Sent ${n} photos`;
  return "";
}

/**
 * The message shape every client gets. Additive over the stored row:
 *  - `text`        the real text ('' for a photo only message). New app reads this.
 *  - `mediaItems`  always an array.
 *  - `content`     the real text, or "Sent a photo" for a photo only message, so app builds from
 *                  before photos show a readable bubble instead of an empty one.
 */
export function toClientMessage<T extends { content: string; mediaItems?: string[] | null }>(m: T): T & { text: string; mediaItems: string[] } {
  const mediaItems = Array.isArray(m.mediaItems) ? m.mediaItems : [];
  const text = m.content || "";
  return { ...m, text, mediaItems, content: text.trim() ? text : messageSummary(text, mediaItems) || text };
}

/** `recent` = the conversation's most recent messages (newest 5). Same text AND same photos. */
export function isRepeatedMessage(
  recent: Array<{ senderId: string; content: string; mediaItems?: string[] | null }>,
  senderId: string,
  content: string,
  mediaItems: string[] = [],
): boolean {
  const key = JSON.stringify(mediaItems);
  return recent.filter((m) => m.senderId === senderId && m.content === content && JSON.stringify(m.mediaItems ?? []) === key).length >= 2;
}
