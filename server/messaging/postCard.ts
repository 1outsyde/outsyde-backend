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
  kind: "quote";
  card: Record<string, unknown>;
  content: string;
}): Promise<Message> {
  const message = await storage.createMessage({
    conversationId: input.conversationId,
    senderId: input.senderId,
    content: input.content,
    kind: input.kind,
    card: input.card,
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
      });
    }
  } catch (err) {
    console.error(`[cards] live delivery or push failed for message ${message.id}:`, err);
  }
  return message;
}
