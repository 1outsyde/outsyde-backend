/**
 * Posts a card message (quote cards, Quotes step 2) into a chat: saves it, delivers it live over the websocket
 * to both people (same payload a websocket send makes), and pushes the other person unless they are looking at
 * the chat. Delivery and push never fail the post: the message is saved first.
 *
 * `content` must read on its own: older app builds show only that text.
 */
import { storage } from "../storage";
import type { Message } from "@shared/schema";

export async function postCardMessage(input: {
  conversationId: string;
  senderId: string;
  recipientId: string;
  /** Deliverables D1a: "text" posts a plain message for the sender (no card), e.g. the delivery address. */
  kind: "quote" | "text";
  card: Record<string, unknown> | null;
  content: string;
  /** Step 6a: the push body when it should say more than the card text (no 50 character cut). */
  pushBody?: string;
}): Promise<Message> {
  const message = await storage.createMessage({
    conversationId: input.conversationId,
    senderId: input.senderId,
    content: input.content,
    kind: input.kind,
    card: input.kind === "text" ? null : input.card,
  });
  try {
    const { notifyNewMessageInBackground } = await import("./notifyNewMessage");
    const { resolvePublicIdentity } = await import("../publicIdentity");
    const { sendToUser, isUserViewingConversation } = await import("../websocket");
    const { toClientMessage } = await import("./messageRules");
    const sender = await storage.getUser(input.senderId);
    const senderPublicName = sender ? (await resolvePublicIdentity(sender)).publicName : null;
    const payload = { ...toClientMessage(message), senderName: senderPublicName || "Unknown" };
    sendToUser(input.recipientId, { type: "new_message", payload });
    sendToUser(input.senderId, { type: "new_message", payload });
    if (!isUserViewingConversation(input.recipientId, input.conversationId)) {
      notifyNewMessageInBackground({
        conversationId: input.conversationId,
        messageId: message.id,
        senderId: input.senderId,
        recipientId: input.recipientId,
        content: input.content,
        mediaItems: [],
        senderPublicName,
        ...(input.pushBody ? { pushBody: input.pushBody } : {}),
      });
    }
  } catch (err) {
    console.error(`[cards] live delivery or push failed for message ${message.id}:`, err);
  }
  return message;
}
