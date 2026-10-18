import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { storage } from "./storage";
import { verifyAccessToken } from "./auth";
import { notifyNewMessageInBackground } from "./messaging/notifyNewMessage";
import { checkOutgoingMessage, isRepeatedMessage, toClientMessage } from "./messaging/messageRules";
import { resolvePublicIdentity } from "./publicIdentity";

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
  activeConversationId?: string; // Track which conversation user is viewing
}

interface WSMessage {
  type: string;
  payload: any;
}

const clients = new Map<string, Set<AuthenticatedWebSocket>>();

// Track which users are actively viewing which conversations
// Key: conversationId, Value: Set of userIds actively viewing
const activeConversationViewers = new Map<string, Set<string>>();

// Check if user is actively viewing a conversation
function isUserViewingConversation(userId: string, conversationId: string): boolean {
  const viewers = activeConversationViewers.get(conversationId);
  return viewers ? viewers.has(userId) : false;
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: AuthenticatedWebSocket) => {
    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        await handleMessage(ws, message);
      } catch (error) {
        console.error("WebSocket message error:", error);
        ws.send(JSON.stringify({ type: "error", payload: { message: "Invalid message format" } }));
      }
    });

    ws.on("close", () => {
      if (ws.userId) {
        // Clean up active conversation tracking
        if (ws.activeConversationId) {
          const viewers = activeConversationViewers.get(ws.activeConversationId);
          if (viewers) {
            viewers.delete(ws.userId);
            if (viewers.size === 0) {
              activeConversationViewers.delete(ws.activeConversationId);
            }
          }
        }
        
        const userClients = clients.get(ws.userId);
        if (userClients) {
          userClients.delete(ws);
          if (userClients.size === 0) {
            clients.delete(ws.userId);
          }
        }
      }
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  });

  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws: AuthenticatedWebSocket) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  console.log("WebSocket server initialized");
  return wss;
}

async function handleMessage(ws: AuthenticatedWebSocket, message: WSMessage) {
  switch (message.type) {
    case "auth":
      await handleAuth(ws, message.payload);
      break;
    case "send_message":
      await handleSendMessage(ws, message.payload);
      break;
    case "typing":
      await handleTyping(ws, message.payload);
      break;
    case "mark_read":
      await handleMarkRead(ws, message.payload);
      break;
    case "focus_conversation":
      await handleFocusConversation(ws, message.payload);
      break;
    case "blur_conversation":
      await handleBlurConversation(ws, message.payload);
      break;
    default:
      ws.send(JSON.stringify({ type: "error", payload: { message: "Unknown message type" } }));
  }
}

async function handleAuth(ws: AuthenticatedWebSocket, payload: { token: string }) {
  try {
    const decoded = verifyAccessToken(payload.token);
    if (!decoded || !decoded.userId) {
      ws.send(JSON.stringify({ type: "auth_error", payload: { message: "Invalid token" } }));
      return;
    }

    ws.userId = decoded.userId;

    if (!clients.has(decoded.userId)) {
      clients.set(decoded.userId, new Set());
    }
    clients.get(decoded.userId)!.add(ws);

    const unreadCount = await storage.getUnreadCount(decoded.userId);

    ws.send(JSON.stringify({ 
      type: "auth_success", 
      payload: { 
        userId: decoded.userId,
        unreadCount,
      } 
    }));
  } catch (error) {
    console.error("WebSocket auth error:", error);
    ws.send(JSON.stringify({ type: "auth_error", payload: { message: "Authentication failed" } }));
  }
}

async function handleSendMessage(ws: AuthenticatedWebSocket, payload: { conversationId: string; content?: string; mediaItems?: string[] }) {
  if (!ws.userId) {
    ws.send(JSON.stringify({ type: "error", payload: { message: "Not authenticated" } }));
    return;
  }

  try {
    const conversation = await storage.getConversation(payload?.conversationId);
    if (!conversation) {
      ws.send(JSON.stringify({ type: "error", payload: { message: "Conversation not found" } }));
      return;
    }

    if (conversation.participant1Id !== ws.userId && conversation.participant2Id !== ws.userId) {
      ws.send(JSON.stringify({ type: "error", payload: { message: "Not a participant" } }));
      return;
    }

    const recipientId = conversation.participant1Id === ws.userId 
      ? conversation.participant2Id 
      : conversation.participant1Id;

    // Same rules as the REST send (R23): block check, content check, repeat check.
    if (await storage.isUserBlockedEitherWay(ws.userId, recipientId)) {
      ws.send(JSON.stringify({ type: "error", payload: { message: "You cannot send messages in this conversation." } }));
      return;
    }
    const check = checkOutgoingMessage(payload, process.env.R2_PUBLIC_URL);
    if (!check.ok) {
      ws.send(JSON.stringify({ type: "error", payload: { message: check.message } }));
      return;
    }
    const { content, mediaItems } = check;
    const recentMessages = await storage.getConversationMessages(payload.conversationId, 5);
    if (isRepeatedMessage(recentMessages, ws.userId, content, mediaItems)) {
      ws.send(JSON.stringify({ type: "error", payload: { message: "Please avoid sending the same message repeatedly." } }));
      return;
    }

    const message = await storage.createMessage({
      conversationId: payload.conversationId,
      senderId: ws.userId,
      content,
      mediaItems,
    });

    const sender = await storage.getUser(ws.userId);
    // Public identity (business name for vendors, same rule as the feed)
    const senderPublicName = sender ? (await resolvePublicIdentity(sender)).publicName : null;

    const messagePayload = {
      ...toClientMessage(message),
      senderName: senderPublicName || "Unknown",
    };

    ws.send(JSON.stringify({ type: "message_sent", payload: messagePayload }));

    // Send real-time WebSocket message
    sendToUser(recipientId, { type: "new_message", payload: messagePayload });

    // Push (app + web) unless the recipient is looking at this conversation right now.
    if (!isUserViewingConversation(recipientId, payload.conversationId)) {
      notifyNewMessageInBackground({
        conversationId: payload.conversationId,
        messageId: message.id,
        senderId: ws.userId,
        recipientId,
        content,
        mediaItems,
        senderPublicName,
      });
    }
  } catch (error) {
    console.error("Send message error:", error);
    ws.send(JSON.stringify({ type: "error", payload: { message: "Failed to send message" } }));
  }
}

/** The conversation if this socket's user is in it, else null (typing / read / focus must not work on other people's chats). */
async function getOwnConversation(ws: AuthenticatedWebSocket, conversationId: unknown) {
  if (!ws.userId || typeof conversationId !== "string" || !conversationId) return null;
  const conversation = await storage.getConversation(conversationId);
  if (!conversation) return null;
  if (conversation.participant1Id !== ws.userId && conversation.participant2Id !== ws.userId) return null;
  return conversation;
}

async function handleTyping(ws: AuthenticatedWebSocket, payload: { conversationId: string; isTyping: boolean }) {
  if (!ws.userId) return;

  try {
    const conversation = await getOwnConversation(ws, payload?.conversationId);
    if (!conversation) return;

    const recipientId = conversation.participant1Id === ws.userId 
      ? conversation.participant2Id 
      : conversation.participant1Id;

    sendToUser(recipientId, { 
      type: "typing", 
      payload: { 
        conversationId: payload.conversationId,
        userId: ws.userId,
        isTyping: payload.isTyping,
      } 
    });
  } catch (error) {
    console.error("Typing indicator error:", error);
  }
}

async function handleMarkRead(ws: AuthenticatedWebSocket, payload: { conversationId: string }) {
  if (!ws.userId) return;

  try {
    const conversation = await getOwnConversation(ws, payload?.conversationId);
    if (!conversation) return;
    await storage.markMessagesAsRead(payload.conversationId, ws.userId);
    
    ws.send(JSON.stringify({ 
      type: "messages_read", 
      payload: { conversationId: payload.conversationId } 
    }));

    {
      const otherUserId = conversation.participant1Id === ws.userId 
        ? conversation.participant2Id 
        : conversation.participant1Id;

      sendToUser(otherUserId, { 
        type: "messages_read_by_recipient", 
        payload: { 
          conversationId: payload.conversationId,
          readBy: ws.userId,
        } 
      });
    }
  } catch (error) {
    console.error("Mark read error:", error);
  }
}

// Track when user focuses on a conversation (opens it)
async function handleFocusConversation(ws: AuthenticatedWebSocket, payload: { conversationId: string }) {
  if (!ws.userId) return;

  try {
    if (!(await getOwnConversation(ws, payload?.conversationId))) return;
    // Remove from previous conversation if any
    if (ws.activeConversationId) {
      const prevViewers = activeConversationViewers.get(ws.activeConversationId);
      if (prevViewers) {
        prevViewers.delete(ws.userId);
        if (prevViewers.size === 0) {
          activeConversationViewers.delete(ws.activeConversationId);
        }
      }
    }

    // Add to new conversation viewers
    ws.activeConversationId = payload.conversationId;
    if (!activeConversationViewers.has(payload.conversationId)) {
      activeConversationViewers.set(payload.conversationId, new Set());
    }
    activeConversationViewers.get(payload.conversationId)!.add(ws.userId);

    // Also mark messages as read when focusing
    await storage.markMessagesAsRead(payload.conversationId, ws.userId);

    console.log(`[WS] User ${ws.userId} focused on conversation ${payload.conversationId}`);
  } catch (error) {
    console.error("Focus conversation error:", error);
  }
}

// Track when user blurs/leaves a conversation
async function handleBlurConversation(ws: AuthenticatedWebSocket, payload: { conversationId: string }) {
  if (!ws.userId) return;

  try {
    const viewers = activeConversationViewers.get(payload.conversationId);
    if (viewers) {
      viewers.delete(ws.userId);
      if (viewers.size === 0) {
        activeConversationViewers.delete(payload.conversationId);
      }
    }
    ws.activeConversationId = undefined;

    console.log(`[WS] User ${ws.userId} blurred conversation ${payload.conversationId}`);
  } catch (error) {
    console.error("Blur conversation error:", error);
  }
}

function sendToUser(userId: string, message: WSMessage) {
  const userClients = clients.get(userId);
  if (userClients) {
    const payload = JSON.stringify(message);
    userClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }
}

export function broadcastToConversation(conversationId: string, message: WSMessage, excludeUserId?: string) {
  clients.forEach((userClients, userId) => {
    if (userId !== excludeUserId) {
      userClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(message));
        }
      });
    }
  });
}
