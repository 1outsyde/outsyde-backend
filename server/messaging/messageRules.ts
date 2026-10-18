/**
 * Rules every outgoing direct message must pass, shared by the REST send and the websocket send
 * so a sender can't skip a check by switching paths (R23).
 *
 * Same limits REST had before this file existed:
 *  - text 1..2000 characters
 *  - at most 5 links
 *  - the same text may not be sent a third time within the last 5 messages
 */

export const MESSAGE_MAX_CHARS = 2000;
export const MESSAGE_MAX_LINKS = 5;

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

/** `recent` = the conversation's most recent messages (newest 5). */
export function isRepeatedMessage(
  recent: Array<{ senderId: string; content: string }>,
  senderId: string,
  content: string,
): boolean {
  return recent.filter((m) => m.senderId === senderId && m.content === content).length >= 2;
}
