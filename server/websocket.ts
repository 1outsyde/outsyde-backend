import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { storage } from "./storage";
import { verifyAccessToken } from "./auth";

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

interface WSMessage {
  type: string;
  payload: any;
}

const clients = new Map<string, Set<AuthenticatedWebSocket>>();

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

async function handleSendMessage(ws: AuthenticatedWebSocket, payload: { conversationId: string; content: string }) {
  if (!ws.userId) {
    ws.send(JSON.stringify({ type: "error", payload: { message: "Not authenticated" } }));
    return;
  }

  try {
    const conversation = await storage.getConversation(payload.conversationId);
    if (!conversation) {
      ws.send(JSON.stringify({ type: "error", payload: { message: "Conversation not found" } }));
      return;
    }

    if (conversation.participant1Id !== ws.userId && conversation.participant2Id !== ws.userId) {
      ws.send(JSON.stringify({ type: "error", payload: { message: "Not a participant" } }));
      return;
    }

    const message = await storage.createMessage({
      conversationId: payload.conversationId,
      senderId: ws.userId,
      content: payload.content,
    });

    const sender = await storage.getUser(ws.userId);

    const messagePayload = {
      ...message,
      senderName: sender?.name || "Unknown",
    };

    ws.send(JSON.stringify({ type: "message_sent", payload: messagePayload }));

    const recipientId = conversation.participant1Id === ws.userId 
      ? conversation.participant2Id 
      : conversation.participant1Id;

    sendToUser(recipientId, { type: "new_message", payload: messagePayload });
  } catch (error) {
    console.error("Send message error:", error);
    ws.send(JSON.stringify({ type: "error", payload: { message: "Failed to send message" } }));
  }
}

async function handleTyping(ws: AuthenticatedWebSocket, payload: { conversationId: string; isTyping: boolean }) {
  if (!ws.userId) return;

  try {
    const conversation = await storage.getConversation(payload.conversationId);
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
    await storage.markMessagesAsRead(payload.conversationId, ws.userId);
    
    ws.send(JSON.stringify({ 
      type: "messages_read", 
      payload: { conversationId: payload.conversationId } 
    }));

    const conversation = await storage.getConversation(payload.conversationId);
    if (conversation) {
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
