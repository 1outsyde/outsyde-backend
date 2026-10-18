/**
 * One place that tells a recipient about a new direct message.
 *
 * Called by both send paths (REST POST /api/conversations/:id/messages and the websocket
 * send_message handler) so push behaves the same whichever path the sender used.
 *
 *  - Expo push (the iOS/Android app): sent whenever the recipient has an Expo token.
 *  - Web push (VAPID, push_subscriptions): unchanged payload, sent when configured.
 *  - Never creates a `notifications` row (messages have their own unread badge; the tab badge
 *    already adds message unread to Activity unread, so a row would double count).
 *  - Never throws: a push failure must never fail the message send.
 *
 * Deps are injectable so the rules can be unit tested without a database or network.
 */

export const PUSH_PREVIEW_MAX = 50;

/** Lock screen preview: trimmed text, cut at 50 chars with an ellipsis. */
export function buildMessagePreview(content: string): string {
  const text = (content || "").replace(/\s+/g, " ").trim();
  if (text.length <= PUSH_PREVIEW_MAX) return text;
  return text.substring(0, PUSH_PREVIEW_MAX - 3).trimEnd() + "...";
}

export interface NotifyNewMessageInput {
  conversationId: string;
  messageId: string;
  senderId: string;
  recipientId: string;
  /** The message text as stored. */
  content: string;
  /** Sender's public name (business name for vendors). Falls back to "New message". */
  senderPublicName: string | null;
}

export interface NotifyDeps {
  sendExpoPush: (p: { userId: string; title: string; body: string; data?: Record<string, string> }) => Promise<boolean>;
  isWebPushConfigured: () => boolean;
  getWebPushSubscriptions: (userId: string) => Promise<any[]>;
  sendWebPush: (subscription: any, payload: any) => Promise<unknown>;
  getUnreadCount: (userId: string) => Promise<number>;
  log?: (msg: string, err?: unknown) => void;
}

export interface NotifyResult {
  expo: boolean;
  webDevices: number;
}

export async function notifyNewMessage(input: NotifyNewMessageInput, deps: NotifyDeps): Promise<NotifyResult> {
  const log = deps.log ?? ((m: string, e?: unknown) => (e ? console.error(m, e) : console.log(m)));
  const result: NotifyResult = { expo: false, webDevices: 0 };

  // Never notify the sender about their own message.
  if (!input.recipientId || input.recipientId === input.senderId) return result;

  const title = (input.senderPublicName || "").trim() || "New message";
  const body = buildMessagePreview(input.content) || "New message";

  let badgeCount: number | null = null;
  try {
    badgeCount = await deps.getUnreadCount(input.recipientId);
  } catch (err) {
    log("[MessagePush] unread count failed", err);
  }

  // App (Expo) push. data values must be strings.
  try {
    const data: Record<string, string> = {
      type: "new_message",
      conversationId: input.conversationId,
      messageId: input.messageId,
      senderId: input.senderId,
    };
    if (badgeCount !== null) data.badgeCount = String(badgeCount);
    result.expo = await deps.sendExpoPush({ userId: input.recipientId, title, body, data });
  } catch (err) {
    log("[MessagePush] expo push failed", err);
  }

  // Web push: same payload shape as before this change.
  try {
    if (deps.isWebPushConfigured()) {
      const subscriptions = await deps.getWebPushSubscriptions(input.recipientId);
      if (subscriptions.length > 0) {
        const payload = {
          title,
          body,
          url: `/messages?conversation=${input.conversationId}`,
          tag: `message-${input.conversationId}`,
          data: {
            type: "new_message",
            conversationId: input.conversationId,
            senderDisplayName: input.senderPublicName || "Unknown",
            messagePreview: body,
            badgeCount: badgeCount ?? 0,
          },
        };
        for (const subscription of subscriptions) {
          await deps.sendWebPush(subscription, payload);
          result.webDevices++;
        }
      }
    }
  } catch (err) {
    log("[MessagePush] web push failed", err);
  }

  return result;
}

/** Real dependencies, loaded lazily so importing this file never touches the DB. */
export async function defaultNotifyDeps(): Promise<NotifyDeps> {
  const [{ sendExpoPush }, push, { storage }] = await Promise.all([
    import("../expoPushService"),
    import("../pushService"),
    import("../storage"),
  ]);
  return {
    sendExpoPush,
    isWebPushConfigured: push.isPushConfigured,
    getWebPushSubscriptions: (userId) => storage.getUserPushSubscriptions(userId),
    sendWebPush: push.sendPushNotification,
    getUnreadCount: (userId) => storage.getUnreadCount(userId),
  };
}

/** Fire and forget from a request handler: never awaited by the caller's response, never throws. */
export function notifyNewMessageInBackground(input: NotifyNewMessageInput): void {
  defaultNotifyDeps()
    .then((deps) => notifyNewMessage(input, deps))
    .catch((err) => console.error("[MessagePush] notify failed", err));
}
